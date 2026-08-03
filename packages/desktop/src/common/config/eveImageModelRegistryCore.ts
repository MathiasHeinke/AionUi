/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE managed IMAGE MODEL REGISTRY core (MAT-1769).
 *
 * THE RULE THIS ENFORCES. The three-way image model selector in the composer
 * (Schnell / Qualität / MAX) may quote a price ONLY from this server-owned
 * registry. There is deliberately NO client-side rate table for images — the
 * video lane's hardcoded `VIDEO_MODEL_USD_PER_SECOND` is the anti-pattern: a UI
 * literal goes stale the day the server reprices, and a stale price is a lie at
 * the exact moment of choosing. So this module defines only the WIRE SHAPE and
 * a fail-closed parser. Anything that does not parse — missing tier, unknown
 * shape, non-integer credit — is `null`, and every consumer treats `null` as
 * "price unavailable", never as "use the last number we remember".
 *
 * THE CONTRACT (CoS-authoritative, mirrored from the eve-multimodal gateway):
 * the gateway serves the pinned registry as an authenticated READ —
 *
 *   GET {EVE_MULTIMODAL_FUNCTION_URL}/image-model-capabilities
 *   Authorization: Bearer <CEVE wire>
 *
 * and the 200 body IS the serialized registry view (NO envelope), exactly the
 * shape `publicImageModelCapabilities` in
 * supabase/functions/eve-multimodal/image-model-registry.ts returns:
 *
 *   {
 *     "version": "command-eve-image-model-registry/v1",
 *     "enabled": true,
 *     "default_tier": "quality",
 *     "tiers": [
 *       {
 *         "id": "fast" | "quality" | "max",          // all three, each once
 *         "slug": "x-ai/grok-imagine-image-quality", // provider model the tier resolves to
 *         "display_name": "Nano Banana 2",           // user-facing model name
 *         "premium": false,
 *         "supports_references": true,
 *         "resolutions": ["1K", "2K"],
 *         "quotes": {
 *           "generate_credits": { "1K": 1380, "2K": 1380 },
 *           "edit_credits": { "1K": 1380, "2K": 1380 },
 *           "per_input_reference_credits": 0
 *         }
 *       }
 *     ]
 *   }
 *
 * Exactly three tiers are REQUIRED, not sampled: the composer control is an
 * exactly-three selector, and a registry that cannot account for all three
 * would leave one option quoting nothing while looking identical to the
 * others. One bad tier poisons the whole read.
 */

export const COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION = 'command-eve-image-model-registry/v1' as const;

/** Authenticated read endpoint on the eve-multimodal gateway (CoS contract). */
export const COMMAND_EVE_IMAGE_MODEL_CAPABILITIES_PATH = '/image-model-capabilities' as const;

export const COMMAND_EVE_IMAGE_MODEL_TIER_IDS = ['fast', 'quality', 'max'] as const;
export type CommandEveImageModelTierId = (typeof COMMAND_EVE_IMAGE_MODEL_TIER_IDS)[number];

/** The product default: the middle tier, chosen when nothing is stored or a read fails closed. */
export const DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER: CommandEveImageModelTierId = 'quality';

export function isCommandEveImageModelTierId(value: unknown): value is CommandEveImageModelTierId {
  return typeof value === 'string' && (COMMAND_EVE_IMAGE_MODEL_TIER_IDS as readonly string[]).includes(value);
}

/**
 * Fail-closed normalization for anything that claims to be a tier (stored
 * config values, bridge payloads): unknown input becomes the product default,
 * never an error and never a pass-through.
 */
export function normalizeCommandEveImageModelTier(value: unknown): CommandEveImageModelTierId {
  return isCommandEveImageModelTierId(value) ? value : DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER;
}

export type CommandEveImageModelResolution = '1K' | '2K';
const RESOLUTIONS: readonly CommandEveImageModelResolution[] = ['1K', '2K'];

export type CommandEveImageModelTierQuotes = {
  /** Credits per generated image, per resolution. */
  generate_credits: Record<CommandEveImageModelResolution, number>;
  /** Credits per edited image, per resolution. */
  edit_credits: Record<CommandEveImageModelResolution, number>;
  /** Surcharge per input reference image on an edit (0 when the registry does not price it). */
  per_input_reference_credits: number;
};

export type CommandEveImageModelTierSpec = {
  id: CommandEveImageModelTierId;
  /** Provider model slug the SERVER resolves this tier to (e.g. 'google/gemini-3.1-flash-image'). */
  slug: string;
  /** User-facing model name the server pins (e.g. 'Schnell', 'Nano Banana 2', 'GPT Image 2'). */
  display_name: string;
  /** Server-flagged premium tier — the renderer stays BELOW the EVE MAX reasoning accent. */
  premium: boolean;
  /** Whether this model accepts edit/reference image inputs through the managed lane. */
  supports_references: boolean;
  /** The resolutions this tier can produce through the managed lane. */
  resolutions: readonly CommandEveImageModelResolution[];
  quotes: CommandEveImageModelTierQuotes;
};

