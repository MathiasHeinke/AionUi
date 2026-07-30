/**
 * @vitest-environment node
 */

import { acpConversation } from '@/common/adapter/ipcBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backendPort = 18_814;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ACP mode/model config-options bridge', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = backendPort;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    vi.unstubAllGlobals();
  });

  it('reads the live mode from the stable config-options route', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      jsonResponse({
        config_options: [
          {
            id: 'mode',
            category: 'mode',
            type: 'select',
            current_value: 'dont_ask',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'dont_ask', name: "Don't Ask" },
            ],
          },
        ],
      })
    );

    await expect(acpConversation.getMode.invoke({ conversation_id: 'conversation-1' })).resolves.toEqual({
      mode: 'dont_ask',
      initialized: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:${backendPort}/api/conversations/conversation-1/config-options`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('writes mode through config-options/mode and maps the observed result', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      jsonResponse({
        confirmation: 'observed',
        config_options: [
          {
            id: 'mode',
            category: 'mode',
            type: 'select',
            current_value: 'dont_ask',
            options: [{ value: 'dont_ask', name: "Don't Ask" }],
          },
        ],
      })
    );

    await expect(
      acpConversation.setMode.invoke({ conversation_id: 'conversation-1', mode: 'dont_ask' })
    ).resolves.toEqual({ mode: 'dont_ask', initialized: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:${backendPort}/api/conversations/conversation-1/config-options/mode`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: 'dont_ask' }) })
    );
  });

  // Regression: the mapper used to fabricate `default` plus `initialized: true`
  // for a payload that carried no mode option. The permission pill then showed
  // "Ask" for a session whose real mode was never reported, and every caller's
  // `initialized === false` guard was unreachable.
  it('reports an absent mode option as un-established instead of fabricating Ask', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ config_options: [] }));

    await expect(acpConversation.getMode.invoke({ conversation_id: 'conversation-1' })).resolves.toEqual({
      mode: 'default',
      initialized: false,
    });
  });

  it('does not present a mode option without a value as established', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      jsonResponse({
        config_options: [
          { id: 'mode', category: 'mode', type: 'select', options: [{ value: 'default', name: 'Default' }] },
        ],
      })
    );

    await expect(acpConversation.getMode.invoke({ conversation_id: 'conversation-1' })).resolves.toEqual({
      mode: 'default',
      initialized: false,
    });
  });

  // Deliberately NOT asserted: that `confirmation: 'command_ack'` means
  // un-established. Nothing in this repo evidences the backend ever answering
  // `'observed'`, so treating an ack as a failure could leave a widening
  // permanently unconfirmed. Pin it only once the backend contract is proven.

  it('maps the model catalog and writes model through config-options/model', async () => {
    const fetchMock = vi.mocked(fetch);
    const payload = {
      confirmation: 'observed',
      config_options: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          current_value: 'model-b',
          options: [
            { value: 'model-a', name: 'Model A' },
            { value: 'model-b', name: 'Model B' },
          ],
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload)).mockResolvedValueOnce(jsonResponse(payload));

    const expected = {
      model_info: {
        current_model_id: 'model-b',
        current_model_label: 'Model B',
        available_models: [
          { id: 'model-a', label: 'Model A' },
          { id: 'model-b', label: 'Model B' },
        ],
      },
    };
    await expect(acpConversation.getModel.invoke({ conversation_id: 'conversation-1' })).resolves.toEqual(expected);
    await expect(
      acpConversation.setModel.invoke({ conversation_id: 'conversation-1', model_id: 'model-b' })
    ).resolves.toEqual(expected);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://127.0.0.1:${backendPort}/api/conversations/conversation-1/config-options/model`
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ value: 'model-b' }) })
    );
  });
});
