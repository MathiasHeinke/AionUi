/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The inline image-model selector (MAT-1769).
 *
 * These tests pin four properties: exactly three options with the premium
 * media-control names; radio semantics (picker, never a gate); the price
 * comes from the SERVER REGISTRY handed in as data — never from a client
 * literal; and an unavailable registry degrades to an honest "price
 * unavailable" state with no digits anywhere, while the preference itself
 * stays selectable.
 */

import { cleanup, render, screen } from '@testing-library/react';
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

describe('ImageModelPill', () => {
  it('renders nothing when the conversation is not a managed EVE conversation', () => {
    render(<ImageModelPill visible={false} value='quality' onChange={vi.fn()} registry={REGISTRY} />);
    expect(screen.queryByTestId('image-model-pill')).toBeNull();
  });

  it('offers exactly three options with the premium media-control names', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    expect(screen.getByTestId('image-model-option-fast')).toHaveTextContent('Schnell');
    // AAA live finding: the fast registry display_name equals its tier label —
    // it must render ONCE, never "Schnell Schnell". Quality/MAX keep their
    // distinct registry names.
    const fastOption = screen.getByTestId('image-model-option-fast');
    expect(fastOption.querySelectorAll('.image-model-pill__model')).toHaveLength(0);
    expect(fastOption.textContent?.trim()).toBe('Schnell');
    expect(screen.getByTestId('image-model-option-quality').querySelector('.image-model-pill__model')?.textContent).toBe('Nano Banana 2');
    expect(screen.getByTestId('image-model-option-max').querySelector('.image-model-pill__model')?.textContent).toBe('GPT Image 2');
    expect(screen.getByTestId('image-model-option-quality')).toHaveTextContent('Qualität');
    expect(screen.getByTestId('image-model-option-max')).toHaveTextContent('MAX');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    // The server-pinned model names ride as subtitles on the options.
    expect(screen.getByTestId('image-model-option-quality')).toHaveTextContent('Nano Banana 2');
    expect(screen.getByTestId('image-model-option-max')).toHaveTextContent('GPT Image 2');
  });

  it('is a radiogroup picker, not a gate: radios only, no dialog, no confirm', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    expect(screen.getByRole('radiogroup')).toBeTruthy();
    expect(screen.getByTestId('image-model-option-quality')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('image-model-option-fast')).toHaveAttribute('aria-checked', 'false');
    // Radios are buttons with role=radio; a confirm/cancel pair would arrive as real buttons.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is keyboard reachable: tab moves focus onto the options', async () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={REGISTRY} />);

    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId('image-model-option-fast'));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId('image-model-option-quality'));
  });

  it('reports a selection to the caller on click only — never automatically', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ImageModelPill visible value='quality' onChange={onChange} registry={REGISTRY} />);
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('image-model-option-max'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('max');

    // The caller owns the state; the checked radio follows the value prop.
    rerender(<ImageModelPill visible value='max' onChange={onChange} registry={REGISTRY} />);
    expect(screen.getByTestId('image-model-option-max')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('image-model-pill')).toHaveAttribute('data-selected-tier', 'max');
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

  it('shows an honest unavailable state with NO literal price when the registry is unproven', () => {
    render(<ImageModelPill visible value='quality' onChange={vi.fn()} registry={null} />);

    const estimate = screen.getByTestId('image-model-pill-estimate');
    expect(estimate).toHaveAttribute('data-quote-state', 'unavailable');
    expect(estimate).toHaveTextContent('Preis aktuell nicht verfügbar');
    // No digits anywhere in the estimate — a made-up number is the failure this pins.
    expect(estimate.textContent).not.toMatch(/\d/);
    // No server-pinned model names either: nothing proven, nothing claimed.
    expect(screen.getByTestId('image-model-option-quality')).not.toHaveTextContent('Nano Banana 2');
    // …but the preference itself stays selectable.
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });
});
