import { createHash } from 'node:crypto';
import {
  commandEveProviderCallRequestId,
  isContentFreeCallIdentity,
} from '../../../packages/desktop/src/common/config/commandEveProviderCallIdentity';
import type { AcpPerformanceMark } from '../../../packages/desktop/src/renderer/utils/performance/acpPerformanceMarks';

export const COMMAND_EVE_TTFT_FORMAL_RECEIPT_VERSION = 'command-eve-ttft-formal-receipt/v1' as const;

export const COMMAND_EVE_PROVIDER_CALL_RECEIPT_VERSION = 'command-eve-provider-call/v1' as const;
export const COMMAND_EVE_PROVIDER_TURN_BINDING_VERSION = 'command-eve-provider-turn-binding/v1' as const;

const SHA256 = /^[a-f0-9]{64}$/;
const USAGE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export type CommandEveProviderCallResponseUsage = {
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  prompt_eval_count: number | null;
  prompt_reuse_status: 'observed' | 'unavailable';
  prompt_reused_tokens: number | null;
  prompt_tokens: number | null;
  reasoning_tokens: number | null;
};

export type CommandEveProviderCallReceipt = {
  schema_version: typeof COMMAND_EVE_PROVIDER_CALL_RECEIPT_VERSION;
  status: 'observed';
  reason_code: null;
  hash_algorithm: 'sha256';
  content_included: false;
  turn_id: string;
  call_index: number;
  request_id: string;
  final_request_fingerprint_sha256: string;
  response_usage: CommandEveProviderCallResponseUsage;
  response_usage_fingerprint_sha256: string;
  attempt_count: number;
};

export type CommandEveProviderCallHistoryRecord = {
  version: 'command-eve-upstream-outcome/v3';
  boundary: 'desktop_upstream_transport';
  provider_call: CommandEveProviderCallReceipt;
  started_at: string;
  headers_received_at: string;
  first_body_chunk_at: string;
  observed_at: string;
  outcome: 'completed';
  response_started: true;
};

export type CommandEveProviderCallReceiptValidation =
  | { ok: true; receipt: CommandEveProviderCallReceipt }
  | { ok: false; violations: string[] };

export type CommandEveTtftAttemptBinding = {
  conversationId: string;
  attemptId: number;
  seatGeneration: number;
  turnId: string;
  requestMessageId: string;
};

export type CommandEveTtftVisibleElementSnapshot = {
  connected: boolean;
  documentVisible: boolean;
  messageId: string | null;
  expectedMessageId: string;
  hasText: boolean;
  display: string;
  visibility: string;
  opacity: number;
  width: number;
  height: number;
};

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

export type CommandEveTtftProviderTurnBindingEvidence = {
  conversationId: string;
  sessionId: string;
  aionCoreTurnId: string;
  hermesTurnId: string;
  requestId: string;
  callIndex: number;
  observedAtEpochMs: number;
};

export type CommandEveTtftUpstreamEvidence = {
  turnId: string;
  callIndex: number;
  requestId: string;
  finalRequestFingerprintSha256: string;
  responseUsageFingerprintSha256: string;
  attemptCount: number;
  startedAtEpochMs: number;
  headersReceivedAtEpochMs: number | null;
  firstBodyChunkAtEpochMs: number | null;
  observedAtEpochMs: number;
};

export type CommandEveTtftVisibleEvidence = {
  messageId: string;
  atEpochMs: number;
};

export type CommandEveTtftFormalInput = {
  notBeforeEpochMs: number;
  marks: AcpPerformanceMark[];
  attemptBinding: CommandEveTtftAttemptBinding | null;
  firstVisible: CommandEveTtftVisibleEvidence | null;
  runtimeReadiness: CommandEveTtftRuntimeReadinessEvidence | null;
  providerTurnBinding: CommandEveTtftProviderTurnBindingEvidence | null;
  upstream: CommandEveTtftUpstreamEvidence | null;
  evidenceViolations?: string[];
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
    upstreamFinalRequestFingerprintSha256: string | null;
    upstreamResponseUsageSha256: string | null;
    upstreamCallIndex: number | null;
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

const canonicalUsageRecord = (value: CommandEveProviderCallResponseUsage): string =>
  JSON.stringify(Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))));

