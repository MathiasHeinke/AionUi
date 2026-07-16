/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { detectCommandEveSensitiveEgress } from '../../../common/api/egressBoundaryCore';
import { validatePhaseBGateReceiptRawDerivation, type PhaseBRawObservation } from './phaseBGateEvaluatorCore';

export const PHASE_B_CANDIDATE_SCHEMA_VERSION = 'command-eve-windows-phase-b-candidate/v1' as const;
export const PHASE_B_GATE_SCHEMA_VERSION = 'command-eve-windows-phase-b-gate/v1' as const;

export const PHASE_B_GATE_IDS = [
  'WIN-B00',
  'WIN-B01',
  'WIN-B02',
  'WIN-B03',
  'WIN-B04',
  'WIN-B05',
  'WIN-B06',
  'WIN-B07',
  'WIN-B08',
  'WIN-B09',
  'WIN-B10',
  'WIN-B11',
  'WIN-B12',
  'WIN-B13',
  'WIN-B14',
  'WIN-B15',
  'WIN-B16',
  'WIN-B17',
  'WIN-B18',
  'WIN-B19',
] as const;

export type PhaseBGateId = (typeof PHASE_B_GATE_IDS)[number];
export type PhaseBGateTarget = 'lowmem-8gb' | 'normal-16gb' | 'cross-platform' | 'controller';
export type PhaseBGateStatus =
  | 'PASS'
  | 'REJECT'
  | 'BLOCKED_AUTH'
  | 'BLOCKED_ARTIFACT'
  | 'BLOCKED_ENVIRONMENT'
  | 'BLOCKED_EXTERNAL_APPROVAL';
export type PhaseBGateOutcome =
  | 'completed'
  | 'blocked-auth'
  | 'blocked-artifact'
  | 'blocked-environment'
  | 'blocked-external-approval';
export type PhaseBEvidenceKind =
  | 'json'
  | 'markdown'
  | 'log'
  | 'screenshot'
  | 'image'
  | 'video'
  | 'audio'
  | 'artifact'
  | 'report';

type PhaseBMachineExecution = {
  target: 'lowmem-8gb' | 'normal-16gb';
  os_name: string;
  os_build: string;
  native_architecture: 'AMD64';
  process_architecture: 'X64';
  ram_bytes: number;
  cpu_count: number;
  standard_user: boolean;
};

type PhaseBCrossPlatformExecution = {
  target: 'cross-platform';
  platforms: ['macOS', 'Windows'];
  same_source_commit: boolean;
};

type PhaseBControllerExecution = {
  target: 'controller';
  controller: 'codex-controller';
};

export type PhaseBGateExecution = PhaseBMachineExecution | PhaseBCrossPlatformExecution | PhaseBControllerExecution;

type PhaseBMachineProvenance = {
  lane: 'windows-cloud-pc';
  workflow_repository: 'MathiasHeinke/command-eve-windows-lab';
  workflow_commit: string;
  run_id: string;
  run_attempt: number;
  job: string;
  runner_binding: string;
  runner_name: string;
  machine_receipt_sha256: string;
};

type PhaseBCrossPlatformProvenance = {
  lane: 'cross-platform-ci';
  workflow_repository: 'MathiasHeinke/AionUi';
  workflow_commit: string;
  run_id: string;
  run_attempt: number;
  job: string;
  mac_receipt_sha256: string;
  windows_receipt_sha256: string;
};

type PhaseBControllerProvenance = {
  lane: 'controller-review';
  controller: 'codex-controller';
  source_tree_clean: boolean;
  report_sha256: string;
};

export type PhaseBGateProvenance = PhaseBMachineProvenance | PhaseBCrossPlatformProvenance | PhaseBControllerProvenance;

export type PhaseBCandidateManifestV1 = {
  schema_version: typeof PHASE_B_CANDIDATE_SCHEMA_VERSION;
  candidate_id: string;
  source: {
    repository: string;
    commit: string;
    tree_clean: true;
  };
  artifact: {
    name: string;
    sha256: string;
    size_bytes: number;
  };
  build: {
    workflow_repository: string;
    workflow_commit: string;
    run_id: string;
    run_attempt: number;
    job: string;
    runner_os: 'Windows';
    runner_arch: 'X64';
  };
  created_at: string;
  completion_sentinel: 'WIN_PHASE_B_CANDIDATE_MANIFEST_COMPLETE';
};

export type PhaseBGateReceiptV1 = {
  schema_version: typeof PHASE_B_GATE_SCHEMA_VERSION;
  candidate_id: string;
  candidate_manifest_sha256: string;
  gate_id: PhaseBGateId;
  evaluator_id: string;
  evaluation_outcome: PhaseBGateOutcome;
  status: PhaseBGateStatus;
  reject_code: string | null;
  source: {
    repository: string;
    commit: string;
    tree_clean: boolean;
  };
  artifact: {
    name: string;
    sha256: string;
    size_bytes: number;
  };
  execution: PhaseBGateExecution;
  provenance: PhaseBGateProvenance;
  commands: Array<{
    id: string;
    exit_code: number;
    duration_ms?: number;
  }>;
  assertions: Array<{
    id: string;
    status: 'PASS' | 'REJECT';
    detail: string;
  }>;
  metrics: Record<string, string | number | boolean | null>;
  evidence: Array<{
    path: string;
    sha256: string;
    size_bytes: number;
    kind: PhaseBEvidenceKind;
  }>;
  raw_evaluation: {
    schema_version: 'command-eve-windows-phase-b-raw-evaluation/v1';
    observations: Record<string, PhaseBRawObservation>;
    completion_sentinel: 'WIN_PHASE_B_RAW_EVALUATION_COMPLETE';
  };
  started_at: string;
  completed_at: string;
  worker: string;
  reviewer: string;
  completion_sentinel: 'WIN_PHASE_B_GATE_COMPLETE';
};

export type PhaseBRequiredReceipt = {
  gate_id: PhaseBGateId;
  target: PhaseBGateTarget;
};

