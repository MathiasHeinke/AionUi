/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * H1 (isolation-critical) — MID-SWITCH KANBAN WRITE-FENCE, tested through the REAL
 * bridge seam (not a fixture-vs-fixture mirror).
 *
 * The sacred invariant: while a seat switch is in flight, a kanban WRITE must be
 * REFUSED (SEAT_SWITCH_IN_PROGRESS) so seat-A content can never land in seat-B's
 * kanban.db during the window between setActiveSeatId(target) and the completed
 * backend re-spawn. This test drives the ACTUAL registered `command-eve.switch-
 * seat` provider to TAKE the in-flight lock (by stalling its first await), then —
 * while the lock is held — drives the ACTUAL registered `command-eve.kanban-
 * marketing-card-create` / `-card-move` / `-card-action` providers and asserts
 * they are fenced. The same single module-level in-flight boolean gates both, so
 * this exercises the real serialization boundary the fix relies on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Capture the real providers registered by initCommandEveBridge ──────────────
const registered = new Map<string, (req?: unknown) => Promise<unknown>>();
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (fn: (req?: unknown) => Promise<unknown>) => {
        registered.set(channel, fn);
        return { channel };
      },
    }),
  },
}));

// ── Neutralize the heavy leaf deps the bridge pulls at import (electron/IO). ────
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: () => undefined, getSync: () => undefined, set: () => {} },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/ce-h1-data' }));

// Control the switch handler's FIRST await (readMySeatsWire) so we can freeze the
// switch mid-flight with the in-flight lock held, then run a kanban write.
let releaseSwitchGate: (() => void) | null = null;
const switchGate = () =>
  new Promise<null>((resolve) => {
    releaseSwitchGate = () => resolve(null);
  });
const readMySeatsWireCoreMock = vi.fn(() => switchGate());
vi.mock('@process/commandEve/seatWireFetchCore', () => ({
  readMySeatsWire: (...args: unknown[]) => readMySeatsWireCoreMock(...args),
}));

// The kanban mutation CORE must NOT actually run in this test — if the guard works
// the mutation core is never reached while fenced. Make it a spy that throws if
// ever called during the fence, so a guard regression is loud.
const kanbanCoreSpies = {
  createKanbanMarketingCard: vi.fn(() => ({ ok: true, status: 'ready' })),
  moveKanbanMarketingCard: vi.fn(() => ({ ok: true, status: 'ready' })),
  applyKanbanMarketingCardAction: vi.fn(() => ({ ok: true, status: 'ready' })),
  createKanbanMarketingProofCard: vi.fn(() => ({ ok: true, status: 'ready' })),
};
vi.mock('@process/commandEve/kanbanPreflightCore', () => ({
  createKanbanMarketingCard: (...a: unknown[]) => kanbanCoreSpies.createKanbanMarketingCard(...a),
  moveKanbanMarketingCard: (...a: unknown[]) => kanbanCoreSpies.moveKanbanMarketingCard(...a),
  applyKanbanMarketingCardAction: (...a: unknown[]) => kanbanCoreSpies.applyKanbanMarketingCardAction(...a),
  createKanbanMarketingProofCard: (...a: unknown[]) => kanbanCoreSpies.createKanbanMarketingProofCard(...a),
  // The remaining named exports the bridge imports — inert stubs (never called here).
  approveKanbanMarketingOutput: vi.fn(),
  buildKanbanMarketingBoard: vi.fn(),
  checkKanbanMarketingWorkerStartGate: vi.fn(),
  generateKanbanMarketingDraft: vi.fn(),
  planKanbanMarketingCardDispatch: vi.fn(),
  prepareKanbanMarketingWorkerDispatcher: vi.fn(),
  promoteKanbanMarketingWorkerExecutor: vi.fn(),
  recordKanbanMarketingDispatchApproval: vi.fn(),
  recordKanbanMarketingDispatchDecision: vi.fn(),
  requestKanbanMarketingWorkerDispatch: vi.fn(),
  runKanbanMarketingWorkerObserved: vi.fn(),
  runKanbanPreflight: vi.fn(),
}));

