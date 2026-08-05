/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The server-owned image model registry core (MAT-1769).
 *
 * The property these tests pin is FAIL-CLOSED parsing: the composer quotes
 * prices from this registry and nothing else, so any deviation — a missing
 * tier, a renamed field, a non-integer credit — must yield `null`, never a
 * partial or assumed registry. A parser that "recovers" is a price the UI
 * invented.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_IMAGE_MODEL_REGISTRY_VERSION,
  DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER,
  commandEveImageModelProvider,
  getCommandEveImageModelTierSpec,
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
    tiers: [tierRaw('fast'), tierRaw('quality'), tierRaw('max')],
    ...overrides,
  };
}

describe('parseCommandEveImageModelRegistry', () => {
  it('parses a healthy registry view and exposes all three tiers', () => {
    const registry = parseCommandEveImageModelRegistry(registryRaw());
    expect(registry).not.toBeNull();
    expect(registry?.enabled).toBe(true);
    expect(registry?.default_tier).toBe('quality');
    expect(registry?.tiers).toHaveLength(3);
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')).toMatchObject({
      id: 'quality',
      slug: 'provider/quality-image',
      display_name: 'quality model',
      premium: false,
      supports_references: true,
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

  it('rejects a registry that cannot account for ALL THREE tiers', () => {
    // Two tiers: one option would quote nothing while looking identical.
    expect(parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('fast'), tierRaw('quality')] }))).toBeNull();
    // A duplicate plus a stranger is not three tiers either.
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [tierRaw('fast'), tierRaw('fast'), tierRaw('ultra')] }))
    ).toBeNull();
    // A FOURTH tier, even a healthy one, is a shape deviation.
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ tiers: [tierRaw('fast'), tierRaw('quality'), tierRaw('max'), tierRaw('ultra')] })
      )
    ).toBeNull();
  });

  it('rejects malformed tier payloads instead of recovering them', () => {
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ tiers: [tierRaw('fast', { slug: '' }), tierRaw('quality'), tierRaw('max')] })
      )
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ tiers: [tierRaw('fast'), tierRaw('quality', { display_name: 42 }), tierRaw('max')] })
      )
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ tiers: [tierRaw('fast'), tierRaw('quality'), tierRaw('max', { premium: 'yes' })] })
      )
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ tiers: [tierRaw('fast', { supports_references: 0 }), tierRaw('quality'), tierRaw('max')] })
      )
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ tiers: [tierRaw('fast', { resolutions: [] }), tierRaw('quality'), tierRaw('max')] })
      )
    ).toBeNull();
    expect(
      parseCommandEveImageModelRegistry(
        registryRaw({ tiers: [tierRaw('fast', { resolutions: ['4K'] }), tierRaw('quality'), tierRaw('max')] })
      )
    ).toBeNull();
  });

  it('rejects non-integer, negative, missing, or incomplete credit quotes', () => {
    const fractional = tierRaw('fast');
    fractional.quotes.generate_credits = { '1K': 29.5, '2K': 60 };
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [fractional, tierRaw('quality'), tierRaw('max')] }))
    ).toBeNull();

    const negative = tierRaw('fast');
    negative.quotes.edit_credits = { '1K': -1, '2K': 72 };
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [negative, tierRaw('quality'), tierRaw('max')] }))
    ).toBeNull();

    const missing2K = tierRaw('fast');
    missing2K.quotes.generate_credits = { '1K': 30 } as unknown as { '1K': number; '2K': number };
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [missing2K, tierRaw('quality'), tierRaw('max')] }))
    ).toBeNull();

    // per_input_reference_credits is part of the contract — absent is a deviation.
    const missingPerRef = tierRaw('fast');
    delete (missingPerRef.quotes as Record<string, unknown>).per_input_reference_credits;
    expect(
      parseCommandEveImageModelRegistry(registryRaw({ tiers: [missingPerRef, tierRaw('quality'), tierRaw('max')] }))
    ).toBeNull();
  });

  // ── CROSS-WIRE FIXTURE (MAT-1769, CoS contract) ──────────────────────────
  // Mirrors the serialized view served by
  //   GET {EVE_MULTIMODAL_FUNCTION_URL}/image-model-capabilities
  // from supabase/functions/eve-multimodal/image-model-registry.ts
  // (`publicImageModelCapabilities` over IMAGE_MODEL_REGISTRY, prices as pinned
  // 2026-08-02: fast USD 0.05 / quality USD 0.15 / max USD 0.25 per image at
  //  standard 10x markup, FX 0.92, 10 credits per EUR cent → usdCents × 92).
  // The server worktree pins no literal fixture FILE for this body (its tests
  // derive the view from the registry), so this literal is the client-side
  // pin. TODO-sync: if the server adds a canonical fixture, mirror its text
  // here verbatim.
  it('accepts the canonical gateway GET response verbatim', () => {
    const canonicalGatewayResponse = {
      version: 'command-eve-image-model-registry/v1',
      enabled: true,
      default_tier: 'quality',
      tiers: [
        {
          id: 'fast',
          slug: 'x-ai/grok-imagine-image-quality',
          display_name: 'Schnell',
          premium: false,
          supports_references: false,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 460, '2K': 644 },
            edit_credits: { '1K': 460, '2K': 644 },
            per_input_reference_credits: 0,
          },
        },
        {
          id: 'quality',
          slug: 'google/gemini-3.1-flash-image',
          display_name: 'Nano Banana 2',
          premium: false,
          supports_references: true,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 1380, '2K': 1380 },
            edit_credits: { '1K': 1380, '2K': 1380 },
            per_input_reference_credits: 0,
          },
        },
        {
          id: 'max',
          slug: 'openai/gpt-image-2',
          display_name: 'GPT Image 2',
          premium: true,
          supports_references: false,
          resolutions: ['1K', '2K'],
          quotes: {
            generate_credits: { '1K': 2300, '2K': 2300 },
            edit_credits: { '1K': 2300, '2K': 2300 },
            per_input_reference_credits: 0,
          },
        },
      ],
    };

    const registry = parseCommandEveImageModelRegistry(canonicalGatewayResponse);
    expect(registry).not.toBeNull();
    expect(registry?.tiers.map((tier) => tier.id)).toEqual(['fast', 'quality', 'max']);
    expect(getCommandEveImageModelTierSpec(registry!, 'fast')?.display_name).toBe('Schnell');
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')?.display_name).toBe('Nano Banana 2');
    expect(getCommandEveImageModelTierSpec(registry!, 'max')?.display_name).toBe('GPT Image 2');
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')?.quotes.generate_credits).toEqual({
      '1K': 1380,
      '2K': 1380,
    });
    expect(getCommandEveImageModelTierSpec(registry!, 'max')?.quotes.edit_credits['1K']).toBe(2300);
    expect(getCommandEveImageModelTierSpec(registry!, 'quality')?.supports_references).toBe(true);
    expect(getCommandEveImageModelTierSpec(registry!, 'fast')?.supports_references).toBe(false);
  });
});

