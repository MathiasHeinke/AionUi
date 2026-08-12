/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TConversationRuntimeStateKind, TConversationRuntimeSummary } from '@/common/config/storage';

export type ConversationRuntimeView = {
  conversation_id: string;
  activeTurnId: string | null;
  state: TConversationRuntimeStateKind;
  isProcessing: boolean;
  canSendMessage: boolean;
  pendingConfirmations: number;
  hasBackendRuntime: boolean;
  localSubmitting: boolean;
  hydrated: boolean;
  localStopping: boolean;
};

export type ConversationRuntimeViewLogEvent =
  | 'runtime_hydrated'
  | 'runtime_hydrate_missing_summary'
  | 'turn_completed_applied'
  | 'turn_completed_missing_runtime'
  | 'runtime_release_confirmed'
  | 'local_send_started'
  | 'local_send_accepted'
  | 'local_send_failed'
  | 'local_stop_requested'
  | 'local_stop_acknowledged'
  | 'runtime_view_cleaned';

export type ConversationRuntimeViewLogLevel = 'info' | 'warn';

export type ConversationRuntimeViewLogEntry = {
  level: ConversationRuntimeViewLogLevel;
  event: ConversationRuntimeViewLogEvent;
  data: Record<string, unknown>;
};

type ConversationRuntimeSnapshot = {
  view: ConversationRuntimeView;
  logs: ConversationRuntimeViewLogEntry[];
};

type ConversationRuntimeViewListener = () => void;
type ConversationRuntimeMetadata = {
  pendingLocalSendSeq: number | null;
  pendingStopTurnId: string | null;
  lastCompletedTurnId: string | null;
  activeStreamTurnId: string | null;
  recoveredTerminalStreamTurnId: string | null;
};

const listeners = new Set<ConversationRuntimeViewListener>();
const runtimeViews = new Map<string, ConversationRuntimeView>();
const fallbackSnapshots = new Map<string, ConversationRuntimeView>();
const runtimeMetadata = new Map<string, ConversationRuntimeMetadata>();

const createRuntimeMetadata = (): ConversationRuntimeMetadata => ({
  pendingLocalSendSeq: null,
  pendingStopTurnId: null,
  lastCompletedTurnId: null,
  activeStreamTurnId: null,
  recoveredTerminalStreamTurnId: null,
});

const getRuntimeMetadata = (conversation_id: string): ConversationRuntimeMetadata => {
  const existing = runtimeMetadata.get(conversation_id);
  if (existing) {
    return existing;
  }

  const next = createRuntimeMetadata();
  runtimeMetadata.set(conversation_id, next);
  return next;
};

export const createDefaultConversationRuntimeView = (conversation_id: string): ConversationRuntimeView => ({
  conversation_id,
  activeTurnId: null,
  state: 'idle',
  isProcessing: false,
  canSendMessage: true,
  pendingConfirmations: 0,
  hasBackendRuntime: false,
  localSubmitting: false,
  hydrated: false,
  localStopping: false,
});

const summarizeView = (view: ConversationRuntimeView): Record<string, unknown> => ({
  conversation_id: view.conversation_id,
  activeTurnId: view.activeTurnId,
  state: view.state,
  isProcessing: view.isProcessing,
  canSendMessage: view.canSendMessage,
  pendingConfirmations: view.pendingConfirmations,
  hasBackendRuntime: view.hasBackendRuntime,
  localSubmitting: view.localSubmitting,
  hydrated: view.hydrated,
  localStopping: view.localStopping,
});

const createLog = (
  level: ConversationRuntimeViewLogLevel,
  event: ConversationRuntimeViewLogEvent,
  view: ConversationRuntimeView,
  data: Record<string, unknown> = {}
): ConversationRuntimeViewLogEntry => ({
  level,
  event,
  data: {
    ...summarizeView(view),
    ...data,
  },
});

const viewFromRuntimeSummary = (
  previous: ConversationRuntimeView,
  runtime: TConversationRuntimeSummary,
  metadata: ConversationRuntimeMetadata,
  options: { preservePendingLocalSend?: boolean } = {}
): ConversationRuntimeView => {
  const pendingLocalSend = metadata.pendingLocalSendSeq !== null && options.preservePendingLocalSend !== false;
  const activeTurnId = runtime.turn_id ?? null;
  const localStopping =
    metadata.pendingStopTurnId !== null &&
    metadata.pendingStopTurnId === activeTurnId &&
    runtime.is_processing === true;

  return {
    ...previous,
    activeTurnId,
    state: pendingLocalSend && runtime.state === 'idle' ? 'starting' : runtime.state,
    isProcessing: pendingLocalSend || runtime.is_processing,
    canSendMessage: !pendingLocalSend && runtime.can_send_message,
    pendingConfirmations: runtime.pending_confirmations,
    hasBackendRuntime: true,
    hydrated: true,
    localSubmitting: pendingLocalSend,
    localStopping,
  };
};

