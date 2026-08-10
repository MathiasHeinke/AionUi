/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — WHERE THE PRICE OF AN EDIT COMES FROM, for a clip that predates it.
 *
 * An edit is not allowed to choose its tier: it inherits the source's. For a
 * clip generated BEFORE this slice, the record on disk carries no `tier_id` at
 * all, so `resolveVideoArtifactTier` recovers it by reading back the durable
 * human description this lane has always written:
 *
 *     480p · 5s · ca. 500 Credits · grok-imagine-video
 *
 * That recovered token decides the MODEL and the PRICE of a paid call. Nothing
 * tested it. The suite's editability tests all build MODERN artifacts through
 * `buildVideoConversationArtifact`, which sets `tier_id` explicitly — so the
 * legacy branch, which is the branch every clip the founder already has will
 * take, was never executed by a single assertion.
 *
 * Four claims, each with a price attached:
 *
 *   RECOVERY IS EXACT. `480p → sd` and `720p → fast`. A wrong mapping bills the
 *   wrong rate against a clip nobody proved was that resolution.
 *
 *   1080p IS REFUSED LOCALLY. The edit endpoint does not serve it. Recovering it
 *   correctly is what turns a paid round trip that 400s into a free local no.
 *
 *   AN UNRECOVERABLE TIER IS A REFUSAL, NEVER A DEFAULT. `undefined` here means
 *   "no edit"; the moment it means "probably the usual one", the app is guessing
 *   with the user's money.
 *
 *   THE STORED VALUE WINS. A modern record must not be re-derived from prose —
 *   the description is a fallback, not a second source of truth.
 *
 * The last describe closes the loop: recovery is only interesting because it
 * decides whether a paid capability handle exists at all.
 */

import { describe, expect, it } from 'vitest';

import {
  hydrateVideoArtifactPayload,
  isVideoArtifactEditable,
  isVideoEditEligibleTier,
  resolveVideoArtifactTier,
  type CommandEveVideoConversationArtifact,
  type CommandEveVideoConversationArtifactPayload,
} from '@/common/config/videoGenerationRequestCore';
import { mintVideoEditCapabilityGrant } from '@/common/config/eveArtifactCapabilityHandleCore';

/**
 * A record exactly as this lane wrote it BEFORE the registry fields existed: a
 * description, a path, a hash — and nothing that answers an edit's questions.
 *
 * Spelled as a cast rather than through `buildVideoConversationArtifact`,
 * because that builder now always writes the modern fields and so cannot
 * produce the shape that is actually on the founder's disk.
 */
function legacyPayload(description: string): CommandEveVideoConversationArtifactPayload {
  return {
    artifact_type: 'video',
    title: 'Video',
    description,
    path: '/tmp/videos/conv-1/legacy.mp4',
    mime_type: 'video/mp4',
    hash: 'a'.repeat(64),
    size: 4096,
  } as unknown as CommandEveVideoConversationArtifactPayload;
}

function legacyArtifact(description: string): CommandEveVideoConversationArtifact {
  return {
    id: 'video-legacy',
    conversation_id: 'conv-1',
    kind: 'video',
    status: 'active',
    payload: legacyPayload(description),
    created_at: 1_754_000_000_000,
    updated_at: 1_754_000_000_000,
  } as unknown as CommandEveVideoConversationArtifact;
}