export const PHASE_B_REQUIRED_RECEIPTS: readonly PhaseBRequiredReceipt[] = [
  { gate_id: 'WIN-B00', target: 'lowmem-8gb' },
  { gate_id: 'WIN-B00', target: 'normal-16gb' },
  { gate_id: 'WIN-B01', target: 'lowmem-8gb' },
  { gate_id: 'WIN-B01', target: 'normal-16gb' },
  { gate_id: 'WIN-B02', target: 'lowmem-8gb' },
  { gate_id: 'WIN-B02', target: 'normal-16gb' },
  { gate_id: 'WIN-B03', target: 'normal-16gb' },
  { gate_id: 'WIN-B04', target: 'lowmem-8gb' },
  { gate_id: 'WIN-B04', target: 'normal-16gb' },
  { gate_id: 'WIN-B05', target: 'normal-16gb' },
  { gate_id: 'WIN-B06', target: 'normal-16gb' },
  { gate_id: 'WIN-B07', target: 'normal-16gb' },
  { gate_id: 'WIN-B08', target: 'normal-16gb' },
  { gate_id: 'WIN-B09', target: 'normal-16gb' },
  { gate_id: 'WIN-B10', target: 'normal-16gb' },
  { gate_id: 'WIN-B11', target: 'lowmem-8gb' },
  { gate_id: 'WIN-B11', target: 'normal-16gb' },
  { gate_id: 'WIN-B12', target: 'lowmem-8gb' },
  { gate_id: 'WIN-B13', target: 'normal-16gb' },
  { gate_id: 'WIN-B14', target: 'normal-16gb' },
  { gate_id: 'WIN-B15', target: 'normal-16gb' },
  { gate_id: 'WIN-B16', target: 'cross-platform' },
  { gate_id: 'WIN-B17', target: 'lowmem-8gb' },
  { gate_id: 'WIN-B17', target: 'normal-16gb' },
  { gate_id: 'WIN-B18', target: 'controller' },
  { gate_id: 'WIN-B19', target: 'controller' },
] as const;

type PhaseBGateContract = {
  evaluator_id: string;
  required_assertion_ids: readonly string[];
  required_evidence_kinds: readonly PhaseBEvidenceKind[];
};

export const PHASE_B_GATE_CONTRACTS: Readonly<Record<PhaseBGateId, PhaseBGateContract>> = {
  'WIN-B00': {
    evaluator_id: 'phase-b-environment-truth/v1',
    required_assertion_ids: [
      'windows-11',
      'native-amd64',
      'expected-ram-class',
      'standard-user',
      'clock-synchronized',
      'jit-binding-reconciled',
    ],
    required_evidence_kinds: ['json', 'markdown'],
  },
  'WIN-B01': {
    evaluator_id: 'phase-b-clean-lifecycle/v1',
    required_assertion_ids: ['install', 'launch', 'exit', 'uninstall', 'zero-owned-residue'],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B02': {
    evaluator_id: 'phase-b-defender-truth/v1',
    required_assertion_ids: [
      'defender-enabled',
      'smartscreen-enabled',
      'exclusions-unchanged',
      'warnings-not-bypassed',
    ],
    required_evidence_kinds: ['json', 'markdown'],
  },
  'WIN-B03': {
    evaluator_id: 'phase-b-account-credits/v1',
    required_assertion_ids: ['activation', 'entitlement', 'purchased-credit-path', 'no-free-tier-fallthrough'],
    required_evidence_kinds: ['json', 'markdown'],
  },
  'WIN-B04': {
    evaluator_id: 'phase-b-hermes-bootstrap/v1',
    required_assertion_ids: ['pinned-python', 'bootstrap-repair', 'managed-cloud-turn'],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B05': {
    evaluator_id: 'phase-b-artifact-surface/v1',
    required_assertion_ids: [
      'image-rendered',
      'video-rendered',
      'audio-rendered',
      'html-rendered',
      'table-text-rendered',
      'file-downloadable',
      'survives-restart',
    ],
    required_evidence_kinds: ['json', 'markdown', 'image', 'video', 'audio', 'artifact'],
  },
  'WIN-B06': {
    evaluator_id: 'phase-b-file-semantics/v1',
    required_assertion_ids: ['attach', 'open', 'reveal', 'safe-workspace', 'spaces-unicode-long-paths'],
    required_evidence_kinds: ['json', 'markdown', 'artifact'],
  },
  'WIN-B07': {
    evaluator_id: 'phase-b-voice/v1',
    required_assertion_ids: [
      'cloud-stt',
      'cloud-tts',
      'consent',
      'enter-transcribe',
      'send-after-transcribe',
      'denial-recovery',
      'cancel-recovery',
    ],
    required_evidence_kinds: ['json', 'markdown', 'audio'],
  },
  'WIN-B08': {
    evaluator_id: 'phase-b-turn-control/v1',
    required_assertion_ids: [
      'stop',
      'correct-now',
      'queue-next',
      'resume',
      'automatic-continuation',
      'deterministic-order',
    ],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B09': {
    evaluator_id: 'phase-b-bounded-workers/v1',
    required_assertion_ids: ['read-only-delegation', 'cli-brands-hidden', 'timeout', 'orphan-cleanup'],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B10': {
    evaluator_id: 'phase-b-support-bundle/v1',
    required_assertion_ids: [
      'useful-diagnostics',
      'secrets-redacted',
      'tokens-redacted',
      'user-content-redacted',
      'private-paths-redacted',
    ],
    required_evidence_kinds: ['json', 'markdown', 'artifact'],
  },
  'WIN-B11': {
    evaluator_id: 'phase-b-recovery/v1',
    required_assertion_ids: ['app-restart', 'bootstrap-repair', 'profile-preserved', 'repeatable'],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B12': {
    evaluator_id: 'phase-b-low-memory-performance/v1',
    required_assertion_ids: ['os-responsive', 'memory-bounded', 'cpu-bounded', 'honest-degradation'],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B13': {
    evaluator_id: 'phase-b-normal-performance/v1',
    required_assertion_ids: ['chat-latency', 'artifact-latency', 'worker-latency'],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B14': {
    evaluator_id: 'phase-b-soak/v1',
    required_assertion_ids: ['eight-hour-duration', 'no-leak', 'no-deadlock', 'no-orphan-growth'],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B15': {
    evaluator_id: 'phase-b-visual-ux/v1',
    required_assertion_ids: [
      'light-mode',
      'dark-mode',
      'display-scaling',
      'viewport-1280x720',
      'viewport-1920x1080',
      'no-overlap',
      'no-clipped-controls',
    ],
    required_evidence_kinds: ['json', 'markdown', 'screenshot'],
  },
  'WIN-B16': {
    evaluator_id: 'phase-b-update-parity/v1',
    required_assertion_ids: [
      'same-source-commit',
      'mac-suite',
      'windows-suite',
      'no-windows-fork',
      'update-detect',
      'update-download',
      'update-install',
      'update-relaunch',
    ],
    required_evidence_kinds: ['json', 'markdown', 'artifact', 'report'],
  },
  'WIN-B17': {
    evaluator_id: 'phase-b-security-negatives/v1',
    required_assertion_ids: [
      'traversal-fails-closed',
      'forged-capability-fails-closed',
      'unsafe-html-fails-closed',
      'secret-scan-clean',
      'standard-user-escalation-fails-closed',
    ],
    required_evidence_kinds: ['json', 'markdown', 'log'],
  },
  'WIN-B18': {
    evaluator_id: 'phase-b-peer-convergence/v1',
    required_assertion_ids: [
      'codex-review-complete',
      'fable-review-complete',
      'zero-confirmed-p0',
      'zero-confirmed-p1',
      'zero-confirmed-p2',
      'delta-converged',
    ],
    required_evidence_kinds: ['json', 'markdown', 'report'],
  },
  'WIN-B19': {
    evaluator_id: 'phase-b-presentation-packet/v1',
    required_assertion_ids: [
      'sanitized-demo-script',
      'known-limits',
      'rollback',
      'support-rehearsal',
      'evidence-index',
    ],
    required_evidence_kinds: ['json', 'markdown', 'report'],
  },
};

