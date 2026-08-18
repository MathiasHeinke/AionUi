/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18232 — a turn that reached `finish_reason=stop` is ANSWERED.
 *
 * THE DEFECT, as Alois saw it: every chat turn rendered a correct answer and then
 * painted a red card underneath it —
 * `UNKNOWN_UPSTREAM_ERROR ({"details":"Set changed size during iteration"})`.
 * AionCore treats a terminal error as an unhealthy agent, so it evicted the ACP
 * task and the NEXT turn paid a full ~10s cold start.
 *
 * TWO INDEPENDENT DEFECTS, deliberately tested apart:
 *
 *  1. THE CAUSE. The provider-binding cleanup passed a GENERATOR to
 *     `set.difference_update()` — a generator that reads the very set being
 *     shrunk. Deterministic `RuntimeError`, not a race: it fires whenever the
 *     finished turn emitted at least one provider binding, and stays silent when
 *     it emitted none. That asymmetry is what made it look intermittent.
 *
 *  2. THE AMPLIFIER. ANY epilogue failure after `Turn ended` escaped `prompt()`,
 *     which acp converts into a -32603 response. A bookkeeping bug could
 *     therefore un-answer an answered turn. Fixing only (1) would leave the next
 *     epilogue bug free to do the same thing.
 *
 * WHY THE CONTAINMENT IS NOT A SWALLOW — the boundaries asserted below: proof of
 * completion is required and is PER SESSION; `RequestError` still propagates
 * because it is a deliberate authority answer; and `BaseException` (cancellation)
 * is never caught.
 *
 * The probe runs the REAL emitted shim through the stock interpreter with
 * `-I -S -B`: no site packages, no bytecode written (writing .pyc into the app
 * bundle would break its code signature), and no Hermes wheel import — every seam
 * the installers touch is stubbed, so this file tests the shim and nothing else.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { provisionSeatRuntimeFiles, resolveCommandEveRuntimeBootstrapPaths } from '@/process/commandEve/runtimeBootstrapCore';
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

/** The shim exactly as Hermes imports it: the provider plugin's `__init__.py`. */
function emittedShim(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-epilogue-test-'));
  tempRoots.push(root);
  setActiveSeatId(REAL_UUID);
  const seatHome = resolveCommandEveRuntimeBootstrapPaths(root).hermesHome;
  provisionSeatRuntimeFiles({ userDataPath: root, seatId: REAL_UUID });
  const shimPath = path.join(seatHome, 'plugins', 'model-providers', 'custom', '__init__.py');
  if (!fs.existsSync(shimPath)) throw new Error('emitter wrote no shim at ' + shimPath);
  return fs.readFileSync(shimPath, 'utf8');
}

