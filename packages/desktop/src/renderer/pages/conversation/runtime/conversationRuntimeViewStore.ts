/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';
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

export type ConversationRuntimeAttemptTicket = {
  kind: 'send' | 'stop';
  conversationId: string;
  seatId: string;
  attemptId: number;
  seatGeneration: number;
};

/**
 * Lightweight renderer authority captured synchronously at the user-action
 * boundary. Unlike an attempt ticket it does not reserve the conversation; it
 * only proves that later async preparation/queue callbacks still belong to the
 * same seat generation.
 */
export type ConversationRuntimeSeatTicket = {
  conversationId: string;
  seatId: string;
  rebindEpoch: number;
  seatGeneration: number;
};

export type ConversationRuntimeMutationResult = {
  applied: boolean;
  logs: ConversationRuntimeViewLogEntry[];
  replayTurnCompleted?: IConversationTurnCompletedEvent;
};

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
export type ConversationStreamTurnConsumer = 'conversation_list_sync' | 'generation_activity';
export type ConversationTurnCompletedConsumer = 'conversation_list_sync' | 'runtime_view';
type ConversationStreamTerminalReceipt = {
  turnId: string;
  type: string;
  consumers: Set<ConversationStreamTurnConsumer>;
};
type ConversationRuntimeMetadata = {
  pendingLocalSendSeq: number | null;
  pendingStopTurnId: string | null;
  lastCompletedTurnId: string | null;
  activeStreamTurnId: string | null;
  recoveredTerminalStreamTurnId: string | null;
  streamTerminalReceipt: ConversationStreamTerminalReceipt | null;
  streamSeatEpoch: number | null;
};

type PendingSendAttempt = {
  ticket: ConversationRuntimeAttemptTicket;
  stage: 'issued' | 'started';
  deferredCompletions: Map<string, IConversationTurnCompletedEvent>;
};

type PendingStopAttempt = {
  ticket: ConversationRuntimeAttemptTicket;
  stage: 'issued' | 'requested';
  turnId: string | null;
};

const listeners = new Set<ConversationRuntimeViewListener>();
const runtimeViews = new Map<string, ConversationRuntimeView>();
const fallbackSnapshots = new Map<string, ConversationRuntimeView>();
const runtimeMetadata = new Map<string, ConversationRuntimeMetadata>();
const pendingSendAttempts = new Map<string, PendingSendAttempt>();
const pendingStopAttempts = new Map<string, PendingStopAttempt>();
const turnCompletedReceipts = new Map<string, Set<ConversationTurnCompletedConsumer>>();
const turnCompletedReplayListeners = new Map<
  ConversationTurnCompletedConsumer,
  Set<(event: IConversationTurnCompletedEvent) => void>
>();
let streamSeatEpoch = 0;
let requirePositiveStreamIdentity = false;
let boundStreamSeatId: string | null = null;
let boundConfigSeatRebindEpoch: number | null = null;
let nextRuntimeAttemptId = 0;

const fenceConversationRuntimeSeat = (seatId: string, rebindEpoch: number): void => {
  boundStreamSeatId = seatId;
  boundConfigSeatRebindEpoch = rebindEpoch;
  streamSeatEpoch += 1;
  requirePositiveStreamIdentity = true;
  runtimeViews.clear();
  fallbackSnapshots.clear();
  runtimeMetadata.clear();
  pendingSendAttempts.clear();
  pendingStopAttempts.clear();
  turnCompletedReceipts.clear();
  listeners.forEach((listener) => listener());
};

const synchronizeConversationRuntimeSeat = (): void => {
  const binding = configService.getSeatBindingSnapshot();

  if (boundConfigSeatRebindEpoch === null) {
    // ConfigService begins on the legacy seat and silently resolves the actual
    // boot seat during initialize(). Until that first initialization settles,
    // preserve the historical/background completion contract. The first
    // authoritative epoch-zero binding is boot, not a user seat transition.
    if (binding.rebindEpoch === 0 && !binding.initialized) return;
    if (binding.rebindEpoch === 0) {
      boundStreamSeatId = binding.seatId;
      boundConfigSeatRebindEpoch = binding.rebindEpoch;
      return;
    }
    fenceConversationRuntimeSeat(binding.seatId, binding.rebindEpoch);
    return;
  }

  if (binding.rebindEpoch === boundConfigSeatRebindEpoch && binding.seatId === boundStreamSeatId) {
    return;
  }

  // An epoch advance is an explicit rebind. A seat-id change without an epoch
  // advance is an invariant breach; fence it too instead of silently rebasing.
  fenceConversationRuntimeSeat(binding.seatId, binding.rebindEpoch);
};

