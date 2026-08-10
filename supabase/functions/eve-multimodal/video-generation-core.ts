// Video generation — the PURE half: capability matrix, price derivation and
// request validation. No fetch, no Deno.env, so every rule below is testable
// without a network or a deployed function.
//
// The capability matrix is the point of this module, not a detail of it. Per the
// official xAI model profiles (MAT-1753 — this REPLACES what the comment here
// used to claim):
//
//   grok-imagine-video      text | image | video -> video.  480p $0.05/s, 720p $0.07/s.
//                           There is NO 1080p.
//   grok-imagine-video-1.5  text | image -> video.  480p $0.08/s, 720p $0.14/s,
//                           1080p $0.25/s. TEXT-TO-VIDEO IS INCLUDED, at native
//                           1080p. It also owns REFERENCE-TO-VIDEO: up to 7
//                           reference images, up to 3 PRESET voices, max 15s,
//                           max 720p.
//
// WHAT THIS FILE USED TO SAY, verbatim, because it was believed for two releases:
// "it is IMAGE -> VIDEO ONLY and cannot take a bare prompt … So 1080p is
// unreachable for a text prompt, at any price, under any entitlement." That is
// false. It was encoded as `requiresImageInput: true` on the hd tier, and it made
// the product refuse a resolution the provider sells.
//
// What survives the correction is the POSTURE, which was always right: a request
// that asks for something the provider cannot produce is refused with a precise
// capability error rather than silently downgraded, because a silent downgrade
// would bill a 720p job against a 1080p promise.
//
// THE FOUR MODES ARE MUTUALLY EXCLUSIVE. text / image / reference / edit are
// alternatives, not flags — reference cannot combine with image->video and cannot
// combine with an edit. `extractEveMultimodalVideoInput` builds a
// `VideoRequestMode` union, so a body carrying two input families is refused at
// the parse rather than validated afterwards; downstream there is no shape that
// can hold the impossible combination.
//
// PRICE IS KEYED BY (MODEL, RESOLUTION). The tier records used to carry the rate,
// which silently assumed one model per resolution. Reference mode runs on 1.5, so
// its 720p second costs $0.14 — double the base model'"'"'s $0.07. Quoting the tier
// rate for a reference render would under-bill it by half, every time.

import crypto from 'node:crypto';

export type VideoQualityTier = 'sd' | 'fast' | 'hd';
export type VideoResolution = '480p' | '720p' | '1080p';
export type VideoModelId = 'grok-imagine-video' | 'grok-imagine-video-1.5';
export const VIDEO_MODEL_IDS: readonly VideoModelId[] = Object.freeze(['grok-imagine-video', 'grok-imagine-video-1.5']);

/** The four MUTUALLY EXCLUSIVE ways a clip can be produced. */
export type VideoModeKind = 'text' | 'image' | 'reference' | 'edit';

/**
 * A tier is now nothing but a NAME FOR A RESOLUTION.
 *
 * `model`, `usdPerSecond`, `creditsPerSecond` and `requiresImageInput` were all
 * removed deliberately: each was a per-resolution constant that stopped being one
 * the moment a second model could serve the same resolution. The price and the
 * model are reachable only through `resolveVideoPlan`, which knows the mode.
 */
export type VideoTierSpec = {
  id: VideoQualityTier;
  resolution: VideoResolution;
  isDefault: boolean;
};

// The existing internal conversion, mirrored from _shared/credits-core.ts:
// metered image/video/music lanes take the universal DEFAULT_MARKUP_FACTOR floor,
// and CREDITS_PER_EUR_CENT is the integer 10.
export const VIDEO_MARKUP_FACTOR = 2;
export const VIDEO_CREDITS_PER_EUR_CENT = 10;

/**
 * Retail credits per generated second, derived from the provider's USD list price.
 *
 * Integer cents FIRST: `0.05 * 100` is 5.000000000000001 in IEEE-754, and a later
 * ceil() would turn that into 101 credits instead of 100 — a price wrong by a
 * rounding artefact. credits-core makes the same point when it stores the credit
 * ratio as an integer instead of dividing by 0.1.
 *
 * USD cents are treated 1:1 as EUR cents. There is no FX source in this codebase
 * (OpenRouter reports `cost_eur_cents` directly, so eve-inference never needed
 * one). EUR > USD, so this over-states slightly and can never under-charge — the
 * safe direction — but it is an assumption, and this is the line to change if a
 * real rate appears.
 */
export function deriveVideoCreditsPerSecond(usdPerSecond: number): number {
  const rawCents = Math.round(usdPerSecond * 100);
  return rawCents * VIDEO_MARKUP_FACTOR * VIDEO_CREDITS_PER_EUR_CENT;
}

