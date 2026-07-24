import { describe, expect, it } from 'vitest';

import { BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME, type IMcpServer } from '@/common/config/storage';
import { resolveGuidInitialMcpServerIds } from '@/renderer/pages/guid/hooks/guidMcpSelectionCore';

const server = (overrides: Partial<IMcpServer>): IMcpServer => ({
  id: 'server',
  name: 'server',
  enabled: true,
  builtin: false,
  transport: { type: 'stdio', command: 'node', args: ['server.js'] },
  created_at: 1,
  updated_at: 1,
  original_json: '{}',
  ...overrides,
});

describe('Guid MCP defaults', () => {
  it('enables only the signed built-in image generator for Command EVE', () => {
    const servers = [
      server({ id: BUILTIN_IMAGE_GEN_ID, name: BUILTIN_IMAGE_GEN_NAME, builtin: true }),
      server({ id: 'chrome-devtools', name: 'chrome-devtools', builtin: true }),
      server({ id: 'customer-git', name: 'customer-git' }),
    ];

    expect(resolveGuidInitialMcpServerIds(servers, true)).toEqual([BUILTIN_IMAGE_GEN_ID]);
  });

  it('does not revive a disabled image generator or alter the generic shell', () => {
    const image = server({
      id: BUILTIN_IMAGE_GEN_ID,
      name: BUILTIN_IMAGE_GEN_NAME,
      builtin: true,
      enabled: false,
    });

    expect(resolveGuidInitialMcpServerIds([image], true)).toEqual([]);
    expect(resolveGuidInitialMcpServerIds([{ ...image, enabled: true }], false)).toEqual([]);
  });
});
