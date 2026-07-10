/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import { applyEveVisualPreferences, resolveEveAppearance } from '@/renderer/theme/visualPreferences';
import {
  removeEveVisualBackground,
  resolveEveVisualBackground,
  storeEveVisualBackground,
} from '@/renderer/theme/visualBackgroundAssets';

afterEach(() => {
  document.documentElement.removeAttribute('data-eve-bg-image');
  document.documentElement.removeAttribute('data-eve-reduced-effects');
  document.documentElement.removeAttribute('style');
  localStorage.clear();
});

describe('Command EVE visual DOM projection', () => {
  it('resolves system appearance without weakening explicit modes', () => {
    expect(resolveEveAppearance('system', true)).toBe('dark');
    expect(resolveEveAppearance('system', false)).toBe('light');
    expect(resolveEveAppearance('light', true)).toBe('light');
    expect(resolveEveAppearance('dark', false)).toBe('dark');
  });

  it('applies and then removes reduced-effects and background root state', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    applyEveVisualPreferences(
      {
        accent: 'petrol',
        reducedEffects: true,
        background: { enabled: true, assetId: 'bg-test', fit: 'fill' },
      },
      'dark',
      { root: document, backgroundDataUrl: dataUrl }
    );

    expect(document.documentElement.getAttribute('data-eve-reduced-effects')).toBe('true');
    expect(document.documentElement.getAttribute('data-eve-bg-image')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--eve-bg-image-fit')).toBe('100% 100%');
    expect(document.documentElement.style.getPropertyValue('--primary-6')).toBe('15, 118, 110');

    applyEveVisualPreferences({ background: { enabled: false } }, 'light', { root: document });
    expect(document.documentElement.hasAttribute('data-eve-reduced-effects')).toBe(false);
    expect(document.documentElement.hasAttribute('data-eve-bg-image')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--eve-bg-image-url')).toBe('');
  });
});

describe('local visual background assets', () => {
  it('stores only validated image data behind an opaque id', () => {
    const assetId = storeEveVisualBackground('data:image/webp;base64,AAAA', 'bg-test');
    expect(assetId).toBe('bg-test');
    expect(resolveEveVisualBackground(assetId)).toBe('data:image/webp;base64,AAAA');

    removeEveVisualBackground(assetId);
    expect(resolveEveVisualBackground(assetId)).toBeUndefined();
    expect(() => storeEveVisualBackground('file:///tmp/background.png', 'bg-path')).toThrow();
    expect(resolveEveVisualBackground('/Users/example/background.png')).toBeUndefined();
  });
});
