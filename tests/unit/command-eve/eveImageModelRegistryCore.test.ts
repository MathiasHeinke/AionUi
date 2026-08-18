/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The server-owned image model registry core (MAT-1769).
 *
 * The property these tests pin is FAIL-CLOSED parsing: the composer quotes
 * prices from this registry and nothing else, so a renamed field or a
 * non-integer credit must never reach the UI as a number.
 *
 * WHAT CHANGED WITH THE OPEN CATALOG (2026-08-18). Fail-closed moved from the
 * COUNT to the TIER. It used to be "exactly three or nothing", which was right
 * for a three-way switch and became a self-inflicted outage the moment the
 * server could pin more models: an eighth model would blank the price list on
 * every older client. Now each tier is proven alone and a bad one is DROPPED —
 * never shown unpriced, never shown with a guess — while three conditions
 * still fail the whole read because they would make the SURVIVORS misleading:
 * no survivor at all, a `default_tier` that did not survive, a duplicate id.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION,
  COMMAND_EVE_IMAGE_MODEL_TIER_IDS,
  DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER,
  commandEveImageModelProvider,
  getCommandEveImageModelTierSpec,
  imageModelReferenceCeiling,
  isCommandEveImageModelTierId,
  listImageModelsBeyondCurated,
  normalizeCommandEveImageModelTier,
  parseCommandEveImageModelRegistry,
  resolveImageModelCuratedTiers,
} from '@/common/config/eveImageModelRegistryCore';

function tierRaw(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: `provider/${id}-image`,
    display_name: `${id} model`,
    premium: id === 'max',
    supports_references: id === 'quality',
    curated_rank: null,
    max_reference_images: 4,
    resolutions: ['1K', '2K'],
    quotes: {
      generate_credits: { '1K': 30, '2K': 60 },
      edit_credits: { '1K': 36, '2K': 72 },
      per_input_reference_credits: 4,
    },
    ...overrides,
  };
}

function registryRaw(overrides: Record<string, unknown> = {}) {
  return {
    version: COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION,
    enabled: true,
    default_tier: 'quality',
    tiers: [
      tierRaw('quality', { curated_rank: 1 }),
      tierRaw('quality-pro', { curated_rank: 2 }),
      tierRaw('max', { curated_rank: 3 }),
      tierRaw('seedream-pro', { curated_rank: 4 }),
      tierRaw('grok-2'),
      tierRaw('seedream-lite'),
      tierRaw('qwen-3'),
    ],
    ...overrides,
  };
}

