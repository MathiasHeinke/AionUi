/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import { buildConversationMessagesPath } from '@/common/adapter/ipcBridge';
import type {
  IMessageAcpPermission,
  IMessageAcpToolCall,
  IMessagePermission,
  IMessageText,
  IMessageThinking,
} from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  reconcileHistoryMessages,
  useAddOrUpdateMessage,
  useMessageLstCache,
  useMessageList,
  useMessageListLoading,
} from '@/renderer/pages/conversation/Messages/hooks';
import { fetchAllConversationMessages } from '@/renderer/utils/chat/messageHistory';
import { emitter } from '@/renderer/utils/emitter';

const { responseStreamHandlerRef, resyncHandlerRef, connectedHandlerRef } = vi.hoisted(() => ({
  responseStreamHandlerRef: {
    current: undefined as
      | ((message: { type: string; conversation_id: string; msg_id: string; data: unknown }) => void)
      | undefined,
  },
  resyncHandlerRef: {
    current: undefined as (() => void) | undefined,
  },
  connectedHandlerRef: {
    current: undefined as ((event: { reconnected: boolean }) => void) | undefined,
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: vi
          .fn()
          .mockImplementation(
            (handler: (message: { type: string; conversation_id: string; msg_id: string; data: unknown }) => void) => {
              responseStreamHandlerRef.current = handler;
              return () => {
                if (responseStreamHandlerRef.current === handler) responseStreamHandlerRef.current = undefined;
              };
            }
          ),
      },
      realtimeResyncRequired: {
        on: vi.fn().mockImplementation((handler: () => void) => {
          resyncHandlerRef.current = handler;
          return () => {
            if (resyncHandlerRef.current === handler) resyncHandlerRef.current = undefined;
          };
        }),
      },
      realtimeConnected: {
        on: vi.fn().mockImplementation((handler: (event: { reconnected: boolean }) => void) => {
          connectedHandlerRef.current = handler;
          return () => {
            if (connectedHandlerRef.current === handler) connectedHandlerRef.current = undefined;
          };
        }),
      },
      userCreated: {
        on: vi.fn().mockReturnValue(() => {}),
      },
    },
    database: {
      getConversationMessages: {
        invoke: vi.fn(),
      },
    },
  },
}));

const CONVERSATION_ID = 'conversation-1';
const SECOND_CONVERSATION_ID = 'conversation-2';

function createTextMessage(msgId: string, content: string, conversation_id = CONVERSATION_ID): IMessageText {
  return {
    id: `text-${msgId}-${content}`,
    type: 'text',
    msg_id: msgId,
    conversation_id,
    position: 'left',
    content: {
      content,
    },
  };
}

function createThinkingMessage(msgId: string, content: string): IMessageThinking {
  return {
    id: `thinking-${msgId}-${content}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content,
      status: 'thinking',
    },
  };
}

function createThinkingDoneMessage(msgId: string, duration: number): IMessageThinking {
  return {
    id: `thinking-done-${msgId}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content: '',
      duration,
      status: 'done',
    },
  };
}

function createToolCallMessage(toolCallId: string): IMessageAcpToolCall {
  return {
    id: toolCallId,
    type: 'acp_tool_call',
    msg_id: toolCallId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      session_id: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: toolCallId,
        status: 'completed',
        title: 'Read file',
        kind: 'read',
      },
    },
  };
}

function createLiveToolCallMessage(toolCallId: string): IMessageAcpToolCall {
  return {
    ...createToolCallMessage(toolCallId),
    id: `live-${toolCallId}`,
    msg_id: 'assistant-message-id',
  };
}

function createAcpPermission(callId: string): IMessageAcpPermission {
  return {
    id: `acp-${callId}`,
    msg_id: `acp-${callId}`,
    type: 'acp_permission',
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      session_id: 'session-1',
      options: [{ option_id: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      tool_call: {
        tool_call_id: callId,
        title: 'Write file',
        kind: 'edit',
      },
    },
  };
}

function createRecoveredPermission(callId: string): IMessagePermission {
  return {
    id: `confirmation:${callId}`,
    msg_id: `confirmation:${callId}`,
    type: 'permission',
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      id: callId,
      call_id: callId,
      title: 'Write file',
      description: 'write_file',
      command_type: 'edit',
      options: [{ label: 'Allow once', value: 'allow_once' }],
    },
  };
}

