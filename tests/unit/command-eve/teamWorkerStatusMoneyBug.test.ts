/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MONEY-BUG mirror test (S9 #1) — a FIRED "Dein Team" worker must stop spending.
 *
 * The bug: the shim's per-dispatch team-status resolver read
 * `commandEve.teamWorkerStatus` from the main-process ProcessConfig store — the
 * store the panel (configService → BACKEND `/api/settings/client`) NEVER writes
 * to. So the read ALWAYS returned undefined ⇒ every worker treated active ⇒ a
 * paused/fired worker kept being dispatched and kept SPENDING. The
 * pause/throttle/fire controls had no effect on the store the execution path read.
 *
 * This test exercises the WHOLE resolver path the shim runs per dispatch, through
 * the REAL production units:
 *   readCommandEveSettingsFromBackend  [seat-physical key, /api/settings/client]
 *     → createTeamWorkerStatusResolver  [fresh read + last-known-good]
 *     → evaluateWorkerDispatch          [the pure gate the shim applies]
 *
 * The backend HTTP layer is mocked exactly as the renderer persists the panel
 * value (seat-physical key in the /api/settings/client bag), so the assertions
 * ride the real store-resolution + fail-direction logic — not a re-implementation.
 *
 * It is RED against the pre-fix code: with the resolver reading ProcessConfig
 * (never holding the key), a fired worker's dispatch was `allowed: true`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import { readCommandEveSettingsFromBackend } from '@process/commandEve/commandEveBackendSettingsRead';
import { createTeamWorkerStatusResolver } from '@process/commandEve/teamWorkerStatusResolverCore';
import { evaluateWorkerDispatch } from '@/common/config/eveTeamControlsCore';
import { EVE_TEAM_ROSTER, findEveTeamRole } from '@/common/config/eveTeamRoster';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import {
  __resetActiveSeatForTests,
  setActiveSeatId,
} from '@process/commandEve/seatContextCore';

const STATUS_KEY = 'commandEve.teamWorkerStatus';

/** A real, pausable roster worker id (the gate only ever blocks a KNOWN roster id). */
const ROSTER_WORKER_ID = EVE_TEAM_ROSTER[0].agent_id;

/** Build the settings bag the way the renderer persists the status map for a seat. */
function settingsBagWithStatus(
  status: Record<string, 'active' | 'paused' | 'off'>,
  seatId: string | null
): Record<string, unknown> {
  return { [seatScopedKey(STATUS_KEY, seatId)]: status };
}

/** The full live resolver the shim runs per dispatch (real backend read + last-known-good). */
function buildResolver() {
  return createTeamWorkerStatusResolver(readCommandEveSettingsFromBackend);
}

/** Mirror the shim's dispatch gate: resolve the live map, then evaluate the gate. */
async function dispatchAllowed(
  resolver: () => Promise<Record<string, 'active' | 'paused' | 'off'> | undefined>,
  agentId: string
): Promise<boolean> {
  const statuses = (await resolver()) ?? {};
  return evaluateWorkerDispatch(agentId, statuses).allowed;
}

describe('team-worker-status money bug — fired worker stops spending (full resolver path)', () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    __resetActiveSeatForTests();
  });
  afterEach(() => {
    __resetActiveSeatForTests();
  });

  it('sanity: the chosen worker id is a real, gate-known roster role', () => {
    expect(findEveTeamRole(ROSTER_WORKER_ID)).toBeTruthy();
  });

  it('FIRE (off) → the NEXT dispatch of that worker is DENIED (the money fix)', async () => {
    const resolver = buildResolver();
    httpRequestMock.mockResolvedValue(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'off' }, null));

    const decision = evaluateWorkerDispatch(ROSTER_WORKER_ID, (await resolver()) ?? {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('blocked-off');
  });

  it('PAUSE (paused) → the next dispatch is DENIED as throttled', async () => {
    const resolver = buildResolver();
    httpRequestMock.mockResolvedValue(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'paused' }, null));

    const decision = evaluateWorkerDispatch(ROSTER_WORKER_ID, (await resolver()) ?? {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('blocked-paused');
  });

  it('an ACTIVE worker is dispatched (no false-positive block)', async () => {
    const resolver = buildResolver();
    httpRequestMock.mockResolvedValue(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'active' }, null));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(true);
  });

  it('FRESH read per dispatch: firing between two dispatches flips allow → deny immediately', async () => {
    const resolver = buildResolver();

    // Dispatch 1: worker still active → allowed.
    httpRequestMock.mockResolvedValueOnce(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'active' }, null));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(true);

    // Operator fires the worker (panel writes 'off' to the backend). No cache TTL:
    // the NEXT dispatch reads the fresh value and denies.
    httpRequestMock.mockResolvedValueOnce(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'off' }, null));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(false);
  });

  it('LAST-KNOWN-GOOD: a backend hiccup AFTER a fire keeps the fired worker blocked (money)', async () => {
    const resolver = buildResolver();

    // First successful read sees the worker fired → blocked + snapshot captured.
    httpRequestMock.mockResolvedValueOnce(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'off' }, null));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(false);

    // Backend then hiccups. Fail-direction = last-known-good ⇒ the fired worker
    // STAYS fired (must not resurrect and resume spending on a transient error).
    httpRequestMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(false);
  });

  it('LAST-KNOWN-GOOD availability: a hiccup does NOT brick an ACTIVE worker seen good', async () => {
    const resolver = buildResolver();
    httpRequestMock.mockResolvedValueOnce(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'active' }, null));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(true);

    // Transient error → last-known-good (active) holds ⇒ still allowed. A backend
    // hiccup must not block a worker the operator never paused.
    httpRequestMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(true);
  });

  it('NEVER read (backend down from the first dispatch) → undefined ⇒ fail-open (every worker active)', async () => {
    const resolver = buildResolver();
    httpRequestMock.mockRejectedValue(new Error('ECONNREFUSED'));

    // No successful read has ever happened → no last-known-good → resolver returns
    // undefined → the shim treats it as {} ⇒ every worker active. This preserves
    // availability: a permanently-unreachable backend must not block ALL work.
    const map = await resolver();
    expect(map).toBeUndefined();
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(true);
  });

  it('EMPTY store (never configured) → no gating, and cannot be resurrected by a later hiccup', async () => {
    const resolver = buildResolver();

    // Read succeeds but the key is absent (virgin config) → no status map.
    httpRequestMock.mockResolvedValueOnce({});
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(true);

    // A subsequent hiccup must NOT resurrect a stale roster: last-known-good was
    // seeded to the empty map, so the worker stays allowed (not falsely blocked).
    httpRequestMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(true);
  });

  it('SEAT-SCOPED: a fire persisted under a NON-legacy seat key is resolved + enforced', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    const resolver = buildResolver();
    httpRequestMock.mockResolvedValue(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'off' }, seatId));

    // The resolver MUST resolve the seat-physical key or it falls back to "no map"
    // and the fire silently does nothing for a real seat (the reseller SKU).
    expect(await dispatchAllowed(resolver, ROSTER_WORKER_ID)).toBe(false);
  });

  it('the un-delegated EVE itself is never blocked (system default, not a pausable worker)', async () => {
    const resolver = buildResolver();
    httpRequestMock.mockResolvedValue(settingsBagWithStatus({ [ROSTER_WORKER_ID]: 'off' }, null));
    // Even with a fired roster worker in the map, the system default `eve` is
    // always allowed — firing a worker must not take EVE herself offline.
    expect(await dispatchAllowed(resolver, 'eve')).toBe(true);
  });
});
