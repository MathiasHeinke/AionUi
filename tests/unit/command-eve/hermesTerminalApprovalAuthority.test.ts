/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * G5 (CEVE-18205) — terminal-approval authority is the SHIM, not the wheel.
 *
 * The 0.20 wheel ships its own `_sync_terminal_approval_mode`
 * (acp_adapter/server.py) that is MODE-DEPENDENT: in the dont_ask mode it
 * calls `enable_session_yolo` and switches the session-wide command bypass
 * ON. The Command EVE permission-authority patch replaces that method after
 * import, and the replacement only ever DISABLES the bypass — for every mode,
 * with no branch. Production therefore runs the stricter shim variant and the
 * wheel variant is dead code; anyone reading the wheel alone would believe
 * dont_ask enables the bypass.
 *
 * This suite is the CONTRACT for that authority, read from the REAL installer
 * source (never a copy). It reddens when:
 *   - the shim assignment is removed (the wheel variant would come alive), or
 *   - the replacement grows a way to reach `enable_session_yolo` or a mode
 *     branch (the wheel's semantics smuggled back into the shim).
 *
 * It complements the existing pinned grep (runtimeBootstrapCore.test.ts,
 * provider override must not contain enable_session_yolo): that one guards
 * the EMITTED shim text, this one guards the installer's structure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_PATH = path.resolve(
  process.cwd(),
  'packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts'
);
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

/** The installer block, from its def to the next top-level installer def. */
function installerBlock(): string {
  const start = source.indexOf("'def _install_command_eve_permission_authority_patch() -> None:'");
  expect(start, 'the permission-authority installer moved — re-anchor this contract').toBeGreaterThan(-1);
  const end = source.indexOf("'def _install_command_eve", start + 10);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe('G5 — the shim owns terminal approval', () => {
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
    // The wheel variant is mode-dependent; the shim variant must not be. A
    // mode read or dont_ask comparison here is the wheel semantics returning.
    expect(body, 'a mode branch crept into the shim variant').not.toMatch(/MODE_DONT_ASK|dont_ask|getattr\(state, "mode"/);
  });

  it('the whole emitted-shim source never names the bypass-enabling function', () => {
    // Belt to the existing braces: not the installer, not a comment, nowhere.
    // (The emitted-shim grep in runtimeBootstrapCore.test.ts checks the built
    // provider override; this checks the source that builds it.)
    expect(source).not.toContain('enable' + '_session_yolo');
  });

  it('the authority is STATED at the installer, not in a side file', () => {
    // The comment contract: whoever reads the installer learns that the wheel
    // variant is dead and why. Pin the load-bearing phrases, not the prose.
    const block = source.slice(
      source.indexOf('# TERMINAL-APPROVAL AUTHORITY LIVES HERE'),
      source.indexOf("'def _install_command_eve_permission_authority_patch()")
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('DEAD CODE');
    expect(block).toContain('whl:acp_adapter/server.py::_sync_terminal_approval_mode');
  });
});
