/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HERMES_BUNDLED_LOCALES pin (managed V22 package integration).
 *
 * The reviewed V22 Nix wheel deliberately omits bare data directories. The
 * app therefore packages the 17 locale YAMLs from the same exact Hermes source
 * payload beside the wheel and points Hermes at that immutable Resources path.
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
  const sourceLocales = path.resolve('resources', 'bundled-hermes', 'locales');

  it('pins the managed app resource locale root on the inherited env', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(paths.hermesVenv).toBeTruthy();
    expect(env.HERMES_BUNDLED_LOCALES).toBe(sourceLocales);
  });

  it('is correct BEFORE the venv exists (first run): absolute, non-empty, derived not probed', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(fs.existsSync(paths.hermesVenv)).toBe(false);
    expect(env.HERMES_BUNDLED_LOCALES).toBeTruthy();
    expect(path.isAbsolute(env.HERMES_BUNDLED_LOCALES as string)).toBe(true);
    expect(env.HERMES_BUNDLED_LOCALES).toBe(sourceLocales);
  });

  it('overrides a stale inherited value instead of letting it silently win', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = { HERMES_BUNDLED_LOCALES: '/somewhere/stale/locales' };
    const paths = prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(paths.hermesVenv).toBeTruthy();
    expect(env.HERMES_BUNDLED_LOCALES).toBe(sourceLocales);
  });

  it('stays seat-independent: the venv (and its locales) is shared per install', () => {
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    const legacyPaths = resolveCommandEveRuntimeBootstrapPaths(userData, null, 'darwin');
    expect(legacyPaths.hermesVenv).toBeTruthy();
    expect(env.HERMES_BUNDLED_LOCALES).toBe(sourceLocales);
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

describe('HERMES_BUNDLED_LOCALES package topology truth', () => {
  const bundledDir = path.resolve(process.cwd(), 'resources', 'bundled-hermes');
  const wheelName = fs.readdirSync(bundledDir).find((name) => /^hermes_agent-.*\.whl$/.test(name));

  it('keeps the reviewed V22 wheel unmodified and locale-free', () => {
    expect(wheelName, 'no bundled hermes wheel found').toBeTruthy();
    const derived = deriveWheelLocalesRelDir(listZipEntryNames(path.join(bundledDir, wheelName as string)));
    expect(derived).toBeNull();
  });

  it('pins the complete external locale tree from the managed source payload', () => {
    const localeDirectory = path.join(bundledDir, 'locales');
    expect(fs.readdirSync(localeDirectory).filter((name) => name.endsWith('.yaml'))).toHaveLength(17);
    const userData = makeUserData();
    const env: NodeJS.ProcessEnv = {};
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_BUNDLED_LOCALES).toBe(localeDirectory);
  });
});