const createRuntimeMetadata = (): ConversationRuntimeMetadata => ({
  pendingLocalSendSeq: null,
  pendingStopTurnId: null,
  lastCompletedTurnId: null,
  activeStreamTurnId: null,
  recoveredTerminalStreamTurnId: null,
  streamTerminalReceipt: null,
  streamSeatEpoch: requirePositiveStreamIdentity ? null : streamSeatEpoch,
});

const createRuntimeAttemptTicket = (
  kind: ConversationRuntimeAttemptTicket['kind'],
  conversationId: string
): ConversationRuntimeAttemptTicket => ({
  kind,
  conversationId,
  seatId: configService.getSeatBindingSnapshot().seatId,
  attemptId: ++nextRuntimeAttemptId,
  seatGeneration: streamSeatEpoch,
});

const isRuntimeSeatAdmissionBlocked = (): boolean => {
  const binding = configService.getSeatBindingSnapshot();
  // Epoch zero + uninitialized is the historical boot window. Once an explicit
  // renderer transition has advanced the epoch, admission remains closed until
  // the authoritative terminal seat cache is fully initialized.
  return binding.rebindEpoch > 0 && !binding.initialized;
};

const attemptTicketMatches = (
  pending: PendingSendAttempt | PendingStopAttempt | undefined,
  ticket: ConversationRuntimeAttemptTicket,
  kind: ConversationRuntimeAttemptTicket['kind']
): boolean => {
  const binding = configService.getSeatBindingSnapshot();
  return (
    !isRuntimeSeatAdmissionBlocked() &&
    pending !== undefined &&
    pending.ticket.kind === kind &&
    ticket.kind === kind &&
    pending.ticket.conversationId === ticket.conversationId &&
    pending.ticket.seatId === ticket.seatId &&
    pending.ticket.seatGeneration === ticket.seatGeneration &&
    pending.ticket.attemptId === ticket.attemptId &&
    ticket.seatId === binding.seatId &&
    ticket.seatGeneration === streamSeatEpoch
  );
};

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

export type ConversationStreamTerminalType = 'finish' | 'error';

/**
 * Canonical terminal classifier for every renderer-global response-stream
 * consumer. ACP may close a turn with a direct finish/error frame or with an
 * agent-status failure. Map both failure shapes to the same `error` identity so
 * the per-consumer terminal receipt can admit each production listener exactly
 * once regardless of subscription order.
 */
export const classifyConversationStreamTerminal = (
  message: { type?: string; data?: unknown } | null | undefined
): ConversationStreamTerminalType | null => {
  if (message?.type === 'finish') return 'finish';
  if (message?.type === 'error') return 'error';
  if (message?.type !== 'agent_status' || !message.data || typeof message.data !== 'object') return null;

  const status = (message.data as { status?: unknown }).status;
  return status === 'error' || status === 'disconnected' ? 'error' : null;
};

/**
 * Canonical turn-identity seam for renderer-global response-stream consumers.
 *
 * A recovered idle turn may still deliver its exact terminal frame, which is
 * needed by the local completion/TTS path. Once a newer local submit begins,
 * however, no frame from the recovered turn may mutate global generation or
 * sidebar state. The lifecycle functions below own identity changes. Failed
 * terminals reach each registered consumer once; successful finish replay
 * remains downstream-owned.
 */
