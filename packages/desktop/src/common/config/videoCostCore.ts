/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE VIDEO generation — pure cost core.
 *
 * Video is the most expensive action in the credit economy: one ~5s clip can cost
 * an order of magnitude more than a chat turn or an image. This module owns the
 * credit MATH, the default-tier DECISION and the intent classifier.
 *
 * It used to open a blocking cost preview before every generation and this header
 * said the desktop "NEVER fires a video generation silently". That is no longer
 * how the product works: asking for a video is the authorisation for it, the same
 * way attaching an image is the authorisation to analyse it. The confirmation was
 * a second question about an intent the request already carried.
 *
 * What protects the money is server-side. This module never was a brake, and the
 * brake it used to name was the wrong one: `reservePaidLane` → `canAfford` lives
 * in eve-inference, and video does not go through eve-inference at all — the
 * deployed function contains no reference to video. Video routes to
 * `eve-multimodal`, and its reservation runs there, before the provider call.
 * Citing the inference brake here made a limit sound like it covered a lane it
 * has never seen.
 *
 * The cheaper Fast/720p tier remains the default, and the picker is inline and
 * non-blocking (VideoQualityPill).
 *
 * The tier list is CAPABILITY-AWARE and MODE-AWARE, and the mode half is a
 * correction that cost this lane real capability. An earlier revision of this
 * header stated that `grok-imagine-video-1.5` is "IMAGE->VIDEO ONLY" and that a
 * bare prompt can therefore never yield 1080p. That is FALSE against the official
 * xAI model profile: 1.5 does text-to-video with NATIVE 1080p. The belief was
 * encoded in a `requiresImageInput` flag on the tier table, in a request-side
 * guard, and in two server test assertions — so the product refused a resolution
 * the provider sells.
 *
 * WHAT IS ACTUALLY TRUE (the profile, MAT-1753):
 *
 *   grok-imagine-video      text | image | video -> video. 480p $0.05/s,
 *                           720p $0.07/s. NO 1080p.
 *   grok-imagine-video-1.5  text | image -> video, 480p $0.08/s, 720p $0.14/s,
 *                           1080p $0.25/s — text-to-video INCLUDED.
 *                           REFERENCE-TO-VIDEO is a capability of 1.5 and of
 *                           1.5 only: up to 7 reference images, up to 3 PRESET
 *                           voices, max 15s, max 720p.
 *
 * FOUR MUTUALLY EXCLUSIVE MODES. text / image / reference / edit are alternatives,
 * never a combination: reference cannot ride along with an image->video job and
 * cannot ride along with an edit. That is enforced BY CONSTRUCTION here — see
 * {@link VideoRequestMode}, a discriminated union in which no value can carry two
 * input families at once — rather than by a validator that rejects a combination
 * somebody was still able to build.
 *
 * PRICE IS KEYED BY (MODEL, RESOLUTION), NOT BY TIER. This is the second
 * correction, and it is a money one. The tier table used to carry
 * `usdPerSecond`/`creditsPerSecond` directly, which silently assumed one model per
 * resolution. Reference mode breaks that assumption: it runs on 1.5, so a 720p
 * reference render costs $0.14/s (280 credits/s), exactly double the $0.07/s
 * (140 credits/s) the `fast` tier used to quote for every 720p job. Quoting the
 * tier's number for a reference render would under-bill it by half. The rate now
 * lives in {@link VIDEO_MODEL_USD_PER_SECOND} and is only ever reached through
 * {@link resolveVideoPlan}, so an estimate cannot name a price for a model the
 * render will not use.
 *
 * PURE (no Electron, no fs, no network) so the math and the classifier stay
 * unit-testable in plain Node, mirroring `creditsCore.ts` / `eveInferenceCore.ts`.
 */

// ---------------------------------------------------------------------------
// Tiers (Fast/720p default; 1080p = explicit upgrade)
// ---------------------------------------------------------------------------

/** Video quality tier ids. `fast` (720p) is the default. */
export type VideoQualityTier = 'sd' | 'fast' | 'hd';

/** Supported video resolutions. */
export type VideoResolution = '480p' | '720p' | '1080p';

/** The two xAI video models, which differ in what they ACCEPT, not just price. */
export type VideoModelId = 'grok-imagine-video' | 'grok-imagine-video-1.5';

/**
 * The four ways a clip can be produced. They are ALTERNATIVES, not flags: see
 * {@link VideoRequestMode} for the union that makes any two of them impossible to
 * hold at the same time.
 */
export type VideoModeKind = 'text' | 'image' | 'reference' | 'edit';

/**
 * A tier is now nothing but a NAME FOR A RESOLUTION.
 *
 * `model`, `usdPerSecond`, `creditsPerSecond` and `requiresImageInput` were all
 * removed from this record deliberately. Each of them was a per-resolution
 * constant that stopped being one the moment a second model could serve the same
 * resolution, and a field that is right for three of four modes is a trap: the
 * wrong number is one property access away and reads as correct. The price and
 * the model are now only reachable through {@link resolveVideoPlan}, which knows
 * the mode.
 */
