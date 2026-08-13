/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { TChatConversation } from '@/common/config/storage';
import {
  getDocumentPreparationConversationIds,
  subscribeConversationDocumentPreparation,
} from '@/renderer/pages/conversation/runtime/conversationDocumentPreparationStore';
import {
  classifyConversationStreamTerminal,
  invalidateConversationRuntimeForSeatRebind,
  shouldApplyConversationTurnCompleted,
  shouldApplyConversationStreamTurn,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import { clearGenerationForBackendRespawn } from '@/renderer/services/commandEveGenerationActivity';
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

/**
 * The three terminal turn states (turn finished for now). EXPORTED so the T5
 * session-digest relay (useSessionDigestRelay) uses the SAME predicate — the two must
 * agree on what "terminal" means, so the relay's immediate-flush condition can never
 * drift from the sidebar's resting-flag logic. NOTE the fail-closed mapper contract:
 * a missing/unknown backend state always remains `unknown` and is never terminal.
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
  turnWorkingConversationIds: Set<string>;
  preparingConversationIds: Set<string>;
  completionUnreadConversationIds: Set<string>;
  attentionConversationIds: Set<string>;
  errorConversationIds: Set<string>;
};

export type ConversationSidebarRestingState = 'idle' | 'done' | 'attention' | 'error';

export type ConversationSidebarStatusReceipt = {
  version: 1;
  seat_id: string;
  state: ConversationSidebarRestingState;
  turn_id: string | null;
  updated_at: number;
};

const CONVERSATION_SIDEBAR_STATUS_EXTRA_KEY = 'command_eve_sidebar_status';

const isConversationSidebarRestingState = (value: unknown): value is ConversationSidebarRestingState => {
  return value === 'idle' || value === 'done' || value === 'attention' || value === 'error';
};

/**
 * Read the durable sidebar receipt from the conversation-owned `extra` bag.
 * The seat id is part of the receipt even though each seat already has its own
 * backend data dir: it is a final renderer-side fence against a stale/cross-seat
 * list response being painted after a rapid A -> B -> A switch.
 */
export const readConversationSidebarStatusReceipt = (
  conversation: TChatConversation,
  currentSeatId: string
): ConversationSidebarStatusReceipt | null => {
  const extra = conversation.extra as Record<string, unknown> | undefined;
  const raw = extra?.[CONVERSATION_SIDEBAR_STATUS_EXTRA_KEY];
  if (!raw || typeof raw !== 'object') return null;

  const receipt = raw as Partial<ConversationSidebarStatusReceipt>;
  if (
    receipt.version !== 1 ||
    receipt.seat_id !== currentSeatId ||
    !isConversationSidebarRestingState(receipt.state) ||
    (receipt.turn_id !== null && typeof receipt.turn_id !== 'string') ||
    typeof receipt.updated_at !== 'number' ||
    !Number.isFinite(receipt.updated_at) ||
    receipt.updated_at <= 0
  ) {
    return null;
  }

  return receipt as ConversationSidebarStatusReceipt;
};

const listeners = new Set<() => void>();

let isStoreInitialized = false;
let conversationsState: TChatConversation[] = [];
let generatingConversationIdsState = new Set<string>();
// 1.820.5 — "working" truth beyond stream frames. The row must light up in ALL
// pre-stream phases, so two additional renderer-side sources feed the same
// per-row working state:
//   - turnWorkingConversationIdsState: the send-lifecycle signal
//     (`conversation.turn.working`, emitted by useConversationRuntimeView's
//     markSend* seam for BOTH platforms) — covers "submitted, backend preparing
//     the turn" before any stream frame exists.
//   - preparingConversationIdsState: mirror of the document-preparation store —
//     covers "EVE bereitet den Auftrag vor" while attachments are prepared.
// Both are unioned into `isConversationGenerating`; the stream-frame set stays
// untouched so every existing terminal/guard semantic is preserved byte-for-byte.
let turnWorkingConversationIdsState = new Set<string>();
let preparingConversationIdsState = new Set<string>();
let completionUnreadConversationIdsState = new Set<string>();
let completedConversationIdsState = new Set<string>();
let attentionConversationIdsState = new Set<string>();
let errorConversationIdsState = new Set<string>();
let conversation_idsState = new Set<string>();
let activeConversationIdState: string | null = null;
let snapshotState: ConversationListSyncSnapshot = {
  conversations: conversationsState,
  generatingConversationIds: generatingConversationIdsState,
  turnWorkingConversationIds: turnWorkingConversationIdsState,
  preparingConversationIds: preparingConversationIdsState,
  completionUnreadConversationIds: completionUnreadConversationIdsState,
  attentionConversationIds: attentionConversationIdsState,
  errorConversationIds: errorConversationIdsState,
};

const emitStoreChange = () => {
  snapshotState = {
    conversations: conversationsState,
    generatingConversationIds: generatingConversationIdsState,
    turnWorkingConversationIds: turnWorkingConversationIdsState,
    preparingConversationIds: preparingConversationIdsState,
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
 * TEST-ONLY full reset: the store is a deliberate module singleton that
 * initialises once, so a suite needing a FRESH initialisation (live bridge
 * re-subscription after clearing its harness handlers) uses this first.
 * Re-initialisation re-subscribes every listener — callers must clear their
 * harness handler sets before re-mounting, or events arrive twice.
 */
export const resetConversationListSyncForTest = (): void => {
  isStoreInitialized = false;
  conversationsState = [];
  conversation_idsState = new Set();
  generatingConversationIdsState = new Set();
  turnWorkingConversationIdsState = new Set();
  preparingConversationIdsState = new Set();
  completionUnreadConversationIdsState = new Set();
  completedConversationIdsState = new Set();
  attentionConversationIdsState = new Set();
  errorConversationIdsState = new Set();
  activeConversationIdState = null;
  localSidebarStatusReceipts.clear();
  sidebarStatusWriteChains.clear();
  localGeneratingTurnIds.clear();
  resetAutoProjectRelayState();
  lastSidebarReceiptUpdatedAt = 0;
  emitStoreChange();
};

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

/**
 * A renderer transition is visible immediately while its conversation-extra
 * PATCH is in flight. The override is retired as soon as a list read carries an
 * equal/newer durable receipt. It is deliberately cleared on every seat epoch.
 */
const localSidebarStatusReceipts = new Map<string, ConversationSidebarStatusReceipt>();
const sidebarStatusWriteChains = new Map<string, Promise<void>>();
const localGeneratingTurnIds = new Map<string, string | null>();
type AutoProjectTurnRelayState = {
  turnId: string | null;
  hasSubstantiveOutput: boolean;
  terminalSuccessObserved: boolean;
  seatEpoch: number;
  requestScheduled: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
};
const autoProjectTurnRelayState = new Map<string, Map<string, AutoProjectTurnRelayState>>();
const completedAutoProjectTurnKeys = new Set<string>();
const failedAutoProjectTurnKeys = new Set<string>();
const inFlightAutoProjectTurnKeys = new Set<string>();
const autoProjectTurnAttemptCounts = new Map<string, number>();
const AUTO_PROJECT_MAX_ATTEMPTS = 2;
const AUTO_PROJECT_RETRY_DELAY_MS = 250;
let lastSidebarReceiptUpdatedAt = 0;

const normalizeStreamIdentity = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const rememberCompletedAutoProjectTurn = (key: string): void => {
  if (completedAutoProjectTurnKeys.has(key)) return;
  completedAutoProjectTurnKeys.add(key);
  if (completedAutoProjectTurnKeys.size <= 256) return;
  const oldest = completedAutoProjectTurnKeys.values().next().value;
  if (oldest) completedAutoProjectTurnKeys.delete(oldest);
};

const rememberFailedAutoProjectTurn = (key: string): void => {
  if (failedAutoProjectTurnKeys.has(key)) return;
  failedAutoProjectTurnKeys.add(key);
  if (failedAutoProjectTurnKeys.size <= 256) return;
  const oldest = failedAutoProjectTurnKeys.values().next().value;
  if (oldest) failedAutoProjectTurnKeys.delete(oldest);
};

const rememberAutoProjectAttempt = (key: string, attempt: number): void => {
  autoProjectTurnAttemptCounts.delete(key);
  autoProjectTurnAttemptCounts.set(key, attempt);
  if (autoProjectTurnAttemptCounts.size <= 256) return;
  const oldest = autoProjectTurnAttemptCounts.keys().next().value;
  if (oldest) autoProjectTurnAttemptCounts.delete(oldest);
};

const autoProjectTurnKey = (conversationId: string, turnId: string): string => `${conversationId}\0${turnId}`;

const clearAutoProjectTurnTimer = (state: AutoProjectTurnRelayState): void => {
  if (state.retryTimer !== null) clearTimeout(state.retryTimer);
  state.retryTimer = null;
  state.requestScheduled = false;
};

const findAutoProjectRelayTurn = (
  conversationId: string,
  turnId: string
): [streamTurnKey: string, state: AutoProjectTurnRelayState] | null => {
  const turns = autoProjectTurnRelayState.get(conversationId);
  if (!turns) return null;
  const direct = turns.get(turnId);
  if (direct) return [turnId, direct];
  for (const entry of turns) {
    if (entry[1].turnId === turnId) return entry;
  }
  return null;
};

const clearAutoProjectRelayForConversation = (conversationId: string): void => {
  const turns = autoProjectTurnRelayState.get(conversationId);
  turns?.forEach(clearAutoProjectTurnTimer);
  autoProjectTurnRelayState.delete(conversationId);
  for (const collection of [completedAutoProjectTurnKeys, failedAutoProjectTurnKeys, inFlightAutoProjectTurnKeys]) {
    for (const key of collection) {
      if (key.startsWith(`${conversationId}\0`)) collection.delete(key);
    }
  }
  for (const key of autoProjectTurnAttemptCounts.keys()) {
    if (key.startsWith(`${conversationId}\0`)) autoProjectTurnAttemptCounts.delete(key);
  }
};

const clearAutoProjectRelayTurn = (conversationId: string, turnId: string | null): void => {
  if (!turnId) {
    autoProjectTurnRelayState.delete(conversationId);
    return;
  }
  const turns = autoProjectTurnRelayState.get(conversationId);
  if (!turns) return;
  const entry = findAutoProjectRelayTurn(conversationId, turnId);
  if (!entry) return;
  clearAutoProjectTurnTimer(entry[1]);
  turns.delete(entry[0]);
  if (turns.size === 0) autoProjectTurnRelayState.delete(conversationId);
};

const resetAutoProjectRelayState = (): void => {
  autoProjectTurnRelayState.forEach((turns) => turns.forEach(clearAutoProjectTurnTimer));
  autoProjectTurnRelayState.clear();
  completedAutoProjectTurnKeys.clear();
  failedAutoProjectTurnKeys.clear();
  inFlightAutoProjectTurnKeys.clear();
  autoProjectTurnAttemptCounts.clear();
};

const hasSubstantiveAutoProjectOutput = (data: unknown): boolean => {
  if (typeof data === 'string') return data.trim().length > 0;
  if (Array.isArray(data)) return data.some(hasSubstantiveAutoProjectOutput);
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return ['content', 'text', 'delta'].some((field) => hasSubstantiveAutoProjectOutput(record[field]));
};

/**
 * Deliver a renderer-proven successful turn to Main. Calls are result-aware:
 * `created` seals the exact-once key; bridge failures/noops/rejections get one
 * bounded retry because Main may still be finishing a durable title write.
 * Main re-proves every policy fact and this helper never creates a project.
 */
const requestAutoProjectForCompletedTurn = (
  conversationId: string,
  streamTurnKey: string,
  state: AutoProjectTurnRelayState
): void => {
  const turnId = state.turnId ?? streamTurnKey;
  const key = autoProjectTurnKey(conversationId, turnId);
  if (
    state.seatEpoch !== seatEpoch ||
    failedAutoProjectTurnKeys.has(key) ||
    completedAutoProjectTurnKeys.has(key) ||
    inFlightAutoProjectTurnKeys.has(key)
  ) {
    return;
  }

  const attempt = autoProjectTurnAttemptCounts.get(key) ?? 0;
  if (attempt >= AUTO_PROJECT_MAX_ATTEMPTS) return;
  rememberAutoProjectAttempt(key, attempt + 1);
  inFlightAutoProjectTurnKeys.add(key);

  void ipcBridge.projectWorkspace.ensureAfterSuccessfulTurn
    .invoke({ conversation_id: conversationId, turn_id: turnId })
    .then((result) => {
      inFlightAutoProjectTurnKeys.delete(key);
      if (state.seatEpoch !== seatEpoch || failedAutoProjectTurnKeys.has(key)) return;
      if (result.status === 'created') {
        rememberCompletedAutoProjectTurn(key);
        autoProjectTurnAttemptCounts.delete(key);
        clearAutoProjectRelayTurn(conversationId, turnId);
        return;
      }
      scheduleAutoProjectRequest(conversationId, streamTurnKey, state, AUTO_PROJECT_RETRY_DELAY_MS);
    })
    .catch(() => {
      inFlightAutoProjectTurnKeys.delete(key);
      if (state.seatEpoch !== seatEpoch || failedAutoProjectTurnKeys.has(key)) return;
      scheduleAutoProjectRequest(conversationId, streamTurnKey, state, AUTO_PROJECT_RETRY_DELAY_MS);
    });
};

function scheduleAutoProjectRequest(
  conversationId: string,
  streamTurnKey: string,
  state: AutoProjectTurnRelayState,
  delayMs = 0
): void {
  const turnId = state.turnId ?? streamTurnKey;
  const key = autoProjectTurnKey(conversationId, turnId);
  if (
    !state.hasSubstantiveOutput ||
    !state.terminalSuccessObserved ||
    state.seatEpoch !== seatEpoch ||
    failedAutoProjectTurnKeys.has(key) ||
    completedAutoProjectTurnKeys.has(key) ||
    inFlightAutoProjectTurnKeys.has(key) ||
    (autoProjectTurnAttemptCounts.get(key) ?? 0) >= AUTO_PROJECT_MAX_ATTEMPTS
  ) {
    return;
  }

  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  if (state.requestScheduled) return;

  const queue = () => {
    state.requestScheduled = true;
    queueMicrotask(() => {
      state.requestScheduled = false;
      const current = autoProjectTurnRelayState.get(conversationId)?.get(streamTurnKey);
      if (current !== state || state.seatEpoch !== seatEpoch || failedAutoProjectTurnKeys.has(key)) return;
      requestAutoProjectForCompletedTurn(conversationId, streamTurnKey, state);
    });
  };

  if (delayMs > 0) {
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      queue();
    }, delayMs);
  } else {
    queue();
  }
}

const failAutoProjectTurn = (conversationId: string, turnId: string): void => {
  const key = autoProjectTurnKey(conversationId, turnId);
  rememberFailedAutoProjectTurn(key);
  autoProjectTurnAttemptCounts.delete(key);
  clearAutoProjectRelayTurn(conversationId, turnId);
};

/**
 * 1.820.4 (MAT-1772) — durable post-turn relay.
 *
 * This listener belongs to the permanently mounted conversation-list store,
 * not AcpChat. Switching from session A to B therefore cannot unmount the only
 * observer before A's terminal frame arrives. Renderer evidence is deliberately
 * narrow: exactly start -> text/content -> finish for one turn. Main still
 * re-proves EVE backend, temporary workspace, title, binding and seat authority.
 */
const relaySuccessfulTurnToAutoProject = (message: {
  type: string;
  conversation_id: string;
  turn_id?: string;
  msg_id?: string;
  data: unknown;
}): void => {
  const conversationId = message.conversation_id;
  const messageTurnId = normalizeStreamIdentity(message.turn_id);
  const streamTurnKey = messageTurnId ?? normalizeStreamIdentity(message.msg_id);
  if (!streamTurnKey) return;
  const relayKey = autoProjectTurnKey(conversationId, messageTurnId ?? streamTurnKey);

  if (classifyConversationStreamTerminal(message) === 'error') {
    failAutoProjectTurn(conversationId, messageTurnId ?? streamTurnKey);
    return;
  }

  if (message.type === 'start') {
    if (completedAutoProjectTurnKeys.has(relayKey) || failedAutoProjectTurnKeys.has(relayKey)) return;
    let turns = autoProjectTurnRelayState.get(conversationId);
    if (!turns) {
      turns = new Map();
      autoProjectTurnRelayState.set(conversationId, turns);
    }
    if (!turns.has(streamTurnKey)) {
      turns.set(streamTurnKey, {
        turnId: messageTurnId,
        hasSubstantiveOutput: false,
        terminalSuccessObserved: false,
        seatEpoch,
        requestScheduled: false,
        retryTimer: null,
      });
    }
    while (turns.size > 8) {
      const oldest = turns.keys().next().value;
      if (!oldest) break;
      turns.delete(oldest);
    }
    return;
  }

  let turns = autoProjectTurnRelayState.get(conversationId);
  let tracked = turns?.get(streamTurnKey);
  if (!tracked && (message.type === 'text' || message.type === 'content')) {
    if (completedAutoProjectTurnKeys.has(relayKey) || failedAutoProjectTurnKeys.has(relayKey)) return;
    turns ??= new Map();
    autoProjectTurnRelayState.set(conversationId, turns);
    tracked = {
      turnId: messageTurnId,
      hasSubstantiveOutput: false,
      terminalSuccessObserved: false,
      seatEpoch,
      requestScheduled: false,
      retryTimer: null,
    };
    turns.set(streamTurnKey, tracked);
  }
  if (!tracked || tracked.seatEpoch !== seatEpoch) return;

  if (message.type === 'text' || message.type === 'content') {
    tracked.turnId ??= messageTurnId;
    tracked.hasSubstantiveOutput ||= hasSubstantiveAutoProjectOutput(message.data);
    scheduleAutoProjectRequest(conversationId, streamTurnKey, tracked);
    return;
  }

  if (message.type !== 'finish') return;
  tracked.turnId ??= messageTurnId;
  tracked.terminalSuccessObserved = true;
  scheduleAutoProjectRequest(conversationId, streamTurnKey, tracked);
};

const nextSidebarReceiptUpdatedAt = (): number => {
  lastSidebarReceiptUpdatedAt = Math.max(Date.now(), lastSidebarReceiptUpdatedAt + 1);
  return lastSidebarReceiptUpdatedAt;
};

const getConversationTurnId = (conversation_id: string): string | null => {
  return conversationsState.find((conversation) => conversation.id === conversation_id)?.runtime?.turn_id ?? null;
};

const persistConversationSidebarStatus = (
  conversation_id: string,
  state: ConversationSidebarRestingState,
  turn_id: string | null = null
): void => {
  if (!conversation_id) return;

  const issuedAtEpoch = seatEpoch;
  const receipt: ConversationSidebarStatusReceipt = {
    version: 1,
    seat_id: configService.getCurrentSeatId(),
    state,
    turn_id,
    updated_at: nextSidebarReceiptUpdatedAt(),
  };
  localSidebarStatusReceipts.set(conversation_id, receipt);

  const chainKey = `${issuedAtEpoch}:${conversation_id}`;
  const previous = sidebarStatusWriteChains.get(chainKey) ?? Promise.resolve();
  let next: Promise<void>;
  next = previous
    .catch(() => {})
    .then(async () => {
      if (issuedAtEpoch !== seatEpoch) return;
      await ipcBridge.conversation.update.invoke({
        id: conversation_id,
        updates: {
          extra: {
            [CONVERSATION_SIDEBAR_STATUS_EXTRA_KEY]: receipt,
          },
        } as unknown as Partial<TChatConversation>,
        merge_extra: true,
      });
    })
    .catch((error: unknown) => {
      if (issuedAtEpoch !== seatEpoch) return;
      console.error('[WorkspaceGroupedHistory] Failed to persist conversation status:', error);
    })
    .finally(() => {
      if (sidebarStatusWriteChains.get(chainKey) === next) {
        sidebarStatusWriteChains.delete(chainKey);
      }
    });
  sidebarStatusWriteChains.set(chainKey, next);
};

const receiptMatchesRuntime = (receipt: ConversationSidebarStatusReceipt, conversation: TChatConversation): boolean => {
  const runtimeTurnId = conversation.runtime?.turn_id ?? null;
  return !receipt.turn_id || !runtimeTurnId || receipt.turn_id === runtimeTurnId;
};

const getEffectiveSidebarStatusReceipt = (
  conversation: TChatConversation,
  currentSeatId: string
): ConversationSidebarStatusReceipt | null => {
  const storedReceipt = readConversationSidebarStatusReceipt(conversation, currentSeatId);
  const localReceipt = localSidebarStatusReceipts.get(conversation.id) ?? null;
  if (storedReceipt && localReceipt && storedReceipt.updated_at >= localReceipt.updated_at) {
    localSidebarStatusReceipts.delete(conversation.id);
    return storedReceipt;
  }
  return localReceipt ?? storedReceipt;
};

const reconcileConversationSidebarStatuses = (conversations: TChatConversation[]): void => {
  const currentSeatId = configService.getCurrentSeatId();
  const nextGenerating = new Set<string>();
  const nextCompletionUnread = new Set<string>();
  const nextCompleted = new Set<string>();
  const nextAttention = new Set<string>();
  const nextError = new Set<string>();

  for (const conversation of conversations) {
    const localGeneratingTurnId = localGeneratingTurnIds.get(conversation.id);
    const runtimeConfirmsLocalTurnEnded =
      localGeneratingTurnId !== undefined &&
      conversation.runtime?.is_processing === false &&
      Boolean(localGeneratingTurnId) &&
      conversation.runtime.turn_id === localGeneratingTurnId;
    const isGenerating =
      conversation.runtime?.is_processing === true ||
      (localGeneratingTurnId !== undefined && !runtimeConfirmsLocalTurnEnded);
    if (isGenerating) {
      nextGenerating.add(conversation.id);
      continue;
    }

    const receipt = getEffectiveSidebarStatusReceipt(conversation, currentSeatId);
    if (activeConversationIdState === conversation.id) {
      if (receipt && receipt.state !== 'idle') {
        persistConversationSidebarStatus(conversation.id, 'idle', conversation.runtime?.turn_id ?? receipt.turn_id);
      }
      continue;
    }

    if (!receipt || receipt.state === 'idle' || !receiptMatchesRuntime(receipt, conversation)) {
      continue;
    }

    // The terminal-turn guard is durable too: a late content/tool frame after a
    // relaunch must not resurrect a completed row as "running".
    nextCompleted.add(conversation.id);
    nextCompletionUnread.add(conversation.id);
    if (receipt.state === 'attention') nextAttention.add(conversation.id);
    if (receipt.state === 'error') nextError.add(conversation.id);
  }

  generatingConversationIdsState = nextGenerating;
  completionUnreadConversationIdsState = nextCompletionUnread;
  completedConversationIdsState = nextCompleted;
  attentionConversationIdsState = nextAttention;
  errorConversationIdsState = nextError;
};

const applyConversationListRows = (items: TChatConversation[]): void => {
  const filteredData = items.filter((conversation) => {
    // Legacy rows from the pre-provider-probe health check flow are hidden
    // from normal history. New health checks must not create conversations.
    const extra = conversation.extra as { is_health_check?: boolean; team_id?: string; teamId?: string } | undefined;
    return extra?.is_health_check !== true && !extra?.team_id && !extra?.teamId;
  });
  conversationsState = filteredData;
  // Use ALL conversation IDs (including team/legacy health-check rows) so the
  // responseStream listener recognises them as known and doesn't trigger an
  // infinite refreshConversations loop.
  conversation_idsState = new Set(items.map((conversation) => conversation.id));
  for (const conversation_id of localSidebarStatusReceipts.keys()) {
    if (!conversation_idsState.has(conversation_id)) localSidebarStatusReceipts.delete(conversation_id);
  }
  reconcileConversationSidebarStatuses(filteredData);
  emitStoreChange();
};

const refreshConversations = () => {
  const issuedAtEpoch = seatEpoch;
  void ipcBridge.database.getUserConversations
    .invoke({ limit: 10000 })
    .then((result) => {
      if (issuedAtEpoch !== seatEpoch) return; // seat switched mid-flight — stale result, drop
      const items = result?.items;
      if (items && Array.isArray(items)) {
        applyConversationListRows(items);
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
  turnWorkingConversationIdsState = new Set();
  preparingConversationIdsState = new Set();
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
        applyConversationListRows(items);
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

const markTurnWorking = (conversation_id: string) => {
  if (turnWorkingConversationIdsState.has(conversation_id)) {
    return;
  }

  turnWorkingConversationIdsState = new Set(turnWorkingConversationIdsState).add(conversation_id);
  emitStoreChange();
};

const clearTurnWorking = (conversation_id: string) => {
  if (!turnWorkingConversationIdsState.has(conversation_id)) {
    return;
  }

  const next = new Set(turnWorkingConversationIdsState);
  next.delete(conversation_id);
  turnWorkingConversationIdsState = next;
  emitStoreChange();
};

/**
 * Mirror the document-preparation store into `preparingConversationIdsState`.
 * The source store owns the started/settled lifecycle; this only re-syncs the
 * reflection (and no-ops when nothing changed, so no render storms).
 */
const syncPreparingConversations = () => {
  const next = new Set(getDocumentPreparationConversationIds());
  if (
    next.size === preparingConversationIdsState.size &&
    [...next].every((id) => preparingConversationIdsState.has(id))
  ) {
    return;
  }

  preparingConversationIdsState = next;
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
  const changed = activeConversationIdState !== conversation_id;
  activeConversationIdState = conversation_id;
  // Opening a conversation means the user has seen its resting state, so clear
  // the "needs you" / "errored" flags (mirrors clearCompletionUnread).
  if (conversation_id) {
    clearCompletionUnreadState(conversation_id);
    clearAttention(conversation_id);
    clearError(conversation_id);
    clearCompleted(conversation_id);
    if (changed) {
      const conversation = conversationsState.find(({ id }) => id === conversation_id);
      if (conversation) {
        const receipt = getEffectiveSidebarStatusReceipt(conversation, configService.getCurrentSeatId());
        if (receipt && receipt.state !== 'idle') {
          persistConversationSidebarStatus(conversation_id, 'idle', getConversationTurnId(conversation_id));
        }
      }
    }
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
    invalidateConversationRuntimeForSeatRebind();
    clearGenerationForBackendRespawn();
    localSidebarStatusReceipts.clear();
    sidebarStatusWriteChains.clear();
    localGeneratingTurnIds.clear();
    resetAutoProjectRelayState();
    lastSidebarReceiptUpdatedAt = 0;
    resetConversationListForSeatSwitch();
    refreshConversationsForSeatSwitch(seatEpoch);
  });

  addEventListener('chat.history.refresh', refreshConversations);
  // Pre-stream "working" signals: the send lifecycle (submitted/accepted/failed)
  // and the document-preparation store. Both feed the same per-row working
  // state the stream frames feed, so a row lights up in EVERY active phase.
  addEventListener('conversation.turn.working', ({ conversation_id, working }) => {
    if (!conversation_id) return;
    if (working) {
      markTurnWorking(conversation_id);
    } else {
      clearTurnWorking(conversation_id);
    }
  });
  subscribeConversationDocumentPreparation(syncPreparingConversations);
  ipcBridge.conversation.listChanged.on((event) => {
    if (event.action === 'deleted') {
      clearGenerating(event.conversation_id);
      clearTurnWorking(event.conversation_id);
      clearCompletionUnreadState(event.conversation_id);
      clearCompleted(event.conversation_id);
      clearAttention(event.conversation_id);
      clearError(event.conversation_id);
      localSidebarStatusReceipts.delete(event.conversation_id);
      localGeneratingTurnIds.delete(event.conversation_id);
      clearAutoProjectRelayForConversation(event.conversation_id);
    }
    refreshConversations();
  });
  ipcBridge.conversation.responseStream.on((message) => {
    const conversation_id = message.conversation_id;
    if (!conversation_id) {
      return;
    }

    const terminalType = classifyConversationStreamTerminal(message);
    const terminal = terminalType !== null;
    if (
      !shouldApplyConversationStreamTurn({
        conversation_id,
        consumer: 'conversation_list_sync',
        terminal,
        turn_id: message.turn_id,
        type: terminalType ?? message.type,
      })
    ) {
      logLateStreamIgnored(conversation_id, message.type);
      return;
    }

    relaySuccessfulTurnToAutoProject(message);

    if (!conversation_idsState.has(conversation_id)) {
      refreshConversations();
    }

    if (terminal) {
      const wasGenerating = generatingConversationIdsState.has(conversation_id);
      const isErrorStream = terminalType === 'error';
      if (isErrorStream && activeConversationIdState !== conversation_id) {
        // A failed/disconnected turn is the loudest resting state — flag it red
        // (unless the user is already looking at this conversation).
        markError(conversation_id);
      }
      if (wasGenerating) {
        // Keep a visible completion receipt even when the operator is already
        // inside this conversation. It is cleared by the next explicit open,
        // while a fresh turn temporarily replaces it with the running state.
        markCompletionUnread(conversation_id);
      }
      const restingState: ConversationSidebarRestingState | null =
        isErrorStream && activeConversationIdState !== conversation_id ? 'error' : wasGenerating ? 'done' : null;
      if (restingState) {
        persistConversationSidebarStatus(conversation_id, restingState, message.turn_id || null);
      }
      localGeneratingTurnIds.delete(conversation_id);
      markCompleted(conversation_id);
      clearGenerating(conversation_id);
      clearTurnWorking(conversation_id);
      return;
    }

    const decision = getSidebarStreamGuardDecision({
      type: message.type,
      completed: completedConversationIdsState.has(conversation_id),
    });
    if (message.type === 'start') {
      // A fresh turn clears any stale resting flags from the previous turn so the
      // row doesn't keep an old "errored"/"needs you" dot while it's regenerating.
      clearCompletionUnreadState(conversation_id);
      clearAttention(conversation_id);
      clearError(conversation_id);
      localGeneratingTurnIds.set(conversation_id, message.turn_id || null);
      persistConversationSidebarStatus(conversation_id, 'idle', message.turn_id || null);
    }
    if (decision.clearCompleted) {
      clearCompleted(conversation_id);
    }
    if (decision.lateIgnored) {
      logLateStreamIgnored(conversation_id, message.type);
      return;
    }
    if (decision.markGenerating) {
      if (!localGeneratingTurnIds.has(conversation_id)) {
        localGeneratingTurnIds.set(conversation_id, message.turn_id || null);
      }
      markGenerating(conversation_id);
    }
  });
  ipcBridge.conversation.turnCompleted.on((event) => {
    if (
      !shouldApplyConversationTurnCompleted({
        conversation_id: event.session_id,
        consumer: 'conversation_list_sync',
        turn_id: event.turn_id,
        runtime_turn_id: event.runtime?.turn_id,
      })
    ) {
      logLateStreamIgnored(event.session_id, 'turn.completed');
      return;
    }

    if (event.runtime?.is_processing) {
      clearCompleted(event.session_id);
      localGeneratingTurnIds.set(event.session_id, event.runtime.turn_id ?? event.turn_id ?? null);
      // The backend took the turn over — the local send gate is superseded by
      // the durable is_processing truth, which markGenerating now reflects.
      clearTurnWorking(event.session_id);
      markGenerating(event.session_id);
      refreshConversations();
      return;
    }

    const isUnseen = activeConversationIdState !== event.session_id;
    if (isTerminalTurnState(event.state)) {
      const completedTurnId = normalizeStreamIdentity(event.turn_id);
      if (completedTurnId && (event.state === 'error' || event.state === 'stopped')) {
        failAutoProjectTurn(event.session_id, completedTurnId);
      } else if (
        completedTurnId &&
        event.status === 'finished' &&
        event.state === 'ai_waiting_input' &&
        event.has_substantive_output &&
        event.can_send_message &&
        !event.runtime?.is_processing
      ) {
        // Only the explicit AionCore outcome/output evidence may recover a
        // compacted stream. Legacy `status=finished` is deliberately UNKNOWN
        // in the mapper and can never become success by inference.
        let entry = findAutoProjectRelayTurn(event.session_id, completedTurnId);
        if (!entry) {
          const currentTurnCorrelates =
            conversation_idsState.has(event.session_id) &&
            (localGeneratingTurnIds.get(event.session_id) === completedTurnId ||
              getConversationTurnId(event.session_id) === completedTurnId);
          if (currentTurnCorrelates) {
            let turns = autoProjectTurnRelayState.get(event.session_id);
            if (!turns) {
              turns = new Map();
              autoProjectTurnRelayState.set(event.session_id, turns);
            }
            const state: AutoProjectTurnRelayState = {
              turnId: completedTurnId,
              hasSubstantiveOutput: true,
              terminalSuccessObserved: true,
              seatEpoch,
              requestScheduled: false,
              retryTimer: null,
            };
            turns.set(completedTurnId, state);
            entry = [completedTurnId, state];
          }
        }
        if (entry && entry[1].seatEpoch === seatEpoch) {
          entry[1].turnId ??= completedTurnId;
          entry[1].hasSubstantiveOutput = true;
          entry[1].terminalSuccessObserved = true;
          scheduleAutoProjectRequest(event.session_id, entry[0], entry[1]);
        }
      }
      markCompletionUnread(event.session_id);
      // Split the terminal turn states into their semantic resting flags:
      //   ai_waiting_input → attention (EVE is waiting on the user)
      //   error / stopped  → error     (the turn failed / was interrupted)
      // Attention/error remain unread-only so an already visible failure does
      // not masquerade as a new background notification.
      if (isUnseen && event.state === 'ai_waiting_input') {
        markAttention(event.session_id);
      } else if (isUnseen && (event.state === 'error' || event.state === 'stopped')) {
        markError(event.session_id);
      }
      const restingState: ConversationSidebarRestingState = isUnseen
        ? event.state === 'ai_waiting_input'
          ? 'attention'
          : 'error'
        : 'done';
      persistConversationSidebarStatus(event.session_id, restingState, event.turn_id || null);
    }
    localGeneratingTurnIds.delete(event.session_id);
    markCompleted(event.session_id);
    clearGenerating(event.session_id);
    clearTurnWorking(event.session_id);
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
    turnWorkingConversationIds,
    preparingConversationIds,
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

  /**
   * "Working" for the row = the UNION of every live-activity truth:
   * stream frames + runtime.is_processing + local turn tracking (the
   * `generating` set), the send-lifecycle gate (`turnWorking`), and the
   * document-preparation mirror (`preparing`). One semantic status — the row
   * simply shows "EVE arbeitet" in every active phase, pre-stream included.
   */
  const isConversationGenerating = useCallback(
    (conversation_id: string) => {
      return (
        generatingConversationIds.has(conversation_id) ||
        turnWorkingConversationIds.has(conversation_id) ||
        preparingConversationIds.has(conversation_id)
      );
    },
    [generatingConversationIds, turnWorkingConversationIds, preparingConversationIds]
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
