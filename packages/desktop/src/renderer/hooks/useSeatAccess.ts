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
 *   - non-desktop / no bridge ⇒ delegate, pinned to the legacy seat,
 *     canSwitch=false (no switcher, no route to another seat).
 *   - MAT-1773: a FAILED my-seats read (bridge legacy_fallback / IPC error) no
 *     longer hides the rail UNCONDITIONALLY. When local, main-derived evidence
 *     says the account is an admin (a cached last-good snapshot, or a bound
 *     non-legacy seat from a previously authorized switch), the hook resolves
 *     the DEGRADED admin posture (resolveDegradedAdminAccess): own seat + add
 *     entry, canSwitch=false — never a fabricated or stale switch target. With
 *     NO evidence it stays fail-closed exactly as before.
 *   - a failed read is NEVER silent: it is logged via writeRendererLog
 *     (transition-gated) and surfaced through `mySeatsSource` for a settings hint.
 *   - the truth is always the MAIN process: the switch IPC re-checks authorization
 *     server-side against a FRESH read, so this hook's posture is defense-in-depth,
 *     not the security boundary.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { application, commandEve } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@renderer/utils/platform';
import {
  isLegacySeatId,
  LEGACY_SEAT_ID,
  resolveDegradedAdminAccess,
  resolveSeatAccess,
  type MySeatsContract,
  type SeatAccess,
} from '@process/commandEve/seatSwitchCore';
import { type MySeatsWireFailure } from '@process/commandEve/seatWireFetchCore';

/**
 * Where the last my-seats resolution came from (MAT-1773 diagnostics):
 *  - 'my_seats'        — a LIVE read of the edge function (authoritative);
 *  - 'legacy_fallback' — the bridge fail-closed (no session / offline / non-2xx /
 *                        malformed / function not deployed — main cannot tell us
 *                        which, only THAT the read failed);
 *  - 'bridge_error'    — the IPC itself threw in the renderer;
 *  - null              — no read attempted yet (loading / non-desktop).
 */
export type MySeatsSource = 'my_seats' | 'legacy_fallback' | 'bridge_error';

export interface SeatAccessState {
  loading: boolean;
  access: SeatAccess;
  /** Provenance of the last my-seats read (see MySeatsSource). A failed read
   * surfaces here so the settings UI can show an honest hint instead of the rail
   * silently vanishing. */
  mySeatsSource: MySeatsSource | null;
  /**
   * WHY the last read failed, from the main-process envelope (null on a live
   * read or when the main predates the field). A { kind:'session' } failure
   * with a REFRESH_HTTP_x / KEYCHAIN_x / SESSION_x reasonCode is a DEAD stored
   * session — recoverable by re-login (isDeadSessionFailure), which is what
   * the rail's recovery affordance keys on.
   */
  mySeatsWireError: MySeatsWireFailure | null;
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
  const [mySeatsSource, setMySeatsSource] = useState<MySeatsSource | null>(null);
  const [mySeatsWireError, setMySeatsWireError] = useState<MySeatsWireFailure | null>(null);
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

  // MAT-1773 — transition-gated diagnostic for a FAILED my-seats read. The 60s
  // backstop poll + focus reconcile re-run refresh() constantly, so we log ONCE
  // per (source, evidence) transition — never per poll. Goes to the main-process
  // renderer log via writeRendererLog (the same channel useConversationListSync
  // uses) so a support bundle shows WHY the rail degraded. NEVER throws:
  // diagnostics must not break resolution.
  const lastLoggedFailureRef = useRef<string | null>(null);
  const logReadFailure = useCallback((source: MySeatsSource, evidence: string, errorMessage?: string): void => {
    const key = `${source}:${evidence}`;
    if (lastLoggedFailureRef.current === key) return;
    lastLoggedFailureRef.current = key;
    try {
      const invoked = application?.writeRendererLog?.invoke?.({
        level: source === 'bridge_error' ? 'error' : 'warn',
        tag: 'seatAccess',
        message: 'my_seats_read_failed',
        data: { source, evidence, ...(errorMessage ? { error: errorMessage } : {}) },
      });
      void (invoked as Promise<unknown> | undefined)?.catch((): undefined => undefined);
    } catch {
      /* diagnostics are best-effort */
    }
  }, []);

  // Persist/clear the LAST-GOOD admin evidence snapshot from a LIVE read. An
  // admin read stores role + the active seat (id + name) so a later failed read
  // can keep the rail visible in the degraded posture; a live DELEGATE read
  // removes it (a demotion is authoritative — no phantom admin rail). Best-effort:
  // a persistence failure must never fail the resolution itself.
  const persistSnapshot = useCallback((contract: MySeatsContract): void => {
    try {
      if (contract.role === 'admin') {
        const active = contract.seats.find((s) => s.seat_id === contract.active_seat_id);
        void configService
          .set('commandEve.lastMySeatsSnapshot', {
            role: 'admin',
            active_seat_id: contract.active_seat_id,
            active_seat_name: active?.name ?? contract.active_seat_id,
            at: Date.now(),
          })
          .catch((): undefined => undefined);
      } else {
        void configService.remove('commandEve.lastMySeatsSnapshot').catch((): undefined => undefined);
      }
    } catch {
      /* best-effort */
    }
  }, []);