describe('parseCommandEveImageModelRegistry', () => {
  it('parses a healthy registry view and exposes every pinned tier', () => {
    const registry = parseCommandEveImageModelRegistry(registryRaw());
    expect(registry).not.toBeNull();
    expect(registry?.enabled).toBe(true);
    expect(registry?.default_tier).toBe('quality');
    expect(registry?.tiers).toHaveLength(7);
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')).toMatchObject({
      id: 'quality',
      slug: 'provider/quality-image',
      display_name: 'quality model',
      premium: false,
      supports_references: true,
      curated_rank: 1,
      max_reference_images: 4,
      resolutions: ['1K', '2K'],
      quotes: {
        generate_credits: { '1K': 30, '2K': 60 },
        edit_credits: { '1K': 36, '2K': 72 },
        per_input_reference_credits: 4,
      },
    });
    expect(getCommandEveImageModelTierSpec(registry!, 'max')?.premium).toBe(true);
  });

  it('rejects non-object bodies and wrong versions or envelope shapes', () => {
    expect(parseCommandEveImageModelRegistry(null)).toBeNull();
    expect(parseCommandEveImageModelRegistry('registry')).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ version: 'command-eve-image-model-registry/v0' }))
    ).toBeNull();
    // The retired POST envelope is NOT the read surface: an `image_capabilities`
    // wrapper is a deviation, and deviation is null.
    expect(parseCommandEveImageModelRegistry({ ok: true, image_capabilities: registryRaw() })).toBeNull();
    expect(parseCommandEveImageModelRegistry(registryRaw({ enabled: 'true' }))).toBeNull();
    expect(parseCommandEveImageModelRegistry(registryRaw({ default_tier: 'ultra' }))).toBeNull();
  });

  it('accepts a SHORTER catalog — the count is no longer the contract', () => {
    // The old rule demanded exactly three. A server that pins two priceable
    // models must not blank the picker.
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({ tiers: [tierRaw('quality', { curated_rank: 1 }), tierRaw('max', { curated_rank: 2 })] })
    );
    expect(registry?.tiers.map((tier) => tier.id)).toEqual(['quality', 'max']);
  });

  it('DROPS an unproven tier instead of poisoning the priceable ones', () => {
    // THE REGRESSION THIS PINS: one malformed row used to blank the whole
    // price list. The healthy models stay offerable; the broken one is simply
    // absent — never listed unpriced.
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({
        tiers: [
          tierRaw('quality', { curated_rank: 1 }),
          tierRaw('max', { curated_rank: 2, quotes: { generate_credits: { '1K': 1.5, '2K': 60 } } }),
          tierRaw('grok-2'),
          // An id this client does not know (a newer server tier) is dropped,
          // not fatal — forward compatibility is the whole point.
          tierRaw('tier-from-the-future'),
        ],
      })
    );
    expect(registry?.tiers.map((tier) => tier.id)).toEqual(['quality', 'grok-2']);
  });

  it('fails the WHOLE read when the survivors would mislead', () => {
    // (a) nothing survived: an empty picker claiming to be a catalog.
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [] }))).toBeNull();
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('ultra'), tierRaw('nonsense')] }))).toBeNull();
    // (b) the default_tier itself did not survive: the seat's fallback would
    // silently become a different, possibly dearer, model.
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ default_tier: 'quality', tiers: [tierRaw('max'), tierRaw('grok-2')] })
      )
    ).toBeNull();
    // (c) a duplicate id: one id carrying two prices is a coin flip.
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality'), tierRaw('quality')] }))
    ).toBeNull();
    // Sharpness control: the SAME shapes minus the poison parse fine.
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality')] }))?.tiers).toHaveLength(1);
  });

  it('tolerates a gateway that predates max_reference_images, but never a malformed one', () => {
    // FORWARD/BACKWARD COMPATIBILITY: the live gateway does not send this
    // field yet. Requiring it would drop every tier and blank the price list —
    // exactly the outage the count rule caused. Absent means "not stated".
    const older = { ...tierRaw('quality', { curated_rank: 1 }) } as Record<string, unknown>;
    delete older.max_reference_images;
    const registry = parseCommandEveImageModelRegistry(registryRaw({ tiers: [older] }));
    expect(registry?.tiers).toHaveLength(1);
    expect(registry?.tiers[0].max_reference_images).toBeNull();
    // A ceiling the user would READ must never be a guess: malformed drops it.
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { max_reference_images: 2.5 })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { max_reference_images: -1 })] }))
    ).toBeNull();
  });

  it('reads a missing honors_resolution as TRUE — the tolerant default is the one that changes nothing', () => {
    // THE DIRECTION OF THIS DEFAULT IS THE WHOLE POINT, and it is the OPPOSITE
    // of the ceiling's above. This field can only ever REMOVE a control. A
    // gateway that predates it prices every model perfectly and offers every
    // resolution today; reading its silence as `false` would strip the
    // resolution switch from EVERY model on EVERY older gateway — a
    // regression dressed up as caution.
    const older = { ...tierRaw('quality', { curated_rank: 1 }) } as Record<string, unknown>;
    delete older.honors_resolution;
    const registry = parseCommandEveImageModelRegistry(registryRaw({ tiers: [older] }));
    expect(registry?.tiers).toHaveLength(1);
    expect(registry?.tiers[0].honors_resolution).toBe(true);
    // An explicit false survives as false — otherwise the tolerant default
    // would swallow the one statement the field exists to carry.
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { honors_resolution: false })] }))
        ?.tiers[0].honors_resolution
    ).toBe(false);
    // MALFORMED STILL DROPS THE TIER. Showing or hiding a control on the
    // strength of a string or a number would be a coin flip, and the user
    // would see a different composer depending on which way it landed.
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { honors_resolution: 'yes' })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { honors_resolution: 0 })] }))
    ).toBeNull();
  });

  it('rejects a malformed curated rank — a bad position would reorder the shortlist silently', () => {
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { curated_rank: 0 })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { curated_rank: 1.5 })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { curated_rank: '1' })] }))
    ).toBeNull();
    // Sharpness control: a legitimate rank and an explicit null both pass.
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { curated_rank: 1 })] }))?.tiers[0]
        .curated_rank
    ).toBe(1);
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { curated_rank: null })] }))?.tiers[0]
        .curated_rank
    ).toBeNull();
  });

  it('rejects malformed tier payloads instead of recovering them', () => {
    // Each of these is the ONLY tier, so dropping it empties the catalog and
    // the read fails — the same guarantee as before, now stated per tier.
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { slug: '' })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { display_name: 42 })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { premium: 'yes' })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { supports_references: 0 })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { resolutions: [] })] }))
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('quality', { resolutions: ['4K'] })] }))
    ).toBeNull();
  });

  it('rejects non-integer, negative, missing, or incomplete credit quotes', () => {
    const fractional = tierRaw('quality');
    fractional.quotes.generate_credits = { '1K': 29.5, '2K': 60 };
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [fractional] }))).toBeNull();

    const negative = tierRaw('quality');
    negative.quotes.edit_credits = { '1K': -1, '2K': 72 };
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [negative] }))).toBeNull();

    const missing2K = tierRaw('quality');
    missing2K.quotes.generate_credits = { '1K': 30 } as unknown as { '1K': number; '2K': number };
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [missing2K] }))).toBeNull();

    // per_input_reference_credits is part of the contract — absent is a deviation.
    const missingPerRef = tierRaw('quality');
    delete (missingPerRef.quotes as Record<string, unknown>).per_input_reference_credits;
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [missingPerRef] }))).toBeNull();
  });

  // ── CROSS-WIRE FIXTURE (MAT-1769, CoS contract) ──────────────────────────
  // Mirrors the serialized view served by
  //   GET {EVE_MULTIMODAL_FUNCTION_URL}/image-model-capabilities
  // from supabase/functions/eve-multimodal/image-model-registry.ts
  // (`publicImageModelCapabilities` over IMAGE_MODEL_REGISTRY, catalog as
  // re-pinned 2026-08-18: the Schnell tier retired, seven models, four of them
  // curated by server rank, prices at the `media` 10x markup, FX 0.92, 10
  // credits per EUR cent → usdCents × 92.)
  //
  // SYNC SOURCE: the server worktree now pins this body as ONE literal in
  // supabase/functions/eve-multimodal/image-model-capabilities-fixture.ts
  // (`CANONICAL_IMAGE_MODEL_CAPABILITIES_RESPONSE`). The text below mirrors it
  // verbatim and is the client half of that cross-wire pin. It is deliberately
  // NOT imported: the two trees deploy independently, so a copy that has to be
  // updated by hand is the point — drift shows up as a diff someone approves.
  //
  // TWO ASYMMETRIES BELOW ARE REAL, not transcription slips (the server states
  // both):
  //   * seedream-lite is PRICED at both resolutions but OFFERED only at 2K —
  //     its images route advertises 2K/4K and no 1K at all. `quotes` is the
  //     price table, `resolutions` is the offer, and they may differ.
  //   * `premium` is DERIVED (dearer than the DEFAULT tier at 1K), not "the
  //     tier called max". quality-pro (2760) carries it while seedream-pro
  //     (460) does not, even though seedream-pro ranks higher in the
  //     shortlist. A client rule of `id === 'max'` would have mislabelled the
  //     dearest model in the catalog.
  it('accepts the canonical gateway GET response verbatim', () => {
    const canonicalGatewayResponse = {
      version: 'command-eve-image-model-registry/v1',
      enabled: true,
      default_tier: 'quality',
      tiers: [
        {
          id: 'quality',
          slug: 'google/gemini-3.1-flash-image',
          display_name: 'Nano Banana 2',
          premium: false,
          supports_references: true,
          curated_rank: 1,
          max_reference_images: 14,
          honors_resolution: true,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 1380, '2K': 1380 },
            edit_credits: { '1K': 1380, '2K': 1380 },
            per_input_reference_credits: 0,
          },
        },
        {
          id: 'quality-pro',
          slug: 'google/gemini-3-pro-image',
          display_name: 'Nano Banana Pro',
          premium: true,
          supports_references: true,
          curated_rank: 2,
          max_reference_images: 14,
          honors_resolution: true,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 2760, '2K': 2760 },
            edit_credits: { '1K': 2760, '2K': 2760 },
            per_input_reference_credits: 0,
          },
        },
        {
          id: 'max',
          slug: 'openai/gpt-image-2',
          display_name: 'GPT Image 2',
          premium: true,
          supports_references: true,
          curated_rank: 3,
          max_reference_images: 16,
          // THE ONLY FALSE IN THE LIVE CATALOG: gpt-image-2 advertises no
          // `resolution` parameter on its one endpoint.
          honors_resolution: false,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 2300, '2K': 2300 },
            edit_credits: { '1K': 2300, '2K': 2300 },
            per_input_reference_credits: 0,
          },
        },
        {
          id: 'seedream-pro',
          slug: 'bytedance-seed/seedream-5-0-pro',
          display_name: 'Seedream 5 Pro',
          premium: false,
          supports_references: true,
          curated_rank: 4,
          max_reference_images: 14,
          honors_resolution: true,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 460, '2K': 828 },
            edit_credits: { '1K': 460, '2K': 828 },
            per_input_reference_credits: 0,
          },
        },
        {
          id: 'grok-2',
          slug: 'x-ai/grok-imagine-image-2.0',
          display_name: 'Grok Imagine 2',
          premium: false,
          supports_references: true,
          curated_rank: null,
          max_reference_images: 3,
          honors_resolution: true,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 552, '2K': 736 },
            edit_credits: { '1K': 552, '2K': 736 },
            per_input_reference_credits: 92,
          },
        },
        {
          id: 'seedream-lite',
          slug: 'bytedance-seed/seedream-5-0-lite',
          display_name: 'Seedream 5 Lite',
          premium: false,
          supports_references: true,
          curated_rank: null,
          max_reference_images: 14,
          honors_resolution: true,
          // 2K ONLY — priced at both, offered at one. See the header.
          resolutions: ['2K'],
          quotes: {
            generate_credits: { '1K': 368, '2K': 368 },
            edit_credits: { '1K': 368, '2K': 368 },
            per_input_reference_credits: 0,
          },
        },
        {
          id: 'qwen-3',
          slug: 'qwen/qwen-image-3',
          display_name: 'Qwen Image 3',
          premium: false,
          supports_references: true,
          curated_rank: null,
          max_reference_images: 4,
          honors_resolution: true,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 276, '2K': 276 },
            edit_credits: { '1K': 276, '2K': 276 },
            per_input_reference_credits: 0,
          },
        },
      ],
    };

    const registry = parseCommandEveImageModelRegistry(canonicalGatewayResponse);
    expect(registry).not.toBeNull();
    expect(registry?.tiers.map((tier) => tier.id)).toEqual([
      'quality',
      'quality-pro',
      'max',
      'seedream-pro',
      'grok-2',
      'seedream-lite',
      'qwen-3',
    ]);
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')?.display_name).toBe('Nano Banana 2');
    expect(getCommandEveImageModelTierSpec(registry!, 'max')?.display_name).toBe('GPT Image 2');
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')?.quotes.generate_credits).toEqual({
      '1K': 1380,
      '2K': 1380,
    });
    expect(getCommandEveImageModelTierSpec(registry!, 'max')?.quotes.edit_credits['1K']).toBe(2300);
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')?.supports_references).toBe(true);
    expect(getCommandEveImageModelTierSpec(registry!, 'grok-2')?.quotes.per_input_reference_credits).toBe(92);

    // PREMIUM IS DERIVED, NOT NAMED. The retired client rule was effectively
    // `id === 'max'`, which would have left the DEAREST model in the catalog
    // unmarked while marking a cheaper one.
    expect(getCommandEveImageModelTierSpec(registry!, 'quality-pro')?.premium).toBe(true);
    expect(getCommandEveImageModelTierSpec(registry!, 'seedream-pro')?.premium).toBe(false);

    // PRICED AT BOTH, OFFERED AT ONE. The 2K-only model survives the parse
    // with its full price table and its narrow offer both intact — the
    // parser must not "helpfully" reconcile the two.
    expect(getCommandEveImageModelTierSpec(registry!, 'seedream-lite')?.resolutions).toEqual(['2K']);
    expect(getCommandEveImageModelTierSpec(registry!, 'seedream-lite')?.quotes.generate_credits).toEqual({
      '1K': 368,
      '2K': 368,
    });

    // FOUR curated models, in the SERVER's rank order — the founder's ask.
    expect(resolveImageModelCuratedTiers(registry!).map((tier) => tier.id)).toEqual([
      'quality',
      'quality-pro',
      'max',
      'seedream-pro',
    ]);
    // The rest, cheapest first.
    expect(listImageModelsBeyondCurated(registry!).map((tier) => tier.id)).toEqual([
      'qwen-3',
      'seedream-lite',
      'grok-2',
    ]);
    // The live reference ceilings, as read from the images route.
    expect(imageModelReferenceCeiling(registry!, 'max')).toBe(16);
    expect(imageModelReferenceCeiling(registry!, 'grok-2')).toBe(3);

    // A RESOLUTION INSTRUCTION IS NOT UNIVERSALLY TAKEN, and the wire says so
    // per model. gpt-image-2's single endpoint advertises no `resolution`
    // parameter at all; every other model in the catalog enumerates one.
    // The composer hides the control on the strength of THIS field rather
    // than a rule about the tier id — the same lesson `premium` already
    // learned, since `max` is a slot and the model in it is replaceable.
    expect(getCommandEveImageModelTierSpec(registry!, 'max')?.honors_resolution).toBe(false);
    for (const tierId of ['quality', 'quality-pro', 'seedream-pro', 'grok-2', 'seedream-lite', 'qwen-3'] as const) {
      expect(getCommandEveImageModelTierSpec(registry!, tierId)?.honors_resolution).toBe(true);
    }
    // AND IT IS INDEPENDENT OF THE OFFER. seedream-lite proves the two fields
    // are not two names for one fact: it narrows `resolutions` to 2K AND
    // takes the parameter. Collapsing either into the other would mislabel it.
    expect(getCommandEveImageModelTierSpec(registry!, 'seedream-lite')?.resolutions).toEqual(['2K']);
    expect(getCommandEveImageModelTierSpec(registry!, 'seedream-lite')?.honors_resolution).toBe(true);
  });
});