export function validateCommandEveProviderCallReceipt(value: unknown): CommandEveProviderCallReceiptValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, violations: ['provider receipt must be an object'] };
  }
  const record = value as Record<string, unknown>;
  const requiredKeys = new Set([
    'attempt_count',
    'call_index',
    'content_included',
    'final_request_fingerprint_sha256',
    'hash_algorithm',
    'reason_code',
    'request_id',
    'response_usage',
    'response_usage_fingerprint_sha256',
    'schema_version',
    'status',
    'turn_id',
  ]);
  const violations = Object.keys(record)
    .filter((key) => !requiredKeys.has(key))
    .map((key) => `provider receipt contains unexpected field: ${key}`);
  const missingKeys = [...requiredKeys].filter((key) => !Object.hasOwn(record, key));
  if (missingKeys.length > 0) violations.push(`provider receipt is missing fields: ${missingKeys.join(',')}`);
  if (record.schema_version !== COMMAND_EVE_PROVIDER_CALL_RECEIPT_VERSION) {
    violations.push(`provider receipt schema_version must be ${COMMAND_EVE_PROVIDER_CALL_RECEIPT_VERSION}`);
  }
  if (record.status !== 'observed') violations.push('provider receipt status must be observed');
  if (record.reason_code !== null) violations.push('provider receipt reason_code must be null');
  if (record.hash_algorithm !== 'sha256') violations.push('provider receipt hash_algorithm must be sha256');
  if (record.content_included !== false) violations.push('provider receipt must declare content_included=false');
  if (!isContentFreeCallIdentity(record.turn_id)) {
    violations.push('provider receipt turn_id is missing or malformed');
  }
  if (!Number.isSafeInteger(record.call_index) || (record.call_index as number) < 1) {
    violations.push('provider receipt call_index must be a positive safe integer');
  }
  if (!isContentFreeCallIdentity(record.request_id)) {
    violations.push('provider receipt request_id is missing or malformed');
  } else if (
    typeof record.turn_id === 'string' &&
    Number.isSafeInteger(record.call_index) &&
    record.request_id !== commandEveProviderCallRequestId(record.turn_id, record.call_index as number)
  ) {
    violations.push('provider receipt request_id does not match turn_id and call_index');
  }
  if (
    typeof record.final_request_fingerprint_sha256 !== 'string' ||
    !SHA256.test(record.final_request_fingerprint_sha256)
  ) {
    violations.push('provider receipt final request fingerprint is not sha256');
  }
  if (
    typeof record.response_usage_fingerprint_sha256 !== 'string' ||
    !SHA256.test(record.response_usage_fingerprint_sha256)
  ) {
    violations.push('provider receipt response usage fingerprint is not sha256');
  }
  if (record.attempt_count !== 1) {
    violations.push('provider receipt attempt_count must be exactly 1');
  }

  let responseUsage: CommandEveProviderCallResponseUsage | null = null;
  if (!record.response_usage || typeof record.response_usage !== 'object' || Array.isArray(record.response_usage)) {
    violations.push('provider receipt response_usage must be an object');
  } else {
    const usageRecord = record.response_usage as Record<string, unknown>;
    const usageKeys = new Set([
      'cache_read_tokens',
      'cache_write_tokens',
      'input_tokens',
      'output_tokens',
      'prompt_eval_count',
      'prompt_reuse_status',
      'prompt_reused_tokens',
      'prompt_tokens',
      'reasoning_tokens',
    ]);
    const unexpectedUsageKeys = Object.keys(usageRecord).filter((key) => !usageKeys.has(key) || !USAGE_KEY.test(key));
    const missingUsageKeys = [...usageKeys].filter((key) => !Object.hasOwn(usageRecord, key));
    if (unexpectedUsageKeys.length > 0) {
      violations.push(`provider receipt response_usage contains unexpected keys: ${unexpectedUsageKeys.join(',')}`);
    }
    if (missingUsageKeys.length > 0) {
      violations.push(`provider receipt response_usage is missing keys: ${missingUsageKeys.join(',')}`);
    }
    const counterKeys = [...usageKeys].filter((key) => key !== 'prompt_reuse_status');
    const malformedCounters = counterKeys.filter((key) => {
      const entry = usageRecord[key];
      return entry !== null && (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0);
    });
    if (malformedCounters.length > 0) {
      violations.push(`provider receipt response_usage contains invalid counters: ${malformedCounters.join(',')}`);
    }
    if (usageRecord.prompt_reuse_status !== 'observed' && usageRecord.prompt_reuse_status !== 'unavailable') {
      violations.push('provider receipt prompt_reuse_status is invalid');
    }
    if (usageRecord.prompt_reuse_status === 'unavailable' && usageRecord.prompt_reused_tokens !== null) {
      violations.push('provider receipt cannot claim reused tokens when reuse status is unavailable');
    }
    if (
      usageRecord.prompt_reuse_status === 'observed' &&
      (typeof usageRecord.prompt_reused_tokens !== 'number' || !Number.isSafeInteger(usageRecord.prompt_reused_tokens))
    ) {
      violations.push('provider receipt observed reuse requires prompt_reused_tokens');
    }
    if (
      typeof usageRecord.prompt_tokens === 'number' &&
      typeof usageRecord.prompt_reused_tokens === 'number' &&
      usageRecord.prompt_reused_tokens > usageRecord.prompt_tokens
    ) {
      violations.push('provider receipt prompt_reused_tokens exceeds prompt_tokens');
    }
    if (unexpectedUsageKeys.length === 0 && missingUsageKeys.length === 0 && malformedCounters.length === 0) {
      responseUsage = usageRecord as CommandEveProviderCallResponseUsage;
      const requiredNumericCounters = [
        'cache_read_tokens',
        'cache_write_tokens',
        'input_tokens',
        'output_tokens',
        'prompt_tokens',
        'reasoning_tokens',
      ] as const;
      const unavailableCounters = requiredNumericCounters.filter((key) => typeof responseUsage?.[key] !== 'number');
      if (unavailableCounters.length > 0) {
        violations.push(
          `provider receipt response_usage is missing observed counters: ${unavailableCounters.join(',')}`
        );
      }
      const expectedUsageSha256 = createHash('sha256')
        .update(canonicalUsageRecord(responseUsage), 'utf8')
        .digest('hex');
      if (record.response_usage_fingerprint_sha256 !== expectedUsageSha256) {
        violations.push('provider receipt response_usage_fingerprint_sha256 does not match response_usage');
      }
      const promptTokens = responseUsage.prompt_tokens;
      const inputTokens = responseUsage.input_tokens;
      const cacheReadTokens = responseUsage.cache_read_tokens;
      const cacheWriteTokens = responseUsage.cache_write_tokens;
      if (
        typeof promptTokens === 'number' &&
        typeof inputTokens === 'number' &&
        typeof cacheReadTokens === 'number' &&
        typeof cacheWriteTokens === 'number'
      ) {
        const assigned = inputTokens + cacheReadTokens + cacheWriteTokens;
        if (assigned !== promptTokens) {
          violations.push(
            `provider receipt response usage buckets ${assigned} do not equal prompt_tokens ${promptTokens}`
          );
        }
      }
      if (
        typeof responseUsage.prompt_eval_count === 'number' &&
        responseUsage.prompt_eval_count !== responseUsage.prompt_tokens
      ) {
        violations.push('provider receipt prompt_eval_count does not equal prompt_tokens');
      }
    }
  }

  if (violations.length > 0 || responseUsage === null) return { ok: false, violations };
  return { ok: true, receipt: record as CommandEveProviderCallReceipt };
}

