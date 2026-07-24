import { describe, expect, it } from 'vitest';

import { isCommandEveManagedImageMcp, userVisibleConversationMcpStatuses } from '@/common/config/eveManagedMcpCore';
import { BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME } from '@/common/config/storage';

describe('managed MCP presentation boundary', () => {
  it('recognizes every stable image-generator identity as app-owned', () => {
    expect(isCommandEveManagedImageMcp({ id: BUILTIN_IMAGE_GEN_ID })).toBe(true);
    expect(isCommandEveManagedImageMcp({ name: BUILTIN_IMAGE_GEN_NAME })).toBe(true);
    expect(isCommandEveManagedImageMcp({ name: 'AionUi Image Generation' })).toBe(true);
    expect(isCommandEveManagedImageMcp({ id: 'customer-files', name: 'Files' })).toBe(false);
  });

  it('removes stale unsupported internal status without hiding real connectors', () => {
    expect(
      userVisibleConversationMcpStatuses([
        { id: BUILTIN_IMAGE_GEN_ID, name: BUILTIN_IMAGE_GEN_NAME, status: 'unsupported' },
        { id: 'customer-files', name: 'Customer Files', status: 'loaded' },
      ])
    ).toEqual([{ id: 'customer-files', name: 'Customer Files', status: 'loaded' }]);
  });

  it('also filters legacy name-only snapshots', () => {
    expect(userVisibleConversationMcpStatuses(undefined, [BUILTIN_IMAGE_GEN_NAME, 'customer-files'])).toEqual([
      { id: 'customer-files', name: 'customer-files', status: 'loaded' },
    ]);
  });
});