describe('the tier of a pre-registry clip is RECOVERED, never assumed', () => {
  it('reads 480p back as the sd tier', () => {
    expect(resolveVideoArtifactTier(legacyPayload('480p · 5s · ca. 500 Credits · grok-imagine-video'))).toBe('sd');
  });

  it('reads 720p back as the fast tier', () => {
    expect(resolveVideoArtifactTier(legacyPayload('720p · 5s · ca. 700 Credits · grok-imagine-video'))).toBe('fast');
  });

  it('reads 1080p back as the hd tier — which the edit endpoint does not serve', () => {
    const payload = legacyPayload('1080p · 5s · ca. 1500 Credits · grok-imagine-video-1.5');
    expect(resolveVideoArtifactTier(payload)).toBe('hd');
    expect(isVideoEditEligibleTier('hd')).toBe(false);
    // The consequence, stated where it can be checked: a 1080p source is turned
    // away locally, before the licence read and before the debit.
    expect(isVideoArtifactEditable(payload)).toBe(false);
  });

  it('REFUSES rather than defaulting when the description names no resolution', () => {
    // THE MONEY ASSERTION. If this ever returns a tier, the app has guessed a
    // price for a clip whose price it does not know.
    expect(resolveVideoArtifactTier(legacyPayload('Video'))).toBeUndefined();
    expect(resolveVideoArtifactTier(legacyPayload(''))).toBeUndefined();
    expect(isVideoArtifactEditable(legacyPayload('Video'))).toBe(false);
  });

  it('takes the resolution only from the LEADING token, never from later prose', () => {
    // A model name, a prompt fragment or a title further along must not be able
    // to supply the tier. `grok-720p-experiment` is exactly the shape that would
    // sneak past an unanchored match.
    expect(
      resolveVideoArtifactTier(legacyPayload('ein Clip · 5s · ca. 500 Credits · grok-720p-experiment'))
    ).toBeUndefined();
  });

  it('prefers a STORED tier over the description, so a modern record is never re-derived', () => {
    const conflicting = {
      ...legacyPayload('1080p · 5s · ca. 1500 Credits · grok-imagine-video-1.5'),
      tier_id: 'sd',
    } as unknown as CommandEveVideoConversationArtifactPayload;
    expect(resolveVideoArtifactTier(conflicting)).toBe('sd');
  });
});

describe('the length of a pre-registry clip is recovered on the same terms', () => {
  it('reads the seconds back out of the durable description', () => {
    expect(
      hydrateVideoArtifactPayload(legacyPayload('480p · 5s · ca. 500 Credits · grok-imagine-video')).duration_seconds
    ).toBe(5);
  });

  it('takes the length only from between the separators, never from a model name', () => {
    // `grok-5s-preview` sits outside the ` · … · ` frame the writer always uses.
    const payload = legacyPayload('480p · ca. 500 Credits · grok-5s-preview');
    expect(hydrateVideoArtifactPayload(payload).duration_seconds).toBe(0);
    // And zero means NOT EDITABLE, so an unrecoverable length can never reach a
    // paid endpoint as an invented one.
    expect(isVideoArtifactEditable(payload)).toBe(false);
  });

  it('still refuses a recovered length past the 8.7 second ceiling', () => {
    expect(isVideoArtifactEditable(legacyPayload('480p · 30s · ca. 3000 Credits · grok-imagine-video'))).toBe(false);
  });

  it('calls a pre-registry clip a generation, because an edit could not have written it', () => {
    expect(
      hydrateVideoArtifactPayload(legacyPayload('480p · 5s · ca. 500 Credits · grok-imagine-video')).origin_capability
    ).toBe('video_generation');
  });
});

describe('recovery is what decides whether a paid capability exists at all', () => {
  it('mints an edit grant for a recoverable, eligible legacy clip — the positive control', () => {
    const grant = mintVideoEditCapabilityGrant({
      artifact: legacyArtifact('480p · 5s · ca. 500 Credits · grok-imagine-video'),
      nowMs: 1_754_000_000_000,
      randomBytes: (size: number) => new Uint8Array(size).fill(0x33),
    });
    expect(grant).toBeDefined();
    expect(grant?.operation).toBe('video_edit');
    expect(grant?.artifact_id).toBe('video-legacy');
  });

  it('mints NOTHING for a legacy 1080p clip', () => {
    expect(
      mintVideoEditCapabilityGrant({
        artifact: legacyArtifact('1080p · 5s · ca. 1500 Credits · grok-imagine-video-1.5'),
        nowMs: 1_754_000_000_000,
        randomBytes: (size: number) => new Uint8Array(size).fill(0x33),
      })
    ).toBeUndefined();
  });

  it('mints NOTHING when the tier could not be recovered, even with a good length', () => {
    // Length recoverable, tier not. The refusal must come from the tier alone —
    // otherwise "we could not price it" would quietly become "we priced it".
    const artifact = legacyArtifact('ein Clip · 5s · ca. 500 Credits · grok-imagine-video');
    expect(hydrateVideoArtifactPayload(artifact.payload).duration_seconds).toBe(5);
    expect(
      mintVideoEditCapabilityGrant({
        artifact,
        nowMs: 1_754_000_000_000,
        randomBytes: (size: number) => new Uint8Array(size).fill(0x33),
      })
    ).toBeUndefined();
  });
});