export function selectCommandEveTtftUpstreamEvidence(input: {
  lines: string[];
  binding: CommandEveTtftProviderTurnBindingEvidence | null;
  notBeforeEpochMs: number;
  notAfterEpochMs: number;
}): { evidence: CommandEveTtftUpstreamEvidence | null; violations: string[] } {
  const violations: string[] = [];
  if (!input.binding) {
    return { evidence: null, violations: ['provider turn binding is unavailable'] };
  }
  const sameTurn: Array<{
    receipt: CommandEveProviderCallReceipt;
    history: CommandEveProviderCallHistoryRecord;
    startedAt: number;
  }> = [];
  for (const line of input.lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== 'command-eve-upstream-outcome/v3'
    ) {
      continue;
    }
    const history = parsed as Record<string, unknown>;
    const allowedHistoryKeys = new Set([
      'version',
      'boundary',
      'provider_call',
      'started_at',
      'headers_received_at',
      'first_body_chunk_at',
      'observed_at',
      'outcome',
      'response_started',
    ]);
    const unexpectedHistoryKeys = Object.keys(history).filter((key) => !allowedHistoryKeys.has(key));
    const missingHistoryKeys = [...allowedHistoryKeys].filter((key) => !Object.hasOwn(history, key));
    if (unexpectedHistoryKeys.length > 0) {
      violations.push(`provider history contains unexpected fields: ${unexpectedHistoryKeys.join(',')}`);
      continue;
    }
    if (missingHistoryKeys.length > 0) {
      violations.push(`provider history is missing fields: ${missingHistoryKeys.join(',')}`);
      continue;
    }
    if (history.boundary !== 'desktop_upstream_transport') {
      violations.push('provider history boundary is invalid');
      continue;
    }
    const validation = validateCommandEveProviderCallReceipt(history.provider_call);
    if ('violations' in validation) {
      violations.push(...validation.violations.map((violation) => `provider receipt invalid: ${violation}`));
      continue;
    }
    const startedAt = typeof history.started_at === 'string' ? Date.parse(history.started_at) : Number.NaN;
    const observedAt = typeof history.observed_at === 'string' ? Date.parse(history.observed_at) : Number.NaN;
    if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt)) {
      violations.push('provider receipt must carry parseable started_at and observed_at timestamps');
      continue;
    }
    if (startedAt < input.notBeforeEpochMs || observedAt > input.notAfterEpochMs) continue;
    if (validation.receipt.turn_id === input.binding.hermesTurnId) {
      sameTurn.push({
        receipt: validation.receipt,
        history: history as CommandEveProviderCallHistoryRecord,
        startedAt,
      });
    }
  }
  if (sameTurn.length !== 1) {
    violations.push(`expected exactly one provider receipt for bound Hermes turn, observed ${sameTurn.length}`);
    return { evidence: null, violations };
  }
  const { receipt, history, startedAt } = sameTurn[0];
  if (receipt.call_index !== 1)
    violations.push(`provider receipt call_index must be 1, observed ${receipt.call_index}`);
  if (receipt.attempt_count !== 1) {
    violations.push(`provider receipt attempt_count must be 1, observed ${receipt.attempt_count}`);
  }
  if (receipt.request_id !== input.binding.requestId) {
    violations.push('provider receipt request_id does not match provider turn binding');
  }
  if (receipt.call_index !== input.binding.callIndex) {
    violations.push('provider receipt call_index does not match provider turn binding');
  }
  if (history.outcome !== 'completed') violations.push('provider history outcome must be completed');
  if (history.response_started !== true) violations.push('provider history response_started must be true');
  const headersReceivedAt = history.headers_received_at ? Date.parse(history.headers_received_at) : Number.NaN;
  const firstBodyChunkAt = history.first_body_chunk_at ? Date.parse(history.first_body_chunk_at) : Number.NaN;
  if (!Number.isFinite(headersReceivedAt) || !Number.isFinite(firstBodyChunkAt)) {
    violations.push('provider receipt must carry parseable headers/body timestamps');
  }
  const observedAt = Date.parse(history.observed_at);
  if (Number.isFinite(headersReceivedAt) && headersReceivedAt < startedAt) {
    violations.push('provider history headers_received_at precedes started_at');
  }
  if (Number.isFinite(firstBodyChunkAt) && Number.isFinite(headersReceivedAt) && firstBodyChunkAt < headersReceivedAt) {
    violations.push('provider history first_body_chunk_at precedes headers_received_at');
  }
  if (Number.isFinite(firstBodyChunkAt) && observedAt < firstBodyChunkAt) {
    violations.push('provider history observed_at precedes first_body_chunk_at');
  }
  if (violations.length > 0) return { evidence: null, violations };
  return {
    evidence: {
      turnId: receipt.turn_id,
      callIndex: receipt.call_index,
      requestId: receipt.request_id,
      finalRequestFingerprintSha256: receipt.final_request_fingerprint_sha256,
      responseUsageFingerprintSha256: receipt.response_usage_fingerprint_sha256,
      attemptCount: receipt.attempt_count,
      startedAtEpochMs: startedAt,
      headersReceivedAtEpochMs: headersReceivedAt,
      firstBodyChunkAtEpochMs: firstBodyChunkAt,
      observedAtEpochMs: observedAt,
    },
    violations: [],
  };
}

