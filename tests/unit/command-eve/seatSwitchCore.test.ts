/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A5 ADVERSARIAL leak-CI for the seat-switch lifecycle (the GATE-NULL runtime
 * keystone). Proves: (1) the switch fires every seam in the right ORDER and
 * re-homes the env to seats/<new>/home (not legacy /home); (2) a switch WITHOUT
 * a re-spawn leaves the simulated running agent on the OLD home (re-spawn is
 * mandatory); (3) a failed re-spawn rolls back to the prior seat (no
 * half-switched state); (4) a path-traversal/NUL/separator id is rejected
 * fail-closed BEFORE any mutation; (5) the SeatGuard classification is
 * fail-closed (unknown ⇒ delegate, never admin) + a delegate can never be
 * authorized to a foreign seat; (6) legacy/single-seat triggers NO re-spawn.
 */

import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applySeatSwitch,
  isSeatSwitchAuthorized,
  parseMySeats,
  resolveSeatAccess,
  type SeatSwitchDeps,
} from '@process/commandEve/seatSwitchCore';
import {
  LEGACY_SEAT_ID,
  __resetActiveSeatForTests,
  getActiveSeatId,
  getActiveSeatKind,
  getActiveSeatLabel,
  resolveActiveSeatHome,
  setActiveSeatId,
} from '@process/commandEve/seatContextCore';

const USER_DATA = path.resolve('/tmp/command-eve-test-userdata');
const SEAT_A = '11111111-1111-1111-1111-111111111111';
const SEAT_B = '22222222-2222-2222-2222-222222222222';

/**
 * A test harness that simulates the env + a "running agent" whose HERMES_HOME is
 * FROZEN at the value present when restartBackend (re-spawn) last ran — exactly
 * the env-inheritance pinning the real backend has.
 */
function makeHarness() {
  const env: { HERMES_HOME?: string } = { HERMES_HOME: resolveActiveSeatHome(USER_DATA).hermesHome };
  // The simulated running agent's frozen home (only re-homed on a re-spawn).
  let agentFrozenHome = env.HERMES_HOME;
  const calls: string[] = [];

  const prepareEnv = vi.fn(() => {
    calls.push('prepareEnv');
    // Re-bake env.HERMES_HOME for the CURRENTLY-active seat (what the real
    // prepareCommandEveRuntimeProcessEnv does).
    env.HERMES_HOME = resolveActiveSeatHome(USER_DATA).hermesHome;
  });
  const restartBackend = vi.fn(() => {
    calls.push('restartBackend');
    // Re-spawn: the new agent inherits the CURRENT env.HERMES_HOME.
    agentFrozenHome = env.HERMES_HOME;
  });
  const rebindConfig = vi.fn((seatId: string) => {
    calls.push(`rebindConfig:${seatId}`);
  });
  const reseedStatus = vi.fn((seatId: string) => {
    calls.push(`reseedStatus:${seatId}`);
  });
  const persistActiveSeat = vi.fn((seatId: string) => {
    calls.push(`persist:${seatId}`);
  });

  const deps: SeatSwitchDeps = { prepareEnv, restartBackend, rebindConfig, reseedStatus, persistActiveSeat };
  return {
    deps,
    calls,
    env,
    get agentFrozenHome() {
      return agentFrozenHome;
    },
    mocks: { prepareEnv, restartBackend, rebindConfig, reseedStatus, persistActiveSeat },
  };
}

beforeEach(() => {
  __resetActiveSeatForTests();
});
afterEach(() => {
  __resetActiveSeatForTests();
  vi.restoreAllMocks();
});

