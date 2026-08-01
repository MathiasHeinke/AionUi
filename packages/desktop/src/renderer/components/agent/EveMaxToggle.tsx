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
 * EVERY CLICK GETS AN ANSWER, AND THE ANSWER IS RENDERED. The control passes the
 * click to the hook in every state except BUSY; the hook decides. The two answers
 * that are not "MAX is now on/off" — a click held because entitlement is UNKNOWN,
 * and a click REFUSED because the answer was no — used to resolve into nothing a
 * user could see (`intentPending` / `intentRefused` had no rendered consumer at
 * all). They now render as a calm, non-modal live region attached to the pill; see
 * `notice` below and `.eve-max-notice` in UnifiedSendBar.css.
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
import { openAccountWeb } from '@renderer/utils/platform';
import { Button, Tooltip } from '@arco-design/web-react';
import { Lightning, Lock } from '@icon-park/react';
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/** The attribute the composer stylesheet keys the MAX visual state on. */
export const EVE_MAX_COMPOSER_ATTRIBUTE = 'data-eve-max';
const EVE_COMPOSER_SURFACE_SELECTOR = '.eve-composer-surface';
/** Ties the pill to its live region, so the answer is reachable from the control. */
const NOTICE_ID = 'eve-max-intent-notice';

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
  // `maxAvailable` is deliberately NOT read here any more. Deciding whether a click
  // may engage MAX is the hook's job — it owns the money gate — and reading the same
  // boolean on this side is exactly how the surface grew a second authority that
  // silently disagreed with it. See `onToggle` below.
  const { maxEngaged, maxLocked, maxState, setMaxEngaged, intentPending, intentRefused, acknowledgeIntentRefused } =
    useEveInferenceSelection();
  // THE SURFACE'S ONLY INPUT. Comes from MAIN, seat-bound, fails closed. The
  // selection hook deliberately no longer exposes a `maxActive` — it is not an
  // authority on what the wire sends.
  const { maxActive, entitlementPending } = useEveMaxAuthority();
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

  // THE CLICK REACHES THE HOOK IN EVERY STATE BUT "BUSY", AND THAT IS THE FIX.
  //
  // This used to `return` on `!maxAvailable`, and `maxAvailable` is false for BOTH
  // answers the control can be waiting on: an authoritative NO *and* the UNKNOWN
  // window. So the pending-intent feature the hook implements was unreachable from
  // the surface that is supposed to feed it — a click during UNKNOWN never became a
  // held intent, and a click on a LOCKED pill never raised the refusal the hook
  // exposes. Two dead ends dressed as a guard.
  //
  // It was also a SECOND authority on the same question. The hook already refuses
  // to persist a MAX it may not have (`next && !maxAvailable` → `intentRefused`)
  // and already holds a click made during UNKNOWN in memory. Re-deciding that here
  // is the duplicate-authority pattern this component's own doc-comment warns
  // about. Only `disabled` (the composer is SENDING) stays here, because that is a
  // fact about this surface and about nothing else.
  const onToggle = useCallback(() => {
    if (disabled) return;
    setMaxEngaged(!maxEngaged);
  }, [disabled, maxEngaged, setMaxEngaged]);

  const onUnlock = useCallback(() => {
    void openAccountWeb('/account?tab=credits');
  }, []);

  // NOTE: no cloud-tier nomenclature in ANY of these strings — not "Stufe", not
  // "level", not a renamed equivalent. The routine lane has no name; MAX is the
  // only word this control is allowed to say about intelligence.
  const label = t('conversation.eveMax.label', 'MAX');
  // MAX is only truly ON when the wire will actually serve it.
  const effectivelyOn = maxActive;
  // THE NEUTRAL STATE, and it takes precedence over every other branch.
  //
  // While the entitlement is UNVERIFIED the control may claim NEITHER lane: not
  // MAX (nothing proved it), and not the locked/upsell story either (nothing
  // disproved it). Saying "checking" is the only sentence the surface has the
  // authority to say — and it is the same state in which submission is held, so
  // a user who reads it also understands why the send button will not go.
  const hint = entitlementPending
    ? t('conversation.eveMax.checkingHint')
    : maxLocked
      ? maxEngaged
        ? t(
            'conversation.eveMax.lockedEngagedHint',
            'MAX bleibt für dich gemerkt, läuft aber erst wieder mit bezahltem Tarif oder gekauften Credits.'
          )
        : t('conversation.eveMax.lockedHint', 'MAX ist im bezahlten Tarif oder mit gekauften Credits verfügbar.')
      : effectivelyOn
        ? t('conversation.eveMax.engagedHint', 'MAX ist aktiv — EVE arbeitet mit voller Denkkraft.')
        : t('conversation.eveMax.availableHint', 'MAX einschalten — volle Denkkraft für harte Aufgaben.');

  // THE VISIBLE RESOLUTION OF A CLICK, in the only two shapes the hook can hand
  // back. REFUSED wins over HELD: they cannot both be true, but if a future edit
  // ever makes them overlap, the refusal is the one the user must read.
  //
  // The HELD sentence deliberately does not name MAX. A click during the unknown
  // window can be either direction (engage OR disengage), and painting "MAX is
  // queued" for a disengage would be the same lie the composer glow used to tell.
  const notice = intentRefused
    ? t(
        'conversation.eveMax.intentRefusedNotice',
        'MAX bleibt gesperrt — er läuft im bezahlten Tarif oder mit gekauften Credits.'
      )
    : intentPending
      ? t(
          'conversation.eveMax.intentHeldNotice',
          'Deine Auswahl ist gemerkt und wird übernommen, sobald die Berechtigung geprüft ist.'
        )
      : undefined;

  return (
    <span
      ref={anchorRef}
      className='eve-max-toggle-anchor inline-flex items-center'
      // `checking` is a FOURTH stamped state, never a re-skin of `available` or
      // `locked`: both of those assert an entitlement answer this one does not have.
      data-eve-max-state={entitlementPending ? 'checking' : maxState}
    >
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
          // CHECKING IS NOT LOCKED, and now the attribute says so.
          //
          // This read `maxLocked ? 'true' : 'false'`, and `maxLocked` is true
          // whenever MAX is not available — which includes the unverified state.
          // So the neutral "checking" pill was stamped `data-locked='true'` and
          // picked up the locked style (the 64%-muted label at UnifiedSendBar.css
          // `[data-locked='true']`), i.e. it wore the not-entitled answer while the
          // comment below insisted the two were separate. The comment was right
          // about the intent and wrong about the code; the code is what moved.
          // Same condition the icon already used at the padlock below.
          data-locked={maxLocked && !entitlementPending ? 'true' : 'false'}
          // Separate from `data-locked` on purpose: locked is an ANSWER (not
          // entitled, here is the upsell), checking is the absence of one.
          data-checking={entitlementPending ? 'true' : 'false'}
          // Coherent ARIA: "pressed" means the strong lane is ACTUALLY running.
          aria-pressed={effectivelyOn}
          // CHECKING IS NOT DISABLED EITHER. `maxLocked` is true during the
          // unverified window too, so this announced "disabled" for a control that
          // DOES accept the click (it becomes a held intent). Same split the
          // `data-locked` attribute above already makes.
          aria-disabled={(maxLocked && !entitlementPending) || disabled === true}
          aria-label={`${label} — ${hint}`}
          aria-describedby={notice ? NOTICE_ID : undefined}
        >
          <span className='eve-max-toggle__content flex items-center gap-4px leading-none'>
            {/* CHECKING WEARS NEITHER ICON'S CLAIM. A padlock says "we know you
                are not entitled, buy it"; a filled bolt says "MAX is running".
                While the entitlement is unverified the control asserts neither,
                so it shows the plain outline mark. */}
            {maxLocked && !entitlementPending ? (
              <Lock theme='outline' size='13' aria-hidden='true' />
            ) : (
              <Lightning theme={effectivelyOn ? 'filled' : 'outline'} size='13' aria-hidden='true' />
            )}
            <span className='eve-max-toggle__label'>{label}</span>
          </span>
        </Button>
      </Tooltip>
      {/* THE ANSWER TO THE CLICK, RENDERED. Not a modal, not a toast that leaves
          before it is read, not a hover-only tooltip: a live region attached to the
          control the user pressed, in the same two shapes the hook can produce.
          `intentRefused` and `intentPending` had NO rendered consumer at all, so an
          impermissible MAX intent was silently dropped — the surface's answer to a
          click was nothing. The pill itself keeps its styling; this only adds the
          sentence. */}
      {notice ? (
        <span
          id={NOTICE_ID}
          className='eve-max-notice'
          role='status'
          aria-live='polite'
          data-testid='eve-max-intent-notice'
          data-kind={intentRefused ? 'refused' : 'held'}
        >
          <span className='eve-max-notice__text'>{notice}</span>
          {intentRefused ? (
            <span className='eve-max-notice__actions'>
              <Button className='eve-max-notice__action' size='mini' type='text' onClick={onUnlock}>
                {t('conversation.eveMax.upgrade', 'MAX freischalten')}
              </Button>
              <Button className='eve-max-notice__action' size='mini' type='text' onClick={acknowledgeIntentRefused}>
                {t('conversation.eveMax.noticeDismiss', 'Verstanden')}
              </Button>
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
};

export default EveMaxToggle;
