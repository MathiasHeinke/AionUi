/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE SEAT-SWITCH core (Phase 4 / A5 — the GATE-NULL RUNTIME keystone).
 *
 * THE CONSUMER OF EVERY SEAT SEAM. ISO-1..ISO-3 + B3 built the seams; A5 is the
 * single coherent lifecycle that wires them so per-seat isolation becomes REAL
 * at runtime. Today everything is correct-but-dormant because the active seat is
 * always LEGACY_SEAT_ID — nothing ever calls setActiveSeatId at runtime.
 *
 * THE WORST FAILURE this module exists to prevent: a mishandled switch that lets
 * seat-A runtime state (env/HERMES_HOME/config cache/agent process) survive into
 * seat-B. A switch is therefore a COUPLED lifecycle that MUST, IN ORDER:
 *
 *   (a) setActiveSeatId(seatId)         — sanitize/throw on a bad id (fail-closed)
 *   (b) prepareEnv()                    — re-bake the shim + set process.env.HERMES_HOME
 *                                         to the NEW seat (re-run prepareCommandEve…)
 *   (c) restartBackend()                — STOP then RE-SPAWN aioncore/ACP so the new
 *                                         agent inherits the new HERMES_HOME (a running
 *                                         agent's HERMES_HOME is env-frozen at spawn —
 *                                         a switch does NOT retroactively re-home it)
 *   (d) rebindConfig(seatId)            — invalidate + re-read the seat's config cache
 *   (e) reseedStatus()                  — re-read the per-seat company-brain seed status
 *   (f) persistActiveSeat(seatId)       — write the SD-4 / B3 pointer (BEST-EFFORT)
 *
 * ISO-1 contract (documented at runtimeBootstrapCore.ts:1144): a switch does NOT
 * retroactively re-home a running agent — re-spawn is MANDATORY. Step (c) is the
 * load-bearing one; the unit tests prove a switch WITHOUT a re-spawn leaves the
 * (simulated) running agent on the OLD home.
 *
 * FAIL-SAFE: if any STRUCTURAL step (a–d) throws, we roll back the active seat to
 * its prior value and re-prepare the env for it, then re-throw. We never leave a
 * half-switched agent: the re-spawn either lands the NEW seat or the rollback
 * lands the PRIOR seat — there is no in-between exposed to the renderer.
 *
 * persistActiveSeat (f) is BEST-EFFORT: the local runtime switch already
 * succeeded, so a network failure persisting the pointer must NOT roll back a
 * working local switch (the next launch re-reads the pointer; a stale pointer is
 * a re-sync concern, not a leak). reseedStatus (e) is likewise informational.
 *
 * PURE / INJECTABLE: every side-effecting seam is injected, so the orchestrator
 * unit-tests with mocks and asserts ORDERING + rollback WITHOUT a live backend.
 */

import {
  LEGACY_SEAT_ID,
  assertSeatId,
  clearActiveSeat,
  getActiveSeatId,
  isLegacySeatId,
  sanitizeSeatId,
  setActiveSeatId,
} from './seatContextCore';

/** Stable result envelope returned to the bridge / renderer. */
export interface SeatSwitchResult {
  ok: boolean;
  /** The seat the runtime ended up on (the target on success, the prior seat after a rollback). */
  active_seat_id: string;
  /** True when the runtime was rolled back to the prior seat after a structural failure. */
  rolled_back: boolean;
  reason_code?: string;
  message?: string;
  /** True when persisting the B3 pointer failed but the LOCAL switch still succeeded. */
  persist_failed?: boolean;
}

/**
 * The injectable seams a switch drives. Each is a thunk so the orchestrator owns
 * ONLY the ordering + fail-safety, never the concrete Electron/backend wiring.
 */
export interface SeatSwitchDeps {
  /** Re-derive process.env.HERMES_HOME + re-bake the shim for the CURRENTLY-active seat. */
  prepareEnv: () => void | Promise<void>;
  /** Cleanly STOP then RE-SPAWN the backend/ACP agent so it inherits the new HERMES_HOME. */
  restartBackend: () => void | Promise<void>;
  /** Invalidate + re-read the seat's namespaced config cache (configService.rebindSeat). */
  rebindConfig: (seatId: string) => void | Promise<void>;
  /** Re-read the per-seat company-brain seed status (best-effort, informational). */
  reseedStatus?: (seatId: string) => void | Promise<void>;
  /** Persist the B3 active-seat pointer (best-effort; a failure does NOT roll back). */
  persistActiveSeat?: (seatId: string) => void | Promise<void>;
}

/**
 * Perform a full, ordered, fail-safe seat switch.
 *
 * ORDERING (asserted by tests): setActiveSeatId → prepareEnv → restartBackend →
 * rebindConfig → reseedStatus → persistActiveSeat.
 *
 * @param newSeatId the target seat (sanitized via assertSeatId — a path-traversal
 *   / separator / NUL id THROWS BEFORE anything mutates, so a crafted id can never
 *   become active).
 */