describe('applySeatSwitch — ordering + env re-home (the keystone)', () => {
  it('fires the seams in the documented ORDER and re-homes the env + agent to seats/<new>/home', async () => {
    const h = makeHarness();
    const result = await applySeatSwitch(SEAT_A, h.deps);

    expect(result.ok).toBe(true);
    expect(result.active_seat_id).toBe(SEAT_A);
    expect(result.rolled_back).toBe(false);

    // ORDER: setActiveSeatId happens inside applySeatSwitch BEFORE prepareEnv; we
    // observe persist → prepareEnv → restartBackend → rebindConfig → reseed →
    // persist.
    //
    // The LEADING persist is the CEVE-18205 durability write: the pointer is
    // written the instant the seat lands, not only at step (f), so a switch that
    // dies mid-restart still heals on the next boot instead of needing a manual
    // re-switch. It is deliberately BEFORE prepareEnv — that is the whole point,
    // and the sibling test below pins that the crash window is covered.
    expect(h.calls).toEqual([
      `persist:${SEAT_A}`,
      'prepareEnv',
      'restartBackend',
      `rebindConfig:${SEAT_A}`,
      `reseedStatus:${SEAT_A}`,
      `persist:${SEAT_A}`,
    ]);

    // The active seat moved, and the env + the re-spawned agent point UNDER
    // seats/<A>/home — NOT the legacy /home.
    expect(getActiveSeatId()).toBe(SEAT_A);
    const expectedHome = path.join(USER_DATA, 'command-eve-runtime', 'hermes', 'seats', SEAT_A, 'home');
    expect(resolveActiveSeatHome(USER_DATA).hermesHome).toBe(expectedHome);
    expect(h.env.HERMES_HOME).toBe(expectedHome);
    expect(h.agentFrozenHome).toBe(expectedHome);
    // The legacy home is NOT where we ended up.
    expect(expectedHome).not.toBe(path.join(USER_DATA, 'command-eve-runtime', 'hermes', 'home'));
  });

  it('setActiveSeatId runs BEFORE prepareEnv (prepareEnv observes the NEW seat)', async () => {
    const h = makeHarness();
    let seatSeenByPrepareEnv = '';
    h.mocks.prepareEnv.mockImplementation(() => {
      // At prepareEnv time the active seat MUST already be the target.
      seatSeenByPrepareEnv = getActiveSeatId();
      h.env.HERMES_HOME = resolveActiveSeatHome(USER_DATA).hermesHome;
    });
    await applySeatSwitch(SEAT_B, h.deps);
    expect(seatSeenByPrepareEnv).toBe(SEAT_B);
  });
});

describe('applySeatSwitch — env-freeze proof (re-spawn is MANDATORY)', () => {
  it('a switch WITHOUT a re-spawn leaves the running agent on the OLD home (proves the leak)', async () => {
    // Switch once to A (full re-spawn) so the agent is frozen on A's home.
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps);
    const aHome = h.agentFrozenHome;

    // Now simulate a BROKEN switch that re-homes the env but SKIPS the re-spawn.
    setActiveSeatId(SEAT_B);
    h.mocks.prepareEnv(); // env now points at B
    // (no restartBackend call)
    const bHome = resolveActiveSeatHome(USER_DATA).hermesHome;

    // The env moved to B, but the still-running agent is STILL frozen on A —
    // this is exactly the cross-seat leak a switch without re-spawn would cause.
    expect(h.env.HERMES_HOME).toBe(bHome);
    expect(h.agentFrozenHome).toBe(aHome);
    expect(h.agentFrozenHome).not.toBe(bHome);
  });
});

