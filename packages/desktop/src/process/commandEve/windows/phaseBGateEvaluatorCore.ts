/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PHASE_B_GATE_CONTRACTS,
  phaseBGateEvaluation,
  type PhaseBGateExecution,
  type PhaseBGateId,
  type PhaseBGateOutcome,
  type PhaseBGateProvenance,
  type PhaseBGateReceiptV1,
} from './phaseBCandidateConvergenceCore';

export const PHASE_B_RAW_EVALUATION_SCHEMA_VERSION = 'command-eve-windows-phase-b-raw-evaluation/v1' as const;

export const PHASE_B_PERFORMANCE_THRESHOLDS = {
  lowmemHeartbeatMaxGapMs: 2_000,
  lowmemIdleProcessTreeRssBytes: 900 * 1024 ** 2,
  lowmemIdleCpuMedianPercent: 3,
  normalWarmVisibleWindowP95Ms: 5_000,
  normalChatFirstResponseP95Ms: 30_000,
  normalArtifactVisibleP95Ms: 60_000,
  normalWorkerCompletionP95Ms: 120_000,
  stopAcknowledgedP95Ms: 500,
  processTreeCleanupMs: 5_000,
  soakDurationMs: 8 * 60 * 60 * 1_000,
  soakMinimumSamples: 480,
  soakMaximumRssGrowthPercent: 20,
} as const;

export type PhaseBRawAssertionProofV1 = {
  command_id: string;
  evidence_paths: string[];
  completion_sentinel: 'WIN_PHASE_B_ASSERTION_PROOF_COMPLETE';
};

export type PhaseBRawObservation = boolean | number | string | null | PhaseBRawAssertionProofV1;

export type PhaseBRawGateEvaluationV1 = {
  schema_version: typeof PHASE_B_RAW_EVALUATION_SCHEMA_VERSION;
  gate_id: PhaseBGateId;
  evaluation_outcome: PhaseBGateOutcome;
  execution: PhaseBGateExecution;
  provenance: PhaseBGateProvenance;
  commands: PhaseBGateReceiptV1['commands'];
  observations: Record<string, PhaseBRawObservation>;
  metrics: PhaseBGateReceiptV1['metrics'];
  evidence: Array<{
    path: string;
    kind: PhaseBGateReceiptV1['evidence'][number]['kind'];
  }>;
  started_at: string;
  completed_at: string;
  worker: string;
  reviewer: string;
  completion_sentinel: 'WIN_PHASE_B_RAW_EVALUATION_COMPLETE';
};

export type PhaseBDerivedGateEvaluation = Omit<
  PhaseBRawGateEvaluationV1,
  'schema_version' | 'observations' | 'completion_sentinel'
> & {
  assertions: PhaseBGateReceiptV1['assertions'];
};

type AssertionResult = PhaseBGateReceiptV1['assertions'][number];

