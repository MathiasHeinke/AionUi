/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  conversation as conversationBridge,
  type IAcpAsyncCompletionReceipt,
  type IAcpAsyncCompletionReceiptList,
  type IConversationArtifact,
} from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';
import {
  COMMAND_EVE_ASYNC_COMPLETION_VERSION,
  DURABLE_WORK_ACTIVITY_VERSION,
  type DurableWorkActionAckV1,
  type DurableWorkActionCapabilityV1,
  type DurableWorkActionRequestV1,
  type DurableWorkItemV1,
  type DurableWorkReceiptState,
  type DurableWorkSnapshotV1,
  type DurableWorkStatus,
} from '@/common/runtime/durableWorkActivity';
import { installDurableWorkActivityAdapter, type DurableWorkActivityAdapterV1 } from './durableWorkActivityAdapter';

export const AIONCORE_ASYNC_COMPLETION_RECEIPTS_VERSION = 'command-eve-async-completion-receipts/v1' as const;
const CORE_POLL_INTERVAL_MS = 1_500;
const CORE_REFERENCE_VERSION = '8a71ed7+';

type ConversationProjectionState = {
  snapshot: DurableWorkSnapshotV1 | null;
  receiptsByItemId: Map<string, IAcpAsyncCompletionReceipt>;
  cancelTurnByItemId: Map<string, string>;
  signature: string;
  revision: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void> | null;
  consecutiveFailures: number;
};

const coreStates = new Set<IAcpAsyncCompletionReceipt['state']>([
  'processing',
  'pending',
  'completed',
  'rejected',
  'explicit_unknown',
]);
const coreOutcomes = new Set<NonNullable<IAcpAsyncCompletionReceipt['last_outcome']>>([
  'accepted',
  'already_applied',
  'retryable',
  'rejected',
  'explicit_unknown',
]);

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const isCoreReceipt = (value: unknown): value is IAcpAsyncCompletionReceipt => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<IAcpAsyncCompletionReceipt>;
  const validTurnId =
    receipt.state === 'rejected'
      ? receipt.turn_id === undefined
      : typeof receipt.turn_id === 'string' && receipt.turn_id.length > 0;
  return (
    typeof receipt.projection_id === 'string' &&
    receipt.projection_id.length > 0 &&
    typeof receipt.completion_id === 'string' &&
    receipt.completion_id.length > 0 &&
    typeof receipt.acp_session_id === 'string' &&
    receipt.acp_session_id.length > 0 &&
    typeof receipt.state === 'string' &&
    coreStates.has(receipt.state as IAcpAsyncCompletionReceipt['state']) &&
    validTurnId &&
    finiteNonNegative(receipt.attempt_count) &&
    Number.isInteger(receipt.attempt_count) &&
    finiteNonNegative(receipt.created_at) &&
    finiteNonNegative(receipt.updated_at) &&
    receipt.updated_at >= receipt.created_at &&
    (receipt.completed_at === undefined || finiteNonNegative(receipt.completed_at)) &&
    (receipt.last_outcome_at === undefined || finiteNonNegative(receipt.last_outcome_at)) &&
    optionalString(receipt.last_error_code) &&
    optionalString(receipt.last_outcome_code) &&
    (receipt.last_outcome === undefined ||
      (typeof receipt.last_outcome === 'string' && coreOutcomes.has(receipt.last_outcome)))
  );
};

export function normalizeAionCoreReceiptList(
  value: unknown,
  conversationId: string
): IAcpAsyncCompletionReceiptList | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const list = value as Partial<IAcpAsyncCompletionReceiptList>;
  if (
    list.version !== AIONCORE_ASYNC_COMPLETION_RECEIPTS_VERSION ||
    list.conversation_id !== conversationId ||
    list.reconstructed_from !== 'persistent_receipts' ||
    !finiteNonNegative(list.generated_at) ||
    !Array.isArray(list.receipts)
  ) {
    return null;
  }
  const ids = new Set<string>();
  if (
    list.receipts.some((receipt) => {
      if (!isCoreReceipt(receipt) || ids.has(receipt.projection_id)) return true;
      ids.add(receipt.projection_id);
      return false;
    })
  ) {
    return null;
  }
  return list as IAcpAsyncCompletionReceiptList;
}