export const VIDEO_TIERS: readonly VideoTierSpec[] = Object.freeze([
  { id: 'sd', resolution: '480p', isDefault: false },
  { id: 'fast', resolution: '720p', isDefault: true },
  { id: 'hd', resolution: '1080p', isDefault: false },
] as const);

/**
 * Provider list price per generated second, USD, keyed by (model, resolution) —
 * the ONLY price table in this module.
 *
 * An absent entry is a real statement: the base model has no 1080p, so asking for
 * its 1080p rate must be `undefined` rather than a number that would let an
 * impossible render carry a plausible price.
 */
export const VIDEO_MODEL_USD_PER_SECOND: Readonly<
  Record<VideoModelId, Readonly<Partial<Record<VideoResolution, number>>>>
> = Object.freeze({
  'grok-imagine-video': Object.freeze({ '480p': 0.05, '720p': 0.07 }),
  'grok-imagine-video-1.5': Object.freeze({
    '480p': 0.08,
    '720p': 0.14,
    '1080p': 0.25,
  }),
});

export const DEFAULT_VIDEO_TIER_ID: VideoQualityTier = 'fast';
export const REFERENCE_VIDEO_TIER_ID: VideoQualityTier = 'fast';
export const MIN_VIDEO_DURATION_SECONDS = 1;
export const MAX_VIDEO_DURATION_SECONDS = 15;
/**
 * The hard transport ceiling for CATALOG-model requests (F8, 1.820.5). The
 * per-model ceiling is the entry's own supported_durations max (20s today,
 * flux-3-video and sora-2-pro); this constant only bounds what the parser
 * lets through before the entry is consulted. Legacy Grok requests keep the
 * flat 15s cap above.
 */
export const MAX_CATALOG_VIDEO_DURATION_SECONDS = 20;

/** Reference-to-video ceilings, from the profile. */
export const MAX_VIDEO_REFERENCE_IMAGES = 7;
export const MAX_VIDEO_REFERENCE_AUDIOS = 3;
export const MAX_REFERENCE_VIDEO_SECONDS = 15;

export function getVideoTier(id: VideoQualityTier | undefined): VideoTierSpec {
  return VIDEO_TIERS.find((tier) => tier.id === id) ?? VIDEO_TIERS.find((tier) => tier.isDefault)!;
}

/**
 * Which model serves a (mode, resolution) pair. Total, and only two rules:
 * reference-to-video exists ONLY on 1.5; otherwise the cheaper base model serves
 * 480p/720p and 1.5 serves 1080p, because the base model has no 1080p.
 *
 * It never asks whether an image is present, because the model does not.
 */
export function videoModelFor(modeKind: VideoModeKind, resolution: VideoResolution): VideoModelId {
  if (modeKind === 'reference') return 'grok-imagine-video-1.5';
  return resolution === '1080p' ? 'grok-imagine-video-1.5' : 'grok-imagine-video';
}

export type VideoSeatCapabilities = {
  /** Proven, not assumed. An unavailable model advertised is the same defect. */
  hd15Available?: boolean;
  /** Preset reference voices: US trusted-partner only. Defaults to FALSE. */
  presetVoicesAvailable?: boolean;
};

export type VideoPlanRefusal =
  | 'video-tier-unavailable'
  | 'video-model-unavailable'
  | 'reference-model-unavailable'
  | 'video-edit-resolution-refused';

export type VideoPlan = {
  modeKind: VideoModeKind;
  tierId: VideoQualityTier;
  resolution: VideoResolution;
  model: VideoModelId;
  usdPerSecond: number;
  creditsPerSecond: number;
  durationSeconds: number;
  maxDurationSeconds: number;
  estimatedCredits: number;
  /** Set only when reference mode CLAMPED a requested tier down to 720p. */
  clampedFromTierId?: VideoQualityTier;
};

export type VideoPlanResult = { ok: true; plan: VideoPlan } | { ok: false; reason: VideoPlanRefusal };

function tiersForMode(modeKind: VideoModeKind): readonly VideoTierSpec[] {
  if (modeKind === 'reference' || modeKind === 'edit') {
    return VIDEO_TIERS.filter((tier) => tier.resolution !== '1080p');
  }
  return VIDEO_TIERS;
}

/**
 * Resolve a request into the single spec that will be rendered AND billed.
 *
 * Every consumer — the capability gate, the debit estimate, the provider payload
 * — goes through here, so the model a request reaches and the number it is
 * charged cannot disagree.
 *
 * Reference mode CLAMPS a 1080p request to 720p; editing REFUSES it. The two
 * differ on purpose, and the clamp is safe precisely because the price below is
 * the clamped price, never the requested one.
 */