export const shouldApplyConversationStreamTurn = (input: {
  conversation_id: string;
  consumer: ConversationStreamTurnConsumer;
  terminal: boolean;
  turn_id?: unknown;
  type?: string;
}): boolean => {
  const conversation_id = input.conversation_id;
  if (!conversation_id) return false;
  synchronizeConversationRuntimeSeat();
  if (isRuntimeSeatAdmissionBlocked()) return false;

  const metadata = getRuntimeMetadata(conversation_id);
  const view = getConversationRuntimeViewSnapshot(conversation_id);
  const turnId = normalizeStreamTurnId(input.turn_id);
  const activeRuntimeTurnId = view.activeTurnId;
  const terminalType = input.type ?? 'terminal';

  if (requirePositiveStreamIdentity && metadata.streamSeatEpoch !== streamSeatEpoch) {
    // A terminal can never establish authority after a seat boundary, even
    // when it has no turn id. Only an explicit new-seat start or the local/
    // runtime lifecycle below may reopen response-stream admission.
    if (input.terminal || input.type !== 'start') return false;
    metadata.streamSeatEpoch = streamSeatEpoch;
  }

  if (input.terminal && turnId && metadata.streamTerminalReceipt?.turnId === turnId) {
    const receipt = metadata.streamTerminalReceipt;
    if (receipt.type !== terminalType || receipt.consumers.has(input.consumer)) return false;
    metadata.streamTerminalReceipt = {
      ...receipt,
      consumers: new Set([...receipt.consumers, input.consumer]),
    };
    return true;
  }

  const acceptTerminal = () => {
    if (!turnId) return;
    metadata.activeStreamTurnId = null;
    metadata.recoveredTerminalStreamTurnId = turnId;
    metadata.streamTerminalReceipt =
      terminalType === 'error'
        ? {
            turnId,
            type: terminalType,
            consumers: new Set([input.consumer]),
          }
        : null;
  };

  const acceptActiveStreamTurn = () => {
    metadata.streamSeatEpoch = streamSeatEpoch;
    if (!turnId) return;
    metadata.recoveredTerminalStreamTurnId = null;
    metadata.streamTerminalReceipt = null;
    metadata.activeStreamTurnId = turnId;
  };

  // The send path has announced a newer logical turn, but its exact backend ID
  // is not available yet. Failing closed here prevents a recovered A frame from
  // being mistaken for B during that submission window.
  if (view.localSubmitting && !view.activeTurnId) return false;

  if (!turnId) {
    // Once an exact stream identity exists, an uncorrelated terminal cannot
    // close it. This is especially important after a seat boundary: a late
    // no-id terminal from seat A must not clear a valid seat-B turn.
    if (input.terminal && requirePositiveStreamIdentity) return false;
    if (input.type === 'start') {
      metadata.streamSeatEpoch = streamSeatEpoch;
    }
    return !activeRuntimeTurnId && !metadata.activeStreamTurnId && !view.localSubmitting;
  }

  if (activeRuntimeTurnId) {
    if (activeRuntimeTurnId !== turnId) return false;
    if (metadata.recoveredTerminalStreamTurnId === turnId && !input.terminal) return false;
    if (input.terminal) {
      acceptTerminal();
    } else {
      metadata.activeStreamTurnId = turnId;
    }
    return true;
  }

  if (metadata.recoveredTerminalStreamTurnId) {
    // Durable recovery already established this exact turn as successful. Only
    // its delayed `finish` may still supply the renderer completion/TTS receipt;
    // a contradictory late error must not paint the recovered row red.
    if (metadata.recoveredTerminalStreamTurnId === turnId) {
      if (input.type !== 'finish') return false;
      acceptTerminal();
      return true;
    }
    // A different non-terminal frame is the only stream-side proof that a
    // background/native conversation moved on. This keeps compact streams
    // (which may begin with content rather than start) working while exact
    // late frames from the recovered turn remain fail-closed above.
    if (input.terminal) {
      acceptTerminal();
      return true;
    }
    acceptActiveStreamTurn();
    return true;
  }

  if (metadata.activeStreamTurnId) {
    if (metadata.activeStreamTurnId === turnId) {
      if (input.terminal) {
        acceptTerminal();
      }
      return true;
    }
    // Without runtime/send lifecycle truth, a start frame is the only valid
    // handoff for a background/native conversation. It supersedes a provisional
    // stream identity; non-start frames from the old identity remain rejected.
    if (input.type !== 'start') return false;
    acceptActiveStreamTurn();
    return true;
  }

  // Preserve background-stream support when the conversation UI was not
  // mounted. A legacy terminal can still close the pre-stream working phase,
  // but it must not become a future active identity.
  if (input.terminal) {
    acceptTerminal();
    return true;
  }
  acceptActiveStreamTurn();
  return true;
};

