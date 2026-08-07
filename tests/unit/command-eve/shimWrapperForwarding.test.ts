/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * G3 (CEVE-18205) — a wrapper must survive an upstream signature change BY DESIGN.
 *
 * The shim replaces Hermes methods at runtime. A replacement that WRAPS the original
 * inherits that original's calling convention: the moment upstream adds a parameter,
 * a wrapper with a fixed signature raises TypeError on a call it used to serve.
 *
 * Hermes 0.20 changed four wrapped signatures — `clear_interrupt` (+preserve_redirect),
 * `interrupt` (+hard_cancel), `run_conversation` (+3) and `_compress_context` (+2). The
 * wrappers absorbed it, but only because they happen to forward `*args, **kwargs`.
 * Nothing required them to, and nothing would have said so if they stopped.
 *
 * WHAT THIS TEST DOES NOT DO is claim the shim is uniformly safe. The readiness sweep
 * reported that "the wrappers forward *args/**kwargs" from a three-site sample; the
 * full enumeration below found four more wrappers that do NOT. They are safe against
 * 0.20 specifically — every method they wrap is signature-identical there — so this
 * test freezes them as a NAMED, JUSTIFIED allowlist rather than pretending the rule
 * already holds everywhere. New wrappers get the rule; the debt stays countable.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  provisionSeatRuntimeFiles,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import { __resetActiveSeatForTests, clearActiveSeat, setActiveSeatId } from '@/process/commandEve/seatContextCore';

const REAL_UUID = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';

/**
 * Wrappers that call an original WITHOUT forwarding blindly.
 *
 * Each is safe against Hermes 0.20 because the method it wraps is signature-identical
 * between 0.17 and 0.20 (verified against the extracted wheels). Each is also a real
 * coupling: the next upstream parameter breaks it. Removing an entry from this list is
 * the fix; adding one requires the same justification.
 */
const FIXED_ARITY_WRAPPERS: Record<string, string> = {
  // Wraps AIAgent._ensure_primary_openai_client — identical in 0.20.
  command_eve_ensure_primary_openai_client: 'AIAgent._ensure_primary_openai_client',
  // Wraps auxiliary_client._resolve_custom_runtime — identical in 0.20.
  command_eve_resolve_custom_runtime: 'auxiliary_client._resolve_custom_runtime',
  // Wraps SessionManager._restore — identical in 0.20.
  command_eve_restore: 'SessionManager._restore',
  // THE arity-counting site. Wraps AIAgent._should_treat_stop_as_truncated and
  // branches on the original's parameter count (3-arg vs 4-arg form) with a
  // documented fallback. Identical in 0.20. This is the one place in the shim that
  // reasons about a signature instead of ignoring it.
  command_eve_should_treat_stop_as_truncated: 'AIAgent._should_treat_stop_as_truncated',
};

type Replacement = {
  function: string;
  target: string;
  resolved: boolean;
  wraps_original?: boolean;
  declares_args?: boolean;
  declares_kwargs?: boolean;
  forwards_args?: boolean;
  forwards_kwargs?: boolean;
};

const tempRoots: string[] = [];

afterEach(() => {
  __resetActiveSeatForTests();
  clearActiveSeat();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function analyseShim(): { replacements: Replacement[]; arity_sites: Array<{ enclosing: string }> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-wrapper-test-'));
  tempRoots.push(root);
  setActiveSeatId(REAL_UUID);
  const seatHome = resolveCommandEveRuntimeBootstrapPaths(root).hermesHome;
  provisionSeatRuntimeFiles({ userDataPath: root, seatId: REAL_UUID });
  const providerPath = path.join(seatHome, 'plugins', 'model-providers', 'custom', '__init__.py');

  const harness = spawnSync(
    'python3',
    [path.resolve('tests/fixtures/command-eve/shim_wrapper_forwarding_harness.py'), providerPath],
    { encoding: 'utf8', timeout: 15_000 }
  );
  expect(harness.status, harness.stderr || harness.stdout).toBe(0);
  return JSON.parse(harness.stdout);
}

describe('G3 — shim wrappers survive an upstream signature change', () => {
  it('every monkeypatch replacement resolves to a real function', () => {
    const { replacements } = analyseShim();
    // Guards the guard: an empty or unresolved set would make every assertion
    // below pass vacuously.
    expect(replacements.length).toBeGreaterThanOrEqual(15);
    expect(replacements.filter((entry) => !entry.resolved)).toEqual([]);
  });

  it('every WRAPPER declares AND forwards *args/**kwargs, or is a justified exception', () => {
    const { replacements } = analyseShim();
    const wrappers = replacements.filter((entry) => entry.wraps_original);
    expect(wrappers.length).toBeGreaterThanOrEqual(10);

    const offenders = wrappers
      .filter(
        (entry) => !(entry.declares_args && entry.declares_kwargs && entry.forwards_args && entry.forwards_kwargs)
      )
      .filter((entry) => !(entry.function in FIXED_ARITY_WRAPPERS))
      .map((entry) => `${entry.function} -> ${entry.target}`);

    // A NEW wrapper that pins its signature lands here. Either it forwards, or it
    // joins the allowlist with a stated reason — both are decisions, which is the
    // whole point; today the choice was made silently and by accident.
    expect(offenders, 'wrapper(s) that would break on the next upstream parameter').toEqual([]);
  });

  it('the allowlist has no stale entries — a fixed wrapper must leave it', () => {
    const { replacements } = analyseShim();
    const byName = new Map(replacements.map((entry) => [entry.function, entry]));

    const stale: string[] = [];
    const vanished: string[] = [];
    for (const [name, target] of Object.entries(FIXED_ARITY_WRAPPERS)) {
      const entry = byName.get(name);
      if (!entry) {
        vanished.push(name);
        continue;
      }
      expect(entry.target, `${name} no longer patches ${target}`).toBe(target);
      if (entry.declares_args && entry.declares_kwargs && entry.forwards_args && entry.forwards_kwargs) {
        stale.push(name);
      }
    }
    // Without this, the allowlist rots into a permanent exemption that outlives the
    // reason for it — and the next reader would trust it.
    expect(stale, 'wrapper(s) now forwarding correctly; remove them from FIXED_ARITY_WRAPPERS').toEqual([]);
    expect(vanished, 'allowlisted wrapper(s) no longer exist; remove them').toEqual([]);
  });

  it('there is exactly ONE arity-counting site, and it is the documented one', () => {
    const { arity_sites } = analyseShim();
    // Reasoning about a wrapped callable's parameter count is the single hardest
    // coupling in the shim. One is a justified exception; two is a pattern.
    expect(arity_sites).toHaveLength(1);
    expect(arity_sites[0].enclosing).toBe('_install_command_eve_stop_continuation_patch');
    expect(FIXED_ARITY_WRAPPERS).toHaveProperty('command_eve_should_treat_stop_as_truncated');
  });
});
