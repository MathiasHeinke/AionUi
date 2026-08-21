/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * G5 (CEVE-18205) → CEVE-1821 — terminal-approval authority is the SHIM, and
 * since 1.821.0 the shim ASKS THE SEAT'S GRANT instead of always answering "ask".
 *
 * WHAT THIS SUITE USED TO PIN, AND WHY IT WAS REWRITTEN RATHER THAN DELETED.
 *
 * Earlier 0.20 wheel bytes shipped a MODE-DEPENDENT synchronizer that switched
 * the SESSION-WIDE command bypass on in dont_ask mode. V22 removes that wheel
 * path; Command EVE still installs its own replacement that only ever DISABLES
 * the bypass. That explicit binding remains load-bearing — and the reason the
 * ladder stopped working: the replacement also returned a hardcoded "ask" for
 * edits, so rung 2 accepted no edits and rung 3 still asked. We had chosen
 * between the wheel's all and our own nothing, and taken nothing.
 *
 * The way out was never to flip the blunt wheel switch. It is to connect the
 * finer machinery we already had. So the contract CHANGED SHAPE, and the change
 * is the point of this file:
 *
 *   BEFORE — the replacement must be unconditional ("ask", for every mode).
 *   AFTER  — the replacement must have NO path to the session-wide bypass (that
 *            part is unchanged and load-bearing), AND the class it grants must
 *            come from the seat's grant rather than from a constant.
 *
 * Both halves are asserted below, plus a SABOTAGE test: a bypass line inserted
 * into the installer has to redden this suite, or the first half is decoration.
 *
 * Read from the REAL installer source, never a copy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = path.resolve(process.cwd(), 'packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

describe('the bundled Hermes 0.20 ACP callback reaches the native approval gate', () => {
  it('maps ACP once/session/always and fails closed on timeout or missing human', () => {
    const harness = spawnSync(
      'python3',
      [
        path.resolve('tests/fixtures/command-eve/hermes_native_approval_contract_harness.py'),
        path.resolve('resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl'),
      ],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    );

    expect(harness.status, harness.stderr || harness.stdout).toBe(0);
    expect(JSON.parse(harness.stdout)).toEqual({
      exact_wheel_function_executed: true,
      exact_wheel_acp_callback_executed: true,
      exact_wheel_async_bridge_executed: true,
      exact_wheel_server_wiring_observed: true,
      acp_request_call_shape_exact: true,
      always_persists_exact_plugin_rule_key: true,
      same_key_skips_human: true,
      changed_key_asks_again: true,
      once_does_not_persist: true,
      session_persists_only_in_session: true,
      timeout_fails_closed: true,
      missing_acp_loop_fails_closed: true,
      missing_human_fails_closed: true,
      callback_option_scope_respected: true,
    });
  });
});

/** The installer block, from its def to the next top-level installer def. */
function installerBlock(): string {
  const start = source.indexOf("'def _install_command_eve_permission_authority_patch() -> None:'");
  expect(start, 'the permission-authority installer moved — re-anchor this contract').toBeGreaterThan(-1);
  const end = source.indexOf("'def _install_command_eve", start + 10);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe('the shim owns terminal approval — and never reaches the session-wide bypass', () => {
  it('the installer REPLACES the wheel method (removing this assignment revives the wheel bypass path)', () => {
    expect(installerBlock()).toContain(
      'HermesACPAgent._sync_terminal_approval_mode = command_eve_sync_terminal_approval_mode'
    );
  });

  it('the replacement can only ever DISABLE the bypass: no enable call, no mode branch', () => {
    const block = installerBlock();
    const defAt = block.indexOf('def command_eve_sync_terminal_approval_mode');
    expect(defAt, 'the replacement function is gone').toBeGreaterThan(-1);
    const assignAt = block.indexOf('HermesACPAgent._sync_terminal_approval_mode =');
    const body = block.slice(defAt, assignAt);
    // The one thing the replacement may do with the bypass: turn it off.
    expect(body).toContain('disable_session_yolo');
    expect(body, 'the replacement reaches the bypass-enabling call').not.toContain('enable_session_yolo');
    // The wheel variant is mode-dependent; the shim variant must not be. A mode
    // read or dont_ask comparison here is the wheel semantics returning — and
    // note that rung 3 does NOT re-open this door: it is granted one operation
    // at a time by the approval-class patch instead.
    expect(body, 'a mode branch crept into the shim variant').not.toMatch(
      /MODE_DONT_ASK|dont_ask|getattr\(state, "mode"/
    );
  });

  it('the whole emitted-shim source never names the bypass-enabling function', () => {
    expect(source).not.toContain('enable' + '_session_yolo');
  });

  it('the authority is STATED at the installer, not in a side file', () => {
    const block = source.slice(
      source.indexOf('# TERMINAL-APPROVAL AUTHORITY LIVES HERE'),
      source.indexOf("'def _install_command_eve_permission_authority_patch()")
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('V22 no longer ships the old mode-dependent ACP synchronizer');
    expect(block).toContain('one explicit source of truth');
  });
});

describe("THE REWRITTEN HALF — the seat's grant decides the class, not a constant", () => {
  it('the edit policy is ASKED, never hardcoded', () => {
    const block = installerBlock();
    const defAt = block.indexOf('def command_eve_edit_approval_policy');
    expect(defAt, 'the edit-policy replacement is gone').toBeGreaterThan(-1);
    const body = block.slice(defAt, block.indexOf('def command_eve_sync_terminal_approval_mode'));
    // The old contract: `return "ask", ...` for every mode and every rung. That
    // is precisely what made rung 2 and rung 3 inert.
    expect(body, 'the edit policy is a constant again — rungs 2+ would go inert').not.toMatch(/return\s+"ask"/);
    expect(body, 'the edit policy no longer comes from the grant').toContain('_command_eve_ask_authority');
    expect(body).toContain('"edit_policy"');
  });

  it('the authority answer is obeyed, not recomputed: no rung arithmetic on this side', () => {
    // Two copies of a ladder drift, and drift here is silent in the permissive
    // direction. The Python may compare the ANSWER to "allow"/"ask" and nothing
    // else — no rung numbers, no thresholds.
    const client = source.slice(
      source.indexOf("'def _command_eve_ask_authority(command: str, inside: bool) -> dict:'"),
      source.indexOf("'def _install_command_eve_permission_authority_patch() -> None:'")
    );
    expect(client.length).toBeGreaterThan(0);
    // `ladder` may be CARRIED (it is useful in a log line); it may never be
    // COMPARED. A comparison is the moment a second ladder is born.
    expect(client, 'the Python side started comparing the rung itself').not.toMatch(/ladder\s*[<>]=?|ladder\s*==/);
    // And no other numeric threshold may govern the outcome: the only values
    // this side is allowed to branch on are the literal strings below.
    const branchSubjects = [...client.matchAll(/if\s+([a-z_]+)\s+not in \{/g)].map((m) => m[1]);
    expect(branchSubjects.toSorted()).toEqual(['decision', 'decision', 'edit_policy']);
  });

  it('every unclear answer fails CLOSED to ask', () => {
    const client = source.slice(
      source.indexOf("'_COMMAND_EVE_APPROVAL_CLOSED = "),
      source.indexOf("'def _install_command_eve_approval_class_patch() -> None:'")
    );
    expect(client).toContain('_COMMAND_EVE_APPROVAL_CLOSED = {"decision": "ask", "edit_policy": "ask", "ladder": 0}');
    // A non-loopback base, a throw, and an unrecognised value each land there.
    expect(client).toContain('if not _command_eve_is_local_shim_base(base)');
    expect(client).toContain('return dict(_COMMAND_EVE_APPROVAL_CLOSED)');
    expect(client).toContain('if decision not in {"allow", "ask"}');
  });

  it('an allowed command is granted ONE operation — never session, never always', () => {
    const patch = source.slice(
      source.indexOf("'def _install_command_eve_approval_class_patch() -> None:'"),
      source.indexOf("'def _install_command_eve_permission_authority_patch() -> None:'")
    );
    expect(patch.length).toBeGreaterThan(0);
    // "once" is per operation. "session"/"always" outlive the decision that
    // produced them — that property is what made the wheel's bypass unusable,
    // and re-introducing it here would recreate it by another name.
    expect(patch).toContain('return "once"');
    expect(patch, 'a session-scoped answer crept into the approval patch').not.toMatch(/return\s+"(session|always)"/);
    // Anything not allowed falls through to the human's card.
    expect(patch).toContain('return inner(command, description, **cb)');
  });

  it('rebinds the factory Hermes server.py actually captured and fails closed on drift', () => {
    const patch = source.slice(
      source.indexOf("'def _install_command_eve_approval_class_patch() -> None:'"),
      source.indexOf("'def _install_command_eve_permission_authority_patch() -> None:'")
    );
    expect(patch).toContain('from acp_adapter import server as acp_server');
    expect(patch).toContain('acp_server.make_approval_callback = command_eve_make_approval_callback');
    expect(patch).toContain('acp_server.make_approval_callback is not acp_permissions.make_approval_callback');
    expect(patch).toContain('from tools import approval as hermes_approval');
    expect(patch).toContain('platform == "acp" and bool(hermes_approval._is_interactive_cli())');
    expect(patch).toContain('_command_eve_acp_interactive_patch');

    const stateGate = source.slice(
      source.indexOf("'def _command_eve_permission_authority_patch_state() -> tuple[bool, str]:'"),
      source.indexOf("'def _require_command_eve_permission_authority_patch() -> None:'")
    );
    expect(stateGate).toContain('server approval factory not bound to seat authority');
    expect(stateGate).toContain('_ce_approval_factory is not getattr(_ce_permissions, "make_approval_callback", None)');
    expect(stateGate).toContain('ACP approval routing not bound to interactive callback');
  });

  it('the session folder is recorded where the ACP layer actually hands it over', () => {
    // Without a cwd every command counts as OUTSIDE the workspace, which needs
    // rung 4/5 — the strict direction. Pin that the ledger is written in the one
    // place a SessionState is available.
    const block = installerBlock();
    expect(block).toContain('_COMMAND_EVE_SESSION_CWD[str(getattr(state, "session_id", "") or "")]');
    const inside = source.slice(
      source.indexOf("'def _command_eve_command_inside_workspace(command: str, cwd: str) -> bool:'"),
      source.indexOf("'def _install_command_eve_approval_class_patch() -> None:'")
    );
    expect(inside).toContain('if not cwd:');
    expect(inside).toContain('return False');
    expect(inside, 'a home-relative path must never count as inside').toContain('if "~" in text:');
  });
});

describe('SABOTAGE — the guard above is not decoration', () => {
  /**
   * The point of a contract test is that it fails when the contract breaks.
   * These re-run the structural assertion against a DELIBERATELY BROKEN copy of
   * the installer body, so a reader can see the real assertion has teeth instead
   * of taking it on trust.
   */
  const assertBypassFree = (text: string): void => {
    const defAt = text.indexOf('def command_eve_sync_terminal_approval_mode');
    const assignAt = text.indexOf('HermesACPAgent._sync_terminal_approval_mode =');
    const body = text.slice(defAt, assignAt);
    expect(body).not.toContain('enable' + '_session_yolo');
    expect(body).not.toMatch(/MODE_DONT_ASK|dont_ask/);
  };

  /** Splice a line into the replacement's body, right after its `def`. */
  const injectIntoReplacement = (line: string): string => {
    const block = installerBlock();
    const marker = 'def command_eve_sync_terminal_approval_mode';
    const at = block.indexOf(marker);
    expect(at, 'the replacement moved — re-anchor the sabotage').toBeGreaterThan(-1);
    const cut = block.indexOf('\n', at) + 1;
    return `${block.slice(0, cut)}    '        ${line}',\n${block.slice(cut)}`;
  };

  it('the REAL installer passes the check', () => {
    expect(() => assertBypassFree(installerBlock())).not.toThrow();
  });

  it('a bypass-enabling line inserted into the replacement REDDENS it', () => {
    const sabotaged = injectIntoReplacement('enable' + '_session_yolo(session_id)');
    expect(sabotaged).not.toEqual(installerBlock());
    expect(() => assertBypassFree(sabotaged)).toThrow();
  });

  it('a mode branch inserted into the replacement REDDENS it', () => {
    const sabotaged = injectIntoReplacement('if mode == self._MODE_DONT_ASK:');
    expect(sabotaged).not.toEqual(installerBlock());
    expect(() => assertBypassFree(sabotaged)).toThrow();
  });
});
