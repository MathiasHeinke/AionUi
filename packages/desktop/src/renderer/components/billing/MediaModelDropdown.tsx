/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SHARED media-model dropdown (MAT-1773, PACKAGE A) — extracted from the
 * video pill's `PillDropdown` + catalog-list render structure so the IMAGE
 * model picker renders through the exact same idiom:
 *
 *   - {@link MediaPillDropdown} is the low-level shell: a glass trigger with a
 *     rotating chevron (and a faint gold tint for an explicit, non-default
 *     selection) plus a list that PORTALS to `document.body` — the composer
 *     panel is `overflow: hidden`, so an in-flow list is clipped by the
 *     composer edge. Placement (up/down, capped height with internal scroll)
 *     comes from `pillDropdownPlacement.ts`; outside-click closes. Open state
 *     is CONTROLLED by the pill, so a pill with several dropdowns keeps its
 *     one-open-at-a-time rule.
 *   - {@link MediaModelDropdown} is the sectioned MODEL picker on top of the
 *     shell: 'Empfohlen' (curated, fixed order) + 'Weitere anzeigen' + divider
 *     + 'Alle Modelle' (price-ascending), provider identity chips, per-row
 *     credit estimates, and a clear check on the selected row. Both pills map
 *     their catalog/registry entries onto the generic {@link MediaModelRow}
 *     and render through this — the video catalog and the image registry stay
 *     data sources, never separate UIs.
 *
 * Styles intentionally reuse the existing `.video-quality-pill__*` classes in
 * `billing.css` (shared usage is noted there); the class names predate the
 * extraction and renaming them would churn every selector for zero gain.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckSmall, Down } from '@icon-park/react';
import {
  alignMeasuredPillDropdownTop,
  clampPillDropdownLeft,
  resolvePillDropdownPlacement,
  type PillDropdownPlacement,
} from '@/renderer/components/billing/pillDropdownPlacement';
import { COMPOSER_MENU_MOTION_STYLE, composerMenuExitDuration } from '@/renderer/utils/ui/composerMenuMotion';
import './billing.css';

/** Estimated px height per option row, for the placement estimate. */
const ROW_HEIGHT_PX = 34;

/**
 * One dropdown of a media pill: a glass trigger plus a PORTALED list. The
 * portal is the P1 clipping fix — the composer panel is `overflow: hidden`, so
 * an in-flow list is cut off at the composer edge; portaling to
 * `document.body` with fixed placement keeps the list fully visible (upward
 * when tight, above every other layer) while reading exactly like the
 * in-place disclosure it replaces. Position is computed once per open — no
 * JS animation loop.
 */