export type PhaseBGateValidation = {
  ok: boolean;
  errors: string[];
};

export type PhaseBEvidenceFileTruth = {
  sha256: string;
  size_bytes: number;
};

export type PhaseBCandidateConvergenceOptions = {
  candidate_manifest: PhaseBCandidateManifestV1;
  candidate_manifest_sha256: string;
  evidence_files: Readonly<Record<string, PhaseBEvidenceFileTruth>>;
};

export type PhaseBCandidateConvergence = {
  schema_version: 'command-eve-windows-phase-b-candidate-convergence/v1';
  status: 'PASS' | 'REJECT';
  reject_code: 'WIN_PHASE_B_INTERNAL_PRESENTATION_REJECT' | null;
  candidate_id: string;
  repository: string;
  source_commit: string;
  artifact_sha256: string;
  artifact_name: string;
  required_receipt_count: number;
  accepted_receipt_count: number;
  missing_receipts: string[];
  errors: string[];
  completion_sentinel: 'WIN_PHASE_B_INTERNAL_PRESENTATION_CONVERGENCE_COMPLETE';
};

const GATE_IDS = new Set<string>(PHASE_B_GATE_IDS);
const STATUSES = new Set<string>([
  'PASS',
  'REJECT',
  'BLOCKED_AUTH',
  'BLOCKED_ARTIFACT',
  'BLOCKED_ENVIRONMENT',
  'BLOCKED_EXTERNAL_APPROVAL',
]);
const OUTCOMES = new Set<string>([
  'completed',
  'blocked-auth',
  'blocked-artifact',
  'blocked-environment',
  'blocked-external-approval',
]);
const TARGETS = new Set<string>(['lowmem-8gb', 'normal-16gb', 'cross-platform', 'controller']);
const EVIDENCE_KINDS = new Set<string>([
  'json',
  'markdown',
  'log',
  'screenshot',
  'image',
  'video',
  'audio',
  'artifact',
  'report',
]);
const FORBIDDEN_METRIC_KEY =
  /(?:token|password|secret|authorization|cookie|card|cvc|otp|prompt|content|body|email|address|phone)/iu;
const RAW_OBSERVATION_KEY = /^[a-z][a-z0-9_-]{0,127}$/u;
const RAW_OBSERVATION_SENSITIVE_KEY_ALLOWLIST = new Set([
  'secrets-redacted',
  'tokens-redacted',
  'user-content-redacted',
  'secret-scan-clean',
]);
const MAX_RAW_OBSERVATION_STRING_CHARACTERS = 256;
const MAX_RAW_OBSERVATION_COLLECTION_ENTRIES = 128;
const MAX_RAW_OBSERVATION_DEPTH = 4;
const MAX_RAW_OBSERVATION_NODES = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha1(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/u.test(value);
}

function validateNoSensitiveText(label: string, value: unknown, errors: string[]): void {
  if (typeof value === 'string' && detectCommandEveSensitiveEgress(value).length > 0) {
    errors.push(`${label} contains sensitive content`);
  }
}

function isEvidenceRelativePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//u.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function receiptKey(gateId: string, target: string): string {
  return `${gateId}@${target}`;
}

export function phaseBCandidateId(sourceCommit: string, artifactSha256: string): string {
  return `ceve-win-${sourceCommit.slice(0, 12)}-${artifactSha256.slice(0, 12)}`;
}