const GATE_OUTCOMES = new Set<PhaseBGateOutcome>([
  'completed',
  'blocked-auth',
  'blocked-artifact',
  'blocked-environment',
  'blocked-external-approval',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function result(id: string, passed: boolean, passDetail: string, rejectDetail: string): AssertionResult {
  return { id, status: passed ? 'PASS' : 'REJECT', detail: passed ? passDetail : rejectDetail };
}

const ASSERTION_EVIDENCE_KIND: Readonly<Record<string, PhaseBGateReceiptV1['evidence'][number]['kind']>> = {
  'image-rendered': 'image',
  'video-rendered': 'video',
  'audio-rendered': 'audio',
  'html-rendered': 'artifact',
  'table-text-rendered': 'artifact',
  'file-downloadable': 'artifact',
  attach: 'artifact',
  open: 'artifact',
  reveal: 'artifact',
  'cloud-stt': 'audio',
  'cloud-tts': 'audio',
  'light-mode': 'screenshot',
  'dark-mode': 'screenshot',
  'display-scaling': 'screenshot',
  'viewport-1280x720': 'screenshot',
  'viewport-1920x1080': 'screenshot',
  'codex-review-complete': 'report',
  'fable-review-complete': 'report',
  'sanitized-demo-script': 'report',
  'known-limits': 'report',
  rollback: 'report',
  'support-rehearsal': 'report',
  'evidence-index': 'report',
};

function assertionProof(raw: PhaseBRawGateEvaluationV1, id: string): boolean {
  const proof = raw.observations[id];
  if (!isRecord(proof)) return false;
  if (proof.completion_sentinel !== 'WIN_PHASE_B_ASSERTION_PROOF_COMPLETE') return false;
  if (typeof proof.command_id !== 'string' || !proof.command_id.trim()) return false;
  if (!Array.isArray(proof.evidence_paths) || proof.evidence_paths.length === 0) return false;
  if (proof.evidence_paths.some((item) => typeof item !== 'string' || !item.trim())) return false;
  if (new Set(proof.evidence_paths).size !== proof.evidence_paths.length) return false;
  if (!Array.isArray(raw.commands)) return false;
  const commands = raw.commands.filter((command) => command?.id === proof.command_id);
  if (commands.length !== 1 || commands[0].exit_code !== 0) return false;
  if (!Array.isArray(raw.evidence)) return false;
  const evidence = raw.evidence.filter(
    (item): item is PhaseBRawGateEvaluationV1['evidence'][number] =>
      isRecord(item) && typeof item.path === 'string' && typeof item.kind === 'string'
  );
  const bound = proof.evidence_paths.map((proofPath) => evidence.find((item) => item.path === proofPath));
  if (bound.some((item) => !item)) return false;
  if (!bound.some((item) => item?.kind === 'json')) return false;
  const requiredKind = ASSERTION_EVIDENCE_KIND[id];
  return !requiredKind || bound.some((item) => item?.kind === requiredKind);
}

function booleanObservation(raw: PhaseBRawGateEvaluationV1, id: string): AssertionResult {
  return result(
    id,
    assertionProof(raw, id),
    `${id} was bound to a successful gate-specific harness command and immutable evidence.`,
    `${id} was missing or was not bound to a successful harness command and evidence.`
  );
}

function numberObservation(raw: PhaseBRawGateEvaluationV1, id: string): number | null {
  const value = raw.observations[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumberObservation(raw: PhaseBRawGateEvaluationV1, id: string): number | null {
  const value = numberObservation(raw, id);
  return value !== null && value >= 0 ? value : null;
}

function nonNegativeIntegerObservation(raw: PhaseBRawGateEvaluationV1, id: string): number | null {
  const value = numberObservation(raw, id);
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function machineExecution(
  raw: PhaseBRawGateEvaluationV1
): Extract<PhaseBGateExecution, { target: 'lowmem-8gb' | 'normal-16gb' }> | null {
  return raw.execution.target === 'lowmem-8gb' || raw.execution.target === 'normal-16gb' ? raw.execution : null;
}

function environmentAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const execution = machineExecution(raw);
  const ram = execution?.ram_bytes ?? 0;
  const gib = 1024 ** 3;
  const expectedRam =
    execution?.target === 'lowmem-8gb'
      ? ram >= 7 * gib && ram <= 10 * gib
      : execution?.target === 'normal-16gb'
        ? ram >= 14 * gib && ram <= 20 * gib
        : false;
  return [
    result(
      'windows-11',
      assertionProof(raw, 'windows-11') && Boolean(execution && /Windows 11/iu.test(execution.os_name)),
      'Execution reports Windows 11.',
      'Execution does not report Windows 11.'
    ),
    result(
      'native-amd64',
      assertionProof(raw, 'native-amd64') &&
        execution?.native_architecture === 'AMD64' &&
        execution.process_architecture === 'X64',
      'Native and process architectures are AMD64/X64.',
      'Native or process architecture is not AMD64/X64.'
    ),
    result(
      'expected-ram-class',
      assertionProof(raw, 'expected-ram-class') && expectedRam,
      'Physical RAM matches the selected machine class.',
      'Physical RAM does not match the selected machine class.'
    ),
    result(
      'standard-user',
      assertionProof(raw, 'standard-user') && execution?.standard_user === true,
      'The workflow runs with a standard-user token.',
      'The workflow is elevated or standard-user evidence is missing.'
    ),
    booleanObservation(raw, 'clock-synchronized'),
    booleanObservation(raw, 'jit-binding-reconciled'),
  ];
}

function turnControlAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const stopP95 = nonNegativeNumberObservation(raw, 'stop_acknowledged_p95_ms');
  return PHASE_B_GATE_CONTRACTS['WIN-B08'].required_assertion_ids.map((id) =>
    id === 'stop'
      ? result(
          id,
          assertionProof(raw, id) &&
            stopP95 !== null &&
            stopP95 <= PHASE_B_PERFORMANCE_THRESHOLDS.stopAcknowledgedP95Ms,
          `Stop was acknowledged within ${PHASE_B_PERFORMANCE_THRESHOLDS.stopAcknowledgedP95Ms} ms p95.`,
          `Stop was not proven within ${PHASE_B_PERFORMANCE_THRESHOLDS.stopAcknowledgedP95Ms} ms p95.`
        )
      : booleanObservation(raw, id)
  );
}

function workerAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const cleanupMs = nonNegativeNumberObservation(raw, 'process_tree_cleanup_ms');
  const orphanCount = nonNegativeIntegerObservation(raw, 'orphan_count');
  return PHASE_B_GATE_CONTRACTS['WIN-B09'].required_assertion_ids.map((id) => {
    if (id !== 'orphan-cleanup') return booleanObservation(raw, id);
    return result(
      id,
      assertionProof(raw, id) &&
        cleanupMs !== null &&
        cleanupMs <= PHASE_B_PERFORMANCE_THRESHOLDS.processTreeCleanupMs &&
        orphanCount === 0,
      `Owned process tree reached zero orphans within ${PHASE_B_PERFORMANCE_THRESHOLDS.processTreeCleanupMs} ms.`,
      `Owned process tree did not reach zero orphans within ${PHASE_B_PERFORMANCE_THRESHOLDS.processTreeCleanupMs} ms.`
    );
  });
}

function lowMemoryAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const heartbeatGap = nonNegativeNumberObservation(raw, 'ui_heartbeat_max_gap_ms');
  const freezeCount = nonNegativeIntegerObservation(raw, 'freeze_count');
  const idleRss = nonNegativeNumberObservation(raw, 'idle_process_tree_rss_bytes');
  const oomCount = nonNegativeIntegerObservation(raw, 'oom_count');
  const idleCpu = nonNegativeNumberObservation(raw, 'idle_cpu_median_percent');
  const workerConcurrency = nonNegativeIntegerObservation(raw, 'worker_concurrency');
  return [
    result(
      'os-responsive',
      assertionProof(raw, 'os-responsive') &&
        heartbeatGap !== null &&
        heartbeatGap <= PHASE_B_PERFORMANCE_THRESHOLDS.lowmemHeartbeatMaxGapMs &&
        freezeCount === 0,
      `UI heartbeat stayed within ${PHASE_B_PERFORMANCE_THRESHOLDS.lowmemHeartbeatMaxGapMs} ms with zero freezes.`,
      'UI heartbeat, freeze count or responsiveness evidence exceeded the low-memory threshold.'
    ),
    result(
      'memory-bounded',
      assertionProof(raw, 'memory-bounded') &&
        idleRss !== null &&
        idleRss <= PHASE_B_PERFORMANCE_THRESHOLDS.lowmemIdleProcessTreeRssBytes &&
        oomCount === 0,
      `Idle process-tree RSS stayed at or below ${PHASE_B_PERFORMANCE_THRESHOLDS.lowmemIdleProcessTreeRssBytes} bytes with zero OOMs.`,
      'Idle process-tree RSS exceeded the cloud-only budget, OOM occurred, or evidence is missing.'
    ),
    result(
      'cpu-bounded',
      assertionProof(raw, 'cpu-bounded') &&
        idleCpu !== null &&
        idleCpu <= PHASE_B_PERFORMANCE_THRESHOLDS.lowmemIdleCpuMedianPercent,
      `Idle CPU median stayed at or below ${PHASE_B_PERFORMANCE_THRESHOLDS.lowmemIdleCpuMedianPercent} percent.`,
      'Idle CPU median exceeded the low-memory threshold or evidence is missing.'
    ),
    result(
      'honest-degradation',
      assertionProof(raw, 'honest-degradation') &&
        raw.observations.degraded_profile_active === true &&
        raw.observations.local_inference_disabled === true &&
        workerConcurrency === 1,
      'Cloud-only degraded profile was explicit, local inference was disabled and worker concurrency was one.',
      'The degraded profile was hidden, local inference remained active, concurrency exceeded one or evidence is missing.'
    ),
  ];
}

function normalPerformanceAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const warmVisible = nonNegativeNumberObservation(raw, 'warm_visible_window_p95_ms');
  const chat = nonNegativeNumberObservation(raw, 'chat_first_response_p95_ms');
  const artifact = nonNegativeNumberObservation(raw, 'artifact_visible_p95_ms');
  const worker = nonNegativeNumberObservation(raw, 'worker_completion_p95_ms');
  return [
    result(
      'chat-latency',
      assertionProof(raw, 'chat-latency') &&
        warmVisible !== null &&
        warmVisible <= PHASE_B_PERFORMANCE_THRESHOLDS.normalWarmVisibleWindowP95Ms &&
        chat !== null &&
        chat <= PHASE_B_PERFORMANCE_THRESHOLDS.normalChatFirstResponseP95Ms,
      'Warm startup and managed-cloud first-response p95 met their budgets.',
      'Warm startup or managed-cloud first-response p95 exceeded budget or is missing.'
    ),
    result(
      'artifact-latency',
      assertionProof(raw, 'artifact-latency') &&
        artifact !== null &&
        artifact <= PHASE_B_PERFORMANCE_THRESHOLDS.normalArtifactVisibleP95Ms,
      'Artifact-visible p95 met its budget.',
      'Artifact-visible p95 exceeded budget or is missing.'
    ),
    result(
      'worker-latency',
      assertionProof(raw, 'worker-latency') &&
        worker !== null &&
        worker <= PHASE_B_PERFORMANCE_THRESHOLDS.normalWorkerCompletionP95Ms,
      'Bounded-worker completion p95 met its budget.',
      'Bounded-worker completion p95 exceeded budget or is missing.'
    ),
  ];
}

function soakAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const duration = nonNegativeNumberObservation(raw, 'soak_duration_ms');
  const samples = nonNegativeIntegerObservation(raw, 'sample_count');
  const rssGrowth = numberObservation(raw, 'rss_growth_percent');
  const deadlocks = nonNegativeIntegerObservation(raw, 'deadlock_count');
  const orphanGrowth = nonNegativeIntegerObservation(raw, 'orphan_growth_count');
  return [
    result(
      'eight-hour-duration',
      assertionProof(raw, 'eight-hour-duration') &&
        duration !== null &&
        duration >= PHASE_B_PERFORMANCE_THRESHOLDS.soakDurationMs &&
        samples !== null &&
        samples >= PHASE_B_PERFORMANCE_THRESHOLDS.soakMinimumSamples,
      'Soak reached eight hours with the minimum sample count.',
      'Soak duration or sample count did not reach the required floor.'
    ),
    result(
      'no-leak',
      assertionProof(raw, 'no-leak') &&
        rssGrowth !== null &&
        rssGrowth <= PHASE_B_PERFORMANCE_THRESHOLDS.soakMaximumRssGrowthPercent,
      `Settled process-tree RSS growth stayed at or below ${PHASE_B_PERFORMANCE_THRESHOLDS.soakMaximumRssGrowthPercent} percent.`,
      'Settled process-tree RSS growth exceeded the allowed percentage or is missing.'
    ),
    result(
      'no-deadlock',
      assertionProof(raw, 'no-deadlock') && deadlocks === 0,
      'No deadlock was detected.',
      'A deadlock was detected or evidence is missing.'
    ),
    result(
      'no-orphan-growth',
      assertionProof(raw, 'no-orphan-growth') && orphanGrowth === 0,
      'Owned orphan-process count did not grow.',
      'Owned orphan-process count grew or evidence is missing.'
    ),
  ];
}

function updateParityAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const execution = raw.execution.target === 'cross-platform' ? raw.execution : null;
  return PHASE_B_GATE_CONTRACTS['WIN-B16'].required_assertion_ids.map((id) =>
    id === 'same-source-commit'
      ? result(
          id,
          assertionProof(raw, id) && execution?.same_source_commit === true,
          'Mac and Windows receipts bind the same source commit.',
          'Mac and Windows receipts do not bind the same source commit.'
        )
      : booleanObservation(raw, id)
  );
}

function peerConvergenceAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  const unresolvedP0 = nonNegativeIntegerObservation(raw, 'unresolved_p0');
  const unresolvedP1 = nonNegativeIntegerObservation(raw, 'unresolved_p1');
  const unresolvedP2 = nonNegativeIntegerObservation(raw, 'unresolved_p2');
  return PHASE_B_GATE_CONTRACTS['WIN-B18'].required_assertion_ids.map((id) => {
    if (id === 'zero-confirmed-p0')
      return result(
        id,
        assertionProof(raw, id) && unresolvedP0 === 0,
        'Zero confirmed P0 findings remain.',
        'Confirmed P0 findings remain or count is missing.'
      );
    if (id === 'zero-confirmed-p1')
      return result(
        id,
        assertionProof(raw, id) && unresolvedP1 === 0,
        'Zero confirmed P1 findings remain.',
        'Confirmed P1 findings remain or count is missing.'
      );
    if (id === 'zero-confirmed-p2')
      return result(
        id,
        assertionProof(raw, id) && unresolvedP2 === 0,
        'Zero confirmed P2 findings remain.',
        'Confirmed P2 findings remain or count is missing.'
      );
    return booleanObservation(raw, id);
  });
}