export const MediaPillDropdown: React.FC<{
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  ariaLabel: string;
  triggerTestId: string;
  listTestId: string;
  triggerContent: React.ReactNode;
  /** Faint gold tint on the trigger (an explicit, non-default selection). */
  triggerActive?: boolean;
  estimatedRows: number;
  children: React.ReactNode;
}> = ({
  open,
  onToggle,
  onClose,
  ariaLabel,
  triggerTestId,
  listTestId,
  triggerContent,
  triggerActive = false,
  estimatedRows,
  children,
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PillDropdownPlacement | null>(null);
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timeout = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
      setPlacement(null);
    }, composerMenuExitDuration(prefersReducedMotion));
    return () => window.clearTimeout(timeout);
  }, [open, rendered]);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlacement(
      resolvePillDropdownPlacement({
        triggerRect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        estimatedListHeight: estimatedRows * ROW_HEIGHT_PX + 48,
      })
    );
  }, [open, estimatedRows]);

  // SECOND GEOMETRY PASS: width and height are content-driven. Keep the list
  // inside the viewport horizontally and, for upward menus, re-anchor its
  // measured bottom edge to the trigger. Otherwise the short curated list
  // inherits the expanded catalog's estimated height and floats too far away.
  useLayoutEffect(() => {
    if (!open || !placement) return;
    const listRect = listRef.current?.getBoundingClientRect();
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (!listRect || !triggerRect) return;
    // The estimated-row effect and this measured pass can run in the same
    // commit when "Weitere anzeigen" changes the list height. A functional
    // update guarantees this pass refines the newest geometry instead of
    // restoring a stale pre-expansion placement captured by this render.
    setPlacement((current) => {
      if (!current) return current;
      const clampedLeft = clampPillDropdownLeft({
        left: current.left,
        measuredWidth: listRect.width,
        viewportWidth: window.innerWidth,
      });
      const anchoredTop = alignMeasuredPillDropdownTop({
        direction: current.direction,
        currentTop: current.top,
        triggerTop: triggerRect.top,
        measuredHeight: listRect.height,
      });
      if (clampedLeft === current.left && anchoredTop === current.top) return current;
      return { ...current, left: clampedLeft, top: anchoredTop };
    });
  }, [open, placement]);

  // Outside click closes — the portal is outside the pill's DOM subtree, so
  // this listens on the document and exempts trigger + list explicitly.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, onClose]);

  return (
    <div className='video-quality-pill__model-dropdown'>
      <button
        ref={triggerRef}
        type='button'
        className={`video-quality-pill__option video-quality-pill__model-trigger${triggerActive ? ' is-active' : ''}`}
        data-testid={triggerTestId}
        aria-haspopup='listbox'
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={onToggle}
      >
        {triggerContent}
        <span className='video-quality-pill__chevron' aria-hidden='true'>
          <Down size={12} />
        </span>
      </button>
      {rendered &&
        placement &&
        createPortal(
          <div
            ref={listRef}
            className={`video-quality-pill__model-list video-quality-pill__model-list--${placement.direction}`}
            data-state={closing ? 'closing' : 'open'}
            role='listbox'
            aria-label={ariaLabel}
            data-testid={listTestId}
            data-direction={placement.direction}
            style={{
              top: placement.top,
              left: placement.left,
              minWidth: placement.minWidth,
              maxWidth: placement.maxWidth,
              maxHeight: placement.maxHeight,
              ...COMPOSER_MENU_MOTION_STYLE,
            }}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
};

/**
 * One row of the shared model dropdown, already resolved by the owning pill:
 * the pill knows its catalog/registry, this component only renders. An absent
 * `estimateCredits` disables the row — a model without a proven price is
 * never offered with an invented one.
 */
export type MediaModelRow = {
  /** Stable row id (catalog entry id / registry tier id) — also the selection value. */
  id: string;
  /** User-facing model name. */
  name: string;
  /** Provider chip identity (`data-provider` key + full label; the chip shows its first letter). */
  providerKey: string;
  providerLabel: string;
  /** Small list-price badge (e.g. `0,14 $/s`); omitted when the lane quotes credits only. */
  priceLabel?: string;
  /** Per-row credit estimate for the current request; `undefined` disables the row. */
  estimateCredits?: number;
  disabled?: boolean;
};

/**
 * The sectioned MODEL dropdown both media pills share: 'Empfohlen' (curated
 * shortlist, fixed order) up front, 'Weitere anzeigen' expanding IN-PLACE to
 * the divider + 'Alle Modelle' (price-ascending rest, never repeating a
 * curated id — the owning core dedupes). The section labels reuse the generic
 * `credits.video.model*` keys for both lanes.
 */
export const MediaModelDropdown: React.FC<{
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  ariaLabel: string;
  /**
   * Test-id stem shared by both lanes: `${prefix}-dropdown-trigger`,
   * `${prefix}-dropdown`, `${prefix}-entry-<row id>`, `${prefix}-show-more`,
   * `${prefix}-section-recommended` / `${prefix}-section-all`.
   */
  testIdPrefix: string;
  triggerContent: React.ReactNode;
  triggerActive?: boolean;
  /** The curated shortlist rows, in their fixed order. */
  recommended: readonly MediaModelRow[];
  /** Everything else, price-ascending, behind 'Weitere anzeigen'. */
  rest: readonly MediaModelRow[];
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Optional trailing note (e.g. the video catalog's approximate-prices line). */
  footerNote?: React.ReactNode;
}> = ({
  open,
  onToggle,
  onClose,
  ariaLabel,
  testIdPrefix,
  triggerContent,
  triggerActive = false,
  recommended,
  rest,
  selectedId,
  onSelect,
  footerNote,
}) => {
  const { t } = useTranslation();
  // 'Weitere anzeigen' expands the list within the SAME dropdown — no page
  // jump, no modal.
  const [showAll, setShowAll] = useState(false);

  const renderRow = (row: MediaModelRow) => {
    const selected = selectedId === row.id;
    return (
      <button
        key={row.id}
        type='button'
        role='option'
        aria-selected={selected}
        disabled={row.disabled === true || row.estimateCredits === undefined}
        // Rendered via a helper, so the owning listbox is declared for the
        // static interaction-semantics check (its escape hatch for exactly
        // this shape) instead of being visible in the JSX tree.
        data-eve-composite-owner='listbox'
        className={`video-quality-pill__model-entry${selected ? ' is-selected' : ''}`}
        data-testid={`${testIdPrefix}-entry-${row.id}`}
        onClick={() => {
          onSelect(row.id);
          onClose();
        }}
      >
        <span className='video-quality-pill__chip' data-provider={row.providerKey} aria-hidden='true'>
          {row.providerLabel.charAt(0)}
        </span>
        <span className='video-quality-pill__model-name'>{row.name}</span>
        {row.priceLabel !== undefined && <span className='video-quality-pill__model-price'>{row.priceLabel}</span>}
        {row.estimateCredits !== undefined && (
          <span className='video-quality-pill__model-estimate'>
            {t('credits.video.modelEstimate', {
              defaultValue: '≈ {{credits}} Credits',
              credits: row.estimateCredits,
            })}
          </span>
        )}
        {selected && (
          <CheckSmall
            theme='outline'
            size={13}
            className='video-quality-pill__check'
            aria-label={t('credits.video.modelSelected', { defaultValue: 'Ausgewählt' })}
          />
        )}
      </button>
    );
  };

  return (
    <MediaPillDropdown
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      ariaLabel={ariaLabel}
      triggerTestId={`${testIdPrefix}-dropdown-trigger`}
      listTestId={`${testIdPrefix}-dropdown`}
      triggerContent={triggerContent}
      triggerActive={triggerActive}
      estimatedRows={(showAll ? recommended.length + rest.length : recommended.length) + 3}
    >
      <div className='video-quality-pill__section-label' data-testid={`${testIdPrefix}-section-recommended`}>
        {t('credits.video.modelRecommended', { defaultValue: 'Empfohlen' })}
      </div>
      {recommended.map(renderRow)}
      {!showAll && rest.length > 0 && (
        <button
          type='button'
          className='video-quality-pill__model-show-more'
          data-testid={`${testIdPrefix}-show-more`}
          onClick={() => setShowAll(true)}
        >
          {t('credits.video.modelShowMore', { defaultValue: 'Weitere anzeigen' })}
        </button>
      )}
      {showAll && rest.length > 0 && (
        <>
          <div className='video-quality-pill__divider' aria-hidden='true' />
          <div className='video-quality-pill__section-label' data-testid={`${testIdPrefix}-section-all`}>
            {t('credits.video.modelAll', { defaultValue: 'Alle Modelle' })}
          </div>
          {rest.map(renderRow)}
        </>
      )}
      {footerNote}
    </MediaPillDropdown>
  );
};

export default MediaModelDropdown;
