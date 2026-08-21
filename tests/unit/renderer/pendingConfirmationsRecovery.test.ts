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
  upsertPendingConfirmationMessage,
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

function withAuthority(
  base: IConfirmation<string>,
  confirmationVersion: number,
  lifecycle = 'pending',
  sessionEpoch = 1
): IConfirmation<string> {
  return {
    ...base,
    authority: {
      protocol_version: 1,
      operation_id: base.call_id,
      operation_digest: `digest-${base.call_id}`,
      confirmation_version: confirmationVersion,
      policy_revision: 4,
      session_epoch: sessionEpoch,
      created_at_ms: 100,
      expires_at_ms: 10_000,
      lifecycle,
      classification: 'routine_edit',
      required_authority: null,
      runtime_receipt_digest: 'runtime-receipt',
    },
  } as IConfirmation<string>;
}

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

  it('retains a rich ACP card when recovery updates lifecycle authority', () => {
    const live = [
      {
        id: 'acp-card',
        msg_id: 'acp-message',
        type: 'acp_permission',
        conversation_id: 'conv-1',
        position: 'left',
        content: {
          session_id: 'session-1',
          options: [{ option_id: 'clarify_choice_0', name: 'Make it blue', kind: 'allow_once' }],
          tool_call: {
            tool_call_id: 'tool-1',
            title: 'Should I make the artifact blue?',
            raw_input: {
              question: 'Should I make the artifact blue?',
              choices: ['Make it blue'],
              metadata: {
                interaction_kind: 'clarify',
                question: 'Should I make the artifact blue?',
                choices: ['Make it blue'],
              },
            },
          },
        },
      },
    ] as TMessage[];

    const result = upsertPendingConfirmationMessage(live, 'conv-1', withAuthority(confirmation, 2));

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('acp_permission');
    if (result[0].type === 'acp_permission') {
      expect(result[0].content.status).toBe('pending');
      expect(result[0].content.options[0]?.option_id).toBe('clarify_choice_0');
      expect(result[0].content.tool_call.raw_input).toMatchObject({
        metadata: {
          interaction_kind: 'clarify',
          question: 'Should I make the artifact blue?',
        },
      });
      expect((result[0].content as Record<string, unknown>).authority).toMatchObject({
        confirmation_version: 2,
      });
    }
  });

  it('ignores stale authority versions but accepts lifecycle updates at the current version', () => {
    const current = buildPendingConfirmationMessage('conv-1', withAuthority(confirmation, 4));
    const stale = upsertPendingConfirmationMessage(
      [current],
      'conv-1',
      withAuthority({ ...confirmation, action: 'expired' }, 3, 'expired')
    );
    expect(stale[0]).toBe(current);

    const updated = upsertPendingConfirmationMessage(
      [current],
      'conv-1',
      withAuthority({ ...confirmation, action: 'expired' }, 4, 'expired')
    );
    expect(updated).toHaveLength(1);
    expect(updated[0].type).toBe('permission');
    if (updated[0].type === 'permission') {
      expect(updated[0].content.action).toBe('expired');
    }
  });

  it('rejects a delayed card from an older runtime even when its numeric version is larger', () => {
    const currentConfirmation = withAuthority(confirmation, 1, 'pending', 1) as IConfirmation<string> & {
      authority: Record<string, unknown>;
    };
    currentConfirmation.authority = {
      ...currentConfirmation.authority,
      created_at_ms: 2_000,
      runtime_receipt_digest: 'runtime-new',
    };
    const delayedOld = withAuthority(
      { ...confirmation, action: 'expired' },
      99,
      'expired',
      99
    ) as IConfirmation<string> & { authority: Record<string, unknown> };
    delayedOld.authority = {
      ...delayedOld.authority,
      created_at_ms: 1_000,
      runtime_receipt_digest: 'runtime-old',
    };
    const current = buildPendingConfirmationMessage('conv-1', currentConfirmation);

    const result = upsertPendingConfirmationMessage([current], 'conv-1', delayedOld);

    expect(result[0]).toBe(current);
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
