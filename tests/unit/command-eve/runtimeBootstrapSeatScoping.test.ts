/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SEAT-SCOPING of the runtime bootstrap factory + shim/wrapper bake-leak fix
 * (Phase 4 / ISO-1 / SEAT-TOOL-1, STEP 2).
 *
 * This is the riskier rewire step: it threads the pure seatContextCore seam back
 * through `resolveCommandEveRuntimeBootstrapPaths` (the ONE factory that ~20
 * sinks call) and hardens the shim/wrapper HERMES_HOME bake.
 *
 * THE TWO HARD INVARIANTS under test:
 *   (a) LEGACY BYTE-IDENTITY — with no active seat, the factory's hermesHome and
 *       managedSkillsRoot equal the EXACT pre-change values
 *       (<root>/command-eve-runtime/hermes/home and .../home/<managed-skills-dir>).
 *   (b) NO ESCAPE — no crafted seat id (active OR explicit) can produce a home
 *       outside hermes/seats/ ; the factory surfaces the throw, it does NOT
 *       silently fall back to a shared home.
 *
 * Plus the bake-leak: the shim/wrapper must emit the `${HERMES_HOME:-<fallback>}`
 * form so a per-seat HERMES_HOME injected by the spawning process WINS, while the
 * baked fallback (legacy-equal for no-seat) keeps behavior unchanged.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  prepareCommandEveRuntimeProcessEnv,
  renderHermesHomeExport,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import {
  LEGACY_SEAT_ID,
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  clearActiveSeat,
  setActiveSeatId,
} from '@/process/commandEve/seatContextCore';

const USER_DATA = '/tmp/command-eve-runtime-seat-test-userdata';
const REAL_UUID_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const REAL_UUID_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

// The managed-skills dir name is private to runtimeBootstrapCore; we derive the
// EXACT pre-change values from the shipped 1.1.3 path SHAPE instead of importing
// the const, so the byte-identity assertion is independent of the source file.
const root = path.resolve(USER_DATA);
const hermesRoot = path.join(root, 'command-eve-runtime', 'hermes');
const LEGACY_HERMES_HOME = path.join(hermesRoot, 'home');

afterEach(() => {
  __resetActiveSeatForTests();
});

describe('(a) legacy byte-identity — no active seat', () => {
  it('hermesHome equals the exact shipped <hermesRoot>/home', () => {
    clearActiveSeat();
    const paths = resolveCommandEveRuntimeBootstrapPaths(USER_DATA);
    expect(paths.hermesHome).toBe(LEGACY_HERMES_HOME);
    expect(paths.hermesHome).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
  });

  it('managedSkillsRoot stays directly under the legacy home', () => {
    clearActiveSeat();
    const paths = resolveCommandEveRuntimeBootstrapPaths(USER_DATA);
    // managedSkillsRoot = <legacy home>/<managed-skills-dir>; derive the dir name
    // from the resolved value and assert it sits under the EXACT legacy home.
    expect(path.dirname(paths.managedSkillsRoot)).toBe(LEGACY_HERMES_HOME);
    expect(paths.managedSkillsRoot.startsWith(LEGACY_HERMES_HOME + path.sep)).toBe(true);
    expect(paths.managedSkillsRoot).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
  });

  it('the explicit LEGACY_SEAT_ID arg is identical to the no-arg default', () => {
    clearActiveSeat();
    const dflt = resolveCommandEveRuntimeBootstrapPaths(USER_DATA);
    const explicit = resolveCommandEveRuntimeBootstrapPaths(USER_DATA, LEGACY_SEAT_ID);
    expect(explicit.hermesHome).toBe(dflt.hermesHome);
    expect(explicit.managedSkillsRoot).toBe(dflt.managedSkillsRoot);
  });

  it('shared infra (venv/wrapper/shim/hermesRoot) is NOT seat-scoped', () => {
    setActiveSeatId(REAL_UUID_A);
    const seatPaths = resolveCommandEveRuntimeBootstrapPaths(USER_DATA);
    expect(seatPaths.hermesRoot).toBe(hermesRoot);
    expect(seatPaths.hermesVenv).toBe(path.join(hermesRoot, 'venv'));
    expect(seatPaths.hermesWrapper).toBe(path.join(hermesRoot, 'hermes-command-eve'));
    expect(seatPaths.hermesShim).toBe(path.join(hermesRoot, 'hermes'));
    // These must NOT have moved under seats/<id>/.
    expect(seatPaths.hermesVenv).not.toContain(SEATS_SUBDIR);
    expect(seatPaths.hermesShim).not.toContain(SEATS_SUBDIR);
  });
});