const isStaleCompletedRuntimeSummary = (
  runtime: TConversationRuntimeSummary | null,
  metadata: ConversationRuntimeMetadata
): boolean =>
  runtime !== null &&
  runtime.turn_id !== null &&
  metadata.lastCompletedTurnId === runtime.turn_id &&
  runtime.is_processing === true;

const normalizeStreamTurnId = (turn_id: unknown): string | null =>
  typeof turn_id === 'string' && turn_id.trim() ? turn_id.trim() : null;

/**
 * Canonical turn-identity seam for renderer-global response-stream consumers.
 *
 * A recovered idle turn may still deliver its exact terminal frame, which is
 * needed by the local completion/TTS path. Once a newer local submit begins,
 * however, no frame from the recovered turn may mutate global generation or
 * sidebar state. The lifecycle functions below own identity changes; consumers
 * use this one idempotent decision instead of maintaining their own heuristics.
 */
export const shouldApplyConversationStreamTurn = (input: {
  conversation_id: string;
  terminal: boolean;
  turn_id?: unknown;
  type?: string;
}): boolean => {
  const conversation_id = input.conversation_id;
  if (!conversation_id) return false;

  const metadata = getRuntimeMetadata(conversation_id);
  const view = getConversationRuntimeViewSnapshot(conversation_id);
  const turnId = normalizeStreamTurnId(input.turn_id);
  const activeRuntimeTurnId = view.activeTurnId;

  // The send path has announced a newer logical turn, but its exact backend ID
  // is not available yet. Failing closed here prevents a recovered A frame from
  // being mistaken for B during that submission window.
  if (view.localSubmitting && !view.activeTurnId) return false;

  if (!turnId) {
    return !activeRuntimeTurnId && !view.localSubmitting;
  }

  if (activeRuntimeTurnId) {
    if (activeRuntimeTurnId !== turnId) return false;
    if (metadata.recoveredTerminalStreamTurnId === turnId && !input.terminal) return false;
    if (input.terminal) {
      metadata.activeStreamTurnId = null;
      metadata.recoveredTerminalStreamTurnId = turnId;
    } else {
      metadata.activeStreamTurnId = turnId;
    }
    return true;
  }

  if (metadata.recoveredTerminalStreamTurnId) {
    // Durable recovery already established this exact turn as successful. Only
    // its delayed `finish` may still supply the renderer completion/TTS receipt;
    // a contradictory late error must not paint the recovered row red.
    if (metadata.recoveredTerminalStreamTurnId === turnId) return input.type === 'finish';
    // A different non-terminal frame is the only stream-side proof that a
    // background/native conversation moved on. This keeps compact streams
    // (which may begin with content rather than start) working while exact
    // late frames from the recovered turn remain fail-closed above.
    if (input.terminal) return true;
    metadata.recoveredTerminalStreamTurnId = null;
    metadata.activeStreamTurnId = turnId;
    return true;
  }

  if (metadata.activeStreamTurnId) {
    if (metadata.activeStreamTurnId === turnId) {
      if (input.terminal) {
        metadata.activeStreamTurnId = null;
        metadata.recoveredTerminalStreamTurnId = turnId;
      }
      return true;
    }
    // Without runtime/send lifecycle truth, a start frame is the only valid
    // handoff for a background/native conversation. It supersedes a provisional
    // stream identity; non-start frames from the old identity remain rejected.
    if (input.type !== 'start') return false;
    metadata.activeStreamTurnId = turnId;
    return true;
  }

  // Preserve background-stream support when the conversation UI was not
  // mounted. A legacy terminal can still close the pre-stream working phase,
  // but it must not become a future active identity.
  if (input.terminal) return true;
  metadata.activeStreamTurnId = turnId;
  return true;
};

const withLogs = (
  view: ConversationRuntimeView,
  logs: ConversationRuntimeViewLogEntry[] = []
): ConversationRuntimeSnapshot => ({
  view,
  logs,
});