describe('applySeatSwitch — failed re-spawn rolls back (no half-switched state)', () => {
  it('rolls back to the prior seat, RE-STARTS the prior-seat backend, and re-homes the env when the switch re-spawn throws (Hotfix-B: pointer + live agent agree)', async () => {
    // Start on A (clean re-spawn).
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps);
    h.calls.length = 0;
    h.mocks.restartBackend.mockClear();

    // Now a switch to B whose FORWARD re-spawn FAILS. The SECOND restartBackend
    // call (the rollback-restart for the prior seat A) uses the default mock and
    // SUCCEEDS — so the prior seat's backend comes back live.
    h.mocks.restartBackend.mockImplementationOnce(() => {
      throw new Error('aioncore failed to re-spawn');
    });
    const result = await applySeatSwitch(SEAT_B, h.deps);

    expect(result.ok).toBe(false);
    expect(result.rolled_back).toBe(true);
    expect(result.reason_code).toBe('SEAT_SWITCH_RESPAWN_FAILED');
    // NOT the dead-backend fail-closed state: the prior seat is live.
    expect(result.backend_down).toBeUndefined();

    // Rolled back to A — NOT stuck half-way on B.
    expect(getActiveSeatId()).toBe(SEAT_A);
    const aHome = path.join(USER_DATA, 'command-eve-runtime', 'hermes', 'seats', SEAT_A, 'home');
    expect(resolveActiveSeatHome(USER_DATA).hermesHome).toBe(aHome);
    expect(h.env.HERMES_HOME).toBe(aHome);
    // Hotfix-B: restartBackend ran TWICE — the failed forward re-spawn AND the
    // successful rollback-restart for the prior seat — and the simulated running
    // agent is now FROZEN on A's home (a live agent that matches the pointer).
    expect(h.mocks.restartBackend).toHaveBeenCalledTimes(2);
    expect(h.agentFrozenHome).toBe(aHome);
    // persist must NOT have fired for the failed target.
    expect(h.mocks.persistActiveSeat).not.toHaveBeenCalledWith(SEAT_B);
  });

  it('FAIL-CLOSED (Hotfix-B): when the switch re-spawn AND the rollback-restart BOTH throw ⇒ backend_down + SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN (not a clean rollback)', async () => {
    // Start on A (clean re-spawn).
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps);
    h.calls.length = 0;
    h.mocks.restartBackend.mockClear();

    // BOTH the forward re-spawn AND the rollback-restart throw (e.g. corrupted venv
    // that fails for every seat). The prior-seat backend cannot be brought back.
    h.mocks.restartBackend.mockImplementation(() => {
      throw new Error('corrupted venv — every spawn fails');
    });
    const result = await applySeatSwitch(SEAT_B, h.deps);

    expect(result.ok).toBe(false);
    expect(result.rolled_back).toBe(true);
    expect(result.backend_down).toBe(true);
    expect(result.reason_code).toBe('SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN');

    // Pointer is honestly on the prior seat A (env re-homed there), but the caller
    // now KNOWS the backend is down — no silent dead-backend reported as clean.
    expect(getActiveSeatId()).toBe(SEAT_A);
    const aHome = path.join(USER_DATA, 'command-eve-runtime', 'hermes', 'seats', SEAT_A, 'home');
    expect(h.env.HERMES_HOME).toBe(aHome);
    // The rollback re-invoked restartBackend AT MOST ONCE (no infinite loop): the
    // forward attempt + exactly one rollback-restart attempt = 2 total.
    expect(h.mocks.restartBackend).toHaveBeenCalledTimes(2);
    expect(h.mocks.persistActiveSeat).not.toHaveBeenCalledWith(SEAT_B);
  });

  it('a failed re-spawn from the LEGACY seat rolls back to legacy (and restarts the legacy backend)', async () => {
    const h = makeHarness();
    h.mocks.restartBackend.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const result = await applySeatSwitch(SEAT_A, h.deps);
    expect(result.ok).toBe(false);
    expect(result.rolled_back).toBe(true);
    // The rollback-restart (default mock) succeeds ⇒ honest rollback, backend live.
    expect(result.reason_code).toBe('SEAT_SWITCH_RESPAWN_FAILED');
    expect(result.backend_down).toBeUndefined();
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);
  });
});

describe('applySeatSwitch — path-traversal fail-closed', () => {
  it.each(['../seat-b', '..', 'seat/../../etc', 'a\0b', 'seat\\b', '/abs/seat'])(
    'rejects unsafe id %j BEFORE any mutation and leaves the active seat unchanged',
    async (badId) => {
      // Establish a known prior seat (A).
      const h = makeHarness();
      await applySeatSwitch(SEAT_A, h.deps);
      h.calls.length = 0;
      h.mocks.prepareEnv.mockClear();
      h.mocks.restartBackend.mockClear();

      const result = await applySeatSwitch(badId, h.deps);
      expect(result.ok).toBe(false);
      expect(result.reason_code).toBe('SEAT_SWITCH_REJECTED_UNSAFE_ID');
      expect(result.rolled_back).toBe(false);
      // NOTHING ran — no env re-home, no re-spawn — and the active seat is still A.
      expect(h.mocks.prepareEnv).not.toHaveBeenCalled();
      expect(h.mocks.restartBackend).not.toHaveBeenCalled();
      expect(getActiveSeatId()).toBe(SEAT_A);
    }
  );
});

