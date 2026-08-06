/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readLicenseWire } from '@/common/config/licenseWireAtRest';

/**
 * CEVE-18205 — the one place that answers "may this seat spend on an
 * agent-initiated video GENERATE?".
 *
 * Its own module, for the reason `agentVideoEditFlag.ts` learned expensively:
 * the first build of the edit gate lived in the MCP loopback only, so the
 * renderer IPC lane — the same paid handler, registered a few lines away — had
 * no gate at all. A gate that lives in one lane's wrapper is not a gate. This
 * one therefore sits where every consumer can import it without a cycle.
 *
 * WHY THIS ONE IS DEFAULT-OFF WHILE `eve_video_edit` IS DEFAULT-ON.
 *
 * This is the important asymmetry in this file, and it is not caution for its
 * own sake — it is a verified structural gap:
 *
 *   `commandEveVideoBridge.ts` states it plainly, in the mint's own comment:
 *   "the path that consumes reference images — `handleCommandEveVideoGenerate`
 *   — takes no permit and redeems none."
 *
 * The EDIT lane is protected by a single-use, turn-bound spend permit: minted in
 * exactly one place (`handleCommandEveArtifactContextEnvelope`), only for a real
 * user turn, retired when the user says something else. That is what makes an
 * agent-callable paid edit safe — the model can hold the tool, but it cannot
 * spend without a credential only a human send produces.
 *
 * GENERATE HAS NO SUCH BINDING. The mint only ever issues `video_edit` and
 * `image_edit` permits; an unrecognised operation mints nothing. So a
 * `video_generate` tool handed to a model is, today, an unbounded
 * agent-initiated spend: N calls, N debits, no per-turn ceiling on this side.
 * The server still re-verifies licence, entitlement, debit-before-provider,
 * idempotency and the tenant cap on every request — but those bound the BLAST,
 * not the INTENT.
 *
 * Default-off is therefore the honest posture, and `'1'` is a deliberate,
 * per-seat decision to accept that gap. It must NOT be flipped default-on by
 * analogy with the edit flag until generate has a turn-bound permit of its own.
 * That work is named and not done; this comment is the marker.
 *
 * ELIGIBILITY IS NOT BYPASSABLE. `'1'` is necessary, never sufficient: a seat
 * whose CEVE licence wire is absent or unreadable stays closed whatever the env
 * says, exactly as every other credential read on this path fails closed.
 * Advertising a paid capability on an unauthenticated seat is forbidden.
 */

/** Env flag carrying the opt-in (and, to the MCP child, Main's decision). */
export const COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG = 'COMMAND_EVE_ENABLE_AGENT_VIDEO_GENERATE';

/**
 * Exactly `'1'`. Not "truthy", not `'true'`, not `'yes'`.
 *
 * A spending flag that accepts several spellings is a spending flag that gets
 * turned on by accident — by a stray `=true` in a shell profile, or by a value
 * someone assumed was ignored. Same exact-match rule as the edit flag, for the
 * same reason.
 *
 * WHO READS THIS: the MCP CHILD, and only the child. Main resolves eligibility
 * itself ({@link resolveAgentVideoGenerateAdvertisement}) and emits exactly
 * `'1'` into the child environment when — and only when — the seat may be told
 * about the paid tool, so for the child this exact-`'1'` read IS the whole
 * decision.
 */
export function isAgentVideoGenerateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG] || '').trim() === '1';
}

export interface AgentVideoGenerateAdvertisementInput {
  env: NodeJS.ProcessEnv;
  /** True iff the seat's CEVE licence wire is present AND readable. */
  licenseWirePresent: boolean;
}

/**
 * THE advertisement decision, pure and in one place.
 *
 * BOTH conditions, in this order and with no third path: the seat opted in with
 * exactly `'1'`, AND it is eligible. Unlike the edit resolver there is no
 * kill-switch value, because there is nothing to kill — absent, empty, `'0'`,
 * `'true'` and every other spelling already mean off.
 */
export function resolveAgentVideoGenerateAdvertisement(input: AgentVideoGenerateAdvertisementInput): boolean {
  if ((input.env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG] || '').trim() !== '1') return false;
  return input.licenseWirePresent === true;
}

/**
 * The production half of the decision: reads the licence wire at rest through
 * the REAL `readLicenseWire` (keychain ref, decrypt, well-formedness check —
 * any failure is `ok: false` and therefore ineligible) and folds it into the
 * resolver above. Every Main-side consumer — the loopback and the MCP-child env
 * emission — asks HERE, so the surfaces cannot drift apart about what this seat
 * offers.
 */
export function isAgentVideoGenerateAdvertisingEnabled(
  dataPath: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const wire = readLicenseWire(dataPath);
  return resolveAgentVideoGenerateAdvertisement({
    env,
    licenseWirePresent: wire.ok === true && typeof wire.wire === 'string' && wire.wire.length > 0,
  });
}

// ---------------------------------------------------------------------------
// The PINNED request shape for the agent lane
// ---------------------------------------------------------------------------
//
// The agent names a PROMPT and nothing else. Tier, model, duration and
// resolution are pinned here, on this side, deliberately:
//
//   - the catalog, its prices and its per-model resolution/duration lists live
//     server-side as a dated frozen snapshot. A model that could name a tier
//     would be quoting from knowledge it does not have and cannot refresh;
//   - the renderer lane's picker exists precisely so a HUMAN chooses the
//     expensive axes after seeing the price. An agent parameter would be a
//     second, cheaper way to reach the same spend with none of that context;
//   - the smallest surface is the one that can widen later without a migration.
//     Adding parameters is additive; removing them is not.
//
// `fast` is the shared default tier (`DEFAULT_VIDEO_TIER_ID` in
// `videoCostCore.ts`), so the agent lane and the picker's default land on the
// same plan rather than two defaults that can drift.

/** The tier the agent lane always requests. Mirrors `DEFAULT_VIDEO_TIER_ID`. */
export const AGENT_VIDEO_GENERATE_TIER_ID = 'fast' as const;

/** Seconds. The short end of the supported range — the cheapest useful clip. */
export const AGENT_VIDEO_GENERATE_DURATION_SECONDS = 5;