const disabled = (reason: string): DurableWorkActionCapabilityV1 => ({
  available: false,
  authority: 'hermes_delegation',
  requiresApproval: false,
  reason,
});

const readNonEmptyString = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const artifactCompletionId = (artifact: IConversationArtifact, conversationId: string): string | null => {
  if (artifact.conversation_id !== conversationId || (artifact.status !== 'active' && artifact.status !== 'saved')) {
    return null;
  }
  const payload = artifact.payload as Record<string, unknown>;
  const rawReceipt = payload.receipt;
  if (!rawReceipt || typeof rawReceipt !== 'object' || Array.isArray(rawReceipt)) return null;
  const completionId = (rawReceipt as Record<string, unknown>).completion_id;
  return typeof completionId === 'string' && completionId.length > 0 ? completionId : null;
};

const isOpenableArtifact = (artifact: IConversationArtifact): boolean => {
  const payload = artifact.payload as Record<string, unknown>;
  return Boolean(
    readNonEmptyString(payload, ['html', 'content']) ||
    readNonEmptyString(payload, [
      'url',
      'file_url',
      'href',
      'src',
      'data_url',
      'download_url',
      'output_url',
      'preview_url',
      'path',
      'file_path',
      'absolute_path',
      'relative_path',
    ])
  );
};

const artifactEvidenceByCompletionId = (
  artifacts: readonly IConversationArtifact[],
  conversationId: string
): Map<string, DurableWorkItemV1['evidence']> => {
  const evidence = new Map<string, DurableWorkItemV1['evidence']>();
  for (const artifact of artifacts) {
    const completionId = artifactCompletionId(artifact, conversationId);
    if (!completionId || !isOpenableArtifact(artifact)) continue;
    const payload = artifact.payload as Record<string, unknown>;
    const label =
      readNonEmptyString(payload, ['title', 'name', 'file_name']) || `Worker artifact · ${artifact.id.slice(0, 12)}`;
    const values = evidence.get(completionId) ?? [];
    values.push({
      id: `artifact:${artifact.id}`,
      label,
      kind: 'artifact',
      ref: `artifact:${artifact.id}`,
    });
    evidence.set(completionId, values);
  }
  return evidence;
};

const isLiveReceiptTurn = (
  receipt: IAcpAsyncCompletionReceipt,
  conversation: TChatConversation | null | undefined
): boolean => {
  const runtime = conversation?.runtime;
  return Boolean(
    runtime &&
    typeof receipt.turn_id === 'string' &&
    runtime.turn_id === receipt.turn_id &&
    runtime.has_task &&
    runtime.is_processing &&
    (runtime.state === 'starting' || runtime.state === 'running' || runtime.state === 'waiting_confirmation')
  );
};

const receiptStatus = (receipt: IAcpAsyncCompletionReceipt, liveTurn: boolean): DurableWorkStatus => {
  switch (receipt.last_outcome) {
    case 'accepted':
    case 'already_applied':
      // The wake content was durably applied, but v1 carries no typed child
      // worker result. `stalled` is intentionally conservative without
      // claiming a reconnect failure or fabricating success.
      return 'stalled';
    case 'retryable':
      return 'waiting';
    case 'rejected':
      return 'failed';
    case 'explicit_unknown':
      return 'stalled';
    default:
      if (receipt.state === 'processing') return liveTurn ? 'running' : 'reconnect_unavailable';
      if (receipt.state === 'pending') return 'waiting';
      if (receipt.state === 'rejected') return 'failed';
      // A committed receipt without a typed outcome is inspectable but cannot
      // truthfully advance to a terminal worker result.
      return 'stalled';
  }
};