export function resolveVideoPlan(input: {
  modeKind: VideoModeKind;
  tierId?: VideoQualityTier;
  /** Explicit client selection; absent preserves automatic economical routing. */
  modelId?: VideoModelId;
  durationSeconds?: number;
  capabilities?: VideoSeatCapabilities;
}): VideoPlanResult {
  const requestedTier = getVideoTier(input.tierId);
  const hd15 = input.capabilities?.hd15Available === true;
  if (input.modeKind === 'reference' && !hd15) {
    return { ok: false, reason: 'reference-model-unavailable' };
  }

  let tier = requestedTier;
  let clampedFromTierId: VideoQualityTier | undefined;
  if (!tiersForMode(input.modeKind).some((candidate) => candidate.id === requestedTier.id)) {
    if (input.modeKind === 'edit') {
      return { ok: false, reason: 'video-edit-resolution-refused' };
    }
    tier = getVideoTier(REFERENCE_VIDEO_TIER_ID);
    clampedFromTierId = requestedTier.id;
  }

  const automaticModel = videoModelFor(input.modeKind, tier.resolution);
  const model = input.modelId ?? automaticModel;
  if (input.modeKind === 'reference' && model !== 'grok-imagine-video-1.5') {
    return { ok: false, reason: 'video-model-unavailable' };
  }
  if (input.modeKind === 'edit' && model !== automaticModel) {
    return { ok: false, reason: 'video-model-unavailable' };
  }
  if (model === 'grok-imagine-video-1.5' && !hd15) {
    return { ok: false, reason: 'video-tier-unavailable' };
  }
  const usdPerSecond = VIDEO_MODEL_USD_PER_SECOND[model][tier.resolution];
  // Unreachable for every pair the routing above produces, and checked anyway: a
  // missing rate must never become a free render.
  if (usdPerSecond === undefined) {
    return {
      ok: false,
      reason: input.modelId === undefined ? 'video-tier-unavailable' : 'video-model-unavailable',
    };
  }

  const maxDurationSeconds = input.modeKind === 'reference' ? MAX_REFERENCE_VIDEO_SECONDS : MAX_VIDEO_DURATION_SECONDS;
  const requested =
    typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds)
      ? Math.max(MIN_VIDEO_DURATION_SECONDS, Math.ceil(input.durationSeconds))
      : MIN_VIDEO_DURATION_SECONDS;
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
      estimatedCredits: durationSeconds * creditsPerSecond,
      ...(clampedFromTierId === undefined ? {} : { clampedFromTierId }),
    },
  };
}

export type VideoTierAvailability = {
  modeKind: VideoModeKind;
  modelId?: VideoModelId;
  capabilities?: VideoSeatCapabilities;
};

export function listAvailableVideoTiers(availability: VideoTierAvailability): readonly VideoTierSpec[] {
  return tiersForMode(availability.modeKind).filter(
    (tier) =>
      resolveVideoPlan({
        modeKind: availability.modeKind,
        tierId: tier.id,
        ...(availability.modelId === undefined ? {} : { modelId: availability.modelId }),
        ...(availability.capabilities === undefined ? {} : { capabilities: availability.capabilities }),
      }).ok
  );
}

export function isVideoTierAvailable(tierId: VideoQualityTier, availability: VideoTierAvailability): boolean {
  return listAvailableVideoTiers(availability).some((tier) => tier.id === tierId);
}

/**
 * The estimated retail cost of a PLAN, in credits.
 *
 * It takes the plan, not a tier id, and that is item E as a signature: a caller
 * holding only a tier cannot ask this function for a price, so it cannot quote
 * 1.5 pricing for a render that will not use 1.5 — or base pricing for one that
 * will.
 */
export function estimateVideoCredits(plan: VideoPlan): number {
  return plan.estimatedCredits;
}

/** Credits -> EUR cents, for the canAfford check (10 credits per EUR cent). */
export function videoCreditsToEurCents(credits: number): number {
  return credits / VIDEO_CREDITS_PER_EUR_CENT;
}

/** One source asset on the wire: the bytes plus the receipt that names them. */
export type VideoAssetInput = {
  base64: string;
  sha256: string;
};

/**
 * The request's INPUT, as a discriminated union.
 *
 * There is no value of this type carrying an image AND reference images: the
 * alternatives are branches, not optional fields. That is what makes the four
 * modes mutually exclusive BY CONSTRUCTION rather than by a validator somebody
 * can forget to call. `presetVoiceIds` lives inside the `reference` branch for
 * the same reason — a voice on a text-to-video job cannot be written down.
 */