export interface VideoTierSpec {
  id: VideoQualityTier;
  resolution: VideoResolution;
  /** True for the resting default tier (Fast/720p). Exactly one tier is default. */
  isDefault: boolean;
  /** True iff selecting this tier costs more than the default. */
  isUpgrade: boolean;
}

/**
 * Derive retail credits/second from a provider USD/second list price, through the
 * existing internal conversion. Kept as a function so the derivation is executable
 * and testable instead of a comment next to a magic number.
 *
 * Mirrors `credits-core.ts`: DEFAULT_MARKUP_FACTOR = 2 (the un-tiered metered floor
 * that the image/video/music lane takes) and CREDITS_PER_EUR_CENT = 10.
 */
export const VIDEO_MARKUP_FACTOR = 2;
export const VIDEO_CREDITS_PER_EUR_CENT = 10;

export function deriveVideoCreditsPerSecond(usdPerSecond: number): number {
  // ROUND to integer cents FIRST, then stay in integer arithmetic. `0.05 * 100`
  // is 5.000000000000001 in IEEE-754, and a later ceil() turns that into 101
  // credits instead of 100 — a price that is wrong by a rounding artefact. This
  // is the same float trap credits-core calls out when it stores CREDITS_PER_EUR_CENT
  // as an integer ratio rather than dividing by 0.1. Provider list prices are
  // quoted in whole cents, so rounding here loses nothing real.
  const rawCents = Math.round(usdPerSecond * 100); // USD cents, 1:1 as EUR cents (above)
  return rawCents * VIDEO_MARKUP_FACTOR * VIDEO_CREDITS_PER_EUR_CENT;
}

/**
 * The video tiers. A tier is a RESOLUTION with a name; nothing here prices it and
 * nothing here names a model, because neither is a function of the resolution
 * alone (see the header, and {@link VIDEO_MODEL_USD_PER_SECOND}).
 */
export const VIDEO_TIERS: readonly VideoTierSpec[] = [
  { id: 'sd', resolution: '480p', isDefault: false, isUpgrade: false },
  { id: 'fast', resolution: '720p', isDefault: true, isUpgrade: false },
  { id: 'hd', resolution: '1080p', isDefault: false, isUpgrade: true },
] as const;

/**
 * Provider list price per generated second, in USD, keyed by (model, resolution)
 * — the ONLY price table in this module.
 *
 * This table previously lived on the tier records and carried SEEDANCE prices
 * (24 / 68 credits/s) for a lane that routes to xAI; the real 720p base rate is
 * 140 credits/s, so a 5s clip previewed 120 credits against a true ~700. That was
 * fixed. What was NOT fixed until MAT-1753 is the shape: one rate per resolution
 * is only correct while one model serves each resolution, and reference-to-video
 * broke that — 720p on 1.5 is $0.14/s, double 720p on the base model.
 *
 * An absent entry is a real statement: the base model has no 1080p at all, so
 * asking for its 1080p rate must be `undefined` rather than a number that would
 * let an impossible render carry a plausible price.
 */
export const VIDEO_MODEL_USD_PER_SECOND: Readonly<
  Record<VideoModelId, Readonly<Partial<Record<VideoResolution, number>>>>
> = {
  'grok-imagine-video': { '480p': 0.05, '720p': 0.07 },
  'grok-imagine-video-1.5': { '480p': 0.08, '720p': 0.14, '1080p': 0.25 },
};

/**
 * Which model actually serves a (mode, resolution) pair.
 *
 * Total by construction, and only two rules:
 *   - reference-to-video exists ONLY on 1.5, at any resolution it allows;
 *   - otherwise the cheaper base model serves 480p/720p and 1.5 serves 1080p,
 *     because the base model has no 1080p.
 *
 * Note what changed: 1080p is reached from a TEXT prompt now. `videoModelFor`
 * never asks whether an image is present, because the model does not.
 */
export function videoModelFor(modeKind: VideoModeKind, resolution: VideoResolution): VideoModelId {
  if (modeKind === 'reference') return 'grok-imagine-video-1.5';
  return resolution === '1080p' ? 'grok-imagine-video-1.5' : 'grok-imagine-video';
}

/** Retail credits/second for a (model, resolution) pair, or `undefined` if the model cannot produce it. */
export function videoCreditsPerSecondFor(model: VideoModelId, resolution: VideoResolution): number | undefined {
  const usd = VIDEO_MODEL_USD_PER_SECOND[model][resolution];
  return usd === undefined ? undefined : deriveVideoCreditsPerSecond(usd);
}

// ---------------------------------------------------------------------------
// Mode: MUTUALLY EXCLUSIVE BY CONSTRUCTION
// ---------------------------------------------------------------------------

/** Up to seven reference images per xAI's reference-to-video profile. */
export const MAX_VIDEO_REFERENCE_IMAGES = 7;

/**
 * Up to three PRESET reference voices. Preset only: custom audio upload is not a
 * supported capability, and there is deliberately no field anywhere in this
 * module that could carry one.
 */
export const MAX_VIDEO_REFERENCE_AUDIOS = 3;

