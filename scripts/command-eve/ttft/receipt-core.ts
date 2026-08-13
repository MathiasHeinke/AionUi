export const COMMAND_EVE_TTFT_RECEIPT_VERSION = 'command-eve-ttft-receipt/v2' as const;

export type CommandEveTtftCohort = 'cold_start_chat' | 'warm_start_chat' | 'warm_existing_session';

export type CommandEveTtftStage =
  | 'app_process_started'
  | 'renderer_usable'
  | 'hermes_spawned'
  | 'hermes_ready'
  | 'acp_session_ready'
  | 'send_action'
  | 'request_accepted'
  | 'model_request_started'
  | 'model_first_token'
  | 'acp_first_text'
  | 'renderer_first_visible'
  | 'response_finished'
  | 'tts_playback_started';

export type CommandEveTtftMilestone =
  | {
      status: 'observed';
      atEpochMs: number;
      source: 'harness' | 'renderer_event' | 'runtime_log';
      evidence: string;
    }
  | {
      status: 'unavailable';
      reason: string;
    };

export type CommandEveTtftMetricName =
  | 'coldAppToRendererMs'
  | 'coldAppToHermesReadyMs'
  | 'coldAppToAcpSessionReadyMs'
  | 'sendToAcpSessionReadyMs'
  | 'sendToRequestAcceptedMs'
  | 'sendToModelFirstTokenMs'
  | 'sendToAcpFirstTextMs'
  | 'sendToFirstVisibleMs'
  | 'acpToRendererMs'
  | 'responseToTtsMs';

export type CommandEveTtftReceipt = {
  version: typeof COMMAND_EVE_TTFT_RECEIPT_VERSION;
  releaseVersion: string;
  hermesVersion: string;
  appCommit: string;
  appCommitSource: 'development_git_head' | 'packaged_cli_assertion';
  promptSha256: string;
  runtimeSelection: string;
  cohort: CommandEveTtftCohort;
  iteration: number;
  recordedAt: string;
  milestones: Record<CommandEveTtftStage, CommandEveTtftMilestone>;
  metrics: Record<CommandEveTtftMetricName, number | null>;
  chronology: {
    valid: boolean;
    violations: string[];
  };
};

export const COMMAND_EVE_TTFT_STAGES: readonly CommandEveTtftStage[] = [
  'app_process_started',
  'renderer_usable',
  'hermes_spawned',
  'hermes_ready',
  'acp_session_ready',
  'send_action',
  'request_accepted',
  'model_request_started',
  'model_first_token',
  'acp_first_text',
  'renderer_first_visible',
  'response_finished',
  'tts_playback_started',
];

const COMMON_ORDER_CONSTRAINTS: ReadonlyArray<readonly [CommandEveTtftStage, CommandEveTtftStage]> = [
  ['app_process_started', 'renderer_usable'],
  ['hermes_spawned', 'hermes_ready'],
  ['hermes_ready', 'acp_session_ready'],
  ['send_action', 'request_accepted'],
  ['request_accepted', 'model_request_started'],
  ['model_request_started', 'model_first_token'],
  ['model_first_token', 'acp_first_text'],
  ['acp_first_text', 'renderer_first_visible'],
  ['acp_first_text', 'response_finished'],
  ['response_finished', 'tts_playback_started'],
];

const orderConstraintsForCohort = (
  cohort: CommandEveTtftCohort
): ReadonlyArray<readonly [CommandEveTtftStage, CommandEveTtftStage]> => [
  ...COMMON_ORDER_CONSTRAINTS,
  ...(cohort === 'warm_existing_session'
    ? ([['acp_session_ready', 'send_action']] as const)
    : ([['send_action', 'acp_session_ready']] as const)),
];

const unavailable = (reason = 'not observed by this measurement lane'): CommandEveTtftMilestone => ({
  status: 'unavailable',
  reason,
});

const observedAt = (milestone: CommandEveTtftMilestone): number | null =>
  milestone.status === 'observed' ? milestone.atEpochMs : null;

const durationBetween = (
  milestones: Record<CommandEveTtftStage, CommandEveTtftMilestone>,
  start: CommandEveTtftStage,
  end: CommandEveTtftStage
): number | null => {
  const startAt = observedAt(milestones[start]);
  const endAt = observedAt(milestones[end]);
  if (startAt === null || endAt === null || endAt < startAt) return null;
  return endAt - startAt;
};

