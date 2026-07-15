/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsGateAssertionReceipt } from './types';
import type { PhaseBMemoryClass } from './phaseBMachineReceiptCore';

export const PHASE_B_RUNNER_POLICY_SCHEMA_VERSION = 'command-eve-windows-phase-b-runner-policy/v1' as const;

export type PhaseBRunnerPolicyEvidenceV1 = {
  schema_version: typeof PHASE_B_RUNNER_POLICY_SCHEMA_VERSION;
  repository: {
    full_name: string;
    visibility: 'private' | 'public' | 'unknown';
  };
  dispatch: {
    event_name: string;
    requested_commit: string;
    trigger_commit: string;
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
  | 'WIN_B_SOURCE_REPOSITORY_MISMATCH'
  | 'WIN_B_SOURCE_COMMIT_NOT_PINNED'
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
  schema_version: 'command-eve-windows-phase-b-runner-policy-result/v1';
  status: 'PASS' | 'REJECT';
  reject_code: 'WIN_PHASE_B_RUNNER_POLICY_REJECT' | null;
  reject_codes: PhaseBRunnerRejectCode[];
  assertions: WindowsGateAssertionReceipt[];
  source_commit: string | null;
  completion_sentinel: 'WIN_PHASE_B_RUNNER_POLICY_COMPLETE';
};

export type PhaseBRunnerPolicyExpectation = {
  expected_repository: string;
  memory_class: PhaseBMemoryClass;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPinnedCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isSafeWorkFolder(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalized = value.replaceAll('\\', '/');
  return normalized === '_work' && !normalized.startsWith('/') && !normalized.split('/').includes('..');
}

function result(
  rejectCodes: PhaseBRunnerRejectCode[],
  assertions: WindowsGateAssertionReceipt[],
  sourceCommit: unknown
): PhaseBRunnerPolicyResult {
  const uniqueRejectCodes = [...new Set(rejectCodes)];
  return {
    schema_version: 'command-eve-windows-phase-b-runner-policy-result/v1',
    status: uniqueRejectCodes.length === 0 ? 'PASS' : 'REJECT',
    reject_code: uniqueRejectCodes.length === 0 ? null : 'WIN_PHASE_B_RUNNER_POLICY_REJECT',
    reject_codes: uniqueRejectCodes,
    assertions,
    source_commit: isPinnedCommit(sourceCommit) ? sourceCommit : null,
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
    return result(rejectCodes, assertions, null);
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
    repository?.full_name === expectation.expected_repository,
    'WIN_B_SOURCE_REPOSITORY_MISMATCH',
    'Runner repository matches the private lab mirror.',
    'Runner repository does not match the expected private lab mirror.'
  );

  const commitPinned =
    isPinnedCommit(dispatch?.requested_commit) &&
    isPinnedCommit(dispatch?.trigger_commit) &&
    dispatch.requested_commit === dispatch.trigger_commit;
  addAssertion(
    'exact-source-commit',
    commitPinned,
    'WIN_B_SOURCE_COMMIT_NOT_PINNED',
    'Dispatch and trigger are bound to one exact lowercase source SHA.',
    'Dispatch uses a branch, malformed SHA, or a different trigger SHA.'
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
  const requiredLabels = ['self-hosted', 'windows', 'x64', 'command-eve-phase-b', memoryLabel];
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

  return result(rejectCodes, assertions, dispatch?.requested_commit);
}