export type VideoRequestMode =
  | { kind: 'text' }
  | { kind: 'image'; image: VideoAssetInput }
  | {
      kind: 'reference';
      referenceImages: readonly VideoAssetInput[];
      presetVoiceIds: readonly string[];
    };

export type EveMultimodalVideoInput = {
  prompt: string;
  /**
   * The legacy tier. REQUIRED for legacy (Grok / no-model) requests; optional
   * for catalog-model requests, where it only seeds the tier->resolution
   * mapping when no free `resolution` is sent.
   */
  tierId?: VideoQualityTier;
  modelId?: VideoModelId;
  /**
   * A model id from the OpenRouter video catalog snapshot (F8, 1.820.5),
   * e.g. `google/veo-3.1`. Mutually exclusive with `modelId`: the parser puts
   * a `vendor/slug`-shaped non-Grok id HERE, and catalog membership,
   * resolution and duration are validated against the entry downstream —
   * never assumed by this type.
   */
  catalogModelId?: string;
  /**
   * The free-form resolution of a catalog-model request ("2K", "1080p", …).
   * Present only alongside `catalogModelId`; legacy requests name a tier and
   * the tier owns the resolution.
   */
  resolution?: string;
  durationSeconds: number;
  mode: VideoRequestMode;
};

const MAX_VIDEO_PROMPT_CHARS = 4_000;
const MAX_VIDEO_IMAGE_BASE64_CHARS = 12_000_000; // ~9 MB of image bytes

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse and BOUND a video-generation request. Returns null for anything that is
 * not a well-formed, in-range request — the caller turns that into a 400 rather
 * than forwarding a half-understood body to a paid provider.
 */
export function extractEveMultimodalVideoInput(body: unknown): EveMultimodalVideoInput | null {
  if (!isRecord(body)) return null;
  const raw = isRecord(body.video_generation) ? body.video_generation : null;
  if (!raw) return null;

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (prompt.length === 0 || prompt.length > MAX_VIDEO_PROMPT_CHARS) {
    return null;
  }

  // MODEL FIRST, because it decides which contract the rest of the body
  // speaks. The two legacy Grok ids keep the legacy contract (tier required,
  // flat 15s cap, tier owns the resolution). Any other id must be a
  // `vendor/slug`-shaped CATALOG id (F8, 1.820.5): catalog membership is
  // validated downstream against the pinned snapshot, and a shaped-but-unknown
  // id is refused there, before any money moves. Anything else — a number, a
  // bare word, a url — is refused here.
  const modelId = raw.model;
  const isLegacyModel =
    modelId === undefined || modelId === 'grok-imagine-video' || modelId === 'grok-imagine-video-1.5';
  let catalogModelId: string | undefined;
  if (!isLegacyModel) {
    if (
      typeof modelId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(modelId) ||
      modelId.length > 128
    ) {
      return null;
    }
    catalogModelId = modelId;
  }

  const tierId = raw.tier;
  const tierValid = tierId === 'sd' || tierId === 'fast' || tierId === 'hd';
  if (tierId !== undefined && !tierValid) return null;
  // Legacy requests REQUIRE the tier — the tier owns the resolution there.
  if (catalogModelId === undefined && !tierValid) return null;

  // The free-form resolution exists ONLY on the catalog contract. On a legacy
  // body it would be a second, conflicting way to name what the tier already
  // owns — refused, never silently preferred.
  const resolutionRaw = raw.resolution;
  if (resolutionRaw !== undefined) {
    if (catalogModelId === undefined) return null;
    if (typeof resolutionRaw !== 'string' || resolutionRaw.length === 0 || resolutionRaw.length > 8) {
      return null;
    }
  }

  const durationRaw = raw.duration_seconds;
  if (typeof durationRaw !== 'number' || !Number.isFinite(durationRaw)) {
    return null;
  }
  const durationSeconds = Math.ceil(durationRaw);
  // Legacy keeps the flat 15s cap; catalog requests get the hard transport
  // ceiling here and the ENTRY's own bound downstream (supported_durations).
  const maxDuration = catalogModelId === undefined ? MAX_VIDEO_DURATION_SECONDS : MAX_CATALOG_VIDEO_DURATION_SECONDS;
  if (durationSeconds < MIN_VIDEO_DURATION_SECONDS || durationSeconds > maxDuration) return null;

  // REFUSE a present-but-wrong-typed image_base64; never silently drop it.
  //
  // This was `typeof raw.image_base64 === "string" ? … : undefined` on its own,
  // which turned a number / object / array / boolean into "no image at all" — so a
  // body that ASKED for an image->video render was parsed as a TEXT render,
  // produced a text video, and BILLED the user for it. A malformed field is not a
  // request for a cheaper product. Both siblings already refuse exactly this shape
  // (extractVideoReferenceImages returns null on a non-string image_base64;
  // extractVideoPresetVoiceIds returns null on a non-string entry), so this closes
  // the one member of the family that guessed.
  //
  // `null` is refused alongside the rest, deliberately: an explicit null is a
  // client that built the field and failed to fill it, which is precisely the case
  // worth surfacing. Only an ABSENT key means "no image".
  if (raw.image_base64 !== undefined && typeof raw.image_base64 !== 'string') {
    return null;
  }
  const imageBase64 = typeof raw.image_base64 === 'string' ? raw.image_base64 : undefined;
  if (imageBase64 !== undefined) {
    if (imageBase64.length === 0 || imageBase64.length > MAX_VIDEO_IMAGE_BASE64_CHARS) return null;
    if (typeof raw.image_sha256 !== 'string' || raw.image_sha256.length !== 64) {
      return null;
    }
  }

  const references = extractVideoReferenceImages(raw.reference_images);
  if (references === null) return null;

  // Preset voice IDS only. There is deliberately no branch that reads bytes, a
  // url, or any `*_audio_base64`-shaped field: custom audio upload is
  // unsupported upstream, so the parser has no way to carry one and no key set
  // downstream can contain one.
  const voices = extractVideoPresetVoiceIds(raw.reference_audios);
  if (voices === null) return null;

  // MUTUAL EXCLUSION, at the parse. A body naming two input families is refused
  // here rather than validated later, so nothing downstream ever holds one.
  if (imageBase64 !== undefined && references.length > 0) return null;
  if (voices.length > 0 && references.length === 0) return null;

  const mode: VideoRequestMode =
    references.length > 0
      ? {
          kind: 'reference',
          referenceImages: references,
          presetVoiceIds: voices,
        }
      : imageBase64 === undefined
        ? { kind: 'text' }
        : {
            kind: 'image',
            image: { base64: imageBase64, sha256: raw.image_sha256 as string },
          };

  return {
    prompt,
    ...(tierValid ? { tierId: tierId as VideoQualityTier } : {}),
    ...(isLegacyModel && modelId !== undefined ? { modelId: modelId as VideoModelId } : {}),
    ...(catalogModelId === undefined ? {} : { catalogModelId }),
    ...(resolutionRaw === undefined ? {} : { resolution: resolutionRaw as string }),
    durationSeconds,
    mode,
  };
}

