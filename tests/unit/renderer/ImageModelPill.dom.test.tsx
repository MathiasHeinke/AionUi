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
 * dropdown — the registry's tier-mapped models listed with provider chips and
 * per-row registry quotes, a model pick mapping back to the TIER id the
 * per-seat preference write carries; the 1K/2K resolution dropdown filtered
 * to the selected model's tiers with auto-pick reporting; and the fail-closed
 * fallback — an unproven registry degrades to a generic tier dropdown with an
 * honest "price unavailable" line and no digits anywhere, while the
 * preference itself stays selectable.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

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
import type { CommandEveImageModelRegistry } from '@/common/config/eveImageModelRegistryCore';

/** The server-pinned registry view (CoS contract), as Main answers it. */
const REGISTRY: CommandEveImageModelRegistry = {
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
        generate_credits: { '1K': 30, '2K': 60 },
        edit_credits: { '1K': 36, '2K': 72 },
        per_input_reference_credits: 4,
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
        generate_credits: { '1K': 40, '2K': 80 },
        edit_credits: { '1K': 48, '2K': 96 },
        per_input_reference_credits: 5,
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
        generate_credits: { '1K': 120, '2K': 240 },
        edit_credits: { '1K': 144, '2K': 288 },
        per_input_reference_credits: 8,
      },
    },
  ],
};

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

    expect(screen.getByTestId('image-model-dropdown-trigger').textContent?.trim()).toBe('Nano Banana 2▾');

    // The fast registry display_name equals its tier label — it must render
    // ONCE, never "Schnell Schnell".
    rerender(<ImageModelPill visible value='fast' onChange={vi.fn()} registry={REGISTRY} />);
    expect(screen.getByTestId('image-model-dropdown-trigger').textContent?.trim()).toBe('Schnell▾');
  });

  it('lists the registry models in the Empfohlen curated section, in server order, with chips and per-row estimates', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    const list = openModelDropdown();
    expect(screen.getByTestId('image-model-section-recommended').textContent).toBe('Empfohlen');

    const entries = list.querySelectorAll('[role="option"]');
    expect([...entries].map((el) => el.getAttribute('data-testid'))).toEqual([
      'image-model-entry-fast',
      'image-model-entry-quality',
      'image-model-entry-max',
    ]);

    // Provider identity chips, derived from the server-pinned slugs.
    expect(
      screen
        .getByTestId('image-model-entry-fast')
        .querySelector('.video-quality-pill__chip')
        ?.getAttribute('data-provider')
    ).toBe('xai');
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
    expect(screen.getByTestId('image-model-entry-fast').textContent).toContain('≈ 30 Credits');
    expect(screen.getByTestId('image-model-entry-quality').textContent).toContain('≈ 40 Credits');
    expect(screen.getByTestId('image-model-entry-max').textContent).toContain('≈ 120 Credits');

    // The registry IS the curated shortlist (exactly three tier-mapped
    // models), so there is nothing behind 'Weitere anzeigen'.
    expect(screen.queryByTestId('image-model-show-more')).toBeNull();

    // The selected row carries the check + accent.
    const selected = screen.getByTestId('image-model-entry-quality');
    expect(selected.classList.contains('is-selected')).toBe(true);
    expect(selected.querySelector('.video-quality-pill__check')).not.toBeNull();
    expect(screen.getByTestId('image-model-entry-fast').querySelector('.video-quality-pill__check')).toBeNull();
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
    fireEvent.click(screen.getByTestId('image-model-entry-fast'));
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
    expect(screen.getByTestId('image-model-entry-fast').textContent).toContain('≈ 60 Credits');
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
});

describe('ImageModelPill fail-closed fallback (registry unproven)', () => {
  it('keeps one compact generic tier dropdown and shows an honest unavailable state with NO literal price', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={null} />);

    const trigger = screen.getByTestId('image-model-dropdown-trigger');
    expect(trigger).toHaveTextContent('Qualität');
    fireEvent.click(trigger);
    expect(screen.getByTestId('image-model-dropdown').querySelectorAll('[role="option"]')).toHaveLength(3);
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
