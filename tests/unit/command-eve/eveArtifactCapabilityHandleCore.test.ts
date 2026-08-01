/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 C2 — the authority mechanism.
 *
 * The claim under test is "a model cannot reach an artifact it was not granted".
 * That claim is only worth something if every way of getting it wrong has a test
 * that goes red, so each refusal below is paired with the positive case it is
 * distinguished from — otherwise a function that refused EVERYTHING would pass.
 */

import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_CAPABILITY_HANDLE_ENTROPY_BYTES,
  ARTIFACT_CAPABILITY_HANDLE_PREFIX,
  constantTimeHandleEquals,
  isWellFormedArtifactCapabilityHandle,
  mintArtifactCapabilityGrant,
  mintVideoEditCapabilityGrant,
  resolveArtifactCapabilityGrant,
  type ArtifactCapabilityGrant,
} from '@/common/config/eveArtifactCapabilityHandleCore';
import {
  buildVideoConversationArtifact,
  type CommandEveVideoConversationArtifact,
} from '@/common/config/videoGenerationRequestCore';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** A deterministic byte source so a minted handle is predictable in a test. */
function fixedRandomBytes(fill: number): (size: number) => Uint8Array {
  return (size: number) => new Uint8Array(size).fill(fill);
}

function mint(overrides: Partial<Parameters<typeof mintArtifactCapabilityGrant>[0]> = {}) {
  return mintArtifactCapabilityGrant({
    conversationId: 'conv-1',
    artifactId: 'video-1',
    artifactSha256: SHA_A,
    operation: 'video_edit',
    nowMs: 1_754_000_000_000,
    randomBytes: fixedRandomBytes(0x11),
    ...overrides,
  });
}

function modernArtifact(
  overrides: { durationSeconds?: number; id?: string; resolution?: string } = {}
): CommandEveVideoConversationArtifact {
  return buildVideoConversationArtifact({
    id: overrides.id ?? 'video-modern',
    conversationId: 'conv-1',
    createdAtMs: 1_754_000_100_000,
    path: '/tmp/videos/conv-1/video-modern.mp4',
    artifact: {
      mimeType: 'video/mp4',
      sha256: SHA_B,
      bytes: 999,
      durationSeconds: overrides.durationSeconds ?? 5,
      resolution: overrides.resolution ?? '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: overrides.resolution === '1080p' ? 'hd' : 'sd',
    } as never,
  });
}

describe('the handle itself', () => {
  it('carries at least 32 bytes of entropy', () => {
    const grant = mint();
    expect(grant).toBeDefined();
    const body = grant!.handle.slice(ARTIFACT_CAPABILITY_HANDLE_PREFIX.length);
    // Hex, so two characters per byte. Asserting the WIDTH rather than the
    // constant means shrinking the constant alone cannot make this pass.
    expect(body).toHaveLength(ARTIFACT_CAPABILITY_HANDLE_ENTROPY_BYTES * 2);
    expect(body).toHaveLength(64);
  });

  it('refuses to mint from a short random read instead of padding it', () => {
    // The NEGATIVE CONTROL for "32 bytes of entropy". A random source that
    // returns fewer bytes is a silent downgrade of the only thing that makes a
    // handle unguessable, so it must produce nothing at all.
    expect(mint({ randomBytes: () => new Uint8Array(8).fill(1) })).toBeUndefined();
    // ...and the same call with a full-width source DOES mint, which proves the
    // refusal above is about the width and not about the test setup.
    expect(mint({ randomBytes: fixedRandomBytes(1) })).toBeDefined();
  });

  it('refuses to mint when the random source throws', () => {
    expect(
      mint({
        randomBytes: () => {
          throw new Error('no entropy');
        },
      })
    ).toBeUndefined();
  });

  it('accepts only its own shape', () => {
    expect(isWellFormedArtifactCapabilityHandle(mint()!.handle)).toBe(true);
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'conv-1',
      'video-1',
      `${ARTIFACT_CAPABILITY_HANDLE_PREFIX}${'a'.repeat(63)}`,
      `${ARTIFACT_CAPABILITY_HANDLE_PREFIX}${'A'.repeat(64)}`,
      `${ARTIFACT_CAPABILITY_HANDLE_PREFIX}${'z'.repeat(64)}`,
      'a'.repeat(64),
    ]) {
      expect(isWellFormedArtifactCapabilityHandle(bad)).toBe(false);
    }
  });

  it('compares without an early exit', () => {
    const a = `${ARTIFACT_CAPABILITY_HANDLE_PREFIX}${'a'.repeat(64)}`;
    expect(constantTimeHandleEquals(a, a)).toBe(true);
    expect(constantTimeHandleEquals(a, `${ARTIFACT_CAPABILITY_HANDLE_PREFIX}${'a'.repeat(63)}b`)).toBe(false);
    expect(constantTimeHandleEquals(a, `${a}extra`)).toBe(false);
  });

  it('refuses a mint whose binding is incomplete', () => {
    expect(mint({ conversationId: '' })).toBeUndefined();
    expect(mint({ artifactId: '' })).toBeUndefined();
    expect(mint({ artifactSha256: 'too-short' })).toBeUndefined();
    expect(mint({ operation: 'artifact_read' as never })).toBeUndefined();
  });
});

