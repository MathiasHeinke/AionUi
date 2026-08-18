// The PINNED, server-owned image-model registry (MAT-1769).
//
// One frozen table is the ONLY place a client-facing image tier becomes a
// provider slug, a price and a provider routing. The parser, the debit bound,
// the provider body and the capabilities quote all read through
// `resolveImageGenerationModel`, so the model a request reaches and the number
// it is quoted/charged cannot disagree — the same doctrine as
// VIDEO_MODEL_USD_PER_SECOND, where an absent entry is a capability statement.
//
// THE CLIENT SENDS A TIER ID, NEVER A RAW SLUG. A slug the client could name
// would be a slug the registry never priced; an unknown tier therefore fails
// CLOSED at the parse, before any debit.
//
// DEFAULT (MAT-1769): `quality` — google/gemini-3.1-flash-image ("Nano
// Banana 2"). This deliberately REPLACES the previous shipped default
// google/gemini-3-pro-image, which is not in this registry: the registry holds
// exactly three entries and there is no legacy mapping, because a fourth entry
// priced by nobody is precisely the defect this module exists to prevent. The
// EVE_MULTIMODAL_OPENROUTER_IMAGE_GENERATION_MODEL env override is gone for the
// same reason — an env string that can name an unpriced slug makes the price
// and the model disagree, which is the video-lane lesson (MAT-1753) applied to
// images.
//
// MARKUP: "standard" (10x), NOT the video lane's explicit 2x. The choice is
// forced, not aesthetic: settlement for this operation runs through
// `actualEurCentsFor` with the BILLABLE_OPERATIONS row for
// `multimodal.image_generation`, whose markupTier is "standard", so a
// provider-reported cost is retailed at 10x. A reserve bound or a quote
// derived at any other factor would disagree with the charge the settle path
// computes. Video can carry its own 2x because it settles exact-equals-bound
// against its own plan; this lane does not.
//
// FX: USD_TO_EUR_SEED (0.92), the same constant the settle path applies to a
// provider-reported cost. The TTS lane carries its own dated ECB record
// because its list price IS the charge; here the list price feeds only the
// pre-call bound and the quote, and using the lane's own conversion is what
// keeps quote, reserve and settle on one rate.
//
// PRICE PROVENANCE, STATED HONESTLY PER ENTRY. `fast` is RESOLUTION-PRICED:
// the OpenRouter images-route endpoint record (rechecked 2026-08-17, CoS
// pricing proof) lists USD 0.05/image at 1K, USD 0.07/image at 2K and +USD
// 0.01 per input image — an earlier revision of this registry pinned a FLAT
// USD 0.05, which
// under-held the 2K case by 40%; an under-bound reserve is the one direction
// that can under-charge, so the record is per-resolution now. `quality` and
// `max` are TOKEN-priced upstream (no per-image list price exists): quality's
// OpenRouter /models listing (2026-08-03) shows image-output at USD 60/1M
// tokens, so the flat USD 0.15 bound is labeled by what it covers — up to
// 2,500 image-output tokens per image; max carries no public rate this repo
// could verify, so its USD 0.25 bound is labeled an UNPROVEN CONSERVATIVE
// CAP. Both stay conservative on purpose: settleBillableOperation clamps the
// exact charge at the reserved bound, so a HIGH bound costs the customer
// nothing after settle and a LOW one is capped — never an unbilled artifact.

import { type PricedAmount, USD_TO_EUR_SEED } from '../_shared/billable-operations.ts';
import { CREDITS_PER_EUR_CENT, TIER_MARKUP_FACTOR } from '../_shared/credits-core.ts';

export type ImageModelTierId = 'fast' | 'quality' | 'max';
export type ImageGenerationResolution = '1K' | '2K';

/** The registry-wide date stamp, bumped like every other pricing record. */
export const IMAGE_MODEL_REGISTRY_VERSION = '2026-08-17';

/**
 * The markup tier this lane's settlement applies. Pinned to the
 * BILLABLE_OPERATIONS row for `multimodal.image_generation`; a test asserts
 * the two cannot drift apart.
 */
export const IMAGE_MARKUP_TIER = 'standard';

/**
 * A versioned per-image USD list price with its provenance — the
 * UsdToEurPriceRecord posture (every input reviewable, every grade stated)
 * at the granularity an image is billed by.
 */