// seatSwitchCore helpers the switch handler uses BEFORE the gate: parseMySeats +
// resolveSeatAccess are only reached AFTER our gated readMySeatsWire resolves, so
// the real ones are fine; we just need the switch to PAUSE at the gate. Keep real.

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type Envelope = { success: boolean; msg?: string; data?: { reason_code?: string; ok?: boolean; status?: string } };

beforeEach(() => {
  registered.clear();
  releaseSwitchGate = null;
  readMySeatsWireCoreMock.mockClear();
  Object.values(kanbanCoreSpies).forEach((s) => s.mockClear());
  initCommandEveBridge();
});
afterEach(() => {
  // Release any dangling gate so a failed test never leaks a pending switch.
  releaseSwitchGate?.();
  vi.clearAllMocks();
});

const call = (channel: string, req?: unknown) => (registered.get(channel) as (r?: unknown) => Promise<Envelope>)(req);

describe('H1 mid-switch kanban write-fence (real bridge providers)', () => {
  it('registers the switch + kanban mutation providers', () => {
    expect(registered.has('command-eve.switch-seat')).toBe(true);
    expect(registered.has('command-eve.kanban-marketing-card-create')).toBe(true);
    expect(registered.has('command-eve.kanban-marketing-card-move')).toBe(true);
    expect(registered.has('command-eve.kanban-marketing-card-action')).toBe(true);
  });

  it('a kanban CREATE while a switch is in flight is REFUSED with SEAT_SWITCH_IN_PROGRESS', async () => {
    // Kick off a switch; it will pause at the gated readMySeatsWire with the lock held.
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    // Yield so the handler runs up to (and awaits) the gate.
    await Promise.resolve();
    await Promise.resolve();

    // While the switch is mid-flight, a card-create must be fenced.
    const res = await call('command-eve.kanban-marketing-card-create', {
      title: 'A-board card',
      lane_key: 'research',
      client_token: 'tok',
    });
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('SEAT_SWITCH_IN_PROGRESS');
    expect(res.data?.status).toBe('blocked');
    // The mutation CORE was never reached — no write could have landed in seat-B.
    expect(kanbanCoreSpies.createKanbanMarketingCard).not.toHaveBeenCalled();

    // Release the switch; let it settle so no pending promise leaks.
    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
  });

  it('kanban MOVE, ACTION and PROOF-CARD are all fenced during a switch', async () => {
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    await Promise.resolve();
    await Promise.resolve();

    const move = await call('command-eve.kanban-marketing-card-move', { task_id: 't1', to_lane_key: 'draft' });
    const action = await call('command-eve.kanban-marketing-card-action', { task_id: 't1', action: 'complete' });
    const proof = await call('command-eve.kanban-marketing-proof-card', {});

    for (const r of [move, action, proof]) {
      expect(r.success).toBe(false);
      expect(r.data?.reason_code).toBe('SEAT_SWITCH_IN_PROGRESS');
    }
    expect(kanbanCoreSpies.moveKanbanMarketingCard).not.toHaveBeenCalled();
    expect(kanbanCoreSpies.applyKanbanMarketingCardAction).not.toHaveBeenCalled();
    expect(kanbanCoreSpies.createKanbanMarketingProofCard).not.toHaveBeenCalled();

    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
  });

  it('after the switch settles, the fence LIFTS — a kanban create reaches the core', async () => {
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    await Promise.resolve();
    await Promise.resolve();
    // Release + settle the switch (it will reject at the admin gate since our gated
    // wire resolves to null ⇒ delegate ⇒ not authorized, but the lock releases in
    // the handler's finally either way).
    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
    await Promise.resolve();

    const res = await call('command-eve.kanban-marketing-card-create', {
      title: 'post-switch card',
      lane_key: 'research',
      client_token: 'tok',
    });
    // No longer fenced: the core ran (returned ok in our spy).
    expect(res.data?.reason_code).not.toBe('SEAT_SWITCH_IN_PROGRESS');
    expect(kanbanCoreSpies.createKanbanMarketingCard).toHaveBeenCalledTimes(1);
  });
});
