/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DelegatedTaskProjection } from '../chat/delegationActivity';

/**
 * Renderer-facing projection contract. The Hermes/AionCore transport owns
 * persistence, receipts, retries, authority and lifecycle truth; AionUI only
 * consumes snapshots and submits capability-scoped actions.
 */
export const DURABLE_WORK_ACTIVITY_VERSION = 'command-eve-durable-work-activity/v1' as const;
export const COMMAND_EVE_ASYNC_COMPLETION_VERSION = 'command-eve-async-completion/v1' as const;

export const DURABLE_WORK_STATUSES = [
  'queued',
  'starting',
  'running',
  'waiting',
  'needs_input',
  'succeeded',
  'failed',
  'stalled',
  'cancelled',
  'reconnect_unavailable',
] as const;

export type DurableWorkStatus = (typeof DURABLE_WORK_STATUSES)[number];
export type DurableWorkKind = 'goal' | 'supergoal' | 'gauntlet' | 'worker' | 'subagent' | 'cron';
export type DurableWorkAction = 'pause' | 'resume' | 'retry' | 'cancel';
export type DurableWorkAuthority =
  | 'hermes_goal'
  | 'hermes_cron'
  | 'hermes_delegation'
  | 'aioncore_approval'
  | 'aioncore_cancel';
export type DurableWorkReceiptState = 'accepted' | 'already_applied' | 'retryable' | 'rejected' | 'explicit_unknown';

export type DurableWorkActionCapabilityV1 = {
  available: boolean;
  authority: DurableWorkAuthority;
  requiresApproval: boolean;
  reason?: string;
};

export type DurableWorkReceiptV1 = {
  id: string;
  recordedAt: number;
  sequence: number;
  state: DurableWorkReceiptState;
};

export type DurableWorkWakeReceiptV1 = DurableWorkReceiptV1 & {
  version: typeof COMMAND_EVE_ASYNC_COMPLETION_VERSION;
};

export type DurableWorkGateV1 = {
  id: string;
  label: string;
  state: 'pending' | 'passed' | 'blocked' | 'needs_input';
  evidenceIds?: string[];
};

export type DurableWorkEvidenceV1 = {
  id: string;
  label: string;
  kind: 'receipt' | 'artifact' | 'log' | 'gate';
  ref?: string;
};

export type DurableWorkItemV1 = {
  id: string;
  kind: DurableWorkKind;
  origin: {
    conversationId: string;
    sessionId: string;
    parentSessionId?: string;
  };
  engine: {
    name: 'hermes' | 'aioncore' | 'command-eve';
    version: string;
  };
  hierarchy?: {
    goalId?: string;
    parentGoalId?: string;
    supergoalId?: string;
    gauntletIteration?: number;
  };
  goal: string;
  role: string;
  status: DurableWorkStatus;
  statusReason?: string;
  queuedAt?: number;
  startedAt?: number;
  lastActivityAt?: number;
  finishedAt?: number;
  current?: {
    step?: string;
    tool?: string;
  };
  gates: DurableWorkGateV1[];
  evidence: DurableWorkEvidenceV1[];
  actions: Record<DurableWorkAction, DurableWorkActionCapabilityV1>;
  receipts: {
    dispatch?: DurableWorkReceiptV1;
    starting?: DurableWorkReceiptV1;
    completion?: DurableWorkReceiptV1;
    delivery?: DurableWorkReceiptV1;
    wake?: DurableWorkWakeReceiptV1;
  };
  sequence: number;
};

export type DurableWorkSnapshotV1 = {
  version: typeof DURABLE_WORK_ACTIVITY_VERSION;
  conversationId: string;
  reconstructedFrom: 'persistent_receipts';
  generatedAt: number;
  revision: number;
  items: DurableWorkItemV1[];
};

export type DurableWorkActionRequestV1 = {
  version: typeof DURABLE_WORK_ACTIVITY_VERSION;
  conversationId: string;
  workItemId: string;
  action: DurableWorkAction;
  expectedRevision: number;
  expectedSequence: number;
};

export type DurableWorkActionAckV1 = {
  version: typeof DURABLE_WORK_ACTIVITY_VERSION;
  request: DurableWorkActionRequestV1;
  state: 'accepted' | 'needs_approval' | 'rejected' | 'unavailable';
  receiptId?: string;
  reason?: string;
};

const statusSet = new Set<string>(DURABLE_WORK_STATUSES);
const kindSet = new Set<string>(['goal', 'supergoal', 'gauntlet', 'worker', 'subagent', 'cron']);
const engineSet = new Set<string>(['hermes', 'aioncore', 'command-eve']);
const authoritySet = new Set<string>([
  'hermes_goal',
  'hermes_cron',
  'hermes_delegation',
  'aioncore_approval',
  'aioncore_cancel',
]);
const gateStateSet = new Set<string>(['pending', 'passed', 'blocked', 'needs_input']);
const evidenceKindSet = new Set<string>(['receipt', 'artifact', 'log', 'gate']);
const receiptStateSet = new Set<string>(['accepted', 'already_applied', 'retryable', 'rejected', 'explicit_unknown']);

