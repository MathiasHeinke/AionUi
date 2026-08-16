/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Hermes wheel bump as a command (Hermes-0.20 preparation).
 *
 * Two layers of protection are pinned here:
 *  1. MANIFEST ↔ REPO tripwire: the script's expected-occurrence manifest must
 *     match the real tree TODAY. If a carrier moves or a count drifts, this
 *     suite goes red long before anyone runs the bump — which is the whole
 *     point: the script aborts on drift instead of half-applying, and this
 *     test makes that drift visible at CI time.
 *  2. Behavioral contract against a fixture repo: plan/apply/dry-run/abort
 *     semantics, self-computed sha, wheel-name contract, residue verification.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_HERMES_DIR,
  HERMES_PIN_FILE,
  HERMES_RUNTIME_LOCK_FILE,
  HERMES_RUNTIME_LOCK_SHA_SITES,
  HERMES_VERSION_SITES,
  HERMES_WHEEL_SHA_SITES,
  applyHermesWheelBump,
  planHermesWheelBump,
  readCurrentHermesPin,
  sha256File,
  wheelFileNameForVersion,
} from '../../../scripts/hermes/bump-hermes-wheel-core.mjs';

const REPO_ROOT = path.resolve(process.cwd());
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('manifest ↔ repo tripwire (the abort-on-drift guarantee, continuously enforced)', () => {
  const pin = readCurrentHermesPin(REPO_ROOT);

  it('parses a plausible current pin', () => {
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every version carrier holds exactly the expected occurrence count', () => {
    for (const site of HERMES_VERSION_SITES) {
      const filePath = path.join(REPO_ROOT, site.file);
      expect(fs.existsSync(filePath), `missing carrier: ${site.file}`).toBe(true);
      const found = countOccurrences(fs.readFileSync(filePath, 'utf8'), pin.version);
      expect(found, `occurrence drift in ${site.file}`).toBe(site.count);
    }
  });

  it('every sha carrier holds exactly the expected occurrence count', () => {
    for (const site of HERMES_WHEEL_SHA_SITES) {
      const found = countOccurrences(fs.readFileSync(path.join(REPO_ROOT, site.file), 'utf8'), pin.sha256);
      expect(found, `sha occurrence drift in ${site.file}`).toBe(site.count);
    }
  });

  it('every runtime-lock sha carrier matches the current lock bytes exactly', () => {
    const lockSha256 = sha256File(path.join(REPO_ROOT, HERMES_RUNTIME_LOCK_FILE));
    for (const site of HERMES_RUNTIME_LOCK_SHA_SITES) {
      const found = countOccurrences(fs.readFileSync(path.join(REPO_ROOT, site.file), 'utf8'), lockSha256);
      expect(found, `Hermes runtime lock sha occurrence drift in ${site.file}`).toBe(site.count);
    }
  });

  it('the committed pin matches the committed wheel BYTES (sha recomputed, not trusted)', () => {
    const wheelPath = path.join(REPO_ROOT, BUNDLED_HERMES_DIR, wheelFileNameForVersion(pin.version));
    expect(fs.existsSync(wheelPath), `bundled wheel missing for pinned version: ${wheelPath}`).toBe(true);
    expect(sha256File(wheelPath)).toBe(pin.sha256);
  });
});

// ---------------------------------------------------------------------------
// Fixture repo — small custom manifest, real filesystem semantics.
// ---------------------------------------------------------------------------

const OLD_SHA = 'a'.repeat(64);

function makeFixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-hermes-bump-'));
  tempDirs.push(root);
  const pinDir = path.join(root, path.dirname(HERMES_PIN_FILE));
  fs.mkdirSync(pinDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, HERMES_PIN_FILE),
    [
      "const DEFAULT_HERMES_VERSION = '0.17.0';",
      'export const COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256 =',
      `  '${OLD_SHA}';`,
      // Computed, not spelled out: the real bump's residue scan sweeps tests/
      // for the compound `hermes_agent-<old>` literal, and a hardcoded spelling
      // HERE would read as residue after every real flip. The WRITTEN fixture
      // file still carries the compound name (that is the point of the count).
      `// wheel: ${wheelFileNameForVersion('0.17.0')}`,
      '',
    ].join('\n')
  );
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'manifest.json'), '{ "release": "x", "hermes": "0.17.0" }\n');
  fs.mkdirSync(path.join(root, BUNDLED_HERMES_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, BUNDLED_HERMES_DIR, wheelFileNameForVersion('0.17.0')), 'old-wheel-bytes');
  return root;
}

