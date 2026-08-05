/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { emitter } from '@/renderer/utils/emitter';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  conversationDeleted,
  getConversationRuntimeViewSnapshot,
  hydrateFailed,
  hydrateStarted,
  hydrateSucceeded,
  localSendAccepted,
  localSendFailed,
  localSendStarted,
  localStopAcknowledged,
  localStopRequested,
  resetLocalGate,
  subscribeConversationRuntimeView,
  turnCompleted,
  type ConversationRuntimeView,
  type ConversationRuntimeViewLogEntry,
} from './conversationRuntimeViewStore';

type UseConversationRuntimeViewReturn = {
  view: ConversationRuntimeView;
  hydrated: boolean;
  isProcessing: boolean;
  canSendMessage: boolean;
  activeTurnId: string | null;
  markSendStarted: () => void;
  markSendAccepted: (turn_id: string, runtime: TConversationRuntimeSummary, msg_id?: string) => void;
  markSendFailed: (reason: string) => void;
  markStopRequested: (turn_id: string) => void;
  markStopAcknowledged: (turn_id: string, runtime: TConversationRuntimeSummary) => void;
  resetLocalGate: (reason: string) => void;
};

const normalizeReason = (reason: string): string => reason.trim().slice(0, 200) || 'unknown';

const logConversationRuntimeView = (entry: ConversationRuntimeViewLogEntry): void => {
  const rendererLogger = ipcBridge.application?.writeRendererLog;
  if (!rendererLogger) {
    return;
  }

  void rendererLogger
    .invoke({
      level: entry.level,
      tag: 'conversationRuntimeView',
      message: entry.event,
      data: entry.data,
    })
    .catch(() => {});
};

const flushRuntimeViewLogs = (logs: ConversationRuntimeViewLogEntry[]): void => {
  logs.forEach(logConversationRuntimeView);
};

const getRuntimeOrNull = (runtime: TConversationRuntimeSummary | undefined): TConversationRuntimeSummary | null =>
  runtime ?? null;

const RUNTIME_RECOVERY_POLL_MS = 1_500;

type RuntimeRecoveryMonitor = {
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  epoch: number;
  trackedTurnId: string | null;
  expectedMessageId: string | null;
};

type RuntimeEventSubscription = {
  refCount: number;
  dispose: () => void;
};

const runtimeRecoveryMonitors = new Map<string, RuntimeRecoveryMonitor>();
const runtimeEventSubscriptions = new Map<string, RuntimeEventSubscription>();

const emitMessagesRefresh = (conversation_id: string, expectedTerminalMessageId?: string | null): void => {
  emitter.emit('conversation.messages.refresh', {
    conversation_id,
    ...(expectedTerminalMessageId ? { expectedTerminalMessageId } : {}),
  });
};

const emitMessagesReconcile = (conversation_id: string): void => {
  emitter.emit('conversation.messages.reconcile', { conversation_id });
};

const emitRuntimeRecovered = (
  conversation_id: string,
  runtime: TConversationRuntimeSummary,
  expectedTerminalMessageId: string | null,
  recoveredTurnId: string | null
): void => {
  // Put the transcript into recovery/loading mode before releasing the composer.
  // Otherwise an idle runtime can briefly reveal the stale empty-slot handoff
  // while the durable messages are still being read.
  emitMessagesRefresh(conversation_id, expectedTerminalMessageId);
  emitter.emit('conversation.runtime.recovered', { conversation_id, runtime, recoveredTurnId });
};

const stopRuntimeRecoveryMonitor = (conversation_id: string): void => {
  const monitor = runtimeRecoveryMonitors.get(conversation_id);
  if (!monitor) return;
  monitor.stopped = true;
  if (monitor.timer) clearTimeout(monitor.timer);
  runtimeRecoveryMonitors.delete(conversation_id);
};

const scheduleRuntimeRecoveryPoll = (
  conversation_id: string,
  monitor: RuntimeRecoveryMonitor,
  delay = RUNTIME_RECOVERY_POLL_MS
): void => {
  if (monitor.stopped || runtimeRecoveryMonitors.get(conversation_id) !== monitor || monitor.timer) return;
  monitor.timer = setTimeout(() => {
    monitor.timer = null;
    void pollConversationRuntime(conversation_id, monitor);
  }, delay);
};

