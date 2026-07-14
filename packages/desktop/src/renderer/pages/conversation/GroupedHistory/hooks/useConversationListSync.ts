/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { TChatConversation } from '@/common/config/storage';
import { addEventListener } from '@/renderer/utils/emitter';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Whitelist of message types that indicate content generation is in progress.
 * Only these types should trigger the sidebar loading spinner.
 * Using a whitelist (instead of a blacklist) prevents unknown/internal message
 * types (e.g. slash_commands_updated, acp_context_usage) from falsely
 * triggering the generating state.
 */
const isGeneratingStreamMessage = (type: string): boolean => {
  return (
    type === 'content' ||
    type === 'start' ||
    type === 'thought' ||
    type === 'thinking' ||
    type === 'tool_group' ||
    type === 'acp_tool_call' ||
    type === 'acp_permission' ||
    type === 'permission' ||
    type === 'plan'
  );
};

const isTerminalAgentStatus = (data: unknown): boolean => {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const { status } = data as { status?: string };
  return status === 'error' || status === 'disconnected';
};

const isTerminalStreamMessage = (message: { type: string; data: unknown }): boolean => {
  return (
    message.type === 'finish' ||
    message.type === 'error' ||
    (message.type === 'agent_status' && isTerminalAgentStatus(message.data))
  );
};

/**
 * The three terminal turn states (turn finished for now). EXPORTED so the T5
 * session-digest relay (useSessionDigestRelay) uses the SAME predicate — the two must
 * agree on what "terminal" means, so the relay's immediate-flush condition can never
 * drift from the sidebar's resting-flag logic. NOTE the state-default falle (see the
 * turn.completed mapper): a missing state becomes 'ai_waiting_input' only when
 * status==='finished', else 'unknown' — and 'unknown' is NOT terminal here.
 */
export const isTerminalTurnState = (state: string): boolean => {
  return state === 'ai_waiting_input' || state === 'error' || state === 'stopped';
};

export type SidebarStreamGuardDecision = {
  markGenerating: boolean;
  clearCompleted: boolean;
  lateIgnored: boolean;
};

export const getSidebarStreamGuardDecision = ({
  type,
  completed,
}: {
  type: string;
  completed: boolean;
}): SidebarStreamGuardDecision => {
  if (!isGeneratingStreamMessage(type)) {
    return {
      markGenerating: false,
      clearCompleted: false,
      lateIgnored: false,
    };
  }

  if (type === 'start') {
    return {
      markGenerating: true,
      clearCompleted: true,
      lateIgnored: false,
    };
  }

  if (completed) {
    return {
      markGenerating: false,
      clearCompleted: false,
      lateIgnored: true,
    };
  }

  return {
    markGenerating: true,
    clearCompleted: false,
    lateIgnored: false,
  };
};

type ConversationListSyncSnapshot = {
  conversations: TChatConversation[];
  generatingConversationIds: Set<string>;
  completionUnreadConversationIds: Set<string>;
  attentionConversationIds: Set<string>;
  errorConversationIds: Set<string>;
};

const listeners = new Set<() => void>();

let isStoreInitialized = false;
let conversationsState: TChatConversation[] = [];
let generatingConversationIdsState = new Set<string>();
let completionUnreadConversationIdsState = new Set<string>();
let completedConversationIdsState = new Set<string>();
let attentionConversationIdsState = new Set<string>();
let errorConversationIdsState = new Set<string>();
let conversation_idsState = new Set<string>();
let activeConversationIdState: string | null = null;
let snapshotState: ConversationListSyncSnapshot = {
  conversations: conversationsState,
  generatingConversationIds: generatingConversationIdsState,
  completionUnreadConversationIds: completionUnreadConversationIdsState,
  attentionConversationIds: attentionConversationIdsState,
  errorConversationIds: errorConversationIdsState,
};

const emitStoreChange = () => {
  snapshotState = {
    conversations: conversationsState,
    generatingConversationIds: generatingConversationIdsState,
    completionUnreadConversationIds: completionUnreadConversationIdsState,
    attentionConversationIds: attentionConversationIdsState,
    errorConversationIds: errorConversationIdsState,
  };
  listeners.forEach((listener) => listener());
};

const subscribeConversationListSync = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getConversationListSyncSnapshot = (): ConversationListSyncSnapshot => snapshotState;