const statusReason = (receipt: IAcpAsyncCompletionReceipt, liveTurn: boolean): string => {
  if (receipt.last_outcome === 'accepted' || receipt.last_outcome === 'already_applied') {
    return 'worker_terminal_outcome_untyped';
  }
  if (receipt.last_outcome === 'retryable') return receipt.last_outcome_code || 'hermes_retry_owned';
  if (receipt.last_outcome === 'rejected') return receipt.last_outcome_code || 'completion_rejected';
  if (receipt.last_outcome === 'explicit_unknown' || receipt.state === 'explicit_unknown') {
    return receipt.last_outcome_code || receipt.last_error_code || 'explicit_unknown';
  }
  if (receipt.state === 'processing' && !liveTurn) return 'processing_receipt_without_live_turn';
  if (receipt.state === 'completed') return 'worker_terminal_outcome_untyped';
  return receipt.last_error_code || receipt.state;
};

const wakeReceipt = (receipt: IAcpAsyncCompletionReceipt): DurableWorkItemV1['receipts']['wake'] => {
  const outcome = receipt.last_outcome;
  if (!outcome) return undefined;
  return {
    version: COMMAND_EVE_ASYNC_COMPLETION_VERSION,
    id: `aioncore:${receipt.projection_id}:${outcome}`,
    recordedAt: receipt.last_outcome_at ?? receipt.updated_at,
    sequence: receipt.attempt_count,
    state: outcome as DurableWorkReceiptState,
  };
};

const currentStep = (receipt: IAcpAsyncCompletionReceipt, liveTurn: boolean): DurableWorkItemV1['current'] => {
  switch (receipt.last_outcome) {
    case 'retryable':
      return { step: 'Hermes retries durable delivery', tool: 'command_eve/async_completion' };
    case 'accepted':
    case 'already_applied':
      return { step: 'Wake delivery applied; worker outcome untyped', tool: 'command_eve/async_completion' };
    case 'rejected':
      return { step: 'Durable delivery rejected', tool: 'command_eve/async_completion' };
    case 'explicit_unknown':
      return { step: 'Durable delivery outcome explicitly unknown', tool: 'command_eve/async_completion' };
    default:
      if (receipt.state === 'processing' && !liveTurn) {
        return { step: 'Persisted receipt has no matching live turn', tool: 'command_eve/async_completion' };
      }
      return receipt.state === 'processing'
        ? { step: 'AionCore applies durable completion', tool: 'command_eve/async_completion' }
        : { step: 'Awaiting Hermes retry', tool: 'command_eve/async_completion' };
  }
};

const toWorkItem = (
  receipt: IAcpAsyncCompletionReceipt,
  conversationId: string,
  conversation: TChatConversation | null | undefined,
  artifactEvidence: DurableWorkItemV1['evidence'] = []
): DurableWorkItemV1 => {
  const liveTurn = isLiveReceiptTurn(receipt, conversation);
  const cancelAvailable = receipt.state === 'processing' && liveTurn;
  return {
    id: `hermes:${receipt.projection_id}`,
    kind: 'worker',
    origin: {
      conversationId,
      sessionId: receipt.acp_session_id,
    },
    engine: {
      name: 'aioncore',
      version: CORE_REFERENCE_VERSION,
    },
    goal: `Hermes background work · ${receipt.completion_id.slice(0, 12)}`,
    role: 'worker',
    status: receiptStatus(receipt, liveTurn),
    statusReason: statusReason(receipt, liveTurn),
    queuedAt: receipt.created_at,
    startedAt: receipt.created_at,
    lastActivityAt: receipt.updated_at,
    finishedAt: receipt.completed_at,
    current: currentStep(receipt, liveTurn),
    gates:
      receipt.last_outcome === 'retryable'
        ? [{ id: `retry:${receipt.projection_id}`, label: 'Hermes durable retry', state: 'pending' }]
        : receipt.last_outcome === 'explicit_unknown' || receipt.state === 'explicit_unknown'
          ? [{ id: `unknown:${receipt.projection_id}`, label: 'Outcome requires inspection', state: 'blocked' }]
          : [],
    evidence: [
      {
        id: `receipt:${receipt.projection_id}`,
        label: receipt.last_outcome || receipt.state,
        kind: 'receipt',
        ref: `acp-completion:${receipt.projection_id}`,
      },
      ...artifactEvidence,
    ],
    actions: {
      pause: disabled('hermes_pause_transport_unavailable'),
      resume: disabled('hermes_resume_transport_unavailable'),
      retry: disabled(receipt.last_outcome === 'retryable' ? 'hermes_retry_owned' : 'receipt_not_retryable'),
      cancel: cancelAvailable
        ? {
            available: true,
            authority: 'aioncore_cancel',
            requiresApproval: false,
          }
        : disabled('no_active_aioncore_turn'),
    },
    receipts: {
      wake: wakeReceipt(receipt),
    },
    sequence: Math.max(receipt.updated_at, receipt.last_outcome_at ?? 0),
  };
};