describe('tier id normalization', () => {
  it('accepts exactly the seven known tier ids', () => {
    expect(COMMAND_EVE_IMAGE_MODEL_TIER_IDS).toEqual([
      'quality',
      'quality-pro',
      'max',
      'grok-2',
      'seedream-pro',
      'seedream-lite',
      'qwen-3',
    ]);
    expect(isCommandEveImageModelTierId('quality')).toBe(true);
    expect(isCommandEveImageModelTierId('quality-pro')).toBe(true);
    expect(isCommandEveImageModelTierId('max')).toBe(true);
    expect(isCommandEveImageModelTierId('seedream-pro')).toBe(true);
    // RETIRED with the Schnell tier — no longer a known id.
    expect(isCommandEveImageModelTierId('fast')).toBe(false);
    expect(isCommandEveImageModelTierId('ultra')).toBe(false);
    expect(isCommandEveImageModelTierId('MAX')).toBe(false);
    expect(isCommandEveImageModelTierId(3)).toBe(false);
    expect(isCommandEveImageModelTierId(undefined)).toBe(false);
  });

  it('fails closed to the product default for unknown values', () => {
    expect(DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER).toBe('quality');
    expect(normalizeCommandEveImageModelTier('max')).toBe('max');
    expect(normalizeCommandEveImageModelTier('ultra')).toBe('quality');
    expect(normalizeCommandEveImageModelTier(null)).toBe('quality');
    expect(normalizeCommandEveImageModelTier('')).toBe('quality');
  });

  it('lands an old seat that still stores the retired ‘fast’ on the default', () => {
    // THE UPGRADE PATH. A seat that chose Schnell has that string on disk. It
    // must resolve to a real, priceable tier — never an empty selection that
    // would leave the composer with no model at all.
    expect(normalizeCommandEveImageModelTier('fast')).toBe('quality');
    expect(normalizeCommandEveImageModelTier('fast')).toBe(DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER);
  });
});