export const hydrateStartedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string
): ConversationRuntimeSnapshot => {
  const view = previous ?? createDefaultConversationRuntimeView(conversation_id);
  return withLogs({
    ...view,
    hydrated: false,
  });
};

export const hydrateSucceededConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  runtime: TConversationRuntimeSummary | null,
  metadata: ConversationRuntimeMetadata = createRuntimeMetadata(),
  options: { preservePendingLocalSend?: boolean } = {}
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);

  if (!runtime) {
    const view = {
      ...base,
      hydrated: true,
    };
    return withLogs(view, [createLog('warn', 'runtime_hydrate_missing_summary', view)]);
  }

  const view = viewFromRuntimeSummary(base, runtime, metadata, options);
  const logs = [createLog('info', 'runtime_hydrated', view)];
  if (view.canSendMessage && !view.isProcessing) {
    logs.push(createLog('info', 'runtime_release_confirmed', view, { source: 'hydrate' }));
  }
  return withLogs(view, logs);
};

export const hydrateFailedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  reason: string
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const view = {
    ...base,
    hydrated: true,
  };
  return withLogs(view, [createLog('warn', 'runtime_hydrate_missing_summary', view, { reason })]);
};

export const turnCompletedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary | null,
  metadata: ConversationRuntimeMetadata = createRuntimeMetadata()
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);

  if (!runtime) {
    const view = {
      ...base,
      hydrated: true,
    };
    return withLogs(view, [createLog('warn', 'turn_completed_missing_runtime', view)]);
  }

  const view = viewFromRuntimeSummary(base, runtime, metadata, { preservePendingLocalSend: false });
  const logs = [createLog('info', 'turn_completed_applied', view, { turn_id })];
  if (view.canSendMessage && !view.isProcessing) {
    logs.push(createLog('info', 'runtime_release_confirmed', view, { source: 'turn_completed' }));
  }
  return withLogs(view, logs);
};

export const localSendStartedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const view: ConversationRuntimeView = {
    ...base,
    state: base.state === 'idle' ? 'starting' : base.state,
    isProcessing: true,
    canSendMessage: false,
    localSubmitting: true,
    hydrated: true,
  };
  return withLogs(view, [createLog('info', 'local_send_started', view)]);
};

export const localSendAcceptedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary,
  msg_id?: string
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const view = viewFromRuntimeSummary(base, runtime, createRuntimeMetadata(), { preservePendingLocalSend: false });
  return withLogs(view, [
    createLog('info', 'local_send_accepted', view, {
      turn_id,
      runtime_turn_id: runtime.turn_id,
      ...(msg_id ? { msg_id } : {}),
    }),
  ]);
};

const staleRuntimeSummaryConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  event: ConversationRuntimeViewLogEvent,
  source: string,
  /**
   * `| null` because callers pass `runtime.turn_id`, which is nullable, and because
   * nothing here decides on it: it lands in the log entry beside
   * `runtime_turn_id: runtime.turn_id`, the very same value under another name.
   * Requiring a string forced a caller to invent one for a record that is meant to
   * say "there was no turn id".
   */
  turn_id: string | null,
  runtime: TConversationRuntimeSummary,
  msg_id?: string
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const view: ConversationRuntimeView = {
    ...base,
    hydrated: true,
  };
  return withLogs(view, [
    createLog('info', event, view, {
      turn_id,
      runtime_turn_id: runtime.turn_id,
      source,
      stale_after_completed: true,
      ...(msg_id ? { msg_id } : {}),
    }),
  ]);
};

export const localSendFailedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  reason: string
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const hasActiveTurn = base.isProcessing && Boolean(base.activeTurnId);
  const view: ConversationRuntimeView = {
    ...base,
    ...(hasActiveTurn
      ? {}
      : {
          state: 'idle',
          isProcessing: false,
          canSendMessage: true,
        }),
    localSubmitting: false,
    hydrated: true,
  };
  return withLogs(view, [createLog('info', 'local_send_failed', view, { reason })]);
};

export const localStopRequestedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  turn_id: string
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const view = {
    ...base,
    localStopping: base.activeTurnId === turn_id && base.isProcessing,
    hydrated: true,
  };
  return withLogs(view, [createLog('info', 'local_stop_requested', view, { turn_id })]);
};