export function validatePhaseBCandidateManifest(input: unknown): PhaseBGateValidation {
  if (!isRecord(input)) return { ok: false, errors: ['candidate manifest must be an object'] };
  const errors: string[] = [];
  if (input.schema_version !== PHASE_B_CANDIDATE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${PHASE_B_CANDIDATE_SCHEMA_VERSION}`);
  }
  const source = isRecord(input.source) ? input.source : null;
  const artifact = isRecord(input.artifact) ? input.artifact : null;
  const build = isRecord(input.build) ? input.build : null;
  if (!source) errors.push('source must be an object');
  if (source?.repository !== 'MathiasHeinke/AionUi') {
    errors.push('source.repository must be MathiasHeinke/AionUi');
  }
  if (!isSha1(source?.commit)) errors.push('source.commit must be a lowercase 40-character SHA-1');
  if (source?.tree_clean !== true) errors.push('source.tree_clean must be true');
  if (!artifact) errors.push('artifact must be an object');
  if (!isNonEmptyString(artifact?.name) || !/^Command EVE-.+-win-x64\.exe$/u.test(artifact.name)) {
    errors.push('artifact.name must identify one Command EVE Windows x64 installer');
  }
  validateNoSensitiveText('artifact.name', artifact?.name, errors);
  if (!isSha256(artifact?.sha256)) errors.push('artifact.sha256 must be a lowercase SHA-256');
  if (!isPositiveInteger(artifact?.size_bytes)) errors.push('artifact.size_bytes must be a positive safe integer');
  if (!build) errors.push('build must be an object');
  if (build?.workflow_repository !== 'MathiasHeinke/AionUi') {
    errors.push('build.workflow_repository must be MathiasHeinke/AionUi');
  }
  if (!isSha1(build?.workflow_commit)) errors.push('build.workflow_commit must be a lowercase SHA-1');
  if (isSha1(source?.commit) && isSha1(build?.workflow_commit) && build.workflow_commit !== source.commit) {
    errors.push('build.workflow_commit must equal source.commit');
  }
  if (!isRunId(build?.run_id)) errors.push('build.run_id must be a positive canonical integer string');
  if (!isPositiveInteger(build?.run_attempt)) errors.push('build.run_attempt must be a positive safe integer');
  if (!isNonEmptyString(build?.job)) errors.push('build.job is required');
  validateNoSensitiveText('build.job', build?.job, errors);
  if (build?.runner_os !== 'Windows') errors.push('build.runner_os must be Windows');
  if (build?.runner_arch !== 'X64') errors.push('build.runner_arch must be X64');
  if (isSha1(source?.commit) && isSha256(artifact?.sha256)) {
    const expectedId = phaseBCandidateId(source.commit, artifact.sha256);
    if (input.candidate_id !== expectedId) errors.push(`candidate_id must be ${expectedId}`);
  } else if (!isNonEmptyString(input.candidate_id)) {
    errors.push('candidate_id is required');
  }
  if (!isIsoTimestamp(input.created_at)) errors.push('created_at must be an ISO-8601 timestamp');
  if (input.completion_sentinel !== 'WIN_PHASE_B_CANDIDATE_MANIFEST_COMPLETE') {
    errors.push('completion_sentinel must be WIN_PHASE_B_CANDIDATE_MANIFEST_COMPLETE');
  }
  return { ok: errors.length === 0, errors };
}

function validateMachineExecution(execution: Record<string, unknown>, status: string | null, errors: string[]): void {
  if (execution.target !== 'lowmem-8gb' && execution.target !== 'normal-16gb') return;
  if (!isNonEmptyString(execution.os_name) || !/Windows 11/iu.test(execution.os_name)) {
    errors.push('machine execution must report Windows 11');
  }
  if (!isNonEmptyString(execution.os_build)) errors.push('machine execution.os_build is required');
  validateNoSensitiveText('machine execution.os_name', execution.os_name, errors);
  validateNoSensitiveText('machine execution.os_build', execution.os_build, errors);
  if (execution.native_architecture !== 'AMD64') errors.push('machine execution.native_architecture must be AMD64');
  if (execution.process_architecture !== 'X64') errors.push('machine execution.process_architecture must be X64');
  if (!isPositiveInteger(execution.ram_bytes)) errors.push('machine execution.ram_bytes must be positive');
  if (!isPositiveInteger(execution.cpu_count)) errors.push('machine execution.cpu_count must be a positive integer');
  if (typeof execution.standard_user !== 'boolean') errors.push('machine execution.standard_user must be boolean');
  if (status === 'PASS' && execution.standard_user !== true) {
    errors.push('machine execution.standard_user must be true for PASS');
  }
  const ramBytes = Number(execution.ram_bytes);
  const gib = 1024 ** 3;
  if (execution.target === 'lowmem-8gb' && (ramBytes < 7 * gib || ramBytes > 10 * gib)) {
    errors.push('lowmem-8gb execution must report between 7 GiB and 10 GiB RAM');
  }
  if (execution.target === 'normal-16gb' && (ramBytes < 14 * gib || ramBytes > 20 * gib)) {
    errors.push('normal-16gb execution must report between 14 GiB and 20 GiB RAM');
  }
}

function validateExecution(value: unknown, status: string | null, errors: string[]): PhaseBGateTarget | null {
  if (!isRecord(value)) {
    errors.push('execution must be an object');
    return null;
  }
  const target =
    typeof value.target === 'string' && TARGETS.has(value.target) ? (value.target as PhaseBGateTarget) : null;
  if (!target) {
    errors.push('execution.target is not recognized');
    return null;
  }
  if (target === 'lowmem-8gb' || target === 'normal-16gb') validateMachineExecution(value, status, errors);
  if (target === 'cross-platform') {
    if (
      !Array.isArray(value.platforms) ||
      value.platforms.length !== 2 ||
      value.platforms[0] !== 'macOS' ||
      value.platforms[1] !== 'Windows'
    ) {
      errors.push('cross-platform execution.platforms must be exactly macOS, Windows');
    }
    if (typeof value.same_source_commit !== 'boolean') {
      errors.push('cross-platform execution.same_source_commit must be boolean');
    }
    if (status === 'PASS' && value.same_source_commit !== true) {
      errors.push('cross-platform execution.same_source_commit must be true for PASS');
    }
  }
  if (target === 'controller' && value.controller !== 'codex-controller') {
    errors.push('controller execution.controller must be codex-controller');
  }
  return target;
}

function validateProvenance(value: unknown, target: PhaseBGateTarget | null, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('provenance must be an object');
    return;
  }
  if (target === 'lowmem-8gb' || target === 'normal-16gb') {
    if (value.lane !== 'windows-cloud-pc') errors.push('machine provenance.lane must be windows-cloud-pc');
    if (value.workflow_repository !== 'MathiasHeinke/command-eve-windows-lab') {
      errors.push('machine provenance.workflow_repository must be the private Windows lab');
    }
    if (!isSha1(value.workflow_commit)) errors.push('machine provenance.workflow_commit must be a SHA-1');
    if (!isRunId(value.run_id)) errors.push('machine provenance.run_id must be a positive canonical integer string');
    if (!isPositiveInteger(value.run_attempt)) errors.push('machine provenance.run_attempt must be positive');
    if (!isNonEmptyString(value.job)) errors.push('machine provenance.job is required');
    validateNoSensitiveText('machine provenance.job', value.job, errors);
    if (!isNonEmptyString(value.runner_binding) || !/^[0-9a-f]{32}$/u.test(value.runner_binding)) {
      errors.push('machine provenance.runner_binding must be a lowercase 32-character binding');
    }
    if (
      !isNonEmptyString(value.runner_name) ||
      !/^command-eve-phase-b-(?:lowmem|normal)-[0-9a-f]{12}$/u.test(value.runner_name)
    ) {
      errors.push('machine provenance.runner_name is invalid');
    }
    if (!isSha256(value.machine_receipt_sha256)) errors.push('machine provenance.machine_receipt_sha256 is invalid');
    return;
  }
  if (target === 'cross-platform') {
    if (value.lane !== 'cross-platform-ci') errors.push('cross-platform provenance.lane must be cross-platform-ci');
    if (value.workflow_repository !== 'MathiasHeinke/AionUi') {
      errors.push('cross-platform provenance.workflow_repository must be MathiasHeinke/AionUi');
    }
    if (!isSha1(value.workflow_commit)) errors.push('cross-platform provenance.workflow_commit must be a SHA-1');
    if (!isRunId(value.run_id)) {
      errors.push('cross-platform provenance.run_id must be a positive canonical integer string');
    }
    if (!isPositiveInteger(value.run_attempt)) errors.push('cross-platform provenance.run_attempt must be positive');
    if (!isNonEmptyString(value.job)) errors.push('cross-platform provenance.job is required');
    validateNoSensitiveText('cross-platform provenance.job', value.job, errors);
    if (!isSha256(value.mac_receipt_sha256)) errors.push('cross-platform provenance.mac_receipt_sha256 is invalid');
    if (!isSha256(value.windows_receipt_sha256)) {
      errors.push('cross-platform provenance.windows_receipt_sha256 is invalid');
    }
    return;
  }
  if (target === 'controller') {
    if (value.lane !== 'controller-review') errors.push('controller provenance.lane must be controller-review');
    if (value.controller !== 'codex-controller')
      errors.push('controller provenance.controller must be codex-controller');
    if (value.source_tree_clean !== true) errors.push('controller provenance.source_tree_clean must be true');
    if (!isSha256(value.report_sha256)) errors.push('controller provenance.report_sha256 is invalid');
  }
}

function validateCommands(value: unknown, status: string | null, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('commands must be an array');
    return;
  }
  for (const [index, command] of value.entries()) {
    if (!isRecord(command) || !isNonEmptyString(command.id) || !Number.isInteger(command.exit_code)) {
      errors.push(`commands[${index}] is malformed`);
      continue;
    }
    validateNoSensitiveText(`commands[${index}].id`, command.id, errors);
    if (
      command.duration_ms !== undefined &&
      (!Number.isFinite(command.duration_ms) || Number(command.duration_ms) < 0)
    ) {
      errors.push(`commands[${index}].duration_ms must be non-negative`);
    }
  }
  if (status === 'PASS' && value.length === 0) errors.push('commands must not be empty for PASS');
  if (status === 'PASS' && value.some((command) => !isRecord(command) || command.exit_code !== 0)) {
    errors.push('every command must exit zero when receipt status is PASS');
  }
}

function assertionMap(value: unknown, errors: string[]): Map<string, 'PASS' | 'REJECT'> {
  const result = new Map<string, 'PASS' | 'REJECT'>();
  if (!Array.isArray(value)) {
    errors.push('assertions must be an array');
    return result;
  }
  for (const [index, assertion] of value.entries()) {
    if (
      !isRecord(assertion) ||
      !isNonEmptyString(assertion.id) ||
      (assertion.status !== 'PASS' && assertion.status !== 'REJECT') ||
      !isNonEmptyString(assertion.detail)
    ) {
      errors.push(`assertions[${index}] is malformed`);
      continue;
    }
    if (result.has(assertion.id)) errors.push(`assertions[${index}].id is duplicated`);
    validateNoSensitiveText(`assertions[${index}].id`, assertion.id, errors);
    validateNoSensitiveText(`assertions[${index}].detail`, assertion.detail, errors);
    result.set(assertion.id, assertion.status);
  }
  return result;
}

function derivedStatus(
  outcome: PhaseBGateOutcome,
  requiredIds: readonly string[],
  assertions: Map<string, 'PASS' | 'REJECT'>
): PhaseBGateStatus {
  if (outcome === 'blocked-auth') return 'BLOCKED_AUTH';
  if (outcome === 'blocked-artifact') return 'BLOCKED_ARTIFACT';
  if (outcome === 'blocked-environment') return 'BLOCKED_ENVIRONMENT';
  if (outcome === 'blocked-external-approval') return 'BLOCKED_EXTERNAL_APPROVAL';
  return requiredIds.every((id) => assertions.get(id) === 'PASS') ? 'PASS' : 'REJECT';
}

export function phaseBGateEvaluation(
  gateId: PhaseBGateId,
  outcome: PhaseBGateOutcome,
  assertions: PhaseBGateReceiptV1['assertions']
): Pick<PhaseBGateReceiptV1, 'evaluator_id' | 'status' | 'reject_code'> {
  const contract = PHASE_B_GATE_CONTRACTS[gateId];
  const map = new Map(assertions.map((assertion) => [assertion.id, assertion.status] as const));
  const status = derivedStatus(outcome, contract.required_assertion_ids, map);
  const codePrefix = gateId.replace('-', '_');
  const rejectCode =
    status === 'PASS' ? null : status === 'REJECT' ? `${codePrefix}_GATE_REJECT` : `${codePrefix}_${status}`;
  return { evaluator_id: contract.evaluator_id, status, reject_code: rejectCode };
}

function validateMetrics(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('metrics must be an object');
    return;
  }
  for (const [key, metric] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) errors.push(`metrics.${key} has an invalid key`);
    if (FORBIDDEN_METRIC_KEY.test(key)) errors.push(`metrics.${key} uses a forbidden sensitive-data key`);
    if (metric !== null && !['string', 'number', 'boolean'].includes(typeof metric)) {
      errors.push(`metrics.${key} must be scalar or null`);
    }
    if (typeof metric === 'string' && metric.length > 256) errors.push(`metrics.${key} exceeds 256 characters`);
    if (typeof metric === 'string') validateNoSensitiveText(`metrics.${key}`, metric, errors);
    if (typeof metric === 'number' && !Number.isFinite(metric)) errors.push(`metrics.${key} must be finite`);
  }
}

function validateRawObservationSurfaces(value: Record<string, unknown>, errors: string[]): void {
  const seen = new WeakSet<object>();
  let nodesVisited = 0;
  let nodeLimitReported = false;

  const visit = (label: string, node: unknown, depth: number): void => {
    nodesVisited += 1;
    if (nodesVisited > MAX_RAW_OBSERVATION_NODES) {
      if (!nodeLimitReported) errors.push('raw_evaluation.observations exceeds the bounded node count');
      nodeLimitReported = true;
      return;
    }
    if (typeof node === 'string') {
      if (node.length > MAX_RAW_OBSERVATION_STRING_CHARACTERS) {
        errors.push(`${label} exceeds ${MAX_RAW_OBSERVATION_STRING_CHARACTERS} characters`);
      }
      validateNoSensitiveText(label, node, errors);
      return;
    }
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) errors.push(`${label} must be finite`);
      return;
    }
    if (!Array.isArray(node) && !isRecord(node)) {
      errors.push(`${label} must contain only JSON-compatible observations`);
      return;
    }
    if (depth >= MAX_RAW_OBSERVATION_DEPTH) {
      errors.push(`${label} exceeds the bounded observation depth`);
      return;
    }
    if (seen.has(node)) {
      errors.push(`${label} must not contain cyclic or aliased objects`);
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      if (node.length > MAX_RAW_OBSERVATION_COLLECTION_ENTRIES) {
        errors.push(`${label} exceeds ${MAX_RAW_OBSERVATION_COLLECTION_ENTRIES} entries`);
      }
      for (const [index, item] of node.slice(0, MAX_RAW_OBSERVATION_COLLECTION_ENTRIES).entries()) {
        visit(`${label}[${index}]`, item, depth + 1);
      }
      return;
    }

    const entries = Object.entries(node);
    if (entries.length > MAX_RAW_OBSERVATION_COLLECTION_ENTRIES) {
      errors.push(`${label} exceeds ${MAX_RAW_OBSERVATION_COLLECTION_ENTRIES} entries`);
    }
    for (const [key, item] of entries.slice(0, MAX_RAW_OBSERVATION_COLLECTION_ENTRIES)) {
      const itemLabel = `${label}.${key}`;
      if (!RAW_OBSERVATION_KEY.test(key)) errors.push(`${itemLabel} has an invalid key`);
      if (FORBIDDEN_METRIC_KEY.test(key) && !(depth === 0 && RAW_OBSERVATION_SENSITIVE_KEY_ALLOWLIST.has(key))) {
        errors.push(`${itemLabel} uses a forbidden sensitive-data key`);
      }
      validateNoSensitiveText(`${itemLabel} key`, key, errors);
      visit(itemLabel, item, depth + 1);
    }
  };

  visit('raw_evaluation.observations', value, 0);
}

function validateEvidence(
  value: unknown,
  status: string | null,
  contract: PhaseBGateContract | null,
  errors: string[]
): void {
  if (!Array.isArray(value)) {
    errors.push('evidence must be an array');
    return;
  }
  const paths = new Set<string>();
  const kinds = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`evidence[${index}] is malformed`);
      continue;
    }
    if (!isEvidenceRelativePath(item.path)) errors.push(`evidence[${index}].path must be evidence-root-relative`);
    validateNoSensitiveText(`evidence[${index}].path`, item.path, errors);
    if (!isSha256(item.sha256)) errors.push(`evidence[${index}].sha256 must be a lowercase SHA-256`);
    if (!isPositiveInteger(item.size_bytes)) errors.push(`evidence[${index}].size_bytes must be positive`);
    if (typeof item.kind !== 'string' || !EVIDENCE_KINDS.has(item.kind)) {
      errors.push(`evidence[${index}].kind is not recognized`);
    } else {
      kinds.add(item.kind);
    }
    if (typeof item.path === 'string' && paths.has(item.path)) errors.push(`evidence[${index}].path is duplicated`);
    if (typeof item.path === 'string') paths.add(item.path);
  }
  if (status === 'PASS' && contract) {
    for (const kind of contract.required_evidence_kinds) {
      if (!kinds.has(kind)) errors.push(`PASS evidence is missing required kind ${kind}`);
    }
  }
}

function validateProvenanceEvidenceBinding(
  provenance: unknown,
  target: PhaseBGateTarget | null,
  status: string | null,
  evidence: unknown,
  errors: string[]
): void {
  if (status !== 'PASS' || !isRecord(provenance) || !Array.isArray(evidence)) return;
  const entries = evidence.filter(isRecord);
  const matchingPaths = (sha256: unknown, kind: PhaseBEvidenceKind): string[] =>
    typeof sha256 === 'string'
      ? entries
          .filter((item) => item.sha256 === sha256 && item.kind === kind && typeof item.path === 'string')
          .map((item) => item.path as string)
      : [];

  if (target === 'lowmem-8gb' || target === 'normal-16gb') {
    if (matchingPaths(provenance.machine_receipt_sha256, 'json').length === 0) {
      errors.push('machine provenance receipt SHA-256 must bind a JSON evidence file');
    }
    return;
  }
  if (target === 'cross-platform') {
    const macPaths = matchingPaths(provenance.mac_receipt_sha256, 'json');
    const windowsPaths = matchingPaths(provenance.windows_receipt_sha256, 'json');
    if (macPaths.length === 0) errors.push('cross-platform mac receipt SHA-256 must bind a JSON evidence file');
    if (windowsPaths.length === 0) errors.push('cross-platform windows receipt SHA-256 must bind a JSON evidence file');
    if (macPaths.some((item) => windowsPaths.includes(item))) {
      errors.push('cross-platform mac and Windows provenance must bind distinct evidence files');
    }
    return;
  }
  if (target === 'controller' && matchingPaths(provenance.report_sha256, 'report').length === 0) {
    errors.push('controller provenance report SHA-256 must bind a report evidence file');
  }
}

export function validatePhaseBGateReceipt(input: unknown): PhaseBGateValidation {
  if (!isRecord(input)) return { ok: false, errors: ['receipt must be an object'] };
  const errors: string[] = [];
  if (input.schema_version !== PHASE_B_GATE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${PHASE_B_GATE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(input.candidate_id)) errors.push('candidate_id is required');
  if (!isSha256(input.candidate_manifest_sha256)) errors.push('candidate_manifest_sha256 must be a SHA-256');
  const gateId =
    typeof input.gate_id === 'string' && GATE_IDS.has(input.gate_id) ? (input.gate_id as PhaseBGateId) : null;
  if (!gateId) errors.push('gate_id is not recognized');
  const contract = gateId ? PHASE_B_GATE_CONTRACTS[gateId] : null;
  if (contract && input.evaluator_id !== contract.evaluator_id) {
    errors.push(`evaluator_id must be ${contract.evaluator_id}`);
  }
  const status = typeof input.status === 'string' && STATUSES.has(input.status) ? input.status : null;
  if (!status) errors.push('status is not recognized');
  const outcome =
    typeof input.evaluation_outcome === 'string' && OUTCOMES.has(input.evaluation_outcome)
      ? (input.evaluation_outcome as PhaseBGateOutcome)
      : null;
  if (!outcome) errors.push('evaluation_outcome is not recognized');
  const assertions = assertionMap(input.assertions, errors);
  if (gateId && contract && outcome && status) {
    const expectedStatus = derivedStatus(outcome, contract.required_assertion_ids, assertions);
    if (status !== expectedStatus) errors.push(`status must be computed as ${expectedStatus}`);
    const expectedCode = phaseBGateEvaluation(
      gateId,
      outcome,
      Array.isArray(input.assertions) ? (input.assertions as PhaseBGateReceiptV1['assertions']) : []
    ).reject_code;
    if (input.reject_code !== expectedCode) errors.push(`reject_code must be ${expectedCode ?? 'null'}`);
    if (status === 'PASS') {
      for (const id of contract.required_assertion_ids) {
        if (assertions.get(id) !== 'PASS') errors.push(`required assertion ${id} must PASS`);
      }
    }
  }
  const source = isRecord(input.source) ? input.source : null;
  if (!source) errors.push('source must be an object');
  if (!isNonEmptyString(source?.repository)) errors.push('source.repository is required');
  validateNoSensitiveText('source.repository', source?.repository, errors);
  if (!isSha1(source?.commit)) errors.push('source.commit must be a lowercase 40-character SHA-1');
  if (typeof source?.tree_clean !== 'boolean') errors.push('source.tree_clean must be boolean');
  if (status === 'PASS' && source?.tree_clean !== true) errors.push('source.tree_clean must be true for PASS');
  const artifact = isRecord(input.artifact) ? input.artifact : null;
  if (!artifact) errors.push('artifact must be an object');
  if (!isNonEmptyString(artifact?.name)) errors.push('artifact.name is required');
  validateNoSensitiveText('artifact.name', artifact?.name, errors);
  if (!isSha256(artifact?.sha256)) errors.push('artifact.sha256 must be a lowercase SHA-256');
  if (!isPositiveInteger(artifact?.size_bytes)) errors.push('artifact.size_bytes must be positive');
  const target = validateExecution(input.execution, status, errors);
  if (
    gateId &&
    target &&
    !PHASE_B_REQUIRED_RECEIPTS.some((item) => item.gate_id === gateId && item.target === target)
  ) {
    errors.push(`${receiptKey(gateId, target)} is not part of the required Phase B matrix`);
  }
  validateProvenance(input.provenance, target, errors);
  if (
    target === 'cross-platform' &&
    isRecord(input.provenance) &&
    isRecord(input.source) &&
    input.provenance.workflow_commit !== input.source.commit
  ) {
    errors.push('cross-platform provenance.workflow_commit must equal source.commit');
  }
  validateCommands(input.commands, status, errors);
  validateMetrics(input.metrics, errors);
  validateEvidence(input.evidence, status, contract, errors);
  validateProvenanceEvidenceBinding(input.provenance, target, status, input.evidence, errors);
  const rawEvaluation = isRecord(input.raw_evaluation) ? input.raw_evaluation : null;
  if (!rawEvaluation) {
    errors.push('raw_evaluation must be an object');
  } else {
    if (rawEvaluation.schema_version !== 'command-eve-windows-phase-b-raw-evaluation/v1') {
      errors.push('raw_evaluation.schema_version is not recognized');
    }
    if (!isRecord(rawEvaluation.observations)) {
      errors.push('raw_evaluation.observations must be an object');
    } else {
      validateRawObservationSurfaces(rawEvaluation.observations, errors);
    }
    if (rawEvaluation.completion_sentinel !== 'WIN_PHASE_B_RAW_EVALUATION_COMPLETE') {
      errors.push('raw_evaluation completion sentinel is missing');
    }
  }
  if (!isIsoTimestamp(input.started_at)) errors.push('started_at must be an ISO-8601 timestamp');
  if (!isIsoTimestamp(input.completed_at)) errors.push('completed_at must be an ISO-8601 timestamp');
  if (
    isIsoTimestamp(input.started_at) &&
    isIsoTimestamp(input.completed_at) &&
    Date.parse(input.completed_at) < Date.parse(input.started_at)
  ) {
    errors.push('completed_at must not precede started_at');
  }
  if (!isNonEmptyString(input.worker)) errors.push('worker is required');
  if (!isNonEmptyString(input.reviewer)) errors.push('reviewer is required');
  validateNoSensitiveText('worker', input.worker, errors);
  validateNoSensitiveText('reviewer', input.reviewer, errors);
  if (input.completion_sentinel !== 'WIN_PHASE_B_GATE_COMPLETE') {
    errors.push('completion_sentinel must be WIN_PHASE_B_GATE_COMPLETE');
  }
  if (rawEvaluation) errors.push(...validatePhaseBGateReceiptRawDerivation(input));
  return { ok: errors.length === 0, errors };
}

export function evaluatePhaseBCandidateConvergence(
  receipts: readonly unknown[],
  options: PhaseBCandidateConvergenceOptions
): PhaseBCandidateConvergence {
  const errors: string[] = [];
  const manifestValidation = validatePhaseBCandidateManifest(options.candidate_manifest);
  for (const error of manifestValidation.errors) errors.push(`candidate manifest: ${error}`);
  if (!isSha256(options.candidate_manifest_sha256)) errors.push('candidate manifest SHA-256 is invalid');
  const byKey = new Map<string, Record<string, unknown>>();
  for (const [index, receipt] of receipts.entries()) {
    const validation = validatePhaseBGateReceipt(receipt);
    if (!isRecord(receipt)) {
      for (const error of validation.errors) errors.push(`receipt[${index}]: ${error}`);
      continue;
    }
    const target =
      isRecord(receipt.execution) && typeof receipt.execution.target === 'string'
        ? receipt.execution.target
        : 'unknown';
    const key = receiptKey(String(receipt.gate_id), target);
    if (byKey.has(key)) {
      errors.push(`duplicate receipt for ${key}`);
      continue;
    }
    byKey.set(key, receipt);
    for (const error of validation.errors) errors.push(`${key}: ${error}`);
    if (receipt.status !== 'PASS') errors.push(`${key} did not PASS`);
    if (receipt.candidate_id !== options.candidate_manifest.candidate_id) {
      errors.push(`${key} references an unexpected candidate ID`);
    }
    if (receipt.candidate_manifest_sha256 !== options.candidate_manifest_sha256) {
      errors.push(`${key} references an unexpected candidate manifest SHA-256`);
    }
    const source = isRecord(receipt.source) ? receipt.source : null;
    const artifact = isRecord(receipt.artifact) ? receipt.artifact : null;
    if (source?.repository !== options.candidate_manifest.source.repository) {
      errors.push(`${key} references an unexpected source repository`);
    }
    if (source?.commit !== options.candidate_manifest.source.commit) {
      errors.push(`${key} references an unexpected source commit`);
    }
    if (artifact?.name !== options.candidate_manifest.artifact.name) {
      errors.push(`${key} references an unexpected artifact name`);
    }
    if (artifact?.sha256 !== options.candidate_manifest.artifact.sha256) {
      errors.push(`${key} references an unexpected artifact SHA-256`);
    }
    if (artifact?.size_bytes !== options.candidate_manifest.artifact.size_bytes) {
      errors.push(`${key} references an unexpected artifact size`);
    }
    if (Array.isArray(receipt.evidence)) {
      for (const item of receipt.evidence) {
        if (!isRecord(item) || typeof item.path !== 'string') continue;
        const fileTruth = options.evidence_files[item.path];
        if (!fileTruth) {
          errors.push(`${key} evidence is missing from the verified bundle: ${item.path}`);
          continue;
        }
        if (fileTruth.sha256 !== item.sha256) errors.push(`${key} evidence SHA-256 mismatch: ${item.path}`);
        if (fileTruth.size_bytes !== item.size_bytes) errors.push(`${key} evidence size mismatch: ${item.path}`);
      }
    }
  }

  const requiredKeys = PHASE_B_REQUIRED_RECEIPTS.map((item) => receiptKey(item.gate_id, item.target));
  const missingReceipts = requiredKeys.filter((key) => !byKey.has(key));
  const unexpectedReceipts = [...byKey.keys()].filter((key) => !requiredKeys.includes(key));
  for (const key of unexpectedReceipts) errors.push(`unexpected receipt ${key}`);

  const ok = errors.length === 0 && missingReceipts.length === 0 && byKey.size === requiredKeys.length;
  return {
    schema_version: 'command-eve-windows-phase-b-candidate-convergence/v1',
    status: ok ? 'PASS' : 'REJECT',
    reject_code: ok ? null : 'WIN_PHASE_B_INTERNAL_PRESENTATION_REJECT',
    candidate_id: options.candidate_manifest.candidate_id,
    repository: options.candidate_manifest.source.repository,
    source_commit: options.candidate_manifest.source.commit,
    artifact_sha256: options.candidate_manifest.artifact.sha256,
    artifact_name: options.candidate_manifest.artifact.name,
    required_receipt_count: requiredKeys.length,
    accepted_receipt_count: byKey.size,
    missing_receipts: missingReceipts,
    errors,
    completion_sentinel: 'WIN_PHASE_B_INTERNAL_PRESENTATION_CONVERGENCE_COMPLETE',
  };
}
