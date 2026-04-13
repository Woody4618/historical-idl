import {
    Address,
    getBase58Decoder,
    getBase58Encoder,
    Rpc,
    SolanaRpcApi,
} from '@solana/kit';
import {
    Compression,
    Encoding,
    findMetadataPda,
    PROGRAM_METADATA_PROGRAM_ADDRESS,
    type Seed,
    unpackDirectData as pmpUnpackDirectData,
} from '@solana-program/program-metadata';

// ─── Re-exports from PMP package ─────────────────────────────────────────────

export { Compression, Encoding, PROGRAM_METADATA_PROGRAM_ADDRESS };
export type { Seed };

export const FORMAT_NAME = ['none', 'json', 'yaml', 'toml'];
export const ENCODING_NAME = ['none', 'utf8', 'base58', 'base64'];
export const COMPRESSION_NAME = ['none', 'gzip', 'zlib'];
export const DISC_LABEL = ['Empty', 'Buffer', 'Metadata'];

const DISC = {
    Write: 0,
    Initialize: 1,
    SetAuthority: 2,
    SetData: 3,
    SetImmutable: 4,
    Trim: 5,
    Close: 6,
    Allocate: 7,
    Extend: 8,
} as const;

const DISC_NAME: Record<number, string> = {
    0: 'Write', 1: 'Initialize', 2: 'SetAuthority', 3: 'SetData',
    4: 'SetImmutable', 5: 'Trim', 6: 'Close', 7: 'Allocate', 8: 'Extend',
};

// ─── Types ───────────────────────────────────────────────────────────────────

export type VirtualState = {
    /** 0 = Empty, 1 = Buffer, 2 = Metadata */
    discriminator: 0 | 1 | 2;
    authority: Address | null;
    mutable: boolean;
    canonical: boolean;
    seed: Uint8Array<ArrayBuffer>;
    encoding: number;
    compression: number;
    format: number;
    /** 0 = Direct, 1 = Url, 2 = External */
    dataSource: number;
    dataLength: number;
    data: Uint8Array<ArrayBuffer>;
};

export type Snapshot = {
    slot: bigint;
    blockTime: bigint | null;
    signature: string;
    instruction: string;
    state: VirtualState | null;
    decodedContent: string | null;
};

type SigInfo = {
    signature: string;
    slot: bigint;
    blockTime: bigint | null;
    err: unknown;
};

type CompiledInstruction = {
    programIdIndex: number;
    accounts: number[];
    data: string;
};

type InnerInstructionGroup = {
    index: number;
    instructions: CompiledInstruction[];
};

type ParsedTx = {
    slot: bigint;
    blockTime: bigint | null;
    transaction: {
        message: {
            accountKeys: string[];
            instructions: CompiledInstruction[];
        };
    };
    meta: {
        err: unknown;
        innerInstructions?: InnerInstructionGroup[] | null;
        loadedAddresses?: {
            writable?: string[];
            readonly?: string[];
        } | null;
    } | null;
};

// ─── PDA derivation ──────────────────────────────────────────────────────────

export async function findPmpMetadataPda(
    programAddress: Address,
    seed: Seed,
    authority?: Address | null,
): Promise<Address> {
    const [pda] = await findMetadataPda({
        program: programAddress,
        authority: authority ?? null,
        seed,
    });
    return pda;
}

// ─── Low-level helpers ───────────────────────────────────────────────────────

function fromBase58(b58: string): Uint8Array<ArrayBuffer> {
    try {
        return new Uint8Array(getBase58Encoder().encode(b58));
    } catch {
        return new Uint8Array(0);
    }
}

function readU32LE(bytes: Uint8Array, offset: number): number {
    return (
        (bytes[offset] |
            (bytes[offset + 1] << 8) |
            (bytes[offset + 2] << 16) |
            ((bytes[offset + 3] << 24) >>> 0)) >>>
        0
    );
}

function rawBytesToAddress(bytes: Uint8Array<ArrayBuffer>, offset: number): Address {
    const slice = bytes.slice(offset, offset + 32);
    return getBase58Decoder().decode(slice) as Address;
}

function writeChunk(
    buf: Uint8Array<ArrayBuffer>,
    chunk: Uint8Array<ArrayBuffer>,
    dstOffset: number,
): Uint8Array<ArrayBuffer> {
    const needed = dstOffset + chunk.length;
    if (needed > buf.length) {
        const grown = new Uint8Array(needed);
        grown.set(buf);
        buf = grown;
    }
    buf.set(chunk, dstOffset);
    return buf;
}

function cloneState(s: VirtualState): VirtualState {
    return {
        ...s,
        seed: new Uint8Array(s.seed) as Uint8Array<ArrayBuffer>,
        data: new Uint8Array(s.data) as Uint8Array<ArrayBuffer>,
    };
}