/**
 * Non-mutating admission gate shared by the two renderer consumers of the
 * durable `turn.completed` event. After a seat boundary, completion itself is
 * never authority: an explicit stream start, runtime hydration, or local send
 * must first bind this conversation to the current renderer generation.
 *
 * The lookup deliberately avoids the snapshot/metadata getters because those
 * create fallback state. A rejected old-seat completion therefore cannot
 * recreate runtime identity for a same-id conversation in the new seat.
 */
export const shouldApplyConversationTurnCompleted = (input: {
  conversation_id: string;
  consumer: ConversationTurnCompletedConsumer;
  turn_id?: unknown;
  runtime_turn_id?: unknown;
}): boolean => {
  if (!input.conversation_id) return false;
  synchronizeConversationRuntimeSeat();
  if (isRuntimeSeatAdmissionBlocked()) return false;

  const metadata = runtimeMetadata.get(input.conversation_id);
  const view = runtimeViews.get(input.conversation_id) ?? fallbackSnapshots.get(input.conversation_id);
  const turnId = normalizeStreamTurnId(input.turn_id) ?? normalizeStreamTurnId(input.runtime_turn_id);

  // A durable completion that races the send response has no seat or attempt
  // identity of its own. Until local-send acceptance binds the returned turn,
  // neither real consumer may let that event clear/paint the current seat.
  if (pendingSendAttempts.has(input.conversation_id)) return false;

  if (requirePositiveStreamIdentity) {
    if (!metadata || metadata.streamSeatEpoch !== streamSeatEpoch || !turnId) return false;

    const boundTurnId = view?.activeTurnId ?? metadata.activeStreamTurnId ?? metadata.recoveredTerminalStreamTurnId;
    // A completion has no seat field, so a generation-only bind is not enough:
    // require an exact turn established by stream start, runtime hydration, or
    // local-send acceptance. This keeps a delayed old-seat completion from
    // claiming a current-seat local-submit window.
    return boundTurnId === turnId;
  }

  // Preserve legacy/background durable completions before the first renderer
  // seat transition, while retaining the existing exact active-turn fence.
  const activeTurnId = view?.activeTurnId ?? metadata?.activeStreamTurnId;
  return !activeTurnId || !turnId || activeTurnId === turnId;
};

export type ConversationTurnCompletedAdmission = 'apply' | 'defer' | 'reject';

const turnCompletedFingerprint = (event: IConversationTurnCompletedEvent): string =>
  [
    event.session_id,
    event.turn_id,
    event.status,
    event.state,
    event.runtime?.turn_id ?? '',
    event.runtime?.state ?? '',
    event.runtime?.is_processing ? '1' : '0',
    event.can_send_message ? '1' : '0',
    event.has_substantive_output ? '1' : '0',
  ].join('\u0000');

export const admitConversationTurnCompleted = (input: {
  event: IConversationTurnCompletedEvent;
  consumer: ConversationTurnCompletedConsumer;
}): ConversationTurnCompletedAdmission => {
  const conversation_id = input.event.session_id;
  if (!conversation_id) return 'reject';
  synchronizeConversationRuntimeSeat();

  const pending = pendingSendAttempts.get(conversation_id);
  if (pending) {
    const turnId = normalizeStreamTurnId(input.event.turn_id) ?? normalizeStreamTurnId(input.event.runtime?.turn_id);
    if (pending.stage !== 'started' || !turnId) return 'reject';
    pending.deferredCompletions.delete(turnId);
    pending.deferredCompletions.set(turnId, input.event);
    while (pending.deferredCompletions.size > 4) {
      const oldest = pending.deferredCompletions.keys().next().value as string | undefined;
      if (!oldest) break;
      pending.deferredCompletions.delete(oldest);
    }
    return 'defer';
  }

  if (
    !shouldApplyConversationTurnCompleted({
      conversation_id,
      consumer: input.consumer,
      turn_id: input.event.turn_id,
      runtime_turn_id: input.event.runtime?.turn_id,
    })
  ) {
    return 'reject';
  }

  const fingerprint = turnCompletedFingerprint(input.event);
  const consumers = turnCompletedReceipts.get(fingerprint) ?? new Set<ConversationTurnCompletedConsumer>();
  if (consumers.has(input.consumer)) return 'reject';
  consumers.add(input.consumer);
  turnCompletedReceipts.set(fingerprint, consumers);
  while (turnCompletedReceipts.size > 128) {
    const oldest = turnCompletedReceipts.keys().next().value as string | undefined;
    if (!oldest) break;
    turnCompletedReceipts.delete(oldest);
  }
  return 'apply';
};