describe('tier id normalization', () => {
  it('accepts exactly the three known tier ids', () => {
    expect(isCommandEveImageModelTierId('fast')).toBe(true);
    expect(isCommandEveImageModelTierId('quality')).toBe(true);
    expect(isCommandEveImageModelTierId('max')).toBe(true);
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
});

describe('catalog presentation helpers (MAT-1773 PACKAGE A)', () => {
  it('curates the registry’s own tiers in server order — never an invented model', () => {
    const registry = parseCommandEveImageModelRegistry(registryRaw())!;
    expect(resolveImageModelCuratedTiers(registry).map((tier) => tier.id)).toEqual(['fast', 'quality', 'max']);
    // The shortlist IS the registry, so nothing is left for 'Alle Modelle'.
    expect(listImageModelsBeyondCurated(registry)).toEqual([]);
  });

  it('keeps the curated shortlist in SERVER order, not tier-id order', () => {
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({ tiers: [tierRaw('max'), tierRaw('fast'), tierRaw('quality')] })
    )!;
    expect(resolveImageModelCuratedTiers(registry).map((tier) => tier.id)).toEqual(['max', 'fast', 'quality']);
  });

  it('derives the provider chip identity from the server-pinned slug vendor', () => {
    const registry = parseCommandEveImageModelRegistry(
      registryRaw({
        tiers: [
          tierRaw('fast', { slug: 'x-ai/grok-imagine-image-quality' }),
          tierRaw('quality', { slug: 'google/gemini-3.1-flash-image' }),
          tierRaw('max', { slug: 'openai/gpt-image-2' }),
        ],
      })
    )!;
    const byVendor = Object.fromEntries(registry.tiers.map((tier) => [tier.id, commandEveImageModelProvider(tier)]));
    expect(byVendor.fast).toEqual({ key: 'xai', label: 'xAI' });
    expect(byVendor.quality).toEqual({ key: 'google', label: 'Google' });
    expect(byVendor.max).toEqual({ key: 'openai', label: 'OpenAI' });
  });
});