export async function applySeatSwitch(newSeatId: string | null | undefined, deps: SeatSwitchDeps): Promise<SeatSwitchResult> {
  const priorSeatId = getActiveSeatId();

  // (a) Sanitize FIRST. A bad id throws here, BEFORE any state mutates, so the
  // active seat is untouched (fail-closed). assertSeatId folds legacy aliases to
  // LEGACY_SEAT_ID and rejects traversal/separator/NUL by construction.
  let targetSeatId: string;
  try {
    targetSeatId = assertSeatId(newSeatId);
  } catch (error) {
    return {
      ok: false,
      active_seat_id: priorSeatId,
      rolled_back: false,
      reason_code: 'SEAT_SWITCH_REJECTED_UNSAFE_ID',
      message: error instanceof Error ? error.message : 'Rejected unsafe seat id.',
    };
  }

  // No-op fast path: switching to the seat we are already on does NO restart (so
  // legacy/single-seat installs that "select" their only seat never respawn the
  // backend — byte-identical to 1.1.3). Still best-effort persist the pointer.
  if (targetSeatId === priorSeatId) {
    let persistFailed = false;
    if (deps.persistActiveSeat) {
      try {
        await deps.persistActiveSeat(targetSeatId);
      } catch {
        persistFailed = true;
      }
    }
    return { ok: true, active_seat_id: targetSeatId, rolled_back: false, ...(persistFailed ? { persist_failed: true } : {}) };
  }

  // Roll the runtime back to the prior seat on a structural failure. Re-baking
  // the env for the prior seat re-homes process.env.HERMES_HOME; we DO NOT
  // restart the backend on rollback by default (the old agent was never
  // re-spawned if restartBackend was the step that threw — and if it threw
  // mid-restart the caller's restartBackend is responsible for not leaving an
  // orphan; see restartCommandEveBackendForSeat which stop()s before start()).
  const rollback = async (): Promise<void> => {
    try {
      setActiveSeatId(priorSeatId);
    } catch {
      // The prior seat was already sanitized once (it was active); if it somehow
      // fails to re-set, fall back to the hard legacy default — never leave the
      // holder pointing at the failed target.
      clearActiveSeat();
    }
    try {
      await deps.prepareEnv();
    } catch {
      // Best-effort env re-home on rollback; the holder is already reverted.
    }
  };

  // (b) Make the target active, then (c) re-home env, then (d) re-spawn.
  try {
    setActiveSeatId(targetSeatId); // (a→b boundary: holder now points at target
    await deps.prepareEnv(); // (b) env.HERMES_HOME → seats/<target>/home
    await deps.restartBackend(); // (c) stop + re-spawn so the agent re-homes
    await deps.rebindConfig(targetSeatId); // (d) config cache re-reads under target
  } catch (error) {
    await rollback();
    return {
      ok: false,
      active_seat_id: getActiveSeatId(),
      rolled_back: true,
      reason_code: 'SEAT_SWITCH_RESPAWN_FAILED',
      message: error instanceof Error ? error.message : 'Seat switch failed; rolled back to the prior seat.',
    };
  }

  // (e) Re-read seed status — informational; a failure never fails the switch.
  if (deps.reseedStatus) {
    try {
      await deps.reseedStatus(targetSeatId);
    } catch {
      // ignore — the runtime is already on the new seat.
    }
  }

  // (f) Persist the B3 pointer — BEST-EFFORT. The local switch already
  // succeeded; a network failure here must NOT roll back a working local switch.
  let persistFailed = false;
  if (deps.persistActiveSeat) {
    try {
      await deps.persistActiveSeat(targetSeatId);
    } catch {
      persistFailed = true;
    }
  }

  return { ok: true, active_seat_id: targetSeatId, rolled_back: false, ...(persistFailed ? { persist_failed: true } : {}) };
}

// ---------------------------------------------------------------------------
// B3 my-seats data contract + SeatGuard access classification (PURE).
//
// The my-seats edge function (B3, AUTHORED not deployed) returns:
//   { account{id,role}, seats[{tenant_id,name,role,is_active}], active_seat_id }
// We parse it DEFENSIVELY (it crosses the wire) and classify access fail-closed.
// ---------------------------------------------------------------------------

export type SeatRole = 'admin' | 'delegate';

export interface SeatListEntry {
  seat_id: string;
  name: string;
  role: SeatRole;
  is_active: boolean;
}

export interface MySeatsContract {
  account_id: string | null;
  /** Account-level role. admin ⇒ may switch across all seats; delegate ⇒ pinned. */
  role: SeatRole;
  active_seat_id: string;
  seats: SeatListEntry[];
}

/**
 * The renderer's resolved access posture. FAIL-CLOSED: unknown/missing role or
 * an unparseable payload resolves to a single PINNED delegate seat — never an
 * admin who could switch.
 */