const FIXTURE_VERSION_SITES = [
  { file: HERMES_PIN_FILE, count: 2 },
  { file: 'public/manifest.json', count: 1 },
];
const FIXTURE_SHA_SITES = [{ file: HERMES_PIN_FILE, count: 1 }];

function makeTargetWheel(version: string, bytes = 'new-wheel-bytes'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-hermes-wheel-'));
  tempDirs.push(dir);
  const wheelPath = path.join(dir, wheelFileNameForVersion(version));
  fs.writeFileSync(wheelPath, bytes);
  return wheelPath;
}

function fixturePlan(
  root: string,
  overrides: Partial<{ targetVersion: string; wheelPath: string; allowSameVersionRepin: boolean }> = {}
) {
  return planHermesWheelBump({
    repoRoot: root,
    targetVersion: overrides.targetVersion ?? '0.20.0',
    wheelPath: overrides.wheelPath ?? makeTargetWheel('0.20.0'),
    versionSites: FIXTURE_VERSION_SITES,
    shaSites: FIXTURE_SHA_SITES,
    allowSameVersionRepin: overrides.allowSameVersionRepin,
  });
}

describe('planHermesWheelBump (fixture)', () => {
  it('computes the sha itself and plans every carrier', () => {
    const root = makeFixtureRepo();
    const wheelPath = makeTargetWheel('0.20.0', 'precise-bytes');
    const plan = fixturePlan(root, { wheelPath });
    expect(plan.newSha256).toBe(sha256File(wheelPath));
    expect(plan.oldVersion).toBe('0.17.0');
    expect(plan.versionEdits.map((edit: { file: string }) => edit.file)).toEqual([
      HERMES_PIN_FILE,
      'public/manifest.json',
    ]);
  });

  it('aborts on occurrence-count drift instead of half-applying', () => {
    const root = makeFixtureRepo();
    fs.appendFileSync(path.join(root, 'public', 'manifest.json'), '// stray 0.17.0 mention\n');
    expect(() => fixturePlan(root)).toThrow(/site drift: public\/manifest\.json/);
  });

  it('aborts when an expected carrier is missing entirely', () => {
    const root = makeFixtureRepo();
    fs.rmSync(path.join(root, 'public', 'manifest.json'));
    expect(() => fixturePlan(root)).toThrow(/missing site: public\/manifest\.json/);
  });

  it('rejects a wheel whose NAME does not carry the target version (load-bearing contract)', () => {
    const root = makeFixtureRepo();
    const wrongName = makeTargetWheel('0.19.9');
    expect(() => fixturePlan(root, { wheelPath: wrongName })).toThrow(/BY NAME/);
  });

  it('rejects a no-op bump to the already-pinned version', () => {
    const root = makeFixtureRepo();
    expect(() => fixturePlan(root, { targetVersion: '0.17.0', wheelPath: makeTargetWheel('0.17.0') })).toThrow(
      /already pins/
    );
  });

  it('plans an explicit same-version repin without rewriting version carriers', () => {
    const root = makeFixtureRepo();
    const wheelPath = makeTargetWheel('0.17.0', 'reviewed-repin-bytes');
    const plan = fixturePlan(root, { targetVersion: '0.17.0', wheelPath, allowSameVersionRepin: true });
    expect(plan.sameVersionRepin).toBe(true);
    expect(plan.versionEdits).toEqual([]);
    expect(plan.shaEdits.map((edit: { file: string }) => edit.file)).toEqual([HERMES_PIN_FILE]);
    expect(plan.newSha256).toBe(sha256File(wheelPath));
    const dryRun = applyHermesWheelBump(plan, { dryRun: true });
    expect(dryRun.actions.some((action: string) => action.startsWith('remove old wheel'))).toBe(false);
  });
});