export type ImageModelPriceRecord = {
  /** Effective date of THIS price pin. */
  readonly version: string;
  /**
   * The provider's USD list price per generated image BY RESOLUTION. `fast`
   * is genuinely resolution-priced upstream; `quality`/`max` are token-priced
   * upstream and carry a conservative per-image bound at each resolution
   * (rationale in the entry's providerPriceSource).
   */
  readonly providerUsdPerImage: Readonly<Record<ImageGenerationResolution, number>>;
  /**
   * The provider's USD price per INPUT (reference/edit) image, when upstream
   * publishes one. It is added once per accepted reference to the reserve,
   * quote and registry fallback actual; absent means this registry has no
   * separately published reference surcharge for that tier.
   */
  readonly providerUsdPerInputReference?: number;
  readonly providerPriceSource: string;
  /**
   * Exactly what the figure is: a verified page recheck, a bound with a
   * stated token rationale, or an unproven conservative cap. Never a
   * fake-precision "official" claim.
   */
  readonly evidenceGrade: string;
};

export type ImageModelRegistryEntry = {
  /** The client-facing tier id. This is the ONLY selector the wire accepts. */
  readonly tierId: ImageModelTierId;
  /** The OpenRouter model slug. Server-owned; the client never sends it. */
  readonly providerSlug: string;
  /** The user-facing product name (display is a client concern). */
  readonly displayName: string;
  readonly price: ImageModelPriceRecord;
  readonly supportedResolutions: readonly ImageGenerationResolution[];
  /**
   * The OpenRouter `provider.only` pin for this model, or null for none. The
   * google slug keeps the ZDR-capable google-vertex/global pin the lane
   * already ships; the x-ai and openai slugs carry NO `only` pin (pinning a
   * vertex route for them would structurally exclude their own providers).
   * `allow_fallbacks: false`, `zdr: true` and `data_collection: "deny"` are
   * NOT per-model — they apply to every tier, unchanged.
   */
  readonly openRouterProviderOnly: readonly string[] | null;
  /**
   * Provider-advertised reference ceiling from the authoritative images route.
   * The request parser applies the lower of this value and its global payload
   * ceiling, so a provider-specific limit is never discovered after debit.
   */
  readonly maxReferenceImages: number;
  /**
   * Whether this model accepts edit/reference image inputs THROUGH THIS LANE.
   * Evidence-based, and fail-closed where there is none: the google image
   * family is proven by the lane's own production traffic (the previous
   * gemini-3-pro-image pin served `input_references` on the same endpoint);
   * The authoritative capability source is the IMAGES-API endpoint record —
   * `/api/v1/images/models/{slug}/endpoints` — NOT the chat record at
   * `/api/v1/models/{slug}/endpoints`. The chat record's
   * `supported_parameters` enumerates chat knobs (seed, max_tokens,
   * temperature, ...) and names `input_references` for NO image model,
   * including the google slug this lane already serves references to in
   * production; reading it would fail-close every tier for the wrong reason.
   *
   * Live recheck 2026-08-17 against the images route, `supported_parameters
   * .input_references`:
   *   openai/gpt-image-2                -> {type: range, min: 0, max: 16}
   *   google/gemini-3.1-flash-image     -> {type: range, min: 0, max: 14}
   *   x-ai/grok-imagine-image-quality   -> {type: range, min: 0, max: 3}
   */
  readonly supportsReferenceImages: boolean;
  readonly isDefault: boolean;
};

