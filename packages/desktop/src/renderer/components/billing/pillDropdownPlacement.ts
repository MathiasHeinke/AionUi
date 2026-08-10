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
  /**
   * Width FLOOR (trigger width, min a readable floor). The list itself sizes
   * to its CONTENT (`width: max-content` in CSS) — inheriting the trigger
   * width as the *actual* width was why "Grok I…", "Google Veo …" ellipsed
   * while free space sat right next to the list (founder screenshot).
   */
  minWidth: number;
  /** Hard cap: content may widen the list up to the viewport edge, never past it. */
  maxWidth: number;
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
  viewportWidth: number;
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

  const minWidth = Math.max(triggerRect.width, PILL_DROPDOWN_MIN_WIDTH_PX);
  return {
    direction,
    top: Math.max(gap, top),
    left: triggerRect.left,
    minWidth,
    // Never smaller than the floor (a pathological viewport should not squash
    // the floor away), never past the viewport minus a gap on each side.
    maxWidth: Math.max(minWidth, input.viewportWidth - 2 * gap),
    maxHeight,
  };
}

/**
 * Second geometry pass, after the browser has sized the content-wide list:
 * keep the measured list inside the right viewport edge by sliding it left
 * (never squashing it), floored at the left gap. Pure for the same reason as
 * the resolver above.
 */
export function clampPillDropdownLeft(input: {
  left: number;
  measuredWidth: number;
  viewportWidth: number;
  gap?: number;
}): number {
  const gap = input.gap ?? PILL_DROPDOWN_GAP_PX;
  return Math.max(gap, Math.min(input.left, input.viewportWidth - gap - input.measuredWidth));
}

/**
 * Re-anchor an upward-opening list after the browser has measured its real
 * height. The first pass necessarily uses an estimate; keeping that estimated
 * top after a short curated list renders leaves a conspicuous empty gulf
 * between trigger and menu. Downward lists already anchor from their top edge.
 */
export function alignMeasuredPillDropdownTop(input: {
  direction: PillDropdownDirection;
  currentTop: number;
  triggerTop: number;
  measuredHeight: number;
  gap?: number;
}): number {
  if (input.direction === 'down') return input.currentTop;
  const gap = input.gap ?? PILL_DROPDOWN_GAP_PX;
  return Math.max(gap, input.triggerTop - gap - input.measuredHeight);
}
