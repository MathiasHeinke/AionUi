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

  it('resolves relative Hermes media paths from the session cwd before the existing confinement gate', () => {
    const root = makeUserData();
    const shimPath = path.join(root, 'command-eve-provider-override.py');
    fs.writeFileSync(shimPath, emittedShim(), 'utf8');
    // The packaged runtime is the ONLY interpreter that proves anything here:
    // the probe imports `agent.runtime_cwd` and `tools.image_source` out of the
    // SHIPPED site-packages, so a fallback to the developer's `python3` does not
    // test a weaker version of this — it tests a different program.
    //
    // Two build layouts produce that runtime and BOTH count. `out/mac-arm64` is
    // what `build-mac:arm64:notarized` writes; `out/qa-signed-packaged` is the
    // QA-signed variant from electron-builder.qa-signed.yml. Pinning only the
    // latter is what made this test go red for an ENVIRONMENT reason on a tree
    // whose bundle was sitting in the other directory — a red that says nothing
    // about the code is worse than no test, because it trains people to ignore
    // it.
    const packagedRoots = [
      'out/mac-arm64/Command EVE.app/Contents/Resources/python',
      'out/qa-signed-packaged/mac-arm64/Command EVE.app/Contents/Resources/python',
    ].map((candidate) => path.resolve(candidate));
    const packagedRoot = packagedRoots.find(
      (candidate) =>
        fs.existsSync(path.join(candidate, 'bin/python3.12')) &&
        fs.existsSync(path.join(candidate, 'artifact-site-packages'))
    );
    const packagedPython = packagedRoot ? path.join(packagedRoot, 'bin/python3.12') : '';
    const packagedSite = packagedRoot ? path.join(packagedRoot, 'artifact-site-packages') : '';
    const hasPackagedRuntime = packagedRoot !== undefined;
    const python = hasPackagedRuntime ? packagedPython : 'python3';
    const hermesSource = hasPackagedRuntime
      ? packagedSite
      : path.resolve('resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl');
    const probe = String.raw`
import ast
import asyncio
import inspect
import json
import os
from pathlib import Path
import sys
import tempfile
import types
from typing import Any

shim_path = Path(sys.argv[1])
sys.path.insert(0, sys.argv[2])

from agent.runtime_cwd import set_session_cwd
from tools import image_source

vision_tools = types.ModuleType("tools.vision_tools")
vision_tools._detect_image_mime_type_from_bytes = lambda data: "image/png"
sys.modules["tools.vision_tools"] = vision_tools

tree = ast.parse(shim_path.read_text(encoding="utf-8"))
installer = next(
    node
    for node in tree.body
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    and node.name == "_install_command_eve_media_runtime_cwd_patch"
)
module = ast.fix_missing_locations(ast.Module(body=[installer], type_ignores=[]))
installed = set()
namespace = {
    "Any": Any,
    "inspect": inspect,
    "_command_eve_mark_patch": installed.add,
}
exec(compile(module, str(shim_path), "exec"), namespace)

root = Path(tempfile.mkdtemp())
project = root / "project"
media = project / "bilder"
media.mkdir(parents=True)
image = media / "x.png"
image.write_bytes(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de"
    "0000000c4944415408d763f8cfc000000301010018dd8db10000000049454e44ae426082"
))
process_cwd = root / "process"
process_cwd.mkdir()
os.chdir(process_cwd)
os.environ["TERMINAL_ENV"] = "local"
set_session_cwd(str(project))

async def resolve(src):
    return await image_source.resolve_image_source(src, image_source.ResolveContext())

before_failed = False
try:
    asyncio.run(resolve("bilder/x.png"))
except image_source.SourceNotFound:
    before_failed = True

namespace["_install_command_eve_media_runtime_cwd_patch"]()
patched_once = image_source.resolve_image_source
namespace["_install_command_eve_media_runtime_cwd_patch"]()
idempotent_install = image_source.resolve_image_source is patched_once
gate_paths = []
original_gate = image_source._permitted_host_read_target
def recording_gate(path, context):
    gate_paths.append(str(path))
    return original_gate(path, context)
image_source._permitted_host_read_target = recording_gate
bare = asyncio.run(resolve("bilder/x.png"))
file_uri = asyncio.run(resolve("file://bilder/x.png"))
sandbox_paths = []
original_fallback = image_source._resolve_container_fallback
async def recording_fallback(path, context, source, permitted=("image",)):
    sandbox_paths.append(str(path))
    return image_source.ResolvedImage(data=image.read_bytes(), mime="image/png", origin="container")
image_source._resolve_container_fallback = recording_fallback
os.environ["TERMINAL_ENV"] = "docker"
sandbox = asyncio.run(resolve("bilder/x.png"))
image_source._resolve_container_fallback = original_fallback
file_path_preserved = None
if sys.argv[3] == "packaged":
    from tools.file_tools import _resolve_path_for_task
    from tools.terminal_tool import register_task_env_overrides

    register_task_env_overrides("media-cwd-probe", {"cwd": str(project)})
    resolved_file_path = str(_resolve_path_for_task("bilder/x.png", "media-cwd-probe"))
    file_path_preserved = (
        resolved_file_path.endswith("/bilder/x.png")
        and resolved_file_path != str(process_cwd / "bilder" / "x.png")
    )

print(json.dumps({
    "before_failed": before_failed,
    "patch_installed": "media_runtime_cwd" in installed,
    "idempotent_install": idempotent_install,
    "bare_origin": bare.origin,
    "file_uri_origin": file_uri.origin,
    "payload_matches": bare.data == image.read_bytes() == file_uri.data,
    "confinement_gate_preserved": (
        gate_paths == [str(image), str(image), str(image)]
        and sandbox.origin == "container"
        and sandbox_paths == [str(image)]
    ),
    "file_path_preserved": file_path_preserved,
}))
`;
    const result = spawnSync(
      python,
      ['-I', '-S', '-B', '-c', probe, shimPath, hermesSource, hasPackagedRuntime ? 'packaged' : 'wheel'],
      {
        encoding: 'utf8',
        timeout: 30_000,
      }
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      before_failed: true,
      patch_installed: true,
      idempotent_install: true,
      bare_origin: 'file',
      file_uri_origin: 'file',
      payload_matches: true,
      confinement_gate_preserved: true,
    });
    expect(payload.file_path_preserved).toBe(hasPackagedRuntime ? true : null);
  });

  /**
   * The NameError class the ledger assertions above CANNOT see.
   *
   * `acp_session_recovery` was renamed to `acp_session_guard`, and 1.823.0 later
   * re-added two calls to the retired name. The module-level one runs at import,
   * so every provisioned seat raised
   * `NameError: _install_command_eve_acp_session_recovery_patch is not defined`
   * before the provider ever loaded. The tuple assertion above reddened only
   * because that rename also left an EXPECTED entry behind; a call reintroduced
   * WITHOUT a tuple entry stays invisible to every assertion above and is still
   * fatal at import. Name resolution therefore needs its own gate.
   */
  it('every installer CALL resolves to a definition — a rename cannot leave a NameError behind', () => {
    const shim = emittedShim();
    const defined = new Set(Array.from(shim.matchAll(/^def (_install_command_eve_[A-Za-z0-9_]*)\s*\(/gm), (m) => m[1]));
    // `def` lines are declarations, not calls; everything else that names an
    // installer with parentheses is one, at module level or inside a body.
    const called = new Set(
      shim
        .split(/\r?\n/)
        .filter((line) => !/^\s*def\s/.test(line))
        .flatMap((line) => Array.from(line.matchAll(/\b(_install_command_eve_[A-Za-z0-9_]*)\s*\(/g), (m) => m[1]))
    );
    // Guards the guard: if the slicer stops finding calls, the assertions below
    // would pass vacuously on an empty set.
    expect(called.size, 'no installer calls found — the slicer broke, not the shim').toBeGreaterThanOrEqual(12);

    // Both directions close the call graph: an undefined callee is a NameError at
    // import, and an installer nobody calls is dead patch machinery that the
    // ledger would still report as expected.
    expect(
      [...called].filter((name) => !defined.has(name)),
      'installer CALLED but never defined — NameError at import'
    ).toEqual([]);
    expect(
      [...defined].filter((name) => !called.has(name)),
      'installer DEFINED but never called — dead patch machinery'
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