export const subscribeConversationTurnCompletedReplay = (
  consumer: ConversationTurnCompletedConsumer,
  listener: (event: IConversationTurnCompletedEvent) => void
): (() => void) => {
  const listenersForConsumer = turnCompletedReplayListeners.get(consumer) ?? new Set();
  listenersForConsumer.add(listener);
  turnCompletedReplayListeners.set(consumer, listenersForConsumer);
  return () => listenersForConsumer.delete(listener);
};

export const replayDeferredConversationTurnCompleted = (event: IConversationTurnCompletedEvent): void => {
  for (const consumer of ['runtime_view', 'conversation_list_sync'] as const) {
    turnCompletedReplayListeners.get(consumer)?.forEach((listener) => listener(event));
  }
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
  runtime: TConversationRuntimeSummary | null,
  expectedSeatId?: string
): ConversationRuntimeViewLogEntry[] => {
  synchronizeConversationRuntimeSeat();
  const observedSeatId = boundStreamSeatId ?? configService.getSeatBindingSnapshot().seatId;
  if (expectedSeatId && expectedSeatId !== observedSeatId) return [];
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
    metadata.streamSeatEpoch = streamSeatEpoch;
    metadata.activeStreamTurnId = runtime.turn_id;
    metadata.recoveredTerminalStreamTurnId = null;
    metadata.streamTerminalReceipt = null;
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
  synchronizeConversationRuntimeSeat();
  if (pendingSendAttempts.has(conversation_id)) return [];
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
  const pendingSend = pendingSendAttempts.get(conversation_id);
  if (pendingSend?.stage === 'started' && (view.activeTurnId === turn_id || metadata.activeStreamTurnId === turn_id)) {
    pendingSendAttempts.delete(conversation_id);
  }
  if (metadata.pendingStopTurnId === turn_id) {
    metadata.pendingStopTurnId = null;
    pendingStopAttempts.delete(conversation_id);
  }
  metadata.lastCompletedTurnId = turn_id;
  metadata.activeStreamTurnId = null;
  metadata.recoveredTerminalStreamTurnId = turn_id;
  metadata.streamTerminalReceipt = null;
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
  pendingSendAttempts.delete(conversation_id);
  pendingStopAttempts.delete(conversation_id);
  listeners.forEach((listener) => listener());
  return previous
    ? [
        createLog('info', 'runtime_view_cleaned', previous, {
          reason: 'conversation_deleted',
        }),
      ]
    : [];
};

export const issueLocalSendAttempt = (conversation_id: string): ConversationRuntimeAttemptTicket | null => {
  synchronizeConversationRuntimeSeat();
  if (!conversation_id || isRuntimeSeatAdmissionBlocked() || pendingSendAttempts.has(conversation_id)) return null;
  const ticket = createRuntimeAttemptTicket('send', conversation_id);
  pendingSendAttempts.set(conversation_id, { ticket, stage: 'issued', deferredCompletions: new Map() });
  return ticket;
};

/** Test/source adapters can use this helper to exercise the complete local-send lifecycle. */
export const beginLocalSendAttempt = (conversation_id: string): ConversationRuntimeAttemptTicket | null => {
  const ticket = issueLocalSendAttempt(conversation_id);
  if (!ticket || !localSendStarted(conversation_id, ticket).applied) return null;
  return ticket;
};

export const localSendStarted = (
  conversation_id: string,
  ticket: ConversationRuntimeAttemptTicket
): ConversationRuntimeMutationResult => {
  synchronizeConversationRuntimeSeat();
  const pending = pendingSendAttempts.get(conversation_id);
  if (!attemptTicketMatches(pending, ticket, 'send') || pending?.stage !== 'issued') {
    return { applied: false, logs: [] };
  }
  pending.stage = 'started';
  const metadata = getRuntimeMetadata(conversation_id);
  metadata.streamSeatEpoch = streamSeatEpoch;
  metadata.pendingLocalSendSeq = (metadata.pendingLocalSendSeq ?? 0) + 1;
  metadata.pendingStopTurnId = null;
  metadata.streamTerminalReceipt = null;
  return {
    applied: true,
    logs: setConversationRuntimeSnapshot(
      conversation_id,
      localSendStartedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id)
    ),
  };
};