export const localStopAcknowledgedConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary,
  metadata: ConversationRuntimeMetadata = createRuntimeMetadata()
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const view = viewFromRuntimeSummary(base, runtime, metadata, { preservePendingLocalSend: false });
  return withLogs(view, [createLog('info', 'local_stop_acknowledged', view, { turn_id })]);
};

export const resetLocalGateConversationRuntimeView = (
  previous: ConversationRuntimeView | undefined,
  conversation_id: string,
  reason: string
): ConversationRuntimeSnapshot => {
  const base = previous ?? createDefaultConversationRuntimeView(conversation_id);
  const view: ConversationRuntimeView = {
    ...base,
    localSubmitting: false,
    localStopping: false,
    hydrated: true,
  };
  return withLogs(view, [createLog('info', 'runtime_view_cleaned', view, { reason })]);
};

const setConversationRuntimeSnapshot = (conversation_id: string, snapshot: ConversationRuntimeSnapshot) => {
  runtimeViews.set(conversation_id, snapshot.view);
  fallbackSnapshots.set(conversation_id, snapshot.view);
  listeners.forEach((listener) => listener());
  return snapshot.logs;
};

export const subscribeConversationRuntimeView = (listener: ConversationRuntimeViewListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getConversationRuntimeViewSnapshot = (conversation_id: string): ConversationRuntimeView => {
  const existing = runtimeViews.get(conversation_id);
  if (existing) {
    return existing;
  }
  const fallback = fallbackSnapshots.get(conversation_id);
  if (fallback) {
    return fallback;
  }
  const next = createDefaultConversationRuntimeView(conversation_id);
  fallbackSnapshots.set(conversation_id, next);
  return next;
};

export const waitForConversationActiveTurnId = (
  conversation_id: string,
  options: { timeoutMs?: number } = {}
): Promise<string | null> => {
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (turnId: string | null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      unsubscribe?.();
      resolve(turnId);
    };

    const inspect = () => {
      const view = getConversationRuntimeViewSnapshot(conversation_id);
      if (view.activeTurnId) {
        finish(view.activeTurnId);
        return;
      }
      if (!view.isProcessing) finish(null);
    };

    unsubscribe = subscribeConversationRuntimeView(inspect);
    inspect();
    if (!settled) timeout = setTimeout(() => finish(null), timeoutMs);
  });
};

export const hydrateStarted = (conversation_id: string): ConversationRuntimeViewLogEntry[] =>
  setConversationRuntimeSnapshot(
    conversation_id,
    hydrateStartedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id)
  );

export const hydrateSucceeded = (
  conversation_id: string,
  runtime: TConversationRuntimeSummary | null
): ConversationRuntimeViewLogEntry[] => {
  const metadata = getRuntimeMetadata(conversation_id);
  if (isStaleCompletedRuntimeSummary(runtime, metadata)) {
    return setConversationRuntimeSnapshot(
      conversation_id,
      staleRuntimeSummaryConversationRuntimeView(
        runtimeViews.get(conversation_id),
        conversation_id,
        'runtime_hydrated',
        'hydrate',
        runtime.turn_id,
        runtime
      )
    );
  }

  if (runtime?.is_processing && runtime.turn_id) {
    metadata.activeStreamTurnId = runtime.turn_id;
    metadata.recoveredTerminalStreamTurnId = null;
  }

  return setConversationRuntimeSnapshot(
    conversation_id,
    hydrateSucceededConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, runtime, metadata, {
      preservePendingLocalSend: true,
    })
  );
};

export const hydrateFailed = (conversation_id: string, reason: string): ConversationRuntimeViewLogEntry[] =>
  setConversationRuntimeSnapshot(
    conversation_id,
    hydrateFailedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, reason)
  );

export const turnCompleted = (
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary | null
): ConversationRuntimeViewLogEntry[] => {
  const metadata = getRuntimeMetadata(conversation_id);
  const view = getConversationRuntimeViewSnapshot(conversation_id);
  const activeTurnId = view.activeTurnId ?? metadata.activeStreamTurnId;
  if (
    (view.localSubmitting && (activeTurnId !== null || metadata.recoveredTerminalStreamTurnId !== null)) ||
    (activeTurnId !== null && activeTurnId !== turn_id)
  ) {
    // A newer submission/turn owns the conversation now. The delayed durable
    // completion is real for its own turn but cannot replace that ownership.
    return [];
  }
  metadata.pendingLocalSendSeq = null;
  if (metadata.pendingStopTurnId === turn_id) {
    metadata.pendingStopTurnId = null;
  }
  metadata.lastCompletedTurnId = turn_id;
  metadata.activeStreamTurnId = null;
  metadata.recoveredTerminalStreamTurnId = turn_id;
  return setConversationRuntimeSnapshot(
    conversation_id,
    turnCompletedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, turn_id, runtime, metadata)
  );
};