async function pollConversationRuntime(conversation_id: string, monitor: RuntimeRecoveryMonitor): Promise<void> {
  const pollEpoch = monitor.epoch;
  const trackedTurnId = monitor.trackedTurnId;
  try {
    const conversation = await getConversationOrNull(conversation_id);
    if (monitor.stopped || runtimeRecoveryMonitors.get(conversation_id) !== monitor || monitor.epoch !== pollEpoch) {
      return;
    }

    if (!conversation) {
      stopRuntimeRecoveryMonitor(conversation_id);
      flushRuntimeViewLogs(conversationDeleted(conversation_id));
      return;
    }

    const runtime = getRuntimeOrNull(conversation.runtime);
    if (!runtime) {
      flushRuntimeViewLogs(hydrateFailed(conversation_id, 'runtime summary missing during recovery'));
      scheduleRuntimeRecoveryPoll(conversation_id, monitor);
      return;
    }

    const currentView = getConversationRuntimeViewSnapshot(conversation_id);
    const newerTurnIsActive =
      trackedTurnId !== null &&
      currentView.activeTurnId !== null &&
      currentView.activeTurnId !== trackedTurnId &&
      currentView.isProcessing;
    if (currentView.localSubmitting || newerTurnIsActive) {
      scheduleRuntimeRecoveryPoll(conversation_id, monitor);
      return;
    }

    if (runtime.is_processing && runtime.turn_id && runtime.turn_id !== monitor.trackedTurnId) {
      monitor.trackedTurnId = runtime.turn_id;
      monitor.epoch += 1;
    }
    flushRuntimeViewLogs(hydrateSucceeded(conversation_id, runtime));
    if (runtime.is_processing) {
      // The websocket is the low-latency path, but the durable transcript must
      // keep a mounted chat live even after sleep/network churn leaves that
      // socket stale. This one-shot signal is coalesced by the message cache and
      // never toggles the full history loading state.
      emitMessagesReconcile(conversation_id);
      scheduleRuntimeRecoveryPoll(conversation_id, monitor);
      return;
    }

    const expectedMessageId = monitor.expectedMessageId;
    const recoveredTurnId = monitor.trackedTurnId;
    stopRuntimeRecoveryMonitor(conversation_id);
    emitRuntimeRecovered(conversation_id, runtime, expectedMessageId, recoveredTurnId);
  } catch (error: unknown) {
    if (monitor.stopped || runtimeRecoveryMonitors.get(conversation_id) !== monitor) return;
    const reason = error instanceof Error ? error.message : String(error);
    // A transient status read must not unlock an accepted run. Preserve the
    // current store state and retry until the backend confirms a terminal state.
    flushRuntimeViewLogs(hydrateFailed(conversation_id, normalizeReason(reason)));
    scheduleRuntimeRecoveryPoll(conversation_id, monitor);
  }
}

const ensureRuntimeRecoveryMonitor = (
  conversation_id: string,
  turn_id: string | null = null,
  expectedMessageId: string | null = null
): void => {
  if (!conversation_id) return;
  const existing = runtimeRecoveryMonitors.get(conversation_id);
  if (existing && !existing.stopped) {
    if (turn_id && existing.trackedTurnId !== turn_id) {
      existing.trackedTurnId = turn_id;
      existing.epoch += 1;
    }
    if (expectedMessageId) existing.expectedMessageId = expectedMessageId;
    scheduleRuntimeRecoveryPoll(conversation_id, existing);
    return;
  }
  const monitor: RuntimeRecoveryMonitor = {
    timer: null,
    stopped: false,
    epoch: 0,
    trackedTurnId: turn_id,
    expectedMessageId,
  };
  runtimeRecoveryMonitors.set(conversation_id, monitor);
  scheduleRuntimeRecoveryPoll(conversation_id, monitor);
};