describe('applySeatSwitch — legacy / no-op single-seat triggers NO re-spawn', () => {
  it('switching to the seat we are already on does NOT re-spawn the backend', async () => {
    const h = makeHarness();
    // Active seat is LEGACY by default; "switch" to legacy.
    const result = await applySeatSwitch(LEGACY_SEAT_ID, h.deps);
    expect(result.ok).toBe(true);
    expect(result.active_seat_id).toBe(LEGACY_SEAT_ID);
    expect(h.mocks.prepareEnv).not.toHaveBeenCalled();
    expect(h.mocks.restartBackend).not.toHaveBeenCalled();
  });

  it('switching to the currently-active real seat is a no-op re-spawn', async () => {
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps);
    h.mocks.restartBackend.mockClear();
    const result = await applySeatSwitch(SEAT_A, h.deps);
    expect(result.ok).toBe(true);
    expect(h.mocks.restartBackend).not.toHaveBeenCalled();
  });

  it('the no-op path REFRESHES the display label from the wire name (server-side rename re-selected in place) without re-spawning (audit INFO)', async () => {
    const h = makeHarness();
    // Land on A with its original label.
    await applySeatSwitch(SEAT_A, h.deps, 'Bäckerei Müller');
    expect(getActiveSeatLabel()).toBe('Bäckerei Müller');
    h.mocks.restartBackend.mockClear();

    // The seat was renamed server-side; the operator re-selects it in place. The
    // no-op fast path must pick up the NEW wire name — no restart, no rollback.
    const result = await applySeatSwitch(SEAT_A, h.deps, 'Bäckerei Müller GmbH');
    expect(result.ok).toBe(true);
    expect(result.rolled_back).toBe(false);
    expect(h.mocks.restartBackend).not.toHaveBeenCalled();
    expect(getActiveSeatLabel()).toBe('Bäckerei Müller GmbH');
  });

  it('the no-op path leaves the label UNTOUCHED when no wire label is provided', async () => {
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps, 'Kanzlei Schmidt');
    expect(getActiveSeatLabel()).toBe('Kanzlei Schmidt');
    // Re-select in place with no label ⇒ holder unchanged (no accidental blank).
    const result = await applySeatSwitch(SEAT_A, h.deps);
    expect(result.ok).toBe(true);
    expect(getActiveSeatLabel()).toBe('Kanzlei Schmidt');
  });
});

describe('K2 parseMySeats — kind tolerance (default-deny to client)', () => {
  const wire = (kind?: unknown) => ({
    account: { id: 'acc1', role: 'admin' },
    active_seat_id: SEAT_A,
    seats: [{ tenant_id: SEAT_A, name: 'A', ...(kind === undefined ? {} : { kind }) }],
  });
  const kindOf = (k?: unknown) => parseMySeats(wire(k))!.seats.find((s) => s.seat_id === SEAT_A)!.kind;

  it('accepts the two literals own_company / department', () => {
    expect(kindOf('own_company')).toBe('own_company');
    expect(kindOf('department')).toBe('department');
  });

  it('folds absent / null / typo / uppercase / hostile / explicit-client to client (default-deny)', () => {
    expect(kindOf(undefined)).toBe('client'); // absent
    expect(kindOf(null)).toBe('client');
    expect(kindOf('client')).toBe('client');
    expect(kindOf('CLIENT')).toBe('client'); // case-sensitive literal match
    expect(kindOf('own-company')).toBe('client'); // hyphen typo
    expect(kindOf('__proto__')).toBe('client'); // hostile
    expect(kindOf(42)).toBe('client'); // non-string
  });
});