/** Reference-to-video tops out at 15 seconds and 720p. Both are provider limits. */
export const MAX_REFERENCE_VIDEO_SECONDS = 15;
export const REFERENCE_VIDEO_MAX_RESOLUTION: VideoResolution = '720p';

/**
 * The pending request's INPUT, as a discriminated union.
 *
 * This is the "unrepresentable, not merely rejected" part of MAT-1753. There is
 * no value of this type that carries an image AND reference images, or reference
 * images AND an edit source: the alternatives are branches, not optional fields,
 * so a caller cannot construct the impossible combination and then be told off
 * for it. `presetVoiceIds` lives inside the `reference` branch for the same
 * reason — a voice on a text-to-video job is not a rejected request, it is a
 * request that cannot be written down.
 *
 * Generic over the asset representation so the SAME union serves the renderer
 * (which holds grant-verified PATHS and no bytes) and the gateway request builder
 * (which holds base64 + a SHA-256 receipt). One shape, two payload types — not
 * two shapes that can drift.
 */
export type VideoRequestMode<TAsset = string> =
  | { kind: 'text' }
  | { kind: 'image'; image: TAsset }
  | { kind: 'reference'; referenceImages: readonly TAsset[]; presetVoiceIds: readonly string[] }
  | { kind: 'edit'; source: TAsset };

export type VideoModeRefusal =
  | 'video-mode-ambiguous'
  | 'reference-images-too-many'
  | 'reference-voices-too-many'
  | 'reference-voices-not-entitled';

export type VideoModeResult<TAsset> =
  | { ok: true; mode: VideoRequestMode<TAsset> }
  | { ok: false; reason: VideoModeRefusal };

/** What the seat may actually reach. Both default to FALSE and must be PROVEN. */
export interface VideoSeatCapabilities {
  /**
   * Is grok-imagine-video-1.5 actually reachable on the existing xAI entitlement?
   * Defaults to FALSE and must be proven, not assumed: an unavailable model that
   * we advertise is the same defect as a resolution the model cannot produce.
   */
  hd15Available?: boolean;
  /**
   * May this seat use PRESET reference voices?
   *
   * xAI gates preset voices to US trusted partners. This is not a preference and
   * not a soft warning: an unentitled seat must never even be shown the control,
   * because a control that renders is a promise. Defaults to FALSE.
   */
  presetVoicesAvailable?: boolean;
}

/**
 * The ONLY way to build a {@link VideoRequestMode}.
 *
 * Takes the loose, optional inputs a call site actually has and either produces
 * exactly one mode or refuses by name. Everything it can refuse is a thing that
 * cannot exist afterwards, which is what lets every consumer downstream stop
 * re-checking it.
 */
export function buildVideoRequestMode<TAsset>(input: {
  image?: TAsset | null;
  referenceImages?: readonly TAsset[] | null;
  presetVoiceIds?: readonly string[] | null;
  editSource?: TAsset | null;
  capabilities?: VideoSeatCapabilities;
}): VideoModeResult<TAsset> {
  const image = input.image ?? undefined;
  const references = (input.referenceImages ?? []).filter((asset) => asset !== undefined && asset !== null);
  const voices = (input.presetVoiceIds ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0);
  const editSource = input.editSource ?? undefined;

  const families = [image !== undefined, references.length > 0, editSource !== undefined].filter(Boolean).length;
  if (families > 1) return { ok: false, reason: 'video-mode-ambiguous' };

  if (references.length === 0) {
    // A voice outside reference mode has nowhere to go. Refusing it here rather
    // than dropping it silently is the difference between "we cannot do that"
    // and a render that quietly ignores half of what was asked for.
    if (voices.length > 0) return { ok: false, reason: 'video-mode-ambiguous' };
    if (editSource !== undefined) return { ok: true, mode: { kind: 'edit', source: editSource } };
    if (image !== undefined) return { ok: true, mode: { kind: 'image', image } };
    return { ok: true, mode: { kind: 'text' } };
  }

  if (references.length > MAX_VIDEO_REFERENCE_IMAGES) return { ok: false, reason: 'reference-images-too-many' };
  if (voices.length > MAX_VIDEO_REFERENCE_AUDIOS) return { ok: false, reason: 'reference-voices-too-many' };
  if (voices.length > 0 && input.capabilities?.presetVoicesAvailable !== true) {
    return { ok: false, reason: 'reference-voices-not-entitled' };
  }
  return { ok: true, mode: { kind: 'reference', referenceImages: references, presetVoiceIds: voices } };
}

/** One selectable PRESET voice. An id the provider already holds, plus a label. */
export interface VideoPresetVoice {
  id: string;
  label: string;
}

/**
 * The preset voices this build may offer — DELIBERATELY EMPTY.
 *
 * The capability is real and gated (US trusted partners only), and the ≤3 bound
 * and the entitlement refusal are enforced and tested. What is NOT established is
 * the provider's actual preset voice IDS: they were not in the crawled profile
 * for this ticket, and inventing three plausible names would put strings into a
 * paid request that no upstream endpoint recognises — a fabricated catalogue that
 * looks exactly like a verified one.
 *
 * So the list stays empty and the control therefore does not render, even for an
 * entitled seat, until the ids are read off the provider profile and put here.
 * That is a smaller failure than a picker that offers voices which do not exist.
 */
