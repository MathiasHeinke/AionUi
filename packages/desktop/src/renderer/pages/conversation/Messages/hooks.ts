/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AgentStreamErrorInfo, IMessageText, IMessageTips, TMessage } from '@/common/chat/chatLib';
import {
  composeMessage,
  mergeAcpToolCallContent,
  mergeTextMessageContent,
  normalizeAgentStreamError,
  preferTextMessageVersion,
} from '@/common/chat/chatLib';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createContext } from '@renderer/utils/ui/createContext';
import { addEventListener } from '@/renderer/utils/emitter';

const MESSAGE_HISTORY_PAGE_SIZE = 200;
const TERMINAL_RECONCILE_DELAY_MS = 75;
const TERMINAL_RECONCILE_RETRY_DELAY_MS = 600;
const TERMINAL_RECONCILE_MAX_ATTEMPTS = 6;
const RECOVERY_RECONCILE_MAX_ATTEMPTS = 20;
const RECOVERY_RECONCILE_MIN_ATTEMPTS = 4;

const [useMessageList, MessageListProvider, useUpdateMessageList] = createContext([] as TMessage[]);
const [useMessageListLoading, MessageListLoadingProvider, useUpdateMessageListLoading] = createContext(false);

const [useChatKey, ChatKeyProvider] = createContext('');

const beforeUpdateMessageListStack: Array<(list: TMessage[]) => TMessage[]> = [];

export type MessageHistoryPagination = {
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  loadedHistoricalMessages: number;
  totalHistoricalMessages: number;
  loadOlderMessages: () => Promise<void>;
};

export const emptyMessageHistoryPagination: MessageHistoryPagination = {
  hasOlderMessages: false,
  isLoadingOlderMessages: false,
  loadedHistoricalMessages: 0,
  totalHistoricalMessages: 0,
  loadOlderMessages: async () => {},
};

// 消息索引缓存类型定义
// Message index cache type definitions
interface MessageIndex {
  msgIdIndex: Map<string, number>; // msg_id -> index
  call_idIndex: Map<string, number>; // tool_call.call_id -> index
  tool_call_idIndex: Map<string, number>; // acp_tool_call.update.tool_call_id -> index
  permission_call_idIndex: Map<string, number>; // permission.content.call_id -> index
}

function getMessageIndexKey(message: TMessage): string | undefined {
  if (!message.msg_id) return undefined;
  return message.type === 'thinking' ? `thinking:${message.msg_id}` : message.msg_id;
}

// 使用 WeakMap 缓存索引，当列表被 GC 时自动清理
// Use WeakMap to cache index, auto-cleanup when list is GC'd
const indexCache = new WeakMap<TMessage[], MessageIndex>();

export function logDroppedToolCallWithoutCallId(message: TMessage | undefined): boolean {
  if (!message) return false;
  if (message.type !== 'tool_call' || message.content?.call_id) return false;

  console.warn('[tool-call] dropped tool_call without call_id', {
    conversation_id: message.conversation_id,
    msg_id: message.msg_id,
    name: message.content?.name,
    status: message.content?.status,
  });
  return true;
}

// 构建消息索引
// Build message index
function buildMessageIndex(list: TMessage[]): MessageIndex {
  const msgIdIndex = new Map<string, number>();
  const call_idIndex = new Map<string, number>();
  const tool_call_idIndex = new Map<string, number>();
  const permission_call_idIndex = new Map<string, number>();

  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    const msgIndexKey = getMessageIndexKey(msg);
    if (msgIndexKey) {
      msgIdIndex.set(msgIndexKey, i);
    }
    if (msg.type === 'tool_call' && msg.content?.call_id) {
      call_idIndex.set(msg.content.call_id, i);
    }
    if (msg.type === 'acp_tool_call' && msg.content?.update?.tool_call_id) {
      tool_call_idIndex.set(msg.content.update.tool_call_id, i);
    }
    if (msg.type === 'permission' && msg.content?.call_id) {
      permission_call_idIndex.set(msg.content.call_id, i);
    }
  }

  return { msgIdIndex, call_idIndex, tool_call_idIndex, permission_call_idIndex };
}

// 获取或构建索引（带缓存）
// Get or build index with caching
function getOrBuildIndex(list: TMessage[]): MessageIndex {
  let cached = indexCache.get(list);
  if (!cached) {
    cached = buildMessageIndex(list);
    indexCache.set(list, cached);
  }
  return cached;
}

