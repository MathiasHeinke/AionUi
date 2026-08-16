import { createHash } from 'node:crypto';
import type { AcpPerformanceMark } from '../../../packages/desktop/src/renderer/utils/performance/acpPerformanceMarks';

export const COMMAND_EVE_TTFT_FORMAL_RECEIPT_VERSION = 'command-eve-ttft-formal-receipt/v1' as const;

const CONTENT_FREE_MARK_KEYS = new Set([
  'version',
  'stage',
  'conversationId',
  'turnId',
  'messageId',
  'attemptId',
  'seatGeneration',
  'outputKind',
  'outcome',
  'atEpochMs',
  'atMonotonicMs',
]);

const WARMUP_DISPOSITION_STAGES = new Set<AcpPerformanceMark['stage']>([
  'warmup_started',
  'warmup_joined',
  'warmup_skipped',
  'runtime_resident',
]);
const WARMUP_SETTLED_STAGES = new Set<AcpPerformanceMark['stage']>(['warmup_ready', 'warmup_failed', 'warmup_timeout']);
const TERMINAL_STAGES = new Set<AcpPerformanceMark['stage']>([
  'response_finished',
  'response_error',
  'turn_cancel_acknowledged',
]);

export type CommandEveTtftRuntimeReadinessEvidence = {
  conversationId: string;
  turnId: string;
  taskReadyAtEpochMs: number | null;
  hermesSessionReadyAtEpochMs: number | null;
};

export type CommandEveTtftUpstreamEvidence = {
  conversationId: string;
  turnId: string;
  requestId: string;
  startedAtEpochMs: number;
  headersReceivedAtEpochMs: number | null;
  firstBodyChunkAtEpochMs: number | null;
};

export type CommandEveTtftVisibleEvidence = {
  messageId: string;
  atEpochMs: number;
};

export type CommandEveTtftFormalInput = {
  notBeforeEpochMs: number;
  marks: AcpPerformanceMark[];
  firstVisible: CommandEveTtftVisibleEvidence | null;
  runtimeReadiness: CommandEveTtftRuntimeReadinessEvidence | null;
  upstream: CommandEveTtftUpstreamEvidence | null;
  runtimeActivityLimitMs?: number;
};

export type CommandEveTtftFormalGroup =
  | 'submit_started'
  | 'runtime_activity_visible'
  | 'turn_admission'
  | 'warmup_or_residency'
  | 'task_and_session_ready'
  | 'upstream_transport'
  | 'first_visible_output'
  | 'terminal';

export type CommandEveTtftFormalReceipt = {
  version: typeof COMMAND_EVE_TTFT_FORMAL_RECEIPT_VERSION;
  outcome: 'PASS' | 'INSUFFICIENT_EVIDENCE';
  contentFree: boolean;
  missingGroups: CommandEveTtftFormalGroup[];
  violations: string[];
  correlation: {
    conversationIdSha256: string | null;
    turnIdSha256: string | null;
    firstOutputMessageIdSha256: string | null;
    upstreamRequestIdSha256: string | null;
    attemptId: number | null;
    seatGeneration: number | null;
    terminalStage: AcpPerformanceMark['stage'] | null;
  };
  timings: {
    submitToRuntimeActivityVisibleMs: number | null;
    submitToTurnAdmissionMs: number | null;
    turnAdmissionToFirstOutputStateMs: number | null;
    firstOutputStateToVisibleMs: number | null;
    upstreamStartToHeadersMs: number | null;
    upstreamHeadersToFirstBodyChunkMs: number | null;
  };
  staleEvidenceRejected: number;
};

const sha256 = (value: string | undefined): string | null =>
  value ? createHash('sha256').update(value, 'utf8').digest('hex') : null;

const duration = (start: number | null | undefined, end: number | null | undefined): number | null =>
  typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null;

const sameAttempt = (mark: AcpPerformanceMark, submit: AcpPerformanceMark): boolean =>
  mark.conversationId === submit.conversationId &&
  mark.attemptId === submit.attemptId &&
  mark.seatGeneration === submit.seatGeneration;

/**
 * Pure, provider-free TTFT-0/TTFT-5 formal gate. Raw identifiers are accepted
 * only in-memory for exact matching; the returned receipt contains hashes and
 * numeric correlation fields only.
 */
