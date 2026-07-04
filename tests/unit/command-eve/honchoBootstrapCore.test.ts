/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-Inc.3 / O1 — the provisioning orchestration brain. Pins the fail-safe
 * invariants independent of the exact injected commands: every miss is 'skip'
 * (never blocked/failed), a prerequisite failure stops the chain + ends not-ready,
 * readiness is always written + two-fact, and no throw escapes.
 */

import { describe, expect, it, vi } from 'vitest';
import { runHonchoBootstrap, type HonchoBootstrapDeps, type HonchoCommandSet } from '@/process/commandEve/honchoBootstrapCore';
import { buildHonchoProvisionPlan } from '@/process/commandEve/honchoProvisionPlanCore';
import { buildHonchoRuntimeConfig, HONCHO_DERIVER_BRANCH_CLOUD } from '@/process/commandEve/honchoRuntimeConfigCore';
import { honchoReady, HONCHO_STATE_OFF } from '@/process/commandEve/honchoReadinessCore';
import { resolveSeatHome } from '@/process/commandEve/seatContextCore';

const SEAT = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const NOW = Date.parse('2026-07-04T12:00:00.000Z');
const cfg = () => buildHonchoRuntimeConfig({ seatId: SEAT, seatHome: resolveSeatHome('/tmp/eve-honcho-o1', SEAT), hasLicense: true });

const ALL_PRESENT = { hasHomebrew: true, hasPostgres: true, hasPgvector: true, pythonSupported: true, hasHonchoPkg: true, dbProvisioned: true, freeDiskGb: 50 };
const OPTED = { memoryOptedIn: true, hasLicense: true };

/** A scriptable fake runner: fails for any command string in `fail`. */
function fakeRunner(fail: Set<string> = new Set(), threw: Set<string> = new Set()) {
  const seen: string[] = [];
  const runner = vi.fn(async (command: string, args: string[]) => {
    seen.push(command);
    if (threw.has(command)) throw new Error(`runner blew up for ${command}`);
    return { command, args, ok: !fail.has(command) };
  });
  return { runner, seen };
}

/** Commands for every step (distinct strings so the fake runner can key off them). */
const COMMANDS: HonchoCommandSet = {
  'honcho-homebrew': { command: 'ensure-brew' },
  'honcho-postgres': { command: 'install-postgres' },
  'honcho-pgvector': { command: 'install-pgvector' },
  'honcho-python': { command: 'ensure-python' },
  'honcho-package': { command: 'pip-honcho' },
  'honcho-db': { command: 'createdb-seat' },
  'honcho-process': { command: 'honcho-serve' },
};

function deps(over: Partial<HonchoBootstrapDeps> = {}): HonchoBootstrapDeps {
  const { runner } = fakeRunner();
  return {
    plan: buildHonchoProvisionPlan({ consent: OPTED, config: cfg(), detection: ALL_PRESENT, mode: 'auto' }),
    config: cfg(),
    commands: COMMANDS,
    runner,
    detachedSpawner: vi.fn(),
    probeServer: async () => true,
    probeDeriver: async () => true,
    writeReadiness: vi.fn(),
    now: () => NOW,
    ...over,
  };
}

/** Every stage status must be pass|skip — never blocked/failed. */
function assertNeverBlocked(stages: { status?: string }[]) {
  for (const s of stages) expect(['pass', 'skip']).toContain(s.status);
}

describe('runHonchoBootstrap — plan disabled', () => {
  it('a disabled plan writes an off readiness + one skip stage, no commands run', async () => {
    const runner = fakeRunner();
    const write = vi.fn();
    const r = await runHonchoBootstrap(deps({
      plan: buildHonchoProvisionPlan({ consent: { memoryOptedIn: false }, config: cfg() }),
      runner: runner.runner,
      writeReadiness: write,
    }));
    expect(r.honchoEnabled).toBe(false);
    expect(honchoReady(r.readiness)).toBe(false);
    expect(r.readiness.state).toBe(HONCHO_STATE_OFF);
    expect(runner.seen).toHaveLength(0);
    expect(write).toHaveBeenCalledOnce();
    assertNeverBlocked(r.stages);
  });
});