/**
 * Up to 7 reference images, each with its own SHA-256 receipt.
 *
 * `null` is a REFUSAL (malformed, or an eighth image), `[]` means "the body did
 * not ask for reference mode". Truncating an eighth image to seven would render
 * something the user did not ask for and bill them for it.
 */
function extractVideoReferenceImages(raw: unknown): VideoAssetInput[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];
  if (raw.length > MAX_VIDEO_REFERENCE_IMAGES) return null;
  const assets: VideoAssetInput[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const base64 = entry.image_base64;
    const sha256 = entry.image_sha256;
    if (typeof base64 !== 'string' || base64.length === 0) return null;
    if (base64.length > MAX_VIDEO_IMAGE_BASE64_CHARS) return null;
    if (typeof sha256 !== 'string' || sha256.length !== 64) return null;
    assets.push({ base64, sha256 });
  }
  return assets;
}

/** Up to 3 PRESET voice ids. `null` is a refusal; `[]` means none were asked for. */
function extractVideoPresetVoiceIds(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];
  if (raw.length > MAX_VIDEO_REFERENCE_AUDIOS) return null;
  const ids: string[] = [];
  for (const entry of raw) {
    // A STRING id and nothing else. An object here would be the shape a custom
    // audio payload arrives in, so it is refused rather than partially read.
    if (typeof entry !== 'string') return null;
    const id = entry.trim();
    if (id.length === 0 || id.length > 64) return null;
    ids.push(id);
  }
  return ids;
}

/** The mode a parsed request actually represents. */
export function videoModeKindOf(input: EveMultimodalVideoInput): VideoModeKind {
  return input.mode.kind;
}

/** Every source image on a parsed request, whichever mode carried it. */
export function videoSourceAssetsOf(input: EveMultimodalVideoInput): readonly VideoAssetInput[] {
  if (input.mode.kind === 'image') return [input.mode.image];
  if (input.mode.kind === 'reference') return input.mode.referenceImages;
  return [];
}

