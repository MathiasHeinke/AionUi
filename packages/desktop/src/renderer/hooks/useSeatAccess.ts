/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useSeatAccess (Phase 4 / A5) — the renderer's seat-access posture + switch action.
 *
 * This hook is the SeatGuard's data source AND the SeatSwitcher's controller. It
 * reads the my-seats contract over the bridge and resolves it with the SAME pure
 * `resolveSeatAccess` the main process uses, so renderer + main agree on who may
 * switch. It is FAIL-CLOSED by construction:
 *   - non-desktop / no bridge / any error ⇒ delegate, pinned to the legacy seat,
 *     canSwitch=false (no switcher, no route to another seat).
 *   - the truth is always the MAIN process: the switch IPC re-checks authorization
 *     server-side, so this hook hiding the switcher is defense-in-depth, not the
 *     security boundary.
 */

import { useCallback, useEffect, useState } from 'react';
import { commandEve } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@renderer/utils/platform';
import { resolveSeatAccess, type SeatAccess } from '@process/commandEve/seatSwitchCore';

export interface SeatAccessState {
  loading: boolean;
  access: SeatAccess;
  /** True while a switch IPC is in flight (the UI shows a "restarting EVE…" state). */
  switching: boolean;
  /** Reason code of the last failed switch (e.g. SWITCH_SEAT_FORBIDDEN), else null. */
  lastSwitchError: string | null;
  /** Re-read the my-seats contract (after a switch resolves). */
  refresh: () => Promise<void>;
  /** Request a switch to `seatId`. Resolves true on success. Fail-closed: a delegate
   * (or a target not in the authorized list) is rejected by main AND short-circuited
   * here before the IPC even fires. */
  switchTo: (seatId: string) => Promise<boolean>;
}

/** The hard fail-closed default: a single pinned delegate on the legacy seat. */
const FAIL_CLOSED_ACCESS: SeatAccess = resolveSeatAccess(null);

export function useSeatAccess(): SeatAccessState {
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<SeatAccess>(FAIL_CLOSED_ACCESS);
  const [switching, setSwitching] = useState(false);
  const [lastSwitchError, setLastSwitchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isElectronDesktop()) {
      // No desktop bridge ⇒ no seat product ⇒ fail-closed (no switcher).
      setAccess(FAIL_CLOSED_ACCESS);
      setLoading(false);
      return;
    }
    try {
      const response = await commandEve.mySeats.invoke();
      const contract = response?.data?.contract ?? null;
      setAccess(resolveSeatAccess(contract));
    } catch (error) {
      console.error('my-seats bridge call failed:', error);
      // FAIL-CLOSED on any error: never widen access to admin on a failed read.
      setAccess(FAIL_CLOSED_ACCESS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchTo = useCallback(
    async (seatId: string): Promise<boolean> => {
      setLastSwitchError(null);
      // Defense-in-depth: a delegate / unauthorized target is short-circuited
      // here. The MAIN process re-checks (isSeatSwitchAuthorized) — this hook is
      // not the boundary, but it must never even attempt a forbidden switch.
      if (!access.canSwitch || !access.seats.some((s) => s.seat_id === seatId) || seatId === access.activeSeatId) {
        setLastSwitchError('SWITCH_SEAT_FORBIDDEN');
        return false;
      }
      if (!isElectronDesktop()) {
        setLastSwitchError('SWITCH_SEAT_NO_BRIDGE');
        return false;
      }
      setSwitching(true);
      try {
        const response = await commandEve.switchSeat.invoke({ seatId });
        const ok = response?.data?.ok === true && response?.success !== false;
        if (!ok) {
          setLastSwitchError(response?.data?.reason_code ?? 'SWITCH_SEAT_FAILED');
        }
        // RE-HOME THE RENDERER CONFIG CACHE (CONFIRMED-HIGH fix). The main process
        // seams (setActiveSeatId / prepareEnv / restartBackend) re-home correctly,
        // but the renderer-side configService caches seat-scoped values keyed to
        // its OWN currentSeatId, which ONLY moves via rebindSeat. Without this call
        // a switch A→B would leave the renderer serving seat A's cached config
        // (clientSeeded, teamWorkerStatus, …). We rebind to the AUTHORITATIVE seat
        // the MAIN process reports it ended up on — the target on success, the
        // PRIOR seat after a rollback — never a stale local guess. On a clean
        // success that is `seatId`; on a rollback it is the prior seat, so the
        // renderer never ends up bound to a seat main did not switch to.
        const authoritativeSeatId = typeof response?.data?.active_seat_id === 'string' && response.data.active_seat_id.length > 0 ? response.data.active_seat_id : ok ? seatId : access.activeSeatId;
        try {
          await configService.rebindSeat(authoritativeSeatId);
        } catch (rebindError) {
          // A rebind failure must NOT mask the switch outcome; the next read
          // re-resolves the active seat. Log for diagnosability only.
          console.error('configService.rebindSeat after switch failed:', rebindError);
        }
        // Always re-read the contract: on success the active seat moved; on a
        // rollback it stayed — either way the UI must reflect the real state.
        await refresh();
        return ok;
      } catch (error) {
        console.error('switch-seat bridge call failed:', error);
        setLastSwitchError('SWITCH_SEAT_BRIDGE_FAILED');
        // The IPC itself threw — main's active seat is whatever it was before this
        // attempt. Re-home the renderer cache to the last-known active seat so it
        // never drifts onto the un-confirmed target.
        try {
          await configService.rebindSeat(access.activeSeatId);
        } catch (rebindError) {
          console.error('configService.rebindSeat after switch error failed:', rebindError);
        }
        await refresh();
        return false;
      } finally {
        setSwitching(false);
      }
    },
    [access, refresh]
  );

  return { loading, access, switching, lastSwitchError, refresh, switchTo };
}