describe('K2 applySeatSwitch — kind holder threading (set / restore)', () => {
  it('the structural switch sets the kind holder from the wire record', async () => {
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps, 'Klinik Salem', 'client');
    expect(getActiveSeatKind()).toBe('client');
    await applySeatSwitch(SEAT_B, h.deps, 'FYN Labs', 'own_company');
    expect(getActiveSeatKind()).toBe('own_company');
  });

  it('a legacy/founder target folds the kind holder to the default (client)', async () => {
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps, 'FYN Labs', 'own_company');
    expect(getActiveSeatKind()).toBe('own_company');
    // Switching home resets kind (legacy never consults kind, folds to default).
    await applySeatSwitch(LEGACY_SEAT_ID, h.deps, 'Founder', 'own_company');
    expect(getActiveSeatKind()).toBe('client');
  });

  it('a failed re-spawn ROLLS BACK the kind holder to the prior seat kind', async () => {
    const h = makeHarness();
    // Land on an own_company seat.
    await applySeatSwitch(SEAT_A, h.deps, 'FYN Labs', 'own_company');
    expect(getActiveSeatKind()).toBe('own_company');
    // Make the next switch's restart throw so it rolls back.
    h.mocks.restartBackend.mockRejectedValueOnce(new Error('respawn boom'));
    const result = await applySeatSwitch(SEAT_B, h.deps, 'Klinik Salem', 'client');
    expect(result.ok).toBe(false);
    expect(result.rolled_back).toBe(true);
    // The kind holder is restored to the prior (own_company), not the failed target's.
    expect(getActiveSeatKind()).toBe('own_company');
  });

  it('the no-op in-place re-select refreshes the kind (server-side re-classification)', async () => {
    const h = makeHarness();
    await applySeatSwitch(SEAT_A, h.deps, 'A', 'client');
    expect(getActiveSeatKind()).toBe('client');
    h.mocks.restartBackend.mockClear();
    // Re-select A in place after it was re-classified to own_company.
    const result = await applySeatSwitch(SEAT_A, h.deps, 'A', 'own_company');
    expect(result.ok).toBe(true);
    expect(h.mocks.restartBackend).not.toHaveBeenCalled();
    expect(getActiveSeatKind()).toBe('own_company');
  });
});

