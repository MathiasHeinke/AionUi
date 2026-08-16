/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY } from '@/common/config/agentVideoGenerateReleaseCore';

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
 * Default-off is therefore the honest posture. In 1.823.0 the shared
 * `AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY` release fence also keeps the MCP
 * child unadvertised even if an older per-Seat setting or a manually supplied
 * carrier says true. It must NOT be flipped until a confirmed turn can mint and
 * activate a single-use generate permit; the explicit composer lane is separate.
 *
 * THE SECOND OPEN MONEY ITEM: THERE IS NO DAILY COUNTER. Named here for the same
 * reason as the permit above — so it stays a tracked gap instead of becoming a
 * parked promise. The settings panel offers a daily amount; nothing in this
 * codebase counts anything against it.
 *
 * What does not exist today. `spentTodayCents` occurs exactly twice in the whole
 * tree: a type declaration (`eveAuthorityCore.ts:126`) and one read (`:206`).
 * Nothing writes it, no store holds it, nothing rolls it over at a day boundary.
 * `spend_daily_cents` (`eveAuthorityRuntimeCore.ts:66`, assigned `:104`) has no
 * production consumer at all, and the number never even crosses to EVE — the
 * approval endpoint answers with `{decision, edit_policy, ladder}` and nothing
 * else (`ollamaOpenAiShim.ts:2667-2671`). The single probe that does run passes
 * a hardcoded `amountCents: 0` (`eveAuthorityRuntimeCore.ts:84`), which asks "is
 * a ceiling configured at all", not "does this purchase fit under it".
 *
 * What enforcement actually requires, so nobody costs it as incidental:
 *
 *   - Durable PER-SEAT daily state, with a day boundary and crash safety. A
 *     counter that lives in memory is not a ceiling, it is a hint that resets.
 *   - Replay awareness. `artifactCapabilityLoopback.ts:235` carries a `replayed`
 *     flag precisely because this path can be redelivered idempotently; a naive
 *     counter debits the same clip twice.
 *   - BOTH lanes, not one. The agent lane calls through
 *     `artifactCapabilityLoopback.ts:322`; the renderer lane arrives via
 *     `commandEveBridge.ts:2310` and `handleCommandEveVideoGenerateBridge`.
 *     They do converge on `handleCommandEveVideoGenerate`
 *     (`commandEveVideoBridge.ts:260`), which is the natural choke point for the
 *     DEBIT — but not for the DECISION: agent-initiated and user-initiated spend
 *     are different authority questions, so the check cannot simply be dropped
 *     at the join and called done.
 *   - `decideAuthority` invoked with a real `amountCents` and a real
 *     `spentTodayCents` in place of the zero probe. Neither video lane consults
 *     the authority layer at all today.
 *
 * Why it is not simply built fail-closed first. A counter that is broken or
 * unavailable would then refuse every generate, and generate is a paid feature.
 * A single point of failure in front of a paid path is not worth shipping before
 * the store behind it is real. Fail-closed is the right end state; it is not the
 * right first step.
 *
 * What the user is told MEANWHILE, so the gap is disclosed rather than hidden:
 * the authority panel carries `commandEve.authority.budgetNotEnforced`, which
 * says the amount opens the seal and is not counted against actual spending.
 * That string and this block describe the same gap and have to move together.
 *
 * WHAT CHANGED IN CEVE-18205-FLAG. The first slice made the release an ENV var,
 * which is not a per-seat release at all: an env var is a property of the
 * PROCESS, so every seat an operator runs out of one install got the same answer.
 * For a switch that spends a CLIENT's credits, "the founder turned it on once"
 * must never mean "every client seat can spend". The release therefore moved to a
 * per-seat config value read fresh from the backend settings store — see
 * `agentVideoGenerateSeatResolver.ts` for the value and its fail-closed
 * direction, and `agentVideoGenerateGateMain.ts` for the composed production
 * gate. This module keeps the two decisions that need neither seat context nor a
 * network round trip: the global kill-switch and licence eligibility.
 *
 * ELIGIBILITY IS NOT BYPASSABLE. A seat whose CEVE licence wire is absent or
 * unreadable stays closed whatever its config says, exactly as every other
 * credential read on this path fails closed. Advertising a paid capability on an
 * unauthenticated seat is forbidden.
 */

/** Env flag carrying the kill-switch (and, to the MCP child, Main's decision). */
export const COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG = 'COMMAND_EVE_ENABLE_AGENT_VIDEO_GENERATE';

/**
 * Exactly `'1'`, AND only after the shared turn-authority readiness fence opens.
 * Not "truthy", not `'true'`, not `'yes'`.
 *
 * A spending flag that accepts several spellings is a spending flag that gets
 * turned on by accident — by a stray `=true` in a shell profile, or by a value
 * someone assumed was ignored. Same exact-match rule as the edit flag, for the
 * same reason.
 *
 * WHO READS THIS: the MCP CHILD, and only the child. Main composes the real
 * decision itself (kill-switch + licence + per-seat config, see
 * `agentVideoGenerateGateMain.ts`) and emits exactly `'1'` into the child
 * environment when — and only when — the seat may be told about the paid tool.
 * The child then applies the shared readiness fence as a final fail-closed
 * product boundary. It never reads the config store: it has no seat context and
 * no business holding one.
 */
export function isAgentVideoGenerateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY && (env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG] || '').trim() === '1';
}

/**
 * The GLOBAL kill-switch: exactly `'0'` (trimmed).
 *
 * CEVE-18205-FLAG moved the RELEASE decision to a per-seat config value
 * (`agentVideoGenerateSeatResolver.ts`), and this env var kept only the half it
 * was actually good at. An env var is a property of the PROCESS, so it can never
 * express "this client seat may spend and that one may not" — but it is exactly
 * the right shape for "close this everywhere, now", which needs no seat context
 * and no backend round trip.
 *
 * The direction is therefore one-way and deliberate: the env can TAKE the release
 * away, never grant it. `'1'` is not required and grants nothing — requiring it
 * would mean an operator who ticks the box in the UI gets silence, which is the
 * silently-dead-control failure this whole store-split lineage exists to prevent.
 */
export function isAgentVideoGenerateKillSwitched(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG] || '').trim() === '0';
}

/**
 * Is this seat entitled at all?
 *
 * Reads the licence wire at rest through the REAL `readLicenseWire` (keychain
 * ref, decrypt, well-formedness check — any failure is `ok: false` and therefore
 * ineligible). Necessary, never sufficient: a licence says the seat CAN pay, the
 * per-seat config says it MAY. Advertising a paid capability on a seat that
 * cannot pay is forbidden whatever its config says, so this is checked before the
 * config read and independently of it.
 */
export function isAgentVideoGenerateLicenseEligible(dataPath: string): boolean {
  const wire = readLicenseWire(dataPath);
  return wire.ok === true && typeof wire.wire === 'string' && wire.wire.length > 0;
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
