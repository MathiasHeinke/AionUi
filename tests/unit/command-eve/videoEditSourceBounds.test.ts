/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the bounded read that stands between a local file and a PAID
 * upload.
 *
 * `readBoundedVideoSource` is new in this slice and is the production default
 * for `deps.readVideoSource`. The edit suite already pins the ENOENT case ("the
 * source file is gone"); the three guards the function was actually written for
 * — a symlink, an oversized file, an empty file — had no test at all, and each
 * is a refusal that must happen BEFORE the licence read and BEFORE the upload.
 *
 * Why each one costs money or worse if it stops firing:
 *
 *   SYMLINK. The path comes from OUR record, but a record is a file on the
 *   user's disk and the file it names can be replaced by a link to something
 *   else. Following it would upload whatever it points at to a third-party
 *   provider. `lstat` + `isSymbolicLink()` is the whole defence, and nothing
 *   exercised it.
 *
 *   OVERSIZE. `lstatSync` first is deliberate — the comment says an enormous file
 *   must never be loaded into memory at all. Refusing after the read would be
 *   the same refusal with the damage already done, and no test could tell the
 *   two apart except this one.
 *
 *   EMPTY. Zero bytes is not a clip. Sending it buys a provider error at full
 *   price.
 *
 * Every refusal below asserts THREE things, not one: the reason code, that the
 * gateway was never called, and that the licence was never even read — because
 * "refused" and "refused before anything was spent" are different claims.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readLicenseWireMock = vi.fn();
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import type { CommandEveVideoBridgeDeps } from '@/process/bridge/commandEveVideoBridge';
import { handleCommandEveVideoEdit, MAX_VIDEO_EDIT_SOURCE_BYTES } from '@/process/bridge/commandEveVideoBridge';
import { ensureVideoEditCapabilityHandle } from '@/process/commandEve/artifactCapabilityHandleStore';
import {
  issueVideoEditSpendPermit,
  readVideoEditSpendPermitRecord,
} from '@/process/commandEve/videoEditSpendPermitStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import { buildVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';

let dataRoot: string;
let videoRoot: string;
let sourcePath: string;

const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Seed a record pointing at `sourcePath`. The FILE is written by each test, so
 * the record can name a symlink, an oversized file or nothing at all while the
 * record itself stays ordinary — which is exactly the situation the guards are
 * for: our record, someone else's file.
 */
function seedRecord() {
  const artifact = buildVideoConversationArtifact({
    id: 'video-aubergine',
    conversationId: 'conv-1',
    createdAtMs: 1_754_000_000_000,
    path: sourcePath,
    artifact: {
      mimeType: 'video/mp4',
      sha256: SOURCE_SHA,
      bytes: SOURCE_BYTES.byteLength,
      durationSeconds: 5,
      resolution: '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: 'sd',
    } as never,
  });
  saveVideoArtifactRecord(dataRoot, artifact);
  return artifact;
}

function permitForTurn(userTurnText: string): string {
  const permit = issueVideoEditSpendPermit(dataRoot, {
    conversationId: 'conv-1',
    userTurnSha256: crypto.createHash('sha256').update(userTurnText).digest('hex'),
    allowedArtifactSha256: [SOURCE_SHA],
  });
  expect(permit).toBeTruthy();
  return permit as string;
}

/**
 * Production deps with ONE deliberate omission: `readVideoSource` is left unset
 * so the handler falls through to the real `readBoundedVideoSource`. Stubbing it
 * here would make this whole file test a mock.
 */
function deps(fetchImpl: typeof fetch): CommandEveVideoBridgeDeps {
  return {
    getDataPath: () => dataRoot,
    fetch: fetchImpl,
    newRequestId: () => 'req-fixed',
    newArtifactId: () => 'video-edited',
    getActiveSeatId: () => 'seat-1',
    areFileSelectionPathsGranted: () => true,
    readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    saveVideoFile: (input) => {
      const savedPath = path.join(videoRoot, `${input.artifactId}.mp4`);
      fs.writeFileSync(savedPath, Buffer.from(input.dataBase64, 'base64'));
      return savedPath;
    },
    saveArtifactRecord: saveVideoArtifactRecord,
    // Injected, never via process.env — the spending flag stays default-off.
    isVideoEditEnabled: () => true,
  };
}

async function editWith(handle: string, permit: string) {
  const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: false }));
  const result = await handleCommandEveVideoEdit(
    { handle, permit, instruction: 'mach die Aubergine bunt' },
    deps(fetchImpl as unknown as typeof fetch)
  );
  return { result, fetchImpl };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-edit-bounds-'));
  videoRoot = path.join(dataRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
  sourcePath = path.join(videoRoot, 'video-aubergine.mp4');
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * The gateway's own ceiling, quoted so the derivation below has something real
 * to derive AGAINST: `MAX_VIDEO_SOURCE_BASE64_CHARS` at
 * `supabase/functions/eve-multimodal/video-generation-core.ts:352`, enforced at
 * :383 as `sourceBase64.length > MAX_VIDEO_SOURCE_BASE64_CHARS`. The comparison
 * is strict, so exactly 40,000,000 characters is ACCEPTED and 40,000,001 is not.
 */
const GATEWAY_MAX_SOURCE_BASE64_CHARS = 40_000_000;

describe('the bound this slice added is a real bound', () => {
  it('DERIVES the ceiling: a source at the limit still fits the gateway base64 check', () => {
    // This is deliberately NOT `expect(CONSTANT).toBe(<the same literal>)`, which
    // asserts the constant equals itself and stays green for any value. It
    // ENCODES a buffer of exactly the permitted size through the same expression
    // the bridge sends with (`Buffer.from(sourceBytes).toString('base64')`,
    // commandEveVideoBridge.ts:1031) and measures the string the gateway counts.
    //
    // The band this closes: with a byte ceiling above 30,000,000 the desktop
    // accepts, reads, base64s and UPLOADS a source the gateway then refuses —
    // exactly the round trip the constant's comment claims it prevents.
    const atCeiling = Buffer.from(new Uint8Array(MAX_VIDEO_EDIT_SOURCE_BYTES)).toString('base64').length;
    expect(atCeiling).toBeLessThanOrEqual(GATEWAY_MAX_SOURCE_BASE64_CHARS);

    // And it is TIGHT, not merely safe: one byte more would overshoot. Without
    // this half, a ceiling of 1 byte would also pass the assertion above while
    // making the feature useless.
    const oneOver = Buffer.from(new Uint8Array(MAX_VIDEO_EDIT_SOURCE_BYTES + 1)).toString('base64').length;
    expect(oneOver).toBeGreaterThan(GATEWAY_MAX_SOURCE_BASE64_CHARS);
  });

  it('POSITIVE BOUNDARY CONTROL: a file AT the ceiling is read, so the bound is a bound and not a wall', async () => {
    seedRecord();
    // Sparse, so this costs no disk. `lstatSync().size` is what the guard reads.
    const fd = fs.openSync(sourcePath, 'w');
    fs.ftruncateSync(fd, MAX_VIDEO_EDIT_SOURCE_BYTES);
    fs.closeSync(fd);
    const handle = ensureVideoEditCapabilityHandle(dataRoot, seedRecord())!;
    const { result, fetchImpl } = await editWith(handle, permitForTurn('mach die Aubergine bunt'));

    // It got PAST the reader — proven by the fact that the refusal is now the
    // hash comparison on the bytes it actually read, a strictly later guard.
    expect(result.ok === false && result.reasonCode).toBe('video-edit-artifact-changed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('an out-of-bounds source is refused before the licence and before the upload', () => {
  it('refuses a source ONE byte over the ceiling', async () => {
    seedRecord();
    const fd = fs.openSync(sourcePath, 'w');
    fs.ftruncateSync(fd, MAX_VIDEO_EDIT_SOURCE_BYTES + 1);
    fs.closeSync(fd);
    const handle = ensureVideoEditCapabilityHandle(dataRoot, seedRecord())!;
    const { result, fetchImpl } = await editWith(handle, permitForTurn('mach die Aubergine bunt'));

    expect(result.ok === false && result.reasonCode).toBe('video-edit-source-unreadable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readLicenseWireMock).not.toHaveBeenCalled();
  });

  it('refuses an EMPTY source rather than paying to send zero bytes', async () => {
    seedRecord();
    fs.writeFileSync(sourcePath, Buffer.alloc(0));
    const handle = ensureVideoEditCapabilityHandle(dataRoot, seedRecord())!;
    const { result, fetchImpl } = await editWith(handle, permitForTurn('mach die Aubergine bunt'));

    expect(result.ok === false && result.reasonCode).toBe('video-edit-source-unreadable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readLicenseWireMock).not.toHaveBeenCalled();
  });
});

describe('the reader never follows a link out of the clip it was given', () => {
  it('refuses a SYMLINK, even one pointing at a perfectly readable file', async () => {
    // The elsewhere file is deliberately readable and in bounds, so nothing but
    // the symlink check itself can be producing this refusal.
    const elsewhere = path.join(dataRoot, 'somebody-elses-secret.mp4');
    fs.writeFileSync(elsewhere, SOURCE_BYTES);
    seedRecord();
    fs.symlinkSync(elsewhere, sourcePath);
    const handle = ensureVideoEditCapabilityHandle(dataRoot, seedRecord())!;
    const { result, fetchImpl } = await editWith(handle, permitForTurn('mach die Aubergine bunt'));

    expect(result.ok === false && result.reasonCode).toBe('video-edit-source-unreadable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readLicenseWireMock).not.toHaveBeenCalled();
  });

  it('refuses a DIRECTORY standing where the clip should be', async () => {
    // HONEST NOTE: this one is belt-and-braces. `readFileSync` throws EISDIR on
    // its own, so deleting the `isFile()` guard does NOT turn this red — unlike
    // the three above, which each go red when their guard is removed. It is here
    // to pin the OBSERVED refusal, not to claim credit for catching a regression
    // it cannot catch.
    seedRecord();
    fs.mkdirSync(sourcePath, { recursive: true });
    const handle = ensureVideoEditCapabilityHandle(dataRoot, seedRecord())!;
    const { result, fetchImpl } = await editWith(handle, permitForTurn('mach die Aubergine bunt'));

    expect(result.ok === false && result.reasonCode).toBe('video-edit-source-unreadable');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readLicenseWireMock).not.toHaveBeenCalled();
  });
});

describe('a bounds refusal is FREE — it never burns the turn', () => {
  it('leaves the spend permit intact, so the user can retry with a real clip', async () => {
    seedRecord();
    fs.writeFileSync(sourcePath, Buffer.alloc(0));
    const handle = ensureVideoEditCapabilityHandle(dataRoot, seedRecord())!;
    const permit = permitForTurn('mach die Aubergine bunt');

    const { result } = await editWith(handle, permit);
    expect(result.ok).toBe(false);

    // The record is still there and still unconsumed. A refusal that silently
    // spent the permit would charge the user a turn for our own guard firing.
    const record = readVideoEditSpendPermitRecord(dataRoot, permit);
    expect(record).toBeDefined();
    expect(record?.conversation_id).toBe('conv-1');
  });
});
