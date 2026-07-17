/**
 * @vitest-environment node
 */

import { conversation } from '@/common/adapter/ipcBridge';
import type { TProviderWithModel } from '@/common/config/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backendPort = 18_814;

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('conversation skill selection bridge', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = backendPort;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    vi.unstubAllGlobals();
  });

  it('sends creation-only selections and reads the persisted runtime skill snapshot', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'conversation-1',
        type: 'acp',
        name: 'Capability handoff',
        extra: {
          backend: 'hermes',
          skills: ['auto-active', 'optional-active'],
        },
      })
    );

    const created = await conversation.create.invoke({
      type: 'acp',
      name: 'Capability handoff',
      model: {} as TProviderWithModel,
      extra: {
        backend: 'hermes',
        preset_enabled_skills: ['optional-active'],
        exclude_auto_inject_skills: ['auto-excluded'],
      },
    });

    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(`http://127.0.0.1:${backendPort}/api/conversations`);
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      type: 'acp',
      name: 'Capability handoff',
      extra: {
        backend: 'hermes',
        preset_enabled_skills: ['optional-active'],
        exclude_auto_inject_skills: ['auto-excluded'],
      },
    });
    expect(created.extra).toEqual({
      backend: 'hermes',
      skills: ['auto-active', 'optional-active'],
      custom_workspace: false,
    });
    expect(created.extra).not.toHaveProperty('preset_enabled_skills');
    expect(created.extra).not.toHaveProperty('exclude_auto_inject_skills');
  });
});