// 使用索引优化的消息合并函数
// Index-optimized message compose function
function composeMessageWithIndex(message: TMessage | undefined, list: TMessage[], index: MessageIndex): TMessage[] {
  if (!message) return list || [];

  if (logDroppedToolCallWithoutCallId(message)) {
    return list || [];
  }

  if (!list?.length) {
    // Update index when adding first message
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) {
      index.msgIdIndex.set(msgIndexKey, 0);
    }
    return [message];
  }

  const last = list[list.length - 1];

  // 对于 tool_group 类型，使用原始的 composeMessage（因为涉及内部数组匹配）
  // For tool_group type, use original composeMessage (involves inner array matching)
  // After composeMessage, the returned list may have different length/ordering,
  // so we must invalidate the index to prevent stale lookups in subsequent calls.
  if (message.type === 'tool_group') {
    const result = composeMessage(message, list);
    if (result !== list) {
      // Rebuild index maps from the new list to keep them in sync
      const rebuilt = buildMessageIndex(result);
      index.msgIdIndex = rebuilt.msgIdIndex;
      index.call_idIndex = rebuilt.call_idIndex;
      index.tool_call_idIndex = rebuilt.tool_call_idIndex;
      index.permission_call_idIndex = rebuilt.permission_call_idIndex;
    }
    return result;
  }

  // tool_call: 使用 call_idIndex 快速查找
  // tool_call: use call_idIndex for fast lookup
  if (message.type === 'tool_call' && message.content?.call_id) {
    const existingIdx = index.call_idIndex.get(message.content.call_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'tool_call') {
        const newList = list.slice();
        const merged = { ...existingMsg.content, ...message.content };
        newList[existingIdx] = { ...existingMsg, content: merged };
        return newList;
      }
    }
    // 未找到，添加新消息并更新索引
    const newIdx = list.length;
    index.call_idIndex.set(message.content.call_id, newIdx);
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // acp_tool_call: use tool_call_idIndex for fast lookup
  if (message.type === 'acp_tool_call' && message.content?.update?.tool_call_id) {
    const existingIdx = index.tool_call_idIndex.get(message.content.update.tool_call_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'acp_tool_call') {
        const newList = list.slice();
        const merged = mergeAcpToolCallContent(existingMsg.content, message.content);
        newList[existingIdx] = { ...existingMsg, content: merged };
        return newList;
      }
    }
    // 未找到，添加新消息并更新索引
    const newIdx = list.length;
    index.tool_call_idIndex.set(message.content.update.tool_call_id, newIdx);
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // permission: use call_id for recovery/live stream dedupe.
  if (message.type === 'permission' && message.content?.call_id) {
    const existingIdx = index.permission_call_idIndex.get(message.content.call_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'permission') {
        const newList = list.slice();
        newList[existingIdx] = { ...existingMsg, ...message, content: message.content };
        return newList;
      }
    }
    const newIdx = list.length;
    index.permission_call_idIndex.set(message.content.call_id, newIdx);
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // text message: merge only with the latest contiguous streaming chunk.
  // text 消息: 只与最后一条连续的流式片段合并，保留被工具/思考打断后的消息边界。
  if (message.type === 'text' && message.msg_id) {
    const existingIdx = index.msgIdIndex.get(message.msg_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'text') {
        // User messages (right position) are complete — skip if already exists to prevent duplicates
        if (message.position === 'right') {
          return list;
        }
        // Complete teammate messages are not streaming chunks — skip if already exists
        if ((message.content as { teammateMessage?: boolean })?.teammateMessage) {
          return list;
        }
      }
    }

    if (last.type === 'text' && last.msg_id === message.msg_id) {
      const newList = list.slice();
      newList[newList.length - 1] = {
        ...last,
        content: mergeTextMessageContent(last.content, message.content),
      };
      return newList;
    }

    const newIdx = list.length;
    index.msgIdIndex.set(message.msg_id, newIdx);
    return list.concat(message);
  }

  // thinking message: merge only with the latest contiguous thinking chunk.
  // Uses "thinking:${msg_id}" key to avoid collision with text messages sharing the same msg_id.
  if (message.type === 'thinking' && message.msg_id) {
    const thinkingKey = `thinking:${message.msg_id}`;
    if (message.content.status === 'done') {
      const existingIdx = index.msgIdIndex.get(thinkingKey);
      if (existingIdx !== undefined && existingIdx < list.length) {
        const existingMsg = list[existingIdx];
        if (existingMsg.type === 'thinking') {
          const newList = list.slice();
          newList[existingIdx] = {
            ...existingMsg,
            content: {
              ...existingMsg.content,
              status: 'done' as const,
              duration: message.content.duration,
              subject: message.content.subject || existingMsg.content.subject,
            },
          };
          return newList;
        }
      }
    }

    if (last.type === 'thinking' && last.msg_id === message.msg_id) {
      const newList = list.slice();
      newList[newList.length - 1] = {
        ...last,
        content: {
          ...last.content,
          content: last.content.content + message.content.content,
          subject: message.content.subject || last.content.subject,
        },
      };
      return newList;
    }

    const newIdx = list.length;
    index.msgIdIndex.set(thinkingKey, newIdx);
    return list.concat(message);
  }

  // plan message: update content and move to end of list
  if (message.type === 'plan' && message.msg_id) {
    const existingIdx = index.msgIdIndex.get(message.msg_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      const newList = list.slice();
      newList.splice(existingIdx, 1);
      const updated = { ...existingMsg, ...message, content: message.content } as TMessage;
      newList.push(updated);
      // Rebuild index after splice
      const rebuilt = buildMessageIndex(newList);
      index.msgIdIndex = rebuilt.msgIdIndex;
      index.call_idIndex = rebuilt.call_idIndex;
      index.tool_call_idIndex = rebuilt.tool_call_idIndex;
      index.permission_call_idIndex = rebuilt.permission_call_idIndex;
      return newList;
    }
    const newIdx = list.length;
    index.msgIdIndex.set(message.msg_id, newIdx);
    return list.concat(message);
  }

  // agent_status / tips and other msg_id-based messages:
  // replace the existing item in place instead of appending duplicates.
  if (message.msg_id) {
    const existingIdx = index.msgIdIndex.get(message.msg_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      const newList = list.slice();
      newList[existingIdx] = {
        ...existingMsg,
        ...message,
        content: message.content,
      } as TMessage;
      return newList;
    }
  }

  // Other types: fallback to last message check
  // 其他类型: 回退到检查最后一条消息
  if (last.msg_id !== message.msg_id || last.type !== message.type) {
    // Add new message and update index
    const newIdx = list.length;
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // Merge other message types with same msg_id
  const newList = list.slice();
  const lastIdx = newList.length - 1;
  newList[lastIdx] = { ...last, ...message };
  return newList;
}

