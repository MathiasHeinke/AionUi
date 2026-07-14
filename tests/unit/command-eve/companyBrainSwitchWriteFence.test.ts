/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * F4 (HIGH) — MID-SWITCH COMPANY-BRAIN WRITE-FENCE, tested through the REAL bridge
 * seam (mirrors kanbanSwitchWriteFence.test.ts, brain twin).
 *
 * The sacred invariant: while a seat switch is in flight, a Company-Brain WRITE /
 * REMOVE must be REFUSED (SEAT_SWITCH_IN_PROGRESS) so one seat's knowledge can never
 * land in another seat's company-brain/ during the window between
 * setActiveSeatId(target) and the completed backend re-spawn. LIST is a read and is
 * NOT fenced — but it must SKIP its reconcile (an index write) while in flight. This
 * drives the ACTUAL registered `command-eve.switch-seat` provider to TAKE the
 * in-flight lock (by stalling its first await), then asserts write/remove are fenced
 * and list does not reconcile — all over the SAME single in-flight boolean.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: () => undefined, getSync: () => undefined, set: () => {} },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));

// The store writes to disk — point the bridge at a real tmp userDataPath.
let dataRoot = '';
vi.mock('@process/utils/utils', () => ({ getDataPath: () => dataRoot }));

// Freeze the switch handler's FIRST await (readMySeatsWire) so the in-flight lock
// stays held while we drive brain mutations.
let releaseSwitchGate: (() => void) | null = null;
const switchGate = () =>
  new Promise<null>((resolve) => {
    releaseSwitchGate = () => resolve(null);
  });
const readMySeatsWireCoreMock = vi.fn(() => switchGate());
vi.mock('@process/commandEve/seatWireFetchCore', () => ({
  readMySeatsWire: (...args: unknown[]) => readMySeatsWireCoreMock(...args),
}));

// seatContextCore stays REAL — resolveActiveSeatHome / setActiveSeatId are the pure
// seam the brain handlers rely on for active-seat resolution.
import { __resetActiveSeatForTests, resolveSeatHome, setActiveSeatId } from '@process/commandEve/seatContextCore';
import { COMPANY_BRAIN_DIR } from '@process/commandEve/companyBrainSeedCore';
import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type Envelope = {
  success: boolean;
  msg?: string;
  data?: { reason_code?: string; ok?: boolean; entries?: Array<{ id: string }> };
};

const SEAT = 'aabbccdd-1122-4333-8444-556677889900';
const tempRoots: string[] = [];
const call = (channel: string, req?: unknown) => (registered.get(channel) as (r?: unknown) => Promise<Envelope>)(req);

beforeEach(() => {
  registered.clear();
  releaseSwitchGate = null;
  readMySeatsWireCoreMock.mockClear();
  __resetActiveSeatForTests();
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-brain-fence-'));
  tempRoots.push(dataRoot);
  setActiveSeatId(SEAT);
  initCommandEveBridge();
});
afterEach(() => {
  releaseSwitchGate?.();
  __resetActiveSeatForTests();
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('F4 mid-switch company-brain write-fence (real bridge providers)', () => {
  it('a brain WRITE while a switch is in flight is REFUSED with SEAT_SWITCH_IN_PROGRESS', async () => {
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    await Promise.resolve();
    await Promise.resolve();

    const res = await call('command-eve.company-brain-write', { kind: 'offer', title: 'X', body: 'y' });
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('SEAT_SWITCH_IN_PROGRESS');
    // Nothing was written into the active seat home while fenced.
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    expect(fs.existsSync(path.join(home, COMPANY_BRAIN_DIR, 'brain.json'))).toBe(false);

    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
  });

  it('a brain REMOVE while a switch is in flight is REFUSED with SEAT_SWITCH_IN_PROGRESS', async () => {
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    await Promise.resolve();
    await Promise.resolve();

    const res = await call('command-eve.company-brain-remove', { id: 'offer-anything' });
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('SEAT_SWITCH_IN_PROGRESS');

    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
  });

  it('LIST during a switch is NOT fenced but SKIPS reconcile (an unindexed .md is NOT adopted)', async () => {
    // Drop an EVE note into entries/ WITHOUT an index entry.
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    const entriesDir = path.join(home, COMPANY_BRAIN_DIR, 'entries');
    fs.mkdirSync(entriesDir, { recursive: true });
    fs.writeFileSync(path.join(entriesDir, 'note-during-switch.md'), '# During switch\nbody');

    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    await Promise.resolve();
    await Promise.resolve();

    const listed = await call('command-eve.company-brain-list');
    // Read succeeds (not fenced) …
    expect(listed.success).toBe(true);
    // … but the reconcile was SKIPPED, so the unindexed note was NOT folded in.
    expect(listed.data?.entries?.some((e) => e.id === 'note-during-switch')).toBe(false);

    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
  });

  it('after the switch settles, the fence LIFTS — a brain write reaches the store', async () => {
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    await Promise.resolve();
    await Promise.resolve();
    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
    await Promise.resolve();

    const res = await call('command-eve.company-brain-write', { kind: 'note', title: 'post-switch', body: 'ok' });
    expect(res.data?.reason_code).not.toBe('SEAT_SWITCH_IN_PROGRESS');
    expect(res.success).toBe(true);
    expect(res.data?.ok).toBe(true);
  });
});
