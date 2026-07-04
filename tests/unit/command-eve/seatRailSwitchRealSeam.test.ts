/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TEST-HONESTY MIRRORS (a) + (b) — drive the REAL registered bridge providers, not
 * fixture-vs-fixture twins. The 1.2.19 mirror-gap class is: the my-seats provider,
 * the switch-seat handler and the prompt assembly were only tested against hand-
 * built fixtures that duplicated the production logic. Here we run the ACTUAL
 * `initCommandEveBridge` providers over a controlled wire and assert through the
 * SAME resolveSeatAccess / isSeatSwitchAuthorized code the renderer + main use.
 *
 *  (a) command-eve.my-seats → (real parseMySeats) → resolveSeatAccess → rail VISIBLE
 *      (admin, >1 seat, Founder chip prepended) — and fail-closed for a delegate.
 *  (b) command-eve.switch-seat: the IPC admin GATE + Founder-chip target + label
 *      threading, enforced in MAIN (a delegate / unlisted target is rejected before
 *      any state mutates; an admin→client and admin→Founder-home succeed).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture real providers.
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

// Neutralize the heavy leaf deps the bridge pulls at import.
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: () => undefined, getSync: () => undefined, set: () => {} },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/ce-rail-data' }));

// Control ONLY the network wire read; the parse + access classification stay REAL.
let wirePayload: unknown = null;
vi.mock('@process/commandEve/seatWireFetchCore', () => ({
  readMySeatsWire: async () => wirePayload,
}));

// The seat-switch handler dynamically imports the runtime seams — stub them so the
// switch does not spawn a real backend; the GATE runs BEFORE these are reached.
// MUTABLE mock so a test can make the re-spawn FAIL (Hotfix-B rollback paths). By
// default it resolves (a clean re-spawn). Tests reset it in beforeEach.
const { restartBackendMock } = vi.hoisted(() => ({ restartBackendMock: vi.fn(async () => {}) }));
vi.mock('@process/commandEve/seatSwitchRuntime', () => ({
  restartCommandEveBackendForSeat: (...args: unknown[]) => restartBackendMock(...args),
}));

import fs from 'fs';
import path from 'path';
import { initCommandEveBridge } from '@process/bridge/commandEveBridge';
import { parseMySeats, resolveSeatAccess } from '@process/commandEve/seatSwitchCore';
import { setActiveSeatId, __resetActiveSeatForTests, resolveSeatHermesHome } from '@process/commandEve/seatContextCore';

const SEAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SEAT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LEGACY = 'seat-1';
const DATA_PATH = '/tmp/ce-rail-data';

// H4 precondition: the switch now FAILS-CLOSED unless the target seat home already
// holds a valid config.yaml + SOUL.md (never boot a seat on wheel defaults). These
// tests exercise the switch MECHANICS (admin gate, label threading, rollback), not
// the fresh-unprovisioned-seat case, so seed minimal valid runtime files for every
// seat they land on. The backend is mocked unreachable, so no real provisioning
// runs — this stands in for the last-known-good files a prior good pass would leave.
const seedSeatRuntimeFiles = (seatId: string): void => {
  const home = resolveSeatHermesHome(DATA_PATH, seatId);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), 'memory_enabled: true\n');
  fs.writeFileSync(path.join(home, 'SOUL.md'), '# EVE\nVoice + values.\n');
};

const adminWire = () => ({
  ok: true,
  account: { id: 'acc-1', role: 'admin' },
  seats: [
    { tenant_id: SEAT_A, name: 'Bäckerei Müller', role: 'admin', is_active: true },
    { tenant_id: SEAT_B, name: 'Kanzlei Schmidt', role: 'admin', is_active: false },
  ],
  active_seat_id: SEAT_A,
});

const delegateWire = () => ({
  ok: true,
  account: { id: 'acc-2', role: 'delegate' },
  seats: [{ tenant_id: SEAT_A, name: 'Bäckerei Müller', role: 'delegate', is_active: true }],
  active_seat_id: SEAT_A,
});

