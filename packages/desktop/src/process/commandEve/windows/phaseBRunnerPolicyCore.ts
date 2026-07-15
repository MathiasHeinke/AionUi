/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsGateAssertionReceipt } from './types';
import type { PhaseBMemoryClass } from './phaseBMachineReceiptCore';

export const PHASE_B_RUNNER_POLICY_SCHEMA_VERSION = 'command-eve-windows-phase-b-runner-policy/v2' as const;

export type PhaseBRunnerPolicyEvidenceV2 = {
  schema_version: typeof PHASE_B_RUNNER_POLICY_SCHEMA_VERSION;
  repository: {
    full_name: string;
    visibility: 'private' | 'public' | 'unknown';
  };
  dispatch: {
    event_name: string;
    source_repository: string;
    source_ref: string;
    source_commit: string;
    workflow_commit: string;
    runner_binding: string;
    expected_runner_name: string;
    actual_runner_name: string;
    run_id: string;
    run_attempt: number;
    ref: string;
    ref_type: string;
    workflow_ref: string;
    pull_request_from_fork: boolean;
    permissions: Record<string, 'none' | 'read' | 'write'>;
  };
  runner: {
    mode: 'jit' | 'ephemeral' | 'persistent' | 'unknown';
    max_jobs: number;
    labels: string[];
    work_folder: string;
    preexisting_credential_file_count: number;
    controller_token_present: boolean;
    production_secrets_available: boolean;
    root_is_disposable: boolean;
    diagnostics_externalized: boolean;
    credential_delivery: 'encoded_jit_config_once' | 'registration_token_once' | 'persistent_registration_token';
  };
};

export type PhaseBRunnerRejectCode =
  | 'WIN_B_RUNNER_POLICY_SCHEMA_INVALID'
  | 'WIN_B_REPOSITORY_NOT_PRIVATE'
  | 'WIN_B_CONTROL_REPOSITORY_MISMATCH'
  | 'WIN_B_SOURCE_REPOSITORY_MISMATCH'
  | 'WIN_B_SOURCE_REF_INVALID'
  | 'WIN_B_SOURCE_COMMIT_NOT_PINNED'
  | 'WIN_B_SOURCE_COMMIT_MISMATCH'
  | 'WIN_B_WORKFLOW_COMMIT_NOT_PINNED'
  | 'WIN_B_WORKFLOW_COMMIT_MISMATCH'
  | 'WIN_B_RUNNER_BINDING_INVALID'
  | 'WIN_B_RUNNER_NAME_MISMATCH'
  | 'WIN_B_RUN_ID_INVALID'
  | 'WIN_B_RUN_ATTEMPT_INVALID'
  | 'WIN_B_RUN_REF_MISMATCH'
  | 'WIN_B_WORKFLOW_REF_MISMATCH'
  | 'WIN_B_WORKFLOW_NOT_MANUAL'
  | 'WIN_B_FORK_CONTEXT_FORBIDDEN'
  | 'WIN_B_WORKFLOW_PERMISSIONS_TOO_BROAD'
  | 'WIN_B_RUNNER_NOT_JIT'
  | 'WIN_B_RUNNER_NOT_SINGLE_JOB'
  | 'WIN_B_RUNNER_LABELS_INVALID'
  | 'WIN_B_RUNNER_WORK_FOLDER_INVALID'
  | 'WIN_B_RUNNER_CREDENTIAL_RESIDUE'
  | 'WIN_B_CONTROLLER_TOKEN_EXPOSED'
  | 'WIN_B_PRODUCTION_SECRETS_EXPOSED'
  | 'WIN_B_RUNNER_ROOT_NOT_DISPOSABLE'
  | 'WIN_B_RUNNER_DIAGNOSTICS_NOT_EXTERNALIZED'
  | 'WIN_B_JIT_DELIVERY_INVALID';

