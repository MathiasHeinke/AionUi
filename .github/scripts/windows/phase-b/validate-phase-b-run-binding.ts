/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_CONTROL_REPOSITORY = 'MathiasHeinke/command-eve-windows-lab';
const EXPECTED_SOURCE_REPOSITORY = 'MathiasHeinke/AionUi';
const WORKFLOW_FILE = 'windows-phase-b-lab.yml';

type BindingRejectCode =
  | 'WIN_B_BINDING_ISSUANCE_INVALID'
  | 'WIN_B_BINDING_DISPATCH_INVALID'
  | 'WIN_B_BINDING_RUNNER_RECEIPT_INVALID'
  | 'WIN_B_BINDING_CONTROL_REPOSITORY_MISMATCH'
  | 'WIN_B_BINDING_SOURCE_REPOSITORY_MISMATCH'
  | 'WIN_B_BINDING_WORKFLOW_COMMIT_MISMATCH'
  | 'WIN_B_BINDING_WORKFLOW_BLOB_MISMATCH'
  | 'WIN_B_BINDING_SOURCE_REF_MISMATCH'
  | 'WIN_B_BINDING_SOURCE_COMMIT_MISMATCH'
  | 'WIN_B_BINDING_MEMORY_CLASS_MISMATCH'
  | 'WIN_B_BINDING_RUNNER_BINDING_MISMATCH'
  | 'WIN_B_BINDING_RUNNER_NAME_MISMATCH'
  | 'WIN_B_BINDING_RUNNER_ID_MISMATCH'
  | 'WIN_B_BINDING_JIT_CONFIG_HASH_MISMATCH'
  | 'WIN_B_BINDING_JIT_CONFIG_BYTES_MISMATCH'
  | 'WIN_B_BINDING_RUN_ID_MISMATCH'
  | 'WIN_B_BINDING_RUN_ATTEMPT_MISMATCH'
  | 'WIN_B_BINDING_RUN_REF_MISMATCH'
  | 'WIN_B_BINDING_WORKFLOW_REF_MISMATCH';

type BindingAssertion = {
  id: string;
  status: 'PASS' | 'REJECT';
  detail: string;
};

type BindingOptions = {
  issuancePath: string;
  dispatchPath: string;
  runnerPolicyReceiptPath: string;
  outputPath: string;
};

type BindingReceipt = {
  schema_version: 'command-eve-windows-phase-b-jit-run-binding/v1';
  status: 'PASS' | 'REJECT';
  reject_codes: BindingRejectCode[];
  assertions: BindingAssertion[];
  control_repository: string | null;
  workflow_commit: string | null;
  workflow_template_blob: string | null;
  source_repository: string | null;
  source_ref: string | null;
  source_commit: string | null;
  memory_class: string | null;
  runner_binding: string | null;
  runner_name: string | null;
  runner_id: number | null;
  jit_config_sha256: string | null;
  jit_config_bytes: number | null;
  run_id: string | null;
  run_attempt: number | null;
  run_ref: string | null;
  workflow_ref: string | null;
  completion_sentinel: 'WIN_PHASE_B_JIT_RUN_BINDING_COMPLETE';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function numberValue(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function isPinnedCommit(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{40}$/.test(value);
}

function isSourceRef(value: string | null): value is string {
  return (
    value !== null &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('-') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('..') &&
    !value.includes('//')
  );
}

function isRunnerBinding(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{32}$/.test(value);
}

function isRunnerName(value: string | null): value is string {
  return value !== null && /^command-eve-phase-b-(?:lowmem|normal)-[0-9a-f]{12}$/.test(value);
}

function isRunId(value: string | null): value is string {
  return value !== null && /^[1-9][0-9]*$/.test(value);
}

function isRunnerId(value: number | null): value is number {
  return value !== null && value > 0;
}

function isSha256(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{64}$/.test(value);
}

function isJitConfigByteCount(value: number | null): value is number {
  return value !== null && value >= 80;
}

function isCompletedPassRunnerReceipt(record: Record<string, unknown> | null): boolean {
  const rejectCodes = record?.reject_codes;
  const assertions = record?.assertions;
  return (
    record?.schema_version === 'command-eve-windows-phase-b-runner-policy-result/v2' &&
    record.status === 'PASS' &&
    record.completion_sentinel === 'WIN_PHASE_B_RUNNER_POLICY_COMPLETE' &&
    Array.isArray(rejectCodes) &&
    rejectCodes.length === 0 &&
    Array.isArray(assertions) &&
    assertions.length > 0 &&
    assertions.every((assertion) => isRecord(assertion) && assertion.status === 'PASS')
  );
}

function readJson(filePath: string): Record<string, unknown> | null {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as unknown;
  return isRecord(parsed) ? parsed : null;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, absolute);
}

function parseArguments(argv: string[]): BindingOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error('Arguments must use --name value pairs.');
    values.set(name, value);
  }
  const issuancePath = values.get('--issuance');
  const dispatchPath = values.get('--dispatch');
  const runnerPolicyReceiptPath = values.get('--runner-policy-receipt');
  const outputPath = values.get('--output');
  if (!issuancePath || !dispatchPath || !runnerPolicyReceiptPath || !outputPath) {
    throw new Error('Missing Phase B run-binding validation argument.');
  }
  return { issuancePath, dispatchPath, runnerPolicyReceiptPath, outputPath };
}

