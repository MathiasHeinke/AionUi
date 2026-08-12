/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DelegatedTaskProjection } from '@/common/chat/delegationActivity';
import { projectDelegatedTasksFromMessage } from '@/common/chat/delegationActivity';
import type { TMessage } from '@/common/chat/chatLib';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { useCallback, useSyncExternalStore } from 'react';

const EMPTY_ACTIVITY: readonly DelegatedTaskProjection[] = Object.freeze([]);
const MAX_VISIBLE_DELEGATED_TASKS = 6;
const snapshots = new Map<string, readonly DelegatedTaskProjection[]>();
type LiveDelegationObservation = {
  task: DelegatedTaskProjection;
  acpSessionId: string;
  epoch: number;
};

export type CurrentLiveDelegationObservation = Pick<LiveDelegationObservation, 'acpSessionId' | 'epoch'>;

const liveSnapshots = new Map<string, Map<string, LiveDelegationObservation>>();
const liveSessionByConversation = new Map<string, string>();
const liveEpochByConversation = new Map<string, number>();
const listeners = new Set<() => void>();

const liveEpochForConversation = (conversationId: string): number => liveEpochByConversation.get(conversationId) ?? 0;
const advanceLiveEpoch = (conversationId: string): number => {
  const next = liveEpochForConversation(conversationId) + 1;
  liveEpochByConversation.set(conversationId, next);
  return next;
};

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

const notify = (): void => listeners.forEach((listener) => listener());

const downgradeObservedLive = (conversationId?: string): void => {
  const conversationIds = conversationId
    ? [conversationId]
    : Array.from(new Set([...snapshots.keys(), ...liveSnapshots.keys(), ...liveSessionByConversation.keys()]));
  let changed = false;

  for (const id of conversationIds) {
    advanceLiveEpoch(id);
    liveSnapshots.delete(id);
    liveSessionByConversation.delete(id);
    const previous = snapshots.get(id) ?? EMPTY_ACTIVITY;
    const next = sortAndLimit(previous.map((task) => (task.observedLive ? { ...task, observedLive: false } : task)));
    if (sameActivity(previous, next)) continue;
    snapshots.set(id, next);
    changed = true;
  }
  if (changed) notify();
};

const acpSessionIdFromMessage = (message: TMessage): string | null => {
  if (message.type !== 'acp_tool_call') return null;
  const sessionId = message.content.session_id;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
};

/**
 * Bind the legacy observation cache to the ACP session before a turn can emit
 * its first delegation. A different session invalidates any prior live claim
 * immediately; the next tool update may then establish new provenance.
 */
export function bindConversationDelegationActivitySession(conversationId: string, acpSessionId: string): void {
  const sessionId = acpSessionId.trim();
  if (!conversationId || !sessionId) return;

  const previousSessionId = liveSessionByConversation.get(conversationId);
  if (previousSessionId !== undefined && previousSessionId !== sessionId) {
    downgradeObservedLive(conversationId);
  }
  liveSessionByConversation.set(conversationId, sessionId);
}

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
  const byTaskId = new Map(
    deriveConversationDelegationActivity(messages, conversationId).map((task) => [task.id, task])
  );
  for (const [taskId, live] of liveSnapshots.get(conversationId) ?? []) {
    if (live.epoch !== liveEpochForConversation(conversationId)) continue;
    byTaskId.set(taskId, { ...byTaskId.get(taskId), ...live.task, observedLive: true });
  }
  const next = sortAndLimit(byTaskId.values());
  const previous = snapshots.get(conversationId) ?? EMPTY_ACTIVITY;
  if (sameActivity(previous, next)) return;
  snapshots.set(conversationId, next);
  notify();
}

/**
 * Record only renderer-observed ACP updates for this session/epoch. A reconnect,
 * ACP session rotation or seat rebind invalidates the observation before any
 * later chat/history projection can reuse it.
 */
export function publishLiveConversationDelegationActivity(conversationId: string, message: TMessage): void {
  if (!conversationId || message.conversation_id !== conversationId) return;
  const tasks = projectDelegatedTasksFromMessage(message);
  if (tasks.length === 0) return;
  const acpSessionId = acpSessionIdFromMessage(message);
  if (!acpSessionId) {
    downgradeObservedLive(conversationId);
    return;
  }

  const previousSessionId = liveSessionByConversation.get(conversationId);
  const sessionRotated = previousSessionId !== undefined && previousSessionId !== acpSessionId;
  bindConversationDelegationActivitySession(conversationId, acpSessionId);

  const live = liveSnapshots.get(conversationId) ?? new Map<string, LiveDelegationObservation>();
  for (const task of tasks) {
    live.set(task.id, {
      task: { ...task, observedLive: true },
      acpSessionId,
      epoch: liveEpochForConversation(conversationId),
    });
  }
  liveSnapshots.set(conversationId, live);

  const byTaskId = new Map((snapshots.get(conversationId) ?? EMPTY_ACTIVITY).map((task) => [task.id, task]));
  for (const { task, epoch } of live.values()) {
    if (epoch === liveEpochForConversation(conversationId)) byTaskId.set(task.id, task);
  }
  const next = sortAndLimit(byTaskId.values());
  if (!sessionRotated && sameActivity(snapshots.get(conversationId) ?? EMPTY_ACTIVITY, next)) return;
  snapshots.set(conversationId, next);
  notify();
}

/** Current live provenance is only available for observations in this epoch. */
export function getCurrentLiveDelegationObservation(
  conversationId: string,
  taskId: string
): CurrentLiveDelegationObservation | null {
  const observation = liveSnapshots.get(conversationId)?.get(taskId);
  if (!observation || observation.epoch !== liveEpochForConversation(conversationId)) return null;
  return { acpSessionId: observation.acpSessionId, epoch: observation.epoch };
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
  liveSessionByConversation.clear();
  liveEpochByConversation.clear();
  notify();
}

ipcBridge.conversation.realtimeConnected?.on(({ reconnected }) => {
  if (reconnected) downgradeObservedLive();
});
configService.onSeatRebind?.(() => downgradeObservedLive());
