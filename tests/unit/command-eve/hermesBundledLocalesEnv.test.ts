/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HERMES_BUNDLED_LOCALES pin (Hermes-0.20 preparation).
 *
 * Hermes ≤0.17 resolved bundled locales env → repo → sysconfig; 0.20 dropped
 * the sysconfig branch, so in a wheel install WITHOUT this env var not a
 * single locale file is found and 17 languages silently fall back to English.
 * The bake in prepareCommandEveRuntimeProcessEnv must therefore always pin the
 * venv's data-root locales path — including on a FIRST RUN where the venv does
 * not exist yet (the path is derived, never probed), and never an empty string
 * that a later resolver would silently prefer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  prepareCommandEveRuntimeProcessEnv,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@process/commandEve/runtimeBootstrapCore';

const tempDirs: string[] = [];

function makeUserData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-locales-env-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('HERMES_BUNDLED_LOCALES bake', () => {
  it('pins the venv data-root locales path on the inherited env', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(paths.hermesVenv, 'locales'));
  });

  it('is correct BEFORE the venv exists (first run): absolute, non-empty, derived not probed', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    // The venv is not installed in this fresh userData — the pin must still be
    // the deterministic future location, never '' and never a crash.
    expect(fs.existsSync(paths.hermesVenv)).toBe(false);
    expect(env.HERMES_BUNDLED_LOCALES).toBeTruthy();
    expect(path.isAbsolute(env.HERMES_BUNDLED_LOCALES as string)).toBe(true);
    expect(env.HERMES_BUNDLED_LOCALES).toMatch(/[/\\]locales$/);
  });

  it('overrides a stale inherited value instead of letting it silently win', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = { HERMES_BUNDLED_LOCALES: '/somewhere/stale/locales' };
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(paths.hermesVenv, 'locales'));
  });

  it('stays seat-independent: the venv (and its locales) is shared per install', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    const legacyPaths = resolveCommandEveRuntimeBootstrapPaths(userData, null, 'darwin');
    // hermesVenv lives on the shared hermesRoot (one venv per install), so the
    // locale pin must not vary by seat.
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(legacyPaths.hermesVenv, 'locales'));
  });
});