function emptyState(): VirtualState {
    return {
        discriminator: 0, authority: null, mutable: true, canonical: false,
        seed: new Uint8Array(16), encoding: 0, compression: 0, format: 0,
        dataSource: 0, dataLength: 0, data: new Uint8Array(0),
    };
}

function resolveAccountKeys(tx: ParsedTx): string[] {
    const keys = [...tx.transaction.message.accountKeys];
    const loaded = tx.meta?.loadedAddresses;
    if (loaded) {
        keys.push(...(loaded.writable ?? []));
        keys.push(...(loaded.readonly ?? []));
    }
    return keys;
}

function flattenInstructions(tx: ParsedTx): CompiledInstruction[] {
    const result: CompiledInstruction[] = [];
    const innerByOuterIdx = new Map<number, CompiledInstruction[]>();

    for (const group of tx.meta?.innerInstructions ?? []) {
        innerByOuterIdx.set(group.index, group.instructions);
    }

    tx.transaction.message.instructions.forEach((outerIx, idx) => {
        result.push(outerIx);
        const inner = innerByOuterIdx.get(idx);
        if (inner) result.push(...inner);
    });

    return result;
}

// ─── RPC helpers with retry ──────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: unknown) {
            lastErr = err;
            const is429 =
                err instanceof Error &&
                (err.message.includes('429') || err.message.includes('Too Many Requests'));
            if (!is429 || attempt === maxRetries) throw err;
            const backoff = Math.min(1000 * 2 ** attempt, 15_000);
            await sleep(backoff);
        }
    }
    throw lastErr;
}

async function fetchAllSignatures(rpc: Rpc<SolanaRpcApi>, addr: Address): Promise<SigInfo[]> {
    const all: SigInfo[] = [];
    let before: string | undefined;

    for (;;) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const batch = await withRetry(async () =>
            (await (rpc as any)
                .getSignaturesForAddress(addr, {
                    limit: 1000,
                    ...(before ? { before } : {}),
                })
                .send()) as SigInfo[],
        );

        if (!batch || batch.length === 0) break;
        all.push(...batch);
        before = batch[batch.length - 1].signature;
        if (batch.length < 1000) break;
    }

    return all.reverse();
}

async function fetchTx(rpc: Rpc<SolanaRpcApi>, sig: string): Promise<ParsedTx | null> {
    return withRetry(async () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rpc as any)
            .getTransaction(sig, {
                maxSupportedTransactionVersion: 0,
                encoding: 'json',
            })
            .send() as Promise<ParsedTx | null>,
    );
}

// ─── Buffer reconstruction ───────────────────────────────────────────────────

async function reconstructBufferData(
    rpc: Rpc<SolanaRpcApi>,
    bufferAddr: Address,
): Promise<Uint8Array<ArrayBuffer>> {
    let data: Uint8Array<ArrayBuffer> = new Uint8Array(0);

    const sigs = await fetchAllSignatures(rpc, bufferAddr);

    for (const sigInfo of sigs) {
        if (sigInfo.err) continue;

        const tx = await fetchTx(rpc, sigInfo.signature);
        if (!tx?.transaction?.message) continue;

        const keys = resolveAccountKeys(tx);
        const targetIdx = keys.indexOf(bufferAddr as string);
        if (targetIdx === -1) continue;

        for (const ix of flattenInstructions(tx)) {
            if (keys[ix.programIdIndex] !== (PROGRAM_METADATA_PROGRAM_ADDRESS as string)) continue;
            if (ix.accounts[0] !== targetIdx) continue;

            const bytes = fromBase58(ix.data);
            if (bytes.length === 0) continue;
            const disc = bytes[0];

            if (disc === DISC.Allocate) {
                data = new Uint8Array(0);
            } else if (disc === DISC.Write && bytes.length >= 5) {
                const offset = readU32LE(bytes, 1);
                const chunk = bytes.slice(5);
                if (chunk.length > 0) {
                    data = writeChunk(data, chunk, offset);
                }
            }
        }
    }

    return data;
}

// ─── State machine ───────────────────────────────────────────────────────────

