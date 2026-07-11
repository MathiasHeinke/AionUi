/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVE_VISUAL_PREFERENCES,
  EVE_ACCENTS,
  eveVisualCssVariables,
  normalizeEveVisualPreferences,
} from '@/renderer/theme/visualPreferences';

const relativeLuminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const contrastRatio = (first: string, second: string): number => {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
};

describe('normalizeEveVisualPreferences', () => {
  it('returns safe defaults for malformed input', () => {
    expect(normalizeEveVisualPreferences(null)).toEqual(DEFAULT_EVE_VISUAL_PREFERENCES);
    expect(normalizeEveVisualPreferences(['not', 'a', 'config'])).toEqual(DEFAULT_EVE_VISUAL_PREFERENCES);
  });

  it('clamps every public numeric control to its readability bounds', () => {
    const normalized = normalizeEveVisualPreferences({
      glassOpacity: -4,
      glassBlur: 200,
      background: { intensity: 0, blur: -8, dim: 4 },
    });

    expect(normalized.glassOpacity).toBe(0.72);
    expect(normalized.glassBlur).toBe(28);
    expect(normalized.background).toMatchObject({ intensity: 0.2, blur: 0, dim: 0.6 });
  });

  it('drops invalid enums and non-finite values independently', () => {
    const normalized = normalizeEveVisualPreferences({
      mode: 'sepia',
      accent: 'purple',
      glassOpacity: Number.NaN,
      background: { fit: 'stretch', intensity: Number.POSITIVE_INFINITY },
    });

    expect(normalized.mode).toBe('system');
    expect(normalized.accent).toBe('blue');
    expect(normalized.background.fit).toBe('cover');
    expect(normalized.background.intensity).toBe(DEFAULT_EVE_VISUAL_PREFERENCES.background.intensity);
  });

  it('preserves valid values and normalizes the local asset id', () => {
    const normalized = normalizeEveVisualPreferences({
      mode: 'dark',
      accent: 'petrol',
      glassOpacity: 0.8,
      glassBlur: 14,
      reducedEffects: true,
      background: {
        enabled: true,
        assetId: '  local-asset-42  ',
        fit: 'contain',
        intensity: 0.7,
        blur: 6,
        dim: 0.25,
        adaptiveTint: false,
      },
    });

    expect(normalized).toMatchObject({
      mode: 'dark',
      accent: 'petrol',
      glassOpacity: 0.8,
      glassBlur: 14,
      reducedEffects: true,
    });
    expect(normalized.background).toEqual({
      enabled: true,
      assetId: 'local-asset-42',
      fit: 'contain',
      intensity: 0.7,
      blur: 6,
      dim: 0.25,
      adaptiveTint: false,
    });
  });

  it('rejects filesystem paths and other non-opaque background asset ids', () => {
    for (const assetId of ['/Users/example/background.jpg', '../background.jpg', 'file:///tmp/background.jpg']) {
      expect(normalizeEveVisualPreferences({ background: { assetId } }).background.assetId).toBeUndefined();
    }
  });
});

describe('eveVisualCssVariables', () => {
  it('projects the default light glass tiers without forcing the background readability floor', () => {
    const tokens = eveVisualCssVariables(DEFAULT_EVE_VISUAL_PREFERENCES, 'light');

    expect(tokens['--eve-glass-chrome-opacity']).toBe('84%');
    expect(tokens['--eve-glass-panel-opacity']).toBe('90%');
    expect(tokens['--eve-glass-overlay-opacity']).toBe('88%');
    expect(tokens['--eve-glass-chrome-blur']).toBe('20px');
  });

  it('forces solid unblurred surfaces when effects are reduced', () => {
    const tokens = eveVisualCssVariables({ reducedEffects: true }, 'dark');

    expect(tokens['--eve-glass-chrome-opacity']).toBe('100%');
    expect(tokens['--eve-glass-panel-opacity']).toBe('100%');
    expect(tokens['--eve-glass-overlay-opacity']).toBe('100%');
    expect(tokens['--eve-glass-chrome-blur']).toBe('0px');
  });

  it('enforces the background readability floor before values reach CSS', () => {
    const tokens = eveVisualCssVariables({ glassOpacity: 0.72, background: { enabled: true } }, 'dark');

    expect(tokens['--eve-glass-chrome-opacity']).toBe('88%');
    expect(tokens['--eve-glass-panel-opacity']).toBe('94%');
    expect(tokens['--eve-glass-overlay-opacity']).toBe('92%');
  });

  it('updates the complete Arco RGB ramp and both legacy aliases for the selected accent', () => {
    const tokens = eveVisualCssVariables({ accent: 'graphite' }, 'dark');

    expect(tokens['--primary']).toBe('#64748b');
    expect(tokens['--color-primary-6']).toBe('#64748b');
    expect(tokens['--primary-6']).toBe('100, 116, 139');
    expect(tokens['--primary-rgb']).toBe('100, 116, 139');
    for (let index = 1; index <= 10; index += 1) {
      expect(tokens[`--primary-${index}`]).toMatch(/^\d{1,3}, \d{1,3}, \d{1,3}$/);
    }
  });

  it('keeps Arco light aliases translucent or pale instead of mapping them to saturated hover colors', () => {
    const lightTokens = eveVisualCssVariables({ accent: 'emerald' }, 'light');
    const darkTokens = eveVisualCssVariables({ accent: 'emerald' }, 'dark');

    expect(lightTokens['--color-primary-light-3']).toBe(`rgb(${lightTokens['--primary-3']})`);
    expect(lightTokens['--color-primary-light-4']).toBe(`rgb(${lightTokens['--primary-4']})`);
    expect(darkTokens['--color-primary-light-3']).toBe('rgba(21, 128, 61, 0.5)');
    expect(darkTokens['--color-primary-light-4']).toBe('rgba(21, 128, 61, 0.65)');
  });

  it('pins Arco ramp direction independently for light and dark appearances', () => {
    const lightTokens = eveVisualCssVariables({ accent: 'blue' }, 'light');
    const darkTokens = eveVisualCssVariables({ accent: 'blue' }, 'dark');

    expect(lightTokens['--primary-1']).toBe('233, 239, 253');
    expect(lightTokens['--primary-10']).toBe('17, 46, 108');
    expect(darkTokens['--primary-1']).toBe('14, 38, 89');
    expect(darkTokens['--primary-10']).toBe('203, 218, 250');
  });

  it('treats the OS reduced-transparency preference as a hard ceiling', () => {
    const tokens = eveVisualCssVariables({ glassOpacity: 0.72, glassBlur: 28, reducedEffects: false }, 'light', {
      reducedTransparency: true,
    });

    expect(tokens['--eve-glass-chrome-opacity']).toBe('100%');
    expect(tokens['--eve-glass-chrome-blur']).toBe('0px');
  });
});

describe('EVE_ACCENTS', () => {
  const surfaces = { light: '#ffffff', dark: '#101214' } as const;
  const cases = Object.entries(EVE_ACCENTS).flatMap(([accent, pair]) =>
    (['light', 'dark'] as const).map((appearance) => ({ accent, appearance, tone: pair[appearance] }))
  );

  it.each(cases)('$accent/$appearance remains visible against the shell', ({ appearance, tone }) => {
    expect(contrastRatio(tone.base, surfaces[appearance])).toBeGreaterThanOrEqual(3);
  });

  it.each(cases)('$accent/$appearance supports white text on filled controls', ({ tone }) => {
    expect(contrastRatio(tone.base, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
