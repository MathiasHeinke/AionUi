/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205-SETTINGS — the operator's switch for "EVE may generate videos on her
 * own".
 *
 * WHAT THIS CLOSES. The per-seat key `commandEve.agentVideoGenerateEnabled` was
 * shipped with its resolver, its seat scoping and its fail-closed gate — but with
 * no place to set it. A release nobody can grant is dead config: the main process
 * reads it, always finds it absent, and the tool is permanently off with no way to
 * tell "deliberately closed" from "broken". This is the missing half.
 *
 * WHY ITS OWN COMPONENT rather than three more lines in the settings list: this
 * switch spends the operator's credits, so its persistence path needs the careful
 * rollback the DSGVO switch already earned (seat-guarded, loudly reported). That
 * is testable here in isolation and would not be inside the 700-line modal.
 *
 * FAIL-CLOSED READ. Only an exact `true` shows as on. Absent, `undefined`, or any
 * other persisted shape reads as OFF — the same direction the main-process
 * resolver takes, so the switch and the gate can never disagree about what this
 * seat is doing.
 *
 * WHAT THIS SWITCH DOES *NOT* DECIDE. It writes one per-seat value. The authority
 * stays in the main process, which re-checks the licence wire, the global
 * kill-switch and this value on every single tool call — so a stale renderer, a
 * seat switch mid-flight, or a value written by an older build cannot open the
 * tool by itself.
 */

import { Message, Switch } from '@arco-design/web-react';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ICommandEveEntitlementGateState } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { useConfig } from '@/renderer/hooks/config/useConfig';

/**
 * Should the row be offered at all?
 *
 * Only a seat whose entitlement is actually `'entitled'`. Every other state —
 * unconfigured, unregistered, registered-but-unlicensed, expired, and the
 * `null`/loading window before the first status read resolves — hides the row.
 *
 * This mirrors the main-process licence check (`isAgentVideoGenerateLicenseEligible`)
 * rather than duplicating its logic: offering a paid control to a seat the gate
 * would refuse is the "advertised capability the app will refuse" failure POLICY F
 * exists to prevent, and it reads to the operator as a broken product.
 *
 * Pure and exported so the visibility rule is unit-testable without mounting the
 * settings modal.
 */
export function isAgentVideoGenerateSettingVisible(state?: ICommandEveEntitlementGateState | null): boolean {
  return state === 'entitled';
}

/** The `data-testid` the DOM test drives; also a stable hook for E2E. */
export const AGENT_VIDEO_GENERATE_TOGGLE_TESTID = 'agent-video-generate-toggle';

const AgentVideoGenerateToggle: React.FC = () => {
  const { t } = useTranslation();
  const [enabled] = useConfig('commandEve.agentVideoGenerateEnabled');
  // FAIL-CLOSED: exactly `true` is on. Absent ⇒ off, matching the resolver.
  const on = enabled === true;

  const handleChange = useCallback(
    (checked: boolean) => {
      const previous = !checked;
      // `configService.set` optimistically updates the cache and notifies, so the
      // switch flips immediately. If the backend PUT rejects we roll the cache
      // back and say so LOUDLY — a spend release that silently fails to persist
      // would leave the operator believing they granted (or revoked) something
      // they did not.
      const issuedForSeat = configService.getCurrentSeatId();
      configService.set('commandEve.agentVideoGenerateEnabled', checked).catch((persistError) => {
        // Roll back ONLY if we are still on the seat the write was issued for. A
        // seat rebind mid-flight re-homed the cache, and seat A's rollback must
        // never land in seat B's namespace — for a spend switch that would be a
        // grant (or a revocation) applied to the wrong client.
        if (configService.getCurrentSeatId() === issuedForSeat) {
          configService.setLocal('commandEve.agentVideoGenerateEnabled', previous);
        }
        console.error('[SystemSettings] Failed to persist agent video generate release:', persistError);
        Message.error(
          t('settings.commandEveAgentVideoGenerateError', {
            defaultValue:
              'Freigabe konnte nicht gespeichert werden — Änderung nicht übernommen. Bitte erneut versuchen.',
          })
        );
      });
    },
    [t]
  );

  return <Switch checked={on} onChange={handleChange} data-testid={AGENT_VIDEO_GENERATE_TOGGLE_TESTID} />;
};

export default AgentVideoGenerateToggle;
