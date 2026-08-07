/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-1821 — the curator tick, and the two ways it could have been built wrong.
 *
 * THE GAP: `runtimeBootstrapCore` emits `curator: enabled: true`, and its own
 * comment admitted the capability never fires on the desktop ACP lane. Measured
 * against the bundled 0.20.0 wheel that is exactly right — `maybe_run_curator`
 * has two callers, `cli.py:15052` and `gateway/run.py:25952`, and `acp_adapter/`
 * contains the word "curator" zero times.
 *
 * WRONG WAY ONE would have been to call `maybe_run_curator`. `should_run_now`
 * (`curator.py:233-282`) seeds `last_run_at` on first observation and returns
 * False, so the first real pass lands one full `DEFAULT_INTERVAL_HOURS = 24 * 7`
 * later (`curator.py:70`) — silent for seven days, and silent in a way nobody
 * would have investigated. `hermes curator run` bypasses that gate entirely
 * (`hermes_cli/curator.py:213-245`; `should_run_now` does not appear in it).
 *
 * WRONG WAY TWO would have been `--consolidate`. Without it the run reads
 * `curator.consolidate` from config, which is OFF (`curator.py:204-212`), so only
 * the deterministic prune runs and the forked aux-model review is skipped — no
 * model call, no credits. That flag is the single edit that would turn this into
 * a cost item, so its absence is asserted rather than assumed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CURATOR_TICK_ARGS,
  CURATOR_TICK_INTERVAL_MS,
  curatorTickBinary,
  runCuratorTick,
  shouldRunCuratorTick,
  __resetCuratorTickForTests,
} from '@/process/commandEve/curatorTickCore';

const PATHS = {
  hermesVenv: '/data/command-eve-runtime/hermes/venv',
  hermesHome: '/data/command-eve-runtime/hermes/seats/seat-42/home',
  platform: 'darwin' as NodeJS.Platform,
};

describe('the argv is the whole cost decision', () => {
  it('runs `curator run`, NOT the gated maybe_run_curator path', () => {
    expect([...CURATOR_TICK_ARGS]).toEqual(['curator', 'run', '--background']);
  });

  it('NEVER passes --consolidate — that is the one flag that would cost money', () => {
    expect(CURATOR_TICK_ARGS).not.toContain('--consolidate');
  });

  it('resolves the bundled console binary per platform', () => {
    expect(curatorTickBinary(PATHS)).toBe('/data/command-eve-runtime/hermes/venv/bin/hermes');
    expect(curatorTickBinary({ ...PATHS, platform: 'win32' })).toBe(
      '/data/command-eve-runtime/hermes/venv/Scripts/hermes.exe'
    );
  });
});

describe('the decision: ticks / does not tick', () => {
  it('ticks the first time once Hermes is actually installed', () => {
    expect(shouldRunCuratorTick({ nowMs: 1_000, binaryPresent: true })).toBe(true);
  });

  it('does NOT tick without the binary — an uninstalled Hermes is not an error', () => {
    expect(shouldRunCuratorTick({ nowMs: 1_000, binaryPresent: false })).toBe(false);
    // …and not even once the interval has passed.
    expect(shouldRunCuratorTick({ nowMs: 10 * CURATOR_TICK_INTERVAL_MS, lastTickAtMs: 0, binaryPresent: false })).toBe(
      false
    );
  });

  it('does not tick again inside the interval, and does once it has passed', () => {
    const base = 1_700_000_000_000;
    expect(
      shouldRunCuratorTick({ nowMs: base + CURATOR_TICK_INTERVAL_MS - 1, lastTickAtMs: base, binaryPresent: true })
    ).toBe(false);
    expect(
      shouldRunCuratorTick({ nowMs: base + CURATOR_TICK_INTERVAL_MS, lastTickAtMs: base, binaryPresent: true })
    ).toBe(true);
  });

  it('a clock that jumped BACKWARDS does not become a burst of spawns', () => {
    const base = 1_700_000_000_000;
    expect(shouldRunCuratorTick({ nowMs: base - 60_000, lastTickAtMs: base, binaryPresent: true })).toBe(false);
    expect(shouldRunCuratorTick({ nowMs: Number.NaN, lastTickAtMs: base, binaryPresent: true })).toBe(false);
  });
});

describe('the spawn: seat-correct, best-effort, never twice in a row', () => {
  it('spawns the binary with the ACTIVE seat HERMES_HOME and nothing else', () => {
    __resetCuratorTickForTests();
    const spawnDetached = vi.fn();
    const ran = runCuratorTick(PATHS, { spawnDetached, binaryExists: () => true, now: () => 1_000 });

    expect(ran).toBe(true);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnDetached.mock.calls[0];
    expect(command).toBe('/data/command-eve-runtime/hermes/venv/bin/hermes');
    expect([...(args as string[])]).toEqual(['curator', 'run', '--background']);
    // The seat home is TAKEN from the caller's already seat-aware path set, never
    // assembled here — a second place that composes seat homes is a second place
    // that can point at the wrong seat.
    expect(options).toEqual({ env: { HERMES_HOME: PATHS.hermesHome } });
  });

  it('declines the second call inside the interval', () => {
    __resetCuratorTickForTests();
    const spawnDetached = vi.fn();
    const deps = { spawnDetached, binaryExists: () => true, now: () => 5_000 };
    expect(runCuratorTick(PATHS, deps)).toBe(true);
    expect(runCuratorTick(PATHS, deps)).toBe(false);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('a missing binary declines quietly — no spawn, no throw', () => {
    __resetCuratorTickForTests();
    const spawnDetached = vi.fn();
    expect(runCuratorTick(PATHS, { spawnDetached, binaryExists: () => false })).toBe(false);
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('a throwing spawn is a debug line, never a boot failure', () => {
    __resetCuratorTickForTests();
    const log = vi.fn();
    const ran = runCuratorTick(PATHS, {
      spawnDetached: () => {
        throw new Error('ENOENT');
      },
      binaryExists: () => true,
      log,
    });
    expect(ran).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a throwing existence check is treated as absent, not as present', () => {
    __resetCuratorTickForTests();
    const spawnDetached = vi.fn();
    const ran = runCuratorTick(PATHS, {
      spawnDetached,
      binaryExists: () => {
        throw new Error('EACCES');
      },
    });
    expect(ran).toBe(false);
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('no safety gate was hung in front of it, deliberately', () => {
  it('the tick does not consult curatorSafetyCore', async () => {
    // `resolveCuratorRuntimeState` returns `disabled` without a staged review and
    // a visible budget, so putting it in front would have made the tick inert on
    // day one — a gate around a lock instead of opening it. It stays available for
    // the day the LLM consolidation is switched on, which is not today.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.join(__dirname, '../../../packages/desktop/src/process/commandEve/curatorTickCore.ts'),
      'utf8'
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[\t ]*\/\/.*$/gm, '');
    expect(code).not.toContain('curatorSafetyCore');
    expect(code).not.toContain('resolveCuratorRuntimeState');
  });
});
