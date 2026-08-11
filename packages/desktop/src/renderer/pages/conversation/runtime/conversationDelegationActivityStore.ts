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
const liveSnapshots = new Map<string, Map<string, DelegatedTaskProjection>>();
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
      candidate.createdAt === item.createdAt &&
      candidate.delegationId === item.delegationId &&
      candidate.backgroundDispatched === item.backgroundDispatched &&
      candidate.observedLive === item.observedLive
    );
  });

const sortAndLimit = (items: Iterable<DelegatedTaskProjection>): readonly DelegatedTaskProjection[] =>
  Array.from(items)
    .toSorted((left, right) => {
      const leftActive = left.status === 'pending' || left.status === 'in_progress';
      const rightActive = right.status === 'pending' || right.status === 'in_progress';
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return right.createdAt - left.createdAt;
    })
    .slice(0, MAX_VISIBLE_DELEGATED_TASKS);

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

  return sortAndLimit(byTaskId.values());
}

export function publishConversationDelegationActivity(conversationId: string, messages: readonly TMessage[]): void {
  if (!conversationId) return;
  const byTaskId = new Map(deriveConversationDelegationActivity(messages, conversationId).map((task) => [task.id, task]));
  for (const [taskId, live] of liveSnapshots.get(conversationId) ?? []) {
    byTaskId.set(taskId, { ...byTaskId.get(taskId), ...live, observedLive: true });
  }
  const next = sortAndLimit(byTaskId.values());
  const previous = snapshots.get(conversationId) ?? EMPTY_ACTIVITY;
  if (sameActivity(previous, next)) return;
  snapshots.set(conversationId, next);
  listeners.forEach((listener) => listener());
}

/**
 * Record only renderer-observed stream updates. This in-memory epoch survives
 * conversation switches and socket reconnects, but intentionally resets on an
 * app restart; historical chat alone can therefore never claim a live worker.
 */
export function publishLiveConversationDelegationActivity(conversationId: string, message: TMessage): void {
  if (!conversationId || message.conversation_id !== conversationId) return;
  const tasks = projectDelegatedTasksFromMessage(message);
  if (tasks.length === 0) return;
  const live = liveSnapshots.get(conversationId) ?? new Map<string, DelegatedTaskProjection>();
  for (const task of tasks) live.set(task.id, { ...task, observedLive: true });
  liveSnapshots.set(conversationId, live);

  const byTaskId = new Map((snapshots.get(conversationId) ?? EMPTY_ACTIVITY).map((task) => [task.id, task]));
  for (const task of live.values()) byTaskId.set(task.id, task);
  const next = sortAndLimit(byTaskId.values());
  if (sameActivity(snapshots.get(conversationId) ?? EMPTY_ACTIVITY, next)) return;
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
  liveSnapshots.clear();
  listeners.forEach((listener) => listener());
}
