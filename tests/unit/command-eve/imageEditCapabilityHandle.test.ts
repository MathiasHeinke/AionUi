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
    });
    expect(grant!.handle).toBe(`evecap_${'01'.repeat(32)}`);
  });

  it('ensure reuses ONE handle per (conversation, artifact, bytes) and re-mints on byte change', () => {
    const ref = { conversation_id: 'conv-1', artifact_id: 'img_1', artifact_sha256: SHA };
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
      { conversation_id: 'conv-1', artifact_id: 'img_1', artifact_sha256: SHA },
      { nowMs: Date.now() }
    )!;
    expect(resolveImageEditCapability(dataRoot, { handle, observedArtifactSha256: SHA })).toMatchObject({ ok: true });
    expect(resolveImageEditCapability(dataRoot, { handle: 'evecap_nope', observedArtifactSha256: SHA })).toEqual({
      ok: false,
      reason: 'handle-malformed',
    });
    expect(
      resolveImageEditCapability(dataRoot, { handle: `evecap_${'9'.repeat(64)}`, observedArtifactSha256: SHA })
    ).toEqual({ ok: false, reason: 'handle-unknown' });
    expect(
      resolveImageEditCapability(dataRoot, { handle, observedArtifactSha256: SHA, expectedConversationId: 'conv-2' })
    ).toEqual({ ok: false, reason: 'conversation-mismatch' });
    expect(resolveImageEditCapability(dataRoot, { handle, observedArtifactSha256: OTHER_SHA })).toEqual({
      ok: false,
      reason: 'artifact-changed',
    });
  });

  it('a VIDEO grant presented for image_edit is operation-mismatch, and the image grant reads back via the shared store', () => {
    // Mint a video grant through the shared core by hand into the store.
    const imageHandle = ensureImageEditCapabilityHandle(
      dataRoot,
      { conversation_id: 'conv-1', artifact_id: 'img_1', artifact_sha256: SHA },
      { nowMs: Date.now() }
    )!;
    const grant = readArtifactCapabilityGrant(dataRoot, imageHandle);
    expect(grant?.operation).toBe('image_edit');

    const videoGrant = {
      handle: `evecap_${'7'.repeat(64)}`,
      conversation_id: 'conv-1',
      artifact_id: 'video-1',
      artifact_sha256: SHA,
      operation: 'video_edit' as const,
      issued_at_ms: Date.now(),
    };
    fs.mkdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'), { recursive: true });
    const key = crypto.createHash('sha256').update(videoGrant.handle).digest('hex');
    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-artifact-capabilities', `${key}.json`),
      JSON.stringify(videoGrant)
    );
    expect(resolveImageEditCapability(dataRoot, { handle: videoGrant.handle, observedArtifactSha256: SHA })).toEqual({
      ok: false,
      reason: 'operation-mismatch',
    });
  });
});
