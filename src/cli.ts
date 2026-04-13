#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { Address, createSolanaRpc } from '@solana/kit';
import { Command } from 'commander';
import pc from 'picocolors';

import {
    COMPRESSION_NAME,
    DISC_LABEL,
    ENCODING_NAME,
    FORMAT_NAME,
    findPmpMetadataPda,
    reconstructHistory,
    type Snapshot,
} from './program-metadata.js';

// ─── Display ─────────────────────────────────────────────────────────────────

function fmtTime(blockTime: bigint | null): string {
    if (!blockTime) return 'unknown time         ';
    return new Date(Number(blockTime) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function displaySnapshots(snapshots: Snapshot[]): void {
    const count = snapshots.length;
    console.log(pc.bold(`Found ${count} state change${count === 1 ? '' : 's'}:\n`));

    for (const snap of snapshots) {
        const slot = pc.cyan(snap.slot.toString().padStart(14));
        const time = pc.dim(fmtTime(snap.blockTime));
        const instr = pc.yellow(snap.instruction.padEnd(14));

        if (!snap.state) {
            console.log(`${slot}  ${time}  ${instr}  ${pc.red('CLOSED')}`);
            console.log(
                `               ${' '.repeat(21)} ${pc.dim('sig: ' + snap.signature)}\n`,
            );
            continue;
        }

        const { state } = snap;
        const discLabel = DISC_LABEL[state.discriminator] ?? 'Unknown';
        let dataInfo: string;

        if (state.discriminator === 2) {
            const fmt = FORMAT_NAME[state.format] ?? `fmt(${state.format})`;
            const enc = ENCODING_NAME[state.encoding] ?? `enc(${state.encoding})`;
            const cmp = COMPRESSION_NAME[state.compression] ?? `cmp(${state.compression})`;
            const mutable = state.mutable ? '' : pc.red(' immutable');
            dataInfo =
                pc.green(`${state.dataLength} bytes`) +
                `  ${fmt}/${enc}/${cmp}${mutable}`;
        } else {
            dataInfo = pc.dim(
                discLabel +
                    (state.data.length > 0 ? `  ${state.data.length} bytes buffered` : ''),
            );
        }

        console.log(`${slot}  ${time}  ${instr}  ${dataInfo}`);
        console.log(
            `               ${' '.repeat(21)} ${pc.dim('sig: ' + snap.signature)}`,
        );

        if (snap.decodedContent !== null) {
            const preview =
                snap.decodedContent.length > 140
                    ? snap.decodedContent.slice(0, 140) + pc.dim('…')
                    : snap.decodedContent;
            console.log(
                `               ${' '.repeat(21)} ${pc.dim('↳')} ${preview}`,
            );
        }

        console.log();
    }
}

// ─── Save / export ───────────────────────────────────────────────────────────

function saveSnapshots(snapshots: Snapshot[], outDir: string): void {
    fs.mkdirSync(outDir, { recursive: true });

    for (const snap of snapshots) {
        const filename = `${snap.slot}_${snap.instruction.toLowerCase()}.json`;
        const filepath = path.join(outDir, filename);

        const serialisable = {
            slot: snap.slot.toString(),
            blockTime: snap.blockTime !== null ? Number(snap.blockTime) : null,
            signature: snap.signature,
            instruction: snap.instruction,
            state: snap.state
                ? {
                      discriminator: snap.state.discriminator,
                      authority: snap.state.authority,
                      mutable: snap.state.mutable,
                      canonical: snap.state.canonical,
                      seed: Buffer.from(snap.state.seed).toString('hex'),
                      encoding:
                          ENCODING_NAME[snap.state.encoding] ?? snap.state.encoding,
                      compression:
                          COMPRESSION_NAME[snap.state.compression] ??
                          snap.state.compression,
                      format:
                          FORMAT_NAME[snap.state.format] ?? snap.state.format,
                      dataSource: snap.state.dataSource,
                      dataLength: snap.state.dataLength,
                      data: Buffer.from(
                          snap.state.data.slice(0, snap.state.dataLength),
                      ).toString('base64'),
                  }
                : null,
            decodedContent: snap.decodedContent,
        };

        fs.writeFileSync(filepath, JSON.stringify(serialisable, null, 2));
    }
}

type IdlVersion = {
    version: string | null;
    filename: string;
    activeFrom: { slot: string; time: string | null };
    activeTo: { slot: string; time: string | null } | 'current';
};

function dumpDistinctIdls(snapshots: Snapshot[], outDir: string): number {
    fs.mkdirSync(outDir, { recursive: true });

    // Collect distinct IDL versions with their activation slots.
    const versions: {
        content: string;
        version: string | null;
        fromSlot: bigint;
        fromTime: bigint | null;
    }[] = [];

    let prevContent: string | null = null;
    for (const snap of snapshots) {
        if (snap.decodedContent === null) continue;
        if (snap.decodedContent === prevContent) continue;
        prevContent = snap.decodedContent;

        let version: string | null = null;
        try {
            const parsed = JSON.parse(snap.decodedContent) as Record<string, unknown>;
            const v =
                parsed['version'] ??
                (parsed['metadata'] as Record<string, unknown> | undefined)?.['version'];
            if (typeof v === 'string') version = v;
        } catch {
            /* not JSON */
        }

        versions.push({
            content: snap.decodedContent,
            version,
            fromSlot: snap.slot,
            fromTime: snap.blockTime,
        });
    }

    // Find the last slot that touched the account (for the "activeTo" of the
    // latest version — might be a re-upload or SetImmutable after the last
    // content change).
    const lastSnap = snapshots[snapshots.length - 1];
    const isClosed = lastSnap && !lastSnap.state;

    // Write each distinct IDL file and build the index.
    const index: IdlVersion[] = [];
    for (let i = 0; i < versions.length; i++) {
        const v = versions[i];
        const suffix = v.version ? `_v${v.version}` : '';
        const filename = `${v.fromSlot}${suffix}.json`;
        fs.writeFileSync(path.join(outDir, filename), v.content);

        const next = versions[i + 1];
        const activeTo: IdlVersion['activeTo'] = next
            ? { slot: next.fromSlot.toString(), time: fmtTimeIso(next.fromTime) }
            : isClosed
              ? { slot: lastSnap.slot.toString(), time: fmtTimeIso(lastSnap.blockTime) }
              : 'current';

        index.push({
            version: v.version,
            filename,
            activeFrom: { slot: v.fromSlot.toString(), time: fmtTimeIso(v.fromTime) },
            activeTo,
        });
    }

    fs.writeFileSync(
        path.join(outDir, 'index.json'),
        JSON.stringify(index, null, 2),
    );

    // Print timeline summary.
    if (versions.length > 0) {
        console.log(pc.bold(`\nIDL version timeline:\n`));
        for (let i = 0; i < index.length; i++) {
            const entry = index[i];
            const from = `slot ${pc.cyan(entry.activeFrom.slot)}`;
            const fromTime = entry.activeFrom.time ? pc.dim(` (${entry.activeFrom.time})`) : '';
            const to =
                entry.activeTo === 'current'
                    ? pc.green('current')
                    : `slot ${pc.cyan(entry.activeTo.slot)}`;
            const toTime =
                entry.activeTo !== 'current' && entry.activeTo.time
                    ? pc.dim(` (${entry.activeTo.time})`)
                    : '';
            const ver = entry.version ? pc.yellow(`v${entry.version}`) : pc.dim('(no version)');
            console.log(`  ${ver}  ${from}${fromTime}  →  ${to}${toTime}`);
            console.log(`  ${pc.dim(`  └─ ${entry.filename}`)}`);
        }
        console.log();
    }

    return versions.length;
}

function fmtTimeIso(blockTime: bigint | null): string | null {
    if (!blockTime) return null;
    return new Date(Number(blockTime) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command()
    .name('historical-idl')
    .description('Reconstruct historical IDL versions from on-chain Solana transactions')
    .version('0.1.0')
    .argument('<program-address>', 'Program address to look up IDL history for')
    .option('-r, --rpc <url>', 'Solana RPC URL (or set RPC_URL env var)')
    .option('-s, --seed <seed>', 'Metadata seed', 'idl')
    .option('-a, --authority <address>', 'Authority address (for non-canonical metadata)')
    .option('-o, --output <dir>', 'Directory to save full snapshots')
    .option('--dump-idls <dir>', 'Directory to write each distinct IDL version')
    .action(async (programAddress: string, opts) => {
        const rpcUrl: string | undefined = opts.rpc ?? process.env.RPC_URL;
        if (!rpcUrl) {
            console.error(
                pc.red('Error: No RPC URL provided. Use --rpc <url> or set the RPC_URL environment variable.'),
            );
            process.exit(1);
        }

        const rpc = createSolanaRpc(rpcUrl);
        const addr = programAddress as Address;
        const seed: string = opts.seed;
        const authority: Address | undefined = opts.authority
            ? (opts.authority as Address)
            : undefined;

        const metadataAddr = await findPmpMetadataPda(addr, seed, authority);

        console.log(pc.bold('Reconstructing metadata history...\n'));
        console.log(`  ${pc.dim('program:')}    ${addr}`);
        console.log(`  ${pc.dim('seed:')}       ${seed}`);
        if (authority) console.log(`  ${pc.dim('authority:')}  ${authority}`);
        console.log(`  ${pc.dim('metadata:')}   ${metadataAddr}`);
        console.log(`  ${pc.dim('rpc:')}        ${rpcUrl}`);
        console.log();

        let snapshots: Snapshot[];
        try {
            snapshots = await reconstructHistory(rpc, metadataAddr);
        } catch (err) {
            console.error(pc.red((err as Error).message ?? String(err)));
            process.exit(1);
        }

        if (snapshots.length === 0) {
            console.log(pc.yellow('No transactions found for this metadata account.'));
            return;
        }

        displaySnapshots(snapshots);

        if (opts.output) {
            saveSnapshots(snapshots, opts.output);
            console.log(
                pc.green(
                    `Saved ${snapshots.length} snapshot(s) to ${pc.bold(opts.output)}`,
                ),
            );
        }

        if (opts.dumpIdls) {
            const written = dumpDistinctIdls(snapshots, opts.dumpIdls);
            console.log(
                pc.green(
                    `Wrote ${written} distinct IDL version(s) to ${pc.bold(opts.dumpIdls)}`,
                ),
            );
        }
    });

program.parse();
