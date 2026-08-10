// The PINNED, server-owned OpenRouter VIDEO model catalog (MAT-1773/F8).
//
// F8 supersedes the F6-era assumption that OpenRouter carries no video
// models. It does — verified 2026-08-05 against the official catalog
// endpoint `GET /api/v1/videos/models` on the gateway host (21 models) and
// the official video-generation guide (docs/guides/overview/multimodal/
// video-generation on the same host). OpenRouter becomes the single gateway
// for video; the xAI direct lane stays as the flag-gated fallback for
// already-shipped 1.820.4 clients. (The host literal is deliberately not
// repeated in this file: the metering gate allows provider hosts to be named
// only in the registry.)
//
// ONE FROZEN SNAPSHOT, NOT A LIVE FETCH. The catalog below is the 2026-08-05
// response of /videos/models, trimmed to the fields the money path and the
// capabilities quote read. A runtime fetch of the price list would make the
// quote, the reserve bound and the charged price drift whenever the upstream
// page changes; a dated snapshot makes every figure re-derivable and every
// repricing a deliberate, dated edit — the same doctrine as
// IMAGE_MODEL_REGISTRY and VIDEO_MODEL_USD_PER_SECOND.
//
// SKU KEYS ARE HETEROGENEOUS UPSTREAM, and that is a measured fact, not a
// complaint: the 2026-08-05 catalog prices per-second output under FOUR
// different key families (`cents_per_video_output_second_{res}`,
// `cents_per_second_output[{_res}]`, `duration_seconds*[{_res}]` in USD,
// `text|image_to_video_duration_seconds_{res}` in USD) plus a per-TOKEN
// family (`video_tokens`) that cannot be converted to a per-second bound
// without a tokens-per-second figure the catalog does not publish. The
// resolver below reads the families in a declared priority order; a model
// whose only price is per-token resolves to null and is EXCLUDED from the
// priceable catalog rather than guessed. Under-charging is the one direction
// this file must never take.
//
// CREDITS DERIVATION ROUNDS UP. Sub-cent USD prices exist upstream
// (0.0988/s), and `deriveVideoCreditsPerSecond`'s Math.round can round DOWN
// (0.084 -> 8 cents). The bound here uses Math.ceil on the USD-cent figure
// instead, so the reserve can never under-hold against the list price.

import {
  getVideoTier,
  VIDEO_CREDITS_PER_EUR_CENT,
  VIDEO_MARKUP_FACTOR,
  type VideoModelId,
  type VideoQualityTier,
  type VideoRequestMode,
} from './video-generation-core.ts';

/** Date of the catalog snapshot this module pins. Bump on every refresh. */
export const OPENROUTER_VIDEO_CATALOG_VERSION = '2026-08-05';

/** The catalog PATH this snapshot was taken from (GET on the gateway host —
 * the host literal itself may appear only in the registry, so it is not
 * repeated here). Never fetched at runtime. */
export const OPENROUTER_VIDEO_CATALOG_SOURCE = '/api/v1/videos/models';

export type OpenRouterVideoCatalogEntry = {
  /** The OpenRouter model slug sent as `model` in the submit body. */
  readonly id: string;
  /** The catalog's own display name. */
  readonly displayName: string;
  /** null when the catalog publishes no resolution list (e.g. runway/aleph-2). */
  readonly supportedResolutions: readonly string[] | null;
  /** null when the catalog publishes no duration list. */
  readonly supportedDurations: readonly number[] | null;
  readonly supportedAspectRatios: readonly string[] | null;
  /** The catalog's raw pricing_skus, verbatim — provenance for the resolver. */
  readonly pricingSkus: Readonly<Record<string, string>>;
};

/**
 * THE 2026-08-05 SNAPSHOT of GET /api/v1/videos/models — 21 models, in the
 * endpoint's own order, trimmed to id/name/resolutions/durations/aspect-ratios/
 * pricing_skus. Any refresh replaces this block wholesale and bumps
 * OPENROUTER_VIDEO_CATALOG_VERSION.
 */
