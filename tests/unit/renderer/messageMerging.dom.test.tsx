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
import type { IMessageAcpToolCall, IMessageText, IMessageThinking } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  useAddOrUpdateMessage,
  useMessageLstCache,
  useMessageList,
} from '@/renderer/pages/conversation/Messages/hooks';
import { fetchAllConversationMessages } from '@/renderer/utils/chat/messageHistory';

const { responseStreamHandlerRef } = vi.hoisted(() => ({
  responseStreamHandlerRef: {
    current: undefined as
      | ((message: { type: string; conversation_id: string; msg_id: string; data: unknown }) => void)
      | undefined,
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
