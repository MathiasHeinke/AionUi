/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE video cost-wall core (Lane 3, war-game heavy-lane guardrail) —
 * all pure:
 *   (1) cost preview math (rounds UP; min 1s duration; tier multiplier).
 *   (2) DEFAULT tier = Fast/720p (cheaper); 1080p is the explicit upgrade.
 *   (3) the submit GATE invariant: video NEVER requires a confirmation — asking
 *       for a video is the authorisation for it.
 *   (4) capability matrix: 1080p needs grok-imagine-video-1.5 — from a TEXT
 *       prompt too (MAT-1753 corrected the "image-to-video only" belief).
 *   (5) the four modes are mutually exclusive BY CONSTRUCTION, and the price is
 *       keyed by (model, resolution) rather than by tier.
 *
 * No Electron/fs/network — same pattern as creditsCore.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  buildResolvedVideoMessage,
  buildVideoSubmitGate,
  DEFAULT_VIDEO_DURATION_SECONDS,
  DEFAULT_VIDEO_TIER_ID,
  estimateVideoCost,
  getVideoTier,
  isExplicitUpgrade,
  isVideoGenerationRequest,
  isVideoLaneRequest,
  isVideoTierAvailable,
  listAvailableVideoModels,
  listAvailableVideoTiers,
  deriveVideoCreditsPerSecond,
  requestRoutesToVideoLane,
  buildVideoRequestMode,
  resolveVideoPlan,
  videoModelFor,
  MAX_REFERENCE_VIDEO_SECONDS,
  MAX_VIDEO_REFERENCE_IMAGES,
  VIDEO_LANE_AGENT_ID,
  VIDEO_MODEL_USD_PER_SECOND,
  VIDEO_TIERS,
  type VideoModeKind,
  type VideoQualityTier,
} from '@/common/config/videoCostCore';

/** A seat with grok-imagine-video-1.5 proven available. */
const HD15 = { hd15Available: true } as const;

/** The resolved plan, or a hard failure — a test must never assert on a refusal it did not expect. */
function plan(modeKind: VideoModeKind, tierId: VideoQualityTier, durationSeconds = 5) {
  const resolved = resolveVideoPlan({ modeKind, tierId, durationSeconds, capabilities: HD15 });
  if (resolved.ok !== true) throw new Error(`expected a plan, got refusal ${resolved.reason}`);
  return resolved.plan;
}

// ---------------------------------------------------------------------------
// (2) default tier — Fast/720p is the cheaper resting default
// ---------------------------------------------------------------------------