export type PhaseBRunnerPolicyResult = {
  schema_version: 'command-eve-windows-phase-b-runner-policy-result/v2';
  status: 'PASS' | 'REJECT';
  reject_code: 'WIN_PHASE_B_RUNNER_POLICY_REJECT' | null;
  reject_codes: PhaseBRunnerRejectCode[];
  assertions: WindowsGateAssertionReceipt[];
  control_repository: string | null;
  source_repository: string | null;
  source_ref: string | null;
  source_commit: string | null;
  workflow_commit: string | null;
  memory_class: PhaseBMemoryClass;
  runner_binding: string | null;
  runner_name: string | null;
  run_id: string | null;
  run_attempt: number | null;
  run_ref: string | null;
  workflow_ref: string | null;
  completion_sentinel: 'WIN_PHASE_B_RUNNER_POLICY_COMPLETE';
};

export type PhaseBRunnerPolicyExpectation = {
  expected_control_repository: string;
  expected_source_repository: string;
  expected_source_ref: string;
  expected_source_commit: string;
  expected_workflow_commit: string;
  expected_runner_binding: string;
  expected_runner_name: string;
  memory_class: PhaseBMemoryClass;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPinnedCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isRepositoryFullName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isSourceRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('-') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('..') &&
    !value.includes('//')
  );
}