export const conversationDeleted = (conversation_id: string): ConversationRuntimeViewLogEntry[] => {
  const previous = runtimeViews.get(conversation_id) ?? fallbackSnapshots.get(conversation_id);
  runtimeViews.delete(conversation_id);
  fallbackSnapshots.delete(conversation_id);
  runtimeMetadata.delete(conversation_id);
  listeners.forEach((listener) => listener());
  return previous
    ? [
        createLog('info', 'runtime_view_cleaned', previous, {
          reason: 'conversation_deleted',
        }),
      ]
    : [];
};

export const localSendStarted = (conversation_id: string): ConversationRuntimeViewLogEntry[] => {
  const metadata = getRuntimeMetadata(conversation_id);
  metadata.pendingLocalSendSeq = (metadata.pendingLocalSendSeq ?? 0) + 1;
  metadata.pendingStopTurnId = null;
  return setConversationRuntimeSnapshot(
    conversation_id,
    localSendStartedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id)
  );
};

export const localSendAccepted = (
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary,
  msg_id?: string
): ConversationRuntimeViewLogEntry[] => {
  const metadata = getRuntimeMetadata(conversation_id);
  const staleAfterCompleted = isStaleCompletedRuntimeSummary(runtime, metadata);
  if (!staleAfterCompleted) {
    metadata.pendingLocalSendSeq = null;
    metadata.activeStreamTurnId = runtime.turn_id ?? turn_id;
    metadata.recoveredTerminalStreamTurnId = null;
  }
  return setConversationRuntimeSnapshot(
    conversation_id,
    staleAfterCompleted
      ? staleRuntimeSummaryConversationRuntimeView(
          runtimeViews.get(conversation_id),
          conversation_id,
          'local_send_accepted',
          'send_response',
          turn_id,
          runtime,
          msg_id
        )
      : localSendAcceptedConversationRuntimeView(
          runtimeViews.get(conversation_id),
          conversation_id,
          turn_id,
          runtime,
          msg_id
        )
  );
};

export const localSendFailed = (conversation_id: string, reason: string): ConversationRuntimeViewLogEntry[] => {
  const metadata = getRuntimeMetadata(conversation_id);
  metadata.pendingLocalSendSeq = null;
  return setConversationRuntimeSnapshot(
    conversation_id,
    localSendFailedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, reason)
  );
};

export const localStopRequested = (conversation_id: string, turn_id: string): ConversationRuntimeViewLogEntry[] => {
  const metadata = getRuntimeMetadata(conversation_id);
  metadata.pendingStopTurnId = turn_id;
  return setConversationRuntimeSnapshot(
    conversation_id,
    localStopRequestedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, turn_id)
  );
};

export const localStopAcknowledged = (
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary
): ConversationRuntimeViewLogEntry[] => {
  const metadata = getRuntimeMetadata(conversation_id);
  if (metadata.pendingStopTurnId === turn_id) {
    metadata.pendingStopTurnId = null;
  }
  const staleAfterCompleted = isStaleCompletedRuntimeSummary(runtime, metadata);
  return setConversationRuntimeSnapshot(
    conversation_id,
    staleAfterCompleted
      ? staleRuntimeSummaryConversationRuntimeView(
          runtimeViews.get(conversation_id),
          conversation_id,
          'local_stop_acknowledged',
          'stop_response',
          turn_id,
          runtime
        )
      : localStopAcknowledgedConversationRuntimeView(
          runtimeViews.get(conversation_id),
          conversation_id,
          turn_id,
          runtime,
          metadata
        )
  );
};

export const resetLocalGate = (conversation_id: string, reason: string): ConversationRuntimeViewLogEntry[] =>
  setConversationRuntimeSnapshot(
    conversation_id,
    resetLocalGateConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, reason)
  );

export const resetConversationRuntimeViewStoreForTest = () => {
  runtimeViews.clear();
  fallbackSnapshots.clear();
  runtimeMetadata.clear();
  listeners.clear();
};
