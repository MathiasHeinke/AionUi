import { describe, expect, it } from 'vitest';

import {
  COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY,
  readCommandEveManagedImageRequestId,
} from '@/process/resources/builtinMcp/managedImageRequestIdentityCore';

const LOGICAL_CALL_ID = 'c'.repeat(64);

const meta = (logicalCallId = LOGICAL_CALL_ID) => ({
  [COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY]: {
    logicalCallId,
  },
});

describe('managed image MCP request identity', () => {
  it('accepts the fixed-length opaque digest emitted by Hermes', () => {
    expect(readCommandEveManagedImageRequestId(meta())).toBe(LOGICAL_CALL_ID);
  });

  it('does not let MCP route metadata alter the Hermes debit identity', () => {
    const retry = {
      ...meta(),
      [COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY]: {
        ...meta()[COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY],
        mcpServerName: 'aionui-image-generation',
        mcpToolName: 'aionui_image_generation',
      },
    };

    expect(readCommandEveManagedImageRequestId(retry)).toBe(LOGICAL_CALL_ID);
  });

  it('refuses missing, malformed, or uppercase Hermes metadata', () => {
    expect(readCommandEveManagedImageRequestId({})).toBeUndefined();
    expect(
      readCommandEveManagedImageRequestId({
        [COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY]: {
          logicalCallId: '',
        },
      })
    ).toBeUndefined();
    expect(readCommandEveManagedImageRequestId(meta('C'.repeat(64)))).toBeUndefined();
  });
});