type MySeatsEnvelope = { success: boolean; data?: { contract?: unknown; source?: string } };
type SwitchEnvelope = { success: boolean; data?: { ok?: boolean; reason_code?: string; active_seat_id?: string; rolled_back?: boolean; backend_down?: boolean } };

beforeEach(() => {
  registered.clear();
  wirePayload = null;
  restartBackendMock.mockReset();
  restartBackendMock.mockImplementation(async () => {});
  __resetActiveSeatForTests();
  setActiveSeatId(SEAT_A);
  // Seed valid runtime files for every seat the (b) mirror switches to, so the H4
  // fail-closed gate sees last-known-good files and the switch mechanics run.
  seedSeatRuntimeFiles(SEAT_A);
  seedSeatRuntimeFiles(SEAT_B);
  seedSeatRuntimeFiles(LEGACY);
  initCommandEveBridge();
});
afterEach(() => {
  __resetActiveSeatForTests();
  vi.clearAllMocks();
  fs.rmSync(DATA_PATH, { recursive: true, force: true });
});

const mySeats = () => (registered.get('command-eve.my-seats') as () => Promise<MySeatsEnvelope>)();
const switchSeat = (seatId: string) =>
  (registered.get('command-eve.switch-seat') as (r?: { seatId?: string }) => Promise<SwitchEnvelope>)({ seatId });

describe('mirror (a) — REAL my-seats provider → resolveSeatAccess → rail visibility', () => {
  it('an admin with >1 seat: the contract resolves to canSwitch + a prepended Founder chip', async () => {
    wirePayload = adminWire();
    const res = await mySeats();
    expect(res.success).toBe(true);
    expect(res.data?.source).toBe('my_seats');

    // Feed the provider's OWN contract through the SAME resolver the rail uses.
    const access = resolveSeatAccess(res.data?.contract as ReturnType<typeof parseMySeats>);
    expect(access.role).toBe('admin');
    expect(access.canSwitch).toBe(true); // rail VISIBLE
    // The Founder home chip is prepended for admins (return-home path).
    expect(access.seats[0].seat_id).toBe(LEGACY);
    expect(access.seats[0].name).toBe('Founder');
    // Both client seats are present.
    expect(access.seats.map((s) => s.seat_id)).toContain(SEAT_A);
    expect(access.seats.map((s) => s.seat_id)).toContain(SEAT_B);
  });

  it('a delegate: fail-closed to a single pinned seat, rail HIDDEN (no Founder chip)', async () => {
    wirePayload = delegateWire();
    const res = await mySeats();
    const access = resolveSeatAccess(res.data?.contract as ReturnType<typeof parseMySeats>);
    expect(access.role).toBe('delegate');
    expect(access.canSwitch).toBe(false); // rail HIDDEN
    expect(access.seats.some((s) => s.seat_id === LEGACY)).toBe(false); // never a home chip
  });

  it('no wire (offline / no account) ⇒ legacy fallback ⇒ rail hidden', async () => {
    wirePayload = null;
    const res = await mySeats();
    expect(res.data?.source).toBe('legacy_fallback');
    const access = resolveSeatAccess(res.data?.contract as ReturnType<typeof parseMySeats>);
    expect(access.canSwitch).toBe(false);
  });
});

