/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE managed IMAGE MODEL REGISTRY core (MAT-1769).
 *
 * THE RULE THIS ENFORCES. The image model selector in the composer may quote a
 * price ONLY from this server-owned registry. There is deliberately NO
 * client-side rate table for images — the
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
 *         "id": "quality" | "quality-pro" | …,       // each at most once
 *         "slug": "x-ai/grok-imagine-image-quality", // provider model the tier resolves to
 *         "display_name": "Nano Banana 2",           // user-facing model name
 *         "premium": false,
 *         "supports_references": true,
 *         "curated_rank": 1,                         // 1..N = 'Empfohlen' order; null = behind 'Weitere anzeigen'
 *         "max_reference_images": 14,                // references per edit; ABSENT on gateways predating the field
 *         "honors_resolution": true,                 // does the provider TAKE a resolution instruction; ABSENT = true
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
 * WHY THE FAIL-CLOSED RULE CHANGED SHAPE (2026-08-18). It used to demand
 * EXACTLY THREE tiers and poison the entire read on one bad one. That was
 * right while the control was a three-way switch: with a fixed three, a
 * missing tier left one option quoting nothing while looking identical to the
 * others, so refusing everything was the only honest answer.
 *
 * The catalog is now OPEN — the server curates a shortlist and may pin more
 * models at any time. Under an open list the old rule inverts into a
 * self-inflicted outage: the server adds an eighth model and every older
 * client, whose count no longer matches, shows "price unavailable" for models
 * it could price perfectly. A client must not break because the server got
 * richer.
 *
 * So fail-closed moved from the COUNT to the TIER. Each tier is proven on its
 * own; one that is not — unknown id, malformed quote, non-integer credit,
 * bad rank — is DROPPED, and a dropped tier is simply not offered. Never
 * shown unpriced, never shown with a guess. What is displayed is exactly what
 * was proven, and absence is honest where invention is not.
 *
 * THE SERVER'S OWN EVIDENCE FOR THIS (2026-08-18, independently observed).
 * seedream-lite sells only 2K — its images route advertises 2K/4K and no 1K.
 * The honest wire for that would be a price table with just the 2K key. The
 * server publishes BOTH keys anyway, and says why in its fixture header: the
 * desktop parser "fails the whole registry closed on a missing one". So the
 * old rule had already begun shaping the server's data — a single narrow
 * model was forced to publish a price nobody can buy, because the alternative
 * was blacking out the entire image lane on every client.
 *
 * That is the tell of a rule in the wrong place: it was no longer protecting
 * the client, it was taxing the server. Per-tier proof removes the tax. One
 * model's quirk now costs that model, and nothing else. (The placeholder
 * column is still real data on the wire, so ranking reads the cheapest
 * OFFERED rate — see `imageModelBaseRate` — rather than a price that exists
 * only to satisfy a parser.)
 *
 * Three whole-read failures survive, because each would make the SURVIVORS
 * misleading rather than merely fewer:
 *   - NO tier survives — an empty picker claiming to be a catalog;
 *   - the `default_tier` did not survive — the seat's fallback choice would
 *     silently become a different, possibly dearer, model;
 *   - a DUPLICATE id — the same id resolving to two prices means the wire is
 *     not trustworthy at all, and picking one is picking a coin flip.
 */

export const COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION = 'command-eve-image-model-registry/v1' as const;

/** Authenticated read endpoint on the eve-multimodal gateway (CoS contract). */
export const COMMAND_EVE_IMAGE_MODEL_CAPABILITIES_PATH = '/image-model-capabilities' as const;

/**
 * The tier vocabulary the server pins (2026-08-18). These are IDENTITIES, not
 * a ranking: the 'Empfohlen' order is the server's `curated_rank`, never this
 * array's order. `fast` was retired with the Schnell tier.
 */
export const COMMAND_EVE_IMAGE_MODEL_TIER_IDS = [
  'quality',
  'quality-pro',
  'max',
  'grok-2',
  'seedream-pro',
  'seedream-lite',
  'qwen-3',
] as const;
export type CommandEveImageModelTierId = (typeof COMMAND_EVE_IMAGE_MODEL_TIER_IDS)[number];

