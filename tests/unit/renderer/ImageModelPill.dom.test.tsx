/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The inline image-model selector (MAT-1769; dropdown idiom since MAT-1773
 * PACKAGE A).
 *
 * These tests pin: with a proven registry the picker is the SHARED media-model
 * dropdown — the SERVER-RANKED shortlist ('Empfohlen', four models since the
 * 2026-08-18 catalog) with everything else behind 'Weitere anzeigen', provider
 * chips and per-row registry quotes, a model pick mapping back to the TIER id the
 * per-seat preference write carries; the 1K/2K resolution dropdown filtered
 * to the selected model's tiers with auto-pick reporting; and the fail-closed
 * fallback — an unproven registry degrades to a generic tier dropdown with an
 * honest "price unavailable" line and no digits anywhere, while the
 * preference itself stays selectable.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const { imageCapabilitiesInvokeMock, imageModelPreferenceReadInvokeMock, imageModelPreferenceSetInvokeMock } =
  vi.hoisted(() => ({
    imageCapabilitiesInvokeMock: vi.fn(),
    imageModelPreferenceReadInvokeMock: vi.fn(),
    imageModelPreferenceSetInvokeMock: vi.fn(),
  }));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      imageCapabilities: { invoke: imageCapabilitiesInvokeMock },
      imageModelPreferenceRead: { invoke: imageModelPreferenceReadInvokeMock },
      imageModelPreferenceSet: { invoke: imageModelPreferenceSetInvokeMock },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown>) => {
      let s = (o?.defaultValue as string) ?? _k;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{${key}}}`, 'g'), String(val));
        }
      }
      return s;
    },
  }),
}));

import ImageModelPill from '@/renderer/components/billing/ImageModelPill';
import { useImageComposerSelection } from '@/renderer/components/billing/useImageComposerSelection';
import type { CommandEveImageModelRegistry } from '@/common/config/eveImageModelRegistryCore';

/**
 * The server-pinned registry view (CoS contract), as Main answers it: SEVEN
 * models, four of them server-ranked into the curated shortlist. Prices are
 * test values, deliberately not the live ones — this file pins BEHAVIOUR, and
 * the price contract belongs to the registry core's cross-wire fixture.
 */
const tier = (
  id: string,
  overrides: Partial<CommandEveImageModelRegistry['tiers'][number]> = {}
): CommandEveImageModelRegistry['tiers'][number] =>
  ({
    id,
    slug: `provider/${id}`,
    display_name: id,
    premium: false,
    supports_references: true,
    curated_rank: null,
    max_reference_images: 14,
    honors_resolution: true,
    resolutions: ['1K', '2K'],
    quotes: {
      generate_credits: { '1K': 30, '2K': 60 },
      edit_credits: { '1K': 36, '2K': 72 },
      per_input_reference_credits: 4,
    },
    ...overrides,
  }) as CommandEveImageModelRegistry['tiers'][number];

const REGISTRY: CommandEveImageModelRegistry = {
  version: 'command-eve-image-model-registry/v1',
  enabled: true,
  default_tier: 'quality',
  tiers: [
    tier('quality', {
      slug: 'google/gemini-3.1-flash-image',
      display_name: 'Nano Banana 2',
      curated_rank: 1,
      quotes: {
        generate_credits: { '1K': 40, '2K': 80 },
        edit_credits: { '1K': 48, '2K': 96 },
        per_input_reference_credits: 5,
      },
    }),
    tier('quality-pro', {
      slug: 'google/gemini-3-pro-image',
      display_name: 'Nano Banana Pro',
      curated_rank: 2,
      quotes: {
        generate_credits: { '1K': 90, '2K': 180 },
        edit_credits: { '1K': 99, '2K': 198 },
        per_input_reference_credits: 0,
      },
    }),
    tier('max', {
      slug: 'openai/gpt-image-2',
      display_name: 'GPT Image 2',
      premium: true,
      curated_rank: 3,
      max_reference_images: 16,
      quotes: {
        generate_credits: { '1K': 120, '2K': 240 },
        edit_credits: { '1K': 144, '2K': 288 },
        per_input_reference_credits: 8,
      },
    }),
    tier('seedream-pro', {
      slug: 'bytedance-seed/seedream-5-0-pro',
      display_name: 'Seedream 5 Pro',
      curated_rank: 4,
      quotes: {
        generate_credits: { '1K': 25, '2K': 50 },
        edit_credits: { '1K': 30, '2K': 60 },
        per_input_reference_credits: 0,
      },
    }),
    // Behind 'Weitere anzeigen' — no curated rank.
    tier('grok-2', {
      slug: 'x-ai/grok-imagine-image-2.0',
      display_name: 'Grok Imagine 2',
      max_reference_images: 3,
      quotes: {
        generate_credits: { '1K': 55, '2K': 70 },
        edit_credits: { '1K': 55, '2K': 70 },
        per_input_reference_credits: 9,
      },
    }),
    tier('seedream-lite', {
      slug: 'bytedance-seed/seedream-5-0-lite',
      display_name: 'Seedream 5 Lite',
      // PRICED AT BOTH, OFFERED AT ONE: its images route advertises 2K/4K and
      // no 1K. A 1K order would have been reserved, debited and never
      // delivered — so the offer, not the price table, drives the UI.
      resolutions: ['2K'],
      quotes: {
        // The two columns DIFFER on purpose: a row that quoted the phantom 1K
        // column would print 99 and the assertion below would catch it.
        generate_credits: { '1K': 99, '2K': 20 },
        edit_credits: { '1K': 99, '2K': 24 },
        per_input_reference_credits: 0,
      },
    }),
    tier('qwen-3', {
      slug: 'qwen/qwen-image-3',
      display_name: 'Qwen Image 3',
      quotes: {
        generate_credits: { '1K': 15, '2K': 15 },
        edit_credits: { '1K': 18, '2K': 18 },
        per_input_reference_credits: 0,
      },
    }),
  ],
};

/** Only two models accept references — the edit picker must show exactly those. */
const EDIT_REGISTRY: CommandEveImageModelRegistry = {
  ...REGISTRY,
  tiers: REGISTRY.tiers.map((entry) =>
    entry.id === 'quality' || entry.id === 'max' ? entry : { ...entry, supports_references: false }
  ),
};

beforeEach(() => {
  imageCapabilitiesInvokeMock.mockReset();
  imageModelPreferenceReadInvokeMock.mockReset();
  imageModelPreferenceSetInvokeMock.mockReset();
  imageCapabilitiesInvokeMock.mockResolvedValue({
    success: true,
    data: { ok: true, registry: REGISTRY, revision: 'f'.repeat(64) },
  });
  imageModelPreferenceReadInvokeMock.mockResolvedValue({
    success: true,
    data: {
      status: 'resolved',
      seatId: 'seat-1',
      tier: 'quality',
      source: 'stored_explicit',
      physicalKey: 'commandEve.imageModelPreference',
    },
  });
});

afterEach(cleanup);

const openModelDropdown = () => {
  fireEvent.click(screen.getByTestId('image-model-dropdown-trigger'));
  return screen.getByTestId('image-model-dropdown');
};

describe('ImageModelPill model dropdown (MAT-1773 PACKAGE A)', () => {
  it('renders nothing when the conversation is not a managed EVE conversation', () => {
    render(<ImageModelPill visible={false} value='quality' onChange={vi.fn()} registry={REGISTRY} />);
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
  });

  it('shows only the concise registry model name on the trigger', () => {
    const { rerender } = render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);
    const trigger = screen.getByTestId('image-model-dropdown-trigger');

    expect(trigger.textContent?.trim()).toBe('Nano Banana 2');
    expect(trigger.querySelector('.video-quality-pill__chevron')).toHaveAttribute('aria-hidden', 'true');
    expect(trigger.querySelector('.video-quality-pill__chevron svg')).not.toBeNull();

    // An expandable (non-curated) model is still a legitimate selection and
    // names itself on the trigger exactly once.
    rerender(<ImageModelPill visible value='grok-2' onChange={vi.fn()} registry={REGISTRY} />);
    expect(screen.getByTestId('image-model-dropdown-trigger').textContent?.trim()).toBe('Grok Imagine 2');
  });

  it('recommends EXACTLY FOUR models and hides the rest behind "Weitere anzeigen"', () => {
    // THE FOUNDER'S ASK, pinned: "wie bei video 4 modelle kuratiert
    // vorschlagen rest ausklappbar".
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    const list = openModelDropdown();
    expect(screen.getByTestId('image-model-section-recommended').textContent).toBe('Empfohlen');

    // Four rows, in the SERVER's curated_rank order — not array order, not
    // price order.
    expect([...list.querySelectorAll('[role="option"]')].map((el) => el.getAttribute('data-testid'))).toEqual([
      'image-model-entry-quality',
      'image-model-entry-quality-pro',
      'image-model-entry-max',
      'image-model-entry-seedream-pro',
    ]);

    // The other three are NOT rendered until asked for.
    expect(screen.queryByTestId('image-model-entry-grok-2')).toBeNull();
    expect(screen.queryByTestId('image-model-entry-seedream-lite')).toBeNull();
    expect(screen.queryByTestId('image-model-entry-qwen-3')).toBeNull();
    expect(screen.queryByTestId('image-model-section-all')).toBeNull();

    // One click reveals the rest, cheapest first, in the SAME dropdown.
    fireEvent.click(screen.getByTestId('image-model-show-more'));
    expect(screen.getByTestId('image-model-section-all')).toBeTruthy();
    expect(
      [...screen.getByTestId('image-model-dropdown').querySelectorAll('[role="option"]')].map((el) =>
        el.getAttribute('data-testid')
      )
    ).toEqual([
      'image-model-entry-quality',
      'image-model-entry-quality-pro',
      'image-model-entry-max',
      'image-model-entry-seedream-pro',
      // rest: 15 < 20 < 55 credits at 1K
      'image-model-entry-qwen-3',
      'image-model-entry-seedream-lite',
      'image-model-entry-grok-2',
    ]);
    // No model appears twice once everything is visible.
    const ids = [...screen.getByTestId('image-model-dropdown').querySelectorAll('[role="option"]')].map((el) =>
      el.getAttribute('data-testid')
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists the curated models with chips and per-row estimates', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    openModelDropdown();

    // Provider identity chips, derived from the server-pinned slugs.
    expect(
      screen
        .getByTestId('image-model-entry-seedream-pro')
        .querySelector('.video-quality-pill__chip')
        ?.getAttribute('data-provider')
    ).toBe('bytedanceseed');
    expect(
      screen
        .getByTestId('image-model-entry-quality')
        .querySelector('.video-quality-pill__chip')
        ?.getAttribute('data-provider')
    ).toBe('google');
    expect(
      screen
        .getByTestId('image-model-entry-max')
        .querySelector('.video-quality-pill__chip')
        ?.getAttribute('data-provider')
    ).toBe('openai');

    // Per-row estimates quote the REGISTRY's generate_credits at the current
    // resolution tier (1K by default) — never a client-fabricated number.
    expect(screen.getByTestId('image-model-entry-quality').textContent).toContain('≈ 40 Credits');
    expect(screen.getByTestId('image-model-entry-quality-pro').textContent).toContain('≈ 90 Credits');
    expect(screen.getByTestId('image-model-entry-max').textContent).toContain('≈ 120 Credits');
    expect(screen.getByTestId('image-model-entry-seedream-pro').textContent).toContain('≈ 25 Credits');

    // The selected row carries the check + accent.
    const selected = screen.getByTestId('image-model-entry-quality');
    expect(selected.classList.contains('is-selected')).toBe(true);
    expect(selected.querySelector('.video-quality-pill__check')).not.toBeNull();
    expect(screen.getByTestId('image-model-entry-max').querySelector('.video-quality-pill__check')).toBeNull();
  });

  it('maps a model pick back to the TIER id the registry defines — the value the preference write carries', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ImageModelPill visible value='quality' onChange={onChange} registry={REGISTRY} />);
    expect(onChange).not.toHaveBeenCalled();

    openModelDropdown();
    await userEvent.click(screen.getByTestId('image-model-entry-max'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('max');

    // The caller owns the state; the selection follows the value prop.
    rerender(<ImageModelPill visible value='max' onChange={onChange} registry={REGISTRY} />);
    expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-selected-tier', 'max');
    expect(screen.getByTestId('image-model-dropdown-trigger').textContent).toContain('GPT Image 2');
  });

  it('closes the dropdown with the shared exit motion on a pick and on an outside click', async () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    openModelDropdown();
    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId('image-model-dropdown')).toHaveAttribute('data-state', 'closing');
    await waitFor(() => expect(screen.queryByTestId('image-model-dropdown')).toBeNull());

    const list = openModelDropdown();
    expect(list.isConnected).toBe(true);
    fireEvent.click(screen.getByTestId('image-model-entry-max'));
    expect(screen.getByTestId('image-model-dropdown')).toHaveAttribute('data-state', 'closing');
    await waitFor(() => expect(screen.queryByTestId('image-model-dropdown')).toBeNull());
  });

  it('is a picker, not a gate: no dialog, no confirm', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);
    openModelDropdown();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('quotes the SELECTED tier from the server registry data', () => {
    const { rerender } = render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);
    // quality: 40 credits (1K), 80 (2K) — straight from the registry fixture.
    expect(screen.getByTestId('image-model-pill-estimate')).toHaveTextContent('40');
    expect(screen.getByTestId('image-model-pill-estimate')).toHaveTextContent('80');
    expect(screen.getByTestId('image-model-pill-estimate')).toHaveAttribute('data-quote-state', 'available');

    rerender(<ImageModelPill visible value='max' onChange={vi.fn()} registry={REGISTRY} />);
    expect(screen.getByTestId('image-model-pill-estimate')).toHaveTextContent('120');
    expect(screen.getByTestId('image-model-pill-estimate')).toHaveTextContent('240');
  });
});

describe('ImageModelPill edit dropdown', () => {
  it('offers exactly the registry-declared reference models and quotes base plus one source image', async () => {
    const onChange = vi.fn();
    render(<ImageModelPill visible value='quality' onChange={onChange} registry={EDIT_REGISTRY} operation='edit' />);

    const estimate = screen.getByTestId('image-model-pill-estimate');
    expect(estimate).toHaveTextContent('53');
    expect(estimate).toHaveTextContent('101');
    expect(estimate).not.toHaveTextContent('40');
    expect(estimate).not.toHaveTextContent('80');
    expect(estimate).toHaveAttribute('data-credits-1k', '53');
    expect(estimate).toHaveAttribute('data-credits-2k', '101');
    expect(estimate).toHaveAttribute('data-reference-surcharge', '5');
    expect(estimate).toHaveAttribute('data-priced-reference-count', '1');

    openModelDropdown();
    const entries = screen.getByTestId('image-model-dropdown').querySelectorAll('[role="option"]');
    expect([...entries].map((entry) => entry.getAttribute('data-testid'))).toEqual([
      'image-model-entry-quality',
      'image-model-entry-max',
    ]);
    // Curated models that cannot take references are gone from edit mode too.
    expect(screen.queryByTestId('image-model-entry-quality-pro')).toBeNull();
    expect(screen.queryByTestId('image-model-entry-seedream-pro')).toBeNull();
    expect(screen.getByTestId('image-model-entry-quality')).toHaveTextContent('≈ 53 Credits');
    expect(screen.getByTestId('image-model-entry-max')).toHaveTextContent('≈ 152 Credits');

    await userEvent.click(screen.getByTestId('image-model-entry-max'));
    expect(onChange).toHaveBeenCalledWith('max');

    fireEvent.click(screen.getByTestId('image-resolution-dropdown-trigger'));
    expect(screen.getByTestId('image-resolution-option-1K')).toHaveTextContent('≈ 53 Credits');
    expect(screen.getByTestId('image-resolution-option-2K')).toHaveTextContent('≈ 101 Credits');
  });

  it('prices exactly the one source image, not the advisory attachment count', () => {
    render(
      <ImageModelPill
        visible
        value='grok-2'
        onChange={vi.fn()}
        registry={REGISTRY}
        operation='edit'
        referenceCount={3}
      />
    );

    const estimate = screen.getByTestId('image-model-pill-estimate');
    expect(estimate).toHaveTextContent('64');
    expect(estimate).toHaveTextContent('79');
    expect(estimate).not.toHaveTextContent('82');
    expect(estimate).toHaveAttribute('data-priced-reference-count', '1');
  });
});

describe('useImageComposerSelection edit isolation', () => {
  it('does not mutate or persist the create preference for an edit-only tier choice', async () => {
    const { result } = renderHook(() => useImageComposerSelection());
    await waitFor(() => expect(result.current.registry).toEqual(REGISTRY));
    expect(result.current.tierId).toBe('quality');

    act(() => result.current.setTierId('max', { persist: false }));

    expect(result.current.tierId).toBe('quality');
    expect(imageModelPreferenceSetInvokeMock).not.toHaveBeenCalled();
  });
});

describe('ImageModelPill reference ceiling (max_reference_images)', () => {
  it('lands a 1K seat on 2K when a 2K-ONLY model is picked, and reports it', () => {
    // THE PRE-DEBIT TRAP (server note, 2026-08-18): seedream-lite is priced at
    // both resolutions but only OFFERS 2K. A composer left on 1K would have
    // sent a 1K order that gets reserved, debited and never delivered. The
    // control must converge to a resolution the model actually serves, SHOW
    // that, and report it upward — never sit in an invalid state.
    const onResolutionChange = vi.fn();
    render(
      <ImageModelPill
        visible
        value='seedream-lite'
        onChange={vi.fn()}
        registry={REGISTRY}
        resolution='1K'
        onResolutionChange={onResolutionChange}
      />
    );

    expect(onResolutionChange).toHaveBeenCalledWith('2K');
    expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-resolution', '2K');
    // A single-offer model needs no resolution switch at all: a control whose
    // only option is the current one is a choice that is not a choice.
    expect(screen.queryByTestId('image-resolution-dropdown-trigger')).toBeNull();
  });

  it('quotes a 2K-only model at the resolution it actually serves', () => {
    // The row must not quote the 1K column of a price table whose 1K offer
    // does not exist.
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);
    openModelDropdown();
    fireEvent.click(screen.getByTestId('image-model-show-more'));
    expect(screen.getByTestId('image-model-entry-seedream-lite').textContent).toContain('≈ 20 Credits');
  });

  it('carries the SELECTED model’s ceiling so the composer can warn BEFORE sending', () => {
    const { rerender } = render(
      <ImageModelPill visible value='max' onChange={vi.fn()} registry={REGISTRY} operation='edit' referenceCount={2} />
    );
    const pill = () => screen.getByTestId('image-model-pill');

    // THE NUMBER SHOWN IS THE ONE THAT BINDS, NOT THE ONE THE MODEL BOASTS.
    // GPT Image 2 advertises 16 references, but this lane caps every model at
    // four — enforced in the bridge policy, the artifact bridge, the managed
    // image service and, authoritatively, the gateway's parse before any
    // reserve. Rendering 16 would promise a fifth reference that is refused
    // four layers down; the pill therefore reports 4 and says WHAT bound it.
    expect(pill()).toHaveAttribute('data-reference-ceiling', '4');
    expect(pill()).toHaveAttribute('data-reference-ceiling-bound-by', 'lane');
    expect(pill()).not.toHaveAttribute('data-references-over-ceiling');

    // Grok takes only 3 — TIGHTER than the lane cap, so here the model is the
    // binding limit and the distinction is real rather than decorative. The
    // SAME two references are still fine…
    rerender(
      <ImageModelPill
        visible
        value='grok-2'
        onChange={vi.fn()}
        registry={REGISTRY}
        operation='edit'
        referenceCount={2}
      />
    );
    expect(pill()).toHaveAttribute('data-reference-ceiling', '3');
    expect(pill()).toHaveAttribute('data-reference-ceiling-bound-by', 'model');
    expect(pill()).not.toHaveAttribute('data-references-over-ceiling');

    // …but a fourth is already over grok's line, and that is visible while the
    // user can still fix it — not as a refusal after sending. Four is the
    // ONLY count at which the two limits disagree, which is exactly why the
    // model ceiling still has to travel.
    rerender(
      <ImageModelPill
        visible
        value='grok-2'
        onChange={vi.fn()}
        registry={REGISTRY}
        operation='edit'
        referenceCount={4}
      />
    );
    expect(pill()).toHaveAttribute('data-references-over-ceiling', 'true');

    // SHARPNESS: the same four references on a model whose ceiling exceeds the
    // lane cap are NOT over the line. Without this the assertion above would
    // also pass if the flag had simply latched on.
    rerender(
      <ImageModelPill visible value='max' onChange={vi.fn()} registry={REGISTRY} operation='edit' referenceCount={4} />
    );
    expect(pill()).not.toHaveAttribute('data-references-over-ceiling');
  });

  it('claims NO ceiling when the registry proved none', () => {
    // Without a registry there is nothing to promise…
    const { rerender } = render(
      <ImageModelPill visible value='quality' onChange={vi.fn()} registry={null} referenceCount={9} />
    );
    expect(screen.getByTestId('image-model-pill')).not.toHaveAttribute('data-reference-ceiling');
    expect(screen.getByTestId('image-model-pill')).not.toHaveAttribute('data-references-over-ceiling');

    // …and a gateway that predates the field (null ceiling) is silent too,
    // rather than guessing a number the user would read as a promise.
    const olderGateway: CommandEveImageModelRegistry = {
      ...REGISTRY,
      tiers: REGISTRY.tiers.map((entry) => (entry.id === 'quality' ? { ...entry, max_reference_images: null } : entry)),
    };
    rerender(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={olderGateway} referenceCount={9} />);
    expect(screen.getByTestId('image-model-pill')).not.toHaveAttribute('data-reference-ceiling');
    expect(screen.getByTestId('image-model-pill')).not.toHaveAttribute('data-references-over-ceiling');
  });
});

describe('ImageModelPill resolution dropdown (1K/2K tiers)', () => {
  it('offers the selected model’s resolution tiers with per-option registry estimates', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    expect(screen.getByTestId('image-resolution-dropdown-trigger').textContent).toContain('Standard');

    fireEvent.click(screen.getByTestId('image-resolution-dropdown-trigger'));
    const options = screen.getByTestId('image-resolution-dropdown').querySelectorAll('[role="option"]');
    expect([...options].map((el) => el.getAttribute('data-testid'))).toEqual([
      'image-resolution-option-1K',
      'image-resolution-option-2K',
    ]);
    // quality: 40 credits (1K), 80 (2K) — the registry's own quotes.
    expect(screen.getByTestId('image-resolution-option-1K').textContent).toContain('≈ 40 Credits');
    expect(screen.getByTestId('image-resolution-option-2K').textContent).toContain('≈ 80 Credits');
  });

  it('reports a resolution pick and re-quotes the model rows at the new tier', async () => {
    const onResolutionChange = vi.fn();
    render(
      <ImageModelPill
        visible
        value='quality'
        onChange={vi.fn()}
        registry={REGISTRY}
        onResolutionChange={onResolutionChange}
      />
    );

    fireEvent.click(screen.getByTestId('image-resolution-dropdown-trigger'));
    await userEvent.click(screen.getByTestId('image-resolution-option-2K'));

    expect(onResolutionChange).toHaveBeenCalledWith('2K');
    expect(screen.getByTestId('image-resolution-dropdown-trigger').textContent).toContain('Hoch');
    expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-resolution', '2K');

    // The model rows now quote the 2K generate credits.
    openModelDropdown();
    expect(screen.getByTestId('image-model-entry-quality').textContent).toContain('≈ 80 Credits');
    expect(screen.getByTestId('image-model-entry-max').textContent).toContain('≈ 240 Credits');
  });

  it('auto-picks the model’s first tier when the current resolution is unsupported, and reports it', () => {
    const restricted: CommandEveImageModelRegistry = {
      ...REGISTRY,
      tiers: REGISTRY.tiers.map((tier) =>
        tier.id === 'quality' ? Object.assign({}, tier, { resolutions: ['2K'] as const }) : tier
      ),
    };
    const onResolutionChange = vi.fn();
    render(
      <ImageModelPill
        visible
        value='quality'
        onChange={vi.fn()}
        registry={restricted}
        onResolutionChange={onResolutionChange}
      />
    );

    // 1K is unselectable on this model — the pick converges to 2K, shown and
    // reported, never a late error.
    expect(onResolutionChange).toHaveBeenCalledWith('2K');
    expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-resolution', '2K');
    // A single-tier model needs no resolution dropdown.
    expect(screen.queryByTestId('image-resolution-dropdown-trigger')).toBeNull();
  });

  it('offers no resolution control for a model whose provider does not take one', () => {
    // THE DEAD SWITCH (live, 2026-08-18). gpt-image-2's single endpoint
    // advertises aspect_ratio, quality, background, n, input_references and
    // output_compression — and NO `resolution` at any value. The lane still
    // sends one and the model sizes at its own discretion, so the control was
    // a choice that decided nothing.
    //
    // The tier still LISTS both resolutions: hiding the switch is a statement
    // about the parameter, not about the capability. Which is exactly why the
    // registry carries `honors_resolution` instead of narrowing `resolutions`
    // — a narrowed list would claim 1K is impossible, and it is not.
    const deadSwitch: CommandEveImageModelRegistry = {
      ...REGISTRY,
      tiers: REGISTRY.tiers.map((entry) =>
        entry.id === 'max' ? Object.assign({}, entry, { honors_resolution: false }) : entry
      ),
    };
    const onResolutionChange = vi.fn();
    render(
      <ImageModelPill
        visible
        value='max'
        onChange={vi.fn()}
        registry={deadSwitch}
        resolution='1K'
        onResolutionChange={onResolutionChange}
      />
    );

    expect(screen.queryByTestId('image-resolution-dropdown-trigger')).toBeNull();
    // AND THE VALUE IS LEFT ALONE. Hiding a control must not silently move the
    // state behind it: the seat stays on 1K, nothing is reported upward, and
    // the request body is byte-identical to before this field existed.
    expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-resolution', '1K');
    expect(onResolutionChange).not.toHaveBeenCalled();

    // SHARPNESS CONTROL, in the same test so the two cannot drift apart: the
    // SAME registry with the flag true keeps the switch. Without this line the
    // assertion above would also pass if the control had disappeared for some
    // unrelated reason.
    cleanup();
    render(<ImageModelPill visible value='max' onChange={vi.fn()} registry={REGISTRY} resolution='1K' />);
    expect(screen.getByTestId('image-resolution-dropdown-trigger')).not.toBeNull();
  });

  it('keeps the resolution control on a gateway that never sent honors_resolution', () => {
    // A FIELD THAT CAN ONLY REMOVE A CONTROL MUST DEFAULT TO PRESENT. The
    // parser reads an omitted flag as `true`; this pins the consequence at the
    // surface the user actually sees, so nobody can "harden" that default into
    // fail-closed and quietly strip the switch from every model on an older
    // gateway.
    const olderGateway = {
      ...REGISTRY,
      tiers: REGISTRY.tiers.map((entry) => {
        const withoutFlag = { ...entry } as Record<string, unknown>;
        delete withoutFlag.honors_resolution;
        return withoutFlag as CommandEveImageModelRegistry['tiers'][number];
      }),
    };
    render(<ImageModelPill visible value='max' onChange={vi.fn()} registry={olderGateway} resolution='1K' />);
    expect(screen.getByTestId('image-resolution-dropdown-trigger')).not.toBeNull();
  });
});

describe('ImageModelPill fail-closed fallback (registry unproven)', () => {
  it('keeps one compact generic tier dropdown and shows an honest unavailable state with NO literal price', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={null} />);

    const trigger = screen.getByTestId('image-model-dropdown-trigger');
    expect(trigger).toHaveTextContent('Qualität');
    fireEvent.click(trigger);
    // ONLY the tiers this client can name from its own approved copy. Listing
    // all seven would mean announcing vendor models (Seedream, Qwen, Grok)
    // the client has NOT proven the server offers — the same invention this
    // component refuses for prices.
    expect(screen.getByTestId('image-model-dropdown').querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(screen.queryByTestId('image-model-option-seedream-pro')).toBeNull();
    expect(screen.queryByTestId('image-model-option-grok-2')).toBeNull();
    expect(screen.getByTestId('image-model-option-quality')).toHaveAttribute('aria-selected', 'true');

    const estimate = screen.getByTestId('image-model-pill-estimate');
    expect(estimate).toHaveAttribute('data-quote-state', 'unavailable');
    expect(estimate).toHaveTextContent('Preis aktuell nicht verfügbar');
    // No digits anywhere in the estimate — a made-up number is the failure this pins.
    expect(estimate.textContent).not.toMatch(/\d/);
    // No server-pinned model names either: nothing proven, nothing claimed.
    expect(screen.getByTestId('image-model-option-quality')).not.toHaveTextContent('Nano Banana 2');
  });

  it('keeps the preference itself selectable in the fallback', async () => {
    const onChange = vi.fn();
    render(<ImageModelPill visible value='quality' onChange={onChange} registry={null} />);

    fireEvent.click(screen.getByTestId('image-model-dropdown-trigger'));
    await userEvent.click(screen.getByTestId('image-model-option-max'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('max');
  });
});