/** sha256 of the prompt text, used both by the usage fingerprint and the debit ref. */
export function videoPromptSha256(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export type VideoDebitExternalRefInput = {
  tenantId: string;
  promptSha256: string;
  /**
   * The RESOLVED model identity — a legacy Grok id, or a catalog slug for
   * F8/1.820.5 requests. Typed as string deliberately: the ref must be able
   * to name any model the catalog serves, and two different models must
   * never share an idempotency key.
   */
  model: string;
  /** The resolved tier, or the resolution stand-in a catalog request keyed on. */
  tierId: string;
  durationSeconds: number;
  /**
   * Every source image SHA, in order, plus any preset voice ids.
   *
   * ORDER MATTERS and is not sorted: two reference sets with the same images in
   * a different order are two different renders to the provider, so they must be
   * two different refs. Folding them together would refuse the second as a
   * replay of the first.
   */
  sourceSha256?: readonly string[];
  presetVoiceIds?: readonly string[];
};

/**
 * The credit-ledger idempotency key for a video debit: content-derived from
 * tenant + prompt + resolved model + tier + duration + image SHA, deliberately WITHOUT the
 * per-call request id (the desktop mints a fresh uuid every attempt, so a
 * request-id-keyed ref could never replay-protect a retry — the same defect
 * e45379a5 fixed for the daily-cap fingerprint).
 *
 * Namespaced ("command-eve-video-debit-v2") and computed independently from
 * the daily-cap usage fingerprint below: they key two different idempotency
 * domains (credit_transactions.external_ref vs the usage receipts table), and
 * must never be assumed interchangeable even though today they hash the same
 * inputs.
 */
export function videoDebitExternalRef(input: VideoDebitExternalRefInput): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        'command-eve-video-debit-v2',
        input.tenantId,
        input.promptSha256,
        input.model,
        input.tierId,
        String(input.durationSeconds),
        (input.sourceSha256 ?? []).join(','),
        (input.presetVoiceIds ?? []).join(','),
      ].join('\n'),
      'utf8'
    )
    .digest('hex');
}

/**
 * The xAI video API takes an input image as `image: { url }`, where `url` is a
 * public URL or a base64 DATA url — not a bare base64 string, which is what this
 * lane used to send under the non-existent field `image_base64`.
 *
 * Building that data url needs a media type, and nothing upstream carries one:
 * the desktop hands over raw bytes and the gateway only ever saw base64. So the
 * type is derived from the bytes themselves, and ONLY for the three formats the
 * endpoint documents (JPEG, PNG, WebP). An undetectable image returns null and
 * the caller refuses — guessing `image/png` would send a mislabelled asset to a
 * paid endpoint and make the provider's complaint unreadable.
 */
export function xaiImageDataUrlFromBase64(imageBase64: string): string | null {
  // 16 base64 chars decode to 12 bytes, which is all any of these signatures needs.
  const head = imageBase64.slice(0, 16);
  if (head.length < 16) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(head);
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
  const mediaType = xaiImageMediaType(bytes);
  return mediaType === null ? null : `data:${mediaType};base64,${imageBase64}`;
}

// ---------------------------------------------------------------------------
// Video EDIT (`POST /v1/videos/edits`) — MAT-1747, first slice of MAT-1748
// ---------------------------------------------------------------------------
//
// Editing is a different contract from generation, not a flag on it:
//
//   - the source carries the duration AND the aspect ratio, so neither may be
//     sent; the provider preserves them.
//   - the output resolution equals the source resolution, capped at 720p, so
//     the caller does not choose a resolution either.
//   - the source may be at most 8.7 seconds.
//
// Hermes 0.19.0 encodes exactly this in `tools/xai_video_tools.py` /
// `plugins/video_gen/xai/__init__.py`: its edit payload is `{model, prompt,
// video}` and it appends `duration` ONLY on the `extensions` endpoint. We match
// that shape rather than invent one, so a later bundled 0.19.0 can call this
// lane without a translation layer.

/** xAI's documented ceiling for an edit source. Longer sources are refused. */
export const MAX_VIDEO_EDIT_SOURCE_SECONDS = 8.7;

/** Video input is billed per source-second on TOP of the generated output. */
export const VIDEO_EDIT_INPUT_USD_PER_SECOND = 0.01;
export const VIDEO_EDIT_INPUT_CREDITS_PER_SECOND = deriveVideoCreditsPerSecond(VIDEO_EDIT_INPUT_USD_PER_SECOND);