export function selectCommandEveTtftProviderTurnBinding(input: {
  lines: string[];
  expectedConversationId: string;
  expectedAionCoreTurnId: string;
  notBeforeEpochMs: number;
  notAfterEpochMs: number;
}): { evidence: CommandEveTtftProviderTurnBindingEvidence | null; violations: string[] } {
  const violations: string[] = [];
  const matches: CommandEveTtftProviderTurnBindingEvidence[] = [];
  const requiredKeys = new Set([
    'version',
    'boundary',
    'contentIncluded',
    'conversationId',
    'sessionId',
    'aionCoreTurnId',
    'hermesTurnId',
    'requestId',
    'callIndex',
    'observedAt',
  ]);
  for (const line of input.lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).version !== COMMAND_EVE_PROVIDER_TURN_BINDING_VERSION
    ) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const unexpectedKeys = Object.keys(record).filter((key) => !requiredKeys.has(key));
    const missingKeys = [...requiredKeys].filter((key) => !Object.hasOwn(record, key));
    if (unexpectedKeys.length > 0) {
      violations.push(`provider turn binding contains unexpected fields: ${unexpectedKeys.join(',')}`);
      continue;
    }
    if (missingKeys.length > 0) {
      violations.push(`provider turn binding is missing fields: ${missingKeys.join(',')}`);
      continue;
    }
    if (record.boundary !== 'desktop_acp_session_info' || record.contentIncluded !== false) {
      violations.push('provider turn binding boundary/content declaration is invalid');
      continue;
    }
    if (
      !isContentFreeCallIdentity(record.conversationId) ||
      !isContentFreeCallIdentity(record.sessionId) ||
      !isContentFreeCallIdentity(record.aionCoreTurnId) ||
      !isContentFreeCallIdentity(record.hermesTurnId) ||
      !isContentFreeCallIdentity(record.requestId) ||
      !Number.isSafeInteger(record.callIndex) ||
      (record.callIndex as number) < 1 ||
      record.requestId !== commandEveProviderCallRequestId(record.hermesTurnId, record.callIndex as number)
    ) {
      violations.push('provider turn binding identity is invalid');
      continue;
    }
    const observedAt = typeof record.observedAt === 'string' ? Date.parse(record.observedAt) : Number.NaN;
    if (!Number.isFinite(observedAt)) {
      violations.push('provider turn binding observedAt must be parseable');
      continue;
    }
    if (observedAt < input.notBeforeEpochMs || observedAt > input.notAfterEpochMs) continue;
    if (
      record.conversationId === input.expectedConversationId &&
      record.aionCoreTurnId === input.expectedAionCoreTurnId
    ) {
      matches.push({
        conversationId: record.conversationId,
        sessionId: record.sessionId,
        aionCoreTurnId: record.aionCoreTurnId,
        hermesTurnId: record.hermesTurnId,
        requestId: record.requestId,
        callIndex: record.callIndex as number,
        observedAtEpochMs: observedAt,
      });
    }
  }
  if (matches.length !== 1) {
    violations.push(
      `expected exactly one provider turn binding for admitted AionCore turn, observed ${matches.length}`
    );
    return { evidence: null, violations };
  }
  const binding = matches[0];
  if (binding.callIndex !== 1) {
    violations.push(`provider turn binding callIndex must be 1, observed ${binding.callIndex}`);
  }
  if (violations.length > 0) return { evidence: null, violations };
  return { evidence: binding, violations: [] };
}