  // MAT-1773 — the DEGRADED admin fallback. A failed my-seats read used to hide
  // the rail UNCONDITIONALLY (fail-closed ⇒ delegate), which made the founder's
  // rail invisible on any transient/permanent read failure. When LOCAL evidence
  // says this install's account is an admin, fall back to the honest degraded
  // posture instead: own active seat + add entry, canSwitch=false (never a
  // fabricated/stale switch target). Two evidence sources, both main-derived:
  //   1. a cached last-good snapshot whose role is 'admin' (a previous LIVE read);
  //   2. a currently-bound NON-legacy seat — only a previously main-AUTHORIZED
  //      switch could have bound it, so the account passed the admin gate before.
  // WITHOUT evidence the posture stays fail-closed (a genuine legacy/single-seat
  // install is byte-identical to before). Display-only: the switch IPC
  // re-authorizes against a fresh read in main.
  const resolveWithFallback = useCallback(
    (source: MySeatsSource, failClosed: SeatAccess, errorMessage?: string): SeatAccess => {
      let boundSeat = LEGACY_SEAT_ID;
      try {
        const bound = configService.getCurrentSeatId?.();
        if (typeof bound === 'string' && bound.length > 0) boundSeat = bound;
      } catch {
        /* no binding available ⇒ legacy */
      }
      let snapshot: { role?: unknown; active_seat_id?: unknown; active_seat_name?: unknown } | undefined;
      try {
        const raw = configService.get?.('commandEve.lastMySeatsSnapshot');
        if (raw && typeof raw === 'object') snapshot = raw;
      } catch {
        /* no snapshot available */
      }
      const snapshotAdmin = snapshot?.role === 'admin';
      const evidence = snapshotAdmin ? 'admin-snapshot' : !isLegacySeatId(boundSeat) ? 'active-seat' : 'none';
      logReadFailure(source, evidence, errorMessage);
      if (evidence === 'none') return failClosed;
      // The own seat's display name: only from a snapshot whose recorded active
      // seat IS the currently-bound one; otherwise null ⇒ the resolver shows the
      // raw id (honest, never invented).
      const snapshotName = snapshot?.active_seat_name;
      const seatName =
        snapshotAdmin && snapshot?.active_seat_id === boundSeat && typeof snapshotName === 'string'
          ? snapshotName
          : null;
      return resolveDegradedAdminAccess(boundSeat, seatName);
    },
    [logReadFailure]
  );

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
      const wireError = (response?.data?.wire_error ?? null) as MySeatsWireFailure | null;
      // LIVE read: any response carrying a real contract that is NOT the bridge's
      // explicit legacy fail-closed envelope. (Version-skew tolerant: an older
      // main without the `source` field still counts as live.)
      if (contract && response?.data?.source !== 'legacy_fallback') {
        const resolved = resolveSeatAccess(contract);
        persistSnapshot(contract);
        lastLoggedFailureRef.current = null;
        if (mountedRef.current) {
          setAccess(resolved);
          setMySeatsSource('my_seats');
          setMySeatsWireError(null);
        }
        return resolved;
      }
      // legacy_fallback: main could not read the wire (or parsed nothing). Try
      // the local-evidence degraded admin fallback before hiding the rail.
      const resolved = resolveSeatAccess(contract);
      const fallback = resolveWithFallback('legacy_fallback', resolved);
      if (mountedRef.current) {
        setAccess(fallback);
        setMySeatsSource('legacy_fallback');
        setMySeatsWireError(wireError);
      }
      return fallback;
    } catch (error) {
      console.error('my-seats bridge call failed:', error);
      // The IPC itself threw. Historically this fail-closed to delegate (rail
      // hidden); now the same local-evidence fallback applies.
      const fallback = resolveWithFallback(
        'bridge_error',
        FAIL_CLOSED_ACCESS,
        error instanceof Error ? error.message : String(error)
      );
      if (mountedRef.current) {
        setAccess(fallback);
        setMySeatsSource('bridge_error');
      }
      return fallback;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [persistSnapshot, resolveWithFallback]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // M4 — pick up a seat created on the web WITHOUT an app restart. A new client
  // seat (added on command-eve.com/account; included in Standard at no per-seat
  // charge since 1.820.1) only lands in this hook's `access.seats` when the
  // my-seats contract is re-read. Re-read on window FOCUS (the operator tabs back
  // from the browser after creating it) and on a slow BACKSTOP poll (a long-lived
  // window that never blurs), mirroring useEntitlementGate's off-band reconcile.
  // Desktop only; refresh() is fail-closed and idempotent.
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
          const settled =
            typeof response?.data?.active_seat_id === 'string' && response.data.active_seat_id.length > 0
              ? response.data.active_seat_id
              : response?.data?.ok === true
                ? seatId
                : access.activeSeatId;
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

  return { loading, access, mySeatsSource, mySeatsWireError, switching, lastSwitchError, switchErrorNonce, refresh, switchTo };
}