describe('catalog presentation helpers (MAT-1773 PACKAGE A)', () => {
  it('curates exactly the SERVER-ranked tiers — four recommended, the rest expandable', () => {
    const registry = parseCommandEveImageModelRegistry(registryRaw())!;
    // The founder's ask: four curated, everything else behind 'Weitere anzeigen'.
    expect(resolveImageModelCuratedTiers(registry).map((tier) => tier.id)).toEqual([
      'quality',
      'quality-pro',
      'max',
      'seedream-pro',
    ]);
    expect(listImageModelsBeyondCurated(registry).map((tier) => tier.id)).toHaveLength(3);
    // Nothing appears twice: the two lists partition the registry exactly.
    const curated = resolveImageModelCuratedTiers(registry).map((tier) => tier.id);
    const rest = listImageModelsBeyondCurated(registry).map((tier) => tier.id);
    expect(new Set([...curated, ...rest]).size).toBe(registry.tiers.length);
  });

  it('orders the shortlist by curated_rank, NOT by server array order', () => {
    // The sharp case: the server sends its ranks out of order. A client that
    // merely echoed array order would show 4-2-1-3 and quietly demote the
    // default model out of first place.
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({
        tiers: [
          tierRaw('seedream-pro', { curated_rank: 4 }),
          tierRaw('quality-pro', { curated_rank: 2 }),
          tierRaw('quality', { curated_rank: 1 }),
          tierRaw('max', { curated_rank: 3 }),
        ],
      })
    )!;
    expect(resolveImageModelCuratedTiers(registry).map((tier) => tier.id)).toEqual([
      'quality',
      'quality-pro',
      'max',
      'seedream-pro',
    ]);
  });

  it('ranks the expandable rest by the cheapest OFFERED rate, not a phantom column', () => {
    // THE TRAP THIS PINS. seedream-lite is quoted at 1K and 2K but SELLS only
    // 2K — the server keeps the 1K column populated on purpose, because a
    // partial price table would fail the tier outright. That column is a
    // placeholder, not an offer. A sort that read `generate_credits['1K']`
    // blindly would order this list by a price nobody can buy: below, the
    // 2K-only model would jump to the front on a phantom 10 instead of
    // sitting last on its real 900.
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({
        tiers: [
          tierRaw('quality', { curated_rank: 1 }),
          tierRaw('seedream-lite', {
            resolutions: ['2K'],
            quotes: {
              generate_credits: { '1K': 10, '2K': 900 },
              edit_credits: { '1K': 10, '2K': 900 },
              per_input_reference_credits: 0,
            },
          }),
          tierRaw('qwen-3', {
            quotes: {
              generate_credits: { '1K': 100, '2K': 100 },
              edit_credits: { '1K': 100, '2K': 100 },
              per_input_reference_credits: 0,
            },
          }),
          tierRaw('grok-2', {
            quotes: {
              generate_credits: { '1K': 400, '2K': 400 },
              edit_credits: { '1K': 400, '2K': 400 },
              per_input_reference_credits: 0,
            },
          }),
        ],
      })
    )!;
    expect(listImageModelsBeyondCurated(registry).map((tier) => tier.id)).toEqual([
      'qwen-3',
      'grok-2',
      'seedream-lite',
    ]);
  });

  it('sorts the expandable rest cheapest-first by the 1K generate quote', () => {
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({
        tiers: [
          tierRaw('quality', { curated_rank: 1 }),
          tierRaw('grok-2', { quotes: { generate_credits: { '1K': 900, '2K': 900 }, edit_credits: { '1K': 900, '2K': 900 }, per_input_reference_credits: 0 } }),
          tierRaw('qwen-3', { quotes: { generate_credits: { '1K': 100, '2K': 100 }, edit_credits: { '1K': 100, '2K': 100 }, per_input_reference_credits: 0 } }),
          tierRaw('seedream-lite', { quotes: { generate_credits: { '1K': 400, '2K': 400 }, edit_credits: { '1K': 400, '2K': 400 }, per_input_reference_credits: 0 } }),
        ],
      })
    )!;
    expect(listImageModelsBeyondCurated(registry).map((tier) => tier.id)).toEqual([
      'qwen-3',
      'seedream-lite',
      'grok-2',
    ]);
  });

  it('shows an EMPTY shortlist rather than inventing one when the server ranked nothing', () => {
    // Fail-closed for curation too: no rank means no recommendation. The
    // models stay reachable behind 'Weitere anzeigen'; the client never
    // promotes one on its own taste.
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({ tiers: [tierRaw('quality'), tierRaw('max')] })
    )!;
    expect(resolveImageModelCuratedTiers(registry)).toEqual([]);
    expect(listImageModelsBeyondCurated(registry).map((tier) => tier.id)).toEqual(['quality', 'max']);
  });

  it('reports a reference ceiling only where the server proved one', () => {
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({
        tiers: [
          tierRaw('quality', { curated_rank: 1, supports_references: true, max_reference_images: 14 }),
          tierRaw('grok-2', { supports_references: true, max_reference_images: 3 }),
          // Takes no references at all.
          tierRaw('qwen-3', { supports_references: false, max_reference_images: 0 }),
        ],
      })
    )!;
    expect(imageModelReferenceCeiling(registry, 'quality')).toBe(14);
    expect(imageModelReferenceCeiling(registry, 'grok-2')).toBe(3);
    // No references, and a tier the registry does not carry: nothing claimed.
    expect(imageModelReferenceCeiling(registry, 'qwen-3')).toBeNull();
    expect(imageModelReferenceCeiling(registry, 'seedream-lite')).toBeNull();
  });

  it('derives the provider chip identity from the server-pinned slug vendor', () => {
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({
        tiers: [
          tierRaw('grok-2', { slug: 'x-ai/grok-imagine-image-2.0' }),
          tierRaw('quality', { slug: 'google/gemini-3.1-flash-image' }),
          tierRaw('max', { slug: 'openai/gpt-image-2' }),
        ],
      })
    )!;
    const byVendor = Object.fromEntries(registry.tiers.map((tier) => [tier.id, commandEveImageModelProvider(tier)]));
    expect(byVendor['grok-2']).toEqual({ key: 'xai', label: 'xAI' });
    expect(byVendor.quality).toEqual({ key: 'google', label: 'Google' });
    expect(byVendor.max).toEqual({ key: 'openai', label: 'OpenAI' });
  });
});
