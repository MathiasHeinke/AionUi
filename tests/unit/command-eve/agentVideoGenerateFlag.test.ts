/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

const {
  AGENT_VIDEO_GENERATE_DURATION_SECONDS,
  AGENT_VIDEO_GENERATE_TIER_ID,
  COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG: FLAG,
  isAgentVideoGenerateEnabled,
} = await import('@/process/commandEve/agentVideoGenerateFlag');
const { DEFAULT_VIDEO_TIER_ID } = await import('@/common/config/videoCostCore');
const { AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY } = await import('@/common/config/agentVideoGenerateReleaseCore');

describe('agent video generation remains closed at the native boundary', () => {
  it('keeps every carrier spelling inert while the release fence is closed', () => {
    expect(AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY).toBe(false);
    for (const value of ['1', ' 1 ', 'true', 'TRUE', 'yes', 'on', '11', '']) {
      expect(isAgentVideoGenerateEnabled({ [FLAG]: value }), `"${value}" must not open the lane`).toBe(false);
    }
    expect(isAgentVideoGenerateEnabled({})).toBe(false);
  });

  it('keeps the agent request axes pinned to the shared defaults', () => {
    expect(AGENT_VIDEO_GENERATE_TIER_ID).toBe(DEFAULT_VIDEO_TIER_ID);
    expect(AGENT_VIDEO_GENERATE_DURATION_SECONDS).toBe(5);
  });
});
