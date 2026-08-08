/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DelegatedTaskProjection } from '@/common/chat/delegationActivity';
import { projectDelegatedTasksFromMessage } from '@/common/chat/delegationActivity';
import type { TMessage } from '@/common/chat/chatLib';
import { useCallback, useSyncExternalStore } from 'react';

const EMPTY_ACTIVITY: readonly DelegatedTaskProjection[] = Object.freeze([]);
const MAX_VISIBLE_DELEGATED_TASKS = 6;
const snapshots = new Map<string, readonly DelegatedTaskProjection[]>();
const listeners = new Set<() => void>();

const sameActivity = (left: readonly DelegatedTaskProjection[], right: readonly DelegatedTaskProjection[]): boolean =>
  left.length === right.length &&
  left.every((item, index) => {
    const candidate = right[index];
    return (
      candidate?.id === item.id &&
      candidate.goal === item.goal &&
      candidate.status === item.status &&
      candidate.agentId === item.agentId &&
      candidate.createdAt === item.createdAt
    );
  });

export function deriveConversationDelegationActivity(
  messages: readonly TMessage[],
  conversationId: string
): readonly DelegatedTaskProjection[] {
  if (!conversationId) return EMPTY_ACTIVITY;

  const byTaskId = new Map<string, DelegatedTaskProjection>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.conversation_id !== conversationId) continue;
    for (const task of projectDelegatedTasksFromMessage(message)) {
      if (!byTaskId.has(task.id)) byTaskId.set(task.id, task);
    }
  }

  return Array.from(byTaskId.values())
    .toSorted((left, right) => {
      const leftActive = left.status === 'pending' || left.status === 'in_progress';
      const rightActive = right.status === 'pending' || right.status === 'in_progress';
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return right.createdAt - left.createdAt;
    })
    .slice(0, MAX_VISIBLE_DELEGATED_TASKS);
}

export function publishConversationDelegationActivity(conversationId: string, messages: readonly TMessage[]): void {
  if (!conversationId) return;
  const next = deriveConversationDelegationActivity(messages, conversationId);
  const previous = snapshots.get(conversationId) ?? EMPTY_ACTIVITY;
  if (sameActivity(previous, next)) return;
  snapshots.set(conversationId, next);
  listeners.forEach((listener) => listener());
}

export function useConversationDelegationActivity(conversationId: string): readonly DelegatedTaskProjection[] {
  const getSnapshot = useCallback(
    () => (conversationId ? (snapshots.get(conversationId) ?? EMPTY_ACTIVITY) : EMPTY_ACTIVITY),
    [conversationId]
  );
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    getSnapshot
  );
}

export function resetConversationDelegationActivityForTest(): void {
  snapshots.clear();
  listeners.forEach((listener) => listener());
}