export const VIDEO_PRESET_VOICES: readonly VideoPresetVoice[] = [];

/** A user-facing sentence per mode refusal. Named causes, never one generic. */
export function describeVideoModeRefusal(reason: VideoModeRefusal): string {
  switch (reason) {
    case 'video-mode-ambiguous':
      return 'Ein Video entsteht entweder aus einem Bild, aus Referenzbildern oder aus dem Text allein — bitte nur eine dieser Quellen.';
    case 'reference-images-too-many':
      return `Es sind höchstens ${MAX_VIDEO_REFERENCE_IMAGES} Referenzbilder möglich.`;
    case 'reference-voices-too-many':
      return `Es sind höchstens ${MAX_VIDEO_REFERENCE_AUDIOS} Stimmen möglich.`;
    case 'reference-voices-not-entitled':
      return 'Stimmen sind für dieses Konto nicht freigeschaltet.';
  }
}

// ---------------------------------------------------------------------------
// The PLAN — one resolution of mode + tier + capability into model and price
// ---------------------------------------------------------------------------

export type VideoPlanRefusal =
  | 'video-tier-unavailable'
  | 'reference-model-unavailable'
  | 'video-edit-resolution-refused';

/**
 * Everything a render is: which mode, which model, which resolution, how long,
 * and what it costs. Produced once and then carried — never recomputed by a
 * second surface with a second set of assumptions.
 */
export interface VideoPlan {
  modeKind: VideoModeKind;
  tierId: VideoQualityTier;
  resolution: VideoResolution;
  model: VideoModelId;
  usdPerSecond: number;
  creditsPerSecond: number;
  durationSeconds: number;
  /** The provider ceiling for THIS mode (15s for reference). */
  maxDurationSeconds: number;
  estimatedCredits: number;
  /** True iff the resolved tier is the explicit 1080p upgrade. */
  isUpgrade: boolean;
  /**
   * Set only when the request asked for a tier this mode cannot serve and the
   * mode CLAMPS rather than refuses. Reference-to-video clamps to 720p (a
   * provider ceiling on an otherwise valid request); editing REFUSES 1080p
   * instead, and keeps refusing it. The two rules differ on purpose, so the one
   * that silently changes the spec is the one that must say it changed it — the
   * price below is the clamped price, never the requested one.
   */
  clampedFromTierId?: VideoQualityTier;
}

export type VideoPlanResult = { ok: true; plan: VideoPlan } | { ok: false; reason: VideoPlanRefusal };

/** The tiers a mode can serve at all, before entitlement is considered. */
function tiersForMode(modeKind: VideoModeKind): readonly VideoTierSpec[] {
  if (modeKind === 'reference' || modeKind === 'edit') {
    return VIDEO_TIERS.filter((tier) => tier.resolution !== '1080p');
  }
  return VIDEO_TIERS;
}

/**
 * Resolve a request into the single spec that will be rendered AND billed.
 *
 * Every consumer — the picker's price line, the send path, the gateway body —
 * goes through here, so the number a user reads and the model a request reaches
 * cannot disagree. That is item E of MAT-1753 stated as code: an estimate can
 * only quote a rate this function looked up for the model it also chose.
 */
export function resolveVideoPlan(input: {
  modeKind: VideoModeKind;
  tierId?: VideoQualityTier;
  durationSeconds?: number;
  capabilities?: VideoSeatCapabilities;
}): VideoPlanResult {
  const requestedTier = getVideoTier(input.tierId);
  const hd15 = input.capabilities?.hd15Available === true;

  if (input.modeKind === 'reference' && !hd15) return { ok: false, reason: 'reference-model-unavailable' };

  let tier = requestedTier;
  let clampedFromTierId: VideoQualityTier | undefined;
  if (!tiersForMode(input.modeKind).some((candidate) => candidate.id === requestedTier.id)) {
    // Editing refuses; reference clamps. See VideoPlan.clampedFromTierId.
    if (input.modeKind === 'edit') return { ok: false, reason: 'video-edit-resolution-refused' };
    tier = getVideoTier(REFERENCE_VIDEO_TIER_ID);
    clampedFromTierId = requestedTier.id;
  }

  const model = videoModelFor(input.modeKind, tier.resolution);
  if (model === 'grok-imagine-video-1.5' && !hd15) return { ok: false, reason: 'video-tier-unavailable' };

  const usdPerSecond = VIDEO_MODEL_USD_PER_SECOND[model][tier.resolution];
  // Unreachable for every pair the routing above can produce, and checked anyway:
  // a missing rate must never become a free render.
  if (usdPerSecond === undefined) return { ok: false, reason: 'video-tier-unavailable' };

  const maxDurationSeconds = input.modeKind === 'reference' ? MAX_REFERENCE_VIDEO_SECONDS : MAX_VIDEO_DURATION_SECONDS;
  const rawDuration = input.durationSeconds;
  const requested =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.ceil(rawDuration)
      : DEFAULT_VIDEO_DURATION_SECONDS;
  const durationSeconds = Math.min(requested, maxDurationSeconds);
  const creditsPerSecond = deriveVideoCreditsPerSecond(usdPerSecond);

  return {
    ok: true,
    plan: {
      modeKind: input.modeKind,
      tierId: tier.id,
      resolution: tier.resolution,
      model,
      usdPerSecond,
      creditsPerSecond,
      durationSeconds,
      maxDurationSeconds,
      estimatedCredits: Math.ceil(durationSeconds * creditsPerSecond),
      isUpgrade: tier.isUpgrade,
      ...(clampedFromTierId === undefined ? {} : { clampedFromTierId }),
    },
  };
}

