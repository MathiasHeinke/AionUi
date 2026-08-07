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
 * WHERE the files land — measured against the VALID 0.20 wheel (build020h)
 * and cross-checked against the official upstream 0.17/0.19 wheels: ALL of
 * them ship locales through the wheel-native data category
 * (`hermes_agent-<v>.data/data/locales/…`), which pip installs at the venv
 * ROOT: `<venv>/locales`. A fresh 0.20 install confirms it (17 files in
 * `venv/locales`; `venv/data/locales` absent). An interim detour pinned
 * `<venv>/data/locales` — measured against a SELF-BUILT wheel whose pyproject
 * mistakenly declared a setuptools data-files `data/locales` target; that was
 * our own packaging bug, since fixed. The layout-truth suite below derives
 * the install target from the BUNDLED WHEEL'S OWN ENTRIES, so neither a
 * mis-built wheel nor a wrong constant can go green by agreeing with itself.
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
  it('pins the wheel-native data-category install target (<venv>/locales) on the inherited env', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(paths.hermesVenv, 'locales'));
  });

  it('is correct BEFORE the venv exists (first run): absolute, non-empty, derived not probed', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(fs.existsSync(paths.hermesVenv)).toBe(false);
    expect(env.HERMES_BUNDLED_LOCALES).toBeTruthy();
    expect(path.isAbsolute(env.HERMES_BUNDLED_LOCALES as string)).toBe(true);
    expect(env.HERMES_BUNDLED_LOCALES).toMatch(/[/\\]locales$/);
    // The venv-root target, NOT the data/locales detour of the mis-built
    // interim wheel (see the header): the pin must sit directly on the venv.
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(paths.hermesVenv, 'locales'));
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
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(legacyPaths.hermesVenv, 'locales'));
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
 * The wheel-native category (0.17, 0.19 upstream AND the valid 0.20 build)
 * yields `….data/data/locales/de.yaml` → `locales/…`; the mis-built interim
 * wheel doubled the segment (`….data/data/data/locales/…` → `data/locales`).
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

  it('the bundled wheel carries a full locale set in the wheel-native layout — anything else is unverified', () => {
    expect(wheelName, 'no bundled hermes wheel found').toBeTruthy();
    const derived = deriveWheelLocalesRelDir(listZipEntryNames(path.join(bundledDir, wheelName as string)));
    expect(derived, 'bundled wheel ships no locales — the resolver contract changed, re-derive the pin').not.toBeNull();
    // Counted from the wheels themselves: 0.17 ships 16 locale YAMLs, 0.20
    // ships 17. The floor guards against a truncated locale set, not a census.
    expect(derived!.yamlCount).toBeGreaterThanOrEqual(16);
    // ONE verified layout: the wheel-native data category (venv-root target),
    // which upstream 0.17/0.19 and the valid 0.20 build all use. A
    // `data/locales` derivation means a wheel with the doubled data segment of
    // the mis-built interim build (our own pyproject bug, since fixed) — or any
    // other foreign layout — is about to be bundled UNVERIFIED. Red on
    // purpose: diff the self-built wheel against the upstream layout first.
    expect(
      derived!.relDir,
      `unverified foreign locale layout '${derived!.relDir}' — diff this wheel against the upstream layout before bundling`
    ).toBe('locales');
  });

  it('the pin matches the wheel-derived install dir — from the bytes, never from its own constant', () => {
    const derived = deriveWheelLocalesRelDir(listZipEntryNames(path.join(bundledDir, wheelName as string)));
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    // The expected value is DERIVED from the wheel's zip entries: relDir is
    // whatever the wheel actually installs, joined onto the venv. If a future
    // wheel changes its layout, the previous test reds first — and this one
    // keeps the pin honest against the bytes rather than against a copy of
    // the constant in runtimeBootstrapCore.
    expect(env.HERMES_BUNDLED_LOCALES).toBe(path.join(paths.hermesVenv, ...derived!.relDir.split('/')));
  });
});