describe('resolution refuses on every mismatch', () => {
  const grant = mint() as ArtifactCapabilityGrant;

  const resolve = (overrides: Partial<Parameters<typeof resolveArtifactCapabilityGrant>[0]> = {}) =>
    resolveArtifactCapabilityGrant({
      handle: grant.handle,
      grant,
      conversationId: 'conv-1',
      operation: 'video_edit',
      observedArtifactSha256: SHA_A,
      ...overrides,
    });

  it('authorises the exact tuple it was minted for', () => {
    // The POSITIVE control. Without it, every refusal below would also pass in a
    // function that refused unconditionally.
    expect(resolve()).toEqual({ ok: true, grant });
  });

  it('refuses a handle it never minted', () => {
    expect(resolve({ handle: `${ARTIFACT_CAPABILITY_HANDLE_PREFIX}${'c'.repeat(64)}` })).toEqual({
      ok: false,
      reason: 'handle-unknown',
    });
  });

  it('refuses when the store has nothing for the handle', () => {
    expect(resolve({ grant: undefined })).toEqual({ ok: false, reason: 'handle-unknown' });
  });

  it('refuses a malformed handle before it ever reaches the store comparison', () => {
    expect(resolve({ handle: 'conv-1' })).toEqual({ ok: false, reason: 'handle-malformed' });
  });

  it('refuses a handle minted for another conversation', () => {
    // The whole reason handles exist: conversation scoping cannot be enforced by
    // asking the model which conversation it is in.
    expect(resolve({ conversationId: 'conv-2' })).toEqual({ ok: false, reason: 'conversation-mismatch' });
  });

  it('refuses a handle minted for another operation', () => {
    expect(resolve({ operation: 'artifact_read' as never })).toEqual({ ok: false, reason: 'operation-mismatch' });
  });

  it('refuses when the bytes on disk no longer match the binding', () => {
    expect(resolve({ observedArtifactSha256: SHA_B })).toEqual({ ok: false, reason: 'artifact-changed' });
  });

  it('refuses when the observed hash is not a hash at all', () => {
    expect(resolve({ observedArtifactSha256: '' })).toEqual({ ok: false, reason: 'artifact-changed' });
    expect(resolve({ observedArtifactSha256: 'not-a-sha' })).toEqual({ ok: false, reason: 'artifact-changed' });
  });
});

describe('a handle is never minted for a clip that cannot be edited', () => {
  it('mints for an editable clip', () => {
    const grant = mintVideoEditCapabilityGrant({
      artifact: modernArtifact(),
      nowMs: 1,
      randomBytes: fixedRandomBytes(0x22),
    });
    expect(grant?.artifact_sha256).toBe(SHA_B);
    expect(grant?.operation).toBe('video_edit');
  });

  it('refuses a clip past the 8.7 second ceiling', () => {
    expect(
      mintVideoEditCapabilityGrant({
        artifact: modernArtifact({ durationSeconds: 9 }),
        nowMs: 1,
        randomBytes: fixedRandomBytes(0x22),
      })
    ).toBeUndefined();
  });

  it('refuses a 1080p clip, which the edit endpoint does not serve', () => {
    expect(
      mintVideoEditCapabilityGrant({
        artifact: modernArtifact({ resolution: '1080p' }),
        nowMs: 1,
        randomBytes: fixedRandomBytes(0x22),
      })
    ).toBeUndefined();
  });

  it('refuses a clip whose length was never recoverable', () => {
    const unreadable = {
      ...modernArtifact(),
      payload: { ...modernArtifact().payload, description: 'Video', duration_seconds: 0, tier_id: undefined },
    } as CommandEveVideoConversationArtifact;
    expect(
      mintVideoEditCapabilityGrant({ artifact: unreadable, nowMs: 1, randomBytes: fixedRandomBytes(0x22) })
    ).toBeUndefined();
  });
});