const PROBE = String.raw`
import ast
import asyncio
import io
import json
import logging
import re
import sys
import threading
import types
from pathlib import Path
from typing import Any

shim_path = Path(sys.argv[1])
tree = ast.parse(shim_path.read_text(encoding="utf-8"))

# ---------------------------------------------------------------- DEFECT 1 ----
# The cleanup must hand difference_update a MATERIALISED sequence. A generator
# argument reads the same set the call is shrinking.
shapes = {"calls": 0, "generator_args": 0, "materialised_args": 0}
for node in ast.walk(tree):
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "difference_update"
        and "_COMMAND_EVE_PROVIDER_TURN_BINDINGS_SENT" in ast.unparse(node.func.value)
    ):
        shapes["calls"] += 1
        arg = node.args[0] if node.args else None
        if isinstance(arg, ast.GeneratorExp):
            shapes["generator_args"] += 1
        elif isinstance(arg, (ast.ListComp, ast.SetComp, ast.List, ast.Set, ast.Tuple)):
            shapes["materialised_args"] += 1

def _cleanup(materialise):
    live = {("a", "1"), ("a", "2"), ("b", "3")}
    if materialise:
        live.difference_update([b for b in live if b[0] == "a"])
    else:
        live.difference_update(b for b in live if b[0] == "a")
    return sorted(live)

generator_reproduces_the_bug = False
try:
    _cleanup(False)
except RuntimeError as exc:
    generator_reproduces_the_bug = "changed size during iteration" in str(exc)
materialised_is_correct = _cleanup(True) == [("b", "3")]

# ---------------------------------------------------------------- DEFECT 2 ----
WANTED = {
    "_CommandEveInternalErrorContextHandler",
    "_install_command_eve_acp_internal_error_context_patch",
    "_CommandEveTurnCompletionHandler",
    "_command_eve_attach_turn_completion_capture",
    "_command_eve_turn_completions",
    "_install_command_eve_acp_epilogue_isolation_patch",
}
STATE_PREFIX = "_COMMAND_EVE_TURN_COMPLETION"

selected = []
for node in tree.body:
    if getattr(node, "name", None) in WANTED:
        selected.append(node)
    elif isinstance(node, ast.Assign) and any(
        ast.unparse(t).startswith(STATE_PREFIX) for t in node.targets
    ):
        selected.append(node)
    elif isinstance(node, ast.AnnAssign) and ast.unparse(node.target).startswith(STATE_PREFIX):
        selected.append(node)

found = {getattr(n, "name", None) for n in selected}
missing = sorted(WANTED - found)

class RequestError(Exception):
    pass

class PromptResponse:
    def __init__(self, stop_reason="end_turn", usage=None):
        self.stop_reason = stop_reason

class HermesACPAgent:
    pass

acp_mod = types.ModuleType("acp")
exceptions_mod = types.ModuleType("acp.exceptions")
exceptions_mod.RequestError = RequestError
schema_mod = types.ModuleType("acp.schema")
schema_mod.PromptResponse = PromptResponse
adapter_mod = types.ModuleType("acp_adapter")
server_mod = types.ModuleType("acp_adapter.server")
server_mod.HermesACPAgent = HermesACPAgent
sys.modules.update({
    "acp": acp_mod,
    "acp.exceptions": exceptions_mod,
    "acp.schema": schema_mod,
    "acp_adapter": adapter_mod,
    "acp_adapter.server": server_mod,
})

installed = set()
namespace = {
    "Any": Any,
    "logging": logging,
    "threading": threading,
    "re": re,
    "_command_eve_mark_patch": installed.add,
}
module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
exec(compile(module, str(shim_path), "exec"), namespace)

SESSION = "sess-under-test"
loop_logger = logging.getLogger("agent.conversation_loop")
loop_logger.setLevel(logging.INFO)

def run_turn(failure, completed_session):
    """One ACP turn: optionally log the agent loop's completion proof, then fail."""
    async def impl(self, *args, **kwargs):
        if completed_session:
            loop_logger.info(
                "Turn ended: reason=text_response(finish_reason=stop) "
                "api_calls=1/90 session=" + completed_session
            )
        if failure is not None:
            raise failure
        return PromptResponse(stop_reason="end_turn")

    HermesACPAgent._prompt_impl = impl
    if hasattr(HermesACPAgent, "_command_eve_acp_epilogue_isolation_patch_installed"):
        delattr(HermesACPAgent, "_command_eve_acp_epilogue_isolation_patch_installed")
    namespace["_install_command_eve_acp_epilogue_isolation_patch"]()
    try:
        response = asyncio.run(HermesACPAgent._prompt_impl(HermesACPAgent(), None, SESSION))
        return {"raised": None, "stop_reason": getattr(response, "stop_reason", None)}
    except BaseException as exc:
        return {"raised": type(exc).__name__, "stop_reason": None}

set_error = RuntimeError("Set changed size during iteration")

contained_after_completion = run_turn(set_error, SESSION)
propagates_without_completion = run_turn(RuntimeError("epilogue"), None)
propagates_request_error = run_turn(RequestError("authority"), SESSION)
propagates_cancellation = run_turn(asyncio.CancelledError(), SESSION)
propagates_other_session = run_turn(RuntimeError("epilogue"), "a-different-session")
healthy_turn = run_turn(None, SESSION)

# ------------------------------------------------------- DIAGNOSTIC CHANNEL ----
# acp raises 'from None', so the cause is never printed. It IS still on
# __context__; the handler must render it.
namespace["_install_command_eve_acp_internal_error_context_patch"]()
buffer = io.StringIO()
real_stderr = sys.stderr
sys.stderr = buffer
try:
    try:
        try:
            live = {1, 2, 3}
            for item in live:
                live.add(item + 10)
        except RuntimeError:
            raise RequestError("Internal error") from None
    except RequestError:
        logging.getLogger().error("Background task failed", exc_info=sys.exc_info())
finally:
    sys.stderr = real_stderr
diagnostic = buffer.getvalue()

unrelated = io.StringIO()
sys.stderr = unrelated
try:
    logging.getLogger().error("some other failure", exc_info=False)
finally:
    sys.stderr = real_stderr

print(json.dumps({
    "shapes": shapes,
    "generator_reproduces_the_bug": generator_reproduces_the_bug,
    "materialised_is_correct": materialised_is_correct,
    "missing_definitions": missing,
    "marked": sorted(installed),
    "contained_after_completion": contained_after_completion,
    "propagates_without_completion": propagates_without_completion,
    "propagates_request_error": propagates_request_error,
    "propagates_cancellation": propagates_cancellation,
    "propagates_other_session": propagates_other_session,
    "healthy_turn": healthy_turn,
    "diagnostic_names_the_cause": "Set changed size during iteration" in diagnostic,
    "diagnostic_labels_itself": "ORIGINAL cause" in diagnostic,
    "diagnostic_ignores_unrelated": unrelated.getvalue() == "",
}))
`;

