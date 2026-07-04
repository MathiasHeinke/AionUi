/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO MCP SERVER core (1.7.0 / COMPA-624 Inc.3 / P4 — the PURE
 * per-seat mcp_servers entry builder).
 *
 * When Honcho is genuinely READY for the active seat, EVE should be able to read +
 * curate the per-seat user model through Honcho's MCP tools. This maps the Inc.1
 * per-seat config to ONE stdio {@link CommandEveHermesMcpServer} entry the config-
 * yaml renderer concatenates onto the vetted servers.
 *
 * TWO INVARIANTS:
 *  - NO FALSE READINESS: returns `undefined` unless `ready === true` AND the config
 *    carries a per-seat dbUri + workspaceId + honchoHome — so a not-yet-running
 *    Honcho never advertises a tool that would fail.
 *  - PER-SEAT ISOLATION: the env carries the seat's OWN dbUri (a passwordless
 *    loopback peer-auth URI — no secret) + opaque workspaceId + honchoHome, so two
 *    seats get DISJOINT Honcho MCP servers. PURE: no fs/net/spawn.
 */

import type { CommandEveHermesMcpServer } from './runtimeBootstrapCore';
import type { HonchoRuntimeConfig } from './honchoRuntimeConfigCore';

/** The stable mcp_servers id for the per-seat Honcho memory server. */
export const HONCHO_MCP_SERVER_ID = 'honcho';

/** The resolved launcher invocation (from the seat's Honcho venv) — injected by O2. */
export interface HonchoMcpLauncher {
  command?: string;
  args?: string[];
}

/**
 * Build the per-seat Honcho mcp_servers entry, or `undefined` when it must not be
 * advertised. Fail-safe: any of {not ready, missing config fields, no launcher
 * command} ⇒ undefined (EVE simply has no honcho tool that turn).
 */
export function honchoMcpServerForSeat(
  cfg: HonchoRuntimeConfig | undefined,
  ready: boolean,
  launcher?: HonchoMcpLauncher
): CommandEveHermesMcpServer | undefined {
  if (ready !== true) return undefined;
  if (!cfg || !cfg.dbUri || !cfg.workspaceId || !cfg.honchoHome) return undefined;
  const command = launcher && typeof launcher.command === 'string' ? launcher.command.trim() : '';
  if (command.length === 0) return undefined;
  return {
    id: HONCHO_MCP_SERVER_ID,
    command,
    args: (launcher && launcher.args) || [],
    env: {
      // Per-seat scoping. dbUri is a passwordless loopback URI (peer/socket auth),
      // workspaceId is opaque (never the label — H3). No secret leaves here.
      HONCHO_DB_URI: cfg.dbUri,
      HONCHO_WORKSPACE_ID: cfg.workspaceId,
      HONCHO_HOME: cfg.honchoHome,
    },
  };
}
