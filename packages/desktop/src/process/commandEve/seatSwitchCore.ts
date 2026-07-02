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
 * its prior value AND re-prepare the env for it AND re-invoke restartBackend so the
 * PRIOR seat's backend is running again — the pointer and the LIVE agent agree. The
 * restart hook (index.ts) stop()s the current process tree BEFORE it start()s, so a
 * switch whose start() threw already SIGTERM/SIGKILLed the old backend: without this
 * rollback-restart the renderer would show "back on the prior seat" while aioncore is
 * DEAD (every chat/bridge call fails until a relaunch). We now restart it.
 *
 * HONEST POST-ROLLBACK CONTRACT (Hotfix-B):
 *   - restartBackend threw, prior-seat restart SUCCEEDS ⇒ ok:false, rolled_back:true,
 *     reason_code SEAT_SWITCH_RESPAWN_FAILED, backend LIVE on the prior seat (the
 *     pointer is truthful — a plain retry is safe).
 *   - restartBackend threw AND the prior-seat restart ALSO fails ⇒ ok:false,
 *     rolled_back:true, backend_down:true, reason_code
 *     SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN. The renderer surfaces a DISTINCT
 *     fail-closed error (switch failed AND backend down — needs relaunch), NOT a
 *     clean rollback. The restart hook clears __backendPort so nothing points at a
 *     dead pid. There is NO silent dead-backend state.
 * The rollback re-invokes restartBackend AT MOST ONCE, so a persistently-throwing
 * restart cannot recurse (no infinite restart loop).
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
  DEFAULT_SEAT_KIND,
  DEFAULT_SEAT_LABEL,
  LEGACY_SEAT_ID,
  assertSeatId,
  clearActiveSeat,
  getActiveSeatId,
  getActiveSeatKind,
  getActiveSeatLabel,
  isLegacySeatId,
  sanitizeSeatId,
  setActiveSeatId,
  setActiveSeatKind,
  setActiveSeatLabel,
} from './seatContextCore';

// Pure re-exports so the renderer can classify the active seat (Founder/legacy
// vs a real client seat) WITHOUT importing seatContextCore directly (which pulls
// in Node `os`/`path` at module top). Both are pure values/functions — used by
// the A3 billing consumption card to decide the founder-summary visibility.
export { LEGACY_SEAT_ID, isLegacySeatId };