/** What the caller knows about the pending request when choosing a tier. */
export interface VideoTierAvailability {
  modeKind: VideoModeKind;
  capabilities?: VideoSeatCapabilities;
}

/**
 * The tiers that are genuinely offerable for THIS request. Anything that cannot
 * be produced is not returned — the honest selector shows what the request can
 * actually make, never an option that fails on submit.
 *
 * The migration is visible here: a TEXT prompt with 1.5 available now gets three
 * options including 1080p, because 1.5 does text-to-video. Without 1.5 proven it
 * still gets two, and reference mode gets none at all rather than a 480p/720p
 * pair the seat could not render.
 */
export function listAvailableVideoTiers(availability: VideoTierAvailability): readonly VideoTierSpec[] {
  return tiersForMode(availability.modeKind).filter(
    (tier) =>
      resolveVideoPlan({
        modeKind: availability.modeKind,
        tierId: tier.id,
        ...(availability.capabilities === undefined ? {} : { capabilities: availability.capabilities }),
      }).ok === true
  );
}

/**
 * Is this tier actually producible for the request? The submit path calls this so
 * an impossible tier is refused with a precise capability error instead of being
 * silently downgraded — a silent downgrade would bill 720p while the user was
 * shown 1080p, which is the exact dishonesty this lane keeps producing.
 */
export function isVideoTierAvailable(tierId: VideoQualityTier, availability: VideoTierAvailability): boolean {
  return listAvailableVideoTiers(availability).some((tier) => tier.id === tierId);
}

/** The cheaper Fast/720p tier id — the default the wall pre-selects. */
export const DEFAULT_VIDEO_TIER_ID: VideoQualityTier = 'fast';

/**
 * The tier reference-to-video clamps DOWN to. It is 720p by id rather than by
 * lookup so the clamp cannot drift if the tier list is ever reordered.
 */
export const REFERENCE_VIDEO_TIER_ID: VideoQualityTier = 'fast';

/** A typical clip length (seconds) used when the caller does not specify one. */
export const DEFAULT_VIDEO_DURATION_SECONDS = 5;

/**
 * The provider window for a non-reference generation, mirrored from the gateway
 * (`MAX_VIDEO_DURATION_SECONDS` in `video-generation-core.ts`). Reference mode has
 * its own, lower ceiling — {@link MAX_REFERENCE_VIDEO_SECONDS}.
 */
export const MAX_VIDEO_DURATION_SECONDS = 15;

/** Look up a tier spec by id (falls back to the default tier if unknown). */
export function getVideoTier(id: VideoQualityTier | undefined): VideoTierSpec {
  return VIDEO_TIERS.find((t) => t.id === id) ?? VIDEO_TIERS.find((t) => t.isDefault) ?? VIDEO_TIERS[0];
}

// ---------------------------------------------------------------------------
// Cost preview math
// ---------------------------------------------------------------------------

export interface VideoCostRequest {
  /** Clip duration in seconds (defaults to DEFAULT_VIDEO_DURATION_SECONDS). */
  durationSeconds?: number;
  /** Selected quality tier (defaults to the Fast/720p default tier). */
  tierId?: VideoQualityTier;
  /**
   * The mode the render will ACTUALLY use. REQUIRED, and that is the point of
   * item E: an estimate that does not know the mode cannot know the model, and an
   * estimate that does not know the model is a number about some other render.
   * There is deliberately no default — a caller that has not decided the mode has
   * not yet got a price.
   */
  modeKind: VideoModeKind;
  capabilities?: VideoSeatCapabilities;
}

export interface VideoCostPreview {
  /** Resolved clip duration (seconds, min 1). */
  durationSeconds: number;
  /** The resolved tier the estimate is for (AFTER any reference clamp). */
  tier: VideoTierSpec;
  /** Estimated credits this generation will cost (rounded UP — never understate). */
  estimatedCredits: number;
  /** Convenience: true iff the resolved tier is the explicit 1080p upgrade. */
  isUpgrade: boolean;
  /** The plan the estimate is FOR, so a caller can show/send the same spec. */
  plan: VideoPlan;
}

/**
 * Estimate the credit cost of a video generation, or refuse.
 *
 * Rounds UP so the preview is a conservative ceiling (a user should never be
 * surprised by a HIGHER charge than the wall showed). Returns `undefined` when
 * the request has no producible plan at all — a refusal, not a zero: quoting a
 * price for a render that cannot happen is how a picker promises what the
 * provider will not do.
 */