async function applyInstruction(
    state: VirtualState,
    ix: CompiledInstruction,
    keys: string[],
    rpc: Rpc<SolanaRpcApi>,
): Promise<{ next: VirtualState; closed: boolean; name: string }> {
    const bytes = fromBase58(ix.data);
    if (bytes.length === 0) return { next: state, closed: false, name: 'Unknown' };

    const disc = bytes[0];
    const name = DISC_NAME[disc] ?? `Unknown(${disc})`;
    const next = cloneState(state);

    switch (disc) {
        case DISC.Allocate: {
            next.discriminator = 1;
            next.data = new Uint8Array(0);
            next.dataLength = 0;
            if (bytes.length >= 17) next.seed = bytes.slice(1, 17);
            if (ix.accounts.length >= 2) next.authority = keys[ix.accounts[1]] as Address;
            next.canonical = ix.accounts.length >= 3;
            break;
        }

        case DISC.Write: {
            if (bytes.length < 5) break;
            const offset = readU32LE(bytes, 1);
            const inline = bytes.slice(5);

            if (inline.length > 0) {
                next.data = writeChunk(next.data, inline, offset);
            } else if (ix.accounts.length >= 3) {
                const srcAddr = keys[ix.accounts[2]] as Address;
                const srcData = await reconstructBufferData(rpc, srcAddr);
                next.data = writeChunk(next.data, srcData, offset);
            }
            break;
        }

        case DISC.Initialize: {
            if (bytes.length < 21) break;
            next.seed = bytes.slice(1, 17);
            next.encoding = bytes[17];
            next.compression = bytes[18];
            next.format = bytes[19];
            next.dataSource = bytes[20];
            if (ix.accounts.length >= 2) next.authority = keys[ix.accounts[1]] as Address;
            next.canonical = ix.accounts.length >= 3;

            if (next.discriminator === 1) {
                next.discriminator = 2;
                next.dataLength = next.data.length;
            } else {
                next.discriminator = 2;
                const inline = bytes.slice(21);
                next.data = inline;
                next.dataLength = inline.length;
            }
            break;
        }

        case DISC.SetData: {
            if (bytes.length < 4) break;
            next.encoding = bytes[1];
            next.compression = bytes[2];
            next.format = bytes[3];

            if (bytes.length >= 5) {
                next.dataSource = bytes[4];

                if (bytes.length > 5) {
                    const inline = bytes.slice(5);
                    next.data = inline;
                    next.dataLength = inline.length;
                } else if (ix.accounts.length >= 3) {
                    const bufAddr = keys[ix.accounts[2]] as Address;
                    const bufData = await reconstructBufferData(rpc, bufAddr);
                    next.data = bufData;
                    next.dataLength = bufData.length;
                }
            } else if (ix.accounts.length >= 3) {
                next.dataSource = 0;
                const bufAddr = keys[ix.accounts[2]] as Address;
                const bufData = await reconstructBufferData(rpc, bufAddr);
                next.data = bufData;
                next.dataLength = bufData.length;
            }
            break;
        }

        case DISC.SetAuthority: {
            if (bytes.length >= 33) {
                const allZero = bytes.slice(1, 33).every((b) => b === 0);
                next.authority = allZero ? null : rawBytesToAddress(bytes, 1);
            } else {
                next.authority = null;
            }
            break;
        }

        case DISC.SetImmutable: {
            next.mutable = false;
            break;
        }

        case DISC.Close: {
            return { next, closed: true, name };
        }

        case DISC.Trim:
        case DISC.Extend:
            break;
    }

    return { next, closed: false, name };
}

// ─── Decoding ────────────────────────────────────────────────────────────────

function tryDecode(state: VirtualState): string | null {
    if (state.discriminator !== 2) return null;
    if (state.dataSource !== 0) return null;
    if (state.dataLength === 0) return null;

    try {
        return pmpUnpackDirectData({
            data: state.data.slice(0, state.dataLength),
            compression: state.compression as Compression,
            encoding: state.encoding as Encoding,
        });
    } catch {
        return null;
    }
}

// ─── History reconstruction ──────────────────────────────────────────────────

export async function reconstructHistory(
    rpc: Rpc<SolanaRpcApi>,
    metadataAddr: Address,
): Promise<Snapshot[]> {
    const sigs = await fetchAllSignatures(rpc, metadataAddr);
    const snapshots: Snapshot[] = [];
    let state = emptyState();

    for (const sigInfo of sigs) {
        if (sigInfo.err) continue;

        let tx: ParsedTx | null;
        try {
            tx = await fetchTx(rpc, sigInfo.signature);
        } catch {
            continue;
        }
        if (!tx?.transaction?.message) continue;
        if (tx.meta?.err) continue;

        const keys = resolveAccountKeys(tx);
        const targetIdx = keys.indexOf(metadataAddr as string);
        if (targetIdx === -1) continue;

        const relevant = flattenInstructions(tx).filter(
            (ix) =>
                keys[ix.programIdIndex] === (PROGRAM_METADATA_PROGRAM_ADDRESS as string) &&
                ix.accounts[0] === targetIdx,
        );
        if (relevant.length === 0) continue;

        let lastName = 'Unknown';
        let closed = false;

        for (const ix of relevant) {
            const result = await applyInstruction(state, ix, keys, rpc);
            state = result.next;
            lastName = result.name;
            if (result.closed) {
                closed = true;
                break;
            }
        }

        snapshots.push({
            slot: sigInfo.slot,
            blockTime: sigInfo.blockTime,
            signature: sigInfo.signature,
            instruction: lastName,
            state: closed ? null : cloneState(state),
            decodedContent: closed ? null : tryDecode(state),
        });

        if (closed) break;
    }

    return snapshots;
}
