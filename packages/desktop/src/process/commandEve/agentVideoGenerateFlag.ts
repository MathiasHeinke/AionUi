/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY } from '@/common/config/agentVideoGenerateReleaseCore';

/**
 * Paid agent video generation stays closed until native Hermes approval and a
 * stable request identity cover the complete tool call. The release fence is the
 * single product boundary; no per-seat spend consent or renderer pre-dispatch
 * authority is layered behind it.
 */
export const COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG = 'COMMAND_EVE_ENABLE_AGENT_VIDEO_GENERATE';

export function isAgentVideoGenerateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY && (env[COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG] || '').trim() === '1';
}

/** The pinned request axes; the model never names a paid tier or duration. */
export const AGENT_VIDEO_GENERATE_TIER_ID = 'fast' as const;
export const AGENT_VIDEO_GENERATE_DURATION_SECONDS = 5;
