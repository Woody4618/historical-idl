import { NextRequest, NextResponse } from 'next/server';
import { Address, createSolanaRpc } from '@solana/kit';
import { fetchMetadataContent } from '@solana-program/program-metadata';
import { findAnchorIdlAddress } from '@core/anchor';
import { inflate } from 'node:zlib';
import { promisify } from 'node:util';

const zlibInflate = promisify(inflate);

export const maxDuration = 30;

function readU32LE(buf: Buffer, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      ((buf[offset + 3] << 24) >>> 0)) >>>
    0
  );
}

async function fetchCurrentAnchorIdl(
  rpc: ReturnType<typeof createSolanaRpc>,
  programId: Address,
): Promise<string | null> {
  const idlAddr = await findAnchorIdlAddress(programId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountInfo = await (rpc as any)
    .getAccountInfo(idlAddr, { encoding: 'base64' })
    .send();

  if (!accountInfo?.value?.data) return null;

  const raw = Buffer.from(accountInfo.value.data[0], 'base64');
  if (raw.length <= 44) return null;

  // Anchor IDL account layout: 8 discriminator + 32 authority + 4 data_len + data
  const dataLen = readU32LE(raw, 40);
  if (dataLen === 0 || 44 + dataLen > raw.length) return null;

  const compressed = raw.slice(44, 44 + dataLen);
  const decompressed = await zlibInflate(compressed);
  return decompressed.toString('utf8');
}

async function fetchCurrentPmpIdl(
  rpc: ReturnType<typeof createSolanaRpc>,
  programId: Address,
): Promise<string | null> {
  try {
    const content = await fetchMetadataContent(rpc, programId, 'idl');
    return content || null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const programId = req.nextUrl.searchParams.get('programId')?.trim();

    if (!programId || programId.length < 32) {
      return NextResponse.json({ error: 'Missing or invalid programId query parameter' }, { status: 400 });
    }

    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      return NextResponse.json({ error: 'RPC_URL not configured on server' }, { status: 500 });
    }

    const rpc = createSolanaRpc(rpcUrl);
    const addr = programId as Address;

    // Try PMP first
    const pmpContent = await fetchCurrentPmpIdl(rpc, addr);
    if (pmpContent) {
      let parsed: unknown;
      try { parsed = JSON.parse(pmpContent); } catch { parsed = null; }

      return NextResponse.json({
        programId,
        type: 'pmp',
        idl: parsed ?? pmpContent,
      });
    }

    // Fall back to Anchor
    const anchorContent = await fetchCurrentAnchorIdl(rpc, addr);
    if (anchorContent) {
      let parsed: unknown;
      try { parsed = JSON.parse(anchorContent); } catch { parsed = null; }

      return NextResponse.json({
        programId,
        type: 'anchor',
        idl: parsed ?? anchorContent,
      });
    }

    return NextResponse.json(
      { error: 'No IDL found for this program (checked PMP and Anchor)' },
      { status: 404 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