describe('mirror (b) — REAL switch-seat handler: admin gate + Founder chip + label threading', () => {
  it('a DELEGATE is rejected by the MAIN gate (no state mutation)', async () => {
    wirePayload = delegateWire();
    const res = await switchSeat(SEAT_B);
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('SWITCH_SEAT_FORBIDDEN');
    // Active seat unchanged.
    expect(res.data?.active_seat_id).toBe(SEAT_A);
  });

  it('an admin → an UNLISTED target is rejected (membership gate)', async () => {
    wirePayload = adminWire();
    const res = await switchSeat('cccccccc-cccc-cccc-cccc-cccccccccccc');
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('SWITCH_SEAT_FORBIDDEN');
  });

  it('an admin → a listed CLIENT seat is authorized and lands on the target (label threaded from the wire seat record)', async () => {
    wirePayload = adminWire();
    const res = await switchSeat(SEAT_B);
    expect(res.success).toBe(true);
    expect(res.data?.ok).toBe(true);
    expect(res.data?.active_seat_id).toBe(SEAT_B);
  });

  it('an admin → the Founder HOME (legacy chip) is authorized (return-home path)', async () => {
    wirePayload = adminWire();
    // Start in a client seat, then switch back home.
    setActiveSeatId(SEAT_B);
    const res = await switchSeat(LEGACY);
    expect(res.success).toBe(true);
    expect(res.data?.active_seat_id).toBe(LEGACY);
  });

  it('a missing target id is rejected before any mutation', async () => {
    wirePayload = adminWire();
    const res = await (registered.get('command-eve.switch-seat') as (r?: { seatId?: string }) => Promise<SwitchEnvelope>)({});
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('SWITCH_SEAT_NO_TARGET');
  });

  // Hotfix-B: the failed-switch honesty contract, through the REAL bridge handler.
  it('a switch whose re-spawn fails ONCE rolls back to the prior seat with the backend restarted (SEAT_SWITCH_RESPAWN_FAILED, not backend_down)', async () => {
    wirePayload = adminWire(); // active = SEAT_A
    // Forward re-spawn for SEAT_B throws; the rollback-restart for SEAT_A succeeds.
    restartBackendMock.mockRejectedValueOnce(new Error('aioncore failed to re-spawn'));
    const res = await switchSeat(SEAT_B);

    expect(res.success).toBe(false);
    expect(res.data?.ok).toBe(false);
    expect(res.data?.rolled_back).toBe(true);
    expect(res.data?.reason_code).toBe('SEAT_SWITCH_RESPAWN_FAILED');
    expect(res.data?.backend_down).toBeUndefined();
    // Rolled back to the prior seat A.
    expect(res.data?.active_seat_id).toBe(SEAT_A);
    // restartBackend ran twice: the failed forward attempt + the successful rollback.
    expect(restartBackendMock).toHaveBeenCalledTimes(2);
  });

  it('a switch whose re-spawn AND rollback-restart BOTH fail surfaces the DISTINCT fail-closed backend_down state (SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN — not a clean rollback)', async () => {
    wirePayload = adminWire(); // active = SEAT_A
    // Every spawn fails (e.g. corrupted venv) ⇒ the prior seat cannot be restored live.
    restartBackendMock.mockRejectedValue(new Error('corrupted venv — every spawn fails'));
    const res = await switchSeat(SEAT_B);

    expect(res.success).toBe(false);
    expect(res.data?.ok).toBe(false);
    expect(res.data?.rolled_back).toBe(true);
    expect(res.data?.backend_down).toBe(true);
    expect(res.data?.reason_code).toBe('SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN');
    // Pointer honestly on the prior seat, but the caller KNOWS the backend is down.
    expect(res.data?.active_seat_id).toBe(SEAT_A);
    // At most ONE rollback-restart (no infinite loop): forward + one rollback = 2.
    expect(restartBackendMock).toHaveBeenCalledTimes(2);
  });

  // H4 (Codex): a switch to a target with NO valid runtime files must FAIL-CLOSED —
  // the seat would otherwise boot on wheel defaults (memory off, no SOUL). The gate
  // throws in prepareEnv, so applySeatSwitch rolls back and the forward re-spawn for
  // the target NEVER runs (only the rollback-restart for the prior seat does).
  it('an authorized switch to a target with NO valid runtime files FAILS-CLOSED and rolls back (never boots on wheel defaults)', async () => {
    wirePayload = adminWire(); // active = SEAT_A
    // Strip SEAT_B's seeded files: a fresh, never-provisioned client seat.
    fs.rmSync(resolveSeatHermesHome(DATA_PATH, SEAT_B), { recursive: true, force: true });
    const res = await switchSeat(SEAT_B);

    expect(res.success).toBe(false);
    expect(res.data?.ok).toBe(false);
    expect(res.data?.rolled_back).toBe(true);
    // Pointer stayed on / returned to the prior seat — never landed on the degraded target.
    expect(res.data?.active_seat_id).toBe(SEAT_A);
    // The forward re-spawn for SEAT_B never ran; only the rollback-restart for SEAT_A did.
    expect(restartBackendMock).toHaveBeenCalledTimes(1);
  });
});