describe('runHonchoBootstrap — happy path', () => {
  it('all deps present + both probes pass ⇒ ready, only serve spawned, readiness written', async () => {
    const spawn = vi.fn();
    const write = vi.fn();
    const r = await runHonchoBootstrap(deps({ detachedSpawner: spawn, writeReadiness: write }));
    expect(r.honchoEnabled).toBe(true);
    expect(honchoReady(r.readiness)).toBe(true);
    expect(r.readiness.seatId).toBe(SEAT);
    expect(r.readiness.branch).toBe(HONCHO_DERIVER_BRANCH_CLOUD);
    expect(spawn).toHaveBeenCalledWith('honcho-serve', [], expect.anything());
    expect(write).toHaveBeenCalledOnce();
    assertNeverBlocked(r.stages);
    // the ready stage is a pass
    expect(r.stages.find((s) => s.id === 'honcho-ready')?.status).toBe('pass');
  });
});

describe('runHonchoBootstrap — a prerequisite failure stops the chain (never blocked)', () => {
  it('postgres install fails ⇒ that step + all later steps skip, ends not-ready', async () => {
    const { runner, seen } = fakeRunner(new Set(['install-postgres']));
    const plan = buildHonchoProvisionPlan({ consent: OPTED, config: cfg(), detection: { ...ALL_PRESENT, hasPostgres: false, dbProvisioned: false } });
    const spawn = vi.fn();
    const r = await runHonchoBootstrap(deps({ plan, runner, detachedSpawner: spawn }));
    expect(honchoReady(r.readiness)).toBe(false);
    // postgres skipped; the chain stopped so serve was never spawned + createdb never ran
    expect(r.stages.find((s) => s.id === 'honcho-postgres')?.status).toBe('skip');
    expect(spawn).not.toHaveBeenCalled();
    expect(seen).not.toContain('createdb-seat');
    assertNeverBlocked(r.stages);
  });

  it('a missing command for a step ⇒ skip + chain stop', async () => {
    const plan = buildHonchoProvisionPlan({ consent: OPTED, config: cfg(), detection: { ...ALL_PRESENT, hasPgvector: false } });
    const r = await runHonchoBootstrap(deps({ plan, commands: { ...COMMANDS, 'honcho-pgvector': undefined } }));
    expect(honchoReady(r.readiness)).toBe(false);
    expect(r.stages.find((s) => s.id === 'honcho-pgvector')?.status).toBe('skip');
    assertNeverBlocked(r.stages);
  });

  it('a runner that THROWS is caught ⇒ skip, no throw escapes', async () => {
    const { runner } = fakeRunner(new Set(), new Set(['install-postgres']));
    const plan = buildHonchoProvisionPlan({ consent: OPTED, config: cfg(), detection: { ...ALL_PRESENT, hasPostgres: false } });
    await expect(runHonchoBootstrap(deps({ plan, runner }))).resolves.toBeDefined();
    const r = await runHonchoBootstrap(deps({ plan, runner }));
    expect(honchoReady(r.readiness)).toBe(false);
    assertNeverBlocked(r.stages);
  });

  it('a serve spawn that throws ⇒ skip PROCESS_DOWN, not-ready, no throw escapes', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn failed');
    });
    const r = await runHonchoBootstrap(deps({ detachedSpawner: spawn }));
    expect(honchoReady(r.readiness)).toBe(false);
    expect(r.stages.find((s) => s.id === 'honcho-process')?.status).toBe('skip');
    assertNeverBlocked(r.stages);
  });
});