export const localSendAccepted = (
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary,
  msg_id: string | undefined,
  ticket: ConversationRuntimeAttemptTicket
): ConversationRuntimeMutationResult => {
  synchronizeConversationRuntimeSeat();
  const pending = pendingSendAttempts.get(conversation_id);
  const metadata = runtimeMetadata.get(conversation_id);
  if (!attemptTicketMatches(pending, ticket, 'send') || pending?.stage !== 'started' || !metadata) {
    return { applied: false, logs: [] };
  }
  const acceptedTurnId = runtime.turn_id ?? turn_id;
  const replayTurnCompleted = pending.deferredCompletions.get(acceptedTurnId);
  pendingSendAttempts.delete(conversation_id);
  metadata.streamSeatEpoch = streamSeatEpoch;
  const staleAfterCompleted = isStaleCompletedRuntimeSummary(runtime, metadata);
  if (!staleAfterCompleted) {
    metadata.pendingLocalSendSeq = null;
    metadata.activeStreamTurnId = runtime.turn_id ?? turn_id;
    metadata.recoveredTerminalStreamTurnId = null;
    metadata.streamTerminalReceipt = null;
  }
  return {
    applied: true,
    ...(replayTurnCompleted ? { replayTurnCompleted } : {}),
    logs: setConversationRuntimeSnapshot(
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
    ),
  };
};

export const localSendFailed = (
  conversation_id: string,
  reason: string,
  ticket: ConversationRuntimeAttemptTicket
): ConversationRuntimeMutationResult => {
  synchronizeConversationRuntimeSeat();
  const pending = pendingSendAttempts.get(conversation_id);
  const metadata = runtimeMetadata.get(conversation_id);
  if (!attemptTicketMatches(pending, ticket, 'send') || pending?.stage !== 'started' || !metadata) {
    return { applied: false, logs: [] };
  }
  pendingSendAttempts.delete(conversation_id);
  metadata.pendingLocalSendSeq = null;
  return {
    applied: true,
    logs: setConversationRuntimeSnapshot(
      conversation_id,
      localSendFailedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, reason)
    ),
  };
};

export const issueLocalStopAttempt = (conversation_id: string): ConversationRuntimeAttemptTicket | null => {
  synchronizeConversationRuntimeSeat();
  if (!conversation_id || isRuntimeSeatAdmissionBlocked() || pendingStopAttempts.has(conversation_id)) return null;
  const ticket = createRuntimeAttemptTicket('stop', conversation_id);
  pendingStopAttempts.set(conversation_id, { ticket, stage: 'issued', turnId: null });
  return ticket;
};

export const localStopRequested = (
  conversation_id: string,
  turn_id: string,
  ticket: ConversationRuntimeAttemptTicket
): ConversationRuntimeMutationResult => {
  synchronizeConversationRuntimeSeat();
  const pending = pendingStopAttempts.get(conversation_id);
  if (!turn_id || !attemptTicketMatches(pending, ticket, 'stop') || pending?.stage !== 'issued') {
    return { applied: false, logs: [] };
  }
  pending.stage = 'requested';
  pending.turnId = turn_id;
  const metadata = getRuntimeMetadata(conversation_id);
  metadata.pendingStopTurnId = turn_id;
  return {
    applied: true,
    logs: setConversationRuntimeSnapshot(
      conversation_id,
      localStopRequestedConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, turn_id)
    ),
  };
};

export const localStopAcknowledged = (
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary,
  ticket: ConversationRuntimeAttemptTicket
): ConversationRuntimeMutationResult => {
  synchronizeConversationRuntimeSeat();
  const pending = pendingStopAttempts.get(conversation_id);
  const metadata = runtimeMetadata.get(conversation_id);
  if (
    !attemptTicketMatches(pending, ticket, 'stop') ||
    pending?.stage !== 'requested' ||
    pending.turnId !== turn_id ||
    !metadata
  ) {
    return { applied: false, logs: [] };
  }
  pendingStopAttempts.delete(conversation_id);
  metadata.pendingStopTurnId = null;
  const staleAfterCompleted = isStaleCompletedRuntimeSummary(runtime, metadata);
  return {
    applied: true,
    logs: setConversationRuntimeSnapshot(
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
    ),
  };
};