export const OPENROUTER_VIDEO_CATALOG: readonly OpenRouterVideoCatalogEntry[] = Object.freeze([
  {
    id: 'black-forest-labs/flux-3-video',
    displayName: 'Black Forest Labs: FLUX.3 Video',
    supportedResolutions: ['720p', '1080p'],
    supportedDurations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    supportedAspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    pricingSkus: {
      cents_per_second_output: '17',
      cents_per_second_output_720p: '17',
      cents_per_second_output_1080p: '29',
      cents_per_second_video_continuation_720p: '41',
      cents_per_second_video_continuation_1080p: '53',
    },
  },
  {
    id: 'minimax/hailuo-3',
    displayName: 'MiniMax: H3',
    supportedResolutions: ['2K'],
    supportedDurations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    pricingSkus: {
      duration_seconds: '0.13',
      reference_images: '0.04',
    },
  },
  {
    id: 'runway/aleph-2',
    displayName: 'Runway: Aleph 2.0',
    supportedResolutions: null,
    supportedDurations: null,
    supportedAspectRatios: ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9'],
    pricingSkus: {
      cents_per_second_output: '28',
      minimum_cents_per_generation: '56',
    },
  },
  {
    id: 'runway/gen-4.5',
    displayName: 'Runway: Gen-4.5',
    supportedResolutions: ['720p'],
    supportedDurations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    supportedAspectRatios: ['16:9', '9:16'],
    pricingSkus: {
      cents_per_second_output: '12',
    },
  },
  {
    id: 'x-ai/grok-imagine-video-1.5',
    displayName: 'SpaceXAI: Grok Imagine Video 1.5',
    supportedResolutions: ['480p', '720p', '1080p'],
    supportedDurations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
    pricingSkus: {
      cents_per_image_input: '1',
      cents_per_video_output_second_480p: '8',
      cents_per_video_output_second_720p: '14',
      cents_per_video_output_second_1080p: '25',
    },
  },
  {
    id: 'alibaba/happyhorse-1.1',
    displayName: 'Alibaba: HappyHorse 1.1',
    supportedResolutions: ['720p', '1080p'],
    supportedDurations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', '9:21'],
    pricingSkus: {
      duration_seconds_720p: '0.0988',
      duration_seconds_1080p: '0.1278',
    },
  },
  {
    id: 'alibaba/happyhorse-1.0',
    displayName: 'Alibaba: HappyHorse 1.0',
    supportedResolutions: ['720p', '1080p'],
    supportedDurations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9', '9:21'],
    pricingSkus: {
      duration_seconds_720p: '0.0988',
      duration_seconds_1080p: '0.1694',
    },
  },
  {
    id: 'x-ai/grok-imagine-video',
    displayName: 'SpaceXAI: Grok Imagine Video',
    supportedResolutions: ['480p', '720p'],
    supportedDurations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
    pricingSkus: {
      cents_per_image_input: '0.2',
      cents_per_video_output_second_480p: '5',
      cents_per_video_output_second_720p: '7',
    },
  },
  {
    id: 'kwaivgi/kling-v3.0-pro',
    displayName: 'Kling: Video v3.0 Pro',
    supportedResolutions: ['720p'],
    supportedDurations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['16:9', '9:16', '1:1'],
    pricingSkus: {
      duration_seconds: '0.112',
      duration_seconds_with_audio: '0.168',
      text_to_video_duration_seconds_480p: '0.112',
      text_to_video_duration_seconds_720p: '0.112',
      image_to_video_duration_seconds_720p: '0.112',
      text_to_video_duration_seconds_1080p: '0.112',
      image_to_video_duration_seconds_1080p: '0.112',
    },
  },
  {
    id: 'kwaivgi/kling-v3.0-std',
    displayName: 'Kling: Video v3.0 Standard',
    supportedResolutions: ['720p'],
    supportedDurations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['16:9', '9:16', '1:1'],
    pricingSkus: {
      duration_seconds: '0.084',
      duration_seconds_with_audio: '0.126',
      text_to_video_duration_seconds_480p: '0.084',
      text_to_video_duration_seconds_720p: '0.084',
      image_to_video_duration_seconds_720p: '0.084',
      text_to_video_duration_seconds_1080p: '0.084',
      image_to_video_duration_seconds_1080p: '0.084',
    },
  },
  {
    id: 'google/veo-3.1-fast',
    displayName: 'Google: Veo 3.1 Fast',
    supportedResolutions: ['720p', '1080p', '4K'],
    supportedDurations: [4, 6, 8],
    supportedAspectRatios: ['16:9', '9:16'],
    pricingSkus: {
      duration_seconds_with_audio: '0.12',
      duration_seconds_with_audio_4k: '0.30',
      duration_seconds_without_audio: '0.10',
      duration_seconds_with_audio_720p: '0.10',
      duration_seconds_without_audio_4k: '0.25',
      duration_seconds_without_audio_720p: '0.08',
    },
  },
  {
    id: 'google/veo-3.1-lite',
    displayName: 'Google: Veo 3.1 Lite',
    supportedResolutions: ['720p', '1080p'],
    supportedDurations: [8, 4, 6],
    supportedAspectRatios: ['16:9', '9:16'],
    pricingSkus: {
      duration_seconds_with_audio: '0.08',
      duration_seconds_without_audio: '0.05',
      duration_seconds_with_audio_720p: '0.05',
      duration_seconds_without_audio_720p: '0.03',
    },
  },
  {
    id: 'kwaivgi/kling-video-o1',
    displayName: 'Kling: Video O1',
    supportedResolutions: ['720p'],
    supportedDurations: [5, 10],
    supportedAspectRatios: ['16:9', '9:16', '1:1'],
    pricingSkus: {
      duration_seconds: '0.1120',
    },
  },
  {
    id: 'minimax/hailuo-2.3',
    displayName: 'MiniMax: Hailuo 2.3',
    supportedResolutions: ['1080p'],
    supportedDurations: [6, 10],
    supportedAspectRatios: ['16:9'],
    pricingSkus: {
      duration_seconds: '0.0817',
    },
  },
  {
    id: 'alibaba/wan-2.7',
    displayName: 'Alibaba: Wan 2.7',
    supportedResolutions: ['720p', '1080p'],
    supportedDurations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    pricingSkus: {
      duration_seconds: '0.1',
    },
  },
  {
    id: 'bytedance/seedance-2.0',
    displayName: 'ByteDance: Seedance 2.0',
    supportedResolutions: ['480p', '720p', '1080p', '4K'],
    supportedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'],
    pricingSkus: {
      video_tokens: '0.000007',
      video_tokens_without_audio: '0.000007',
    },
  },
  {
    id: 'bytedance/seedance-2.0-fast',
    displayName: 'ByteDance: Seedance 2.0 Fast',
    supportedResolutions: ['480p', '720p'],
    supportedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    supportedAspectRatios: ['1:1', '3:4', '9:16', '4:3', '16:9', '21:9', '9:21'],
    pricingSkus: {
      video_tokens: '0.0000056',
      video_tokens_without_audio: '0.0000056',
    },
  },
  {
    id: 'alibaba/wan-2.6',
    displayName: 'Alibaba: Wan 2.6',
    supportedResolutions: ['720p', '1080p'],
    supportedDurations: [5, 10],
    supportedAspectRatios: ['16:9', '9:16'],
    pricingSkus: {
      text_to_video_duration_seconds_480p: '0.04',
      text_to_video_duration_seconds_720p: '0.08',
      image_to_video_duration_seconds_720p: '0.10',
      text_to_video_duration_seconds_1080p: '0.12',
      image_to_video_duration_seconds_1080p: '0.15',
    },
  },
  {
    id: 'bytedance/seedance-1-5-pro',
    displayName: 'ByteDance: Seedance 1.5 Pro',
    supportedResolutions: ['480p', '720p', '1080p'],
    supportedDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    supportedAspectRatios: ['1:1', '3:4', '9:16', '9:21', '4:3', '21:9', '16:9', '21:9'],
    pricingSkus: {
      video_tokens: '0.0000024',
      video_tokens_without_audio: '0.0000012',
    },
  },
  {
    id: 'openai/sora-2-pro',
    displayName: 'OpenAI: Sora 2 Pro',
    supportedResolutions: ['720p', '1080p'],
    supportedDurations: [4, 8, 12, 16, 20],
    supportedAspectRatios: ['16:9', '9:16'],
    pricingSkus: {
      duration_seconds_720p: '0.30',
      duration_seconds_1024p: '0.50',
      duration_seconds_1080p: '0.50',
    },
  },
  {
    id: 'google/veo-3.1',
    displayName: 'Google: Veo 3.1',
    supportedResolutions: ['720p', '1080p', '4K'],
    supportedDurations: [4, 6, 8],
    supportedAspectRatios: ['16:9', '9:16'],
    pricingSkus: {
      duration_seconds_with_audio: '0.40',
      duration_seconds_with_audio_4k: '0.60',
      duration_seconds_without_audio: '0.20',
      duration_seconds_without_audio_4k: '0.40',
    },
  },
] as const);