describe('(b) seat isolation through the factory', () => {
  it('an active real seat moves hermesHome + managedSkillsRoot under seats/<id>/', () => {
    setActiveSeatId(REAL_UUID_A);
    const paths = resolveCommandEveRuntimeBootstrapPaths(USER_DATA);
    const seatHome = path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_A, 'home');
    expect(paths.hermesHome).toBe(seatHome);
    expect(path.dirname(paths.managedSkillsRoot)).toBe(seatHome);
    expect(paths.hermesHome.startsWith(path.join(hermesRoot, SEATS_SUBDIR) + path.sep)).toBe(true);
  });

  it('two distinct seats yield DISJOINT homes; neither is a prefix of the other', () => {
    setActiveSeatId(REAL_UUID_A);
    const a = resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome;
    setActiveSeatId(REAL_UUID_B);
    const b = resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome;

    expect(a).not.toBe(b);
    expect(b.startsWith(a + path.sep)).toBe(false);
    expect(a.startsWith(b + path.sep)).toBe(false);
    // Neither equals the legacy home.
    expect(a).not.toBe(LEGACY_HERMES_HOME);
    expect(b).not.toBe(LEGACY_HERMES_HOME);
  });

  it('seat-A home is NOT a prefix of seat-B home (containment leak guard)', () => {
    const a = resolveCommandEveRuntimeBootstrapPaths(USER_DATA, REAL_UUID_A).hermesHome;
    const b = resolveCommandEveRuntimeBootstrapPaths(USER_DATA, REAL_UUID_B).hermesHome;
    expect(b.startsWith(a + path.sep)).toBe(false);
    expect(a.startsWith(b + path.sep)).toBe(false);
  });
});

describe('(c) explicit param beats the active-seat global', () => {
  it('an explicit seatId overrides the active seat default', () => {
    setActiveSeatId(REAL_UUID_A);
    const explicit = resolveCommandEveRuntimeBootstrapPaths(USER_DATA, REAL_UUID_B);
    expect(explicit.hermesHome).toBe(path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_B, 'home'));
    // Active seat is unchanged; the no-arg call still resolves to A.
    expect(resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome).toBe(
      path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_A, 'home')
    );
  });

  it('an explicit legacy id forces the legacy home even when a real seat is active', () => {
    setActiveSeatId(REAL_UUID_A);
    const legacy = resolveCommandEveRuntimeBootstrapPaths(USER_DATA, LEGACY_SEAT_ID);
    expect(legacy.hermesHome).toBe(LEGACY_HERMES_HOME);
  });
});

describe('(d) traversal — the factory surfaces the throw, never a shared fallback', () => {
  const MALICIOUS = ['../x', '../../etc/passwd', 'a/b', '/etc', 'C:\\Windows', '..', '.', '.hidden', ' seat'];

  it.each(MALICIOUS)('explicit unsafe id %j throws (no silent fallback)', (bad) => {
    expect(() => resolveCommandEveRuntimeBootstrapPaths(USER_DATA, bad)).toThrow();
  });

  it('an unsafe id never produces a path outside seats/ (it throws instead)', () => {
    // If the guard ever regressed to a silent fallback, the resolved home would
    // either escape seats/ or collide with the shared/legacy home. We assert the
    // throw so neither can happen.
    let resolved: string | null = null;
    try {
      resolved = resolveCommandEveRuntimeBootstrapPaths(USER_DATA, '../../escape').hermesHome;
    } catch {
      resolved = null;
    }
    expect(resolved).toBeNull();
  });
});