export const resetLocalGate = (
  conversation_id: string,
  reason: string,
  ticket: ConversationRuntimeAttemptTicket
): ConversationRuntimeMutationResult => {
  synchronizeConversationRuntimeSeat();
  const pending =
    ticket.kind === 'send' ? pendingSendAttempts.get(conversation_id) : pendingStopAttempts.get(conversation_id);
  const metadata = runtimeMetadata.get(conversation_id);
  const expectedStage = ticket.kind === 'send' ? 'started' : 'requested';
  if (!attemptTicketMatches(pending, ticket, ticket.kind) || pending?.stage !== expectedStage || !metadata) {
    return { applied: false, logs: [] };
  }
  if (ticket.kind === 'send') {
    pendingSendAttempts.delete(conversation_id);
    metadata.pendingLocalSendSeq = null;
  } else {
    pendingStopAttempts.delete(conversation_id);
    metadata.pendingStopTurnId = null;
  }
  return {
    applied: true,
    logs: setConversationRuntimeSnapshot(
      conversation_id,
      resetLocalGateConversationRuntimeView(runtimeViews.get(conversation_id), conversation_id, reason)
    ),
  };
};

export const abandonLocalRuntimeAttempt = (ticket: ConversationRuntimeAttemptTicket): boolean => {
  synchronizeConversationRuntimeSeat();
  const pending =
    ticket.kind === 'send'
      ? pendingSendAttempts.get(ticket.conversationId)
      : pendingStopAttempts.get(ticket.conversationId);
  if (!attemptTicketMatches(pending, ticket, ticket.kind) || pending?.stage !== 'issued') return false;
  if (ticket.kind === 'send') pendingSendAttempts.delete(ticket.conversationId);
  else pendingStopAttempts.delete(ticket.conversationId);
  return true;
};

/**
 * Fence every renderer-global runtime identity when the config cache moves to
 * another seat. Existing subscribers remain mounted, but late old-seat frames
 * cannot mutate the new seat until positive new-seat identity evidence arrives.
 */
export const invalidateConversationRuntimeForSeatRebind = (): void => {
  synchronizeConversationRuntimeSeat();
};

export const getConversationRuntimeSeatGeneration = (): number => {
  synchronizeConversationRuntimeSeat();
  return streamSeatEpoch;
};

export const captureConversationRuntimeSeatTicket = (conversationId: string): ConversationRuntimeSeatTicket => {
  synchronizeConversationRuntimeSeat();
  const binding = configService.getSeatBindingSnapshot();
  return {
    conversationId,
    seatId: binding.seatId,
    rebindEpoch: binding.rebindEpoch,
    seatGeneration: streamSeatEpoch,
  };
};

export const isConversationRuntimeSeatTicketCurrent = (ticket: ConversationRuntimeSeatTicket): boolean => {
  synchronizeConversationRuntimeSeat();
  const binding = configService.getSeatBindingSnapshot();
  return (
    Boolean(ticket.conversationId) &&
    !isRuntimeSeatAdmissionBlocked() &&
    ticket.seatId === binding.seatId &&
    ticket.rebindEpoch === binding.rebindEpoch &&
    ticket.seatGeneration === streamSeatEpoch
  );
};

export const isConversationRuntimeSeatGenerationCurrent = (generation: number): boolean => {
  synchronizeConversationRuntimeSeat();
  return !isRuntimeSeatAdmissionBlocked() && generation === streamSeatEpoch;
};

export const resetConversationRuntimeViewStoreForTest = () => {
  runtimeViews.clear();
  fallbackSnapshots.clear();
  runtimeMetadata.clear();
  pendingSendAttempts.clear();
  pendingStopAttempts.clear();
  turnCompletedReceipts.clear();
  turnCompletedReplayListeners.clear();
  listeners.clear();
  streamSeatEpoch = 0;
  requirePositiveStreamIdentity = false;
  boundStreamSeatId = null;
  boundConfigSeatRebindEpoch = null;
  nextRuntimeAttemptId = 0;
};
