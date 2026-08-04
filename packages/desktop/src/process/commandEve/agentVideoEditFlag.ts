/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readLicenseWire } from '@/common/config/licenseWireAtRest';

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
 * THE CONTRACT, AND ITS HISTORY. 1.820.1 shipped this DEFAULT-OFF behind an
 * opt-in env flag: nothing advertised `eve_video_edit` unless
 * `COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT` was exactly `'1'`, because an MCP tool
 * call does not pass through Hermes' approval prompt and the feature had not
 * yet earned default-on. Two proofs earned it: the packaged emitted-config
 * proof (the shipping asarUnpack list puts the MCP script where an external
 * node can execute it, the packaged layout emits `aionui-eve-artifacts`, and
 * every fail-closed precondition survives) and the bounded no-paid dry proof
 * (context → tool surface → loopback, with zero debit and zero egress). With
 * both green, 1.820.2 flips the POSTURE, not the spend authority:
 *
 *   - an ELIGIBLE seat — one whose CEVE licence wire is present and readable
 *     via the real `readLicenseWire(dataPath)` — advertises `eve_video_edit`
 *     BY DEFAULT, with no env var involved;
 *   - exactly `'0'` (trimmed) is the emergency kill-switch and forces OFF even
 *     on an eligible seat;
 *   - `'1'` is now a NO-OP. Default-on made it redundant, and it must NOT
 *     bypass eligibility: advertising a paid capability on an unauthenticated
 *     seat is forbidden, whatever the env says;
 *   - no licence wire, or a wire that will not read, is OFF — fail closed, as
 *     every other credential read on this path already is.
 *
 * What did NOT change: the server-side gates. Licence verify, entitlement,
 * debit-before-provider and idempotency all re-verify everything per request,
 * exactly as before. This flip changes ADVERTISEMENT and permit minting; it
 * spends nothing by itself.
 */

/** Env flag carrying the kill-switch (and, to the MCP child, Main's decision). */
export const COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG = 'COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT';

/**
 * Exactly `'1'`. Not "truthy", not `'true'`, not `'yes'`.
 *
 * A spending flag that accepts several spellings is a spending flag that gets
 * turned on by accident — by a stray `=true` in a shell profile, or by a value
 * someone assumed was ignored.
 *
 * WHO READS THIS, post-flip: the MCP CHILD, and only the child. Main resolves
 * eligibility itself (see {@link resolveAgentVideoEditAdvertisement}) and emits
 * exactly `'1'` into the child environment when — and only when — the seat may
 * be told about the paid tool, so for the child this exact-`'1'` read IS the
 * whole decision. Main never decides from this function: on Main's side `'1'`
 * is a no-op and `'0'` is the kill-switch, both judged by the resolver below.
 */
export function isAgentVideoEditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] || '').trim() === '1';
}

export interface AgentVideoEditAdvertisementInput {
  env: NodeJS.ProcessEnv;
  /** True iff the seat's CEVE licence wire is present AND readable. */
  licenseWirePresent: boolean;
}

/**
 * THE advertisement decision, pure and in one place.
 *
 * Kill-switch first: exactly `'0'` (trimmed) closes the seat even when a
 * licence wire reads fine — an emergency off that does not require deleting
 * credentials. Otherwise the seat advertises iff it is eligible, i.e. the
 * licence wire is present and readable. Every other value of the flag —
 * including `'1'` — changes nothing: default-on made `'1'` redundant, and a
 * redundant spelling that could ALSO override the eligibility check would be
 * an opt-out seat's way to advertise a capability it cannot pay for.
 */
export function resolveAgentVideoEditAdvertisement(input: AgentVideoEditAdvertisementInput): boolean {
  if ((input.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG] || '').trim() === '0') return false;
  return input.licenseWirePresent === true;
}

/**
 * The production half of the decision: reads the licence wire at rest through
 * the REAL `readLicenseWire` (keychain ref, decrypt, well-formedness check —
 * any failure is `ok: false` and therefore ineligible) and folds it into the
 * resolver above. Every Main-side consumer — the context envelope, the shared
 * paid handler, the loopback and the MCP-child env emission — asks HERE, so
 * the four surfaces cannot drift apart about what this seat offers.
 */
export function isAgentVideoEditAdvertisingEnabled(dataPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const wire = readLicenseWire(dataPath);
  return resolveAgentVideoEditAdvertisement({
    env,
    licenseWirePresent: wire.ok === true && typeof wire.wire === 'string' && wire.wire.length > 0,
  });
}

// ---------------------------------------------------------------------------
// MAT-1753 — the seat's VIDEO MODEL capabilities
// ---------------------------------------------------------------------------
//
// Same module for the same reason as above: both lanes that can start a paid
// video (the renderer IPC bridge and the picker that renders in front of it)
// must ask ONE thing, and neither may answer for itself.
//
// WHAT THESE FLAGS ARE AND ARE NOT. They are the DESKTOP MIRROR of two
// server-side gates; they are not the authority. `eve-multimodal` decides for
// real (`EVE_MULTIMODAL_ENABLE_XAI_VIDEO_HD15`, and the preset-voice
// entitlement), and it decides again on every request regardless of what the
// desktop believed. What these buy is honesty in the UI: a control that renders
// is a promise, so the desktop default has to match the release contract that is
// actually deployed. For 1.820.4, HD 1.5 is part of the licensed product and the
// server gate is enabled, so HD 1.5 defaults ON here as well. Exactly `0` remains
// an emergency desktop kill-switch. Preset voices remain default OFF because
// their upstream entitlement is narrower and has not been released generally.
//
// The server remains the spending authority and re-checks its own flag on every
// request. This desktop value only controls whether the selector is advertised.

/** Makes grok-imagine-video-1.5 (and therefore 1080p, and reference mode) offerable. */
export const COMMAND_EVE_VIDEO_HD15_FLAG = 'COMMAND_EVE_ENABLE_VIDEO_HD15';

/**
 * Makes PRESET reference voices offerable.
 *
 * xAI gates these to US trusted partners. There is deliberately no flag for
 * CUSTOM audio upload: that capability does not exist upstream, so the product
 * has no field, no control and no flag that could ever expose it.
 */
export const COMMAND_EVE_VIDEO_PRESET_VOICES_FLAG = 'COMMAND_EVE_ENABLE_VIDEO_PRESET_VOICES';

export interface VideoSeatCapabilityFlags {
  hd15Available: boolean;
  presetVoicesAvailable: boolean;
}

/**
 * HD 1.5 follows the 1.820.4 licensed-release default and accepts exactly `0`
 * as an emergency kill-switch. Preset voices keep their exact-`1` opt-in.
 */
export function readVideoSeatCapabilities(env: NodeJS.ProcessEnv = process.env): VideoSeatCapabilityFlags {
  return {
    hd15Available: (env[COMMAND_EVE_VIDEO_HD15_FLAG] || '').trim() !== '0',
    presetVoicesAvailable: (env[COMMAND_EVE_VIDEO_PRESET_VOICES_FLAG] || '').trim() === '1',
  };
}
