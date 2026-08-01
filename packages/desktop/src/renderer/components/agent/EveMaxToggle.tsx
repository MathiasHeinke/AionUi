/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EveMaxToggle — the composer control that engages the strong lane.
 *
 * MAX is the ONLY user-visible name for that lane. No model id, vendor or slug
 * is rendered here or anywhere downstream; the server owns which model serves it.
 *
 * STATES. Engagement and entitlement are INDEPENDENT axes, not one enum — a seat
 * can hold a persisted MAX intent and simultaneously have lost entitlement:
 *
 *   - available          — purchase-backed, MAX off. Operable.
 *   - engaged            — purchase-backed, MAX on. Reads pressed.
 *   - locked             — not purchase-backed, MAX off. Rendered (never hidden),
 *                          announced disabled, upsell tooltip.
 *   - locked + engaged   — THE FIFTH STATE, and the one that used to produce
 *                          contradictory ARIA: a lapsed seat whose persisted
 *                          intent is still MAX. It is NOT "on": the wire clamps
 *                          to the routine lane, so announcing `aria-pressed=true`
 *                          would tell a screen-reader user the strong lane is
 *                          active when it is not. We therefore announce
 *                          `aria-pressed=false` + `aria-disabled=true` and say
 *                          the truth in the label ("intent kept, needs a plan"),
 *                          while `data-engaged` still carries the raw intent for
 *                          styling and tests.
 *   - disabled / loading — the surface is busy (sending); greys out without
 *                          changing which lane is engaged.
 *   - offline            — handled upstream by runtime truth; MAX stays as-is so
 *                          nothing silently re-lanes the user.
 *
 * THE COMPOSER SEAM. MAX repaints the WHOLE composer, and the composer is fully
 * CSS-variable driven (`--eve-spotlight-color`, `--eve-composer-border`,
 * `--eve-spotlight-max`). So instead of introducing a new element or a competing
 * class — which would lose the specificity war against
 * `.sendbox-panel.eve-composer-surface { border-color: … !important }` — this
 * component stamps `data-eve-max` on the nearest `.eve-composer-surface`
 * ancestor and lets the stylesheet RE-POINT those variables. A variable wins
 * regardless of `!important`, because the `!important` declaration is what reads
 * the variable.
 *
 * WHAT DRIVES THAT STAMP IS THE POINT: `maxActive` from useEveMaxAuthority — the
 * MAIN process's decision about what the wire will serve, for THIS seat — never
 * `maxEngaged` (what the user once chose), and never a renderer-local
 * recomputation of the wire tier (that duplicate authority has been deleted). The composer glow means "the
 * strong lane is running THIS turn". Two states must therefore NOT paint it:
 * a lapsed seat whose intent is remembered but clamped, and a seat whose
 * entitlement is not yet known. Intent stays visible on the pill instead.
 */

import { useEveInferenceSelection } from '@renderer/hooks/agent/useEveInferenceSelection';
import { useEveMaxAuthority } from '@renderer/hooks/agent/useEveMaxAuthority';
import { Button, Tooltip } from '@arco-design/web-react';
import { Lightning, Lock } from '@icon-park/react';
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/** The attribute the composer stylesheet keys the MAX visual state on. */
export const EVE_MAX_COMPOSER_ATTRIBUTE = 'data-eve-max';
const EVE_COMPOSER_SURFACE_SELECTOR = '.eve-composer-surface';

/**
 * Stamp / clear `data-eve-max` on the composer surface that CONTAINS this
 * control. Scoped by DOM ancestry rather than a global flag, so a non-EVE
 * composer on screen at the same time is never repainted.
 */
function useComposerMaxState(anchor: React.RefObject<HTMLElement | null>, engaged: boolean): void {
  useEffect(() => {
    const surface = anchor.current?.closest<HTMLElement>(EVE_COMPOSER_SURFACE_SELECTOR);
    if (!surface) return;
    if (engaged) {
      surface.setAttribute(EVE_MAX_COMPOSER_ATTRIBUTE, 'true');
    } else {
      surface.removeAttribute(EVE_MAX_COMPOSER_ATTRIBUTE);
    }
    // Unmounting the control must not leave a composer painted for a lane it is
    // no longer in.
    return () => surface.removeAttribute(EVE_MAX_COMPOSER_ATTRIBUTE);
  }, [anchor, engaged]);
}