describe('applyHermesWheelBump (fixture)', () => {
  it('dry-run reports the full plan and writes NOTHING', () => {
    const root = makeFixtureRepo();
    const before = fs.readFileSync(path.join(root, HERMES_PIN_FILE), 'utf8');
    const result = applyHermesWheelBump(fixturePlan(root), { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.actions.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(root, HERMES_PIN_FILE), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(root, BUNDLED_HERMES_DIR, wheelFileNameForVersion('0.20.0')))).toBe(false);
    expect(fs.existsSync(path.join(root, BUNDLED_HERMES_DIR, wheelFileNameForVersion('0.17.0')))).toBe(true);
  });

  it('real run flips every carrier, swaps the wheel and verifies zero residue', () => {
    const root = makeFixtureRepo();
    const wheelPath = makeTargetWheel('0.20.0');
    const result = applyHermesWheelBump(fixturePlan(root, { wheelPath }), { dryRun: false });
    expect(result.verified).toBe(true);
    const pinAfter = readCurrentHermesPin(root);
    expect(pinAfter.version).toBe('0.20.0');
    expect(pinAfter.sha256).toBe(sha256File(wheelPath));
    expect(fs.readFileSync(path.join(root, 'public', 'manifest.json'), 'utf8')).toContain('0.20.0');
    expect(fs.existsSync(path.join(root, BUNDLED_HERMES_DIR, wheelFileNameForVersion('0.20.0')))).toBe(true);
    expect(fs.existsSync(path.join(root, BUNDLED_HERMES_DIR, wheelFileNameForVersion('0.17.0')))).toBe(false);
  });

  it('real same-version repin preserves version carriers and replaces only the reviewed bytes and sha', () => {
    const root = makeFixtureRepo();
    const manifestBefore = fs.readFileSync(path.join(root, 'public', 'manifest.json'), 'utf8');
    const wheelPath = makeTargetWheel('0.17.0', 'reviewed-repin-bytes');
    const plan = fixturePlan(root, { targetVersion: '0.17.0', wheelPath, allowSameVersionRepin: true });
    const result = applyHermesWheelBump(plan, { dryRun: false });
    expect(result.verified).toBe(true);
    expect(readCurrentHermesPin(root)).toEqual({ version: '0.17.0', sha256: sha256File(wheelPath) });
    expect(fs.readFileSync(path.join(root, 'public', 'manifest.json'), 'utf8')).toBe(manifestBefore);
    expect(sha256File(path.join(root, BUNDLED_HERMES_DIR, wheelFileNameForVersion('0.17.0')))).toBe(
      sha256File(wheelPath)
    );
  });

  it('repins the derived Hermes runtime-lock sha after updating its wheel row', () => {
    const root = makeFixtureRepo();
    const runtimeLockFile = 'resources/hermes-runtime.tsv';
    const runtimeLockPinFile = 'public/hermes-runtime-lock-pin.txt';
    const runtimeLockPath = path.join(root, runtimeLockFile);
    fs.mkdirSync(path.dirname(runtimeLockPath), { recursive: true });
    fs.writeFileSync(runtimeLockPath, `hermes-agent\t0.17.0\t${OLD_SHA}\trepo://wheel.whl\n`);
    const oldRuntimeLockSha = sha256File(runtimeLockPath);
    fs.writeFileSync(path.join(root, runtimeLockPinFile), `${oldRuntimeLockSha}\n`);
    const wheelPath = makeTargetWheel('0.20.0', 'runtime-lock-repin-bytes');

    const plan = planHermesWheelBump({
      repoRoot: root,
      targetVersion: '0.20.0',
      wheelPath,
      versionSites: [...FIXTURE_VERSION_SITES, { file: runtimeLockFile, count: 1 }],
      shaSites: [...FIXTURE_SHA_SITES, { file: runtimeLockFile, count: 1 }],
      runtimeLockFile,
      lockShaSites: [{ file: runtimeLockPinFile, count: 1 }],
    });
    expect(plan.runtimeLock?.oldSha256).toBe(oldRuntimeLockSha);
    expect(plan.runtimeLock?.newSha256).not.toBe(oldRuntimeLockSha);

    expect(applyHermesWheelBump(plan, { dryRun: false }).verified).toBe(true);
    expect(fs.readFileSync(runtimeLockPath, 'utf8')).toContain(plan.newSha256);
    expect(sha256File(runtimeLockPath)).toBe(plan.runtimeLock?.newSha256);
    expect(fs.readFileSync(path.join(root, runtimeLockPinFile), 'utf8')).toContain(plan.runtimeLock?.newSha256);
  });
});