export function buildCommandEveTtftFormalReceipt(input: CommandEveTtftFormalInput): CommandEveTtftFormalReceipt {
  const marks = input.marks.filter((mark) => mark.atEpochMs >= input.notBeforeEpochMs);
  const unexpectedKeys = marks.flatMap((mark) =>
    Object.keys(mark)
      .filter((key) => !CONTENT_FREE_MARK_KEYS.has(key))
      .map((key) => `${mark.stage}.${key}`)
  );
  const submit = marks.find(
    (mark) =>
      mark.stage === 'submit_started' &&
      Number.isSafeInteger(mark.attemptId) &&
      Number.isSafeInteger(mark.seatGeneration)
  );
  const runtimeVisible = submit
    ? marks.find((mark) => mark.stage === 'runtime_activity_visible' && sameAttempt(mark, submit))
    : undefined;
  const admission = submit
    ? marks.find(
        (mark) =>
          mark.stage === 'turn_admitted' && sameAttempt(mark, submit) && Boolean(mark.turnId) && Boolean(mark.messageId)
      )
    : undefined;
  const warmupDisposition = submit
    ? marks.find((mark) => WARMUP_DISPOSITION_STAGES.has(mark.stage) && sameAttempt(mark, submit))
    : undefined;
  const warmupSettled = submit
    ? marks.find((mark) => WARMUP_SETTLED_STAGES.has(mark.stage) && sameAttempt(mark, submit))
    : undefined;
  const firstOutput = admission
    ? marks.find(
        (mark) =>
          mark.stage === 'first_output_state' &&
          mark.conversationId === admission.conversationId &&
          mark.turnId === admission.turnId &&
          Boolean(mark.messageId) &&
          Boolean(mark.outputKind)
      )
    : undefined;
  const terminal = admission
    ? marks.find(
        (mark) =>
          TERMINAL_STAGES.has(mark.stage) &&
          mark.conversationId === admission.conversationId &&
          mark.turnId === admission.turnId
      )
    : undefined;
  const runtimeReadinessMatches = Boolean(
    admission &&
    input.runtimeReadiness?.conversationId === admission.conversationId &&
    input.runtimeReadiness.turnId === admission.turnId &&
    typeof input.runtimeReadiness.taskReadyAtEpochMs === 'number' &&
    typeof input.runtimeReadiness.hermesSessionReadyAtEpochMs === 'number'
  );
  const upstreamMatches = Boolean(
    admission &&
    input.upstream?.conversationId === admission.conversationId &&
    input.upstream.turnId === admission.turnId &&
    input.upstream.requestId &&
    typeof input.upstream.headersReceivedAtEpochMs === 'number' &&
    typeof input.upstream.firstBodyChunkAtEpochMs === 'number'
  );
  const visibleMatches = Boolean(
    firstOutput &&
    input.firstVisible?.messageId === firstOutput.messageId &&
    typeof input.firstVisible.atEpochMs === 'number' &&
    input.firstVisible.atEpochMs >= firstOutput.atEpochMs
  );
  const runtimeVisibleLatency = duration(submit?.atEpochMs, runtimeVisible?.atEpochMs);
  const runtimeActivityLimitMs = input.runtimeActivityLimitMs ?? 150;

  const missingGroups: CommandEveTtftFormalGroup[] = [];
  if (!submit) missingGroups.push('submit_started');
  if (!runtimeVisible || runtimeVisibleLatency === null || runtimeVisibleLatency > runtimeActivityLimitMs) {
    missingGroups.push('runtime_activity_visible');
  }
  if (!admission) missingGroups.push('turn_admission');
  if (!warmupDisposition || !warmupSettled) missingGroups.push('warmup_or_residency');
  if (!runtimeReadinessMatches) missingGroups.push('task_and_session_ready');
  if (!upstreamMatches) missingGroups.push('upstream_transport');
  if (!firstOutput || !visibleMatches) missingGroups.push('first_visible_output');
  if (!terminal) missingGroups.push('terminal');

  const staleEvidenceRejected = admission
    ? marks.filter(
        (mark) =>
          (mark.stage === 'first_output_state' || TERMINAL_STAGES.has(mark.stage)) &&
          (mark.conversationId !== admission.conversationId || mark.turnId !== admission.turnId)
      ).length + (input.firstVisible && firstOutput && input.firstVisible.messageId !== firstOutput.messageId ? 1 : 0)
    : 0;
  const violations = [
    ...unexpectedKeys.map((key) => `non-content-free marker field: ${key}`),
    ...(runtimeVisibleLatency !== null && runtimeVisibleLatency > runtimeActivityLimitMs
      ? [`runtime activity visible after ${runtimeVisibleLatency}ms (limit ${runtimeActivityLimitMs}ms)`]
      : []),
  ];
  const contentFree = unexpectedKeys.length === 0;

  return {
    version: COMMAND_EVE_TTFT_FORMAL_RECEIPT_VERSION,
    outcome: contentFree && missingGroups.length === 0 ? 'PASS' : 'INSUFFICIENT_EVIDENCE',
    contentFree,
    missingGroups,
    violations,
    correlation: {
      conversationIdSha256: sha256(admission?.conversationId),
      turnIdSha256: sha256(admission?.turnId),
      firstOutputMessageIdSha256: sha256(firstOutput?.messageId),
      upstreamRequestIdSha256: sha256(upstreamMatches ? input.upstream?.requestId : undefined),
      attemptId: submit?.attemptId ?? null,
      seatGeneration: submit?.seatGeneration ?? null,
      terminalStage: terminal?.stage ?? null,
    },
    timings: {
      submitToRuntimeActivityVisibleMs: runtimeVisibleLatency,
      submitToTurnAdmissionMs: duration(submit?.atEpochMs, admission?.atEpochMs),
      turnAdmissionToFirstOutputStateMs: duration(admission?.atEpochMs, firstOutput?.atEpochMs),
      firstOutputStateToVisibleMs: duration(firstOutput?.atEpochMs, input.firstVisible?.atEpochMs),
      upstreamStartToHeadersMs: upstreamMatches
        ? duration(input.upstream?.startedAtEpochMs, input.upstream?.headersReceivedAtEpochMs)
        : null,
      upstreamHeadersToFirstBodyChunkMs: upstreamMatches
        ? duration(input.upstream?.headersReceivedAtEpochMs, input.upstream?.firstBodyChunkAtEpochMs)
        : null,
    },
    staleEvidenceRejected,
  };
}