const EveMaxToggle: React.FC<{
  /** Disable the control while the surface is busy (sending / loading). */
  disabled?: boolean;
}> = ({ disabled }) => {
  const { t } = useTranslation();
  const { maxEngaged, maxAvailable, maxLocked, maxState, setMaxEngaged } = useEveInferenceSelection();
  // THE SURFACE'S ONLY INPUT. Comes from MAIN, seat-bound, fails closed. The
  // selection hook deliberately no longer exposes a `maxActive` — it is not an
  // authority on what the wire sends.
  const { maxActive } = useEveMaxAuthority();
  const anchorRef = useRef<HTMLSpanElement>(null);

  // THE SURFACE FOLLOWS `maxActive`, NEVER `maxEngaged`.
  //
  // The composer glow depicts EFFECTIVE ACTIVE INFERENCE, not a stored
  // preference. Painting it from intent meant a lapsed seat wore the full MAX
  // treatment while the wire clamped that same turn to the routine lane — the
  // surface asserting a state the system was not in. `maxActive` is derived from
  // the effective wire tier, so surface and request cannot disagree; it is also
  // false while entitlement is UNKNOWN, because unknown is not active.
  //
  // The PILL keeps showing intent (`data-engaged` + its locked styling), so a
  // remembered choice stays visible on the control the user pressed.
  useComposerMaxState(anchorRef, maxActive);

  const onToggle = useCallback(() => {
    if (disabled || !maxAvailable) return;
    setMaxEngaged(!maxEngaged);
  }, [disabled, maxAvailable, maxEngaged, setMaxEngaged]);

  // NOTE: no cloud-tier nomenclature in ANY of these strings — not "Stufe", not
  // "level", not a renamed equivalent. The routine lane has no name; MAX is the
  // only word this control is allowed to say about intelligence.
  const label = t('conversation.eveMax.label', 'MAX');
  // MAX is only truly ON when the wire will actually serve it.
  const effectivelyOn = maxActive;
  const hint = maxLocked
    ? maxEngaged
      ? t(
          'conversation.eveMax.lockedEngagedHint',
          'MAX bleibt für dich gemerkt, läuft aber erst wieder mit bezahltem Tarif oder gekauften Credits.'
        )
      : t('conversation.eveMax.lockedHint', 'MAX ist im bezahlten Tarif oder mit gekauften Credits verfügbar.')
    : effectivelyOn
      ? t('conversation.eveMax.engagedHint', 'MAX ist aktiv — EVE arbeitet mit voller Denkkraft.')
      : t('conversation.eveMax.availableHint', 'MAX einschalten — volle Denkkraft für harte Aufgaben.');

  return (
    <span ref={anchorRef} className='eve-max-toggle-anchor inline-flex items-center' data-eve-max-state={maxState}>
      <Tooltip content={hint} position='top'>
        <Button
          // Deliberately NOT `agent-mode-compact-pill`: inside .unified-send-bar
          // that class clamps every control to a 32x32 ICON footprint and hides
          // its text. MAX is the only pill with a word in it, so it got a 32px
          // layout box around ~52px of rendered content — overflowing ~10px each
          // side, which made the label overlap the neighbouring control's hit
          // target. This control owns its own sizing instead.
          //
          // Also deliberately NOT `type='primary'`: inside the send bar the
          // primary styling is overridden away (so it gave no feedback at all),
          // and in LIGHT theme + disabled it resolved to white-on-near-white —
          // the wordmark disappeared completely. Engagement is expressed by
          // `data-engaged` in CSS we control.
          className='eve-max-toggle'
          shape='round'
          size='small'
          disabled={disabled}
          onClick={onToggle}
          data-testid='eve-max-toggle'
          data-engaged={maxEngaged ? 'true' : 'false'}
          data-active={effectivelyOn ? 'true' : 'false'}
          data-locked={maxLocked ? 'true' : 'false'}
          // Coherent ARIA: "pressed" means the strong lane is ACTUALLY running.
          aria-pressed={effectivelyOn}
          aria-disabled={maxLocked || disabled === true}
          aria-label={`${label} — ${hint}`}
        >
          <span className='eve-max-toggle__content flex items-center gap-4px leading-none'>
            {maxLocked ? (
              <Lock theme='outline' size='13' aria-hidden='true' />
            ) : (
              <Lightning theme={effectivelyOn ? 'filled' : 'outline'} size='13' aria-hidden='true' />
            )}
            <span className='eve-max-toggle__label'>{label}</span>
          </span>
        </Button>
      </Tooltip>
    </span>
  );
};

export default EveMaxToggle;