export const IMAGE_MODEL_REGISTRY: readonly ImageModelRegistryEntry[] = Object.freeze([
  {
    tierId: 'fast',
    providerSlug: 'x-ai/grok-imagine-image-quality',
    displayName: 'Schnell',
    price: Object.freeze({
      version: IMAGE_MODEL_REGISTRY_VERSION,
      providerUsdPerImage: Object.freeze({ '1K': 0.05, '2K': 0.07 }),
      providerUsdPerInputReference: 0.01,
      providerPriceSource:
        'OpenRouter images-route endpoint recheck 2026-08-17 (CoS pricing proof): USD 0.05/image 1K, USD 0.07/image 2K, +USD 0.01 per input image',
      evidenceGrade: 'verified images-route endpoint recheck 2026-08-17; NOT invoice-validated',
    }),
    supportedResolutions: Object.freeze(['1K', '2K'] as const),
    openRouterProviderOnly: null,
    maxReferenceImages: 3,
    supportsReferenceImages: true,
    isDefault: false,
  },
  {
    tierId: 'quality',
    providerSlug: 'google/gemini-3.1-flash-image',
    displayName: 'Nano Banana 2',
    price: Object.freeze({
      version: IMAGE_MODEL_REGISTRY_VERSION,
      // CONSERVATIVE BOUND with a stated rationale, NOT a list price: the
      // OpenRouter /models listing (2026-08-03) prices this model per token
      // (USD 0.50/M input, USD 3/M output, USD 60/M image-output), so no
      // per-image price exists upstream. USD 0.15/image covers up to 2,500
      // image-output tokens per image at the listed image-output rate.
      providerUsdPerImage: Object.freeze({ '1K': 0.15, '2K': 0.15 }),
      providerPriceSource:
        'OpenRouter /models 2026-08-03: token-priced (0.50/M in, 3/M out, 60/M image-out); USD 0.15 bound covers <= 2,500 image-output tokens/image',
      evidenceGrade: 'conservative bound with stated token rationale; NOT a per-image list price',
    }),
    supportedResolutions: Object.freeze(['1K', '2K'] as const),
    openRouterProviderOnly: Object.freeze(['google-vertex/global'] as const),
    maxReferenceImages: 14,
    supportsReferenceImages: true,
    isDefault: true,
  },
  {
    tierId: 'max',
    providerSlug: 'openai/gpt-image-2',
    displayName: 'GPT Image 2',
    price: Object.freeze({
      version: IMAGE_MODEL_REGISTRY_VERSION,
      // CONSERVATIVE BOUND with a stated rationale, NOT a list price: the
      // OpenRouter live page recheck (2026-08-03, CoS pricing proof) prices
      // this model per token (USD 8/M input and output, USD 30/M
      // image-output, USD 2/M cached input). USD 0.25/image covers up to
      // 8,333 image-output tokens per image at the listed image-output rate.
      providerUsdPerImage: Object.freeze({ '1K': 0.25, '2K': 0.25 }),
      providerPriceSource:
        'OpenRouter live page recheck 2026-08-03 (CoS pricing proof): token-priced (8/M in+out, 30/M image-out, 2/M cached); USD 0.25 bound covers <= 8,333 image-output tokens/image',
      evidenceGrade: 'conservative bound with stated token rationale; NOT a per-image list price',
    }),
    supportedResolutions: Object.freeze(['1K', '2K'] as const),
    openRouterProviderOnly: null,
    maxReferenceImages: 16,
    supportsReferenceImages: true,
    isDefault: false,
  },
] as const);

/**
 * THE ONE tier -> model+price resolution. `undefined` means the client sent
 * no tier and gets the DEFAULT; an unknown string is a hard fail (null), so a
 * typo can never silently bill the default model against a request that named
 * another one.
 */
export function resolveImageGenerationModel(tierId: string | undefined): ImageModelRegistryEntry | null {
  if (tierId === undefined) {
    return IMAGE_MODEL_REGISTRY.find((entry) => entry.isDefault) ?? null;
  }
  return IMAGE_MODEL_REGISTRY.find((entry) => entry.tierId === tierId) ?? null;
}

/**
 * Retail CREDITS per generated image, derived from the price record's own
 * provenance inputs — integer-exact, the same doctrine as
 * deriveVideoCreditsPerSecond ("0.05 * 100 is 5.000000000000001 in IEEE-754").
 *
 * The whole chain is computed in integers: USD cents FIRST, then the FX seed
 * as integer EUR cents per USD cent (92), the standard markup (10) and the
 * credit ratio (10 credits per EUR cent). The factors of 100 cancel exactly,
 * so the result is `usdCents * 92` with no float rounding artefact anywhere —
 * a later ceil() can never invent a credit.
 */
export function deriveImageCreditsPerImage(providerUsdPerImage: number): number {
  const usdCents = Math.round(providerUsdPerImage * 100);
  const fxEurCentsPerUsdCent = Math.round(USD_TO_EUR_SEED * 100);
  const markup = TIER_MARKUP_FACTOR[IMAGE_MARKUP_TIER];
  return (usdCents * fxEurCentsPerUsdCent * markup * CREDITS_PER_EUR_CENT) / 100;
}

function imageModelProviderUsdCents(
  entry: ImageModelRegistryEntry,
  resolution: ImageGenerationResolution,
  referenceCount: number
): number {
  if (!Number.isInteger(referenceCount) || referenceCount < 0) {
    throw new RangeError('imageModelProviderUsdCents: referenceCount must be an integer >= 0');
  }
  const outputUsdCents = Math.round(entry.price.providerUsdPerImage[resolution] * 100);
  const inputReferenceUsdCents = Math.round((entry.price.providerUsdPerInputReference ?? 0) * 100);
  return outputUsdCents + referenceCount * inputReferenceUsdCents;
}

/** The quote/debit schedule for one entry at one resolution, in both denominations. */
export function imageModelCreditsPerImage(
  entry: ImageModelRegistryEntry,
  resolution: ImageGenerationResolution,
  referenceCount = 0
): number {
  return deriveImageCreditsPerImage(imageModelProviderUsdCents(entry, resolution, referenceCount) / 100);
}

export function imageModelRetailEurCentsPerImage(
  entry: ImageModelRegistryEntry,
  resolution: ImageGenerationResolution,
  referenceCount = 0
): number {
  return imageModelCreditsPerImage(entry, resolution, referenceCount) / CREDITS_PER_EUR_CENT;
}

