/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createCommandEveCloudVisualFlowId,
  isCommandEveCloudVisualFlowId,
} from '@/common/config/visual/cloudVisualPolicyCore';

describe('cloud visual flow ids', () => {
  it('mints the canonical visual_flow id from renderer entropy', () => {
    const flowId = createCommandEveCloudVisualFlowId('0123456789abcdef0123456789abcdef');

    expect(flowId).toBe('visual_flow_0123456789abcdef0123456789abcdef');
    expect(isCommandEveCloudVisualFlowId(flowId)).toBe(true);
  });

  it('rejects the eight-character random part that caused the 1.822.1 preload rejection', () => {
    expect(() => createCommandEveCloudVisualFlowId('01234567')).toThrow(
      'COMMAND_EVE_CLOUD_VISUAL_FLOW_ID_RANDOM_PART_INVALID'
    );
  });
});
