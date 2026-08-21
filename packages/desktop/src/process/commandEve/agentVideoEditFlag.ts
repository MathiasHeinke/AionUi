/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the one place that answers whether legacy video edit is offered.
 *
 * 1.823.6 ships no legacy paid video create or edit path. The native Hermes
 * authority migration is not complete, so this shared release fence keeps every
 * legacy video-edit surface closed: Main, the renderer bridge and the MCP child
 * all consume one false answer. An environment variable or licence wire cannot
 * reopen a retired release surface.
 *
 * Keep the historical carrier constant while the bundled MCP configuration
 * still imports it. The reader intentionally ignores it; deleting that
 * compatibility surface belongs to the native-authority migration, not this
 * release fence.
 */

/** Historical MCP-child carrier. It cannot enable legacy video edit. */
export const COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG = 'COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT';

/** The MCP child must not advertise a retired legacy paid tool. */
export function isAgentVideoEditEnabled(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

export interface AgentVideoEditAdvertisementInput {
  env: NodeJS.ProcessEnv;
  /** True iff the seat's CEVE licence wire is present AND readable. */
  licenseWirePresent: boolean;
}

/**
 * The Main-side release decision, pure and in one place.
 */
export function resolveAgentVideoEditAdvertisement(_input: AgentVideoEditAdvertisementInput): boolean {
  return false;
}

/**
 * The production half of the release decision. It deliberately does not read
 * entitlement state: no credential can make a retired surface available.
 */
export function isAgentVideoEditAdvertisingEnabled(_dataPath: string, _env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
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
