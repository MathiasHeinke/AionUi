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

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Monotonic counter bumped on every failure — pair with lastSwitchError so a toast
   * re-fires even when the SAME reject code repeats (the sync reset+set batch). */
  switchErrorNonce: number;
  /** Re-read the my-seats contract (after a switch resolves). Returns the freshly
   * resolved access so a caller can rebind to MAIN's authoritative active seat
   * (never a local guess) — load-bearing on the switch error / timeout path. */
  refresh: () => Promise<SeatAccess>;
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
  // A monotonic nonce bumped on EVERY failure alongside lastSwitchError. A toast
  // consumer keys on this so a repeated IDENTICAL reject code still re-fires — on the
  // synchronous reject paths the null reset and the re-set batch into one React tick
  // with no committed value change, which a [lastSwitchError]-only effect would miss.
  const [switchErrorNonce, setSwitchErrorNonce] = useState(0);
  const flagSwitchError = useCallback((code: string) => {
    setLastSwitchError(code);
    setSwitchErrorNonce((n) => n + 1);
  }, []);

  // Mounted guard: the switch flow can leave a fire-and-forget rebind in flight (the
  // timeout path), whose later settle calls refresh() → setAccess/setLoading. If the
  // hook unmounted by then (SeatSwitcher renders null for a delegate and can unmount),
  // those setters would run post-unmount. Guard by construction, not React-version luck.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<SeatAccess> => {
    if (!isElectronDesktop()) {
      // No desktop bridge ⇒ no seat product ⇒ fail-closed (no switcher).
      if (mountedRef.current) {
        setAccess(FAIL_CLOSED_ACCESS);
        setLoading(false);
      }
      return FAIL_CLOSED_ACCESS;
    }
    try {
      const response = await commandEve.mySeats.invoke();
      const contract = response?.data?.contract ?? null;
      const resolved = resolveSeatAccess(contract);
      if (mountedRef.current) setAccess(resolved);
      return resolved;
    } catch (error) {
      console.error('my-seats bridge call failed:', error);
      // FAIL-CLOSED on any error: never widen access to admin on a failed read.
      if (mountedRef.current) setAccess(FAIL_CLOSED_ACCESS);
      return FAIL_CLOSED_ACCESS;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // M4 — pick up a seat bought on the web WITHOUT an app restart. A new client
  // seat (the +99€/seat expansion, added on command-eve.com/account) only lands
  // in this hook's `access.seats` when the my-seats contract is re-read. Re-read
  // on window FOCUS (the operator tabs back from the browser after buying) and on
  // a slow BACKSTOP poll (a long-lived window that never blurs), mirroring
  // useEntitlementGate's off-band reconcile. Desktop only; refresh() is
  // fail-closed and idempotent.
  //
  // Race-guard: a switch is a real backend STOP + RE-SPAWN whose terminal seat
  // only MAIN knows; the switch flow drives its OWN authoritative refresh() at
  // settle. A focus/poll refresh mid-switch could sample a NON-terminal seat, so
  // we SKIP while switching (read via a ref so the listener never re-subscribes
  // on each switching toggle). Post-switch focus/poll reconciles normally.
  const switchingRef = useRef(switching);
  useEffect(() => {
    switchingRef.current = switching;
  }, [switching]);
  useEffect(() => {
    if (!isElectronDesktop()) return;
    const reconcile = (): void => {
      // Never race a live switch — its own settle path re-reads authoritatively.
      if (switchingRef.current) return;
      void refresh();
    };
    window.addEventListener('focus', reconcile);
    // Slow backstop (60s) for a window that stays focused for a long time.
    const SEAT_RECONCILE_POLL_MS = 60 * 1000;
    const timer = window.setInterval(reconcile, SEAT_RECONCILE_POLL_MS);
    return () => {
      window.removeEventListener('focus', reconcile);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const switchTo = useCallback(
    async (seatId: string): Promise<boolean> => {
      setLastSwitchError(null);
      // Defense-in-depth: a delegate / unauthorized target is short-circuited
      // here. The MAIN process re-checks (isSeatSwitchAuthorized) — this hook is
      // not the boundary, but it must never even attempt a forbidden switch.
      if (!access.canSwitch || !access.seats.some((s) => s.seat_id === seatId) || seatId === access.activeSeatId) {
        flagSwitchError('SWITCH_SEAT_FORBIDDEN');
        return false;
      }
      if (!isElectronDesktop()) {
        flagSwitchError('SWITCH_SEAT_NO_BRIDGE');
        return false;
      }
      setSwitching(true);
      // A switch is a real backend STOP + RE-SPAWN whose TRUE terminal seat only MAIN
      // knows. Two concerns are deliberately DECOUPLED:
      //   (1) UI liveness — bound how long the rail stays frozen so a hung/slow respawn
      //       never leaves switching=true forever. That is the 45s race below.
      //   (2) Config correctness — the renderer configService caches seat-scoped values
      //       keyed to its OWN currentSeatId (clientSeeded, teamWorkerStatus, …), moved
      //       ONLY by rebindSeat. It must end bound to main's TRUE terminal seat: the
      //       target on success, the PRIOR seat on a rollback. main moves the active
      //       pointer to the TARGET *before* the long respawn, so a value sampled at the
      //       45s mark is NOT terminal (the respawn may still fail and roll back). So the
      //       rebind is driven by the REAL IPC response WHENEVER it settles — even after
      //       the UI un-freezes — never by a mid-flight guess.
      const SWITCH_TIMEOUT_MS = 45_000;
      const invokePromise = commandEve.switchSeat.invoke({ seatId });

      // (2) Authoritative rebind, decoupled from the UI timeout. Resolves the renderer
      // cache to whatever seat MAIN reports it ACTUALLY ended on, whenever it settles.
      const rebindWhenSettled = invokePromise
        .then(async (response) => {
          const settled = typeof response?.data?.active_seat_id === 'string' && response.data.active_seat_id.length > 0 ? response.data.active_seat_id : response?.data?.ok === true ? seatId : access.activeSeatId;
          try {
            await configService.rebindSeat(settled);
          } catch (rebindError) {
            console.error('configService.rebindSeat (authoritative, post-settle) failed:', rebindError);
          }
          await refresh();
        })
        .catch(async (ipcError) => {
          // The IPC ITSELF rejected (a real failure, NOT the UI timeout — that rejects a
          // separate promise). main is on whatever it was; re-pull + rebind to that.
          console.error('switch-seat IPC rejected:', ipcError);
          try {
            await configService.rebindSeat((await refresh()).activeSeatId);
          } catch (rebindError) {
            console.error('configService.rebindSeat after IPC reject failed:', rebindError);
          }
        });

      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        // (1) UI race: the REAL response or the 45s timeout, whichever first. Drives the
        // un-freeze, the error toast and the return value — NOT the rebind.
        const response = await Promise.race([
          invokePromise,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              reject(new Error('SWITCH_SEAT_TIMEOUT'));
            }, SWITCH_TIMEOUT_MS);
          }),
        ]);
        // The race resolved via the REAL response ⇒ main settled. Await the authoritative
        // rebind so the renderer cache is re-homed to main's terminal seat before return.
        await rebindWhenSettled;
        const ok = response?.data?.ok === true && response?.success !== false;
        if (!ok && mountedRef.current) {
          flagSwitchError(response?.data?.reason_code ?? 'SWITCH_SEAT_FAILED');
        }
        return ok;
      } catch (error) {
        console.error('switch-seat bridge call failed:', error);
        if (mountedRef.current) flagSwitchError(timedOut ? 'SWITCH_SEAT_TIMEOUT' : 'SWITCH_SEAT_BRIDGE_FAILED');
        if (!timedOut) {
          // The IPC itself rejected ⇒ main settled (errored). Await the rebind (its
          // .catch re-homes to main's last-known seat) before returning.
          await rebindWhenSettled;
        }
        // On a TIMEOUT we deliberately do NOT await: main may still be mid-respawn and
        // could yet roll back, so the rebind must follow the REAL settle (rebindWhenSettled
        // self-completes and refresh()es the active-seat ring then) — never a 45s guess.
        return false;
      } finally {
        // Cancel the race timer so a won race does not leave a 45s timer that later
        // fires reject()+timedOut=true into the already-settled closure.
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        // Re-enable the rail. On the timeout path rebindWhenSettled is intentionally left
        // in flight (fire-and-forget) so a slow respawn never re-freezes the UI.
        void rebindWhenSettled;
        if (mountedRef.current) setSwitching(false);
      }
    },
    [access, refresh, flagSwitchError]
  );

  return { loading, access, switching, lastSwitchError, switchErrorNonce, refresh, switchTo };
}