const retainConversationRuntimeEvents = (conversation_id: string): (() => void) => {
  const existing = runtimeEventSubscriptions.get(conversation_id);
  if (existing) {
    existing.refCount += 1;
    return () => releaseConversationRuntimeEvents(conversation_id, existing);
  }

  const turnCompletedEmitter = ipcBridge.conversation.turnCompleted;
  const listChangedEmitter = ipcBridge.conversation.listChanged;
  if (!turnCompletedEmitter || !listChangedEmitter) {
    return () => {};
  }

  const disposeTurnCompleted = turnCompletedEmitter.on((event) => {
    if (event.session_id !== conversation_id) {
      return;
    }
    const currentView = getConversationRuntimeViewSnapshot(conversation_id);
    if (currentView.localSubmitting) {
      // A delayed completion for the previous turn must not clear the local
      // submit gate before the backend accepts the new turn.
      emitMessagesRefresh(conversation_id);
      return;
    }
    if (currentView.isProcessing && currentView.activeTurnId && currentView.activeTurnId !== event.turn_id) {
      emitMessagesRefresh(conversation_id);
      ensureRuntimeRecoveryMonitor(conversation_id, currentView.activeTurnId);
      return;
    }

    flushRuntimeViewLogs(turnCompleted(conversation_id, event.turn_id, event.runtime));
    if (event.runtime?.is_processing) {
      emitMessagesRefresh(conversation_id);
      ensureRuntimeRecoveryMonitor(conversation_id, event.runtime.turn_id ?? event.turn_id);
    } else if (event.runtime) {
      const expectedMessageId = runtimeRecoveryMonitors.get(conversation_id)?.expectedMessageId ?? null;
      stopRuntimeRecoveryMonitor(conversation_id);
      emitRuntimeRecovered(conversation_id, event.runtime, expectedMessageId, event.runtime.turn_id ?? event.turn_id);
    } else {
      // A terminal transport event without durable runtime truth is not enough
      // to unlock the UI. Reconcile the transcript now and keep polling until
      // the backend itself confirms the run is idle.
      emitMessagesRefresh(conversation_id);
      ensureRuntimeRecoveryMonitor(conversation_id, event.turn_id);
    }
  });

  const disposeListChanged = listChangedEmitter.on((event) => {
    if (event.conversation_id !== conversation_id || event.action !== 'deleted') {
      return;
    }
    stopRuntimeRecoveryMonitor(conversation_id);
    flushRuntimeViewLogs(conversationDeleted(conversation_id));
  });

  const subscription: RuntimeEventSubscription = {
    refCount: 1,
    dispose: () => {
      disposeTurnCompleted();
      disposeListChanged();
    },
  };
  runtimeEventSubscriptions.set(conversation_id, subscription);
  return () => releaseConversationRuntimeEvents(conversation_id, subscription);
};

const releaseConversationRuntimeEvents = (conversation_id: string, subscription: RuntimeEventSubscription): void => {
  if (runtimeEventSubscriptions.get(conversation_id) !== subscription) {
    return;
  }
  subscription.refCount -= 1;
  if (subscription.refCount > 0) {
    return;
  }
  subscription.dispose();
  runtimeEventSubscriptions.delete(conversation_id);
  stopRuntimeRecoveryMonitor(conversation_id);
};

export const resetConversationRuntimeRecoveryMonitorsForTest = (): void => {
  Array.from(runtimeRecoveryMonitors.keys()).forEach(stopRuntimeRecoveryMonitor);
  runtimeEventSubscriptions.forEach((subscription) => subscription.dispose());
  runtimeEventSubscriptions.clear();
};

export const useConversationRuntimeSnapshot = (conversation_id: string): ConversationRuntimeView => {
  const getSnapshot = useCallback(() => getConversationRuntimeViewSnapshot(conversation_id), [conversation_id]);
  return useSyncExternalStore(subscribeConversationRuntimeView, getSnapshot, getSnapshot);
};