export interface SeatAccess {
  role: SeatRole;
  /** True ONLY when role==='admin' AND there is more than one seat. */
  canSwitch: boolean;
  /** The seat the delegate is hard-pinned to (their single assigned/active seat). */
  pinnedSeatId: string;
  activeSeatId: string;
  seats: SeatListEntry[];
}

function asSeatRole(value: unknown): SeatRole {
  // DEFAULT-DENY: anything that is not the literal string 'admin' is a delegate.
  return value === 'admin' ? 'admin' : 'delegate';
}

/**
 * Parse a raw my-seats wire payload into the typed contract, fail-closed.
 * Returns `null` when the payload is structurally unusable (the caller then
 * treats the user as a single pinned delegate on the legacy seat).
 */
export function parseMySeats(raw: unknown): MySeatsContract | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const account = (obj.account && typeof obj.account === 'object' ? obj.account : {}) as Record<string, unknown>;
  const accountId = typeof account.id === 'string' && account.id.length > 0 ? account.id : null;
  const role = asSeatRole(account.role);

  const rawSeats = Array.isArray(obj.seats) ? obj.seats : [];
  const seats: SeatListEntry[] = [];
  for (const entry of rawSeats) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    // Only accept a seat whose id sanitizes (a real UUID/safe-slug OR a legacy
    // alias). A non-sanitizable id is dropped — it can never become a path
    // segment, so it must never appear in the switch list either.
    const sanitized = sanitizeSeatId(typeof e.tenant_id === 'string' ? e.tenant_id : undefined);
    if (sanitized === null) continue;
    seats.push({
      seat_id: sanitized,
      name: typeof e.name === 'string' && e.name.length > 0 ? e.name : sanitized,
      role: asSeatRole(e.role),
      is_active: e.is_active === true,
    });
  }

  const sanitizedActive = sanitizeSeatId(typeof obj.active_seat_id === 'string' ? obj.active_seat_id : undefined);
  const activeSeatId = sanitizedActive ?? LEGACY_SEAT_ID;

  return { account_id: accountId, role, active_seat_id: activeSeatId, seats };
}

/**
 * Resolve the SeatGuard access posture from a parsed contract (or `null`).
 *
 * FAIL-CLOSED invariants:
 *  - `null` contract (unparseable / bridge error) ⇒ delegate pinned to the
 *    legacy seat, canSwitch=false.
 *  - role !== 'admin' ⇒ delegate; canSwitch=false REGARDLESS of seat count.
 *  - admin with <= 1 seat ⇒ canSwitch=false (nothing to switch to; legacy/single
 *    seat is byte-identical — no switcher shown).
 *  - admin with > 1 seat ⇒ canSwitch=true.
 *  - the pinned seat for a delegate is their single seat: the active seat if it
 *    is in their list, else the first listed seat, else the legacy seat.
 */
export function resolveSeatAccess(contract: MySeatsContract | null): SeatAccess {
  if (contract === null) {
    return {
      role: 'delegate',
      canSwitch: false,
      pinnedSeatId: LEGACY_SEAT_ID,
      activeSeatId: LEGACY_SEAT_ID,
      seats: [],
    };
  }

  const { role, seats } = contract;
  const activeSeatId = contract.active_seat_id || LEGACY_SEAT_ID;

  // The delegate's pinned seat: prefer the active seat IF it is one of theirs;
  // else the first seat they can see; else the legacy fallback.
  const activeInList = seats.some((s) => s.seat_id === activeSeatId);
  const pinnedSeatId = activeInList ? activeSeatId : seats[0]?.seat_id ?? LEGACY_SEAT_ID;

  // canSwitch ONLY for an admin with a real choice (>1 seat). Default-deny.
  const canSwitch = role === 'admin' && seats.length > 1;

  return { role, canSwitch, pinnedSeatId, activeSeatId, seats };
}

/**
 * SERVER-SIDE / IPC admin guard for the switch handler. Returns true ONLY when
 * the access posture permits switching to `targetSeatId`:
 *  - role must be admin AND canSwitch,
 *  - the target must be one of the seats the caller is authorized to see.
 *
 * A delegate (or an admin trying to reach a seat NOT in their authorized list)
 * is rejected — this is the IPC-level fail-closed gate that a renderer guard
 * alone could not enforce. Legacy/no-account always rejects a NON-legacy target
 * (single-seat installs never switch).
 */
export function isSeatSwitchAuthorized(access: SeatAccess, targetSeatId: string): boolean {
  if (!access.canSwitch) return false;
  const sanitized = sanitizeSeatId(targetSeatId);
  if (sanitized === null) return false;
  // The legacy seat is never a switch target through an account switcher.
  if (isLegacySeatId(sanitized)) return false;
  return access.seats.some((s) => s.seat_id === sanitized);
}
