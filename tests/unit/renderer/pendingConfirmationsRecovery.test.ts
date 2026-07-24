// @vitest-environment jsdom

import type { IConfirmation, TMessage } from '@/common/chat/chatLib';
import { ipcBridge } from '@/common';
import { MessageListProvider, useMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import { act, renderHook, waitFor } from '@testing-library/react';
import React, { type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingConfirmationMessage,
  hasPermissionMessageForCallId,
  removePermissionMessage,
  usePendingConfirmationsRecovery,
} from '@/renderer/pages/conversation/Messages/usePendingConfirmationsRecovery';

const handlers = vi.hoisted(() => ({
  add: undefined as ((value: IConfirmation<unknown> & { conversation_id: string }) => void) | undefined,
  update: undefined as ((value: IConfirmation<unknown> & { conversation_id: string }) => void) | undefined,
  remove: undefined as ((value: { conversation_id: string; id: string }) => void) | undefined,
  resync: undefined as (() => void) | undefined,
  connected: undefined as ((value: { reconnected?: boolean }) => void) | undefined,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      confirmation: {
        list: { invoke: vi.fn() },
        add: {
          on: vi.fn((handler) => {
            handlers.add = handler;
            return () => {
              if (handlers.add === handler) handlers.add = undefined;
            };
          }),
        },
        update: {
          on: vi.fn((handler) => {
            handlers.update = handler;
            return () => {
              if (handlers.update === handler) handlers.update = undefined;
            };
          }),
        },
        remove: {
          on: vi.fn((handler) => {
            handlers.remove = handler;
            return () => {
              if (handlers.remove === handler) handlers.remove = undefined;
            };
          }),
        },
      },
      realtimeResyncRequired: {
        on: vi.fn((handler) => {
          handlers.resync = handler;
          return () => {
            if (handlers.resync === handler) handlers.resync = undefined;
          };
        }),
      },
      realtimeConnected: {
        on: vi.fn((handler) => {
          handlers.connected = handler;
          return () => {
            if (handlers.connected === handler) handlers.connected = undefined;
          };
        }),
      },
    },
  },
}));

const confirmation: IConfirmation<string> = {
  id: 'tool-1',
  call_id: 'tool-1',
  title: 'Write file',
  description: 'Write /tmp/current_time.txt',
  command_type: 'edit',
  options: [{ label: 'Allow', value: 'allow_once' }],
};

function Wrapper({ children }: PropsWithChildren): JSX.Element {
  return React.createElement(MessageListProvider, { value: [] }, children);
}

function useRecoveryHarness(conversationId = 'conv-1') {
  usePendingConfirmationsRecovery(conversationId);
  return useMessageList();
}

describe('pending confirmations recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.add = undefined;
    handlers.update = undefined;
    handlers.remove = undefined;
    handlers.resync = undefined;
    handlers.connected = undefined;
    vi.mocked(ipcBridge.conversation.confirmation.list.invoke).mockResolvedValue([]);
  });

  it('builds a permission message with stable msg_id from confirmation id', () => {
    const message = buildPendingConfirmationMessage('conv-1', confirmation);

    expect(message.type).toBe('permission');
    expect(message.conversation_id).toBe('conv-1');
    expect(message.msg_id).toBe('confirmation:tool-1');
    expect(message.content.call_id).toBe('tool-1');
  });

  it('detects existing permission messages by call_id', () => {
    const list = [buildPendingConfirmationMessage('conv-1', confirmation)];

    expect(hasPermissionMessageForCallId(list, 'tool-1')).toBe(true);
    expect(hasPermissionMessageForCallId(list, 'tool-2')).toBe(false);
  });

  it('deduplicates a recovered generic confirmation against a live ACP permission', () => {
    const list = [
      {
        id: 'acp-card',
        msg_id: 'acp-message',
        type: 'acp_permission',
        conversation_id: 'conv-1',
        position: 'left',
        content: {
          session_id: 'session-1',
          options: [],
          tool_call: { tool_call_id: 'tool-1' },
        },
      },
    ] as TMessage[];

    expect(hasPermissionMessageForCallId(list, 'tool-1')).toBe(true);
  });

  it('removes recovered permission messages by confirmation id or call_id', () => {
    const list = [
      buildPendingConfirmationMessage('conv-1', confirmation),
      { id: 'text-1', type: 'text', conversation_id: 'conv-1', content: { content: 'hello' } },
    ] as TMessage[];

    const result = removePermissionMessage(list, { id: 'tool-1', call_id: 'tool-1' });

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('text');
  });

  it('materializes confirmation.add immediately even when the chat stream frame was missed', async () => {
    const { result } = renderHook(() => useRecoveryHarness(), { wrapper: Wrapper });
    await waitFor(() => expect(ipcBridge.conversation.confirmation.list.invoke).toHaveBeenCalledTimes(1));

    act(() => handlers.add?.({ ...confirmation, conversation_id: 'conv-1' }));

    await waitFor(() => expect(result.current.some((message) => message.type === 'permission')).toBe(true));
    expect(result.current.find((message) => message.type === 'permission')?.content.call_id).toBe('tool-1');
  });

  it('re-reads the authoritative pending list after realtime reconnect without navigation', async () => {
    vi.mocked(ipcBridge.conversation.confirmation.list.invoke)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...confirmation, id: 'tool-2', call_id: 'tool-2' }]);
    const { result } = renderHook(() => useRecoveryHarness(), { wrapper: Wrapper });
    await waitFor(() => expect(ipcBridge.conversation.confirmation.list.invoke).toHaveBeenCalledTimes(1));

    act(() => handlers.connected?.({ reconnected: true }));

    await waitFor(() => expect(ipcBridge.conversation.confirmation.list.invoke).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        result.current.some((message) => message.type === 'permission' && message.content.call_id === 'tool-2')
      ).toBe(true)
    );
  });

  it('removes both recovered and live ACP permission cards on confirmation.remove', async () => {
    vi.mocked(ipcBridge.conversation.confirmation.list.invoke).mockResolvedValueOnce([confirmation]);
    const { result } = renderHook(() => useRecoveryHarness(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => handlers.remove?.({ conversation_id: 'conv-1', id: 'tool-1' }));

    await waitFor(() => expect(result.current).toHaveLength(0));
  });
});
