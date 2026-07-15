/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  evaluatePhaseBRunnerPolicy,
  type PhaseBRunnerPolicyEvidenceV2,
} from '@/process/commandEve/windows/phaseBRunnerPolicyCore';

const SOURCE_SHA = 'a'.repeat(40);
const WORKFLOW_SHA = 'b'.repeat(40);
const SOURCE_REF = 'codex/command-eve-windows-phase-b-bootstrap';
const RUNNER_BINDING = 'c'.repeat(32);
const RUNNER_NAME = `command-eve-phase-b-lowmem-${RUNNER_BINDING.slice(0, 12)}`;
const RUN_ID = '123456789';
const RUN_REF = `refs/tags/command-eve-phase-b-${RUNNER_BINDING}`;
const WORKFLOW_REF = `MathiasHeinke/command-eve-windows-lab/.github/workflows/windows-phase-b-lab.yml@${RUN_REF}`;

function evidence(overrides: Partial<PhaseBRunnerPolicyEvidenceV2> = {}): PhaseBRunnerPolicyEvidenceV2 {
  return {
    schema_version: 'command-eve-windows-phase-b-runner-policy/v2',
    repository: {
      full_name: 'MathiasHeinke/command-eve-windows-lab',
      visibility: 'private',
    },
    dispatch: {
      event_name: 'workflow_dispatch',
      source_repository: 'MathiasHeinke/AionUi',
      source_ref: SOURCE_REF,
      source_commit: SOURCE_SHA,
      workflow_commit: WORKFLOW_SHA,
      runner_binding: RUNNER_BINDING,
      expected_runner_name: RUNNER_NAME,
      actual_runner_name: RUNNER_NAME,
      run_id: RUN_ID,
      run_attempt: 1,
      ref: RUN_REF,
      ref_type: 'tag',
      workflow_ref: WORKFLOW_REF,
      pull_request_from_fork: false,
      permissions: {
        contents: 'read',
        actions: 'none',
        checks: 'none',
        deployments: 'none',
        id_token: 'none',
        packages: 'none',
      },
    },
    runner: {
      mode: 'jit',
      max_jobs: 1,
      labels: ['self-hosted', 'Windows', 'X64', 'command-eve-phase-b', 'phase-b-lowmem', `ceve-bind-${RUNNER_BINDING}`],
      work_folder: '_work',
      preexisting_credential_file_count: 0,
      controller_token_present: false,
      production_secrets_available: false,
      root_is_disposable: true,
      diagnostics_externalized: true,
      credential_delivery: 'encoded_jit_config_once',
    },
    ...overrides,
  };
}

const expectation = {
  expected_control_repository: 'MathiasHeinke/command-eve-windows-lab',
  expected_source_repository: 'MathiasHeinke/AionUi',
  expected_source_ref: SOURCE_REF,
  expected_source_commit: SOURCE_SHA,
  expected_workflow_commit: WORKFLOW_SHA,
  expected_runner_binding: RUNNER_BINDING,
  expected_runner_name: RUNNER_NAME,
  memory_class: 'lowmem-8gb' as const,
};