// Render + run the EXACT shim HERMES_HOME preamble produced by source
// (renderHermesHomeExport), under real bash, and echo the resolved value. This
// binds the test to the real writer, not a mirror — if the source form drifts,
// these tests render the drifted form and catch a regression.
const runShim = (home: string, env: NodeJS.ProcessEnv): string => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-shim-'));
  try {
    const script = path.join(tmp, 'shim.sh');
    fs.writeFileSync(
      script,
      ['#!/usr/bin/env bash', 'set -euo pipefail', ...renderHermesHomeExport(home), 'printf %s "$HERMES_HOME"', ''].join(
        '\n'
      ),
      { mode: 0o700 }
    );
    return execFileSync('bash', [script], { env, encoding: 'utf8' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

describe('(e) shim/wrapper HERMES_HOME bake-leak fix — under REAL bash', () => {
  it('no HERMES_HOME in env → resolves to the baked legacy fallback (byte-identical)', () => {
    clearActiveSeat();
    const home = resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome;
    expect(home).toBe(LEGACY_HERMES_HOME);
    expect(runShim(home, { PATH: process.env.PATH })).toBe(home);
  });

  it('an empty HERMES_HOME in env → still falls back to the bake', () => {
    // `[ -z "${HERMES_HOME:-}" ]` must treat empty-string as unset, matching the
    // old `${VAR:-WORD}` semantics.
    clearActiveSeat();
    const home = resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome;
    expect(runShim(home, { PATH: process.env.PATH, HERMES_HOME: '' })).toBe(home);
  });

  it('a pre-set HERMES_HOME WINS — the baked fallback does NOT clobber it (the leak fix)', () => {
    const home = resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome;
    const injected = path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_B, 'home');
    expect(runShim(home, { PATH: process.env.PATH, HERMES_HOME: injected })).toBe(injected);
    expect(injected).not.toBe(home);
  });

  it('a home with the FULL shell-special set round-trips faithfully (LOW escaper regression)', () => {
    // The LOW finding: the old `${HERMES_HOME:-WORD}` double-quoted form escaped
    // only \ " ` $ but NOT a single-quote, { or }. The new single-quoted form
    // must survive ALL of: ' { } $ ` " \\ with no crash (unexpected EOF) and no
    // corruption. Run via the REAL source helper.
    const trickyHome = "/tmp/eve $weird/`backtick`/\"quote\"/back\\slash/{brace}/it's/home";
    expect(runShim(trickyHome, { PATH: process.env.PATH })).toBe(trickyHome);
  });

  it('the wrapper preamble is byte-identical to the shim preamble (single source)', () => {
    // Both call sites render via renderHermesHomeExport, so a fix to one is a fix
    // to both. Assert the exact rendered lines for a representative seat home.
    const home = path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_A, 'home');
    expect(renderHermesHomeExport(home)).toEqual([
      `if [ -z "\${HERMES_HOME:-}" ]; then HERMES_HOME='${home}'; fi`,
      'export HERMES_HOME',
    ]);
  });
});

describe('(f) prepareCommandEveRuntimeProcessEnv pins HERMES_HOME onto the spawn env', () => {
  it('no active seat → env.HERMES_HOME is the legacy home (byte-identical)', () => {
    clearActiveSeat();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(USER_DATA, env);
    expect(env.HERMES_HOME).toBe(LEGACY_HERMES_HOME);
    expect(env.HERMES_HOME).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
  });

  it('active real seat → env.HERMES_HOME is seats/<id>/home', () => {
    setActiveSeatId(REAL_UUID_A);
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(USER_DATA, env);
    expect(env.HERMES_HOME).toBe(path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_A, 'home'));
  });

  it('also prepends the shared hermesRoot to PATH (existing contract preserved)', () => {
    clearActiveSeat();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(USER_DATA, env);
    expect((env.PATH || '').split(path.delimiter)[0]).toBe(hermesRoot);
  });
});

describe('(g) CONCURRENCY — a seat switch does NOT retroactively re-home a captured env', () => {
  it('envA stays pinned to seat-A home after switching the active seat to B', () => {
    // Model two still-running agents: prepare env A under seat A, then switch the
    // active seat to B and prepare env B. The previously-captured envA must keep
    // seat-A home (env-inheritance pinning), and the two envs must be DISJOINT.
    setActiveSeatId(REAL_UUID_A);
    const envA: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(USER_DATA, envA);
    const capturedA = envA.HERMES_HOME;

    setActiveSeatId(REAL_UUID_B);
    const envB: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(USER_DATA, envB);

    const seatAHome = path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_A, 'home');
    const seatBHome = path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_B, 'home');

    expect(capturedA).toBe(seatAHome);
    expect(envA.HERMES_HOME).toBe(seatAHome); // unchanged by the later switch
    expect(envB.HERMES_HOME).toBe(seatBHome);
    expect(envA.HERMES_HOME).not.toBe(envB.HERMES_HOME);
  });

  it('a still-running shim spawned from envA resolves seat-A even after a shared-shim re-bake for B', () => {
    // The end-to-end leak proof: agent A inherited HERMES_HOME=seat-A. Later a
    // seat switch overwrites the ONE shared shim to bake seat-B. A child A still
    // spawns via that shared shim — but because A's env already carries
    // HERMES_HOME, the bake is inert for it.
    const seatAHome = path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_A, 'home');
    const seatBHome = path.join(hermesRoot, SEATS_SUBDIR, REAL_UUID_B, 'home');
    // shim now bakes B (post-switch), child runs with A still in its env:
    const resolved = runShim(seatBHome, { PATH: process.env.PATH, HERMES_HOME: seatAHome });
    expect(resolved).toBe(seatAHome);
    expect(resolved).not.toBe(seatBHome);
  });
});