export function openRouterVideoCatalogEntry(id: string): OpenRouterVideoCatalogEntry | null {
  return OPENROUTER_VIDEO_CATALOG.find((entry) => entry.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// THE CATALOG-MODEL REQUEST SPEC (F8, 1.820.5)
// ---------------------------------------------------------------------------

export type CatalogVideoSpecRefusal =
  /** The entry HAS a resolution list and the request named none. */
  | 'video-resolution-required'
  /** The named (or tier-mapped) resolution is not in the entry's list. */
  | 'video-resolution-unavailable'
  /** The duration is not a member of the entry's supported_durations. */
  | 'video-duration-unavailable';

/**
 * Validate a catalog-model request against ITS catalog entry — resolution
 * and duration are entry facts, not global constants.
 *
 * RESOLUTION. A free-form `resolution` wins over a tier (the client named it
 * explicitly); a tier maps 480p/720p/1080p exactly as the legacy contract
 * resolves it. The result must be an EXACT member of the entry's
 * supported_resolutions. An entry with a null list (runway/aleph-2) accepts
 * whatever the client named — including nothing, which then omits the field
 * from the submit body and lets the provider default decide. An entry WITH a
 * list and no resolution named is refused: guessing "720p" would bill one
 * render and produce another, which is the silent-downgrade defect the
 * capability doctrine exists to prevent.
 *
 * DURATION. Must be a member of the entry's supported_durations when that
 * list exists (veo-3.1 renders 4/6/8s and nothing else); a null list means
 * the provider's own bounds, already hard-capped at the parser.
 */
export function resolveCatalogVideoSpec(args: {
  entry: OpenRouterVideoCatalogEntry;
  tierId?: VideoQualityTier;
  resolution?: string;
  durationSeconds: number;
}):
  | { ok: true; resolution: string | null; durationSeconds: number }
  | {
      ok: false;
      reason: CatalogVideoSpecRefusal;
    } {
  const fromTier = args.tierId === undefined ? null : getVideoTier(args.tierId).resolution;
  const requested = args.resolution ?? fromTier;
  let resolution: string | null = null;
  if (requested !== null) {
    if (args.entry.supportedResolutions !== null && !args.entry.supportedResolutions.includes(requested)) {
      return { ok: false, reason: 'video-resolution-unavailable' };
    }
    resolution = requested;
  } else if (args.entry.supportedResolutions !== null) {
    return { ok: false, reason: 'video-resolution-required' };
  }
  if (args.entry.supportedDurations !== null && !args.entry.supportedDurations.includes(args.durationSeconds)) {
    return { ok: false, reason: 'video-duration-unavailable' };
  }
  return { ok: true, resolution, durationSeconds: args.durationSeconds };
}

/**
 * The xAI-direct model id -> the OpenRouter slug serving the same model. This
 * is what lets a 1.820.4 client (which speaks the xAI-shaped contract) be
 * routed over OpenRouter with NO client change.
 */
export function openRouterSlugForXaiModel(model: VideoModelId): string {
  return model === 'grok-imagine-video-1.5' ? 'x-ai/grok-imagine-video-1.5' : 'x-ai/grok-imagine-video';
}

function skuNumber(skus: Readonly<Record<string, string>>, key: string): number | null {
  const raw = skus[key];
  if (typeof raw !== 'string') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * THE PROVIDER'S USD LIST PRICE PER GENERATED SECOND, read out of the raw
 * pricing_skus with a DECLARED priority order. `resolution` is lowercased
 * before use ("4K" prices live under `_4k` keys); pass null for a model with
 * no resolution list. `mode` chooses between the text_to_video and
 * image_to_video SKU families where a model prices them differently
 * (wan-2.6 does); reference mode counts as image-side (input_references).
 *
 * Returns null when no per-second price is derivable — per-token SKUs
 * (seedance) land here, and null means UNOFFERABLE, never "estimate low".
 */
export function openRouterVideoUsdPerSecond(args: {
  entry: OpenRouterVideoCatalogEntry;
  resolution: string | null;
  mode: 'text' | 'image';
}): number | null {
  const skus = args.entry.pricingSkus;
  const res = args.resolution === null ? null : args.resolution.toLowerCase();
  const modePrefix = args.mode === 'image' ? 'image' : 'text';

  if (res !== null) {
    const centsKeys = [`cents_per_video_output_second_${res}`, `cents_per_second_output_${res}`];
    for (const key of centsKeys) {
      const cents = skuNumber(skus, key);
      if (cents !== null) return cents / 100;
    }
    const usdKeys = [
      `duration_seconds_with_audio_${res}`,
      `duration_seconds_${res}`,
      `${modePrefix}_to_video_duration_seconds_${res}`,
      // The OTHER mode's key is a better bound than a flat fallback when the
      // requested mode's own key is absent: both are per-second list prices
      // for this resolution, and taking the one that exists beats taking none.
      `${args.mode === 'image' ? 'text' : 'image'}_to_video_duration_seconds_${res}`,
    ];
    for (const key of usdKeys) {
      const usd = skuNumber(skus, key);
      if (usd !== null) return usd;
    }
  }
  const flatCents = skuNumber(skus, 'cents_per_second_output');
  if (flatCents !== null) return flatCents / 100;
  // Audio defaults to ON upstream (generate_audio defaults true), so the
  // with-audio rate is the one a default request is billed at.
  const withAudio = skuNumber(skus, 'duration_seconds_with_audio');
  if (withAudio !== null) return withAudio;
  const flat = skuNumber(skus, 'duration_seconds');
  if (flat !== null) return flat;
  return null;
}

/**
 * Retail credits per generated second, derived from the USD list price with
 * the video lane's own factors (2x markup, 10 credits per EUR cent, USD cents
 * treated 1:1 as EUR cents — see deriveVideoCreditsPerSecond for that
 * doctrine). THE DIFFERENCE IS THE ROUNDING: Math.ceil on the USD-cent
 * figure, because sub-cent list prices exist upstream (0.0988/s) and
 * Math.round would round 0.084 DOWN to 8 cents — an under-held reserve,
 * which is the one direction the money path must never take.
 */
export function deriveOpenRouterVideoCreditsPerSecond(usdPerSecond: number): number {
  // Round to 1/100 of a cent FIRST: 0.14 * 100 is 14.000000000000002 in
  // IEEE-754, and a bare ceil() would turn 14 cents into 15 — the same float
  // trap deriveVideoCreditsPerSecond documents, one rung up. Catalog prices
  // carry at most four decimal places, so rounding there loses nothing.
  const rawCents = Math.ceil(Math.round(usdPerSecond * 10000) / 100);
  return rawCents * VIDEO_MARKUP_FACTOR * VIDEO_CREDITS_PER_EUR_CENT;
}

/**
 * The reserve-bound estimate for one catalog render, in credits. null when
 * the (model, resolution, mode) has no derivable per-second price — the
 * caller must refuse or fall back, never reserve a guessed bound.
 */
export function estimateOpenRouterVideoCredits(args: {
  entry: OpenRouterVideoCatalogEntry;
  resolution: string | null;
  mode: 'text' | 'image';
  durationSeconds: number;
}): number | null {
  const usdPerSecond = openRouterVideoUsdPerSecond(args);
  if (usdPerSecond === null) return null;
  return args.durationSeconds * deriveOpenRouterVideoCreditsPerSecond(usdPerSecond);
}

/**
 * The exact body sent to `POST /api/v1/videos`, per the official guide
 * (2026-08-05): `model`, `prompt` required; `duration` (integer seconds) and
 * `resolution` optional; image->video rides `frame_images` with a
 * `frame_type`, reference->video rides `input_references`; both carry
 * `{type:"image_url", image_url:{url}}` entries, and a data url is a valid
 * image_url the same way it is on the xAI lane.
 *
 * Pure precisely so a test asserts the KEY SET: a field nobody declared has
 * no path into the body — the same defence buildXaiVideoGenerationBody
 * carries.
 */
export function buildOpenRouterVideoBody(args: {
  model: string;
  prompt: string;
  durationSeconds: number;
  /** Omitted when the entry's contract has no resolution list (aleph-2). */
  resolution?: string | null;
  mode: VideoRequestMode;
  imageDataUrl?: string | null;
  referenceImageDataUrls?: readonly string[];
}): Record<string, unknown> {
  const mode = args.mode;
  const modeFields: Record<string, unknown> =
    mode.kind === 'image'
      ? args.imageDataUrl
        ? {
            frame_images: [
              {
                type: 'image_url',
                image_url: { url: args.imageDataUrl },
                frame_type: 'first_frame',
              },
            ],
          }
        : {}
      : mode.kind === 'reference'
        ? {
            input_references: (args.referenceImageDataUrls ?? []).map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          }
        : {};
  return {
    model: args.model,
    prompt: args.prompt,
    duration: args.durationSeconds,
    ...(args.resolution === null || args.resolution === undefined ? {} : { resolution: args.resolution }),
    ...modeFields,
  };
}

/**
 * The capabilities/quote wire contract version. This string, not the
 * snapshot date, is what the client pins against.
 */
export const OPENROUTER_VIDEO_CAPABILITIES_VERSION = 'command-eve-video-model-catalog/v1';

/**
 * The serializable catalog view for the client dropdown — the answer to
 * "which video models may I offer, and what does a second cost" BEFORE the
 * user hits send. Derived from the snapshot at call time, never a second
 * literal, so the UI can never quote a price the server would not charge.
 *
 * ONLY PRICEABLE MODELS ARE LISTED. Token-priced models (seedance, today)
 * have no derivable per-second bound; they appear under `unpriceable` with
 * the reason, rather than with an invented number.
 */
export function publicOpenRouterVideoCapabilities(args: { enabled: boolean }): {
  version: string;
  enabled: boolean;
  gateway: 'openrouter';
  catalog_snapshot: string;
  models: readonly {
    id: string;
    display_name: string;
    resolutions: readonly string[] | null;
    durations: readonly number[] | null;
    aspect_ratios: readonly string[] | null;
    usd_per_second: Record<string, number>;
    credits_per_second: Record<string, number>;
  }[];
  unpriceable: readonly { id: string; reason: string }[];
} {
  const models = [];
  const unpriceable = [];
  for (const entry of OPENROUTER_VIDEO_CATALOG) {
    const resolutions = entry.supportedResolutions ?? [null];
    const usdPerSecond: Record<string, number> = {};
    const creditsPerSecond: Record<string, number> = {};
    let priceable = true;
    for (const resolution of resolutions) {
      // The capabilities quote is the TEXT-to-video rate; image-side SKUs
      // differ on exactly one catalog model (wan-2.6) and are a submit-time
      // concern of the reserve path, not of the dropdown.
      const usd = openRouterVideoUsdPerSecond({
        entry,
        resolution,
        mode: 'text',
      });
      if (usd === null) {
        priceable = false;
        break;
      }
      const key = resolution ?? 'default';
      usdPerSecond[key] = usd;
      creditsPerSecond[key] = deriveOpenRouterVideoCreditsPerSecond(usd);
    }
    if (!priceable) {
      unpriceable.push({
        id: entry.id,
        reason: 'token-priced upstream; no per-second bound derivable',
      });
      continue;
    }
    models.push({
      id: entry.id,
      display_name: entry.displayName,
      resolutions: entry.supportedResolutions,
      durations: entry.supportedDurations,
      aspect_ratios: entry.supportedAspectRatios,
      usd_per_second: usdPerSecond,
      credits_per_second: creditsPerSecond,
    });
  }
  return {
    version: OPENROUTER_VIDEO_CAPABILITIES_VERSION,
    enabled: args.enabled,
    gateway: 'openrouter',
    catalog_snapshot: OPENROUTER_VIDEO_CATALOG_VERSION,
    models,
    unpriceable,
  };
}