export function selectCommandEveTtftAttemptBinding(input: {
  marks: AcpPerformanceMark[];
  expectedConversationId: string;
  notBeforeEpochMs: number;
}): { binding: CommandEveTtftAttemptBinding | null; violations: string[] } {
  const submits = input.marks.filter(
    (mark) =>
      mark.stage === 'submit_started' &&
      mark.conversationId === input.expectedConversationId &&
      mark.atEpochMs >= input.notBeforeEpochMs &&
      Number.isSafeInteger(mark.attemptId) &&
      Number.isSafeInteger(mark.seatGeneration)
  );
  if (submits.length !== 1) {
    return {
      binding: null,
      violations: [`expected exactly one submit_started for measured conversation, observed ${submits.length}`],
    };
  }
  const submit = submits[0];
  const admissions = input.marks.filter(
    (mark) =>
      mark.stage === 'turn_admitted' &&
      mark.conversationId === submit.conversationId &&
      mark.attemptId === submit.attemptId &&
      mark.seatGeneration === submit.seatGeneration &&
      typeof mark.turnId === 'string' &&
      Boolean(mark.turnId) &&
      typeof mark.messageId === 'string' &&
      Boolean(mark.messageId)
  );
  if (admissions.length !== 1) {
    return {
      binding: null,
      violations: [`expected exactly one turn_admitted for measured submit attempt, observed ${admissions.length}`],
    };
  }
  const admission = admissions[0];
  return {
    binding: {
      conversationId: submit.conversationId,
      attemptId: submit.attemptId as number,
      seatGeneration: submit.seatGeneration as number,
      turnId: admission.turnId as string,
      requestMessageId: admission.messageId as string,
    },
    violations: [],
  };
}

