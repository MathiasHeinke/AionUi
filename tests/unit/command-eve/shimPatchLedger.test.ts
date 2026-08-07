/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * G1 (CEVE-18205) — EVERY shim patch must be COUNTABLE, not merely present.
 *
 * THE DEFECT, quoted from the shim's own comment before this test existed:
 * "Every installer above returns silently when its import fails, so a missing
 * patch looked exactly like a successful one." Twelve `_install_command_eve_*`
 * functions, four markers — and those four lived on three DIFFERENT host classes
 * (HermesACPAgent, ContextCompressor, AIAgent), so nothing could enumerate them.
 * Eleven patches could vanish on a Hermes upgrade with no log, no warning and no
 * receipt entry.
 *
 * WHAT THIS TEST IS FOR is the NEXT installer, not the twelve that exist. A patch
 * added without a ledger entry re-opens exactly the hole G1 closed, and it would
 * do so invisibly. So the assertions below are equalities over sets derived from
 * the EMITTED shim — add an installer and the sets diverge and this file reddens.
 *
 * CONSUMPTION, NOT EXISTENCE. A `grep` for `_command_eve_mark_patch` would pass
 * for twelve marker calls parked in one unrelated function. Every assertion here
 * therefore slices the emitted Python PER FUNCTION BODY and requires the marker to
 * sit inside the installer it belongs to.
 *
 * The shim is read from a REAL provisioned seat home through the real
 * `provisionSeatRuntimeFiles` naht — the same bytes Hermes imports at runtime —
 * mirroring provisionSeatRuntimeFiles.test.ts. A test against a string constant in
 * the emitter could not catch an emitter that stopped writing the file.
 */

import { afterEach, describe, expect, it } from 'vitest';
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
const makeUserData = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-shim-ledger-test-'));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  __resetActiveSeatForTests();
  clearActiveSeat();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The shim exactly as Hermes imports it: the provider plugin's `__init__.py`. */
function emittedShim(): string {
  const userData = makeUserData();
  setActiveSeatId(REAL_UUID);
  const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
  provisionSeatRuntimeFiles({ userDataPath: userData, seatId: REAL_UUID });
  const shimPath = path.join(seatHome, 'plugins', 'model-providers', 'custom', '__init__.py');
  if (!fs.existsSync(shimPath)) throw new Error(`emitter wrote no shim at ${shimPath}`);
  return fs.readFileSync(shimPath, 'utf8');
}

/**
 * Split the emitted Python into top-level `def` bodies, keyed by function name.
 *
 * Column-0 indentation is the boundary: Python guarantees a top-level statement
 * ends the previous top-level body, which is precisely the scope an installer's
 * marker has to live inside.
 */
function topLevelFunctionBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current) bodies.set(current, buffer.join('\n'));
    current = null;
    buffer = [];
  };
  for (const line of lines) {
    const def = /^def ([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (def) {
      flush();
      current = def[1];
      continue;
    }
    // A new top-level statement (column 0, non-blank, not a comment) closes the body.
    if (current && /^\S/.test(line) && !line.startsWith('#')) {
      flush();
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return bodies;
}

const markerNamesIn = (body: string): string[] =>
  Array.from(body.matchAll(/_command_eve_mark_patch\("([a-z_]+)"\)/g), (m) => m[1]);

/** Strip the installer prefix/suffix so `_install_command_eve_x_patch` -> `x`. */
const shortName = (installer: string): string => installer.replace(/^_install_command_eve_/, '').replace(/_patch$/, '');

describe('G1 — the shim patch ledger is complete and consumed', () => {
  it('EVERY installer marks itself, INSIDE its own body', () => {
    const bodies = topLevelFunctionBodies(emittedShim());
    const installers = [...bodies.keys()].filter((name) => name.startsWith('_install_command_eve_'));
    // Guards the guard: if the slicer ever stops finding installers, the
    // assertions below would pass vacuously.
    expect(installers.length).toBeGreaterThanOrEqual(12);

    const unmarked: string[] = [];
    const mismarked: string[] = [];
    for (const installer of installers) {
      const marks = markerNamesIn(bodies.get(installer) ?? '');
      if (marks.length === 0) {
        unmarked.push(installer);
        continue;
      }
      // The marker must name ITS OWN installer — a copy-pasted marker naming a
      // sibling would keep the count right and the ledger wrong.
      if (!marks.includes(shortName(installer))) mismarked.push(`${installer} marks ${marks.join('/')}`);
    }
    expect(unmarked, 'installer(s) with no ledger entry — G1 hole reopened').toEqual([]);
    expect(mismarked, 'installer(s) whose marker names a different patch').toEqual([]);
  });

  it('the EXPECTED tuple matches the installers exactly — no drift in either direction', () => {
    const shim = emittedShim();
    const tuple = /_COMMAND_EVE_EXPECTED_PATCHES = \(([\s\S]*?)\)/.exec(shim);
    expect(tuple, '_COMMAND_EVE_EXPECTED_PATCHES not emitted').not.toBeNull();
    // The ledger has TWO scopes. Boot-scoped patches must exist after import; the
    // turn-scoped one is installed on the first ACP turn and is absent before it BY
    // DESIGN (proven by the 0.20 smoke test, where driving one turn moved the ledger
    // from 11 to 12). Both together must still cover every installer, or a patch can
    // be dropped from the report by quietly relabelling it.
    const turnTuple = /_COMMAND_EVE_TURN_SCOPED_PATCHES = \(([\s\S]*?)\)/.exec(shim);
    expect(turnTuple, '_COMMAND_EVE_TURN_SCOPED_PATCHES not emitted').not.toBeNull();
    const bootScoped = new Set(Array.from(tuple![1].matchAll(/"([a-z_]+)"/g), (m) => m[1]));
    const turnScoped = new Set(Array.from(turnTuple![1].matchAll(/"([a-z_]+)"/g), (m) => m[1]));
    expect(
      [...bootScoped].filter((n) => turnScoped.has(n)),
      'a patch cannot be both scopes'
    ).toEqual([]);
    const expected = new Set([...bootScoped, ...turnScoped]);

    const bodies = topLevelFunctionBodies(shim);
    const installers = [...bodies.keys()].filter((name) => name.startsWith('_install_command_eve_'));
    const declared = new Set(installers.map(shortName));

    // Both directions matter: an installer missing from the tuple is never
    // reported as absent, and a tuple entry with no installer reports a
    // permanent phantom failure.
    expect(
      [...declared].filter((n) => !expected.has(n)),
      'installer missing from EXPECTED tuple'
    ).toEqual([]);
    expect(
      [...expected].filter((n) => !declared.has(n)),
      'EXPECTED entry with no installer'
    ).toEqual([]);
  });

  it('the verifier REPORTS and does not raise, and the authority patch keeps its hard gate', () => {
    const shim = emittedShim();
    const bodies = topLevelFunctionBodies(shim);

    const verify = bodies.get('_verify_command_eve_patches');
    expect(verify, '_verify_command_eve_patches not emitted').toBeDefined();
    expect(verify).toMatch(/_COMMAND_EVE_EXPECTED_PATCHES/);
    expect(verify).toMatch(/_COMMAND_EVE_INSTALLED_PATCHES/);
    // The whole point of G1: a missing non-authority patch degrades a feature,
    // it does not abort the turn.
    expect(verify, 'the verifier must report, never raise').not.toMatch(/\braise\b/);
    // …and it must NOT fold the turn-scoped set in, or every runtime that has not
    // served an ACP turn yet reports a phantom miss.
    expect(verify, 'the verifier must not report turn-scoped patches').not.toMatch(/_COMMAND_EVE_TURN_SCOPED_PATCHES/);

    // …while the authority patch stays hard. That asymmetry IS the design.
    const requireGate = bodies.get('_require_command_eve_permission_authority_patch');
    expect(requireGate, 'the authority gate disappeared').toBeDefined();
    expect(requireGate, 'the authority gate must still raise').toMatch(/\braise\b/);
  });

  it('the missing list is published on the hot path, so the receipt can read it', () => {
    const bodies = topLevelFunctionBodies(emittedShim());

    const writer = bodies.get('_command_eve_write_patch_status');
    expect(writer, '_command_eve_write_patch_status not emitted').toBeDefined();
    expect(writer).toMatch(/_verify_command_eve_patches\(\)/);
    expect(writer).toMatch(/command-eve-patch-status\.json/);
    // Diagnostics must never take down a model call.
    expect(writer, 'the status writer must stay best-effort').toMatch(/except Exception:/);

    // Published from build_api_kwargs_extras — the moment every installer has been
    // retried WITH the ACP layer importable, which is the only point where a
    // missing patch is a fact rather than an import-order race.
    const extras = /def build_api_kwargs_extras\([\s\S]*?\n(?=\S)/.exec(emittedShim())?.[0] ?? '';
    expect(extras).toMatch(/_command_eve_write_patch_status\(\)/);
  });
});