/** Stable result envelope returned to the bridge / renderer. */
export interface SeatSwitchResult {
  ok: boolean;
  /** The seat the runtime ended up on (the target on success, the prior seat after a rollback). */
  active_seat_id: string;
  /** True when the runtime was rolled back to the prior seat after a structural failure. */
  rolled_back: boolean;
  /**
   * True when the switch failed AND the prior-seat backend could NOT be restarted
   * (both restartBackend AND the rollback-restart threw). The runtime pointer is on
   * the prior seat but NO backend is running — the renderer must surface a real
   * error (relaunch/retry needed), NOT report a clean rollback. Set ONLY on the
   * SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN fail-closed path.
   */
  backend_down?: boolean;
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
 * @param deps the injectable side-effecting seams.
 * @param targetLabel OPTIONAL display label for the target seat (Seat-Context-
 *   Bridge / B1). Captured from the SAME wire seat record the caller already holds
 *   (access.seats[].name) — NO network here. Set alongside setActiveSeatId in the
 *   structural phase so the very next env bake carries the new label. A legacy/
 *   founder target folds to 'Founder' (setActiveSeatLabel defaults a blank to it).
 */
export async function applySeatSwitch(
  newSeatId: string | null | undefined,
  deps: SeatSwitchDeps,
  targetLabel?: string | null,
  targetKind?: SeatKind | null
): Promise<SeatSwitchResult> {
  const priorSeatId = getActiveSeatId();
  const priorSeatLabel = getActiveSeatLabel();
  const priorSeatKind = getActiveSeatKind();

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
    // Audit INFO fix: refresh the DISPLAY LABEL on the no-op path from the wire name
    // the caller already threaded (access.seats[].name). A client seat renamed
    // server-side then re-selected in place would otherwise keep the stale label
    // (the label holder is only re-set on the structural switch path below). A
    // legacy/founder target folds to 'Founder'. Pure: no network, no restart — the
    // fresh label reaches the agent on the NEXT genuine switch's env bake, and any
    // label read (env trio / prompt) sees the current name immediately. Only touched
    // when a label was actually provided (undefined ⇒ leave the holder as-is).
    if (targetLabel !== undefined) {
      setActiveSeatLabel(isLegacySeatId(targetSeatId) ? DEFAULT_SEAT_LABEL : targetLabel);
    }
    // K2: refresh the kind holder alongside the label on the in-place re-select
    // (a seat re-classified server-side then re-selected picks up the new kind).
    // A legacy/founder target folds to the DEFAULT ('client') — the legacy branch
    // never consults kind. Only touched when a kind was actually threaded.
    if (targetKind !== undefined) {
      setActiveSeatKind(isLegacySeatId(targetSeatId) ? DEFAULT_SEAT_KIND : targetKind);
    }
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

  // Roll the runtime back to the prior seat on a structural failure. Re-bake the
  // env for the prior seat (re-homes process.env.HERMES_HOME) AND re-invoke
  // restartBackend so the prior seat's agent is LIVE again — the restart hook
  // stop()s BEFORE it start()s, so if restartBackend was the step that threw the
  // old backend is already dead; we MUST bring it back or the pointer would claim
  // a seat with no running agent (the silent dead-backend bug this fix closes).
  //
  // Returns whether the prior-seat backend is live afterwards:
  //   true  ⇒ restart succeeded — the pointer + a running agent AGREE (retry-safe).
  //   false ⇒ the rollback-restart ALSO failed — the caller surfaces the distinct
  //           SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN fail-closed state (relaunch needed).
  // restartBackend is re-invoked AT MOST ONCE here, so a persistently-throwing
  // restart can never recurse (no infinite restart loop).
  const rollback = async (): Promise<{ backendLive: boolean }> => {
    try {
      setActiveSeatId(priorSeatId);
      // Restore the prior label too so the id + label holders never disagree (the
      // rolled-back env bake must carry the prior seat's label, not the target's).
      setActiveSeatLabel(priorSeatLabel);
      // K2: restore the prior kind for the same reason — the rolled-back env bake
      // + tier stamp must carry the prior seat's kind, not the failed target's.
      setActiveSeatKind(priorSeatKind);
    } catch {
      // The prior seat was already sanitized once (it was active); if it somehow
      // fails to re-set, fall back to the hard legacy default — never leave the
      // holder pointing at the failed target.
      clearActiveSeat();
    }
    try {
      await deps.prepareEnv();
    } catch {
      // Best-effort env re-home on rollback; the holder is already reverted. Do NOT
      // attempt the restart on a failed env bake — a restart under the wrong home
      // would be worse than a clean fail-closed. Treat as backend-down.
      return { backendLive: false };
    }
    // Re-spawn the prior seat's backend so the live agent matches the restored
    // pointer. A throw here is the fail-closed (b) path — backend stays down.
    try {
      await deps.restartBackend();
      return { backendLive: true };
    } catch {
      return { backendLive: false };
    }
  };

  // (b) Make the target active, then (c) re-home env, then (d) re-spawn.
  try {
    setActiveSeatId(targetSeatId); // (a→b boundary: holder now points at target
    // Seat-Context-Bridge (B1): capture the target label from the wire seat record
    // the caller threaded (access.seats[].name). Done HERE, alongside the id set,
    // so the prepareEnv bake immediately below carries the NEW label. A legacy/
    // founder target with no label folds to 'Founder'. Pure: no network.
    setActiveSeatLabel(isLegacySeatId(targetSeatId) ? DEFAULT_SEAT_LABEL : targetLabel);
    // K2: set the kind at the SAME set-point (after the label), from the wire
    // record the caller threaded, so the prepareEnv bake + the tier stamp below
    // carry the NEW kind. A legacy/founder target folds to DEFAULT ('client');
    // the legacy branch never consults kind. Pure: no network.
    setActiveSeatKind(isLegacySeatId(targetSeatId) ? DEFAULT_SEAT_KIND : targetKind);
    await deps.prepareEnv(); // (b) env.HERMES_HOME → seats/<target>/home
    await deps.restartBackend(); // (c) stop + re-spawn so the agent re-homes
    await deps.rebindConfig(targetSeatId); // (d) config cache re-reads under target
  } catch (error) {
    const { backendLive } = await rollback();
    const causeMessage = error instanceof Error ? error.message : 'Seat switch failed.';
    if (backendLive) {
      // (a) The prior seat's backend is running again — pointer + live agent AGREE.
      // An honest rollback: the switch failed but EVE is operational on the prior seat.
      return {
        ok: false,
        active_seat_id: getActiveSeatId(),
        rolled_back: true,
        reason_code: 'SEAT_SWITCH_RESPAWN_FAILED',
        message: `Seat switch failed; rolled back to the prior seat (backend restarted). Cause: ${causeMessage}`,
      };
    }
    // (b) FAIL-CLOSED: the switch failed AND the prior-seat backend could not be
    // restarted. The pointer is on the prior seat but NO agent is running — surface
    // a DISTINCT error so the renderer never claims a clean rollback. The restart
    // hook has cleared __backendPort (no dead-pid pointer).
    return {
      ok: false,
      active_seat_id: getActiveSeatId(),
      rolled_back: true,
      backend_down: true,
      reason_code: 'SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN',
      message: `Seat switch failed AND the backend could not be restarted — relaunch Command EVE. Cause: ${causeMessage}`,
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

// v1.5 K2: profile.kind — conditions ONLY prompt/display texts (§5 prompt-only).
// Re-exported from the seatContextCore SSOT so the desktop has ONE kind type.
export type { SeatKind } from './seatContextCore';
import type { SeatKind } from './seatContextCore';

export interface SeatListEntry {
  seat_id: string;
  name: string;
  /**
   * v1.5 K2: the seat's kind. Default-denied to 'client' (the strictest doctrine)
   * for absent/unknown/hostile values (asSeatKind). kind is prompt-only.
   */
  kind: SeatKind;
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
 * v1.5 K2: coerce a wire `kind` value to a SeatKind, DEFAULT-DENY. Only the two
 * literals 'own_company' / 'department' are accepted; ALL else — absent, null, a
 * typo, uppercase 'CLIENT', a hostile value — folds to 'client' (the strictest
 * doctrine). Mirrors asSeatRole. This is the fail-conservative invariant at the
 * parser boundary: a version-skew backend without kind, or a corrupt payload,
 * degrades to full client isolation, never to a laxer posture.
 */
function asSeatKind(value: unknown): SeatKind {
  return value === 'own_company' || value === 'department' ? value : 'client';
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
      // K2: tolerate the wire's kind (absent/unknown ⇒ 'client', default-deny).
      kind: asSeatKind(e.kind),
      role: asSeatRole(e.role),
      is_active: e.is_active === true,
    });
  }

  const sanitizedActive = sanitizeSeatId(typeof obj.active_seat_id === 'string' ? obj.active_seat_id : undefined);
  const activeSeatId = sanitizedActive ?? LEGACY_SEAT_ID;

  return { account_id: accountId, role, active_seat_id: activeSeatId, seats };
}

/**
 * The synthetic FOUNDER chip (spec B4.2). The legacy seat ('seat-1') is the
 * founder's HOME; the my-seats wire never lists it (the server only knows real
 * tenant seats, never the desktop's legacy alias). Without this chip an admin who
 * switched into a client seat could never return home — and the switch guard
 * (isSeatSwitchAuthorized) would reject 'seat-1' because it is not in seats[].
 * We PREPEND it (top of the rail) for ADMINS ONLY, so the founder always has a
 * visible, switchable way back. A delegate never gets it (they own no account and
 * see nothing anyway — invariant: a delegate can never reach the founder home).
 */
const FOUNDER_CHIP_NAME = 'Founder';

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
 *
 * FOUNDER CHIP (admin only): the legacy 'seat-1' home is PREPENDED first for an
 * admin (see FOUNDER_CHIP_NAME) so the founder can always return home. This is
 * the ONE clean enrichment point — both the renderer (useSeatAccess) and the main
 * switch guard resolve through here, so the chip is present consistently for the
 * rail display AND for the isSeatSwitchAuthorized list-membership check. Because
 * the chip adds a seat, an admin with a single client seat now has 2 seats ⇒
 * canSwitch=true (they can hop between that client and home) — the intended fix.
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

  const { role } = contract;
  const activeSeatId = contract.active_seat_id || LEGACY_SEAT_ID;

  // Prepend the Founder chip for admins (idempotent — never double-prepend if the
  // wire somehow already surfaced the legacy seat). Delegates get the wire's seats
  // verbatim (no founder home). Placed FIRST so it sits at the top of the rail.
  let seats = contract.seats;
  if (role === 'admin' && !seats.some((s) => isLegacySeatId(s.seat_id))) {
    seats = [
      {
        seat_id: LEGACY_SEAT_ID,
        name: FOUNDER_CHIP_NAME,
        // K2 cosmetic: the founder home is the operator's OWN company. The legacy
        // branch never consults kind (isLegacySeatId short-circuits the client
        // doctrine anyway), so this only labels the chip honestly for a UI that
        // reads it.
        kind: 'own_company',
        role: 'admin',
        is_active: activeSeatId === LEGACY_SEAT_ID,
      },
      ...seats,
    ];
  }

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
 * alone could not enforce.
 *
 * LEGACY SEAT AS TARGET (spec B4.2 — un-strand the founder): the legacy 'seat-1'
 * is the FOUNDER'S HOME. It USED to be forbidden as any switch target, which
 * stranded an admin in a client seat with no way back. New rule: an ADMIN MAY
 * switch to the legacy seat (it is prepended to their authorized list as the
 * Founder chip by resolveSeatAccess, so the membership check below admits it). A
 * DELEGATE still can NEVER reach it — a delegate never has canSwitch=true and
 * never has the legacy seat in their list, so both guards reject them. This keeps
 * every other fail-closed guard intact (unsafe id, unlisted target, non-admin).
 */
export function isSeatSwitchAuthorized(access: SeatAccess, targetSeatId: string): boolean {
  if (!access.canSwitch) return false;
  // An EMPTY / whitespace target is not a switch intent (it is a missing id, not a
  // "go home" request). Reject it BEFORE sanitizing — otherwise it would fold to the
  // legacy seat and, now that admins may target the legacy home, silently authorize a
  // home-switch on an empty string. An EXPLICIT legacy alias ('seat-1'/'default') is
  // still a valid target (handled by sanitize + the membership check below).
  if (typeof targetSeatId !== 'string' || targetSeatId.trim().length === 0) return false;
  const sanitized = sanitizeSeatId(targetSeatId);
  if (sanitized === null) return false;
  // The legacy seat is a valid target ONLY when it is in the caller's authorized
  // list (resolveSeatAccess prepends it for admins as the Founder home; delegates
  // never have it). We no longer hard-block it here — membership is the gate.
  return access.seats.some((s) => s.seat_id === sanitized);
}