export function estimateVideoCost(request: VideoCostRequest): VideoCostPreview | undefined {
  const resolved = resolveVideoPlan({
    modeKind: request.modeKind,
    ...(request.tierId === undefined ? {} : { tierId: request.tierId }),
    ...(request.durationSeconds === undefined ? {} : { durationSeconds: request.durationSeconds }),
    ...(request.capabilities === undefined ? {} : { capabilities: request.capabilities }),
  });
  if (resolved.ok === false) return undefined;
  const plan = resolved.plan;
  return {
    durationSeconds: plan.durationSeconds,
    tier: getVideoTier(plan.tierId),
    estimatedCredits: plan.estimatedCredits,
    isUpgrade: plan.isUpgrade,
    plan,
  };
}

// ---------------------------------------------------------------------------
// The pre-submit gate decision
// ---------------------------------------------------------------------------

/**
 * The pre-submit gate state for a video request.
 */
export interface VideoSubmitGate {
  /**
   * Whether a blocking confirmation must be shown before submitting. FALSE:
   * asking to generate a video IS the authorisation for it, exactly as attaching
   * an image is the authorisation to analyse it.
   */
  requiresConfirm: boolean;
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The tier a request resolves to when the user did not pick one (Fast/720p). */
  defaultTierId: VideoQualityTier;
}

/**
 * Build the pre-submit gate for a video request.
 *
 * This used to hard-code `requiresConfirm: true` — every single generation
 * opened a modal that asked the user to approve a cost they had just asked to
 * incur. That is not a safety boundary, it is a second question: the request
 * itself already carried the intent.
 *
 * The real brake was never here. It is server-side, fail-closed, and it runs
 * BEFORE the upstream call: `reservePaidLane` loads the balance and answers 402
 * rather than proceeding, via `canAfford`, which refuses on both
 * `insufficient_credits` and `spend_cap_exceeded`
 * (Company.OS supabase/functions/_shared/eve-inference-core.ts and credits-core.ts).
 *
 * Not to be confused with `commitDebit` in eve-inference/index.ts: that is the
 * post-generation ledger reconcile, and its `insufficient` branch is a retry, not
 * a refusal. An earlier revision of this comment cited it as the brake. It is not
 * one, and naming the wrong mechanism is how a limit gets believed into existence.
 *
 * The estimate does not disappear with the wall: the resolved tier and credit
 * figure travel into the dispatched message (`buildResolvedVideoMessage`), so
 * the number stays visible without blocking on it.
 *
 * Still gated elsewhere, unchanged: a provider that is not configured, new
 * billing, and any new sensitive egress.
 */
export function buildVideoSubmitGate(): VideoSubmitGate {
  return {
    requiresConfirm: false,
    allowed: true,
    defaultTierId: DEFAULT_VIDEO_TIER_ID,
  };
}

/**
 * Guard that an upgrade to 1080p (the `hd` tier) was an EXPLICIT user action.
 * The wall starts on the default tier; this returns true only when the selected
 * tier is the upgrade AND the user explicitly toggled it (never auto-selected).
 */
export function isExplicitUpgrade(args: { selectedTierId: VideoQualityTier; userToggledUpgrade: boolean }): boolean {
  const tier = getVideoTier(args.selectedTierId);
  if (!tier.isUpgrade) return false;
  return args.userToggledUpgrade === true;
}

// ---------------------------------------------------------------------------
// Video-generation INTENT detection (the send-path seam)
// ---------------------------------------------------------------------------

/**
 * Phrases that signal the user is asking to GENERATE a video, not merely
 * mentioning one. Matched case-insensitively against the trimmed message; DE + EN.
 *
 * PRECISION OVER RECALL, and that is a deliberate reversal. This list used to be
 * wide because a cost wall stood behind it: an over-firing pattern only cost the
 * user a cancel click. The wall is gone — asking for a video is now the
 * authorisation — so a false positive routes a perfectly ordinary message into
 * the video lane and spends on it with nothing left to catch the mistake.
 *
 * These nouns were removed for exactly that reason, each with a real sentence
 * that tripped it: `short(s)` ("create a short summary of this meeting"),
 * `story/stories` ("make a short story for my blog"), `ad/advert` ("design an ad
 * for Google Ads, text only"), and bare German `film` ("ich will heute Abend
 * einen Film schauen"). The verbs `edit` and `cut` went with them ("edit this
 * blog post about our new ad campaign"), and German `will`, which is a plain
 * future auxiliary.
 *
 * Losing those does not lose genuine video edits: a real editing request still
 * reaches the lane through the capability, the addressed videomarketer or a video
 * skill (see {@link requestRoutesToVideoLane}). Only the regex-ONLY path narrows,
 * and that is the path with no other check behind it.
 *
 * `youtube shorts` survives in the format list, where it is unambiguous.
 */