/**
 * SEAT EPOCH (stale-write guard): every fetch captures the epoch at ISSUE time
 * and drops its result if a seat switch happened while it was in flight — the
 * async sibling of useDayZeroOnboarding's `loadForSeat ===
 * getCurrentSeatId()` guard. Without it, a slow fetch (or a queued seat-switch
 * retry) issued under seat A can resolve AFTER a switch to seat B and clobber
 * B's list with A's rows — the exact cross-seat leak this store must prevent.
 * Bumped in the onSeatRebind handler below; a monotonic counter (not the seat
 * id) so even A→B→A rapid flips invalidate every in-flight read.
 */
let seatEpoch = 0;

const refreshConversations = () => {
  const issuedAtEpoch = seatEpoch;
  void ipcBridge.database.getUserConversations
    .invoke({ limit: 10000 })
    .then((result) => {
      if (issuedAtEpoch !== seatEpoch) return; // seat switched mid-flight — stale result, drop
      const items = result?.items;
      if (items && Array.isArray(items)) {
        const filteredData = items.filter((conv) => {
          // Legacy rows from the pre-provider-probe health check flow are hidden
          // from normal history. New health checks must not create conversations.
          const extra = conv.extra as { is_health_check?: boolean; team_id?: string; teamId?: string } | undefined;
          return extra?.is_health_check !== true && !extra?.team_id && !extra?.teamId;
        });
        conversationsState = filteredData;
        // Use ALL conversation IDs (including team/legacy health-check rows) so the
        // responseStream listener recognises them as known and doesn't
        // trigger an infinite refreshConversations loop.
        conversation_idsState = new Set(items.map((conversation) => conversation.id));
        emitStoreChange();
        return;
      }

      conversationsState = [];
      conversation_idsState = new Set();
      emitStoreChange();
    })
    .catch((error) => {
      if (issuedAtEpoch !== seatEpoch) return; // stale failure from a superseded seat — drop
      console.error('[WorkspaceGroupedHistory] Failed to load conversations:', error);
      conversationsState = [];
      conversation_idsState = new Set();
      emitStoreChange();
    });
};

/**
 * SEAT ISOLATION (the live 1.3 bug): this store is a MODULE-LEVEL singleton that
 * initialises ONCE (isStoreInitialized) and only refreshes on chat-lifecycle
 * events — NONE of which fire on a seat switch. The backend genuinely re-homes to
 * the new seat's conversation DB (distinct --data-dir + a fresh __backendPort),
 * but without this reset the sidebar kept rendering the PRIOR seat's cached list,
 * so a switch looked like "all chats stayed the same / no separate sessions".
 *
 * Hard-reset EVERY piece of module state so the prior seat's conversations AND its
 * per-row resting flags (generating/unread/error/attention dots) and open
 * conversation cannot bleed across the boundary (an isolation leak, not just a
 * stale list).
 */
const resetConversationListForSeatSwitch = () => {
  conversationsState = [];
  conversation_idsState = new Set();
  generatingConversationIdsState = new Set();
  completionUnreadConversationIdsState = new Set();
  completedConversationIdsState = new Set();
  attentionConversationIdsState = new Set();
  errorConversationIdsState = new Set();
  activeConversationIdState = null;
  emitStoreChange();
};

/**
 * Re-fetch the new seat's conversation list after a switch. The switch STOP+RE-
 * SPAWNs the backend and republishes __backendPort; rebindSeat fires onSeatRebind
 * only AFTER the switch IPC (which awaits restartBackend) settles, so the new port
 * is normally live by now — but the respawn completes asynchronously and can even
 * roll back, so a transient boot-window error must NOT leave the new seat's list
 * empty. Retry a bounded number of times on ERROR only (a genuinely fresh seat
 * legitimately returns zero conversations — that is success, not a retry trigger).
 */
const refreshConversationsForSeatSwitch = (issuedAtEpoch: number, retriesRemaining = 4) => {
  if (issuedAtEpoch !== seatEpoch) return; // a newer switch superseded this chain — stop
  void ipcBridge.database.getUserConversations
    .invoke({ limit: 10000 })
    .then((result) => {
      if (issuedAtEpoch !== seatEpoch) return; // switched again mid-flight — stale, drop
      const items = result?.items;
      if (items && Array.isArray(items)) {
        const filteredData = items.filter((conv) => {
          const extra = conv.extra as { is_health_check?: boolean; team_id?: string; teamId?: string } | undefined;
          return extra?.is_health_check !== true && !extra?.team_id && !extra?.teamId;
        });
        conversationsState = filteredData;
        conversation_idsState = new Set(items.map((conversation) => conversation.id));
        emitStoreChange();
        return;
      }
      conversationsState = [];
      conversation_idsState = new Set();
      emitStoreChange();
    })
    .catch((error) => {
      if (issuedAtEpoch !== seatEpoch) return; // superseded chain — its retries die with it
      if (retriesRemaining > 0) {
        // Backend still settling on the new seat's port — retry, don't give up.
        setTimeout(() => refreshConversationsForSeatSwitch(issuedAtEpoch, retriesRemaining - 1), 400);
        return;
      }
      console.error('[WorkspaceGroupedHistory] seat-switch conversation refresh failed:', error);
      conversationsState = [];
      conversation_idsState = new Set();
      emitStoreChange();
    });
};

