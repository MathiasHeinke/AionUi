/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CURATED-CONNECTOR REFERENCE (S5 phase 2, arch §4/§9) — the sandbox-owned SSOT
 * for the `mcp_invocation` VALUES the external Company.OS connector manifest
 * should carry for each curated stdio connector.
 *
 * WHY here and not in the manifest: the connector manifest is DATA that lives in
 * Company.OS (`kits/company-os-kit/.company-os/eve/connector-manifests.json`,
 * resolved at runtime via COMMAND_EVE_COMPANY_OS_ROOT) — outside this sandbox's
 * write scope. This module is the code-side reference the guided-auth modal + the
 * feeder tests pin against, so the CONSUMPTION path is proven against the exact
 * package + env-var names, and there is ONE authoritative place documenting what
 * the manifest entry must say when a maintainer wires it.
 *
 * NOTION FIRST (arch correction §9, 2026-07-02): `@notionhq/notion-mcp-server` is
 * the official, maintained stdio package (env `NOTION_TOKEN`, HIGH confidence) —
 * the reference LIVE connector. Linear + Slack are DELIBERATELY NOT wired as live
 * examples here:
 *   - Linear has NO canonical stdio + API-key package (official MCP is
 *     remote/OAuth via mcp-remote; `mcp-linear` is community with divergent env
 *     names) → an INTEGRATOR DECISION before live.
 *   - Slack's reference impl is ARCHIVED (`@modelcontextprotocol/server-slack` →
 *     servers-archived; also needs SLACK_TEAM_ID) → pick a maintained fork or
 *     defer.
 * Their manifest entries stay in the catalog (they parse as connectors) but carry
 * no live `mcp_invocation` until that decision is made.
 *
 * NONE of this flips any posture: the whole vault feeder is behind
 * COMMAND_EVE_MCP_VAULT_ENABLED, which is a kill switch since 1.821.0 rather
 * than an opt-in; this is reference data only.
 */

import type { CommandEveConnectorMcpInvocation } from './connectorCatalogCore';

/** The curated connector ids this reference knows about. */
export const NOTION_CONNECTOR_ID = 'notion-workspace';

/**
 * The reference Notion stdio invocation (arch §9). `@notionhq/notion-mcp-server`
 * reads `NOTION_TOKEN` from the environment. stdio-only (http/sse are
 * structurally unrepresentable). Default scope is founder (invisible delivery: the
 * operator connects THEIR Notion, serving all clients) — the operator may override
 * to 'seat' at setup for a client-supplied Notion.
 */
export const NOTION_MCP_INVOCATION_REFERENCE: CommandEveConnectorMcpInvocation = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@notionhq/notion-mcp-server'],
  env_refs: ['NOTION_TOKEN'],
  scope_default: 'founder',
};

/**
 * Reference invocation lookup by connector id. Returns the sandbox-owned reference
 * `mcp_invocation` for a curated connector, or `undefined` for connectors that are
 * not yet wired (Linear/Slack — integrator decisions). Used as a FALLBACK by the
 * guided-auth modal when the external manifest has not (yet) been given the
 * invocation, so the reference LIVE connector (Notion) can be set up from the
 * sandbox alone. The feeder itself reads the manifest (authoritative); this only
 * backstops the setup UI for the reference connector.
 */
export function referenceMcpInvocationFor(connectorId: string): CommandEveConnectorMcpInvocation | undefined {
  if (connectorId === NOTION_CONNECTOR_ID) return NOTION_MCP_INVOCATION_REFERENCE;
  return undefined;
}