const projectNeedsInputItem = (
  conversation: TChatConversation | null | undefined,
  conversationId: string
): DurableWorkItemV1 | null => {
  if (!conversation || conversation.id !== conversationId) return null;
  const runtime = conversation.runtime;
  if (
    runtime?.state !== 'waiting_confirmation' ||
    runtime.pending_confirmations < 1 ||
    typeof runtime.turn_id !== 'string' ||
    runtime.turn_id.length === 0
  ) {
    return null;
  }
  const sequence = Math.max(0, Math.floor(conversation.modified_at || conversation.created_at || Date.now()));
  return {
    id: `aioncore-turn:${runtime.turn_id}`,
    kind: 'goal',
    origin: {
      conversationId,
      sessionId: conversationId,
    },
    engine: {
      name: 'aioncore',
      version: CORE_REFERENCE_VERSION,
    },
    goal: conversation.name || 'Conversation input gate',
    role: 'user gate',
    status: 'needs_input',
    statusReason: 'aioncore_waiting_confirmation',
    queuedAt: conversation.created_at,
    lastActivityAt: conversation.modified_at,
    current: {
      step: 'Waiting for user confirmation',
      tool: 'aioncore/confirm',
    },
    gates: [
      {
        id: `confirmation:${runtime.turn_id}`,
        label: `${runtime.pending_confirmations} pending user confirmation`,
        state: 'needs_input',
      },
    ],
    evidence: [
      {
        id: `runtime:${runtime.turn_id}`,
        label: 'AionCore live confirmation gate',
        kind: 'gate',
        ref: `aioncore-turn:${runtime.turn_id}`,
      },
    ],
    actions: {
      pause: disabled('aioncore_pause_transport_unavailable'),
      resume: disabled('confirmation_requires_user'),
      retry: disabled('confirmation_requires_user'),
      cancel: {
        available: true,
        authority: 'aioncore_cancel',
        requiresApproval: false,
      },
    },
    receipts: {},
    sequence,
  };
};

export function projectAionCoreReceiptList(
  value: unknown,
  conversationId: string,
  revision: number,
  conversation?: TChatConversation | null,
  artifacts: readonly IConversationArtifact[] = []
): {
  snapshot: DurableWorkSnapshotV1;
  receiptsByItemId: Map<string, IAcpAsyncCompletionReceipt>;
  cancelTurnByItemId: Map<string, string>;
} | null {
  const core = normalizeAionCoreReceiptList(value, conversationId);
  if (!core) return null;
  const receiptsByItemId = new Map<string, IAcpAsyncCompletionReceipt>();
  const cancelTurnByItemId = new Map<string, string>();
  const artifactsByCompletionId = artifactEvidenceByCompletionId(artifacts, conversationId);
  const items = core.receipts.map((receipt) => {
    const item = toWorkItem(
      receipt,
      conversationId,
      conversation,
      receipt.state === 'rejected' ? [] : artifactsByCompletionId.get(receipt.completion_id)
    );
    receiptsByItemId.set(item.id, receipt);
    if (item.actions.cancel.available && typeof receipt.turn_id === 'string') {
      cancelTurnByItemId.set(item.id, receipt.turn_id);
    }
    return item;
  });
  const needsInputItem = projectNeedsInputItem(conversation, conversationId);
  if (needsInputItem) {
    items.push(needsInputItem);
    cancelTurnByItemId.set(needsInputItem.id, conversation?.runtime?.turn_id || '');
  }
  return {
    snapshot: {
      version: DURABLE_WORK_ACTIVITY_VERSION,
      conversationId,
      reconstructedFrom: 'persistent_receipts',
      generatedAt: core.generated_at,
      revision,
      items,
    },
    receiptsByItemId,
    cancelTurnByItemId,
  };
}

