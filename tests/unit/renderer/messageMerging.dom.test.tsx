/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { IMessageAcpToolCall, IMessageText, IMessageThinking } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  useAddOrUpdateMessage,
  useMessageLstCache,
  useMessageList,
} from '@/renderer/pages/conversation/Messages/hooks';

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
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
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
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
    invoke.mockResolvedValue({ items: [], total: 0, has_more: false });

    renderHook(() => useMessageLstCache(CONVERSATION_ID), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith({
      conversation_id: CONVERSATION_ID,
      page: 1,
      page_size: 250,
      order: 'DESC',
      content_mode: 'compact',
    });
  });

  it('hydrates the newest history page chronologically and exposes older-page state', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue({
      items: [createTextMessage('msg-3', 'newest'), createTextMessage('msg-2', 'middle')],
      total: 3,
      has_more: true,
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
    expect(result.current.pagination.totalHistoricalMessages).toBe(3);
  });

  it('prepends older pages without duplicating overlap from offset pagination', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-3', 'newest'), createTextMessage('msg-2', 'middle')],
        total: 3,
        has_more: true,
      })
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-2', 'middle'), createTextMessage('msg-1', 'oldest')],
        total: 3,
        has_more: false,
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
      page: 2,
      page_size: 250,
      order: 'DESC',
      content_mode: 'compact',
    });
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(result.current.pagination.hasOlderMessages).toBe(false);
  });

  it('does not replace the current conversation with a stale initial history response', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    const firstConversation = createDeferred<{ items: IMessageText[]; total: number; has_more: boolean }>();
    invoke.mockClear();
    invoke.mockReturnValueOnce(firstConversation.promise).mockResolvedValueOnce({
      items: [createTextMessage('msg-b', 'current', SECOND_CONVERSATION_ID)],
      total: 1,
      has_more: false,
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
      total: 1,
      has_more: false,
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
    const olderConversationPage = createDeferred<{ items: IMessageText[]; total: number; has_more: boolean }>();
    invoke.mockClear();
    invoke
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-3', 'newest'), createTextMessage('msg-2', 'middle')],
        total: 3,
        has_more: true,
      })
      .mockReturnValueOnce(olderConversationPage.promise)
      .mockResolvedValueOnce({
        items: [createTextMessage('msg-b', 'current', SECOND_CONVERSATION_ID)],
        total: 1,
        has_more: false,
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
      total: 3,
      has_more: false,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.messages.map((message) => message.conversation_id)).toEqual([SECOND_CONVERSATION_ID]);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('current');
  });
});
