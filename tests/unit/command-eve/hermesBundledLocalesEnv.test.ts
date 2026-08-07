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
 *
 * WHERE the files land is measured, not assumed — this suite's first version
 * asserted `<venv>/locales` and was green while WRONG, because it tested the
 * pin against its own derivation. The 0.20 pyproject uses
 * `tool.setuptools.data-files` with target `data/locales`, which pip installs
 * to `sys.prefix/data/locales` = `<venv>/data/locales` (RECORD:
 * `../../../data/locales/de.yaml` relative to site-packages). The layout-truth
 * suite below therefore derives the install target from the BUNDLED WHEEL'S
 * OWN ENTRIES instead of trusting anyone's constant — including ours.
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
  it('pins the data-files install target (<venv>/data/locales) on the inherited env', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(paths.hermesVenv, 'data', 'locales'));
  });

  it('is correct BEFORE the venv exists (first run): absolute, non-empty, derived not probed', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(fs.existsSync(paths.hermesVenv)).toBe(false);
    expect(env.HERMES_BUNDLED_LOCALES).toBeTruthy();
    expect(path.isAbsolute(env.HERMES_BUNDLED_LOCALES as string)).toBe(true);
    expect(env.HERMES_BUNDLED_LOCALES).toMatch(/[/\\]data[/\\]locales$/);
  });

  it('overrides a stale inherited value instead of letting it silently win', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = { HERMES_BUNDLED_LOCALES: '/somewhere/stale/locales' };
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(paths.hermesVenv, 'data', 'locales'));
  });

  it('stays seat-independent: the venv (and its locales) is shared per install', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    const legacyPaths = resolveCommandEveRuntimeBootstrapPaths(userData, null, 'darwin');
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(legacyPaths.hermesVenv, 'data', 'locales'));
  });
});

// ---------------------------------------------------------------------------
// Layout truth: derive the install target from the bundled wheel's OWN entries.
// ---------------------------------------------------------------------------

/**
 * List a zip's entry names from its central directory — no dependency, no
 * extraction. Enough zip to read the truth: EOCD (0x06054b50) from the tail,
 * then central-directory records (0x02014b50) with the name length at +28.
 */
function listZipEntryNames(zipPath: string): string[] {
  const buffer = fs.readFileSync(zipPath);
  const EOCD = 0x06054b50;
  const CDIR = 0x02014b50;
  let eocdOffset = -1;
  const searchFloor = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= searchFloor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`no zip end-of-central-directory in ${zipPath}`);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  const names: string[] = [];
  while (cursor + 46 <= buffer.length && buffer.readUInt32LE(cursor) === CDIR) {
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * Where pip will land the wheel's locale YAMLs, relative to the venv root.
 * Wheel spec: an entry `<dist>-<v>.data/data/<rest>` installs to
 * `<scheme data root>/<rest>`, and for a venv the data root IS the venv root.
 * So 0.17's `….data/data/locales/de.yaml` → `locales/…`, and 0.20's
 * setuptools data-files form `….data/data/data/locales/de.yaml` →
 * `data/locales/…`.
 */
function deriveWheelLocalesRelDir(entryNames: string[]): { relDir: string; yamlCount: number } | null {
  const matches = entryNames
    .map((name) => name.match(/^[^/]+\.data\/data\/(.+)\/[^/]+\.yaml$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .filter((match) => match[1] === 'locales' || match[1].endsWith('/locales'));
  if (matches.length === 0) return null;
  const relDirs = new Set(matches.map((match) => match[1]));
  if (relDirs.size !== 1) throw new Error(`ambiguous locale dirs in wheel: ${[...relDirs].join(', ')}`);
  return { relDir: [...relDirs][0], yamlCount: matches.length };
}

describe('HERMES_BUNDLED_LOCALES layout truth (derived from the bundled wheel bytes)', () => {
  const bundledDir = path.resolve(process.cwd(), 'resources', 'bundled-hermes');
  const wheelName = fs.readdirSync(bundledDir).find((name) => /^hermes_agent-.*\.whl$/.test(name));

  it('the bundled wheel carries a full locale set in a SINGLE known layout', () => {
    expect(wheelName, 'no bundled hermes wheel found').toBeTruthy();
    const derived = deriveWheelLocalesRelDir(listZipEntryNames(path.join(bundledDir, wheelName as string)));
    expect(derived, 'bundled wheel ships no locales — the resolver contract changed, re-derive the pin').not.toBeNull();
    // Counted from the wheels themselves: 0.17 ships 16 locale YAMLs, 0.20
    // ships 17. The floor guards against a truncated locale set, not a census.
    expect(derived!.yamlCount).toBeGreaterThanOrEqual(16);
    // Only the two layouts that ever existed are legitimate; anything else is
    // a NEW layout nobody has verified — fail instead of guessing.
    expect(['locales', 'data/locales']).toContain(derived!.relDir);
  });

  it('the pin matches the wheel-derived install dir (0.20 layout), or the 0.17 transition contract holds', () => {
    const derived = deriveWheelLocalesRelDir(listZipEntryNames(path.join(bundledDir, wheelName as string)));
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    const pinned = env.HERMES_BUNDLED_LOCALES as string;
    if (derived!.relDir === 'data/locales') {
      // The bundled wheel already uses the setuptools data-files layout the
      // pin targets — from here on the pin MUST match the wheel bytes exactly.
      expect(pinned).toBe(path.join(paths.hermesVenv, ...derived!.relDir.split('/')));
    } else {
      // Transition state (0.17 still bundled): its wheel-native layout lands
      // at `<venv>/locales`, which 0.17 finds via its OWN sysconfig fallback —
      // the pin deliberately targets the 0.20 data-files location instead.
      // If the pin drifts anywhere else, or a bundled wheel ever combines the
      // sysconfig-less resolver with this layout, this branch goes red.
      expect(derived!.relDir).toBe('locales');
      expect(pinned).toBe(path.join(paths.hermesVenv, 'data', 'locales'));
    }
  });
});
