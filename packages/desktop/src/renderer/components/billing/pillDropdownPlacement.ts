/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure placement math for the media-pill dropdowns (MAT-1773, P1).
 *
 * The dropdowns portal to `document.body` because the composer panel is
 * `overflow: hidden` until an overlay opens — an in-flow list is clipped by
 * the composer edge (founder screenshot, 2026-08-05). This function decides
 * direction and geometry from the trigger's viewport rect, so the list is
 * ALWAYS fully visible: it opens UPWARD when there is not enough room below,
 * and its height is capped to the available space (the list scrolls
 * internally). Pure so the geometry is unit-testable without a DOM.
 */

export type PillDropdownDirection = 'up' | 'down';

export type PillDropdownPlacement = {
  direction: PillDropdownDirection;
  /** Fixed-position top edge (viewport px). */
  top: number;
  /** Fixed-position left edge (viewport px). */
  left: number;
  /** List width (the trigger's width, min a readable floor). */
  width: number;
  /** Capped list height; the list scrolls beyond it. */
  maxHeight: number;
};

export const PILL_DROPDOWN_GAP_PX = 6;
export const PILL_DROPDOWN_MAX_HEIGHT_PX = 320;
export const PILL_DROPDOWN_MIN_HEIGHT_PX = 144;
export const PILL_DROPDOWN_MIN_WIDTH_PX = 280;

export function resolvePillDropdownPlacement(input: {
  /** The trigger's viewport rect (only the used fields). */
  triggerRect: { top: number; bottom: number; left: number; width: number };
  viewportHeight: number;
  /** The list's expected content height before capping. */
  estimatedListHeight: number;
  gap?: number;
  maxHeightCap?: number;
  minHeight?: number;
}): PillDropdownPlacement {
  const gap = input.gap ?? PILL_DROPDOWN_GAP_PX;
  const cap = input.maxHeightCap ?? PILL_DROPDOWN_MAX_HEIGHT_PX;
  const minHeight = input.minHeight ?? PILL_DROPDOWN_MIN_HEIGHT_PX;
  const { triggerRect } = input;

  const spaceBelow = Math.max(0, input.viewportHeight - triggerRect.bottom - gap);
  const spaceAbove = Math.max(0, triggerRect.top - gap);

  // Down wins ties and whenever it fits the content or the minimum; up only
  // when it is strictly the roomier side.
  const direction: PillDropdownDirection =
    spaceBelow >= Math.min(input.estimatedListHeight, cap) || spaceBelow >= spaceAbove ? 'down' : 'up';

  const available = direction === 'down' ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(Math.min(input.estimatedListHeight, cap, available), Math.min(minHeight, available));

  const height = Math.min(input.estimatedListHeight, maxHeight);
  const top = direction === 'down' ? triggerRect.bottom + gap : triggerRect.top - gap - height;

  return {
    direction,
    top: Math.max(gap, top),
    left: triggerRect.left,
    width: Math.max(triggerRect.width, PILL_DROPDOWN_MIN_WIDTH_PX),
    maxHeight,
  };
}