export const useAddOrUpdateMessage = () => {
  const update = useUpdateMessageList();
  const pendingRef = useRef<Array<{ message: TMessage; add: boolean }>>([]);
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    rafRef.current = null;

    const pending = pendingRef.current;
    if (!pending.length) return;
    pendingRef.current = [];
    update((list) => {
      // 获取或构建索引用于快速查找 (O(1) instead of O(n))
      // Get or build index for fast lookup
      const index = getOrBuildIndex(list);
      let newList = list;

      for (const item of pending) {
        if (!item.message) {
          continue;
        }

        if (logDroppedToolCallWithoutCallId(item.message)) {
          continue;
        }

        if (item.add) {
          // 新增消息，更新索引
          // New message, update index
          const msg = item.message;
          const newIdx = newList.length;
          const msgIndexKey = getMessageIndexKey(msg);
          if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
          if (msg.type === 'tool_call' && msg.content?.call_id) {
            index.call_idIndex.set(msg.content.call_id, newIdx);
          }
          if (msg.type === 'acp_tool_call' && msg.content?.update?.tool_call_id) {
            index.tool_call_idIndex.set(msg.content.update.tool_call_id, newIdx);
          }
          if (msg.type === 'permission' && msg.content?.call_id) {
            index.permission_call_idIndex.set(msg.content.call_id, newIdx);
          }
          newList = newList.concat(msg);
        } else {
          // 使用索引优化的消息合并
          // Use index-optimized message compose
          newList = composeMessageWithIndex(item.message, newList, index);
        }

        while (beforeUpdateMessageListStack.length) {
          newList = beforeUpdateMessageListStack.shift()!(newList);
        }
      }
      return newList;
    });

    rafRef.current = setTimeout(flush);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        clearTimeout(rafRef.current);
      }
    };
  }, []);

  return useCallback(
    (message: TMessage | undefined, add = false) => {
      if (!message) {
        return;
      }
      pendingRef.current.push({ message, add });
      if (rafRef.current === null) {
        rafRef.current = setTimeout(flush);
      }
    },
    [flush]
  );
};