const markGenerating = (conversation_id: string) => {
  if (generatingConversationIdsState.has(conversation_id)) {
    return;
  }

  generatingConversationIdsState = new Set(generatingConversationIdsState).add(conversation_id);
  emitStoreChange();
};

const clearGenerating = (conversation_id: string) => {
  if (!generatingConversationIdsState.has(conversation_id)) {
    return;
  }

  const next = new Set(generatingConversationIdsState);
  next.delete(conversation_id);
  generatingConversationIdsState = next;
  emitStoreChange();
};

const markCompletionUnread = (conversation_id: string) => {
  if (completionUnreadConversationIdsState.has(conversation_id)) {
    return;
  }

  completionUnreadConversationIdsState = new Set(completionUnreadConversationIdsState).add(conversation_id);
  emitStoreChange();
};

const clearCompletionUnreadState = (conversation_id: string) => {
  if (!completionUnreadConversationIdsState.has(conversation_id)) {
    return;
  }

  const next = new Set(completionUnreadConversationIdsState);
  next.delete(conversation_id);
  completionUnreadConversationIdsState = next;
  emitStoreChange();
};

const markAttention = (conversation_id: string) => {
  if (attentionConversationIdsState.has(conversation_id)) {
    return;
  }

  attentionConversationIdsState = new Set(attentionConversationIdsState).add(conversation_id);
  emitStoreChange();
};

const clearAttention = (conversation_id: string) => {
  if (!attentionConversationIdsState.has(conversation_id)) {
    return;
  }

  const next = new Set(attentionConversationIdsState);
  next.delete(conversation_id);
  attentionConversationIdsState = next;
  emitStoreChange();
};

const markError = (conversation_id: string) => {
  if (errorConversationIdsState.has(conversation_id)) {
    return;
  }

  errorConversationIdsState = new Set(errorConversationIdsState).add(conversation_id);
  emitStoreChange();
};

const clearError = (conversation_id: string) => {
  if (!errorConversationIdsState.has(conversation_id)) {
    return;
  }

  const next = new Set(errorConversationIdsState);
  next.delete(conversation_id);
  errorConversationIdsState = next;
  emitStoreChange();
};

const markCompleted = (conversation_id: string) => {
  completedConversationIdsState = new Set(completedConversationIdsState).add(conversation_id);
};

const clearCompleted = (conversation_id: string) => {
  if (!completedConversationIdsState.has(conversation_id)) {
    return;
  }

  const next = new Set(completedConversationIdsState);
  next.delete(conversation_id);
  completedConversationIdsState = next;
};

const logLateStreamIgnored = (conversation_id: string, type: string) => {
  void ipcBridge.application.writeRendererLog
    .invoke({
      level: 'warn',
      tag: 'conversationRuntimeView',
      message: 'late_stream_ignored_for_runtime',
      data: {
        conversation_id,
        stream_type: type,
      },
    })
    .catch(() => {});
};

const setActiveConversationState = (conversation_id: string | null) => {
  activeConversationIdState = conversation_id;
  // Opening a conversation means the user has seen its resting state, so clear
  // the "needs you" / "errored" flags (mirrors clearCompletionUnread).
  if (conversation_id) {
    clearAttention(conversation_id);
    clearError(conversation_id);
  }
};