function runProbe(): Record<string, unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-epilogue-probe-'));
  tempRoots.push(root);
  const shimPath = path.join(root, 'shim-under-test.py');
  fs.writeFileSync(shimPath, emittedShim(), 'utf8');
  // '-B' is the code-signature guard: the shipped runtime must never gain .pyc.
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', PROBE, shimPath], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('CEVE-18232 — an answered turn stays answered', () => {
  it('the provider-binding cleanup materialises before it mutates (the actual cause)', () => {
    const payload = runProbe();
    // The reproduction runs both shapes against identical data, so the assertions
    // rest on measured behaviour rather than on reading the code.
    expect(payload.generator_reproduces_the_bug, 'the generator shape must still reproduce the reported error').toBe(true);
    expect(payload.materialised_is_correct, 'materialising must remove exactly the same bindings').toBe(true);
    const shapes = payload.shapes as Record<string, number>;
    expect(shapes.calls, 'the cleanup call vanished — this test would pass vacuously').toBe(1);
    expect(shapes.generator_args, 'a generator argument re-opens CEVE-18232').toBe(0);
    expect(shapes.materialised_args).toBe(1);
  });

  it('contains an epilogue failure ONLY behind proof that this session completed a turn', () => {
    const payload = runProbe();
    expect(payload.missing_definitions, 'epilogue isolation is not in the emitted shim').toEqual([]);
    expect(payload.marked).toContain('acp_epilogue_isolation');
    expect(payload.marked).toContain('acp_internal_error_context');
    // The exact production sequence: answer delivered, then the epilogue blows up.
    expect(payload.contained_after_completion, 'an answered turn must not become a red card').toEqual({
      raised: null,
      stop_reason: 'end_turn',
    });
    // …and a healthy turn is untouched.
    expect(payload.healthy_turn).toEqual({ raised: null, stop_reason: 'end_turn' });
  });

  it('is a boundary, not a swallow — every other failure class still propagates', () => {
    const payload = runProbe();
    // No completion proof: every pre-turn and in-turn failure reports as before.
    expect(payload.propagates_without_completion, 'a failure without completion proof must still surface').toEqual({
      raised: 'RuntimeError',
      stop_reason: null,
    });
    // A RequestError is a deliberate authority answer (permission, session guard).
    expect(payload.propagates_request_error, 'an authority decision must never be contained').toEqual({
      raised: 'RequestError',
      stop_reason: null,
    });
    // BaseException is not Exception: cancellation keeps working untouched.
    expect(payload.propagates_cancellation, 'cancellation must not be contained').toEqual({
      raised: 'CancelledError',
      stop_reason: null,
    });
    // Concurrent sessions share this module, so one session's completed turn may
    // never vouch for another's.
    expect(payload.propagates_other_session, "another session's completion must not vouch for this one").toEqual({
      raised: 'RuntimeError',
      stop_reason: null,
    });
  });

  it('prints the cause that acp destroys with `raise ... from None`', () => {
    const payload = runProbe();
    // This is why the hunt was expensive: the printed traceback ends at
    // connection.py and names no origin at all.
    expect(payload.diagnostic_names_the_cause, 'the original error text must reach stderr').toBe(true);
    expect(payload.diagnostic_labels_itself, 'the output must say what it is').toBe(true);
    expect(payload.diagnostic_ignores_unrelated, 'the handler must stay silent for every other error').toBe(true);
  });
});