describe('runHonchoBootstrap — malformed input fail-safes (Codex O1 audit)', () => {
  it('#1 an ENABLED but empty-steps plan never reads ready even if both probes pass — and probes are NOT called', async () => {
    const probeServer = vi.fn(async () => true);
    const probeDeriver = vi.fn(async () => true);
    const r = await runHonchoBootstrap(deps({ plan: { honchoEnabled: true, steps: [] }, probeServer, probeDeriver }));
    expect(honchoReady(r.readiness)).toBe(false); // no server was started
    // The probe must be short-circuited when nothing was provisioned — never a
    // coincidental-loopback ready.
    expect(probeServer).not.toHaveBeenCalled();
    expect(probeDeriver).not.toHaveBeenCalled();
    assertNeverBlocked(r.stages);
  });

  it('#1 an enabled plan with NO process step never reads ready', async () => {
    const r = await runHonchoBootstrap(deps({
      plan: { honchoEnabled: true, steps: [{ id: 'honcho-postgres', alreadySatisfied: true }] },
      probeServer: async () => true,
      probeDeriver: async () => true,
    }));
    expect(honchoReady(r.readiness)).toBe(false);
  });

  it('#2 a config with no honchoHome ⇒ clean not-ready', async () => {
    const r = await runHonchoBootstrap(deps({ config: { seatId: SEAT, deriver: { branch: HONCHO_DERIVER_BRANCH_CLOUD } } }));
    expect(honchoReady(r.readiness)).toBe(false);
    assertNeverBlocked(r.stages);
  });

  it('#3 a THROWING injected now does not throw the bootstrap', async () => {
    const r = await runHonchoBootstrap(deps({
      now: () => {
        throw new Error('clock dead');
      },
    }));
    expect(r).toBeDefined();
    expect(honchoReady(r.readiness)).toBe(false);
    assertNeverBlocked(r.stages);
  });

  it('#3 a NaN now does not throw (reduce guards the clock)', async () => {
    const r = await runHonchoBootstrap(deps({ now: () => NaN }));
    expect(r).toBeDefined();
    assertNeverBlocked(r.stages);
  });

  it('#4 after a failure, later already-satisfied steps SKIP (not pass)', async () => {
    // homebrew missing (fails), then postgres present (already-satisfied) must still skip
    const { runner } = fakeRunner(new Set(['ensure-brew']));
    const plan = buildHonchoProvisionPlan({ consent: OPTED, config: cfg(), detection: { ...ALL_PRESENT, hasHomebrew: false } });
    const r = await runHonchoBootstrap(deps({ plan, runner }));
    const postgres = r.stages.find((s) => s.id === 'honcho-postgres');
    expect(postgres?.status).toBe('skip'); // NOT pass, even though it was already satisfied
    assertNeverBlocked(r.stages);
  });
});

describe('runHonchoBootstrap — readiness probe outcomes', () => {
  it('server up but deriver unreachable ⇒ degraded, not ready', async () => {
    const r = await runHonchoBootstrap(deps({ probeServer: async () => true, probeDeriver: async () => false }));
    expect(honchoReady(r.readiness)).toBe(false);
    expect(r.readiness.serverUp).toBe(true);
    expect(r.readiness.deriverReachable).toBe(false);
    assertNeverBlocked(r.stages);
  });
  it('a probe that THROWS is treated as not reachable (fail-safe)', async () => {
    const r = await runHonchoBootstrap(deps({
      probeServer: async () => {
        throw new Error('probe blew up');
      },
    }));
    expect(honchoReady(r.readiness)).toBe(false);
    assertNeverBlocked(r.stages);
  });
  it('a writeReadiness that throws does not throw the bootstrap', async () => {
    const r = await runHonchoBootstrap(deps({
      writeReadiness: () => {
        throw new Error('disk full');
      },
    }));
    expect(r).toBeDefined();
    expect(honchoReady(r.readiness)).toBe(true); // the run still succeeded; only the persist failed
  });
});
