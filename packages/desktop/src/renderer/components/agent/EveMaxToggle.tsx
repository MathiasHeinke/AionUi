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
 * STATES (all reachable, all accessible):
 *   - available — a real purchase backs MAX; the toggle is operable.
 *   - locked    — trial/free or promotional-credit-only. The control still
 *                 RENDERS (never hidden), announces `aria-disabled`, and carries
 *                 an upsell tooltip. Promotional credits do not unlock MAX.
 *   - engaged   — MAX is the active selection; the toggle reads pressed and the
 *                 composer wears the MAX state.
 *   - disabled / loading — the surface is busy (sending); the control greys out
 *                 without changing which lane is engaged.
 *   - offline   — handled upstream by the picker's runtime truth; MAX itself
 *                 stays engaged so nothing silently re-lanes the user.
 *
 * THE COMPOSER SEAM. Engaging MAX must repaint the WHOLE composer, and the
 * composer is fully CSS-variable driven (`--eve-spotlight-color`,
 * `--eve-composer-border`, `--eve-spotlight-max`). So instead of introducing a
 * new element or a competing class — which would lose the specificity war against
 * `.sendbox-panel.eve-composer-surface { border-color: … !important }` — this
 * component stamps `data-eve-max` on the nearest `.eve-composer-surface`
 * ancestor and lets the stylesheet RE-POINT those variables. A variable wins
 * regardless of `!important`, because the `!important` declaration is what reads
 * the variable.
 */

import { useEveInferenceSelection } from '@renderer/hooks/agent/useEveInferenceSelection';
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
  const anchorRef = useRef<HTMLSpanElement>(null);

  useComposerMaxState(anchorRef, maxEngaged);

  const onToggle = useCallback(() => {
    if (disabled || !maxAvailable) return;
    setMaxEngaged(!maxEngaged);
  }, [disabled, maxAvailable, maxEngaged, setMaxEngaged]);

  // NOTE: no cloud-tier nomenclature in ANY of these strings — not "Stufe", not
  // "level", not a renamed equivalent. The routine lane has no name; MAX is the
  // only word this control is allowed to say about intelligence.
  const label = t('conversation.eveMax.label', 'MAX');
  const hint = maxLocked
    ? t('conversation.eveMax.lockedHint', 'MAX ist im bezahlten Tarif oder mit gekauften Credits verfügbar.')
    : maxEngaged
      ? t('conversation.eveMax.engagedHint', 'MAX ist aktiv — EVE arbeitet mit voller Denkkraft.')
      : t('conversation.eveMax.availableHint', 'MAX einschalten — volle Denkkraft für harte Aufgaben.');

  return (
    <span ref={anchorRef} className='eve-max-toggle-anchor inline-flex items-center' data-eve-max-state={maxState}>
      <Tooltip content={hint} position='top'>
        <Button
          className='eve-max-toggle agent-mode-compact-pill'
          shape='round'
          size='small'
          type={maxEngaged ? 'primary' : 'default'}
          disabled={disabled}
          onClick={onToggle}
          data-testid='eve-max-toggle'
          data-engaged={maxEngaged ? 'true' : 'false'}
          data-locked={maxLocked ? 'true' : 'false'}
          aria-pressed={maxEngaged}
          aria-disabled={maxLocked || disabled === true}
          aria-label={`${label} — ${hint}`}
        >
          <span className='flex items-center gap-4px leading-none'>
            {maxLocked ? (
              <Lock theme='outline' size='13' aria-hidden='true' />
            ) : (
              <Lightning theme={maxEngaged ? 'filled' : 'outline'} size='13' aria-hidden='true' />
            )}
            <span>{label}</span>
          </span>
        </Button>
      </Tooltip>
    </span>
  );
};

export default EveMaxToggle;