const VIDEO_GENERATION_PATTERNS: readonly RegExp[] = [
  // EN: "generate/create/make/produce a video/clip/reel/animation/trailer"
  /\b(generate|create|make|produce|render|animate|shoot|design|build|whip\s+up)\b[^.!?]{0,60}\b(video|clip|reel|tiktok|tik[-\s]?tok|animation|commercial|trailer|montage|footage|movie)s?\b/i,
  // EN: noun-first — "a video for ... — create it", "promo video"
  /\b(video|clip|reel|kurzvideo|tiktok|tik[-\s]?tok|animation|trailer)s?\b[^.!?]{0,60}\b(generate|create|make|produce|render|animate|shoot|design|build|für\s+mich|for\s+me)\b/i,
  // EN: format/lane keywords — "text-to-video", "ai video", "video generation"
  /\b(text[-\s]?to[-\s]?video|img[-\s]?to[-\s]?video|image[-\s]?to[-\s]?video|video\s+gen(eration)?|ai\s+video|video\s+ad|promo\s+video|explainer\s+video|product\s+video|youtube\s+shorts?)\b/i,
  // DE: "erstelle/mach/generiere/produziere/drehe/schneide ein Video/Clip/Reel".
  // `schneid` stays here although English `cut` was dropped: the ambiguity that
  // forced `cut` out is English-only ("cut the intro from the audio clip"), while
  // the German nouns this pairs with — Werbespot, Kurzvideo, Imagefilm — carry the
  // video meaning on their own.
  /\b(erstell|erstelle|erstellst|mach|mache|machst|generier|generiere|generierst|produzier|produziere|dreh|drehe|drehst|erzeug|erzeuge|schneid|schneide|bau|baue|design|entwirf|brauch|brauche|brauchst|braucht|möcht|möchte|möchtest|hätte?\s+gern)\b[^.!?]{0,60}\b(video|clip|reel|kurzvideo|tiktok|tik[-\s]?tok|animation|werbespot|werbevideo|trailer|imagefilm|produktvideo)s?\b/i,
  // DE: verb-after-noun — "Video erstellen/generieren/produzieren"
  /\b(video|clip|reel|kurzvideo|tiktok|tik[-\s]?tok|animation|werbespot|werbevideo|trailer|imagefilm|produktvideo)s?\b[^.!?]{0,60}\b(erstellen|erstell|generieren|generier|drehen|dreh|produzieren|produzier|machen|mach|erzeugen|erzeug|bauen|bau|für\s+mich)\b/i,
];

/**
 * Heuristically detect whether a chat message is asking to GENERATE a video
 * (the heavy paid lane). Pure + dependency-light so the send-path can decide,
 * BEFORE submitting, whether to route through the cost-wall.
 *
 * READ {@link requestRoutesToVideoLane} BEFORE WIDENING THIS. That function ORs
 * this regex with the capability, the addressed agent and the video skills — so
 * a match here is SUFFICIENT on its own to route into the video lane. An older
 * comment here claimed the opposite ("a helpful pre-filter, NOT the sole gate …
 * the fail-safe is the capability gate, not this function"); that was never true
 * of the code, and with the cost wall removed it was actively misleading, because
 * it invited widening a pattern that now spends money unattended.
 *
 * Empty / whitespace / non-string input is never a video request.
 */