function isRunnerBinding(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

function isRunnerName(value: unknown): value is string {
  return typeof value === 'string' && /^command-eve-phase-b-(?:lowmem|normal)-[0-9a-f]{12}$/.test(value);
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function isRunAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeWorkFolder(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalized = value.replaceAll('\\', '/');
  return normalized === '_work' && !normalized.startsWith('/') && !normalized.split('/').includes('..');
}

function result(
  rejectCodes: PhaseBRunnerRejectCode[],
  assertions: WindowsGateAssertionReceipt[],
  repository: Record<string, unknown> | null,
  dispatch: Record<string, unknown> | null,
  expectation: PhaseBRunnerPolicyExpectation
): PhaseBRunnerPolicyResult {
  const uniqueRejectCodes = [...new Set(rejectCodes)];
  return {
    schema_version: 'command-eve-windows-phase-b-runner-policy-result/v2',
    status: uniqueRejectCodes.length === 0 ? 'PASS' : 'REJECT',
    reject_code: uniqueRejectCodes.length === 0 ? null : 'WIN_PHASE_B_RUNNER_POLICY_REJECT',
    reject_codes: uniqueRejectCodes,
    assertions,
    control_repository: isRepositoryFullName(repository?.full_name) ? repository.full_name : null,
    source_repository: isRepositoryFullName(dispatch?.source_repository) ? dispatch.source_repository : null,
    source_ref: isSourceRef(dispatch?.source_ref) ? dispatch.source_ref : null,
    source_commit: isPinnedCommit(dispatch?.source_commit) ? dispatch.source_commit : null,
    workflow_commit: isPinnedCommit(dispatch?.workflow_commit) ? dispatch.workflow_commit : null,
    memory_class: expectation.memory_class,
    runner_binding: isRunnerBinding(dispatch?.runner_binding) ? dispatch.runner_binding : null,
    runner_name: isRunnerName(dispatch?.actual_runner_name) ? dispatch.actual_runner_name : null,
    run_id: isRunId(dispatch?.run_id) ? dispatch.run_id : null,
    run_attempt: isRunAttempt(dispatch?.run_attempt) ? dispatch.run_attempt : null,
    run_ref: typeof dispatch?.ref === 'string' ? dispatch.ref : null,
    workflow_ref: typeof dispatch?.workflow_ref === 'string' ? dispatch.workflow_ref : null,
    completion_sentinel: 'WIN_PHASE_B_RUNNER_POLICY_COMPLETE',
  };
}

export function evaluatePhaseBRunnerPolicy(
  input: unknown,
  expectation: PhaseBRunnerPolicyExpectation
): PhaseBRunnerPolicyResult {
  const assertions: WindowsGateAssertionReceipt[] = [];
  const rejectCodes: PhaseBRunnerRejectCode[] = [];
  const addAssertion = (
    id: string,
    ok: boolean,
    rejectCode: PhaseBRunnerRejectCode,
    passDetail: string,
    rejectDetail: string
  ): void => {
    assertions.push({ id, status: ok ? 'PASS' : 'REJECT', detail: ok ? passDetail : rejectDetail });
    if (!ok) rejectCodes.push(rejectCode);
  };

  if (!isRecord(input)) {
    addAssertion(
      'runner-policy-schema',
      false,
      'WIN_B_RUNNER_POLICY_SCHEMA_INVALID',
      'Runner evidence uses the Phase B policy schema.',
      'Runner evidence is not an object.'
    );
    return result(rejectCodes, assertions, null, null, expectation);
  }

  const repository = isRecord(input.repository) ? input.repository : null;
  const dispatch = isRecord(input.dispatch) ? input.dispatch : null;
  const runner = isRecord(input.runner) ? input.runner : null;
  const schemaValid =
    input.schema_version === PHASE_B_RUNNER_POLICY_SCHEMA_VERSION &&
    repository !== null &&
    dispatch !== null &&
    runner !== null;
  addAssertion(
    'runner-policy-schema',
    schemaValid,
    'WIN_B_RUNNER_POLICY_SCHEMA_INVALID',
    'Runner evidence uses the Phase B policy schema.',
    'Runner evidence schema or required sections are invalid.'
  );

  addAssertion(
    'private-repository',
    repository?.visibility === 'private',
    'WIN_B_REPOSITORY_NOT_PRIVATE',
    'Runner is scoped to a private repository.',
    'Runner repository is public or its visibility is unknown.'
  );

  addAssertion(
    'exact-lab-repository',
    repository?.full_name === expectation.expected_control_repository,
    'WIN_B_CONTROL_REPOSITORY_MISMATCH',
    'Runner repository matches the private control repository.',
    'Runner repository does not match the expected private control repository.'
  );

  addAssertion(
    'exact-source-repository',
    dispatch?.source_repository === expectation.expected_source_repository,
    'WIN_B_SOURCE_REPOSITORY_MISMATCH',
    'Checkout source matches the expected public source repository.',
    'Checkout source does not match the expected public source repository.'
  );

  addAssertion(
    'exact-source-ref',
    isSourceRef(dispatch?.source_ref) && dispatch.source_ref === expectation.expected_source_ref,
    'WIN_B_SOURCE_REF_INVALID',
    'Checkout source branch is explicitly bound to the expected public branch.',
    'Checkout source branch is malformed or differs from the expected public branch.'
  );

  addAssertion(
    'pinned-source-commit',
    isPinnedCommit(dispatch?.source_commit),
    'WIN_B_SOURCE_COMMIT_NOT_PINNED',
    'Checkout source is bound to one exact lowercase source SHA.',
    'Checkout source uses a branch or malformed SHA.'
  );

  addAssertion(
    'exact-source-commit',
    dispatch?.source_commit === expectation.expected_source_commit,
    'WIN_B_SOURCE_COMMIT_MISMATCH',
    'Checkout source commit matches the controller-issued SHA.',
    'Checkout source commit differs from the controller-issued SHA.'
  );

  addAssertion(
    'pinned-workflow-commit',
    isPinnedCommit(dispatch?.workflow_commit),
    'WIN_B_WORKFLOW_COMMIT_NOT_PINNED',
    'Private control workflow is bound to one exact lowercase workflow SHA.',
    'Private control workflow uses a branch or malformed SHA.'
  );

  addAssertion(
    'exact-workflow-commit',
    dispatch?.workflow_commit === expectation.expected_workflow_commit,
    'WIN_B_WORKFLOW_COMMIT_MISMATCH',
    'Private control workflow commit matches the controller-issued SHA.',
    'Private control workflow commit differs from the controller-issued SHA.'
  );

  const runnerBindingValid =
    isRunnerBinding(dispatch?.runner_binding) && dispatch.runner_binding === expectation.expected_runner_binding;
  addAssertion(
    'unique-runner-binding',
    runnerBindingValid,
    'WIN_B_RUNNER_BINDING_INVALID',
    'Dispatch and runner use the controller-issued one-run binding.',
    'Runner binding is malformed or differs from the controller-issued binding.'
  );

  const memoryName = expectation.memory_class === 'lowmem-8gb' ? 'lowmem' : 'normal';
  const derivedRunnerName = isRunnerBinding(expectation.expected_runner_binding)
    ? `command-eve-phase-b-${memoryName}-${expectation.expected_runner_binding.slice(0, 12)}`
    : '';
  const runnerNameValid =
    isRunnerName(expectation.expected_runner_name) &&
    expectation.expected_runner_name === derivedRunnerName &&
    dispatch?.expected_runner_name === expectation.expected_runner_name &&
    dispatch?.actual_runner_name === expectation.expected_runner_name;
  addAssertion(
    'exact-runner-name',
    runnerNameValid,
    'WIN_B_RUNNER_NAME_MISMATCH',
    'The assigned Windows runner name matches the controller-issued JIT runner.',
    'The assigned Windows runner name differs from the controller-issued JIT runner.'
  );

  addAssertion(
    'github-run-id',
    isRunId(dispatch?.run_id),
    'WIN_B_RUN_ID_INVALID',
    'GitHub run identity is present and non-zero.',
    'GitHub run identity is missing or malformed.'
  );

  addAssertion(
    'github-run-attempt',
    isRunAttempt(dispatch?.run_attempt),
    'WIN_B_RUN_ATTEMPT_INVALID',
    'GitHub run attempt is a positive integer.',
    'GitHub run attempt is missing or malformed.'
  );

  const expectedRunRef = isRunnerBinding(expectation.expected_runner_binding)
    ? `refs/tags/command-eve-phase-b-${expectation.expected_runner_binding}`
    : '';
  addAssertion(
    'exact-workflow-tag',
    dispatch?.ref_type === 'tag' && dispatch?.ref === expectedRunRef,
    'WIN_B_RUN_REF_MISMATCH',
    'Workflow dispatch runs from the unique controller-created tag.',
    'Workflow dispatch does not run from the unique controller-created tag.'
  );

  const expectedWorkflowRef = `${expectation.expected_control_repository}/.github/workflows/windows-phase-b-lab.yml@${expectedRunRef}`;
  addAssertion(
    'exact-workflow-ref',
    dispatch?.workflow_ref === expectedWorkflowRef,
    'WIN_B_WORKFLOW_REF_MISMATCH',
    'GitHub workflow reference matches the unique tagged private workflow.',
    'GitHub workflow reference differs from the unique tagged private workflow.'
  );

  addAssertion(
    'manual-dispatch-only',
    dispatch?.event_name === 'workflow_dispatch',
    'WIN_B_WORKFLOW_NOT_MANUAL',
    'Runner job can only start from manual workflow dispatch.',
    'Runner job was not started by workflow_dispatch.'
  );

  addAssertion(
    'no-fork-context',
    dispatch?.pull_request_from_fork === false,
    'WIN_B_FORK_CONTEXT_FORBIDDEN',
    'Runner job has no pull-request fork context.',
    'Runner job is associated with a forked pull request or the context is unknown.'
  );

  const permissions = isRecord(dispatch?.permissions) ? dispatch.permissions : null;
  const permissionsBounded =
    permissions !== null &&
    permissions.contents === 'read' &&
    Object.entries(permissions).every(([name, permission]) =>
      name === 'contents' ? permission === 'read' : permission === 'none'
    );
  addAssertion(
    'read-only-workflow-token',
    permissionsBounded,
    'WIN_B_WORKFLOW_PERMISSIONS_TOO_BROAD',
    'Workflow token grants contents:read and no other capability.',
    'Workflow token has write access, identity-token access, or an unknown capability.'
  );

  addAssertion(
    'jit-runner',
    runner?.mode === 'jit',
    'WIN_B_RUNNER_NOT_JIT',
    'Runner uses GitHub just-in-time registration.',
    'Runner registration is persistent, generic ephemeral, or unknown.'
  );

  addAssertion(
    'single-job-runner',
    runner?.max_jobs === 1,
    'WIN_B_RUNNER_NOT_SINGLE_JOB',
    'Runner accepts exactly one job.',
    'Runner can accept more than one job or its limit is unknown.'
  );

  const labels = Array.isArray(runner?.labels)
    ? runner.labels.filter((label): label is string => typeof label === 'string').map((label) => label.toLowerCase())
    : [];
  const memoryLabel = expectation.memory_class === 'lowmem-8gb' ? 'phase-b-lowmem' : 'phase-b-normal';
  const bindingLabel = isRunnerBinding(expectation.expected_runner_binding)
    ? `ceve-bind-${expectation.expected_runner_binding}`
    : '';
  const requiredLabels = ['self-hosted', 'windows', 'x64', 'command-eve-phase-b', memoryLabel, bindingLabel];
  addAssertion(
    'runner-labels',
    requiredLabels.every((label) => labels.includes(label)),
    'WIN_B_RUNNER_LABELS_INVALID',
    `Runner labels bind Windows x64 and ${expectation.memory_class}.`,
    `Runner labels do not bind Windows x64 and ${expectation.memory_class}.`
  );

  addAssertion(
    'runner-work-folder',
    isSafeWorkFolder(runner?.work_folder),
    'WIN_B_RUNNER_WORK_FOLDER_INVALID',
    'Runner uses the disposable relative _work directory.',
    'Runner work folder is absolute, traversing, or non-canonical.'
  );

  addAssertion(
    'no-preexisting-runner-credential-residue',
    runner?.preexisting_credential_file_count === 0,
    'WIN_B_RUNNER_CREDENTIAL_RESIDUE',
    'No runner registration credential files existed before JIT startup.',
    'Runner registration credential files existed before JIT startup or were not counted.'
  );

  addAssertion(
    'controller-token-absent',
    runner?.controller_token_present === false,
    'WIN_B_CONTROLLER_TOKEN_EXPOSED',
    'Controller GitHub token is absent from the runner.',
    'Controller GitHub token is present on the runner or its absence is unknown.'
  );

  addAssertion(
    'production-secrets-absent',
    runner?.production_secrets_available === false,
    'WIN_B_PRODUCTION_SECRETS_EXPOSED',
    'Production secrets are unavailable to the lab runner.',
    'Production secrets are available to the lab runner or their absence is unknown.'
  );

  addAssertion(
    'disposable-runner-root',
    runner?.root_is_disposable === true,
    'WIN_B_RUNNER_ROOT_NOT_DISPOSABLE',
    'Runner root is unique and disposable per job.',
    'Runner root is persistent or its lifecycle is unknown.'
  );

  addAssertion(
    'external-runner-diagnostics',
    runner?.diagnostics_externalized === true,
    'WIN_B_RUNNER_DIAGNOSTICS_NOT_EXTERNALIZED',
    'Runner diagnostics are copied outside the disposable root before cleanup.',
    'Runner diagnostics would disappear with the disposable runner root.'
  );

  addAssertion(
    'one-time-jit-delivery',
    runner?.credential_delivery === 'encoded_jit_config_once',
    'WIN_B_JIT_DELIVERY_INVALID',
    'Runner receives only a one-use encoded JIT configuration.',
    'Runner receives a reusable registration token or another persistent credential.'
  );

  return result(rejectCodes, assertions, repository, dispatch, expectation);
}