/**
 * The product default, chosen when nothing is stored or a read fails closed.
 * Also the landing spot for a seat that still has the retired `fast` stored —
 * {@link normalizeCommandEveImageModelTier} turns that into this, never into
 * an empty selection.
 */
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
  /**
   * The server's 'Empfohlen' position (1 = first). `null` means the model
   * lives behind 'Weitere anzeigen'. The SERVER curates; the client only
   * sorts by what it is told, so a curation change ships without a client
   * release.
   */
  curated_rank: number | null;
  /**
   * How many reference images this model accepts in ONE edit, as the server
   * read it from the provider's images route. `null` when the server did not
   * state one — an OLDER gateway does not send this field at all, and an
   * unknown ceiling is reported as unknown rather than guessed.
   * The composer shows this ceiling BEFORE sending, so attaching a sixth
   * reference to a three-reference model is visible as a limit rather than a
   * late refusal.
   */
  max_reference_images: number | null;
  /**
   * Whether the provider behind this tier ACCEPTS A RESOLUTION INSTRUCTION at
   * all, as the server read it from the images route. `false` today only for
   * gpt-image-2, whose single endpoint advertises no `resolution` parameter
   * and sizes at its own discretion.
   *
   * The composer HIDES the resolution control for such a tier. The value the
   * lane sends is unaffected — the server still sends what it sends; what
   * stops is OFFERING a switch that cannot change the outcome.
   */
  honors_resolution: boolean;
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
  /** Every tier that PROVED itself, in server order. Dropped tiers are absent, never faked. */
  tiers: readonly CommandEveImageModelTierSpec[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCreditCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * A curated rank is either absent (`null`/omitted — the model sits behind
 * 'Weitere anzeigen') or a positive integer position. `0`, a fraction and a
 * negative are all malformed, and a malformed rank drops the tier: a row
 * whose position cannot be trusted would silently reorder the shortlist.
 */
function parseCuratedRank(value: unknown): { ok: true; rank: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, rank: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return { ok: false };
  return { ok: true, rank: value };
}

/**
 * The reference ceiling is ADVISORY, so its absence must not cost a model its
 * place in the picker: an omitted field is `null` ("not stated"), and only a
 * MALFORMED one (fraction, negative, non-number) drops the tier — a ceiling
 * the user would read must never be a guess.
 *
 * This asymmetry is deliberate. A gateway that predates this field still
 * prices every model perfectly; refusing those models would turn a missing
 * hint into a dead price list, which is the same self-inflicted outage the
 * header's count rule caused.
 */
function parseReferenceCeiling(value: unknown): { ok: true; ceiling: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, ceiling: null };
  if (!isCreditCount(value)) return { ok: false };
  return { ok: true, ceiling: value };
}

/**
 * Whether the provider takes a resolution instruction. ABSENT MEANS `true`,
 * and the direction of that default is the whole point: this field can only
 * ever REMOVE a control the user has today. An older gateway that never heard
 * of it must therefore keep behaving exactly as it does now — reading its
 * silence as `false` would take the resolution switch away from every model on
 * every pre-field gateway, which is a regression dressed as caution.
 *
 * Same asymmetry as the reference ceiling above, opposite tolerant value,
 * because the two fields fail in opposite directions: an unknown CEILING must
 * not be guessed (so `null`, claim nothing), an unknown ACCEPTANCE must not
 * silently narrow the UI (so `true`, change nothing). A MALFORMED value drops
 * the tier either way — a control shown or hidden on a non-boolean would be a
 * coin flip.
 */
function parseHonorsResolution(value: unknown): { ok: true; honors: boolean } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, honors: true };
  if (typeof value !== 'boolean') return { ok: false };
  return { ok: true, honors: value };
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
  const curatedRank = parseCuratedRank(value.curated_rank);
  if (!curatedRank.ok) return null;
  const referenceCeiling = parseReferenceCeiling(value.max_reference_images);
  if (!referenceCeiling.ok) return null;
  const honorsResolution = parseHonorsResolution(value.honors_resolution);
  if (!honorsResolution.ok) return null;
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
    curated_rank: curatedRank.rank,
    max_reference_images: referenceCeiling.ceiling,
    honors_resolution: honorsResolution.honors,
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
 * envelope).
 *
 * The ENVELOPE is all-or-nothing: a wrong version, a mistyped `enabled` or an
 * unknown `default_tier` returns `null`.
 *
 * Each TIER is proven on its own and a tier that does not prove is DROPPED,
 * not fatal — see the header for why an open catalog inverts the old
 * exactly-three rule. Three conditions still fail the whole read, because
 * they would make the survivors misleading rather than merely fewer: no tier
 * survived, the `default_tier`'s own tier did not survive, or an id appeared
 * twice.
 */