describe('Windows Phase B JIT runner policy', () => {
  it('accepts independently pinned private workflow and public source commits', () => {
    const result = evaluatePhaseBRunnerPolicy(evidence(), expectation);

    expect(result.status).toBe('PASS');
    expect(result.reject_codes).toEqual([]);
    expect(result).toMatchObject({
      source_repository: 'MathiasHeinke/AionUi',
      source_ref: SOURCE_REF,
      source_commit: SOURCE_SHA,
      workflow_commit: WORKFLOW_SHA,
      runner_binding: RUNNER_BINDING,
      runner_name: RUNNER_NAME,
      run_id: RUN_ID,
      run_attempt: 1,
      run_ref: RUN_REF,
      workflow_ref: WORKFLOW_REF,
      completion_sentinel: 'WIN_PHASE_B_RUNNER_POLICY_COMPLETE',
    });
  });

  it('rejects a public control repository and both repository substitutions', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({
        repository: { full_name: 'MathiasHeinke/other-control', visibility: 'public' },
        dispatch: { ...evidence().dispatch, source_repository: 'attacker/source' },
      }),
      expectation
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining([
        'WIN_B_REPOSITORY_NOT_PRIVATE',
        'WIN_B_CONTROL_REPOSITORY_MISMATCH',
        'WIN_B_SOURCE_REPOSITORY_MISMATCH',
      ])
    );
  });

  it('rejects branch names for either provenance commit and pull-request dispatch', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({
        dispatch: {
          ...evidence().dispatch,
          event_name: 'pull_request',
          source_commit: 'main',
          workflow_commit: 'private-workflow-branch',
          pull_request_from_fork: true,
        },
      }),
      expectation
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining([
        'WIN_B_SOURCE_COMMIT_NOT_PINNED',
        'WIN_B_WORKFLOW_COMMIT_NOT_PINNED',
        'WIN_B_WORKFLOW_NOT_MANUAL',
        'WIN_B_FORK_CONTEXT_FORBIDDEN',
      ])
    );
  });

  it('rejects an old v1 policy receipt instead of silently accepting missing run binding', () => {
    const result = evaluatePhaseBRunnerPolicy(
      { ...evidence(), schema_version: 'command-eve-windows-phase-b-runner-policy/v1' },
      expectation
    );

    expect(result.reject_codes).toContain('WIN_B_RUNNER_POLICY_SCHEMA_INVALID');
  });

  it('rejects a substituted runner name, binding, run id, and workflow tag', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({
        dispatch: {
          ...evidence().dispatch,
          runner_binding: 'd'.repeat(32),
          actual_runner_name: 'command-eve-phase-b-lowmem-dddddddddddd',
          run_id: '0',
          run_attempt: 0,
          ref: 'refs/heads/main',
          ref_type: 'branch',
          workflow_ref:
            'MathiasHeinke/command-eve-windows-lab/.github/workflows/windows-phase-b-lab.yml@refs/heads/main',
        },
      }),
      expectation
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining([
        'WIN_B_RUNNER_BINDING_INVALID',
        'WIN_B_RUNNER_NAME_MISMATCH',
        'WIN_B_RUN_ID_INVALID',
        'WIN_B_RUN_ATTEMPT_INVALID',
        'WIN_B_RUN_REF_MISMATCH',
        'WIN_B_WORKFLOW_REF_MISMATCH',
      ])
    );
  });

  it('rejects write permissions or identity-token access', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({
        dispatch: {
          ...evidence().dispatch,
          permissions: { contents: 'write', id_token: 'write' },
        },
      }),
      expectation
    );

    expect(result.reject_codes).toContain('WIN_B_WORKFLOW_PERMISSIONS_TOO_BROAD');
  });

  it('rejects persistent or multi-job runners and the wrong memory label', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({
        runner: {
          ...evidence().runner,
          mode: 'persistent',
          max_jobs: 20,
          labels: ['self-hosted', 'Windows', 'X64', 'command-eve-phase-b', 'phase-b-normal'],
        },
      }),
      expectation
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining(['WIN_B_RUNNER_NOT_JIT', 'WIN_B_RUNNER_NOT_SINGLE_JOB', 'WIN_B_RUNNER_LABELS_INVALID'])
    );
  });

  it('rejects credential residue, controller credentials, production secrets, and non-disposable roots', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({
        runner: {
          ...evidence().runner,
          preexisting_credential_file_count: 2,
          controller_token_present: true,
          production_secrets_available: true,
          root_is_disposable: false,
          diagnostics_externalized: false,
          credential_delivery: 'persistent_registration_token',
        },
      }),
      expectation
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining([
        'WIN_B_RUNNER_CREDENTIAL_RESIDUE',
        'WIN_B_CONTROLLER_TOKEN_EXPOSED',
        'WIN_B_PRODUCTION_SECRETS_EXPOSED',
        'WIN_B_RUNNER_ROOT_NOT_DISPOSABLE',
        'WIN_B_RUNNER_DIAGNOSTICS_NOT_EXTERNALIZED',
        'WIN_B_JIT_DELIVERY_INVALID',
      ])
    );
  });

  it('rejects unsafe work-folder paths and malformed evidence', () => {
    const unsafe = evaluatePhaseBRunnerPolicy(
      evidence({ runner: { ...evidence().runner, work_folder: '..\\shared' } }),
      expectation
    );

    expect(unsafe.reject_codes).toContain('WIN_B_RUNNER_WORK_FOLDER_INVALID');
    expect(evaluatePhaseBRunnerPolicy(null, expectation).reject_codes).toContain('WIN_B_RUNNER_POLICY_SCHEMA_INVALID');
  });
});