const initializeConversationListSyncStore = () => {
  if (isStoreInitialized) {
    return;
  }

  isStoreInitialized = true;
  refreshConversations();

  // SEAT ISOLATION: the singleton survives across seat switches (and even a host
  // remount), so subscribe ONCE to the seat-rebind signal — fired by rebindSeat
  // AFTER the config cache has re-homed and the switch IPC (which awaits the
  // backend respawn) has settled. Reset the prior seat's cached list + flags
  // immediately (so the old chats vanish at once), then re-fetch the new seat's
  // list from its freshly-respawned backend. On a single-seat/legacy install the
  // signal never fires (rebindSeat early-returns on a no-op) — byte-identical.
  configService.onSeatRebind(() => {
    // Bump the epoch FIRST: every in-flight fetch/retry issued under the prior
    // seat (including a responseStream-triggered refreshConversations racing the
    // reset below) is invalidated at write-time and cannot clobber the new
    // seat's list.
    seatEpoch += 1;
    resetConversationListForSeatSwitch();
    refreshConversationsForSeatSwitch(seatEpoch);
  });

  addEventListener('chat.history.refresh', refreshConversations);
  ipcBridge.conversation.listChanged.on((event) => {
    if (event.action === 'deleted') {
      clearGenerating(event.conversation_id);
      clearCompletionUnreadState(event.conversation_id);
      clearCompleted(event.conversation_id);
      clearAttention(event.conversation_id);
      clearError(event.conversation_id);
    }
    refreshConversations();
  });
  ipcBridge.conversation.responseStream.on((message) => {
    const conversation_id = message.conversation_id;
    if (!conversation_id) {
      return;
    }

    if (!conversation_idsState.has(conversation_id)) {
      refreshConversations();
    }

    if (isTerminalStreamMessage(message)) {
      const wasGenerating = generatingConversationIdsState.has(conversation_id);
      const isErrorStream =
        message.type === 'error' || (message.type === 'agent_status' && isTerminalAgentStatus(message.data));
      if (isErrorStream && activeConversationIdState !== conversation_id) {
        // A failed/disconnected turn is the loudest resting state — flag it red
        // (unless the user is already looking at this conversation).
        markError(conversation_id);
      }
      if (wasGenerating && activeConversationIdState !== conversation_id) {
        markCompletionUnread(conversation_id);
      }
      clearGenerating(conversation_id);
      return;
    }

    const decision = getSidebarStreamGuardDecision({
      type: message.type,
      completed: completedConversationIdsState.has(conversation_id),
    });
    if (message.type === 'start') {
      // A fresh turn clears any stale resting flags from the previous turn so the
      // row doesn't keep an old "errored"/"needs you" dot while it's regenerating.
      clearAttention(conversation_id);
      clearError(conversation_id);
    }
    if (decision.clearCompleted) {
      clearCompleted(conversation_id);
    }
    if (decision.lateIgnored) {
      logLateStreamIgnored(conversation_id, message.type);
      return;
    }
    if (decision.markGenerating) {
      markGenerating(conversation_id);
    }
  });
  ipcBridge.conversation.turnCompleted.on((event) => {
    const isUnseen = activeConversationIdState !== event.session_id;
    if (isTerminalTurnState(event.state) && isUnseen) {
      markCompletionUnread(event.session_id);
      // Split the terminal turn states into their semantic resting flags:
      //   ai_waiting_input → attention (EVE is waiting on the user)
      //   error / stopped  → error     (the turn failed / was interrupted)
      if (event.state === 'ai_waiting_input') {
        markAttention(event.session_id);
      } else if (event.state === 'error' || event.state === 'stopped') {
        markError(event.session_id);
      }
    }
    markCompleted(event.session_id);
    clearGenerating(event.session_id);
    refreshConversations();
  });
};

export const useConversationListSync = () => {
  useEffect(() => {
    initializeConversationListSyncStore();
  }, []);

  const {
    conversations,
    generatingConversationIds,
    completionUnreadConversationIds,
    attentionConversationIds,
    errorConversationIds,
  } = useSyncExternalStore(
    subscribeConversationListSync,
    getConversationListSyncSnapshot,
    getConversationListSyncSnapshot
  );

  const clearCompletionUnread = useCallback((conversation_id: string) => {
    clearCompletionUnreadState(conversation_id);
    // Reading a conversation also clears its "needs you" / "errored" resting flags.
    clearAttention(conversation_id);
    clearError(conversation_id);
  }, []);

  const setActiveConversation = useCallback((conversation_id: string | null) => {
    setActiveConversationState(conversation_id);
  }, []);

  const isConversationGenerating = useCallback(
    (conversation_id: string) => {
      return generatingConversationIds.has(conversation_id);
    },
    [generatingConversationIds]
  );

  const hasCompletionUnread = useCallback(
    (conversation_id: string) => {
      return completionUnreadConversationIds.has(conversation_id);
    },
    [completionUnreadConversationIds]
  );

  const isConversationWaitingInput = useCallback(
    (conversation_id: string) => {
      return attentionConversationIds.has(conversation_id);
    },
    [attentionConversationIds]
  );

  const hasConversationError = useCallback(
    (conversation_id: string) => {
      return errorConversationIds.has(conversation_id);
    },
    [errorConversationIds]
  );

  return {
    conversations,
    isConversationGenerating,
    hasCompletionUnread,
    isConversationWaitingInput,
    hasConversationError,
    clearCompletionUnread,
    setActiveConversation,
  };
};