export const useConversationRuntimeView = (conversation_id: string): UseConversationRuntimeViewReturn => {
  const view = useConversationRuntimeSnapshot(conversation_id);

  useEffect(() => {
    if (!conversation_id) {
      return;
    }

    let cancelled = false;
    flushRuntimeViewLogs(hydrateStarted(conversation_id));

    void getConversationOrNull(conversation_id)
      .then((conversation) => {
        if (cancelled) {
          return;
        }
        const runtime = getRuntimeOrNull(conversation?.runtime);
        flushRuntimeViewLogs(hydrateSucceeded(conversation_id, runtime));
        if (runtime?.is_processing) ensureRuntimeRecoveryMonitor(conversation_id, runtime.turn_id);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        flushRuntimeViewLogs(hydrateFailed(conversation_id, normalizeReason(reason)));
      });

    return () => {
      cancelled = true;
    };
  }, [conversation_id]);

  useEffect(() => {
    if (!conversation_id) {
      return;
    }
    return retainConversationRuntimeEvents(conversation_id);
  }, [conversation_id]);

  const markSendStarted = useCallback(() => {
    flushRuntimeViewLogs(localSendStarted(conversation_id));
    // Session-list truth (1.820.5): the turn is submitted — the row must show
    // "working" NOW, not only once the first stream frame arrives.
    emitter.emit('conversation.turn.working', { conversation_id, working: true });
  }, [conversation_id]);

  const markSendAccepted = useCallback(
    (turn_id: string, runtime: TConversationRuntimeSummary, msg_id?: string) => {
      flushRuntimeViewLogs(localSendAccepted(conversation_id, turn_id, runtime, msg_id));
      // An instantly-idle runtime means the turn already settled — otherwise the
      // backend accepted work and the pre-stream window continues.
      emitter.emit('conversation.turn.working', {
        conversation_id,
        working: runtime.is_processing === true,
      });
      emitMessagesRefresh(conversation_id, msg_id);
      if (runtime.is_processing)
        ensureRuntimeRecoveryMonitor(conversation_id, runtime.turn_id ?? turn_id, msg_id ?? null);
      else emitRuntimeRecovered(conversation_id, runtime, msg_id ?? null, runtime.turn_id ?? turn_id);
    },
    [conversation_id]
  );

  const markSendFailed = useCallback(
    (reason: string) => {
      flushRuntimeViewLogs(localSendFailed(conversation_id, normalizeReason(reason)));
      const runtimeSnapshot = getConversationRuntimeViewSnapshot(conversation_id);
      if (!runtimeSnapshot.isProcessing) {
        stopRuntimeRecoveryMonitor(conversation_id);
        // The send died before the backend took over — no terminal stream frame
        // will follow, so the session-list "working" flag ends here.
        emitter.emit('conversation.turn.working', { conversation_id, working: false });
      }
    },
    [conversation_id]
  );

  const markStopRequested = useCallback(
    (turn_id: string) => {
      flushRuntimeViewLogs(localStopRequested(conversation_id, turn_id));
    },
    [conversation_id]
  );

  const markStopAcknowledged = useCallback(
    (turn_id: string, runtime: TConversationRuntimeSummary) => {
      flushRuntimeViewLogs(localStopAcknowledged(conversation_id, turn_id, runtime));
      if (runtime.is_processing) ensureRuntimeRecoveryMonitor(conversation_id, runtime.turn_id ?? turn_id);
      else {
        const expectedMessageId = runtimeRecoveryMonitors.get(conversation_id)?.expectedMessageId ?? null;
        stopRuntimeRecoveryMonitor(conversation_id);
        emitRuntimeRecovered(conversation_id, runtime, expectedMessageId, runtime.turn_id ?? turn_id);
      }
    },
    [conversation_id]
  );

  const resetLocalRuntimeGate = useCallback(
    (reason: string) => {
      flushRuntimeViewLogs(resetLocalGate(conversation_id, normalizeReason(reason)));
    },
    [conversation_id]
  );

  return {
    view,
    hydrated: view.hydrated,
    isProcessing: view.isProcessing,
    canSendMessage: view.canSendMessage,
    activeTurnId: view.activeTurnId,
    markSendStarted,
    markSendAccepted,
    markSendFailed,
    markStopRequested,
    markStopAcknowledged,
    resetLocalGate: resetLocalRuntimeGate,
  };
};

export const logStreamTerminalObserved = (
  conversation_id: string,
  turn_id: string | undefined,
  platform: 'acp' | 'aionrs',
  stream_type: string
): void => {
  const rendererLogger = ipcBridge.application?.writeRendererLog;
  if (!rendererLogger) {
    return;
  }

  void rendererLogger
    .invoke({
      level: 'info',
      tag: 'conversationRuntimeView',
      message: 'stream_terminal_observed',
      data: {
        conversation_id,
        turn_id,
        platform,
        stream_type,
      },
    })
    .catch(() => {});
};
