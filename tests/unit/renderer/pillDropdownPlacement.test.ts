/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolvePillDropdownPlacement } from '@/renderer/components/billing/pillDropdownPlacement';

const rect = (top: number, bottom: number) => ({ top, bottom, left: 10, width: 120 });

describe('resolvePillDropdownPlacement (MAT-1773 P1)', () => {
  it('opens downward when there is room below', () => {
    const placement = resolvePillDropdownPlacement({
      triggerRect: rect(100, 130),
      viewportHeight: 768,
      estimatedListHeight: 400,
    });
    expect(placement.direction).toBe('down');
    expect(placement.top).toBe(136); // bottom + gap
    expect(placement.maxHeight).toBe(320); // the cap
  });

  it('opens UPWARD when the space below cannot fit the minimum', () => {
    // Trigger near the bottom edge: 20px below, plenty above.
    const placement = resolvePillDropdownPlacement({
      triggerRect: rect(340, 374),
      viewportHeight: 400,
      estimatedListHeight: 400,
    });
    expect(placement.direction).toBe('up');
    // The list bottom sits gap px above the trigger's top edge.
    expect(placement.top).toBe(340 - 6 - 320);
    expect(placement.maxHeight).toBe(320);
  });

  it('caps the height to the available space so the list is ALWAYS fully visible', () => {
    const placement = resolvePillDropdownPlacement({
      triggerRect: rect(160, 190),
      viewportHeight: 400,
      estimatedListHeight: 500,
    });
    // Down: 204px available below — the cap drops to the available space.
    expect(placement.direction).toBe('down');
    expect(placement.maxHeight).toBe(204);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(400);
  });

  it('opens upward at the smallest supported window height when below is cramped', () => {
    const placement = resolvePillDropdownPlacement({
      triggerRect: rect(280, 310),
      viewportHeight: 320,
      estimatedListHeight: 380,
    });
    expect(placement.direction).toBe('up');
    expect(placement.top).toBeGreaterThanOrEqual(6);
    expect(placement.top + Math.min(380, placement.maxHeight)).toBeLessThanOrEqual(310 - 6);
  });

  it('enforces the readable minimum width', () => {
    const placement = resolvePillDropdownPlacement({
      triggerRect: { top: 10, bottom: 40, left: 5, width: 90 },
      viewportHeight: 768,
      estimatedListHeight: 200,
    });
    expect(placement.width).toBe(280);
  });
});
