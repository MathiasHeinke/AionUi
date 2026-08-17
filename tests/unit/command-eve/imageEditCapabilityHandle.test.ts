import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mintImageEditCapabilityGrant } from '@/common/config/eveArtifactCapabilityHandleCore';
import {
  ensureImageEditCapabilityHandle,
  readArtifactCapabilityGrant,
  resolveImageEditCapability,
} from '@/process/commandEve/artifactCapabilityHandleStore';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const SEAT_A = 'seat-a';
const SEAT_B = 'seat-b';

let dataRoot: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-image-cap-'));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('image_edit capability grants', () => {
  it('mints a grant bound to conversation + artifact + bytes + operation', () => {
    const grant = mintImageEditCapabilityGrant({
      seatId: SEAT_A,
      conversationId: 'conv-1',
      artifactId: 'img_1',
      artifactSha256: SHA,
      nowMs: 1000,
      randomBytes: (size) => new Uint8Array(size).fill(1),
    });
    expect(grant).toMatchObject({
      conversation_id: 'conv-1',
      artifact_id: 'img_1',
      artifact_sha256: SHA,
      operation: 'image_edit',
      seat_id: SEAT_A,
    });
    expect(grant!.handle).toBe(`evecap_${'01'.repeat(32)}`);
  });

  it('ensure reuses ONE handle per (conversation, artifact, bytes) and re-mints on byte change', () => {
    const ref = { conversation_id: 'conv-1', artifact_id: 'img_1', artifact_sha256: SHA, seat_id: SEAT_A };
    const now = Date.now();
    const first = ensureImageEditCapabilityHandle(dataRoot, ref, { nowMs: now });
    const again = ensureImageEditCapabilityHandle(dataRoot, ref, { nowMs: now + 1000 });
    expect(first).toBeTruthy();
    expect(again).toBe(first);
    const changed = ensureImageEditCapabilityHandle(
      dataRoot,
      { ...ref, artifact_sha256: OTHER_SHA },
      { nowMs: now + 2000 }
    );
    expect(changed).toBeTruthy();
    expect(changed).not.toBe(first);
  });

  it('resolve judges well-formedness, existence, conversation, operation and bytes', () => {
    const handle = ensureImageEditCapabilityHandle(
      dataRoot,
      { conversation_id: 'conv-1', artifact_id: 'img_1', artifact_sha256: SHA, seat_id: SEAT_A },
      { nowMs: Date.now() }
    )!;
    expect(
      resolveImageEditCapability(dataRoot, { handle, observedArtifactSha256: SHA, expectedSeatId: SEAT_A })
    ).toMatchObject({ ok: true });
    expect(
      resolveImageEditCapability(dataRoot, {
        handle: 'evecap_nope',
        observedArtifactSha256: SHA,
        expectedSeatId: SEAT_A,
      })
    ).toEqual({
      ok: false,
      reason: 'handle-malformed',
    });
    expect(
      resolveImageEditCapability(dataRoot, {
        handle: `evecap_${'9'.repeat(64)}`,
        observedArtifactSha256: SHA,
        expectedSeatId: SEAT_A,
      })
    ).toEqual({ ok: false, reason: 'handle-unknown' });
    expect(
      resolveImageEditCapability(dataRoot, {
        handle,
        observedArtifactSha256: SHA,
        expectedSeatId: SEAT_A,
        expectedConversationId: 'conv-2',
      })
    ).toEqual({ ok: false, reason: 'conversation-mismatch' });
    expect(
      resolveImageEditCapability(dataRoot, { handle, observedArtifactSha256: OTHER_SHA, expectedSeatId: SEAT_A })
    ).toEqual({
      ok: false,
      reason: 'artifact-changed',
    });
  });

  it('a VIDEO grant presented for image_edit is operation-mismatch, and the image grant reads back via the shared store', () => {
    // Mint a video grant through the shared core by hand into the store.
    const imageHandle = ensureImageEditCapabilityHandle(
      dataRoot,
      { conversation_id: 'conv-1', artifact_id: 'img_1', artifact_sha256: SHA, seat_id: SEAT_A },
      { nowMs: Date.now() }
    )!;
    const grant = readArtifactCapabilityGrant(dataRoot, imageHandle, Date.now(), SEAT_A);
    expect(grant?.operation).toBe('image_edit');

    const videoGrant = {
      handle: `evecap_${'7'.repeat(64)}`,
      conversation_id: 'conv-1',
      artifact_id: 'video-1',
      artifact_sha256: SHA,
      operation: 'video_edit' as const,
      issued_at_ms: Date.now(),
      // Same seat, so the OPERATION is the only thing that can disqualify it.
      seat_id: SEAT_A,
    };
    fs.mkdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'), { recursive: true });
    const key = crypto.createHash('sha256').update(videoGrant.handle).digest('hex');
    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-artifact-capabilities', `${key}.json`),
      JSON.stringify(videoGrant)
    );
    expect(
      resolveImageEditCapability(dataRoot, {
        handle: videoGrant.handle,
        observedArtifactSha256: SHA,
        expectedSeatId: SEAT_A,
      })
    ).toEqual({
      ok: false,
      reason: 'operation-mismatch',
    });

    // A video grant belonging to ANOTHER seat must not even reveal that it
    // exists: the wrong-seat answer is indistinguishable from an unknown handle,
    // so a foreign seat cannot probe for the artifacts of its neighbour.
    const foreignGrant = { ...videoGrant, handle: `evecap_${'8'.repeat(64)}`, seat_id: SEAT_B };
    fs.writeFileSync(
      path.join(
        dataRoot,
        'command-eve-artifact-capabilities',
        `${crypto.createHash('sha256').update(foreignGrant.handle).digest('hex')}.json`
      ),
      JSON.stringify(foreignGrant)
    );
    expect(
      resolveImageEditCapability(dataRoot, {
        handle: foreignGrant.handle,
        observedArtifactSha256: SHA,
        expectedSeatId: SEAT_A,
      })
    ).toEqual({ ok: false, reason: 'handle-unknown' });
  });

  it('uses independent image-only indexes for identical conversation and artifact ids across seats', () => {
    const common = { conversation_id: 'conv-1', artifact_id: 'img_same', artifact_sha256: SHA };
    const now = Date.now();
    const seatAHandle = ensureImageEditCapabilityHandle(dataRoot, { ...common, seat_id: SEAT_A }, { nowMs: now })!;
    const seatBHandle = ensureImageEditCapabilityHandle(dataRoot, { ...common, seat_id: SEAT_B }, { nowMs: now })!;

    expect(seatBHandle).not.toBe(seatAHandle);
    expect(ensureImageEditCapabilityHandle(dataRoot, { ...common, seat_id: SEAT_A }, { nowMs: now + 1 })).toBe(
      seatAHandle
    );
    expect(ensureImageEditCapabilityHandle(dataRoot, { ...common, seat_id: SEAT_B }, { nowMs: now + 1 })).toBe(
      seatBHandle
    );
    expect(readArtifactCapabilityGrant(dataRoot, seatAHandle, now + 1, SEAT_A)).toMatchObject({ seat_id: SEAT_A });
    expect(readArtifactCapabilityGrant(dataRoot, seatAHandle, now + 1, SEAT_B)).toBeUndefined();
    expect(readArtifactCapabilityGrant(dataRoot, seatBHandle, now + 1, SEAT_B)).toMatchObject({ seat_id: SEAT_B });
  });

  it('migrates only a completely missing image seat_id to seat-1 and refuses explicit malformed values', () => {
    const now = Date.now();
    const handle = ensureImageEditCapabilityHandle(
      dataRoot,
      { conversation_id: 'conv-legacy', artifact_id: 'img_legacy', artifact_sha256: SHA, seat_id: 'seat-1' },
      { nowMs: now }
    )!;
    const grantPath = path.join(
      dataRoot,
      'command-eve-artifact-capabilities',
      `${crypto.createHash('sha256').update(handle).digest('hex')}.json`
    );
    const legacy = JSON.parse(fs.readFileSync(grantPath, 'utf8')) as Record<string, unknown>;
    delete legacy.seat_id;
    fs.writeFileSync(grantPath, JSON.stringify(legacy), { mode: 0o600 });

    expect(readArtifactCapabilityGrant(dataRoot, handle, now + 1, 'seat-1')).toMatchObject({ seat_id: 'seat-1' });
    expect(JSON.parse(fs.readFileSync(grantPath, 'utf8'))).toMatchObject({ seat_id: 'seat-1' });
    expect(readArtifactCapabilityGrant(dataRoot, handle, now + 1, SEAT_A)).toBeUndefined();

    const malformed = JSON.parse(fs.readFileSync(grantPath, 'utf8')) as Record<string, unknown>;
    malformed.seat_id = null;
    fs.writeFileSync(grantPath, JSON.stringify(malformed), { mode: 0o600 });
    expect(readArtifactCapabilityGrant(dataRoot, handle, now + 1, 'seat-1')).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(grantPath, 'utf8'))).toMatchObject({ seat_id: null });
  });

  it('reuses a historical shared image index only for seat-1 and writes the new image-only index', () => {
    const now = Date.now();
    const ref = {
      conversation_id: 'conv-legacy-index',
      artifact_id: 'img_legacy_index',
      artifact_sha256: SHA,
      seat_id: 'seat-1',
    };
    const handle = ensureImageEditCapabilityHandle(dataRoot, ref, { nowMs: now })!;
    const indexDir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact');
    const imageIndex = path.join(
      indexDir,
      `${crypto
        .createHash('sha256')
        .update(`image_edit|${ref.seat_id}|${ref.conversation_id}|${ref.artifact_id}`)
        .digest('hex')}.json`
    );
    const legacyIndex = path.join(
      indexDir,
      `${crypto.createHash('sha256').update(`${ref.conversation_id}|${ref.artifact_id}`).digest('hex')}.json`
    );
    fs.renameSync(imageIndex, legacyIndex);
    const grantPath = path.join(
      dataRoot,
      'command-eve-artifact-capabilities',
      `${crypto.createHash('sha256').update(handle).digest('hex')}.json`
    );
    const legacyGrant = JSON.parse(fs.readFileSync(grantPath, 'utf8')) as Record<string, unknown>;
    delete legacyGrant.seat_id;
    fs.writeFileSync(grantPath, `${JSON.stringify(legacyGrant, null, 2)}\n`, { mode: 0o600 });

    expect(ensureImageEditCapabilityHandle(dataRoot, ref, { nowMs: now + 1 })).toBe(handle);
    expect(JSON.parse(fs.readFileSync(grantPath, 'utf8'))).toMatchObject({ seat_id: 'seat-1' });
    expect(JSON.parse(fs.readFileSync(imageIndex, 'utf8'))).toMatchObject({ handle, seat_id: 'seat-1' });
    expect(ensureImageEditCapabilityHandle(dataRoot, { ...ref, seat_id: SEAT_A }, { nowMs: now + 1 })).not.toBe(handle);
  });
});