function TestWrapper({ children }: PropsWithChildren): JSX.Element {
  return <MessageListProvider value={[]}>{children}</MessageListProvider>;
}

function CacheWrapper({ children }: PropsWithChildren): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessageListProvider value={[]}>{children}</MessageListProvider>
    </MessageListLoadingProvider>
  );
}

function useMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    messages: useMessageList(),
  };
}

function useMessageCacheHarness(conversation_id = CONVERSATION_ID) {
  return {
    pagination: useMessageLstCache(conversation_id),
    messages: useMessageList(),
    loading: useMessageListLoading(),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMessageQueue(): Promise<void> {
  await act(async () => {
    vi.runAllTimers();
  });
}

describe('message merging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    responseStreamHandlerRef.current = undefined;
    resyncHandlerRef.current = undefined;
    connectedHandlerRef.current = undefined;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('builds the AionCore cursor URL without legacy page parameters', () => {
    const path = buildConversationMessagesPath({
      conversation_id: 'conversation/with space',
      limit: 200,
      before: 'v1.cursor-value',
      content_mode: 'compact',
    });

    expect(path).toBe(
      '/api/conversations/conversation%2Fwith%20space/messages?limit=200&before=v1.cursor-value&content_mode=compact'
    );
    expect(path).not.toContain('page=');
    expect(path).not.toContain('page_size=');
  });

  it('deduplicates live and persisted ACP tool calls by their stable tool call id', () => {
    const messages = reconcileHistoryMessages(
      [createLiveToolCallMessage('tool-1')],
      [createToolCallMessage('tool-1')],
      CONVERSATION_ID
    );

    expect(messages.filter((message) => message.type === 'acp_tool_call')).toHaveLength(1);
  });

  it('replaces a live ACP permission with the authoritative confirmation projection', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createAcpPermission('permission-1'));
      result.current.addOrUpdateMessage(createRecoveredPermission('permission-1'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('permission');
  });

  it('ignores a late duplicate ACP frame after the authoritative confirmation arrived', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createRecoveredPermission('permission-2'));
      result.current.addOrUpdateMessage(createAcpPermission('permission-2'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('permission');
  });

  it('reconciles legacy ACP tool calls without an update payload', () => {
    const persisted = {
      ...createToolCallMessage('legacy-tool'),
      content: { session_id: 'legacy-session' },
    } as IMessageAcpToolCall;
    const live = {
      ...persisted,
      id: 'live-legacy-tool',
    };

    const messages = reconcileHistoryMessages([live], [persisted], CONVERSATION_ID);

    const toolCalls = messages.filter((message) => message.type === 'acp_tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].msg_id).toBe('legacy-tool');
  });

  it('keeps text segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'hello'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', ' world'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('text');
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'again'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['text', 'acp_tool_call', 'text']);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('again');
  });

  it('keeps thinking segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'beta'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('thinking');
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'gamma'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call', 'thinking']);
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');
    expect((result.current.messages[2] as IMessageThinking).content.content).toBe('gamma');
  });

  it('merges thinking done updates into the existing thinking message instead of appending a completion message', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingDoneMessage('msg-1', 4200));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call']);
    expect((result.current.messages[0] as IMessageThinking).content.status).toBe('done');
    expect((result.current.messages[0] as IMessageThinking).content.duration).toBe(4200);
  });

  it('ignores non-renderable transformed stream messages', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(undefined);
    });
    await flushMessageQueue();

    expect(result.current.messages).toEqual([]);
  });

  it('requests compact tool content when hydrating historical messages', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue({
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });

    renderHook(() => useMessageLstCache(CONVERSATION_ID), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith({
      conversation_id: CONVERSATION_ID,
      limit: 200,
      content_mode: 'compact',
    });
  });

  it('hydrates the newest history page chronologically and exposes older-page state', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue({
      items: [createTextMessage('msg-2', 'middle'), createTextMessage('msg-3', 'newest')],
      oldest_cursor: 'cursor-msg-2',
      newest_cursor: 'cursor-msg-3',
      has_more_before: true,
      has_more_after: false,
    });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-2', 'msg-3']);
    expect(result.current.pagination.hasOlderMessages).toBe(true);
    expect(result.current.pagination.loadedHistoricalMessages).toBe(2);
    expect(result.current.pagination.totalHistoricalMessages).toBe(2);
  });

  it('reconciles persisted messages after a terminal stream event without remounting the chat', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-1', 'Visible without route re-entry')],
        oldest_cursor: 'cursor-msg-1',
        newest_cursor: 'cursor-msg-1',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.messages).toEqual([]);

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: null,
        msg_id: 'msg-1',
        conversation_id: CONVERSATION_ID,
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((result.current.messages[0] as IMessageText).content.content).toBe('Visible without route re-entry');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('preserves loaded history order and pagination when a terminal event reconciles the newest page', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-2', 'middle'), createTextMessage('msg-3', 'recent')],
        oldest_cursor: 'cursor-msg-2',
        newest_cursor: 'cursor-msg-3',
        has_more_before: true,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-1', 'oldest'), createTextMessage('msg-2', 'middle')],
        oldest_cursor: 'cursor-msg-1',
        newest_cursor: 'cursor-msg-2',
        has_more_before: false,
        has_more_after: true,
      })
      .mockResolvedValueOnce({
        items: [
          createTextMessage('msg-2', 'middle'),
          createTextMessage('msg-3', 'recent'),
          createTextMessage('msg-4', 'newest'),
        ],
        oldest_cursor: 'cursor-msg-2',
        newest_cursor: 'cursor-msg-4',
        has_more_before: true,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.pagination.loadOlderMessages();
    });
    const loadedBeforeReconcile = result.current.pagination.loadedHistoricalMessages;
    const totalBeforeReconcile = result.current.pagination.totalHistoricalMessages;

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: null,
        msg_id: 'msg-4',
        conversation_id: CONVERSATION_ID,
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
    expect(result.current.pagination.loadedHistoricalMessages).toBe(loadedBeforeReconcile);
    expect(result.current.pagination.totalHistoricalMessages).toBe(totalBeforeReconcile);
    expect(result.current.pagination.hasOlderMessages).toBe(false);
  });

  it('retries a terminal reconciliation when persistence trails the first read', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-1', 'Persisted after the retry delay')],
        oldest_cursor: 'cursor-msg-1',
        newest_cursor: 'cursor-msg-1',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: null,
        msg_id: 'msg-1',
        conversation_id: CONVERSATION_ID,
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.messages).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((result.current.messages[0] as IMessageText).content.content).toBe('Persisted after the retry delay');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('rehydrates persisted messages after the backend reports a realtime lag', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-recovered', 'Recovered after realtime lag')],
        oldest_cursor: 'cursor-msg-recovered',
        newest_cursor: 'cursor-msg-recovered',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => resyncHandlerRef.current?.());
    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((result.current.messages[0] as IMessageText).content.content).toBe('Recovered after realtime lag');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('rehydrates only after an actual WebSocket reconnect', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValue({
        items: [createTextMessage('msg-reconnected', 'Recovered after reconnect')],
        oldest_cursor: 'cursor-msg-reconnected',
        newest_cursor: 'cursor-msg-reconnected',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => connectedHandlerRef.current?.({ reconnected: false }));
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() => connectedHandlerRef.current?.({ reconnected: true }));
    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((result.current.messages[0] as IMessageText).content.content).toBe('Recovered after reconnect');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('repairs a missed fresh-chat transcript after an explicit runtime refresh', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValue({
        items: [
          createTextMessage('msg-user', 'Read this PDF'),
          createTextMessage('msg-answer', 'Persisted PDF analysis'),
        ],
        oldest_cursor: 'cursor-msg-user',
        newest_cursor: 'cursor-msg-answer',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => emitter.emit('conversation.messages.refresh', { conversation_id: SECOND_CONVERSATION_ID }));
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() =>
      emitter.emit('conversation.messages.refresh', {
        conversation_id: CONVERSATION_ID,
        expectedTerminalMessageId: 'msg-answer',
      })
    );
    expect(result.current.loading).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-user', 'msg-answer']);
    expect(result.current.loading).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('renders persisted in-flight activity without a websocket event or chat remount', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createThinkingMessage('msg-thinking', 'Visible while the chat stays mounted')],
        oldest_cursor: 'cursor-msg-thinking',
        newest_cursor: 'cursor-msg-thinking',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.messages).toEqual([]);

    act(() => emitter.emit('conversation.messages.reconcile', { conversation_id: CONVERSATION_ID }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((result.current.messages[0] as IMessageThinking).content.content).toBe(
      'Visible while the chat stays mounted'
    );
    expect(result.current.loading).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated live transcript reconciles into one in-flight read and one follow-up', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    const emptyPage = {
      items: [],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    };
    let resolveFirstReconcile!: (value: typeof emptyPage) => void;
    const firstReconcile = new Promise<typeof emptyPage>((resolve) => {
      resolveFirstReconcile = resolve;
    });
    invoke
      .mockResolvedValueOnce(emptyPage)
      .mockImplementationOnce(() => firstReconcile)
      .mockResolvedValueOnce(emptyPage);

    renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitter.emit('conversation.messages.reconcile', { conversation_id: CONVERSATION_ID });
      emitter.emit('conversation.messages.reconcile', { conversation_id: CONVERSATION_ID });
      emitter.emit('conversation.messages.reconcile', { conversation_id: CONVERSATION_ID });
    });
    expect(invoke).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirstReconcile(emptyPage);
      await firstReconcile;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('keeps recovery loading until the expected terminal message is actually durable', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    const oldHistory = {
      items: [createTextMessage('msg-old', 'Previous turn')],
      oldest_cursor: 'cursor-msg-old',
      newest_cursor: 'cursor-msg-old',
      has_more_before: false,
      has_more_after: false,
    };
    invoke
      .mockResolvedValueOnce(oldHistory)
      .mockResolvedValueOnce(oldHistory)
      .mockResolvedValueOnce(oldHistory)
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-old', 'Previous turn'), createTextMessage('msg-new', 'New PDF answer')],
        oldest_cursor: 'cursor-msg-old',
        newest_cursor: 'cursor-msg-new',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() =>
      emitter.emit('conversation.messages.refresh', {
        conversation_id: CONVERSATION_ID,
        expectedTerminalMessageId: 'msg-new',
      })
    );
    expect(result.current.loading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-old']);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-old', 'msg-new']);
  });

  it('keeps recovery active beyond the short terminal retry window when persistence is delayed', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    const oldHistory = {
      items: [createTextMessage('msg-old', 'Previous turn')],
      oldest_cursor: 'cursor-msg-old',
      newest_cursor: 'cursor-msg-old',
      has_more_before: false,
      has_more_after: false,
    };
    let reads = 0;
    invoke.mockImplementation(async () => {
      reads += 1;
      if (reads <= 8) return oldHistory;
      return {
        items: [createTextMessage('msg-old', 'Previous turn'), createTextMessage('msg-late', 'Late PDF answer')],
        oldest_cursor: 'cursor-msg-old',
        newest_cursor: 'cursor-msg-late',
        has_more_before: false,
        has_more_after: false,
      };
    });

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() =>
      emitter.emit('conversation.messages.refresh', {
        conversation_id: CONVERSATION_ID,
        expectedTerminalMessageId: 'msg-late',
      })
    );
    const advanceRecoveryRetry = async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    };
    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
      await advanceRecoveryRetry();
      await advanceRecoveryRetry();
      await advanceRecoveryRetry();
      await advanceRecoveryRetry();
      await advanceRecoveryRetry();
    });

    expect(reads).toBe(7);
    expect(result.current.loading).toBe(true);
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-old']);

    await act(async () => {
      await advanceRecoveryRetry();
      await advanceRecoveryRetry();
    });

    expect(reads).toBe(9);
    expect(result.current.loading).toBe(false);
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-old', 'msg-late']);
  });

  it('does not let a superseded recovery read clear terminal reconciliation loading', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    const recoveryRead = createDeferred<{
      items: IMessageText[];
      oldest_cursor: string | null;
      newest_cursor: string | null;
      has_more_before: boolean;
      has_more_after: boolean;
    }>();
    const terminalRead = createDeferred<{
      items: IMessageText[];
      oldest_cursor: string | null;
      newest_cursor: string | null;
      has_more_before: boolean;
      has_more_after: boolean;
    }>();
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockReturnValueOnce(recoveryRead.promise)
      .mockReturnValueOnce(terminalRead.promise);

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => emitter.emit('conversation.messages.refresh', { conversation_id: CONVERSATION_ID }));
    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
    });
    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: null,
        msg_id: 'msg-terminal',
        conversation_id: CONVERSATION_ID,
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
    });

    await act(async () => {
      recoveryRead.resolve({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      terminalRead.resolve({
        items: [createTextMessage('msg-terminal', 'Terminal answer')],
        oldest_cursor: 'cursor-msg-terminal',
        newest_cursor: 'cursor-msg-terminal',
        has_more_before: false,
        has_more_after: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-terminal']);
  });

  it('keeps the assistant terminal id authoritative when runtime recovery reports the user message id', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    const userOnlyHistory = {
      items: [createTextMessage('msg-user', 'Queued correction')],
      oldest_cursor: 'cursor-msg-user',
      newest_cursor: 'cursor-msg-user',
      has_more_before: false,
      has_more_after: false,
    };
    invoke
      .mockResolvedValueOnce({
        items: [],
        oldest_cursor: null,
        newest_cursor: null,
        has_more_before: false,
        has_more_after: false,
      })
      .mockResolvedValueOnce(userOnlyHistory)
      .mockResolvedValueOnce({
        items: [
          createTextMessage('msg-user', 'Queued correction'),
          createTextMessage('msg-assistant', 'Durable corrected answer'),
        ],
        oldest_cursor: 'cursor-msg-user',
        newest_cursor: 'cursor-msg-assistant',
        has_more_before: false,
        has_more_after: false,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), { wrapper: CacheWrapper });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'finish',
        data: null,
        msg_id: 'msg-assistant',
        conversation_id: CONVERSATION_ID,
      });
      emitter.emit('conversation.messages.refresh', {
        conversation_id: CONVERSATION_ID,
        expectedTerminalMessageId: 'msg-user',
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(75);
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-user', 'msg-assistant']);
  });

  it('prepends older pages by cursor without duplicating overlap', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-2', 'middle'), createTextMessage('msg-3', 'newest')],
        oldest_cursor: 'cursor-msg-2',
        newest_cursor: 'cursor-msg-3',
        has_more_before: true,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-1', 'oldest'), createTextMessage('msg-2', 'middle')],
        oldest_cursor: 'cursor-msg-1',
        newest_cursor: 'cursor-msg-2',
        has_more_before: false,
        has_more_after: true,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.pagination.loadOlderMessages();
    });

    expect(invoke).toHaveBeenNthCalledWith(2, {
      conversation_id: CONVERSATION_ID,
      limit: 200,
      before: 'cursor-msg-2',
      content_mode: 'compact',
    });
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(result.current.pagination.hasOlderMessages).toBe(false);
  });

  it('loads repeated older cursor pages to the beginning without losing turns', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-5', 'recent'), createTextMessage('msg-6', 'newest')],
        oldest_cursor: 'cursor-msg-5',
        newest_cursor: 'cursor-msg-6',
        has_more_before: true,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-3', 'older'), createTextMessage('msg-4', 'middle')],
        oldest_cursor: 'cursor-msg-3',
        newest_cursor: 'cursor-msg-4',
        has_more_before: true,
        has_more_after: true,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-1', 'oldest'), createTextMessage('msg-2', 'early')],
        oldest_cursor: 'cursor-msg-1',
        newest_cursor: 'cursor-msg-2',
        has_more_before: false,
        has_more_after: true,
      });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.pagination.loadOlderMessages();
    });
    await act(async () => {
      await result.current.pagination.loadOlderMessages();
    });

    expect(result.current.messages.map((message) => message.msg_id)).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
      'msg-4',
      'msg-5',
      'msg-6',
    ]);
    expect(result.current.pagination.loadedHistoricalMessages).toBe(6);
    expect(result.current.pagination.totalHistoricalMessages).toBe(6);
    expect(result.current.pagination.hasOlderMessages).toBe(false);
  });

  it('does not replace the current conversation with a stale initial history response', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const firstConversation = createDeferred<{
      items: IMessageText[];
      oldest_cursor: string | null;
      newest_cursor: string | null;
      has_more_before: boolean;
      has_more_after: boolean;
    }>();
    invoke.mockClear();
    invoke.mockReturnValueOnce(firstConversation.promise).mockResolvedValueOnce({
      items: [createTextMessage('msg-b', 'current', SECOND_CONVERSATION_ID)],
      oldest_cursor: 'cursor-msg-b',
      newest_cursor: 'cursor-msg-b',
      has_more_before: false,
      has_more_after: false,
    });

    const { result, rerender } = renderHook(({ conversationId }) => useMessageCacheHarness(conversationId), {
      initialProps: { conversationId: CONVERSATION_ID },
      wrapper: CacheWrapper,
    });

    rerender({ conversationId: SECOND_CONVERSATION_ID });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    firstConversation.resolve({
      items: [createTextMessage('msg-a', 'stale', CONVERSATION_ID)],
      oldest_cursor: 'cursor-msg-a',
      newest_cursor: 'cursor-msg-a',
      has_more_before: false,
      has_more_after: false,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.messages.map((message) => message.conversation_id)).toEqual([SECOND_CONVERSATION_ID]);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('current');
  });

  it('does not prepend a stale older page after switching conversations', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const olderConversationPage = createDeferred<{
      items: IMessageText[];
      oldest_cursor: string | null;
      newest_cursor: string | null;
      has_more_before: boolean;
      has_more_after: boolean;
    }>();
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-2', 'middle'), createTextMessage('msg-3', 'newest')],
        oldest_cursor: 'cursor-msg-2',
        newest_cursor: 'cursor-msg-3',
        has_more_before: true,
        has_more_after: false,
      })
      .mockReturnValueOnce(olderConversationPage.promise)
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-b', 'current', SECOND_CONVERSATION_ID)],
        oldest_cursor: 'cursor-msg-b',
        newest_cursor: 'cursor-msg-b',
        has_more_before: false,
        has_more_after: false,
      });

    const { result, rerender } = renderHook(({ conversationId }) => useMessageCacheHarness(conversationId), {
      initialProps: { conversationId: CONVERSATION_ID },
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      void result.current.pagination.loadOlderMessages();
    });
    rerender({ conversationId: SECOND_CONVERSATION_ID });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    olderConversationPage.resolve({
      items: [createTextMessage('msg-1', 'oldest', CONVERSATION_ID)],
      oldest_cursor: 'cursor-msg-1',
      newest_cursor: 'cursor-msg-1',
      has_more_before: false,
      has_more_after: true,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.messages.map((message) => message.conversation_id)).toEqual([SECOND_CONVERSATION_ID]);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('current');
  });

  it('loads every cursor page for complete transcript exports', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    invoke
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-5', 'recent'), createTextMessage('msg-6', 'newest')],
        oldest_cursor: 'cursor-msg-5',
        newest_cursor: 'cursor-msg-6',
        has_more_before: true,
        has_more_after: false,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-3', 'older'), createTextMessage('msg-4', 'middle')],
        oldest_cursor: 'cursor-msg-3',
        newest_cursor: 'cursor-msg-4',
        has_more_before: true,
        has_more_after: true,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-1', 'oldest'), createTextMessage('msg-2', 'early')],
        oldest_cursor: 'cursor-msg-1',
        newest_cursor: 'cursor-msg-2',
        has_more_before: false,
        has_more_after: true,
      });

    const messages = await fetchAllConversationMessages(CONVERSATION_ID, { contentMode: 'full' });

    expect(messages.map((message) => message.msg_id)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6']);
    expect(invoke).toHaveBeenNthCalledWith(2, {
      conversation_id: CONVERSATION_ID,
      limit: 200,
      before: 'cursor-msg-5',
      content_mode: 'full',
    });
    expect(invoke).toHaveBeenNthCalledWith(3, {
      conversation_id: CONVERSATION_ID,
      limit: 200,
      before: 'cursor-msg-3',
      content_mode: 'full',
    });
  });

  it('fails a full transcript load instead of silently accepting a repeated cursor', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockReset();
    invoke.mockResolvedValue({
      items: [createTextMessage('msg-1', 'stuck')],
      oldest_cursor: 'cursor-stuck',
      newest_cursor: 'cursor-stuck',
      has_more_before: true,
      has_more_after: false,
    });

    await expect(fetchAllConversationMessages(CONVERSATION_ID)).rejects.toThrow('cursor did not advance');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