export function buildCommandEveTtftReceipt(input: {
  releaseVersion: string;
  hermesVersion: string;
  appCommit: string;
  appCommitSource: 'development_git_head' | 'packaged_cli_assertion';
  promptSha256: string;
  runtimeSelection: string;
  cohort: CommandEveTtftCohort;
  iteration: number;
  recordedAt?: string;
  milestones: Partial<Record<CommandEveTtftStage, CommandEveTtftMilestone>>;
}): CommandEveTtftReceipt {
  const milestones = Object.fromEntries(
    COMMAND_EVE_TTFT_STAGES.map((stage) => [stage, input.milestones[stage] ?? unavailable()])
  ) as Record<CommandEveTtftStage, CommandEveTtftMilestone>;

  const violations = orderConstraintsForCohort(input.cohort).flatMap(([earlier, later]) => {
    const earlierAt = observedAt(milestones[earlier]);
    const laterAt = observedAt(milestones[later]);
    if (earlierAt === null || laterAt === null || earlierAt <= laterAt) return [];
    return [`${earlier} (${earlierAt}) occurred after ${later} (${laterAt})`];
  });

  return {
    version: COMMAND_EVE_TTFT_RECEIPT_VERSION,
    releaseVersion: input.releaseVersion,
    hermesVersion: input.hermesVersion,
    appCommit: input.appCommit,
    appCommitSource: input.appCommitSource,
    promptSha256: input.promptSha256,
    runtimeSelection: input.runtimeSelection,
    cohort: input.cohort,
    iteration: input.iteration,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    milestones,
    metrics: {
      coldAppToRendererMs: durationBetween(milestones, 'app_process_started', 'renderer_usable'),
      coldAppToHermesReadyMs: durationBetween(milestones, 'app_process_started', 'hermes_ready'),
      coldAppToAcpSessionReadyMs: durationBetween(milestones, 'app_process_started', 'acp_session_ready'),
      sendToAcpSessionReadyMs: durationBetween(milestones, 'send_action', 'acp_session_ready'),
      sendToRequestAcceptedMs: durationBetween(milestones, 'send_action', 'request_accepted'),
      sendToModelFirstTokenMs: durationBetween(milestones, 'send_action', 'model_first_token'),
      sendToAcpFirstTextMs: durationBetween(milestones, 'send_action', 'acp_first_text'),
      sendToFirstVisibleMs: durationBetween(milestones, 'send_action', 'renderer_first_visible'),
      acpToRendererMs: durationBetween(milestones, 'acp_first_text', 'renderer_first_visible'),
      responseToTtsMs: durationBetween(milestones, 'response_finished', 'tts_playback_started'),
    },
    chronology: {
      valid: violations.length === 0,
      violations,
    },
  };
}

export type CommandEveTtftStats = {
  count: number;
  p50: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
};

const percentile = (sorted: number[], fraction: number): number | null => {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? null;
};

export function summarizeCommandEveTtftMetric(
  receipts: CommandEveTtftReceipt[],
  metric: CommandEveTtftMetricName
): CommandEveTtftStats {
  const values = receipts
    .map((receipt) => receipt.metrics[metric])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: values[0] ?? null,
    max: values.at(-1) ?? null,
  };
}

export const DEFAULT_TTFT_ABSOLUTE_REGRESSION_LIMIT_MS: Record<CommandEveTtftMetricName, number> = {
  coldAppToRendererMs: 500,
  coldAppToHermesReadyMs: 750,
  coldAppToAcpSessionReadyMs: 1_000,
  sendToAcpSessionReadyMs: 500,
  sendToRequestAcceptedMs: 100,
  sendToModelFirstTokenMs: 250,
  sendToAcpFirstTextMs: 250,
  sendToFirstVisibleMs: 250,
  acpToRendererMs: 50,
  responseToTtsMs: 100,
};

export type CommandEveTtftRegressionGate = {
  outcome: 'PASS' | 'FAIL' | 'INSUFFICIENT_EVIDENCE';
  metric: CommandEveTtftMetricName;
  baseline: CommandEveTtftStats;
  candidate: CommandEveTtftStats;
  relativeLimit: number;
  absoluteLimitMs: number;
  relativeDelta: number | null;
  absoluteDeltaMs: number | null;
  reason: string;
};

/**
 * Fail only when p95 regresses by BOTH more than 20% and a material absolute
 * budget. That prevents tiny low-latency noise from looking like a release
 * regression while still catching meaningful user-visible drift.
 */
export function evaluateCommandEveTtftRegression(input: {
  baselineReceipts: CommandEveTtftReceipt[];
  candidateReceipts: CommandEveTtftReceipt[];
  metric: CommandEveTtftMetricName;
  minSamples?: number;
  relativeLimit?: number;
  absoluteLimitMs?: number;
}): CommandEveTtftRegressionGate {
  const minSamples = input.minSamples ?? 5;
  const relativeLimit = input.relativeLimit ?? 0.2;
  const absoluteLimitMs = input.absoluteLimitMs ?? DEFAULT_TTFT_ABSOLUTE_REGRESSION_LIMIT_MS[input.metric];
  const baseline = summarizeCommandEveTtftMetric(input.baselineReceipts, input.metric);
  const candidate = summarizeCommandEveTtftMetric(input.candidateReceipts, input.metric);

  if (baseline.count < minSamples || candidate.count < minSamples || baseline.p95 === null || candidate.p95 === null) {
    return {
      outcome: 'INSUFFICIENT_EVIDENCE',
      metric: input.metric,
      baseline,
      candidate,
      relativeLimit,
      absoluteLimitMs,
      relativeDelta: null,
      absoluteDeltaMs: null,
      reason: `requires at least ${minSamples} observed samples in baseline and candidate`,
    };
  }

  const absoluteDeltaMs = candidate.p95 - baseline.p95;
  const relativeDelta = baseline.p95 > 0 ? absoluteDeltaMs / baseline.p95 : null;
  const exceedsRelativeLimit = baseline.p95 === 0 ? candidate.p95 > 0 : (relativeDelta ?? 0) > relativeLimit;
  const failed = exceedsRelativeLimit && absoluteDeltaMs > absoluteLimitMs;
  return {
    outcome: failed ? 'FAIL' : 'PASS',
    metric: input.metric,
    baseline,
    candidate,
    relativeLimit,
    absoluteLimitMs,
    relativeDelta,
    absoluteDeltaMs,
    reason: failed
      ? baseline.p95 === 0
        ? `candidate p95 regressed from 0ms by ${absoluteDeltaMs}ms`
        : `candidate p95 regressed by ${Math.round((relativeDelta ?? 0) * 100)}% and ${absoluteDeltaMs}ms`
      : 'candidate did not exceed both the relative and absolute p95 limits',
  };
}