const degradeSnapshot = (snapshot: DurableWorkSnapshotV1, revision: number): DurableWorkSnapshotV1 => ({
  ...snapshot,
  generatedAt: Date.now(),
  revision,
  items: snapshot.items.map((item) => ({
    ...item,
    status: 'reconnect_unavailable',
    statusReason: 'aioncore_receipt_transport_unavailable',
    actions: {
      pause: disabled('aioncore_receipt_transport_unavailable'),
      resume: disabled('aioncore_receipt_transport_unavailable'),
      retry: disabled('aioncore_receipt_transport_unavailable'),
      cancel: disabled('aioncore_receipt_transport_unavailable'),
    },
  })),
});

const createState = (): ConversationProjectionState => ({
  snapshot: null,
  receiptsByItemId: new Map(),
  cancelTurnByItemId: new Map(),
  signature: '',
  revision: 0,
  listeners: new Set(),
  timer: null,
  inFlight: null,
  consecutiveFailures: 0,
});

export function createAionCoreDurableWorkActivityAdapter(): DurableWorkActivityAdapterV1 & { dispose: () => void } {
  const states = new Map<string, ConversationProjectionState>();
  let disposed = false;

  const stateFor = (conversationId: string): ConversationProjectionState => {
    const existing = states.get(conversationId);
    if (existing) return existing;
    const created = createState();
    states.set(conversationId, created);
    return created;
  };

  const notify = (state: ConversationProjectionState): void => state.listeners.forEach((listener) => listener());

  const refresh = (conversationId: string): Promise<void> => {
    const state = stateFor(conversationId);
    if (state.inFlight) return state.inFlight;
    state.inFlight = Promise.all([
      conversationBridge.listAsyncCompletionReceipts.invoke({ conversation_id: conversationId }),
      conversationBridge.get.invoke({ id: conversationId }),
      conversationBridge.listArtifacts.invoke({ conversation_id: conversationId }),
    ])
      .then(([raw, conversation, artifacts]) => {
        if (disposed) return;
        const normalized = normalizeAionCoreReceiptList(raw, conversationId);
        if (
          !normalized ||
          !conversation ||
          conversation.id !== conversationId ||
          !Array.isArray(artifacts) ||
          artifacts.some((artifact) => artifact.conversation_id !== conversationId)
        ) {
          throw new Error('invalid_aioncore_activity_contract');
        }
        const signature = JSON.stringify({
          receipts: normalized.receipts,
          runtime: conversation.runtime,
          artifacts: artifacts.map((artifact) => ({
            id: artifact.id,
            status: artifact.status,
            updated_at: artifact.updated_at,
            receipt: (artifact.payload as Record<string, unknown>).receipt,
          })),
        });
        state.consecutiveFailures = 0;
        if (signature === state.signature && state.snapshot) return;
        state.revision += 1;
        const projected = projectAionCoreReceiptList(
          normalized,
          conversationId,
          state.revision,
          conversation,
          artifacts
        );
        if (!projected) throw new Error('invalid_aioncore_receipt_projection');
        state.signature = signature;
        state.snapshot = projected.snapshot;
        state.receiptsByItemId = projected.receiptsByItemId;
        state.cancelTurnByItemId = projected.cancelTurnByItemId;
        notify(state);
      })
      .catch(() => {
        if (disposed) return;
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures < 2 || !state.snapshot) return;
        state.revision += 1;
        state.snapshot = degradeSnapshot(state.snapshot, state.revision);
        state.receiptsByItemId.clear();
        state.cancelTurnByItemId.clear();
        state.signature = '';
        notify(state);
      })
      .finally(() => {
        state.inFlight = null;
      });
    return state.inFlight;
  };

  const refreshActive = (): void => {
    for (const [conversationId, state] of states) {
      if (state.listeners.size > 0) void refresh(conversationId);
    }
  };

  const unsubscribeRealtime = conversationBridge.realtimeConnected.on(refreshActive);
  const unsubscribeStream = conversationBridge.responseStream.on((message) => {
    if (message.type === 'start' || message.type === 'finish' || message.type === 'error') {
      const state = states.get(message.conversation_id);
      if (state?.listeners.size) void refresh(message.conversation_id);
    }
  });

  const adapter: DurableWorkActivityAdapterV1 & { dispose: () => void } = {
    version: DURABLE_WORK_ACTIVITY_VERSION,
    getSnapshot: (conversationId) => stateFor(conversationId).snapshot,
    subscribe: (conversationId, listener) => {
      const state = stateFor(conversationId);
      state.listeners.add(listener);
      if (state.listeners.size === 1) {
        void refresh(conversationId);
        state.timer = setInterval(() => void refresh(conversationId), CORE_POLL_INTERVAL_MS);
      }
      return () => {
        state.listeners.delete(listener);
        if (state.listeners.size === 0 && state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
      };
    },
    requestAction: async (request: DurableWorkActionRequestV1): Promise<DurableWorkActionAckV1> => {
      const state = stateFor(request.conversationId);
      const item = state.snapshot?.items.find((candidate) => candidate.id === request.workItemId);
      const turnId = state.cancelTurnByItemId.get(request.workItemId);
      if (
        request.action !== 'cancel' ||
        !item ||
        !turnId ||
        state.snapshot?.revision !== request.expectedRevision ||
        item.sequence !== request.expectedSequence ||
        !item.actions.cancel.available
      ) {
        return {
          version: DURABLE_WORK_ACTIVITY_VERSION,
          request,
          state: 'unavailable',
          reason: request.action === 'cancel' ? 'stale_or_unavailable_cancel' : 'unsupported_typed_action',
        };
      }
      try {
        const response = await conversationBridge.stop.invoke({
          conversation_id: request.conversationId,
          turn_id: turnId,
        });
        void refresh(request.conversationId);
        if (response.outcome !== 'accepted') {
          return {
            version: DURABLE_WORK_ACTIVITY_VERSION,
            request,
            state: response.outcome === 'turn_mismatch' ? 'unavailable' : 'rejected',
            reason: `aioncore_cancel_${response.outcome}`,
          };
        }
        return {
          version: DURABLE_WORK_ACTIVITY_VERSION,
          request,
          state: 'accepted',
          receiptId: `aioncore-turn:${turnId}`,
        };
      } catch {
        return {
          version: DURABLE_WORK_ACTIVITY_VERSION,
          request,
          state: 'rejected',
          reason: 'aioncore_cancel_rejected',
        };
      }
    },
    dispose: () => {
      disposed = true;
      unsubscribeRealtime();
      unsubscribeStream();
      for (const state of states.values()) {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
        state.listeners.clear();
      }
      states.clear();
    },
  };

  return adapter;
}

export function installAionCoreDurableWorkActivityAdapter(): () => void {
  const adapter = createAionCoreDurableWorkActivityAdapter();
  const uninstall = installDurableWorkActivityAdapter(adapter);
  return () => {
    uninstall();
    adapter.dispose();
  };
}
