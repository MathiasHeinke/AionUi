/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * G4 (CEVE-18205) — a reasoning level the user picked must REACH the endpoint.
 *
 * Command EVE registers its own `custom` provider profile under the SAME name and
 * aliases as the wheel-bundled one, and `register_provider` is last-writer-wins.
 * There is no fallback: whatever our profile does not forward is lost.
 *
 * Hermes 0.20 rewrote the bundled `custom` provider to forward an explicit level as
 * a TOP-LEVEL `reasoning_effort` — the format GLM-5.2 on Volcengine ARK and other
 * OpenAI-compatible reasoning APIs expect. Our override implemented only the "off"
 * case, so selecting `high` produced the same request as selecting nothing: no
 * error, no log, just an ignored setting.
 *
 * The assertions run the EMITTED profile through a real Python harness. A source
 * grep for `elif effort` would pass for a branch writing the wrong key, the wrong
 * value, or one guarded by a condition that never holds.
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

const tempRoots: string[] = [];

afterEach(() => {
  __resetActiveSeatForTests();
  clearActiveSeat();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

type Extras = { extra_body: Record<string, unknown>; top_level: Record<string, unknown> };

function runHarness(): Record<string, Extras> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-reasoning-test-'));
  tempRoots.push(root);
  setActiveSeatId(REAL_UUID);
  const seatHome = resolveCommandEveRuntimeBootstrapPaths(root).hermesHome;
  provisionSeatRuntimeFiles({ userDataPath: root, seatId: REAL_UUID });
  const providerPath = path.join(seatHome, 'plugins', 'model-providers', 'custom', '__init__.py');

  const harness = spawnSync(
    'python3',
    [path.resolve('tests/fixtures/command-eve/custom_profile_reasoning_harness.py'), providerPath],
    { encoding: 'utf8', timeout: 15_000 }
  );
  expect(harness.status, harness.stderr || harness.stdout).toBe(0);
  return JSON.parse(harness.stdout) as Record<string, Extras>;
}

describe('G4 — the custom provider forwards the reasoning level it was given', () => {
  it('an EXPLICIT level reaches the endpoint top-level', () => {
    const result = runHarness();
    // The defect: before G4 these were all `{}` — the selection was swallowed.
    expect(result.explicit_high.top_level).toEqual({ reasoning_effort: 'high' });
    expect(result.explicit_max.top_level).toEqual({ reasoning_effort: 'max' });
    // …and it must NOT be smuggled into extra_body, which is the Ollama-only seam.
    expect(result.explicit_high.extra_body).not.toHaveProperty('reasoning_effort');
    expect(result.explicit_high.extra_body).not.toHaveProperty('think');
  });

  it('normalises case and padding rather than forwarding them raw', () => {
    expect(runHarness().explicit_padded.top_level).toEqual({ reasoning_effort: 'high' });
  });

  it('OFF still emits BOTH signals — the ollama#14820 workaround stays intact', () => {
    const result = runHarness();
    // Ollama's /v1/chat/completions ignores extra_body.think; only /api/chat honours
    // it. Dropping either half here would let a thinking model keep thinking after
    // the user turned reasoning off.
    for (const key of ['effort_none', 'disabled'] as const) {
      expect(result[key].top_level, key).toEqual({ reasoning_effort: 'none' });
      expect(result[key].extra_body.think, key).toBe(false);
    }
  });

  it('enabled with NO level stays unset, so the endpoint keeps its own default', () => {
    const result = runHarness();
    // Forcing a level the user never picked is the opposite defect and just as wrong.
    expect(result.enabled_no_effort.top_level).toEqual({});
    expect(result.enabled_no_effort.extra_body).not.toHaveProperty('think');
    expect(result.no_config.top_level).toEqual({});
  });
});
