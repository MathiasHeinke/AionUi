/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-624 Inc.3 — the provisioning ADAPTER wiring (H-INT-7/8). Drives
 * runHonchoProvisioningForSeat with FAKE runner/spawner/probes/detection so the
 * WIRING + fail-safety are proven without a real Homebrew/Postgres/honcho (the real
 * command STRINGS are MAC-VERIFY-PENDING and out of scope here):
 *   - a disabled plan (no consent / low disk / low RAM) NEVER reaches the runner and
 *     writes a not-ready readiness snapshot,
 *   - a fully-satisfied+opted-in seat spawns the server, probes, and writes ready,
 *   - a mid-chain runner failure stops the chain and stays not-ready (never throws).
 */

import { describe, expect, it, vi } from 'vitest';
import { runHonchoProvisioningForSeat } from '@/process/commandEve/honchoProvisioningRun';
import { honchoReady } from '@/process/commandEve/honchoReadinessCore';
import type { HonchoDepDetection } from '@/process/commandEve/honchoProvisionPlanCore';

const SEAT = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';

const allSatisfied: HonchoDepDetection = {
  hasHomebrew: true,
  hasPostgres: true,
  hasPgvector: true,
  hasUv: true,
  pythonSupported: true,
  hasHonchoPkg: true,
  dbProvisioned: true,
  freeDiskGb: 80,
  totalMemoryGb: 16,
};

function fakes(
  over: { runnerOk?: boolean; serverOk?: boolean; deriverOk?: boolean; detection?: HonchoDepDetection } = {}
) {
  const runnerCalls: string[] = [];
  const spawnCalls: string[] = [];
  let written: unknown;
  const deps = {
    detectDeps: () => over.detection || allSatisfied,
    runner: vi.fn(async (command: string) => {
      runnerCalls.push(command);
      return { ok: over.runnerOk !== false, code: 0, stdout: '', stderr: '' };
    }),
    detachedSpawner: vi.fn((command: string) => {
      spawnCalls.push(command);
      return { pid: 1234 } as unknown as ReturnType<typeof Object>;
    }),
    probeServer: async () => over.serverOk !== false,
    probeDeriver: async () => over.deriverOk !== false,
    writeReadiness: (_home: string, state: unknown) => {
      written = state;
    },
    now: () => 1_700_000_000_000,
  };
  return { deps, runnerCalls, spawnCalls, getWritten: () => written };
}

const input = (consent: Record<string, unknown>, mode?: 'auto' | 'check' | 'off') => ({
  userDataPath: '/tmp/honcho-prov-test',
  seatId: SEAT,
  hermesVenv: '/tmp/honcho-prov-test/venv',
  consent,
  mode,
});

describe('runHonchoProvisioningForSeat — fail-safe wiring', () => {
  it('H-INT-8 — consent NOT opted in ⇒ NO runner/spawn, readiness written not-ready', async () => {
    const f = fakes();
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: false }), f.deps as never);
    expect(f.runnerCalls).toEqual([]);
    expect(f.spawnCalls).toEqual([]);
    expect(res.honchoEnabled).toBe(false);
    expect(honchoReady(res.readiness)).toBe(false);
    expect(f.getWritten()).toBeTruthy(); // always writes SOME readiness
  });

  it('H-INT-8 — below the disk floor ⇒ blocked, runner never called', async () => {
    const f = fakes({ detection: { ...allSatisfied, freeDiskGb: 1 } });
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: true, hasLicense: true }), f.deps as never);
    expect(f.runnerCalls).toEqual([]);
    expect(res.honchoEnabled).toBe(false);
    expect(honchoReady(res.readiness)).toBe(false);
  });

  it('H-INT-8 — below the RAM floor ⇒ blocked, runner never called', async () => {
    const f = fakes({ detection: { ...allSatisfied, totalMemoryGb: 4 } });
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: true, hasLicense: true }), f.deps as never);
    expect(f.runnerCalls).toEqual([]);
    expect(res.honchoEnabled).toBe(false);
  });

  it('cloud branch with NO license ⇒ disabled (deriver could not authenticate)', async () => {
    const f = fakes();
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: true, hasLicense: false }), f.deps as never);
    expect(f.runnerCalls).toEqual([]);
    expect(res.honchoEnabled).toBe(false);
  });

  it('H-INT-7 — opted-in + satisfied + probes ok ⇒ server spawned, readiness READY', async () => {
    const f = fakes();
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: true, hasLicense: true }), f.deps as never);
    expect(res.honchoEnabled).toBe(true);
    expect(f.spawnCalls.length).toBe(1); // the honcho serve process
    expect(honchoReady(res.readiness)).toBe(true);
  });

  it('server probe fails ⇒ NOT ready (degraded), but never throws', async () => {
    const f = fakes({ serverOk: false });
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: true, hasLicense: true }), f.deps as never);
    expect(honchoReady(res.readiness)).toBe(false);
  });

  it('a mid-chain runner failure stops the chain ⇒ not-ready, server never spawned', async () => {
    // A fresh (not-yet-satisfied) install that the runner fails.
    const f = fakes({ runnerOk: false, detection: { ...allSatisfied, hasPostgres: false, dbProvisioned: false } });
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: true, hasLicense: true }), f.deps as never);
    expect(honchoReady(res.readiness)).toBe(false);
    expect(f.spawnCalls).toEqual([]); // the chain stopped before the serve step
  });

  it('a THROWING detectDeps does NOT escape (fully fail-soft) ⇒ not-ready off result', async () => {
    const f = fakes();
    f.deps.detectDeps = () => {
      throw new Error('detection blew up');
    };
    const res = await runHonchoProvisioningForSeat(input({ memoryOptedIn: true, hasLicense: true }), f.deps as never);
    expect(res.honchoEnabled).toBe(false);
    expect(honchoReady(res.readiness)).toBe(false);
    expect(f.runnerCalls).toEqual([]);
  });

  it('an unsafe seat id does NOT throw (buildHonchoRuntimeConfig would) ⇒ not-ready', async () => {
    const f = fakes();
    const res = await runHonchoProvisioningForSeat(
      {
        userDataPath: '/tmp/x',
        seatId: '../../escape',
        hermesVenv: '/tmp/x/venv',
        consent: { memoryOptedIn: true, hasLicense: true },
      },
      f.deps as never
    );
    expect(res.honchoEnabled).toBe(false);
    expect(honchoReady(res.readiness)).toBe(false);
  });
});