/**
 * Tiers an edit can actually produce. `hd` is 1080p on grok-imagine-video-1.5;
 * the edit endpoint caps output at 720p, so a 1080p edit is not a price
 * question but an impossibility. Refuse it by name instead of downgrading —
 * the same rule the generation lane already applies to 1080p text prompts.
 */
export const VIDEO_EDIT_ELIGIBLE_TIERS: readonly VideoQualityTier[] = Object.freeze(
  VIDEO_TIERS.filter((tier) => tier.resolution !== '1080p').map((tier) => tier.id)
);

export function isVideoEditEligibleTier(tierId: VideoQualityTier): boolean {
  return VIDEO_EDIT_ELIGIBLE_TIERS.includes(tierId);
}

export type EveMultimodalVideoEditInput = {
  prompt: string;
  /** The tier the SOURCE was produced at — inherited, never chosen for an edit. */
  tierId: VideoQualityTier;
  sourceBase64: string;
  sourceSha256: string;
  sourceDurationSeconds: number;
};

const MAX_VIDEO_SOURCE_BASE64_CHARS = 40_000_000; // ~30 MB of MP4

/**
 * Parse and BOUND an edit request. Same posture as the generation parser: a
 * half-understood body is a 400, never a forwarded paid call.
 *
 * The 8.7-second refusal lives HERE, in the pure layer, so it is provably
 * reachable before the debit — a length check that ran after the charge would
 * bill the user for a rejection.
 */
export function extractEveMultimodalVideoEditInput(body: unknown): EveMultimodalVideoEditInput | null {
  if (!isRecord(body)) return null;
  const raw = isRecord(body.video_edit) ? body.video_edit : null;
  if (!raw) return null;

  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (prompt.length === 0 || prompt.length > MAX_VIDEO_PROMPT_CHARS) {
    return null;
  }

  const tierId = raw.tier;
  if (tierId !== 'sd' && tierId !== 'fast' && tierId !== 'hd') return null;
  if (!isVideoEditEligibleTier(tierId)) return null;

  const sourceBase64 = typeof raw.source_base64 === 'string' ? raw.source_base64 : '';
  if (sourceBase64.length === 0 || sourceBase64.length > MAX_VIDEO_SOURCE_BASE64_CHARS) return null;

  if (typeof raw.source_sha256 !== 'string' || raw.source_sha256.length !== 64) return null;

  const durationRaw = raw.source_duration_seconds;
  if (typeof durationRaw !== 'number' || !Number.isFinite(durationRaw)) {
    return null;
  }
  // NOT ceil()'d. 8.7 is a real boundary with one decimal; rounding a 8.4s
  // source up to 9 would refuse a clip the provider accepts, and rounding a
  // 8.9s source down to 8 would forward one it rejects — after we charged.
  if (durationRaw <= 0 || durationRaw > MAX_VIDEO_EDIT_SOURCE_SECONDS) return null;

  return {
    prompt,
    tierId,
    sourceBase64,
    sourceSha256: raw.source_sha256,
    sourceDurationSeconds: durationRaw,
  };
}

/**
 * Edit price = source seconds as INPUT + the same seconds as OUTPUT.
 *
 * The output length equals the source length because the provider preserves
 * duration, so both terms use the same seconds. Charging only the output — the
 * shape the generation lane uses — would silently under-bill every edit.
 *
 * Ceil ONCE at the end, on the combined figure: two separate ceils would round
 * twice and drift upward against the user.
 */
export function estimateVideoEditCredits(tierId: VideoQualityTier, sourceDurationSeconds: number): number {
  // The output rate comes from the (model, resolution) matrix through the EDIT
  // mode, not from the tier record — a resolution can be served by two models at
  // two different rates. Editing is capped at 720p and therefore always the base
  // model, so this is the same number it has always been; it now arrives by the
  // route that stays correct.
  const resolved = resolveVideoPlan({
    modeKind: 'edit',
    tierId,
    capabilities: { hd15Available: true },
  });
  // An ineligible tier has no edit output rate at all. Returning 0 would price a
  // free edit; callers gate on `isVideoEditEligibleTier` first, and an infinite
  // estimate keeps the arithmetic honest for the one that forgets.
  if (!resolved.ok) return Number.POSITIVE_INFINITY;
  const perSecond = VIDEO_EDIT_INPUT_CREDITS_PER_SECOND + resolved.plan.creditsPerSecond;
  return Math.ceil(sourceDurationSeconds * perSecond);
}

export type VideoEditDebitExternalRefInput = {
  tenantId: string;
  promptSha256: string;
  tierId: VideoQualityTier;
  sourceSha256: string;
};

