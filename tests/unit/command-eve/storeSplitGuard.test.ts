/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * STORE-SPLIT SELF-DETECTION GUARD (S9).
 *
 * The bruchlinie this whole slice fixes: a `commandEve.*` config key the RENDERER
 * persists to the aioncore BACKEND settings store (`configService.set` →
 * `/api/settings/client` → SQLite `client_preferences`) is read back in the MAIN
 * process via `ProcessConfig.get*('commandEve.<key>')` — a DIFFERENT store the
 * renderer never writes to. That read silently returns `undefined` forever, so the
 * control is DEAD. It happened SIX times (inferenceSelection = a money bug;
 * teamWorkerStatus = a money bug; workerAssignments; localModelTierId;
 * modelWarmupEnabled; the STT seed). Each one was invisible until a human noticed.
 *
 * THIS GUARD makes a 7th occurrence FAIL CI instead of dying silently
 * ([[founder-self-detection-standard]] — a failure the system fails to
 * SELF-DETECT is worse than the bug). It greps the compiled-away source of the
 * main-process files for `ProcessConfig.get*('commandEve.<RENDERER_WRITTEN_KEY>')`
 * and fails if any is found. A new split-reader can no longer be introduced
 * without either (a) routing through the backend batch reader, or (b) a conscious,
 * reviewed decision to add the key to the DEFERRED allowlist below.
 *
 * SCOPE: only keys the RENDERER writes via `configService` to the backend store
 * belong here. Keys the MAIN process itself owns and writes via `ProcessConfig`
 * (e.g. `commandEve.spendCapEurCents`, written by commandEveBridge) are NOT
 * store-split victims and are intentionally absent from the list.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The `commandEve.*` keys the RENDERER persists to the BACKEND settings store.
 * A main-process `ProcessConfig.get*` on any of these is the store-split bug.
 * Keep in sync with the keys the settings UI writes via `configService.set`.
 */
const RENDERER_WRITTEN_KEYS: readonly string[] = [
  'commandEve.inferenceSelection',
  'commandEve.teamWorkerStatus',
  'commandEve.workerAssignments',
  'commandEve.localModelTierId',
  'commandEve.modelWarmupEnabled',
  // S11: the PII/DSGVO egress redaction switch. The settings card writes it via
  // configService to the backend store; the shim reads it via the backend batch
  // reader (createEgressRedactionModeResolver), never from ProcessConfig.
  'commandEve.egressRedactionMode',
];

/**
 * Keys that are RENDERER-shaped but whose main-process ProcessConfig read is a
 * CONSCIOUS, reviewed DEFERRAL rather than a bug. `executionMode` has NO renderer
 * writer today — the read resolves to the fixed default 'observed'. Wiring its
 * writer is an open Founder product decision (the autonomy regler = HG-ladder as
 * UI, sweep #8), so it stays on ProcessConfig by design until that decision lands.
 * Adding a key here is the auditable escape hatch — it must be a deliberate act.
 */
const DEFERRED_ALLOWLIST: readonly string[] = ['commandEve.executionMode'];

/** Main-process source files that must never split-read a renderer-written key. */
const GUARDED_SOURCE_PATHS: readonly string[] = [
  '../../../packages/desktop/src/index.ts',
  '../../../packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts',
  '../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts',
  '../../../packages/desktop/src/process/bridge/commandEveBridge.ts',
].map((p) => path.resolve(__dirname, p));

/** Strip block + line comments so a `ProcessConfig.getSync(...)` MENTION in a
 *  docstring (there are several — they DESCRIBE the fixed bug) never trips the
 *  guard. Keeps `://` intact so URLs survive (mirrors eveSoulWiring.test.ts). */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * Build a regex that matches a live `ProcessConfig.get` / `.getSync` call whose
 * FIRST argument is the given key (single or double quoted, with tolerant
 * whitespace). Deliberately narrow — it matches the actual call shape, not a
 * bare string mention.
 */
function processConfigReadRegex(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`ProcessConfig\\s*\\.\\s*get(?:Sync)?\\s*\\(\\s*['"]${escaped}['"]`);
}

describe('store-split self-detection guard', () => {
  it('the deferred allowlist and the renderer-written list never overlap', () => {
    // A key cannot be both "must be backend-read" and "deferred to ProcessConfig".
    const overlap = RENDERER_WRITTEN_KEYS.filter((k) => DEFERRED_ALLOWLIST.includes(k));
    expect(overlap).toEqual([]);
  });

  it('all guarded source files exist (guard cannot silently no-op on a moved file)', () => {
    for (const filePath of GUARDED_SOURCE_PATHS) {
      expect(fs.existsSync(filePath), `guarded source missing: ${filePath}`).toBe(true);
    }
  });

  for (const filePath of GUARDED_SOURCE_PATHS) {
    const label = filePath.split('/packages/')[1] ?? filePath;
    it(`no main-process ProcessConfig read of a renderer-written key in ${label}`, () => {
      const code = stripComments(fs.readFileSync(filePath, 'utf8'));
      const offenders = RENDERER_WRITTEN_KEYS.filter((key) => processConfigReadRegex(key).test(code));
      expect(
        offenders,
        `Store-split regression in ${label}: these renderer-written keys are read from ` +
          `ProcessConfig (the store the renderer NEVER writes to) instead of the backend ` +
          `settings store. Route them through readCommandEveSettingsFromBackend (commandEve` +
          `BackendSettingsRead.ts). Offending keys: ${offenders.join(', ')}`
      ).toEqual([]);
    });
  }

  it('the DEFERRED executionMode read is still present (proves the guard sees live reads, not just absence)', () => {
    // Sanity/anti-vacuous: index.ts DOES still read executionMode from ProcessConfig
    // (deferred by design). If this ever disappears the guard is not being exercised
    // against a real live read and the pattern may have silently broken.
    const indexSrc = stripComments(
      fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf8')
    );
    expect(processConfigReadRegex('commandEve.executionMode').test(indexSrc)).toBe(true);
  });
});
