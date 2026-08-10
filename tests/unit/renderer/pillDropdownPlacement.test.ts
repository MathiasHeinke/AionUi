/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  alignMeasuredPillDropdownTop,
  clampPillDropdownLeft,
  resolvePillDropdownPlacement,
} from '@/renderer/components/billing/pillDropdownPlacement';

const rect = (top: number, bottom: number) => ({ top, bottom, left: 10, width: 120 });
const VIEWPORT_WIDTH = 1280;

const resolve = (input: {
  triggerRect: { top: number; bottom: number; left: number; width: number };
  viewportHeight: number;
  estimatedListHeight: number;
  viewportWidth?: number;
}) => resolvePillDropdownPlacement({ viewportWidth: VIEWPORT_WIDTH, ...input });

describe('resolvePillDropdownPlacement (MAT-1773 P1)', () => {
  it('opens downward when there is room below', () => {
    const placement = resolve({
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
    const placement = resolve({
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
    const placement = resolve({
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
    const placement = resolve({
      triggerRect: rect(280, 310),
      viewportHeight: 320,
      estimatedListHeight: 380,
    });
    expect(placement.direction).toBe('up');
    expect(placement.top).toBeGreaterThanOrEqual(6);
    expect(placement.top + Math.min(380, placement.maxHeight)).toBeLessThanOrEqual(310 - 6);
  });

  it('the trigger width is a FLOOR, not the width: content may grow to the viewport cap', () => {
    // THE FOUNDER SCREENSHOT: "Grok I…", "Google Veo …", "OpenAI Sora…"
    // ellipsed while free space sat right next to the list, because the list
    // INHERITED the trigger width. The contract is now minWidth (readable
    // floor) + maxWidth (viewport edge) — the content decides in between.
    const placement = resolve({
      triggerRect: { top: 10, bottom: 40, left: 5, width: 90 },
      viewportHeight: 768,
      estimatedListHeight: 200,
    });
    expect(placement.minWidth).toBe(280);
    expect(placement.maxWidth).toBe(VIEWPORT_WIDTH - 12); // viewport minus a gap each side
    expect(placement.maxWidth).toBeGreaterThan(placement.minWidth);
  });

  it('a wide trigger raises the floor; a pathological viewport never squashes it away', () => {
    const wide = resolve({
      triggerRect: { top: 10, bottom: 40, left: 5, width: 420 },
      viewportHeight: 768,
      estimatedListHeight: 200,
    });
    expect(wide.minWidth).toBe(420);

    const tiny = resolve({
      triggerRect: { top: 10, bottom: 40, left: 5, width: 90 },
      viewportHeight: 768,
      viewportWidth: 200,
      estimatedListHeight: 200,
    });
    // Floor wins over an impossible viewport: never report maxWidth < minWidth.
    expect(tiny.maxWidth).toBe(tiny.minWidth);
  });
});

describe('alignMeasuredPillDropdownTop (measured-height anchor)', () => {
  it('keeps a short upward list exactly one gap above its trigger', () => {
    expect(
      alignMeasuredPillDropdownTop({
        direction: 'up',
        currentTop: 14,
        triggerTop: 340,
        measuredHeight: 176,
      })
    ).toBe(158);
  });

  it('does not move a downward list whose top is already trigger-anchored', () => {
    expect(
      alignMeasuredPillDropdownTop({
        direction: 'down',
        currentTop: 136,
        triggerTop: 100,
        measuredHeight: 176,
      })
    ).toBe(136);
  });
});

describe('clampPillDropdownLeft (second pass over the measured content width)', () => {
  it('leaves a list alone that fits where it opened', () => {
    expect(clampPillDropdownLeft({ left: 100, measuredWidth: 300, viewportWidth: 1280 })).toBe(100);
  });

  it('slides a content-wide list left instead of letting it run off the right edge', () => {
    // left 1000 + width 360 = 1360 > 1280 - 6 → slide to 1280 - 6 - 360.
    expect(clampPillDropdownLeft({ left: 1000, measuredWidth: 360, viewportWidth: 1280 })).toBe(914);
  });

  it('floors at the left gap when the list is wider than the viewport allows', () => {
    expect(clampPillDropdownLeft({ left: 40, measuredWidth: 2000, viewportWidth: 1280 })).toBe(6);
  });
});