export function imageModelRawEurCentsPerImage(
  entry: ImageModelRegistryEntry,
  resolution: ImageGenerationResolution,
  referenceCount = 0
): number {
  const usdCents = imageModelProviderUsdCents(entry, resolution, referenceCount);
  return (usdCents * Math.round(USD_TO_EUR_SEED * 100)) / 100;
}

/**
 * The fallback ACTUAL for a provider response that omitted `usage.cost`,
 * built from the same versioned record the reserve bound came from: the
 * registry's per-unit price at the request's resolution times the MEASURED
 * returned units (exactly one image — the gateway accepts nothing else).
 * This keeps the per-model price authoritative end to end instead of letting
 * an absent provider figure fall back onto the flat, model-blind
 * BILLABLE_OPERATIONS bound.
 */
export function imageRegistryFallbackActual(
  entry: ImageModelRegistryEntry,
  resolution: ImageGenerationResolution,
  referenceCount = 0
): PricedAmount {
  return {
    ok: true,
    rawEurCents: imageModelRawEurCentsPerImage(entry, resolution, referenceCount),
    retailEurCents: imageModelRetailEurCentsPerImage(entry, resolution, referenceCount),
    basis: `image-registry:${entry.price.version}:${entry.tierId}:${resolution}:${entry.providerSlug}:measured:1:references:${referenceCount}`,
  };
}

/**
 * The capabilities/quote wire contract version. This string, not the registry
 * date stamp, is what the client pins against; the date stamp stays on the
 * price records, where a repricing is the thing being dated.
 */
export const IMAGE_MODEL_CAPABILITIES_VERSION = 'command-eve-image-model-registry/v1';

/**
 * The serializable capabilities/quote view for the client — the answer to
 * "what may I offer, and what will it cost" BEFORE the user hits send. It is
 * derived from the registry at call time, never a second literal, so the UI
 * can never quote a price the server would not charge.
 *
 * THE SHAPE IS A CONTRACT, pinned field-for-field by test because the client
 * renders it verbatim: `id` / `slug` / `display_name` / `premium` /
 * `supports_references` / `resolutions` / `quotes`.
 *
 * THE QUOTES OBJECT IS PER-RESOLUTION BECAUSE THE PRICE IS: `fast` is
 * resolution-priced upstream (its 2K quote differs from its 1K quote), and
 * `quality`/`max` carry their conservative bound at each resolution. EDIT has
 * no separate price record: an edit through this lane is a generation with
 * reference inputs, priced from the same per-resolution record, and that is
 * what edit_credits derives from. REFERENCES: `fast` publishes +USD 0.01 per
 * input image upstream. That surcharge is quoted separately and the reserve
 * multiplies it by the request's validated reference count. `edit_credits`
 * remains the one-output base so the wire does not double-count the first
 * reference; consumers add `per_input_reference_credits` once per reference.
 */
export function publicImageModelCapabilities(args: { enabled: boolean }): {
  version: string;
  enabled: boolean;
  default_tier: ImageModelTierId;
  tiers: readonly {
    id: ImageModelTierId;
    slug: string;
    display_name: string;
    premium: boolean;
    supports_references: boolean;
    resolutions: readonly ImageGenerationResolution[];
    quotes: {
      generate_credits: Record<ImageGenerationResolution, number>;
      edit_credits: Record<ImageGenerationResolution, number>;
      per_input_reference_credits: number;
    };
  }[];
} {
  const defaultTier = IMAGE_MODEL_REGISTRY.find((entry) => entry.isDefault);
  return {
    version: IMAGE_MODEL_CAPABILITIES_VERSION,
    enabled: args.enabled,
    default_tier: defaultTier ? defaultTier.tierId : 'quality',
    tiers: IMAGE_MODEL_REGISTRY.map((entry) => {
      const perResolution = Object.freeze({
        '1K': imageModelCreditsPerImage(entry, '1K'),
        '2K': imageModelCreditsPerImage(entry, '2K'),
      } as Record<ImageGenerationResolution, number>);
      const perInputReferenceCredits =
        entry.price.providerUsdPerInputReference === undefined
          ? 0
          : deriveImageCreditsPerImage(entry.price.providerUsdPerInputReference);
      return {
        id: entry.tierId,
        slug: entry.providerSlug,
        display_name: entry.displayName,
        premium: entry.tierId === 'max',
        supports_references: entry.supportsReferenceImages,
        resolutions: entry.supportedResolutions,
        quotes: {
          generate_credits: perResolution,
          edit_credits: perResolution,
          per_input_reference_credits: perInputReferenceCredits,
        },
      };
    }),
  };
}