export function validatePhaseBRunBinding(options: BindingOptions): { ok: boolean; receipt: BindingReceipt } {
  const issuance = readJson(options.issuancePath);
  const dispatch = readJson(options.dispatchPath);
  const runner = readJson(options.runnerPolicyReceiptPath);
  const issuanceControl = isRecord(issuance?.control_repository) ? issuance.control_repository : null;
  const issuanceSource = isRecord(issuance?.source_repository) ? issuance.source_repository : null;
  const rejectCodes: BindingRejectCode[] = [];
  const assertions: BindingAssertion[] = [];
  const addAssertion = (
    id: string,
    ok: boolean,
    rejectCode: BindingRejectCode,
    passDetail: string,
    rejectDetail: string
  ): void => {
    assertions.push({ id, status: ok ? 'PASS' : 'REJECT', detail: ok ? passDetail : rejectDetail });
    if (!ok) rejectCodes.push(rejectCode);
  };

  addAssertion(
    'valid-jit-issuance',
    issuance?.schema_version === 'command-eve-windows-phase-b-jit-issuance/v2' &&
      issuance.status === 'PASS' &&
      issuance.completion_sentinel === 'WIN_PHASE_B_JIT_ISSUANCE_COMPLETE',
    'WIN_B_BINDING_ISSUANCE_INVALID',
    'JIT issuance is a completed PASS receipt.',
    'JIT issuance schema, status, or completion sentinel is invalid.'
  );
  addAssertion(
    'valid-private-dispatch',
    dispatch?.schema_version === 'command-eve-windows-phase-b-dispatch/v1' &&
      dispatch.status === 'PASS' &&
      dispatch.completion_sentinel === 'WIN_PHASE_B_PRIVATE_DISPATCH_COMPLETE',
    'WIN_B_BINDING_DISPATCH_INVALID',
    'Private workflow dispatch is a completed PASS receipt.',
    'Private workflow dispatch schema, status, or completion sentinel is invalid.'
  );
  addAssertion(
    'valid-runner-policy-receipt',
    isCompletedPassRunnerReceipt(runner),
    'WIN_B_BINDING_RUNNER_RECEIPT_INVALID',
    'Runner policy is a completed PASS receipt.',
    'Runner policy schema, status, or completion sentinel is invalid.'
  );

  const controlRepository = stringValue(issuanceControl, 'full_name');
  addAssertion(
    'same-private-control-repository',
    controlRepository === EXPECTED_CONTROL_REPOSITORY &&
      issuanceControl?.visibility === 'private' &&
      stringValue(dispatch, 'control_repository') === controlRepository &&
      stringValue(runner, 'control_repository') === controlRepository,
    'WIN_B_BINDING_CONTROL_REPOSITORY_MISMATCH',
    'Issuance, dispatch, and runner bind the same exact private control repository.',
    'Control repository provenance differs across Phase B receipts.'
  );

  const sourceRepository = stringValue(issuanceSource, 'full_name');
  addAssertion(
    'same-public-source-repository',
    sourceRepository === EXPECTED_SOURCE_REPOSITORY &&
      issuanceSource?.visibility === 'public' &&
      stringValue(dispatch, 'source_repository') === sourceRepository &&
      stringValue(runner, 'source_repository') === sourceRepository,
    'WIN_B_BINDING_SOURCE_REPOSITORY_MISMATCH',
    'Issuance, dispatch, and runner bind the same exact public source repository.',
    'Source repository provenance differs across Phase B receipts.'
  );

  const workflowCommit = stringValue(issuance, 'workflow_commit');
  addAssertion(
    'same-workflow-commit',
    isPinnedCommit(workflowCommit) &&
      stringValue(dispatch, 'workflow_commit') === workflowCommit &&
      stringValue(runner, 'workflow_commit') === workflowCommit,
    'WIN_B_BINDING_WORKFLOW_COMMIT_MISMATCH',
    'Issuance, dispatch, and runner bind the same exact private workflow commit.',
    'Private workflow commit provenance differs across Phase B receipts.'
  );

  const workflowTemplateBlob = stringValue(issuance, 'workflow_template_blob');
  addAssertion(
    'same-workflow-template-blob',
    isPinnedCommit(workflowTemplateBlob) && stringValue(dispatch, 'workflow_template_blob') === workflowTemplateBlob,
    'WIN_B_BINDING_WORKFLOW_BLOB_MISMATCH',
    'Issuance and dispatch bind the same public-source/private-control workflow blob.',
    'Workflow template blob provenance differs between issuance and dispatch.'
  );

  const sourceRef = stringValue(issuance, 'source_ref');
  addAssertion(
    'same-source-ref',
    isSourceRef(sourceRef) &&
      stringValue(dispatch, 'source_ref') === sourceRef &&
      stringValue(runner, 'source_ref') === sourceRef,
    'WIN_B_BINDING_SOURCE_REF_MISMATCH',
    'Issuance, dispatch, and runner bind the same public source branch.',
    'Public source branch provenance differs across Phase B receipts.'
  );

  const sourceCommit = stringValue(issuance, 'source_commit');
  addAssertion(
    'same-source-commit',
    isPinnedCommit(sourceCommit) &&
      stringValue(dispatch, 'source_commit') === sourceCommit &&
      stringValue(runner, 'source_commit') === sourceCommit,
    'WIN_B_BINDING_SOURCE_COMMIT_MISMATCH',
    'Issuance, dispatch, and runner bind the same exact public source commit.',
    'Public source commit provenance differs across Phase B receipts.'
  );

  const memoryClass = stringValue(issuance, 'memory_class');
  addAssertion(
    'same-memory-class',
    (memoryClass === 'lowmem-8gb' || memoryClass === 'normal-16gb') &&
      stringValue(dispatch, 'memory_class') === memoryClass &&
      stringValue(runner, 'memory_class') === memoryClass,
    'WIN_B_BINDING_MEMORY_CLASS_MISMATCH',
    'Issuance, dispatch, and runner bind the same memory class.',
    'Memory class differs across Phase B receipts.'
  );

  const runnerBinding = stringValue(issuance, 'runner_binding');
  addAssertion(
    'same-runner-binding',
    isRunnerBinding(runnerBinding) &&
      stringValue(dispatch, 'runner_binding') === runnerBinding &&
      stringValue(runner, 'runner_binding') === runnerBinding,
    'WIN_B_BINDING_RUNNER_BINDING_MISMATCH',
    'Issuance, dispatch, and runner bind the same random one-run value.',
    'One-run runner binding differs across Phase B receipts.'
  );

  const runnerName = stringValue(issuance, 'runner_name');
  const memoryName = memoryClass === 'lowmem-8gb' ? 'lowmem' : memoryClass === 'normal-16gb' ? 'normal' : '';
  const expectedRunnerName =
    memoryName !== '' && isRunnerBinding(runnerBinding)
      ? `command-eve-phase-b-${memoryName}-${runnerBinding.slice(0, 12)}`
      : '';
  addAssertion(
    'same-runner-name',
    isRunnerName(runnerName) &&
      runnerName === expectedRunnerName &&
      stringValue(dispatch, 'runner_name') === runnerName &&
      stringValue(runner, 'runner_name') === runnerName,
    'WIN_B_BINDING_RUNNER_NAME_MISMATCH',
    'Issuance, dispatch, and runner bind the same exact JIT runner name.',
    'JIT runner name differs across Phase B receipts.'
  );

  const runnerId = numberValue(issuance, 'runner_id');
  addAssertion(
    'same-runner-id',
    isRunnerId(runnerId) && numberValue(dispatch, 'runner_id') === runnerId,
    'WIN_B_BINDING_RUNNER_ID_MISMATCH',
    'JIT issuance and private dispatch bind the same GitHub runner ID.',
    'GitHub runner ID differs between JIT issuance and private dispatch.'
  );

  const jitConfigSha256 = stringValue(issuance, 'jit_config_sha256');
  addAssertion(
    'same-jit-config-hash',
    isSha256(jitConfigSha256) && stringValue(dispatch, 'jit_config_sha256') === jitConfigSha256,
    'WIN_B_BINDING_JIT_CONFIG_HASH_MISMATCH',
    'JIT issuance and private dispatch bind the same one-use credential hash.',
    'One-use JIT credential hash differs between issuance and dispatch.'
  );

  const jitConfigBytes = numberValue(issuance, 'jit_config_bytes');
  addAssertion(
    'same-jit-config-bytes',
    isJitConfigByteCount(jitConfigBytes) && numberValue(dispatch, 'jit_config_bytes') === jitConfigBytes,
    'WIN_B_BINDING_JIT_CONFIG_BYTES_MISMATCH',
    'JIT issuance and private dispatch bind the same one-use credential byte count.',
    'One-use JIT credential byte count differs between issuance and dispatch.'
  );

  const runId = stringValue(dispatch, 'run_id');
  addAssertion(
    'same-run-id',
    isRunId(runId) && stringValue(runner, 'run_id') === runId,
    'WIN_B_BINDING_RUN_ID_MISMATCH',
    'Controller dispatch and Windows runner bind the same GitHub run ID.',
    'GitHub run ID differs between controller dispatch and Windows runner.'
  );

  const runAttempt = numberValue(dispatch, 'run_attempt');
  addAssertion(
    'same-run-attempt',
    runAttempt !== null && runAttempt > 0 && numberValue(runner, 'run_attempt') === runAttempt,
    'WIN_B_BINDING_RUN_ATTEMPT_MISMATCH',
    'Controller dispatch and Windows runner bind the same GitHub run attempt.',
    'GitHub run attempt differs between controller dispatch and Windows runner.'
  );

  const expectedRunRef = isRunnerBinding(runnerBinding) ? `refs/tags/command-eve-phase-b-${runnerBinding}` : '';
  const runRef = stringValue(dispatch, 'run_ref');
  addAssertion(
    'same-run-ref',
    runRef === expectedRunRef && stringValue(runner, 'run_ref') === runRef,
    'WIN_B_BINDING_RUN_REF_MISMATCH',
    'Controller dispatch and Windows runner bind the same unique workflow tag.',
    'Workflow tag differs between controller dispatch and Windows runner.'
  );

  const expectedWorkflowRef = `${EXPECTED_CONTROL_REPOSITORY}/.github/workflows/${WORKFLOW_FILE}@${expectedRunRef}`;
  const workflowRef = stringValue(dispatch, 'workflow_ref');
  addAssertion(
    'same-workflow-ref',
    workflowRef === expectedWorkflowRef && stringValue(runner, 'workflow_ref') === workflowRef,
    'WIN_B_BINDING_WORKFLOW_REF_MISMATCH',
    'Controller dispatch and Windows runner bind the same exact private workflow reference.',
    'Private workflow reference differs between controller dispatch and Windows runner.'
  );

  const uniqueRejectCodes = [...new Set(rejectCodes)];
  const receipt: BindingReceipt = {
    schema_version: 'command-eve-windows-phase-b-jit-run-binding/v1',
    status: uniqueRejectCodes.length === 0 ? 'PASS' : 'REJECT',
    reject_codes: uniqueRejectCodes,
    assertions,
    control_repository: controlRepository,
    workflow_commit: workflowCommit,
    workflow_template_blob: workflowTemplateBlob,
    source_repository: sourceRepository,
    source_ref: sourceRef,
    source_commit: sourceCommit,
    memory_class: memoryClass,
    runner_binding: runnerBinding,
    runner_name: runnerName,
    runner_id: runnerId,
    jit_config_sha256: jitConfigSha256,
    jit_config_bytes: jitConfigBytes,
    run_id: runId,
    run_attempt: runAttempt,
    run_ref: runRef,
    workflow_ref: workflowRef,
    completion_sentinel: 'WIN_PHASE_B_JIT_RUN_BINDING_COMPLETE',
  };
  writeJsonAtomically(options.outputPath, receipt);
  return { ok: receipt.status === 'PASS', receipt };
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const outcome = validatePhaseBRunBinding(options);
    process.stdout.write(
      `WIN_PHASE_B_JIT_RUN_BINDING_COMPLETE status=${outcome.receipt.status} output=${path.resolve(options.outputPath)}\n`
    );
    if (!outcome.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`WIN_PHASE_B_JIT_RUN_BINDING_ERROR ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  }
}