const unavailableCapability = (reason: string): DurableWorkActionCapabilityV1 => ({
  available: false,
  authority: 'hermes_delegation',
  requiresApproval: false,
  reason,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number => isFiniteNonNegative(value) && Number.isInteger(value);

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const isOptionalTimestamp = (value: unknown): value is number | undefined =>
  value === undefined || isFiniteNonNegative(value);

const isCapability = (value: unknown): value is DurableWorkActionCapabilityV1 =>
  isRecord(value) &&
  typeof value.available === 'boolean' &&
  typeof value.requiresApproval === 'boolean' &&
  typeof value.authority === 'string' &&
  authoritySet.has(value.authority) &&
  isOptionalString(value.reason);

const isGate = (value: unknown): value is DurableWorkGateV1 =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.label === 'string' &&
  typeof value.state === 'string' &&
  gateStateSet.has(value.state) &&
  (value.evidenceIds === undefined ||
    (Array.isArray(value.evidenceIds) && value.evidenceIds.every((id) => typeof id === 'string')));

const isEvidence = (value: unknown): value is DurableWorkEvidenceV1 =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.label === 'string' &&
  typeof value.kind === 'string' &&
  evidenceKindSet.has(value.kind) &&
  isOptionalString(value.ref);

const isReceipt = (value: unknown): value is DurableWorkReceiptV1 =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  value.id.length > 0 &&
  isFiniteNonNegative(value.recordedAt) &&
  isNonNegativeInteger(value.sequence) &&
  typeof value.state === 'string' &&
  receiptStateSet.has(value.state);

const isWakeReceipt = (value: unknown): value is DurableWorkWakeReceiptV1 =>
  isRecord(value) && value.version === COMMAND_EVE_ASYNC_COMPLETION_VERSION && isReceipt(value);

const isOptionalReceipt = (value: unknown): value is DurableWorkReceiptV1 | undefined =>
  value === undefined || isReceipt(value);

const isHierarchy = (value: unknown): value is NonNullable<DurableWorkItemV1['hierarchy']> =>
  isRecord(value) &&
  isOptionalString(value.goalId) &&
  isOptionalString(value.parentGoalId) &&
  isOptionalString(value.supergoalId) &&
  (value.gauntletIteration === undefined || isNonNegativeInteger(value.gauntletIteration));

const isCurrentStep = (value: unknown): value is NonNullable<DurableWorkItemV1['current']> =>
  isRecord(value) && isOptionalString(value.step) && isOptionalString(value.tool);

const isDurableWorkItem = (value: unknown, conversationId: string): value is DurableWorkItemV1 => {
  if (!isRecord(value) || !isRecord(value.origin) || !isRecord(value.engine)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.kind === 'string' &&
    kindSet.has(value.kind) &&
    typeof value.goal === 'string' &&
    value.goal.length > 0 &&
    typeof value.role === 'string' &&
    value.role.length > 0 &&
    typeof value.origin.conversationId === 'string' &&
    value.origin.conversationId === conversationId &&
    typeof value.origin.sessionId === 'string' &&
    value.origin.sessionId.length > 0 &&
    isOptionalString(value.origin.parentSessionId) &&
    typeof value.engine.name === 'string' &&
    engineSet.has(value.engine.name) &&
    typeof value.engine.version === 'string' &&
    value.engine.version.length > 0 &&
    typeof value.status === 'string' &&
    statusSet.has(value.status) &&
    isOptionalString(value.statusReason) &&
    (value.hierarchy === undefined || isHierarchy(value.hierarchy)) &&
    isOptionalTimestamp(value.queuedAt) &&
    isOptionalTimestamp(value.startedAt) &&
    isOptionalTimestamp(value.lastActivityAt) &&
    isOptionalTimestamp(value.finishedAt) &&
    (value.current === undefined || isCurrentStep(value.current)) &&
    isNonNegativeInteger(value.sequence) &&
    Array.isArray(value.gates) &&
    value.gates.every(isGate) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidence) &&
    isRecord(value.actions) &&
    isCapability(value.actions.pause) &&
    isCapability(value.actions.resume) &&
    isCapability(value.actions.retry) &&
    isCapability(value.actions.cancel) &&
    isRecord(value.receipts) &&
    isOptionalReceipt(value.receipts.dispatch) &&
    isOptionalReceipt(value.receipts.starting) &&
    isOptionalReceipt(value.receipts.completion) &&
    isOptionalReceipt(value.receipts.delivery) &&
    (value.receipts.wake === undefined || isWakeReceipt(value.receipts.wake))
  );
};

/**
 * Fail closed at the adapter boundary: another chat, another contract version,
 * malformed revisions and foreign items never enter the renderer projection.
 */
export function normalizeDurableWorkSnapshot(
  value: unknown,
  expectedConversationId: string
): DurableWorkSnapshotV1 | null {
  if (!expectedConversationId || !isRecord(value)) return null;
  if (
    value.version !== DURABLE_WORK_ACTIVITY_VERSION ||
    value.conversationId !== expectedConversationId ||
    value.reconstructedFrom !== 'persistent_receipts' ||
    !isFiniteNonNegative(value.generatedAt) ||
    !isNonNegativeInteger(value.revision) ||
    !Array.isArray(value.items)
  ) {
    return null;
  }

  const ids = new Set<string>();
  const items = value.items.filter((item): item is DurableWorkItemV1 => {
    if (!isDurableWorkItem(item, expectedConversationId) || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });

  return {
    version: DURABLE_WORK_ACTIVITY_VERSION,
    conversationId: expectedConversationId,
    reconstructedFrom: 'persistent_receipts',
    generatedAt: value.generatedAt,
    revision: value.revision,
    items,
  };
}

export function hasAcceptedWakeReceipt(item: DurableWorkItemV1): boolean {
  const wake = item.receipts.wake;
  return isWakeReceipt(wake) && (wake.state === 'accepted' || wake.state === 'already_applied');
}

/** Only this predicate may unlock copy that promises a future chat re-entry. */
export const canPromiseBackgroundFollowUp = hasAcceptedWakeReceipt;

export function durableWorkRuntimeMs(item: DurableWorkItemV1, now: number): number | null {
  const start = item.startedAt ?? item.queuedAt;
  if (!isFiniteNonNegative(start)) return null;
  const end = item.finishedAt ?? (isFiniteNonNegative(now) ? now : start);
  return Math.max(0, end - start);
}

const legacyStatus = (task: DelegatedTaskProjection): DurableWorkStatus => {
  if (!task.observedLive) return 'reconnect_unavailable';
  if (task.backgroundDispatched) return 'running';
  if (task.status === 'pending') return 'queued';
  if (task.status === 'in_progress') return 'running';
  if (task.status === 'failed') return 'failed';
  // A completed delegate_task tool call only proves dispatch/return of that
  // call. It never proves the detached child worker completed successfully.
  return 'reconnect_unavailable';
};

export type LegacyDelegationObservationV1 = {
  acpSessionId: string;
};

/**
 * Legacy chat observations become live only when the renderer still holds the
 * ACP session provenance for this exact observation epoch. They are never a
 * substitute for a durable receipt or a terminal worker outcome.
 */
export function projectLegacyDelegation(
  task: DelegatedTaskProjection,
  conversationId: string,
  observation: LegacyDelegationObservationV1 | null = null
): DurableWorkItemV1 {
  const observedLive =
    task.observedLive === true && typeof observation?.acpSessionId === 'string' && observation.acpSessionId.length > 0;
  const projectedTask = observedLive === task.observedLive ? task : { ...task, observedLive };
  const reason = observedLive
    ? 'worker_terminal_outcome_untyped'
    : task.observedLive
      ? 'live_observation_epoch_unavailable'
      : 'historical_chat_is_not_a_live_receipt';
  const batchSuffix = task.taskCount > 1 ? `:${task.taskIndex}` : '';
  return {
    id: task.delegationId ? `hermes:execution:${task.delegationId}${batchSuffix}` : `legacy:${task.id}`,
    kind: task.taskCount > 1 ? 'subagent' : 'worker',
    origin: {
      conversationId,
      sessionId: observedLive ? observation.acpSessionId : `legacy-unbound:${conversationId}`,
    },
    engine: {
      name: 'hermes',
      version: observedLive ? 'live-acp-tool-observation' : 'historical-message-metadata',
    },
    goal: task.goal,
    role: task.agentId || 'subagent',
    status: legacyStatus(projectedTask),
    statusReason: legacyStatus(projectedTask) === 'failed' ? undefined : reason,
    // Persisted chat timestamps are descriptive only. Runtime timing is shown
    // solely for updates observed during this renderer app epoch.
    queuedAt: observedLive ? task.createdAt : undefined,
    lastActivityAt: observedLive ? task.createdAt : undefined,
    gates: [],
    evidence: [],
    actions: {
      pause: unavailableCapability(reason),
      resume: unavailableCapability(reason),
      retry: unavailableCapability(reason),
      cancel: unavailableCapability(reason),
    },
    receipts: {},
    sequence: 0,
  };
}