export type CommandEveImageModelRegistry = {
  version: typeof COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION;
  /** The gateway's image-generation lane switch. `false` means: refuse, honestly. */
  enabled: boolean;
  /** The tier the server falls back to when a seat has no explicit choice. */
  default_tier: CommandEveImageModelTierId;
  /** Exactly the three tiers, in server order. */
  tiers: readonly CommandEveImageModelTierSpec[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCreditCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseResolutionQuotes(value: unknown): Record<CommandEveImageModelResolution, number> | null {
  if (!isRecord(value)) return null;
  const oneK = value['1K'];
  const twoK = value['2K'];
  if (!isCreditCount(oneK) || !isCreditCount(twoK)) return null;
  return { '1K': oneK, '2K': twoK };
}

function parseResolutions(value: unknown): readonly CommandEveImageModelResolution[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > RESOLUTIONS.length) return null;
  if (!value.every((entry) => typeof entry === 'string' && (RESOLUTIONS as readonly string[]).includes(entry))) {
    return null;
  }
  if (new Set(value).size !== value.length) return null;
  return value as readonly CommandEveImageModelResolution[];
}

function parseTierSpec(value: unknown): CommandEveImageModelTierSpec | null {
  if (!isRecord(value)) return null;
  if (!isCommandEveImageModelTierId(value.id)) return null;
  if (typeof value.slug !== 'string' || !value.slug.trim() || value.slug.length > 200) return null;
  if (typeof value.display_name !== 'string' || !value.display_name.trim() || value.display_name.length > 80) {
    return null;
  }
  if (typeof value.premium !== 'boolean') return null;
  if (typeof value.supports_references !== 'boolean') return null;
  const resolutions = parseResolutions(value.resolutions);
  if (!resolutions) return null;
  if (!isRecord(value.quotes)) return null;
  const generate = parseResolutionQuotes(value.quotes.generate_credits);
  const edit = parseResolutionQuotes(value.quotes.edit_credits);
  if (!generate || !edit) return null;
  const perReference = value.quotes.per_input_reference_credits;
  if (!isCreditCount(perReference)) return null;
  return {
    id: value.id,
    slug: value.slug.trim(),
    display_name: value.display_name.trim(),
    premium: value.premium,
    supports_references: value.supports_references,
    resolutions,
    quotes: {
      generate_credits: generate,
      edit_credits: edit,
      per_input_reference_credits: perReference,
    },
  };
}

/**
 * Fail-closed parse of the server registry view. The 200 body IS the view (no
 * envelope). Returns `null` for ANY deviation: wrong version, missing or
 * mistyped field, missing tier, duplicate tier, unknown tier id, malformed
 * quote. There is no partial success — see the header for why.
 */
export function parseCommandEveImageModelRegistry(raw: unknown): CommandEveImageModelRegistry | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION) return null;
  if (typeof raw.enabled !== 'boolean') return null;
  if (!isCommandEveImageModelTierId(raw.default_tier)) return null;
  if (!Array.isArray(raw.tiers) || raw.tiers.length !== COMMAND_EVE_IMAGE_MODEL_TIER_IDS.length) return null;
  const tiers = raw.tiers.map(parseTierSpec);
  if (tiers.some((tier) => tier === null)) return null;
  const parsed = tiers as CommandEveImageModelTierSpec[];
  const seen = new Set(parsed.map((tier) => tier.id));
  if (seen.size !== COMMAND_EVE_IMAGE_MODEL_TIER_IDS.length) return null;
  if (!COMMAND_EVE_IMAGE_MODEL_TIER_IDS.every((id) => seen.has(id))) return null;
  return {
    version: COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION,
    enabled: raw.enabled,
    default_tier: raw.default_tier,
    tiers: parsed,
  };
}

/** The tier spec, or `undefined` when the (already parsed) registry does not carry it. */
export function getCommandEveImageModelTierSpec(
  registry: CommandEveImageModelRegistry,
  tierId: CommandEveImageModelTierId
): CommandEveImageModelTierSpec | undefined {
  return registry.tiers.find((tier) => tier.id === tierId);
}

/**
 * What any read of the registry yields. Shared by Main (fetch), the bridge,
 * and the renderer, so the failure vocabulary is defined exactly once. Every
 * reason is a statement about the FETCH, never about price — a consumer that
 * gets `{ ok: false }` knows nothing about credits and must say so.
 *
 * Both members carry BOTH fields (the absent one as `?: never`): this project
 * compiles without strictNullChecks, so boolean-discriminant narrowing is not
 * reliable and every consumer reads `result.reason` / `result.registry`
 * directly, exactly as the cloud visual policy's state union does.
 */
export type CommandEveImageModelRegistryUnavailableReason =
  | 'missing_license'
  | 'capabilities_http_error'
  | 'capabilities_unparseable'
  | 'capabilities_timeout'
  | 'capabilities_failed';

export type CommandEveImageModelRegistryResult =
  | { ok: true; registry: CommandEveImageModelRegistry; reason?: never }
  | { ok: false; registry?: never; reason: CommandEveImageModelRegistryUnavailableReason };