export function parseCommandEveImageModelRegistry(raw: unknown): CommandEveImageModelRegistry | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION) return null;
  if (typeof raw.enabled !== 'boolean') return null;
  if (!isCommandEveImageModelTierId(raw.default_tier)) return null;
  if (!Array.isArray(raw.tiers)) return null;
  // Per-tier proof: an unparseable entry is dropped, so one bad row cannot
  // take the priceable ones down with it.
  const parsed = raw.tiers
    .map(parseTierSpec)
    .filter((tier): tier is CommandEveImageModelTierSpec => tier !== null);
  if (parsed.length === 0) return null;
  const seen = new Set(parsed.map((tier) => tier.id));
  // A duplicate id means one id carries two prices: the wire is untrustworthy,
  // and choosing a winner would be choosing a coin flip.
  if (seen.size !== parsed.length) return null;
  // The seat's fallback must be one of the survivors, or a read failure would
  // silently move the default onto a different — possibly dearer — model.
  if (!seen.has(raw.default_tier)) return null;
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
 * Resolves an image-edit selection from the live registry without naming a
 * provider model client-side. Keep an existing choice when it can accept
 * references; otherwise use the server default when it can, then the first
 * server-declared fallback. `null` is fail-closed: no edit-capable tier was
 * proven by this registry.
 */
export function resolveReferenceCapableImageModelTier(
  registry: CommandEveImageModelRegistry,
  preferredTier: CommandEveImageModelTierId
): CommandEveImageModelTierId | null {
  const preferred = getCommandEveImageModelTierSpec(registry, preferredTier);
  if (preferred?.supports_references) return preferred.id;

  const defaultTier = getCommandEveImageModelTierSpec(registry, registry.default_tier);
  if (defaultTier?.supports_references) return defaultTier.id;

  return registry.tiers.find((tier) => tier.supports_references)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Catalog presentation helpers (MAT-1773, PACKAGE A) — the shared media-model
// dropdown lists the registry like the video catalog lists its entries.
// ---------------------------------------------------------------------------

/**
 * The provider identity for a model row's chip: a stable key derived from the
 * vendor part of the server-pinned slug (`google/gemini-…` -> `google`) plus a
 * short label. Mirrors the video catalog's `videoCatalogProvider`; kept local
 * so this module stays free of video imports.
 */
export function commandEveImageModelProvider(spec: CommandEveImageModelTierSpec): { key: string; label: string } {
  const vendor = spec.slug.includes('/') ? spec.slug.slice(0, spec.slug.indexOf('/')) : spec.slug;
  const key = vendor.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const labels: Record<string, string> = {
    xai: 'xAI',
    google: 'Google',
    openai: 'OpenAI',
  };
  const label = labels[key] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
  return { key, label };
}

/**
 * The curated shortlist for the model dropdown ('Empfohlen'): the tiers the
 * SERVER ranked, in `curated_rank` order (1 first). Data-driven by
 * construction — the server curates, the client only sorts, so re-curating
 * the shortlist ships without a client release.
 *
 * Mirrors the video lane's {@link resolveVideoCatalogTopFive} in shape: a
 * short ordered shortlist up front, everything else behind 'Weitere
 * anzeigen'. The ONE deliberate difference is where the order comes from —
 * video pins its five client-side because its catalog is a flat provider
 * list with no server opinion, while this registry carries the rank on the
 * wire. Reading the rank instead of re-pinning names here is what keeps the
 * two lanes one idiom rather than two.
 *
 * Ties keep server order, so a server that ranks two models the same still
 * renders deterministically instead of flickering between reads.
 */
export function resolveImageModelCuratedTiers(registry: CommandEveImageModelRegistry): CommandEveImageModelTierSpec[] {
  return registry.tiers
    .filter((tier) => tier.curated_rank !== null)
    .toSorted((a, b) => (a.curated_rank ?? 0) - (b.curated_rank ?? 0));
}

/**
 * The rate a model is RANKED by: its cheapest quote among the resolutions it
 * actually OFFERS. Mirrors the video lane's `baseVideoCatalogPrice` ("the base
 * rate, i.e. the cheapest resolution key").
 *
 * Reading `generate_credits['1K']` blindly would be wrong, because the price
 * table and the offer are allowed to differ: seedream-lite is quoted at 1K and
 * 2K but sells only 2K (its images route advertises 2K/4K). The server keeps
 * the 1K column populated on purpose — a partial table would fail the tier —
 * so that column is a placeholder, not an offer. Sorting by it would order the
 * list by a price no one can buy.
 */
function imageModelBaseRate(spec: CommandEveImageModelTierSpec): number {
  const offered = spec.resolutions.map((resolution) => spec.quotes.generate_credits[resolution]);
  return offered.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...offered);
}

