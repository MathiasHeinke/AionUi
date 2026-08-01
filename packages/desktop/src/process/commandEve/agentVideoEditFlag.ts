/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the one place that answers "may this seat spend on a video edit?".
 *
 * It lives in its own module for a boring reason with an expensive history: the
 * first build put this check in the MCP loopback only, so the renderer IPC lane
 * — the same paid handler, registered a few lines away — had no gate at all. A
 * lane without the check is the whole vulnerability, so the check has to sit
 * somewhere BOTH lanes can import without an import cycle, and the paid handler
 * itself has to be the thing that asks.
 *
 * Default OFF, and it stays off for 1.820.1. It may only be turned on after a
 * packaged, signed-resource first run proves the MCP server actually lands in
 * the emitted Hermes config AND a bounded no-paid dry path works — neither of
 * which a unit test can establish.
 */

/** Env flag that makes the SPENDING operation reachable. Default: off. */
export const COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG = 'COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT';

/**
 * Exactly `'1'`. Not "truthy", not `'true'`, not `'yes'`.
 *
 * A spending flag that accepts several spellings is a spending flag that gets
 * turned on by accident — by a stray `=true` in a shell profile, or by a value
 * someone assumed was ignored.
 */
export function isAgentVideoEditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] || '').trim() === '1';
}