describe('applySeatSwitch — persist is BEST-EFFORT (local switch still succeeds)', () => {
  it('a failed persistActiveSeat does NOT fail or roll back the local switch', async () => {
    const h = makeHarness();
    // BOTH writes fail — the real shape of a broken disk / read-only volume. (A
    // `mockImplementationOnce` would now only hit the early durability write,
    // which is swallowed by design; see the recovery case below.)
    h.mocks.persistActiveSeat.mockImplementation(() => {
      throw new Error('network down');
    });
    const result = await applySeatSwitch(SEAT_A, h.deps);
    expect(result.ok).toBe(true);
    expect(result.persist_failed).toBe(true);
    expect(result.rolled_back).toBe(false);
    expect(getActiveSeatId()).toBe(SEAT_A);
  });

  it('a TRANSIENT failure on the early write is recovered by the confirmation write', async () => {
    // CEVE-18205: the early write is best-effort precisely so a hiccup on it
    // cannot abort a live switch. Step (f) writes the same value moments later,
    // so the pointer still lands and the operator is told nothing is wrong.
    const h = makeHarness();
    h.mocks.persistActiveSeat.mockImplementationOnce(() => {
      throw new Error('transient');
    });
    const result = await applySeatSwitch(SEAT_A, h.deps);
    expect(result.ok).toBe(true);
    expect(result.persist_failed).toBeUndefined();
    expect(h.mocks.persistActiveSeat).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// SeatGuard classification (parseMySeats + resolveSeatAccess + isSeatSwitchAuthorized)
// ---------------------------------------------------------------------------

describe('SeatGuard — fail-closed classification', () => {
  it('a null/unparseable contract ⇒ delegate pinned to the legacy seat, canSwitch=false', () => {
    const access = resolveSeatAccess(null);
    expect(access.role).toBe('delegate');
    expect(access.canSwitch).toBe(false);
    expect(access.pinnedSeatId).toBe(LEGACY_SEAT_ID);
    expect(parseMySeats(undefined)).toBeNull();
    expect(parseMySeats('garbage')).toBeNull();
    expect(parseMySeats(42)).toBeNull();
  });

  it('unknown / missing role defaults to delegate, NOT admin', () => {
    const access = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1' },
        active_seat_id: SEAT_A,
        seats: [
          { tenant_id: SEAT_A, name: 'A', role: 'wat' },
          { tenant_id: SEAT_B, name: 'B' },
        ],
      })
    );
    expect(access.role).toBe('delegate');
    expect(access.canSwitch).toBe(false);
  });

  it('an admin with >1 seat ⇒ canSwitch=true; admin with ONE client seat now also canSwitch=true (Founder chip adds home, spec B4.2)', () => {
    const multi = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1', role: 'admin' },
        active_seat_id: SEAT_A,
        seats: [
          { tenant_id: SEAT_A, name: 'A', is_active: true },
          { tenant_id: SEAT_B, name: 'B' },
        ],
      })
    );
    expect(multi.role).toBe('admin');
    expect(multi.canSwitch).toBe(true);

    // Spec B4.2: resolveSeatAccess prepends the synthetic Founder (seat-1) chip for
    // admins, so an admin with a single CLIENT seat has TWO seats (Founder + client)
    // and CAN switch (they must be able to return home). The old "single seat admin ⇒
    // canSwitch=false" only holds now when the client-seat list is EMPTY (below).
    const single = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1', role: 'admin' },
        active_seat_id: SEAT_A,
        seats: [{ tenant_id: SEAT_A, name: 'A', is_active: true }],
      })
    );
    expect(single.canSwitch).toBe(true);
    expect(single.seats.map((s) => s.seat_id)).toEqual([LEGACY_SEAT_ID, SEAT_A]);

    // Admin with ZERO client seats ⇒ only the Founder chip ⇒ nothing to switch TO.
    const founderOnly = resolveSeatAccess(
      parseMySeats({ account: { id: 'acc1', role: 'admin' }, active_seat_id: LEGACY_SEAT_ID, seats: [] })
    );
    expect(founderOnly.canSwitch).toBe(false);
    expect(founderOnly.seats.map((s) => s.seat_id)).toEqual([LEGACY_SEAT_ID]);
  });

  it('the Founder chip is prepended FIRST for an admin, absent for a delegate, and rings when active (spec B4.2)', () => {
    // Admin: Founder chip is seat[0], named 'Founder', role 'admin'.
    const adminHome = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1', role: 'admin' },
        active_seat_id: LEGACY_SEAT_ID,
        seats: [{ tenant_id: SEAT_A, name: 'A' }],
      })
    );
    // K2: the Founder chip is cosmetically 'own_company' (the founder home is the operator's own).
    expect(adminHome.seats[0]).toEqual({
      seat_id: LEGACY_SEAT_ID,
      name: 'Founder',
      kind: 'own_company',
      role: 'admin',
      is_active: true,
    });
    expect(adminHome.activeSeatId).toBe(LEGACY_SEAT_ID);
    // The ring follows active_seat_id: at home the Founder chip is active, a client is not.
    expect(adminHome.seats.find((s) => s.seat_id === SEAT_A)?.is_active).toBe(false);

    // Admin sitting on a client seat: the Founder chip exists but does NOT ring.
    const adminOnClient = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1', role: 'admin' },
        active_seat_id: SEAT_A,
        seats: [{ tenant_id: SEAT_A, name: 'A' }],
      })
    );
    expect(adminOnClient.seats[0].seat_id).toBe(LEGACY_SEAT_ID);
    expect(adminOnClient.seats[0].is_active).toBe(false);
    expect(adminOnClient.activeSeatId).toBe(SEAT_A);

    // Delegate: NO Founder chip — they can never reach the founder home.
    const delegate = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1', role: 'delegate' },
        active_seat_id: SEAT_A,
        seats: [{ tenant_id: SEAT_A, name: 'A' }],
      })
    );
    expect(delegate.seats.some((s) => s.seat_id === LEGACY_SEAT_ID)).toBe(false);
  });

  it('a delegate is pinned even with multiple visible seats (over-scope guard)', () => {
    const access = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1', role: 'delegate' },
        active_seat_id: SEAT_A,
        seats: [
          { tenant_id: SEAT_A, name: 'A', is_active: true },
          { tenant_id: SEAT_B, name: 'B' },
        ],
      })
    );
    expect(access.role).toBe('delegate');
    expect(access.canSwitch).toBe(false);
    expect(access.pinnedSeatId).toBe(SEAT_A);
  });

  it('parseMySeats drops a non-sanitizable seat id (it can never become a path segment or a switch target)', () => {
    const parsed = parseMySeats({
      account: { id: 'acc1', role: 'admin' },
      active_seat_id: SEAT_A,
      seats: [
        { tenant_id: SEAT_A, name: 'A' },
        { tenant_id: '../evil', name: 'Evil' },
        { tenant_id: SEAT_B, name: 'B' },
      ],
    });
    expect(parsed?.seats.map((s) => s.seat_id)).toEqual([SEAT_A, SEAT_B]);
  });
});

