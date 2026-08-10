/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The SHARED media-model dropdown (MAT-1773, PACKAGE A) — the component both
 * the video and the image pill render through. These tests pin the generic
 * behavior on synthetic rows (no catalog, no registry): the sectioned list
 * ('Empfohlen' + 'Weitere anzeigen' expanding in place to 'Alle Modelle'),
 * provider chips, per-row estimates, the selected check, and the fail-safe
 * that a row without a proven estimate is disabled rather than priced.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import MediaModelDropdown, { type MediaModelRow } from '@/renderer/components/billing/MediaModelDropdown';

const RECOMMENDED: MediaModelRow[] = [
  { id: 'vendor-a/model-1', name: 'Model One', providerKey: 'vendora', providerLabel: 'VendorA', estimateCredits: 100 },
  {
    id: 'vendor-b/model-2',
    name: 'Model Two',
    providerKey: 'vendorb',
    providerLabel: 'VendorB',
    priceLabel: '0,14 $/s',
    estimateCredits: 200,
  },
];
const REST: MediaModelRow[] = [
  {
    id: 'vendor-c/model-3',
    name: 'Model Three',
    providerKey: 'vendorc',
    providerLabel: 'VendorC',
    estimateCredits: 50,
  },
  // No proven estimate: the row must be DISABLED, never offered with an invented price.
  { id: 'vendor-d/model-4', name: 'Model Four', providerKey: 'vendord', providerLabel: 'VendorD' },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderDropdown = (overrides: Partial<React.ComponentProps<typeof MediaModelDropdown>> = {}) => {
  const props: React.ComponentProps<typeof MediaModelDropdown> = {
    open: true,
    onToggle: vi.fn(),
    onClose: vi.fn(),
    ariaLabel: 'Modell wählen',
    testIdPrefix: 'media-model',
    triggerContent: 'Model One',
    recommended: RECOMMENDED,
    rest: REST,
    selectedId: 'vendor-a/model-1',
    onSelect: vi.fn(),
    ...overrides,
  };
  return { ...render(<MediaModelDropdown {...props} />), props };
};

describe('MediaModelDropdown (shared)', () => {
  it('renders the curated section with chips, estimates and the selected check; the rest stays behind Weitere anzeigen', () => {
    renderDropdown();

    expect(screen.getByTestId('media-model-section-recommended').textContent).toBe('Empfohlen');
    const list = screen.getByTestId('media-model-dropdown');
    // Portaled to document.body, above the overflow-hidden composer.
    expect(list.closest('body')).not.toBeNull();

    const entries = list.querySelectorAll('[role="option"]');
    expect([...entries].map((el) => el.getAttribute('data-testid'))).toEqual([
      'media-model-entry-vendor-a/model-1',
      'media-model-entry-vendor-b/model-2',
    ]);
    expect(screen.getByTestId('media-model-show-more').textContent).toBe('Weitere anzeigen');
    expect(screen.queryByTestId('media-model-entry-vendor-c/model-3')).toBeNull();

    const first = screen.getByTestId('media-model-entry-vendor-a/model-1');
    expect(first.querySelector('.video-quality-pill__chip')?.textContent).toBe('V');
    expect(first.querySelector('.video-quality-pill__chip')?.getAttribute('data-provider')).toBe('vendora');
    expect(first.textContent).toContain('≈ 100 Credits');
    expect(first.classList.contains('is-selected')).toBe(true);
    expect(first.querySelector('.video-quality-pill__check')).not.toBeNull();

    // The optional list-price badge renders only when the lane provides one.
    expect(screen.getByTestId('media-model-entry-vendor-b/model-2').textContent).toContain('0,14 $/s');
    expect(first.querySelector('.video-quality-pill__model-price')).toBeNull();
  });

  it('expands the rest IN-PLACE behind a divider + Alle Modelle, and disables an unpriceable row', () => {
    renderDropdown();

    fireEvent.click(screen.getByTestId('media-model-show-more'));

    const list = screen.getByTestId('media-model-dropdown');
    expect(list.isConnected).toBe(true);
    expect(screen.getByTestId('media-model-section-all').textContent).toBe('Alle Modelle');
    expect(screen.queryByTestId('media-model-show-more')).toBeNull();
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(4);

    const unpriced = screen.getByTestId('media-model-entry-vendor-d/model-4');
    expect(unpriced).toBeDisabled();
    expect(unpriced.textContent).not.toContain('Credits');
  });

  it('re-anchors the measured short and expanded upward list without restoring stale geometry', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const element = this as HTMLElement;
      if (element.dataset.testid === 'media-model-dropdown-trigger') {
        return {
          top: 500,
          bottom: 530,
          left: 120,
          right: 340,
          width: 220,
          height: 30,
          x: 120,
          y: 500,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (element.classList?.contains('video-quality-pill__model-list')) {
        const height = element.querySelector('[data-testid="media-model-section-all"]') ? 310 : 170;
        return {
          top: 0,
          bottom: height,
          left: 120,
          right: 500,
          width: 380,
          height,
          x: 120,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    renderDropdown();
    const list = screen.getByTestId('media-model-dropdown');
    await waitFor(() => expect(list.style.top).toBe('324px'));

    fireEvent.click(screen.getByTestId('media-model-show-more'));

    await waitFor(() => expect(list.style.top).toBe('184px'));
    expect(list.style.maxHeight).toBe('286px');
    expect(parseFloat(list.style.top) + 310 + 6).toBe(500);
  });

  it('reports a pick and closes; outside click closes without a pick', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderDropdown({ onSelect, onClose });

    fireEvent.click(screen.getByTestId('media-model-entry-vendor-b/model-2'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('vendor-b/model-2');
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