export function isCommandEveTtftVisibleElement(snapshot: CommandEveTtftVisibleElementSnapshot): boolean {
  return (
    snapshot.connected &&
    snapshot.documentVisible &&
    snapshot.messageId === snapshot.expectedMessageId &&
    snapshot.hasText &&
    snapshot.display !== 'none' &&
    snapshot.visibility !== 'hidden' &&
    Number.isFinite(snapshot.opacity) &&
    snapshot.opacity > 0 &&
    Number.isFinite(snapshot.width) &&
    snapshot.width > 0 &&
    Number.isFinite(snapshot.height) &&
    snapshot.height > 0
  );
}

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
  const violations: string[] = [...(input.evidenceViolations ?? [])];
  if (!Number.isFinite(input.notBeforeEpochMs)) violations.push('notBeforeEpochMs must be finite');
  input.marks.forEach((mark, index) => {
    if (!Number.isFinite(mark.atEpochMs)) violations.push(`mark[${index}] ${mark.stage} atEpochMs must be finite`);
    if (mark.atMonotonicMs !== null && !Number.isFinite(mark.atMonotonicMs)) {
      violations.push(`mark[${index}] ${mark.stage} atMonotonicMs must be finite or null`);
    }
  });
  const marks = input.marks.filter(
    (mark) => Number.isFinite(mark.atEpochMs) && mark.atEpochMs >= input.notBeforeEpochMs
  );
  const unexpectedKeys = marks.flatMap((mark) =>
    Object.keys(mark)
      .filter((key) => !CONTENT_FREE_MARK_KEYS.has(key))
      .map((key) => `${mark.stage}.${key}`)
  );
  violations.push(...unexpectedKeys.map((key) => `non-content-free marker field: ${key}`));

  const attemptBinding = input.attemptBinding;
  if (!attemptBinding) violations.push('exact submit attempt binding is unavailable');
  const uniqueMark = (label: string, candidates: AcpPerformanceMark[]): AcpPerformanceMark | undefined => {
    if (candidates.length > 1) violations.push(`${label} is ambiguous: observed ${candidates.length} matching marks`);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const submit = attemptBinding
    ? uniqueMark(
        'submit_started',
        marks.filter(
          (mark) =>
            mark.stage === 'submit_started' &&
            mark.conversationId === attemptBinding.conversationId &&
            mark.attemptId === attemptBinding.attemptId &&
            mark.seatGeneration === attemptBinding.seatGeneration
        )
      )
    : undefined;
  const runtimeVisible = submit
    ? uniqueMark(
        'runtime_activity_visible',
        marks.filter((mark) => mark.stage === 'runtime_activity_visible' && sameAttempt(mark, submit))
      )
    : undefined;
  const admission =
    submit && attemptBinding
      ? uniqueMark(
          'turn_admitted',
          marks.filter(
            (mark) =>
              mark.stage === 'turn_admitted' &&
              sameAttempt(mark, submit) &&
              mark.turnId === attemptBinding.turnId &&
              mark.messageId === attemptBinding.requestMessageId
          )
        )
      : undefined;
  const warmupDisposition = submit
    ? uniqueMark(
        'warmup disposition',
        marks.filter((mark) => WARMUP_DISPOSITION_STAGES.has(mark.stage) && sameAttempt(mark, submit))
      )
    : undefined;
  const warmupSettled = submit
    ? uniqueMark(
        'warmup settled',
        marks.filter((mark) => WARMUP_SETTLED_STAGES.has(mark.stage) && sameAttempt(mark, submit))
      )
    : undefined;
  const firstOutput = admission
    ? uniqueMark(
        'first_output_state',
        marks.filter(
          (mark) =>
            mark.stage === 'first_output_state' &&
            mark.conversationId === admission.conversationId &&
            mark.turnId === admission.turnId &&
            Boolean(mark.messageId) &&
            Boolean(mark.outputKind)
        )
      )
    : undefined;
  const terminal = admission
    ? uniqueMark(
        'terminal',
        marks.filter(
          (mark) =>
            TERMINAL_STAGES.has(mark.stage) &&
            mark.conversationId === admission.conversationId &&
            mark.turnId === admission.turnId
        )
      )
    : undefined;
  const runtimeReadinessMatches = Boolean(
    admission &&
    input.runtimeReadiness?.conversationId === admission.conversationId &&
    input.runtimeReadiness.turnId === admission.turnId &&
    typeof input.runtimeReadiness.taskReadyAtEpochMs === 'number' &&
    Number.isFinite(input.runtimeReadiness.taskReadyAtEpochMs) &&
    typeof input.runtimeReadiness.hermesSessionReadyAtEpochMs === 'number' &&
    Number.isFinite(input.runtimeReadiness.hermesSessionReadyAtEpochMs)
  );
  const providerTurnBindingMatches = Boolean(
    admission &&
    input.providerTurnBinding?.conversationId === admission.conversationId &&
    input.providerTurnBinding.aionCoreTurnId === admission.turnId &&
    isContentFreeCallIdentity(input.providerTurnBinding.sessionId) &&
    isContentFreeCallIdentity(input.providerTurnBinding.hermesTurnId) &&
    input.providerTurnBinding.callIndex === 1 &&
    isContentFreeCallIdentity(input.providerTurnBinding.requestId) &&
    input.providerTurnBinding.requestId ===
      commandEveProviderCallRequestId(input.providerTurnBinding.hermesTurnId, input.providerTurnBinding.callIndex) &&
    Number.isFinite(input.providerTurnBinding.observedAtEpochMs)
  );
  const upstreamMatches = Boolean(
    providerTurnBindingMatches &&
    input.providerTurnBinding &&
    input.upstream?.turnId === input.providerTurnBinding.hermesTurnId &&
    input.upstream.callIndex === 1 &&
    input.upstream.callIndex === input.providerTurnBinding.callIndex &&
    isContentFreeCallIdentity(input.upstream.requestId) &&
    input.upstream.requestId === commandEveProviderCallRequestId(input.upstream.turnId, input.upstream.callIndex) &&
    input.upstream.requestId === input.providerTurnBinding.requestId &&
    SHA256.test(input.upstream.finalRequestFingerprintSha256) &&
    SHA256.test(input.upstream.responseUsageFingerprintSha256) &&
    input.upstream.attemptCount === 1 &&
    Number.isFinite(input.upstream.startedAtEpochMs) &&
    typeof input.upstream.headersReceivedAtEpochMs === 'number' &&
    Number.isFinite(input.upstream.headersReceivedAtEpochMs) &&
    typeof input.upstream.firstBodyChunkAtEpochMs === 'number' &&
    Number.isFinite(input.upstream.firstBodyChunkAtEpochMs) &&
    Number.isFinite(input.upstream.observedAtEpochMs)
  );
  const visibleMatches = Boolean(
    firstOutput &&
    input.firstVisible?.messageId === firstOutput.messageId &&
    typeof input.firstVisible.atEpochMs === 'number' &&
    input.firstVisible.atEpochMs >= firstOutput.atEpochMs
  );
  const runtimeVisibleLatency = duration(submit?.atEpochMs, runtimeVisible?.atEpochMs);
  const runtimeActivityLimitMs = input.runtimeActivityLimitMs ?? 150;

  const requireChronology = (label: string, start: number | null | undefined, end: number | null | undefined): void => {
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      return;
    }
    if (end < start) violations.push(`${label} has impossible chronology: ${end} precedes ${start}`);
  };
  requireChronology('notBeforeEpochMs -> submit_started', input.notBeforeEpochMs, submit?.atEpochMs);
  requireChronology('submit_started -> runtime_activity_visible', submit?.atEpochMs, runtimeVisible?.atEpochMs);
  requireChronology('submit_started -> warmup disposition', submit?.atEpochMs, warmupDisposition?.atEpochMs);
  requireChronology('warmup disposition -> warmup settled', warmupDisposition?.atEpochMs, warmupSettled?.atEpochMs);
  requireChronology('warmup settled -> turn_admitted', warmupSettled?.atEpochMs, admission?.atEpochMs);
  requireChronology('submit_started -> turn_admitted', submit?.atEpochMs, admission?.atEpochMs);
  // AionCore schedules background work before returning the 202, while
  // `turn_admitted` is the renderer's later observation of that response.
  // Task start and response delivery therefore race across process boundaries;
  // both must follow submit/warmup, but neither orders the other.
  requireChronology('submit_started -> task ready', submit?.atEpochMs, input.runtimeReadiness?.taskReadyAtEpochMs);
  requireChronology(
    'warmup settled -> task ready',
    warmupSettled?.atEpochMs,
    input.runtimeReadiness?.taskReadyAtEpochMs
  );
  requireChronology(
    'turn_admitted -> provider turn binding',
    admission?.atEpochMs,
    input.providerTurnBinding?.observedAtEpochMs
  );
  requireChronology('turn_admitted -> upstream started', admission?.atEpochMs, input.upstream?.startedAtEpochMs);
  requireChronology(
    'task ready -> upstream started',
    input.runtimeReadiness?.taskReadyAtEpochMs,
    input.upstream?.startedAtEpochMs
  );
  requireChronology(
    'Hermes session ready -> upstream started',
    input.runtimeReadiness?.hermesSessionReadyAtEpochMs,
    input.upstream?.startedAtEpochMs
  );
  requireChronology(
    'upstream started -> headers received',
    input.upstream?.startedAtEpochMs,
    input.upstream?.headersReceivedAtEpochMs
  );
  requireChronology(
    'headers received -> first body chunk',
    input.upstream?.headersReceivedAtEpochMs,
    input.upstream?.firstBodyChunkAtEpochMs
  );
  requireChronology(
    'first body chunk -> provider receipt observed',
    input.upstream?.firstBodyChunkAtEpochMs,
    input.upstream?.observedAtEpochMs
  );
  requireChronology(
    'provider turn binding -> provider receipt observed',
    input.providerTurnBinding?.observedAtEpochMs,
    input.upstream?.observedAtEpochMs
  );
  requireChronology('turn_admitted -> first_output_state', admission?.atEpochMs, firstOutput?.atEpochMs);
  requireChronology(
    'first body chunk -> first_output_state',
    input.upstream?.firstBodyChunkAtEpochMs,
    firstOutput?.atEpochMs
  );
  requireChronology('first_output_state -> terminal', firstOutput?.atEpochMs, terminal?.atEpochMs);
  requireChronology('first_output_state -> first visible', firstOutput?.atEpochMs, input.firstVisible?.atEpochMs);
  requireChronology('task ready -> terminal', input.runtimeReadiness?.taskReadyAtEpochMs, terminal?.atEpochMs);
  requireChronology(
    'Hermes session ready -> terminal',
    input.runtimeReadiness?.hermesSessionReadyAtEpochMs,
    terminal?.atEpochMs
  );
  requireChronology('first body chunk -> terminal', input.upstream?.firstBodyChunkAtEpochMs, terminal?.atEpochMs);
  requireChronology('provider receipt observed -> terminal', input.upstream?.observedAtEpochMs, terminal?.atEpochMs);

  const missingGroups: CommandEveTtftFormalGroup[] = [];
  if (!submit) missingGroups.push('submit_started');
  if (!runtimeVisible || runtimeVisibleLatency === null || runtimeVisibleLatency > runtimeActivityLimitMs) {
    missingGroups.push('runtime_activity_visible');
  }
  if (!admission) missingGroups.push('turn_admission');
  if (!warmupDisposition || !warmupSettled) missingGroups.push('warmup_or_residency');
  if (!runtimeReadinessMatches) missingGroups.push('task_and_session_ready');
  if (!providerTurnBindingMatches || !upstreamMatches) missingGroups.push('upstream_transport');
  if (!firstOutput || !visibleMatches) missingGroups.push('first_visible_output');
  if (!terminal) missingGroups.push('terminal');

  const staleEvidenceRejected = admission
    ? marks.filter(
        (mark) =>
          (mark.stage === 'first_output_state' || TERMINAL_STAGES.has(mark.stage)) &&
          (mark.conversationId !== admission.conversationId || mark.turnId !== admission.turnId)
      ).length + (input.firstVisible && firstOutput && input.firstVisible.messageId !== firstOutput.messageId ? 1 : 0)
    : 0;
  if (runtimeVisibleLatency !== null && runtimeVisibleLatency > runtimeActivityLimitMs) {
    violations.push(`runtime activity visible after ${runtimeVisibleLatency}ms (limit ${runtimeActivityLimitMs}ms)`);
  }
  const contentFree = unexpectedKeys.length === 0;

  return {
    version: COMMAND_EVE_TTFT_FORMAL_RECEIPT_VERSION,
    outcome: contentFree && missingGroups.length === 0 && violations.length === 0 ? 'PASS' : 'INSUFFICIENT_EVIDENCE',
    contentFree,
    missingGroups,
    violations,
    correlation: {
      conversationIdSha256: sha256(admission?.conversationId),
      turnIdSha256: sha256(admission?.turnId),
      firstOutputMessageIdSha256: sha256(firstOutput?.messageId),
      upstreamRequestIdSha256: sha256(upstreamMatches ? input.upstream?.requestId : undefined),
      upstreamFinalRequestFingerprintSha256: upstreamMatches
        ? (input.upstream?.finalRequestFingerprintSha256 ?? null)
        : null,
      upstreamResponseUsageSha256: upstreamMatches ? (input.upstream?.responseUsageFingerprintSha256 ?? null) : null,
      upstreamCallIndex: upstreamMatches ? (input.upstream?.callIndex ?? null) : null,
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