function completedAssertions(raw: PhaseBRawGateEvaluationV1): AssertionResult[] {
  if (raw.gate_id === 'WIN-B00') return environmentAssertions(raw);
  if (raw.gate_id === 'WIN-B08') return turnControlAssertions(raw);
  if (raw.gate_id === 'WIN-B09') return workerAssertions(raw);
  if (raw.gate_id === 'WIN-B12') return lowMemoryAssertions(raw);
  if (raw.gate_id === 'WIN-B13') return normalPerformanceAssertions(raw);
  if (raw.gate_id === 'WIN-B14') return soakAssertions(raw);
  if (raw.gate_id === 'WIN-B16') return updateParityAssertions(raw);
  if (raw.gate_id === 'WIN-B18') return peerConvergenceAssertions(raw);
  return PHASE_B_GATE_CONTRACTS[raw.gate_id].required_assertion_ids.map((id) => booleanObservation(raw, id));
}

export function evaluatePhaseBRawGate(raw: PhaseBRawGateEvaluationV1): PhaseBDerivedGateEvaluation {
  if (!isRecord(raw)) throw new Error('raw evaluation must be an object');
  if (raw.schema_version !== PHASE_B_RAW_EVALUATION_SCHEMA_VERSION) {
    throw new Error(`raw evaluation schema_version must be ${PHASE_B_RAW_EVALUATION_SCHEMA_VERSION}`);
  }
  if (!(raw.gate_id in PHASE_B_GATE_CONTRACTS)) throw new Error('raw evaluation gate_id is not recognized');
  if (!GATE_OUTCOMES.has(raw.evaluation_outcome)) throw new Error('raw evaluation outcome is not recognized');
  if (!isRecord(raw.observations)) throw new Error('raw evaluation observations must be an object');
  if (!isRecord(raw.metrics)) throw new Error('raw evaluation metrics must be an object');
  if (!Array.isArray(raw.commands)) throw new Error('raw evaluation commands must be an array');
  if (!Array.isArray(raw.evidence)) throw new Error('raw evaluation evidence must be an array');
  if (raw.completion_sentinel !== 'WIN_PHASE_B_RAW_EVALUATION_COMPLETE') {
    throw new Error('raw evaluation completion sentinel is missing');
  }
  const assertions =
    raw.evaluation_outcome === 'completed'
      ? completedAssertions(raw)
      : PHASE_B_GATE_CONTRACTS[raw.gate_id].required_assertion_ids.map((id) =>
          result(id, false, '', `${id} was not evaluated because the gate outcome is ${raw.evaluation_outcome}.`)
        );
  return {
    gate_id: raw.gate_id,
    evaluation_outcome: raw.evaluation_outcome,
    execution: raw.execution,
    provenance: raw.provenance,
    commands: raw.commands,
    assertions,
    metrics: raw.metrics,
    evidence: raw.evidence,
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    worker: raw.worker,
    reviewer: raw.reviewer,
  };
}

export function validatePhaseBGateReceiptRawDerivation(input: unknown): string[] {
  if (!isRecord(input)) return ['receipt raw derivation requires an object'];
  const rawEnvelope = isRecord(input.raw_evaluation) ? input.raw_evaluation : null;
  if (!rawEnvelope || !isRecord(rawEnvelope.observations)) return ['raw_evaluation observations are missing'];
  try {
    const raw = {
      schema_version: rawEnvelope.schema_version,
      gate_id: input.gate_id,
      evaluation_outcome: input.evaluation_outcome,
      execution: input.execution,
      provenance: input.provenance,
      commands: input.commands,
      observations: rawEnvelope.observations,
      metrics: input.metrics,
      evidence: Array.isArray(input.evidence)
        ? input.evidence.filter(isRecord).map((item) => ({ path: item.path, kind: item.kind }))
        : input.evidence,
      started_at: input.started_at,
      completed_at: input.completed_at,
      worker: input.worker,
      reviewer: input.reviewer,
      completion_sentinel: rawEnvelope.completion_sentinel,
    } as PhaseBRawGateEvaluationV1;
    const derived = evaluatePhaseBRawGate(raw);
    const computed = phaseBGateEvaluation(derived.gate_id, derived.evaluation_outcome, derived.assertions);
    const errors: string[] = [];
    if (JSON.stringify(input.assertions) !== JSON.stringify(derived.assertions)) {
      errors.push('assertions do not match the embedded raw evaluation');
    }
    if (input.evaluator_id !== computed.evaluator_id) errors.push('evaluator_id does not match the raw evaluation');
    if (input.status !== computed.status) errors.push('status does not match the raw evaluation');
    if (input.reject_code !== computed.reject_code) errors.push('reject_code does not match the raw evaluation');
    return errors;
  } catch (error) {
    return [`raw evaluation could not be re-derived: ${error instanceof Error ? error.message : 'unknown error'}`];
  }
}