describe('VIDEO_TIERS — default + upgrade shape', () => {
  it('has exactly one default tier and it is Fast/720p', () => {
    const defaults = VIDEO_TIERS.filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe('fast');
    expect(defaults[0].resolution).toBe('720p');
    expect(DEFAULT_VIDEO_TIER_ID).toBe('fast');
  });

  it('marks 1080p (hd) as the explicit upgrade and never the default', () => {
    const hd = VIDEO_TIERS.find((t) => t.id === 'hd');
    expect(hd).toBeDefined();
    expect(hd?.resolution).toBe('1080p');
    expect(hd?.isUpgrade).toBe(true);
    expect(hd?.isDefault).toBe(false);
  });

  it('prices the upgrade strictly above the default per second', () => {
    expect(plan('text', 'hd').creditsPerSecond).toBeGreaterThan(plan('text', 'fast').creditsPerSecond);
  });

  // The per-second credit rate MUST equal the derivation from the OFFICIAL xAI
  // model profile. These three tests previously pinned SEEDANCE figures (24/68
  // cr/s) for a lane that routes to xAI — they were guards protecting the wrong
  // number, so a correction would have looked like a regression.
  it('pins per-second credits to the real xAI model profile, per MODEL', () => {
    // RE-VERIFIED against the profile (MAT-1753 item E) rather than trusted. The
    // rate is a function of (model, resolution): the same 720p costs 140 cr/s on
    // the base model and 280 cr/s on 1.5, which is why it cannot live on a tier.
    expect(VIDEO_MODEL_USD_PER_SECOND['grok-imagine-video']).toEqual({ '480p': 0.05, '720p': 0.07 });
    expect(VIDEO_MODEL_USD_PER_SECOND['grok-imagine-video-1.5']).toEqual({
      '480p': 0.08,
      '720p': 0.14,
      '1080p': 0.25,
    });
    expect(plan('text', 'sd').creditsPerSecond).toBe(100);
    expect(plan('text', 'fast').creditsPerSecond).toBe(140);
    expect(plan('text', 'hd').creditsPerSecond).toBe(500);
    expect(plan('reference', 'fast').creditsPerSecond).toBe(280);
  });

  it('the MODE names the model that will actually produce it', () => {
    expect(plan('text', 'sd').model).toBe('grok-imagine-video');
    expect(plan('text', 'fast').model).toBe('grok-imagine-video');
    expect(plan('text', 'hd').model).toBe('grok-imagine-video-1.5');
    expect(plan('reference', 'fast').model).toBe('grok-imagine-video-1.5');
  });

  it('honours an explicit 1.5 selection at 720p and prices that model', () => {
    const resolved = resolveVideoPlan({
      modeKind: 'text',
      tierId: 'fast',
      modelId: 'grok-imagine-video-1.5',
      durationSeconds: 5,
      capabilities: HD15,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.plan.model).toBe('grok-imagine-video-1.5');
    expect(resolved.plan.estimatedCredits).toBe(1400);
  });

  it('offers only models the seat and mode can actually use', () => {
    expect(listAvailableVideoModels({ modeKind: 'text' })).toEqual(['grok-imagine-video']);
    expect(listAvailableVideoModels({ modeKind: 'text', capabilities: HD15 })).toEqual([
      'grok-imagine-video',
      'grok-imagine-video-1.5',
    ]);
    expect(listAvailableVideoModels({ modeKind: 'reference', capabilities: HD15 })).toEqual([
      'grok-imagine-video-1.5',
    ]);
  });

  it('refuses impossible explicit model and resolution combinations', () => {
    expect(
      resolveVideoPlan({
        modeKind: 'text',
        tierId: 'hd',
        modelId: 'grok-imagine-video',
        capabilities: HD15,
      })
    ).toEqual({ ok: false, reason: 'video-model-unavailable' });
  });

  it('getVideoTier falls back to the default tier for an unknown id', () => {
    // @ts-expect-error — exercising the runtime fallback for a bad id.
    expect(getVideoTier('nope').isDefault).toBe(true);
    expect(getVideoTier(undefined).id).toBe('fast');
  });

  // The old M3.7 "unit mismatch" note is RESOLVED, not deferred. It documented a
  // preview pinned to 1 credit = 1 US-cent while creditsCore priced 10 credits per
  // EUR cent, and parked the ~10x gap as a founder margin decision. The gap was
  // never a margin question — it was two different units meeting in one file. The
  // rates now come from the real model profile through the real conversion, so
  // preview and debit speak the same unit and there is nothing left to reconcile.
  it('prices through the internal conversion, not a private 1cr=1ct unit', () => {
    // x2 metered floor, then 10 credits per EUR cent — the credits-core ratio.
    expect(plan('text', 'fast').creditsPerSecond).toBe(7 * 2 * 10);
    expect(plan('text', 'hd').creditsPerSecond).toBe(25 * 2 * 10);
    // The old private unit would have produced the raw USD cents as credits.
    expect(plan('text', 'fast').creditsPerSecond).not.toBe(7);
  });
});

// ---------------------------------------------------------------------------
// (1) cost preview math
// ---------------------------------------------------------------------------

describe('estimateVideoCost — preview math', () => {
  it('defaults to the typical clip length + Fast/720p tier', () => {
    const preview = estimateVideoCost({ modeKind: 'text' });
    expect(preview?.durationSeconds).toBe(DEFAULT_VIDEO_DURATION_SECONDS);
    expect(preview?.tier.id).toBe('fast');
    expect(preview?.isUpgrade).toBe(false);
    // 5s x 140 credits/s = 700 (720p on grok-imagine-video, derived from $0.07/s).
    expect(preview?.estimatedCredits).toBe(700);
  });

  it('rounds the estimate UP so the preview never under-states', () => {
    // 3.2s -> ceil(duration) 4s x 140 credits/s = 560 (duration ceil first).
    const preview = estimateVideoCost({ modeKind: 'text', durationSeconds: 3.2 });
    expect(preview?.durationSeconds).toBe(4);
    expect(preview?.estimatedCredits).toBe(560);
  });

  it('floors a degenerate (0/negative) duration to the default clip length', () => {
    expect(estimateVideoCost({ modeKind: 'text', durationSeconds: 0 })?.durationSeconds).toBe(
      DEFAULT_VIDEO_DURATION_SECONDS
    );
    expect(estimateVideoCost({ modeKind: 'text', durationSeconds: -5 })?.durationSeconds).toBe(
      DEFAULT_VIDEO_DURATION_SECONDS
    );
  });

  it('costs MORE for the 1080p upgrade at the same duration', () => {
    const fast = estimateVideoCost({ modeKind: 'text', durationSeconds: 5, tierId: 'fast', capabilities: HD15 });
    const hd = estimateVideoCost({ modeKind: 'text', durationSeconds: 5, tierId: 'hd', capabilities: HD15 });
    expect(hd!.estimatedCredits).toBeGreaterThan(fast!.estimatedCredits);
    expect(hd?.isUpgrade).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (3) the submit gate — asking for a video IS the authorisation
// ---------------------------------------------------------------------------

// This block previously pinned the opposite invariant ("video ALWAYS requires
// confirm"). That modal asked the user to approve a cost they had just asked to
// incur — a second question, not a boundary.
//
// The limit that protects money is server-side and untouched: `reservePaidLane`
// loads the balance and answers 402 via `canAfford` BEFORE the upstream call,
// refusing on both `insufficient_credits` and `spend_cap_exceeded`. Verified
// against the DEPLOYED bytes, not just the repo (prod eve-inference-core.ts:926,
// 946; credits-core.ts:378,407,427). An earlier version of this comment named the
// post-generation debit path instead — that branch is a retry, not a refusal, and
// citing it made a brake sound like it lived somewhere it does not.
describe('buildVideoSubmitGate — no per-generation confirmation', () => {
  it('does not require a confirmation and allows the request', () => {
    const gate = buildVideoSubmitGate();
    expect(gate.requiresConfirm).toBe(false);
    expect(gate.allowed).toBe(true);
  });

  it('still resolves to the cheaper Fast/720p tier by default', () => {
    expect(buildVideoSubmitGate().defaultTierId).toBe('fast');
  });

  // The wall is gone; the number must not go with it. A caller that submits
  // without a chosen tier still gets a conservative, non-zero credit figure to
  // put in front of the operator.
  it('keeps a usable estimate for the default tier so the cost stays visible', () => {
    const gate = buildVideoSubmitGate();
    const preview = estimateVideoCost({ modeKind: 'text', tierId: gate.defaultTierId });
    expect(preview?.tier.id).toBe('fast');
    expect(preview!.estimatedCredits).toBeGreaterThan(0);
    expect(preview?.isUpgrade).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (4) explicit-upgrade guard
// ---------------------------------------------------------------------------

describe('isExplicitUpgrade — 1080p only via explicit toggle', () => {
  it('is true only when the upgrade tier was explicitly toggled', () => {
    expect(isExplicitUpgrade({ selectedTierId: 'hd', userToggledUpgrade: true })).toBe(true);
  });

  it('is false when on the upgrade tier without an explicit toggle', () => {
    expect(isExplicitUpgrade({ selectedTierId: 'hd', userToggledUpgrade: false })).toBe(false);
  });

  it('is false for the default (non-upgrade) tier regardless of the toggle', () => {
    expect(isExplicitUpgrade({ selectedTierId: 'fast', userToggledUpgrade: true })).toBe(false);
    expect(isExplicitUpgrade({ selectedTierId: 'fast', userToggledUpgrade: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (5) video-generation INTENT detection (the send-path seam)
// ---------------------------------------------------------------------------

describe('isVideoGenerationRequest — high-precision generation-intent detection', () => {
  it('detects EN generation requests', () => {
    expect(isVideoGenerationRequest('Generate a video for our launch')).toBe(true);
    expect(isVideoGenerationRequest('please create a short reel for TikTok')).toBe(true);
    expect(isVideoGenerationRequest('make a 5s clip about the product')).toBe(true);
    expect(isVideoGenerationRequest('do a text-to-video of the hero shot')).toBe(true);
  });

  it('detects DE generation requests (verb before OR after the noun)', () => {
    expect(isVideoGenerationRequest('Erstelle ein Video für die Kampagne')).toBe(true);
    expect(isVideoGenerationRequest('Mach mir ein kurzes Reel für Instagram')).toBe(true);
    expect(isVideoGenerationRequest('Ich möchte ein Video erstellen')).toBe(true);
    expect(isVideoGenerationRequest('Bitte ein Kurzvideo generieren')).toBe(true);
  });

  it('does NOT trip on a mere mention of a video (no generation intent)', () => {
    expect(isVideoGenerationRequest('schau dir dieses Video an')).toBe(false);
    expect(isVideoGenerationRequest('the video was great, thanks')).toBe(false);
    expect(isVideoGenerationRequest('summarize this YouTube link')).toBe(false);
    expect(isVideoGenerationRequest('write a blog post about marketing')).toBe(false);
  });

  it('is false for empty / whitespace / non-string input', () => {
    expect(isVideoGenerationRequest('')).toBe(false);
    expect(isVideoGenerationRequest('   ')).toBe(false);
    expect(isVideoGenerationRequest(null)).toBe(false);
    expect(isVideoGenerationRequest(undefined)).toBe(false);
  });

  // These six sentences all MATCHED before the cost wall was removed. That was
  // tolerable while a confirmation stood behind the classifier — an over-firing
  // pattern cost one cancel click. It is not tolerable now: requestRoutesToVideoLane
  // ORs this regex with the capability checks, so a match alone routes an ordinary
  // message into the paid video lane with nothing left to catch it.
  it('does not route ordinary requests into the paid video lane', () => {
    expect(isVideoGenerationRequest('Create a short summary of this meeting')).toBe(false);
    expect(isVideoGenerationRequest('Make a short story for my blog')).toBe(false);
    expect(isVideoGenerationRequest('Can you write and design an ad for Google Ads (text only)?')).toBe(false);
    expect(isVideoGenerationRequest('Edit this blog post about our new ad campaign')).toBe(false);
    expect(isVideoGenerationRequest('Ich will heute Abend einen Film schauen — hast du Tipps?')).toBe(false);
    expect(isVideoGenerationRequest('Cut the intro from the audio clip')).toBe(false);
  });

  // The narrowing must not cost genuine recall. A real editing request still
  // reaches the lane through the capability / addressed agent / skill branches of
  // requestRoutesToVideoLane; what these pin is that the obvious phrasings survive.
  it('still recognises genuine generation intent', () => {
    expect(isVideoGenerationRequest('please create a short reel for TikTok')).toBe(true);
    expect(isVideoGenerationRequest('render an animation of the logo')).toBe(true);
    expect(isVideoGenerationRequest('build a promo video for the launch')).toBe(true);
    expect(isVideoGenerationRequest('mach mir einen Werbespot für Instagram')).toBe(true);
    expect(isVideoGenerationRequest('Trailer produzieren für das neue Produkt')).toBe(true);
    expect(isVideoGenerationRequest('cut me a youtube short from this')).toBe(true);
  });

  // DUX-6: the hardened classifier must catch MORE real video-intent phrasings
  // (ad/spot/trailer/promo formats, more verbs, both word orders) so fewer heavy
  // requests slip past — without tripping on a mere mention.
  it('detects the broadened video-intent phrasings (DUX-6 recall)', () => {
    expect(isVideoGenerationRequest('schneide mir einen Werbespot für Instagram')).toBe(true);
    expect(isVideoGenerationRequest('mach ein Produktvideo für die Landingpage')).toBe(true);
    expect(isVideoGenerationRequest('ich brauche ein Video für den Launch')).toBe(true);
    expect(isVideoGenerationRequest('cut a promo video for the product')).toBe(true);
    expect(isVideoGenerationRequest('whip up a TikTok ad for us')).toBe(true);
    expect(isVideoGenerationRequest('design a trailer for the campaign')).toBe(true);
    expect(isVideoGenerationRequest('a product video for me — create it')).toBe(true);
  });

  it('still does NOT trip on mere mentions after broadening', () => {
    expect(isVideoGenerationRequest('schau dir dieses Video an')).toBe(false);
    expect(isVideoGenerationRequest('the trailer was great, thanks')).toBe(false);
    expect(isVideoGenerationRequest('what time is the ad meeting?')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (6) FAIL-SAFE video-lane gate (DUX-6) — not the NL regex alone
// ---------------------------------------------------------------------------

describe('requestRoutesToVideoLane — fail-safe gate on the resolved capability/worker', () => {
  it('fires when the resolver explicitly flags the video capability (regex irrelevant)', () => {
    // A message the NL regex would MISS, but the resolver classified as video.
    expect(requestRoutesToVideoLane({ message: 'do the thing we talked about', resolvedVideoCapability: true })).toBe(
      true
    );
  });

  it('fires when the request is addressed/resolved to the videomarketer agent', () => {
    expect(requestRoutesToVideoLane({ message: 'handle it', resolvedAgentId: VIDEO_LANE_AGENT_ID })).toBe(true);
    expect(VIDEO_LANE_AGENT_ID).toBe('video-marketer');
  });

  it('fires when the resolved worker owns a video-lane skill', () => {
    expect(requestRoutesToVideoLane({ message: 'go', resolvedSkills: ['storyboard'] })).toBe(true);
    expect(requestRoutesToVideoLane({ message: 'go', resolvedSkills: ['social-video', 'copywriting'] })).toBe(true);
  });

  it('falls back to the NL classifier as a LAST resort when no resolver signal', () => {
    expect(requestRoutesToVideoLane({ message: 'Erstelle ein Video für die Kampagne' })).toBe(true);
  });

  it('does NOT fire for a plain non-video request with no video signal at all', () => {
    expect(requestRoutesToVideoLane({ message: 'write a blog post about marketing' })).toBe(false);
    expect(requestRoutesToVideoLane({ message: 'handle it', resolvedAgentId: 'content-writer' })).toBe(false);
    expect(requestRoutesToVideoLane({ message: 'go', resolvedSkills: ['copywriting'] })).toBe(false);
  });

  it('isVideoLaneRequest is the readable alias of the same gate', () => {
    expect(isVideoLaneRequest({ resolvedVideoCapability: true })).toBe(true);
    expect(isVideoLaneRequest({ message: 'just chatting' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (7) Resolved video message on CONFIRM (DUX-5)
// ---------------------------------------------------------------------------

describe('buildResolvedVideoMessage — confirm carries the resolved tier/resolution/cost', () => {
  it('appends an explicit video directive with the resolved spec (not the bare text)', () => {
    const out = buildResolvedVideoMessage('Mach ein Reel für den Launch', { tierId: 'fast', estimatedCredits: 120 });
    expect(out).toContain('Mach ein Reel für den Launch');
    expect(out).toContain('[EVE:VIDEO ');
    expect(out).toContain('tier=fast');
    expect(out).toContain('resolution=720p');
    expect(out).toContain('quality=fast');
    expect(out).toContain('credits<=120');
  });

  it('carries the 1080p upgrade resolution + higher cost when the user upgraded', () => {
    const out = buildResolvedVideoMessage('Make a launch video', { tierId: 'hd', estimatedCredits: 340 });
    expect(out).toContain('tier=hd');
    expect(out).toContain('resolution=1080p');
    expect(out).toContain('quality=hd');
    expect(out).toContain('credits<=340');
  });

  it('never double-stamps: re-resolving the same selection is a no-op', () => {
    const once = buildResolvedVideoMessage('clip pls', { tierId: 'fast', estimatedCredits: 120 });
    const twice = buildResolvedVideoMessage(once, { tierId: 'fast', estimatedCredits: 120 });
    expect(twice).toBe(once);
    expect((twice.match(/\[EVE:VIDEO /g) ?? []).length).toBe(1);
  });

  it('REPLACES a stale directive instead of preserving it', () => {
    // The regression this pins: a stamped message returns to the composer via
    // arrow-up history or by editing a queued item. The old code kept the first
    // stamp, so picking HD on a recalled Fast message dispatched tier=fast — the
    // pill said one thing and the agent was told another. The previous version of
    // THIS test asserted the broken behaviour (`expect(twice).toBe(once)` across
    // different tiers), so the defect had a guard protecting it.
    const stamped = buildResolvedVideoMessage('clip pls', { tierId: 'fast', estimatedCredits: 120 });
    const upgraded = buildResolvedVideoMessage(stamped, { tierId: 'hd', estimatedCredits: 340 });

    expect(upgraded).toContain('tier=hd');
    expect(upgraded).toContain('resolution=1080p');
    expect(upgraded).toContain('credits<=340');
    expect(upgraded).not.toContain('tier=fast');
    expect((upgraded.match(/\[EVE:VIDEO /g) ?? []).length).toBe(1);
    expect(upgraded).toContain('clip pls');
  });

  it('downgrades just as honestly as it upgrades', () => {
    // The expensive direction of the same bug: a recalled HD message must not
    // keep billing HD once the user has picked Fast.
    const stamped = buildResolvedVideoMessage('clip pls', { tierId: 'hd', estimatedCredits: 340 });
    const downgraded = buildResolvedVideoMessage(stamped, { tierId: 'fast', estimatedCredits: 120 });

    expect(downgraded).toContain('tier=fast');
    expect(downgraded).not.toContain('tier=hd');
    expect((downgraded.match(/\[EVE:VIDEO /g) ?? []).length).toBe(1);
  });

  it('never eats user text across a line break', () => {
    // An unclosed lookalike: the user typed "[EVE:VIDEO " and kept writing on the
    // next line. With an unbound character class the strip ran past the newline
    // and deleted everything up to the next "]" — silent text loss in the lane
    // that spends money. The real directive is always single-line.
    const typed = 'ich tippe [EVE:VIDEO kaputt\nund hier steht wichtiger Text] und noch mehr';
    const out = buildResolvedVideoMessage(typed, { tierId: 'fast', estimatedCredits: 120 });

    expect(out).toContain('wichtiger Text');
    expect(out).toContain('und noch mehr');
    expect(out).toContain('ich tippe');
  });

  it('still removes a single-line lookalike, so typed text cannot impersonate a spec', () => {
    const spoof = 'mach das [EVE:VIDEO tier=hd resolution=1080p quality=hd credits<=1] bitte';
    const out = buildResolvedVideoMessage(spoof, { tierId: 'fast', estimatedCredits: 120 });

    expect((out.match(/\[EVE:VIDEO /g) ?? []).length).toBe(1);
    expect(out).toContain('tier=fast');
    expect(out).not.toContain('credits<=1]');
  });

  it('clears more than one inherited directive', () => {
    const doubled =
      'clip pls\n\n[EVE:VIDEO tier=fast resolution=720p quality=fast credits<=120]\n\n[EVE:VIDEO tier=hd resolution=1080p quality=hd credits<=340]';
    const out = buildResolvedVideoMessage(doubled, { tierId: 'fast', estimatedCredits: 120 });
    expect((out.match(/\[EVE:VIDEO /g) ?? []).length).toBe(1);
    expect(out).toContain('tier=fast');
    expect(out.startsWith('clip pls')).toBe(true);
  });

  it('still emits the directive even when the original text is empty', () => {
    const out = buildResolvedVideoMessage('', { tierId: 'fast', estimatedCredits: 120 });
    expect(out.startsWith('[EVE:VIDEO ')).toBe(true);
  });

  it('the resolved message DIFFERS from the unmodified original (the DUX-5 bug)', () => {
    const original = 'Erstelle ein Kurzvideo';
    const resolved = buildResolvedVideoMessage(original, { tierId: 'hd', estimatedCredits: 340 });
    // Confirming must NOT just re-fire the original text — it carries the spec.
    expect(resolved).not.toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Capability matrix — what the provider can ACTUALLY produce
// ---------------------------------------------------------------------------

describe('video capability matrix (official xAI model profiles)', () => {
  it('offers a text prompt 480p and 720p when 1.5 is not proven', () => {
    const tiers = listAvailableVideoTiers({ modeKind: 'text' });
    expect(tiers.map((t) => t.resolution)).toEqual(['480p', '720p']);
  });

  // INVERTED, MAT-1753. This assertion used to read "text + 1080p is IMPOSSIBLE —
  // 1.5 is image-to-video only", and it was wrong about the provider: 1.5 does
  // text-to-video at native 1080p. Kept as an assertion rather than deleted,
  // because this exact combination is the one the product refused, and it keeps
  // the half that IS still true — no 1.5 proven, no 1080p.
  it('text + 1080p SUCCEEDS once 1.5 is available, and only then', () => {
    expect(isVideoTierAvailable('hd', { modeKind: 'text' })).toBe(false);
    expect(isVideoTierAvailable('hd', { modeKind: 'text', capabilities: HD15 })).toBe(true);
    const hd = plan('text', 'hd');
    expect(hd.model).toBe('grok-imagine-video-1.5');
    expect(hd.resolution).toBe('1080p');
  });

  it('image + 1080p requires 1.5 to be genuinely available', () => {
    expect(isVideoTierAvailable('hd', { modeKind: 'image' })).toBe(false);
    expect(isVideoTierAvailable('hd', { modeKind: 'image', capabilities: HD15 })).toBe(true);
  });

  it('1080p resolves to grok-imagine-video-1.5, nothing else', () => {
    expect(videoModelFor('text', '1080p')).toBe('grok-imagine-video-1.5');
    expect(videoModelFor('image', '1080p')).toBe('grok-imagine-video-1.5');
    // The base model has NO 1080p rate at all — absent, not zero.
    expect(VIDEO_MODEL_USD_PER_SECOND['grok-imagine-video']['1080p']).toBeUndefined();
  });

  it('text + 720p resolves to grok-imagine-video', () => {
    const fast = listAvailableVideoTiers({ modeKind: 'text' }).find((t) => t.resolution === '720p');
    expect(fast?.id).toBe('fast');
    expect(fast?.isDefault).toBe(true);
    expect(plan('text', 'fast').model).toBe('grok-imagine-video');
  });

  it('480p and 720p stay on the cheaper base model even with an image', () => {
    expect(plan('image', 'sd').model).toBe('grok-imagine-video');
    expect(plan('image', 'fast').model).toBe('grok-imagine-video');
  });
});

describe('the four modes are mutually exclusive BY CONSTRUCTION', () => {
  it('refuses an image AND reference images in the same request', () => {
    const built = buildVideoRequestMode<string>({ image: '/a.png', referenceImages: ['/b.png', '/c.png'] });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toBe('video-mode-ambiguous');
  });

  it('refuses reference images AND an edit source in the same request', () => {
    const built = buildVideoRequestMode<string>({ editSource: '/clip.mp4', referenceImages: ['/b.png'] });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toBe('video-mode-ambiguous');
  });

  it('refuses a voice outside reference mode rather than dropping it', () => {
    const built = buildVideoRequestMode<string>({ image: '/a.png', presetVoiceIds: ['v1'] });
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.reason).toBe('video-mode-ambiguous');
  });

  it('accepts up to 7 reference images and refuses an 8th', () => {
    const seven = buildVideoRequestMode<string>({
      referenceImages: Array.from({ length: MAX_VIDEO_REFERENCE_IMAGES }, (_, i) => `/ref-${i}.png`),
    });
    expect(seven.ok).toBe(true);
    expect(seven.ok === true && seven.mode.kind).toBe('reference');
    const eight = buildVideoRequestMode<string>({
      referenceImages: Array.from({ length: MAX_VIDEO_REFERENCE_IMAGES + 1 }, (_, i) => `/ref-${i}.png`),
    });
    expect(eight.ok).toBe(false);
    expect(eight.ok === false && eight.reason).toBe('reference-images-too-many');
  });

  it('accepts up to 3 preset voices and refuses a 4th', () => {
    const three = buildVideoRequestMode<string>({
      referenceImages: ['/a.png'],
      presetVoiceIds: ['v1', 'v2', 'v3'],
      capabilities: { presetVoicesAvailable: true },
    });
    expect(three.ok).toBe(true);
    const four = buildVideoRequestMode<string>({
      referenceImages: ['/a.png'],
      presetVoiceIds: ['v1', 'v2', 'v3', 'v4'],
      capabilities: { presetVoicesAvailable: true },
    });
    expect(four.ok).toBe(false);
    expect(four.ok === false && four.reason).toBe('reference-voices-too-many');
  });

  it('a seat without the preset-voice entitlement cannot reach preset voices', () => {
    const denied = buildVideoRequestMode<string>({ referenceImages: ['/a.png'], presetVoiceIds: ['v1'] });
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toBe('reference-voices-not-entitled');
    // The SAME request on an entitled seat goes through — so the refusal above is
    // the entitlement and not some other malformation.
    const allowed = buildVideoRequestMode<string>({
      referenceImages: ['/a.png'],
      presetVoiceIds: ['v1'],
      capabilities: { presetVoicesAvailable: true },
    });
    expect(allowed.ok).toBe(true);
  });

  it('has no shape that can carry two input families at once', () => {
    // The type-level claim, exercised at runtime: whatever the constructor
    // returns has exactly ONE branch, and the branch names the only fields there
    // are. There is no `mode.image` on a reference mode to be read by mistake.
    const built = buildVideoRequestMode<string>({ referenceImages: ['/a.png', '/b.png'] });
    expect(built.ok).toBe(true);
    if (built.ok !== true) throw new Error('unreachable');
    expect(Object.keys(built.mode).sort()).toEqual(['kind', 'presetVoiceIds', 'referenceImages']);
  });
});

describe('reference-to-video clamps rather than promising', () => {
  it('clamps a 1080p reference request to 720p and 15s, and prices the CLAMP', () => {
    const clamped = plan('reference', 'hd', 60);
    expect(clamped.resolution).toBe('720p');
    expect(clamped.durationSeconds).toBe(15);
    expect(clamped.maxDurationSeconds).toBe(MAX_REFERENCE_VIDEO_SECONDS);
    expect(clamped.clampedFromTierId).toBe('hd');
    // THE money property: the quoted price is the clamped 720p-on-1.5 rate, never
    // the 1080p rate that was asked for.
    expect(clamped.creditsPerSecond).toBe(280);
    expect(clamped.estimatedCredits).toBe(15 * 280);
  });

  it('never OFFERS 1080p in reference mode, so the clamp is a backstop', () => {
    expect(isVideoTierAvailable('hd', { modeKind: 'reference', capabilities: HD15 })).toBe(false);
  });

  it('refuses reference mode outright when 1.5 is not available', () => {
    const refused = resolveVideoPlan({ modeKind: 'reference', tierId: 'fast' });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe('reference-model-unavailable');
    expect(listAvailableVideoTiers({ modeKind: 'reference' })).toEqual([]);
  });

  it('the edit 720 refusal STILL holds — an edit refuses, it does not clamp', () => {
    const refused = resolveVideoPlan({ modeKind: 'edit', tierId: 'hd', capabilities: HD15 });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe('video-edit-resolution-refused');
  });
});

describe('the quoted price matches the mode actually selected', () => {
  it('quotes base pricing for a base-model render and 1.5 pricing for a 1.5 render', () => {
    const text720 = estimateVideoCost({ modeKind: 'text', tierId: 'fast', durationSeconds: 5, capabilities: HD15 });
    const ref720 = estimateVideoCost({
      modeKind: 'reference',
      tierId: 'fast',
      durationSeconds: 5,
      capabilities: HD15,
    });
    // Same tier, same resolution, DIFFERENT model — and therefore different money.
    expect(text720?.tier.id).toBe(ref720?.tier.id);
    expect(text720?.plan.model).toBe('grok-imagine-video');
    expect(ref720?.plan.model).toBe('grok-imagine-video-1.5');
    expect(text720?.estimatedCredits).toBe(700);
    expect(ref720?.estimatedCredits).toBe(1400);
  });

  it('refuses to quote a price for a render that cannot happen', () => {
    // `undefined`, not a number: a price for an impossible render is a promise.
    expect(estimateVideoCost({ modeKind: 'reference', tierId: 'fast' })).toBeUndefined();
    expect(estimateVideoCost({ modeKind: 'text', tierId: 'hd' })).toBeUndefined();
  });
});

describe('credits derive from the real model profile, not from Seedance', () => {
  it('derives each tier through the internal conversion (x2 floor, 10 cr/EUR cent)', () => {
    expect(deriveVideoCreditsPerSecond(0.05)).toBe(100);
    expect(deriveVideoCreditsPerSecond(0.07)).toBe(140);
    expect(deriveVideoCreditsPerSecond(0.25)).toBe(500);
  });

  it('every (model, resolution) rate EQUALS its own derivation — no hand-tuned numbers', () => {
    for (const rates of Object.values(VIDEO_MODEL_USD_PER_SECOND)) {
      for (const usd of Object.values(rates)) {
        expect(deriveVideoCreditsPerSecond(usd as number)).toBe(Math.round((usd as number) * 100) * 2 * 10);
      }
    }
  });

  it('the Seedance constants are GONE', () => {
    // 24 and 68 cr/s priced a Seedance lane that this product does not call. A 5s
    // 720p clip previewed 120 credits against a real ~700 — understated ~6x.
    const rates = Object.values(VIDEO_MODEL_USD_PER_SECOND).flatMap((byRes) =>
      Object.values(byRes).map((usd) => deriveVideoCreditsPerSecond(usd as number))
    );
    expect(rates).not.toContain(24);
    expect(rates).not.toContain(68);
    expect(Object.keys(VIDEO_MODEL_USD_PER_SECOND).every((m) => m.startsWith('grok-imagine-video'))).toBe(true);
  });

  it('prices a 5s 720p clip at the real rate', () => {
    expect(estimateVideoCost({ modeKind: 'text', durationSeconds: 5, tierId: 'fast' })?.estimatedCredits).toBe(700);
  });
});