/**
 * The credit-ledger idempotency key for an edit debit.
 *
 * Two properties are load-bearing, and they pull in opposite directions:
 *
 * 1. It MUST include the source SHA. Without it, "add a face" applied to two
 *    different clips produces one key, and the second edit is refused as a
 *    replay of the first — the user is told they already did something they
 *    did not do.
 *
 * 2. It MUST NOT include anything that distinguishes HOW the request arrived.
 *    Under the MAT-1748 doctrine the same action reaches this function twice —
 *    once from the cost wall, once as a Hermes tool call. If those two produced
 *    different keys, one approved edit would bill twice. Path-independence is
 *    what makes `commitVideoDebit` return "already" for the second arrival and
 *    stop it before the provider.
 *
 * So: no request id, no channel, no session, no timestamp. Content only.
 */
export function videoEditDebitExternalRef(input: VideoEditDebitExternalRefInput): string {
  return crypto
    .createHash('sha256')
    .update(
      ['command-eve-video-edit-debit-v1', input.tenantId, input.promptSha256, input.tierId, input.sourceSha256].join(
        '\n'
      ),
      'utf8'
    )
    .digest('hex');
}

/**
 * The exact body sent to `/v1/videos/generations`.
 *
 * Kept pure precisely so a test can assert its KEY SET, not just its values.
 * That is what makes "custom audio cannot reach the provider" a STRUCTURAL claim:
 * this function reads nothing but the mode union's own branches, so a field
 * nobody declared has no path into the body — not even if a caller hangs one off
 * the input object.
 */
export function buildXaiVideoGenerationBody(args: {
  model: string;
  prompt: string;
  resolution: string;
  durationSeconds: number;
  mode: VideoRequestMode;
  imageDataUrl?: string | null;
  referenceImageDataUrls?: readonly string[];
}): Record<string, unknown> {
  const mode = args.mode;
  const modeFields: Record<string, unknown> =
    mode.kind === 'image'
      ? args.imageDataUrl
        ? { image: { url: args.imageDataUrl } }
        : {}
      : mode.kind === 'reference'
        ? {
            reference_images: (args.referenceImageDataUrls ?? []).map((url) => ({
              url,
            })),
            // Preset NAMES the provider already holds. Never bytes, never a url,
            // never an upload — there is no branch here that could carry one.
            ...(mode.presetVoiceIds.length === 0 ? {} : { reference_audios: [...mode.presetVoiceIds] }),
          }
        : {};
  return {
    model: args.model,
    prompt: args.prompt,
    resolution: args.resolution,
    // `duration`, not `duration_seconds` — the old name is not a field the API
    // knows, so the clip length silently fell back to the provider default while
    // we billed the length the user picked.
    duration: args.durationSeconds,
    ...modeFields,
  };
}

/**
 * The exact body sent to `/v1/videos/edits`.
 *
 * Kept as a pure function precisely so a test can assert its KEY SET, not just
 * its values. `duration_seconds` instead of `duration` cost this lane weeks of
 * wrongly-billed clip lengths; the defence against the next one is a test that
 * fails when an extra key appears, not care.
 */
export function buildXaiVideoEditBody(args: {
  model: string;
  prompt: string;
  sourceDataUrl: string;
}): Record<string, unknown> {
  return {
    model: args.model,
    prompt: args.prompt,
    // `video: { url }`, mirroring `_video_input_from_public_url` upstream: the
    // url may be a public link OR a data uri. There is no separate base64
    // field — an earlier note of mine claimed there was, and it was wrong.
    video: { url: args.sourceDataUrl },
    // Deliberately absent: `duration` (source-owned, and upstream sends it only
    // on /extensions) and `resolution` (source-owned, capped at 720p).
  };
}

/** Same refuse-rather-than-mislabel rule as the image path, for MP4 sources. */
export function xaiVideoDataUrlFromBase64(sourceBase64: string): string | null {
  const head = sourceBase64.slice(0, 24);
  if (head.length < 24) return null;
  let bytes: Uint8Array;
  try {
    const binary = atob(head);
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
  const mediaType = xaiVideoMediaType(bytes);
  return mediaType === null ? null : `data:${mediaType};base64,${sourceBase64}`;
}

/**
 * Magic-number sniff for the container the edit endpoint documents (MP4).
 *
 * An ISO-BMFF file starts with a 4-byte box length then the literal `ftyp` at
 * offset 4 — the leading bytes are a length, not a signature, so only offsets
 * 4..7 are checked.
 */
export function xaiVideoMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return 'video/mp4';
  }
  return null;
}

/** Magic-number sniff, limited to the formats the video endpoint accepts. */
export function xaiImageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}
