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
// is a promise, so an unentitled seat must not be shown one and then refused.
// Both default OFF, matching the server's own default-off posture — a capability
// we cannot prove is a capability we do not advertise.

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

/** Exactly `'1'`, for the same reason as the spending flag above. */
export function readVideoSeatCapabilities(env: NodeJS.ProcessEnv = process.env): VideoSeatCapabilityFlags {
  return {
    hd15Available: (env[COMMAND_EVE_VIDEO_HD15_FLAG] || '').trim() === '1',
    presetVoicesAvailable: (env[COMMAND_EVE_VIDEO_PRESET_VOICES_FLAG] || '').trim() === '1',
  };
}