export function isVideoGenerationRequest(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (text.length === 0) return false;
  return VIDEO_GENERATION_PATTERNS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Fail-safe video-lane gate (DUX-6) — do NOT rely on the NL regex alone
// ---------------------------------------------------------------------------

/**
 * The stable roster agent id of the heavy video lane worker (the videomarketer).
 * Mirrors `eveTeamRoster` `video-marketer` — duplicated here as a plain string
 * so this module stays a pure, dependency-light core. If the roster id ever
 * changes (it must not — it is the ledger attribution key), update both.
 */
export const VIDEO_LANE_AGENT_ID = 'video-marketer';

/**
 * Hermes skills that mark a worker as the heavy GPU video lane. Mirrors the
 * `video-marketer` role's `skills`.
 *
 * WHAT THIS ACTUALLY DOES TODAY, corrected (1.820.1). This used to claim the
 * cost-wall "MUST fire" whenever a request is routed to a worker owning one of
 * these skills. The gate below does honour `resolvedSkills` — but NO send path
 * supplies it: both call sites in AcpSendBox pass only `message` and
 * `resolvedAgentId`, so in the shipped product this branch is never taken and
 * the wall fires on the addressed agent id or the NL classifier. That is a
 * capability the send path has not wired yet, not a guarantee it keeps; a
 * comment asserting the guarantee made the gap invisible.
 */
const VIDEO_LANE_SKILLS: ReadonlySet<string> = new Set(['video-script', 'storyboard', 'social-video']);

/** Inputs the send-path knows about a pending send, used to decide video routing. */
export interface VideoLaneRouting {
  /** The raw chat message (run through the NL classifier). */
  message?: string | null;
  /** The agent id the request is addressed to / resolved to (if any). */
  resolvedAgentId?: string | null;
  /** The skill labels of the resolved worker / capability (if known). */
  resolvedSkills?: readonly string[] | null;
  /**
   * An explicit signal that the resolver already classified this as the video
   * capability (e.g. a tool/lane class). When true the wall fires unconditionally.
   */
  resolvedVideoCapability?: boolean | null;
}

/**
 * FAIL-SAFE gate (DUX-6): true iff a pending request reaches the heavy video
 * lane by ANY known path — so the cost-wall fires even when the NL regex misses.
 * The gate is the OR of every signal we have:
 *
 *   1. the request is addressed to / resolved to the videomarketer agent id, OR
 *   2. the resolved worker owns a video-lane skill (video-script/storyboard/…), OR
 *   3. the resolver explicitly flagged the video capability, OR
 *   4. (last resort) the NL prompt classifier {@link isVideoGenerationRequest}.
 *
 * Routing on the resolved capability/worker — not just the prompt — is the whole
 * point: it removes the regex as the SOLE gate. The wall over-firing (a false
 * positive) is cheap and recoverable (the user cancels); a false-negative silently
 * spends on the most expensive lane, which is the failure we refuse.
 *
 * HONEST STATUS of those four signals: the send path supplies (1) and (4). (2)
 * and (3) are accepted here and covered by unit tests, but no production caller
 * passes `resolvedSkills` or `resolvedVideoCapability` yet — so today the regex
 * is still the sole gate for a request that is not addressed to the videomarketer.
 */
export function requestRoutesToVideoLane(routing: VideoLaneRouting): boolean {
  if (routing.resolvedVideoCapability === true) return true;
  if (typeof routing.resolvedAgentId === 'string' && routing.resolvedAgentId.trim() === VIDEO_LANE_AGENT_ID) {
    return true;
  }
  if (Array.isArray(routing.resolvedSkills) && routing.resolvedSkills.some((s) => VIDEO_LANE_SKILLS.has(s))) {
    return true;
  }
  return isVideoGenerationRequest(routing.message);
}

/**
 * Convenience alias kept readable at the send-path call-site. Identical to
 * {@link requestRoutesToVideoLane}; named for the question the gate answers
 * ("is this the video lane?") so the SendBox reads as a fail-safe, not a regex.
 */
export function isVideoLaneRequest(routing: VideoLaneRouting): boolean {
  return requestRoutesToVideoLane(routing);
}

// ---------------------------------------------------------------------------
// Resolved video-request payload (DUX-5) — what CONFIRM actually sends
// ---------------------------------------------------------------------------

/** The user's resolved selection from the cost-wall (tier + previewed credits). */
export interface ResolvedVideoSelection {
  tierId: VideoQualityTier;
  estimatedCredits: number;
}

/**
 * Build the message the send-path dispatches AFTER the user confirms the wall
 * (DUX-5). The prior wiring discarded the resolved tier/resolution/cost and
 * re-fired the UNMODIFIED original text — so confirming did NOT actually route a
 * video request at the chosen spec. This appends an explicit, agent-readable
 * video directive carrying the resolved resolution + per-clip credit ceiling, so
 * the request the videomarketer/video lane receives matches exactly what the
 * user saw and approved.
 *
 * The directive is a deterministic suffix, so it is both human-legible and
 * parseable by the agent. The original intent text is preserved verbatim ahead
 * of it.
 *
 * A pre-existing directive is REPLACED, not preserved. It used to be kept ("never
 * double-stamp"), which was correct about the symptom and wrong about the cure:
 * a stamped message comes back into the composer through arrow-up history and
 * through editing a queued item, and keeping the old stamp meant the user could
 * pick HD, watch the pill say HD, and dispatch `tier=fast` — or inherit a stale
 * `tier=hd` while the pill read Fast and be billed for it. Found by CAO audit on
 * 6c59706a with an executed proof. Replacing is still idempotent for the case
 * that motivated the skip (same input, same output) and is correct for the case
 * it got wrong.
 */
export function buildResolvedVideoMessage(originalMessage: string, resolved: ResolvedVideoSelection): string {
  const tier = getVideoTier(resolved.tierId);
  const directive =
    `[EVE:VIDEO tier=${tier.id} resolution=${tier.resolution} ` +
    `quality=${tier.isUpgrade ? 'hd' : 'fast'} credits<=${resolved.estimatedCredits}]`;
  const base = typeof originalMessage === 'string' ? originalMessage : '';
  // Strip EVERY prior directive (a recalled message could carry more than one)
  // together with the blank line that separated it, then re-stamp the fresh one.
  //
  // `[^\]\n]*`, NOT `[^\]]*`: the class must not cross a line break. The emitted
  // directive never contains a newline, so binding it to one line matches every
  // real stamp — while the unbound version would swallow everything between a
  // user-typed "[EVE:VIDEO " and the next "]" anywhere later in the message,
  // silently deleting their text. CAO found that on ce8f90e7 with a worked
  // example. Removing a single-line lookalike is deliberate: it stops a typed
  // string from impersonating a resolved spec.
  const stripped = base.replace(/\n*\[EVE:VIDEO [^\]\n]*\]/g, '');
  const trimmed = stripped.replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n\n${directive}` : directive;
}