export const useRemoveMessageByMsgId = () => {
  const update = useUpdateMessageList();

  return useCallback(
    (msgId: string) => {
      update((list) => list.filter((message) => message.msg_id !== msgId));
    },
    [update]
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJsonRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const normalizeTipType = (value: unknown, fallback: IMessageTips['content']['type']) =>
  value === 'success' || value === 'warning' || value === 'error' || value === 'info' ? value : fallback;

const normalizePersistedWorkspaceRuntimeError = (
  parsed: Record<string, unknown>,
  message: string
): AgentStreamErrorInfo | undefined => {
  if (
    parsed.code !== 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE' &&
    parsed.code !== 'WORKSPACE_PATH_CONTAINS_WHITESPACE_RUNTIME_UNSUPPORTED'
  ) {
    return undefined;
  }

  const details = isRecord(parsed.details) ? parsed.details : undefined;
  const workspacePath = typeof details?.workspace_path === 'string' ? details.workspace_path : undefined;
  if (!workspacePath) {
    return undefined;
  }

  const persistedError = isRecord(parsed.error) ? parsed.error : undefined;
  const detail = typeof persistedError?.detail === 'string' ? persistedError.detail : message;

  return {
    message,
    code: 'WORKSPACE_PATH_RUNTIME_UNAVAILABLE',
    ownership: 'aionui',
    detail,
    workspacePath,
    retryable: false,
    feedback_recommended: false,
  };
};

const classifyPersistedSendFailure = (
  parsed: Record<string, unknown>,
  message: string
): AgentStreamErrorInfo | undefined => {
  if (typeof parsed.source !== 'string' && typeof parsed.code !== 'string') {
    return undefined;
  }

  const persistedCode = typeof parsed.code === 'string' ? parsed.code : undefined;
  if (persistedCode === 'BAD_GATEWAY') {
    return {
      message,
      code: 'UNKNOWN_UPSTREAM_ERROR',
      ownership: 'unknown_upstream',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  if (persistedCode === 'INTERNAL_ERROR') {
    return {
      message,
      code: 'AIONUI_INTERNAL_ERROR',
      ownership: 'aionui',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  if (persistedCode?.startsWith('AIONUI_')) {
    return { message, code: persistedCode, ownership: 'aionui', detail: message, retryable: true };
  }
  if (persistedCode?.startsWith('USER_AGENT_')) {
    return { message, code: persistedCode, ownership: 'user_agent', detail: message, retryable: true };
  }
  if (persistedCode?.startsWith('USER_LLM_PROVIDER_')) {
    return {
      message,
      code: persistedCode,
      ownership: 'user_llm_provider',
      detail: message,
      retryable: false,
      feedback_recommended: false,
    };
  }
  if (persistedCode === 'UNKNOWN_UPSTREAM_ERROR') {
    return {
      message,
      code: persistedCode,
      ownership: 'unknown_upstream',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  if (parsed.source === 'send_failed') {
    return {
      message,
      code: 'AIONUI_INTERNAL_ERROR',
      ownership: 'aionui',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  return undefined;
};

const normalizeDbTipsMessage = (msg: TMessage): TMessage => {
  if (msg.type !== 'tips') return msg;
  const parsed = parseJsonRecord(msg.content);
  if (!parsed || typeof parsed.content !== 'string') return msg;

  const existingContent = isRecord(msg.content) ? msg.content : undefined;
  const fallbackType =
    existingContent?.type === 'success' ||
    existingContent?.type === 'warning' ||
    existingContent?.type === 'error' ||
    existingContent?.type === 'info'
      ? existingContent.type
      : 'error';
  const tipType = normalizeTipType(parsed.type, fallbackType);
  const code =
    typeof parsed.code === 'string'
      ? parsed.code
      : typeof existingContent?.code === 'string'
        ? existingContent.code
        : undefined;
  const params = isRecord(parsed.params)
    ? parsed.params
    : isRecord(existingContent?.params)
      ? existingContent.params
      : undefined;
  const structuredError =
    tipType === 'error'
      ? (normalizePersistedWorkspaceRuntimeError(parsed, parsed.content) ??
        normalizeAgentStreamError(parsed.error) ??
        classifyPersistedSendFailure(parsed, parsed.content) ??
        normalizeAgentStreamError({ ...parsed, message: parsed.content }))
      : undefined;

  return {
    ...msg,
    content: {
      content: parsed.content,
      type: tipType,
      ...(tipType !== 'error' && code ? { code } : {}),
      ...(tipType !== 'error' && params ? { params } : {}),
      ...(structuredError ? { error: structuredError } : {}),
    },
  } as IMessageTips;
};

/**
 * Normalize a message loaded from backend DB: if `content` is a JSON string,
 * parse it and map stored fields to renderer message content.
 */
export function normalizeDbMessage(msg: TMessage): TMessage {
  if (msg.type === 'tips') return normalizeDbTipsMessage(msg);
  if (msg.type !== 'text') return msg;
  const raw = msg.content as unknown;
  if (typeof raw !== 'string') return msg;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.content !== 'string') return msg;
    return {
      ...msg,
      content: {
        content: parsed.content as string,
        ...(parsed.teammate_message ? { teammateMessage: true } : {}),
        ...(parsed.sender_name ? { senderName: parsed.sender_name as string } : {}),
        ...(parsed.sender_backend ? { senderAgentType: parsed.sender_backend as string } : {}),
        ...(parsed.sender_conversation_id ? { senderConversationId: parsed.sender_conversation_id as string } : {}),
      },
    };
  } catch {
    return msg;
  }
}

export function buildConversationHistoryPageRequest(conversation_id: string, before?: string) {
  return {
    conversation_id,
    limit: MESSAGE_HISTORY_PAGE_SIZE,
    ...(before ? { before } : {}),
    content_mode: 'compact' as const,
  };
}

export function toChronologicalHistoryPage(messages: TMessage[]): TMessage[] {
  return messages;
}

function getMessageIdentity(message: TMessage): string {
  return message.msg_id ? `msg:${message.msg_id}:${message.type}` : `id:${message.id}`;
}

export function mergeInitialHistoryMessages(
  currentList: TMessage[],
  historyMessages: TMessage[],
  conversation_id: string
): TMessage[] {
  if (!currentList.length) return historyMessages;
  const sameConversation = currentList.filter((message) => message.conversation_id === conversation_id);
  if (!sameConversation.length) return historyMessages;
  const dbIds = new Set(historyMessages.map((message) => message.id));
  const dbMsgIds = new Set(historyMessages.map((message) => message.msg_id).filter(Boolean));

  const streamingByMsgId = new Map<string, IMessageText>();
  for (const message of sameConversation) {
    if (message.msg_id && message.type === 'text' && dbMsgIds.has(message.msg_id)) {
      streamingByMsgId.set(message.msg_id, message);
    }
  }

  const mergedMessages = historyMessages.map((dbMsg) => {
    if (!dbMsg.msg_id || dbMsg.type !== 'text') return dbMsg;
    const streamMsg = streamingByMsgId.get(dbMsg.msg_id);
    if (!streamMsg) return dbMsg;
    return preferTextMessageVersion(dbMsg, streamMsg);
  });

  const streamingOnly = sameConversation.filter(
    (message) => !dbIds.has(message.id) && !(message.msg_id && dbMsgIds.has(message.msg_id))
  );
  if (!streamingOnly.length && !streamingByMsgId.size) return historyMessages;
  return [...mergedMessages, ...streamingOnly];
}

export function reconcileHistoryMessages(
  currentList: TMessage[],
  historyMessages: TMessage[],
  conversation_id: string
): TMessage[] {
  const currentConversation = currentList.filter((message) => message.conversation_id === conversation_id);
  const persistedConversation = historyMessages.filter((message) => message.conversation_id === conversation_id);
  if (!currentConversation.length) return persistedConversation;
  if (!persistedConversation.length) return currentConversation;

  const persistedById = new Map(persistedConversation.map((message) => [message.id, message]));
  const matches = new Map<TMessage, TMessage>();
  const consumed = new Set<TMessage>();

  for (const current of currentConversation) {
    const persisted = persistedById.get(current.id);
    if (!persisted || consumed.has(persisted)) continue;
    matches.set(current, persisted);
    consumed.add(persisted);
  }

  const currentByIdentity = new Map<string, TMessage[]>();
  const persistedByIdentity = new Map<string, TMessage[]>();
  for (const current of currentConversation) {
    if (matches.has(current)) continue;
    const identity = getMessageIdentity(current);
    const candidates = currentByIdentity.get(identity) ?? [];
    candidates.push(current);
    currentByIdentity.set(identity, candidates);
  }
  for (const persisted of persistedConversation) {
    if (consumed.has(persisted)) continue;
    const identity = getMessageIdentity(persisted);
    const candidates = persistedByIdentity.get(identity) ?? [];
    candidates.push(persisted);
    persistedByIdentity.set(identity, candidates);
  }

  for (const [identity, currentCandidates] of currentByIdentity) {
    const persistedCandidates = persistedByIdentity.get(identity);
    if (!persistedCandidates?.length) continue;
    let currentIndex = currentCandidates.length - 1;
    let persistedIndex = persistedCandidates.length - 1;
    while (currentIndex >= 0 && persistedIndex >= 0) {
      const current = currentCandidates[currentIndex--];
      const persisted = persistedCandidates[persistedIndex--];
      matches.set(current, persisted);
      consumed.add(persisted);
    }
  }

  let changed = currentConversation.length !== currentList.length;
  const reconciled = currentConversation.map((current) => {
    const persisted = matches.get(current);
    if (!persisted || current.type !== 'text' || persisted.type !== 'text') return current;
    const preferred = preferTextMessageVersion(persisted, current);
    if (preferred !== current) changed = true;
    return preferred;
  });

  for (const persisted of persistedConversation) {
    if (consumed.has(persisted)) continue;
    reconciled.push(persisted);
    changed = true;
  }

  return changed ? reconciled : currentList;
}

export function prependOlderHistoryMessages(
  currentList: TMessage[],
  olderMessages: TMessage[],
  conversation_id: string
): TMessage[] {
  const conversationMessages = olderMessages.filter((message) => message.conversation_id === conversation_id);
  if (!conversationMessages.length) return currentList;
  if (!currentList.length) return conversationMessages;

  const existingIds = new Set(currentList.map((message) => message.id));
  const existingIdentities = new Set(currentList.map(getMessageIdentity));
  const olderUnique = conversationMessages.filter(
    (message) => !existingIds.has(message.id) && !existingIdentities.has(getMessageIdentity(message))
  );
  if (!olderUnique.length) return currentList;
  return [...olderUnique, ...currentList];
}

export function shouldLoadOlderConversationMessages(input: {
  scrollTop: number;
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  visibleMessageCount: number;
}): boolean {
  return (
    input.hasOlderMessages && !input.isLoadingOlderMessages && input.visibleMessageCount > 0 && input.scrollTop <= 160
  );
}

export const useMessageLstCache = (key: string) => {
  const update = useUpdateMessageList();
  const setLoading = useUpdateMessageListLoading();
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [loadedHistoricalMessages, setLoadedHistoricalMessages] = useState(0);
  const [totalHistoricalMessages, setTotalHistoricalMessages] = useState(0);
  const oldestCursorRef = useRef<string | null>(null);
  const hasOlderMessagesRef = useRef(false);
  const isLoadingOlderMessagesRef = useRef(false);
  const loadedHistoricalMessagesRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const loadingSequenceRef = useRef(0);

  const setOlderAvailability = useCallback((value: boolean) => {
    hasOlderMessagesRef.current = value;
    setHasOlderMessages(value);
  }, []);

  const loadMessages = useCallback(async (): Promise<TMessage[]> => {
    const generation = loadGenerationRef.current;
    const result = await ipcBridge.database.getConversationMessages.invoke(buildConversationHistoryPageRequest(key));
    if (generation !== loadGenerationRef.current) return [];
    const messages = toChronologicalHistoryPage(result?.items?.map(normalizeDbMessage) ?? []);
    if (messages && Array.isArray(messages)) {
      update((currentList) => {
        return mergeInitialHistoryMessages(currentList, messages, key);
      });
      oldestCursorRef.current = result.oldest_cursor;
      loadedHistoricalMessagesRef.current = messages.length;
      setLoadedHistoricalMessages(messages.length);
      setTotalHistoricalMessages(messages.length);
      setOlderAvailability(result.has_more_before);
      return messages;
    }
    return [];
  }, [key, setOlderAvailability, update]);

  const reconcileMessages = useCallback(
    async (expectedTerminalMessageId: string): Promise<boolean> => {
      const generation = loadGenerationRef.current;
      const result = await ipcBridge.database.getConversationMessages.invoke(buildConversationHistoryPageRequest(key));
      if (generation !== loadGenerationRef.current) return true;
      const messages = toChronologicalHistoryPage(result?.items?.map(normalizeDbMessage) ?? []);
      update((currentList) => reconcileHistoryMessages(currentList, messages, key));
      return expectedTerminalMessageId
        ? messages.some(
            (message) => message.id === expectedTerminalMessageId || message.msg_id === expectedTerminalMessageId
          )
        : messages.length > 0;
    },
    [key, update]
  );

  const loadOlderMessages = useCallback(async (): Promise<void> => {
    if (!key || isLoadingOlderMessagesRef.current || !hasOlderMessagesRef.current) return;

    const before = oldestCursorRef.current;
    if (!before) {
      setOlderAvailability(false);
      return;
    }
    const generation = loadGenerationRef.current;
    isLoadingOlderMessagesRef.current = true;
    setIsLoadingOlderMessages(true);
    try {
      const result = await ipcBridge.database.getConversationMessages.invoke(
        buildConversationHistoryPageRequest(key, before)
      );
      if (generation !== loadGenerationRef.current) return;
      const olderMessages = toChronologicalHistoryPage(result?.items?.map(normalizeDbMessage) ?? []);
      if (!olderMessages.length) {
        setOlderAvailability(false);
        return;
      }

      update((currentList) => prependOlderHistoryMessages(currentList, olderMessages, key));
      oldestCursorRef.current = result.oldest_cursor;
      loadedHistoricalMessagesRef.current += olderMessages.length;
      setLoadedHistoricalMessages(loadedHistoricalMessagesRef.current);
      setTotalHistoricalMessages(loadedHistoricalMessagesRef.current);
      setOlderAvailability(result.has_more_before);
    } catch (error) {
      console.error('[useMessageLstCache] Failed to load older messages from database:', error);
    } finally {
      if (generation === loadGenerationRef.current) {
        isLoadingOlderMessagesRef.current = false;
        setIsLoadingOlderMessages(false);
      }
    }
  }, [key, setOlderAvailability, update]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const loadingSequence = ++loadingSequenceRef.current;
    loadGenerationRef.current += 1;
    isLoadingOlderMessagesRef.current = false;
    setLoading(true);
    setIsLoadingOlderMessages(false);
    oldestCursorRef.current = null;
    loadedHistoricalMessagesRef.current = 0;
    setLoadedHistoricalMessages(0);
    setTotalHistoricalMessages(0);
    setOlderAvailability(false);
    void loadMessages()
      .catch((error) => {
        console.error('[useMessageLstCache] Failed to load messages from database:', error);
      })
      .finally(() => {
        if (!cancelled && loadingSequence === loadingSequenceRef.current) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, loadMessages, setLoading, setOlderAvailability]);

  useEffect(() => {
    if (!key) {
      return;
    }

    return ipcBridge.conversation.userCreated.on((payload) => {
      if (payload.conversation_id !== key) {
        return;
      }

      update((list) => {
        const index = getOrBuildIndex(list);
        return composeMessageWithIndex(
          {
            id: payload.msg_id,
            msg_id: payload.msg_id,
            conversation_id: payload.conversation_id,
            type: 'text',
            position: payload.position,
            status: payload.status,
            hidden: payload.hidden,
            created_at: payload.created_at,
            content: {
              content: payload.content,
            },
          },
          list,
          index
        );
      });
    });
  }, [key, update]);

  useEffect(() => {
    if (!key) return;

    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileSequence = 0;

    const beginReconcileLoading = (): number => {
      const loadingSequence = ++loadingSequenceRef.current;
      setLoading(true);
      return loadingSequence;
    };

    const settleReconcileLoading = (loadingSequence: number): void => {
      if (loadingSequence === loadingSequenceRef.current) setLoading(false);
    };

    const scheduleReconcile = (
      sequence: number,
      terminalMessageId: string,
      attempt: number,
      delay: number,
      minimumAttempts = 1,
      maximumAttempts = TERMINAL_RECONCILE_MAX_ATTEMPTS,
      onSettled?: () => void
    ) => {
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void reconcileMessages(terminalMessageId)
          .then((foundTerminalMessage) => {
            if (
              sequence !== reconcileSequence ||
              (foundTerminalMessage && attempt >= minimumAttempts) ||
              attempt >= maximumAttempts
            ) {
              if (sequence === reconcileSequence) onSettled?.();
              return;
            }
            scheduleReconcile(
              sequence,
              terminalMessageId,
              attempt + 1,
              TERMINAL_RECONCILE_RETRY_DELAY_MS,
              minimumAttempts,
              maximumAttempts,
              onSettled
            );
          })
          .catch((error) => {
            if (sequence === reconcileSequence && attempt < maximumAttempts) {
              scheduleReconcile(
                sequence,
                terminalMessageId,
                attempt + 1,
                TERMINAL_RECONCILE_RETRY_DELAY_MS,
                minimumAttempts,
                maximumAttempts,
                onSettled
              );
              return;
            }
            if (sequence === reconcileSequence) onSettled?.();
            console.error('[useMessageLstCache] Failed to reconcile completed turn:', error);
          });
      }, delay);
    };

    const unsubscribeResponse = ipcBridge.conversation.responseStream.on((message) => {
      if (message.conversation_id !== key || (message.type !== 'finish' && message.type !== 'error')) {
        return;
      }

      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileSequence += 1;
      const sequence = reconcileSequence;
      const loadingSequence = beginReconcileLoading();
      // The WebSocket is the fast path; the persisted transcript is the durable
      // truth. Reconcile shortly after a terminal frame so a transient renderer
      // listener gap or reconnect cannot leave an active chat blank until remount.
      scheduleReconcile(sequence, message.msg_id, 1, TERMINAL_RECONCILE_DELAY_MS, 1, undefined, () => {
        if (sequence === reconcileSequence) settleReconcileLoading(loadingSequence);
      });
    });

    const scheduleRecoveryReconcile = (expectedTerminalMessageId = '') => {
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileSequence += 1;
      const sequence = reconcileSequence;
      const loadingSequence = beginReconcileLoading();
      // Runtime-idle can beat durable transcript persistence by more than one
      // database read. Keep reconciling for a bounded window and require actual
      // transcript evidence before the empty-slot handoff can reappear.
      scheduleReconcile(
        sequence,
        expectedTerminalMessageId,
        1,
        TERMINAL_RECONCILE_DELAY_MS,
        expectedTerminalMessageId ? 1 : RECOVERY_RECONCILE_MIN_ATTEMPTS,
        RECOVERY_RECONCILE_MAX_ATTEMPTS,
        () => {
          if (sequence === reconcileSequence) settleReconcileLoading(loadingSequence);
        }
      );
    };

    const unsubscribeResync = ipcBridge.conversation.realtimeResyncRequired.on(() => scheduleRecoveryReconcile());
    const unsubscribeConnected = ipcBridge.conversation.realtimeConnected.on(({ reconnected }) => {
      if (reconnected) scheduleRecoveryReconcile();
    });
    const unsubscribeExplicitRefresh = addEventListener('conversation.messages.refresh', (event) => {
      if (event.conversation_id === key) scheduleRecoveryReconcile(event.expectedTerminalMessageId);
    });

    return () => {
      reconcileSequence += 1;
      loadingSequenceRef.current += 1;
      unsubscribeResponse();
      unsubscribeResync();
      unsubscribeConnected();
      unsubscribeExplicitRefresh();
      if (reconcileTimer) clearTimeout(reconcileTimer);
      setLoading(false);
    };
  }, [key, reconcileMessages, setLoading]);

  return useMemo<MessageHistoryPagination>(
    () => ({
      hasOlderMessages,
      isLoadingOlderMessages,
      loadedHistoricalMessages,
      totalHistoricalMessages,
      loadOlderMessages,
    }),
    [hasOlderMessages, isLoadingOlderMessages, loadOlderMessages, loadedHistoricalMessages, totalHistoricalMessages]
  );
};

export const beforeUpdateMessageList = (fn: (list: TMessage[]) => TMessage[]) => {
  beforeUpdateMessageListStack.push(fn);
  return () => {
    beforeUpdateMessageListStack.splice(beforeUpdateMessageListStack.indexOf(fn), 1);
  };
};
export {
  ChatKeyProvider,
  MessageListLoadingProvider,
  MessageListProvider,
  useChatKey,
  useMessageList,
  useMessageListLoading,
  useUpdateMessageList,
};