/**
 * Everything behind 'Weitere anzeigen': the registry minus the curated
 * shortlist, price-ascending by {@link imageModelBaseRate} (cheapest first),
 * exactly like {@link listVideoCatalogBeyondTopFive}. Empty when the server
 * ranked every tier it pinned.
 *
 * Dedupe is by TIER ID, the registry's own primary key — a curated model must
 * never appear twice, once under 'Empfohlen' and again under 'Alle Modelle'.
 * (The video lane needs normalized-id matching for the same guarantee only
 * because it matches curated NAMES against served ids; here the id is
 * authoritative on both sides.)
 */
export function listImageModelsBeyondCurated(registry: CommandEveImageModelRegistry): CommandEveImageModelTierSpec[] {
  const curated = new Set(resolveImageModelCuratedTiers(registry).map((tier) => tier.id));
  return registry.tiers
    .filter((tier) => !curated.has(tier.id))
    .toSorted((a, b) => imageModelBaseRate(a) - imageModelBaseRate(b));
}

/**
 * The reference-image ceiling to show the user for a chosen tier, or `null`
 * when nothing was proven (unknown tier, or a model that takes no
 * references). `null` is the honest "we cannot promise a number" — a caller
 * must not substitute a client-side guess.
 */
export function imageModelReferenceCeiling(
  registry: CommandEveImageModelRegistry,
  tierId: CommandEveImageModelTierId
): number | null {
  const spec = getCommandEveImageModelTierSpec(registry, tierId);
  if (!spec || !spec.supports_references) return null;
  const ceiling = spec.max_reference_images;
  return ceiling !== null && ceiling > 0 ? ceiling : null;
}

/**
 * THE CEILING THE OPERATOR ACTUALLY MEETS — which is NOT always the model's.
 *
 * Two independent limits sit on this lane and the tighter one wins:
 *
 *   1. THE LANE CAP. Four references per image, enforced four times over —
 *      the renderer's bridge policy, the artifact bridge, the managed-image
 *      service and, authoritatively, the gateway's own parse before any
 *      reserve. It is a property of this lane, identical for every model.
 *   2. THE MODEL CEILING. What the provider advertises on the images route:
 *      grok 3, qwen 4, both gemini models 14, gpt-image-2 16.
 *
 * MEASURED CONSEQUENCE (2026-08-18): the lane cap is the binding limit for
 * five of seven models, and the model ceiling only ever bites for grok-2, at
 * exactly four attachments. Showing the raw model number would therefore
 * promise 16 references on a lane that refuses the fifth — a worse lie than
 * saying nothing, because the user would act on it.
 *
 * `laneCap` is a PARAMETER rather than an import on purpose: this module is
 * the wire contract and owns no policy, and the constant lives in
 * eveManagedImageGenerationCore, which already imports a type from here. A
 * value import back would close that loop.
 *
 * Returns the binding ceiling, or `null` when the model states none — an
 * unproven ceiling stays unproven, exactly as above.
 */
export function effectiveImageReferenceCeiling(
  registry: CommandEveImageModelRegistry,
  tierId: CommandEveImageModelTierId,
  laneCap: number
): { ceiling: number; boundBy: 'model' | 'lane' } | null {
  if (!Number.isInteger(laneCap) || laneCap <= 0) return null;
  const modelCeiling = imageModelReferenceCeiling(registry, tierId);
  if (modelCeiling === null) return null;
  return modelCeiling < laneCap
    ? { ceiling: modelCeiling, boundBy: 'model' }
    : { ceiling: laneCap, boundBy: 'lane' };
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