describe('SeatGuard — isSeatSwitchAuthorized (the IPC-level gate)', () => {
  const adminAccess = resolveSeatAccess(
    parseMySeats({
      account: { id: 'acc1', role: 'admin' },
      active_seat_id: SEAT_A,
      seats: [
        { tenant_id: SEAT_A, name: 'A', is_active: true },
        { tenant_id: SEAT_B, name: 'B' },
      ],
    })
  );

  it('an admin may switch to a seat IN their authorized list', () => {
    expect(isSeatSwitchAuthorized(adminAccess, SEAT_B)).toBe(true);
  });

  it('an admin may NOT switch to a FOREIGN seat (not in their list)', () => {
    expect(isSeatSwitchAuthorized(adminAccess, '33333333-3333-3333-3333-333333333333')).toBe(false);
  });

  it('a DELEGATE can NEVER be authorized to switch, even to a seat in their list OR the legacy home', () => {
    const delegateAccess = resolveSeatAccess(
      parseMySeats({
        account: { id: 'acc1', role: 'delegate' },
        active_seat_id: SEAT_A,
        seats: [
          { tenant_id: SEAT_A, name: 'A' },
          { tenant_id: SEAT_B, name: 'B' },
        ],
      })
    );
    expect(isSeatSwitchAuthorized(delegateAccess, SEAT_B)).toBe(false);
    expect(isSeatSwitchAuthorized(delegateAccess, SEAT_A)).toBe(false);
    // Spec B4.2: a delegate stays PINNED — they can never reach the founder home
    // (no canSwitch, and the Founder chip is never added to their list).
    expect(isSeatSwitchAuthorized(delegateAccess, LEGACY_SEAT_ID)).toBe(false);
  });

  it('an ADMIN MAY return to the legacy Founder home; an unsafe target is still never authorized (spec B4.2)', () => {
    // CHANGED from "legacy target is never authorized": the legacy seat is the
    // founder's home and resolveSeatAccess prepends it to an admin's authorized list,
    // so an admin may switch back to it. Every other guard is intact.
    expect(isSeatSwitchAuthorized(adminAccess, LEGACY_SEAT_ID)).toBe(true);
    expect(isSeatSwitchAuthorized(adminAccess, 'seat-1')).toBe(true); // alias folds to legacy
    expect(isSeatSwitchAuthorized(adminAccess, '../seat-b')).toBe(false);
    expect(isSeatSwitchAuthorized(adminAccess, '')).toBe(false);
  });

  it('a fail-closed (null) access posture authorizes NOTHING', () => {
    expect(isSeatSwitchAuthorized(resolveSeatAccess(null), SEAT_A)).toBe(false);
  });
});
