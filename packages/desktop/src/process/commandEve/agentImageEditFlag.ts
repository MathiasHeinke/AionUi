/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the one place that answers "may this seat spend on an IMAGE edit?".
 *
 * Verbatim the doctrine of `agentVideoEditFlag.ts`, and it lives in its own
 * module for the same reason: the decision must sit somewhere BOTH lanes — the
 * Hermes MCP loopback and the paid handler itself — can import without an
 * import cycle, and the paid handler must be the thing that asks.
 *
 * Same posture as video post-1.820.2: an ELIGIBLE seat (CEVE licence wire
 * present and readable) advertises BY DEFAULT, exactly `'0'` in
 * `COMMAND_EVE_ENABLE_AGENT_IMAGE_EDIT` is the emergency kill-switch, `'1'` is
 * a no-op that must not bypass eligibility, and an absent or unreadable wire
 * fails closed. The server-side gates (licence verify, entitlement,
 * debit-before-provider, idempotency) re-verify everything per request; this
 * flips ADVERTISEMENT and permit minting only.
 */

import { readLicenseWire } from '@/common/config/licenseWireAtRest';

/** Env flag carrying the kill-switch (and, to the MCP child, Main's decision). */
export const COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG = 'COMMAND_EVE_ENABLE_AGENT_IMAGE_EDIT';

/**
 * Exactly `'1'`. Not "truthy", not `'true'`, not `'yes'` — a spending flag that
 * accepts several spellings gets turned on by accident.
 *
 * WHO READS THIS: the MCP CHILD, and only the child. Main resolves eligibility
 * itself (see {@link resolveAgentImageEditAdvertisement}) and emits exactly
 * `'1'` into the child environment when — and only when — the seat may be told
 * about the paid tool.
 */
export function isAgentImageEditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG] || '').trim() === '1';
}

export interface AgentImageEditAdvertisementInput {
  env: NodeJS.ProcessEnv;
  /** True iff the seat's CEVE licence wire is present AND readable. */
  licenseWirePresent: boolean;
}

/**
 * THE advertisement decision, pure and in one place. Kill-switch first:
 * exactly `'0'` (trimmed) closes even an eligible seat; otherwise the seat
 * advertises iff the licence wire is present and readable.
 */
export function resolveAgentImageEditAdvertisement(input: AgentImageEditAdvertisementInput): boolean {
  if ((input.env[COMMAND_EVE_AGENT_IMAGE_EDIT_FLAG] || '').trim() === '0') return false;
  return input.licenseWirePresent === true;
}

/**
 * The production half: reads the licence wire at rest through the REAL
 * `readLicenseWire` and folds it into the resolver above. Every Main-side
 * consumer — the context envelope, the shared paid handler, the loopback and
 * the MCP-child env emission — asks HERE, so the surfaces cannot drift apart.
 */
export function isAgentImageEditAdvertisingEnabled(dataPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const wire = readLicenseWire(dataPath);
  return resolveAgentImageEditAdvertisement({
    env,
    licenseWirePresent: wire.ok === true && typeof wire.wire === 'string' && wire.wire.length > 0,
  });
}
