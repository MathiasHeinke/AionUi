/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  evaluatePhaseBRunnerPolicy,
  type PhaseBRunnerPolicyEvidenceV1,
} from '@/process/commandEve/windows/phaseBRunnerPolicyCore';

const SOURCE_SHA = 'a'.repeat(40);

function evidence(overrides: Partial<PhaseBRunnerPolicyEvidenceV1> = {}): PhaseBRunnerPolicyEvidenceV1 {
  return {
    schema_version: 'command-eve-windows-phase-b-runner-policy/v1',
    repository: {
      full_name: 'MathiasHeinke/command-eve-windows-lab',
      visibility: 'private',
    },
    dispatch: {
      event_name: 'workflow_dispatch',
      requested_commit: SOURCE_SHA,
      trigger_commit: SOURCE_SHA,
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
      labels: ['self-hosted', 'Windows', 'X64', 'command-eve-phase-b', 'phase-b-lowmem'],
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

describe('Windows Phase B JIT runner policy', () => {
  it('accepts a one-job JIT runner for the exact private lab mirror and source SHA', () => {
    const result = evaluatePhaseBRunnerPolicy(evidence(), {
      expected_repository: 'MathiasHeinke/command-eve-windows-lab',
      memory_class: 'lowmem-8gb',
    });

    expect(result.status).toBe('PASS');
    expect(result.reject_codes).toEqual([]);
    expect(result.completion_sentinel).toBe('WIN_PHASE_B_RUNNER_POLICY_COMPLETE');
  });

  it('rejects public repositories and repository substitution', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({ repository: { full_name: 'MathiasHeinke/AionUi', visibility: 'public' } }),
      { expected_repository: 'MathiasHeinke/command-eve-windows-lab', memory_class: 'lowmem-8gb' }
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining(['WIN_B_REPOSITORY_NOT_PRIVATE', 'WIN_B_SOURCE_REPOSITORY_MISMATCH'])
    );
  });

  it('rejects branch names, mismatched trigger SHAs, and pull-request dispatch', () => {
    const result = evaluatePhaseBRunnerPolicy(
      evidence({
        dispatch: {
          ...evidence().dispatch,
          event_name: 'pull_request',
          requested_commit: 'main',
          trigger_commit: 'b'.repeat(40),
          pull_request_from_fork: true,
        },
      }),
      { expected_repository: 'MathiasHeinke/command-eve-windows-lab', memory_class: 'lowmem-8gb' }
    );

    expect(result.reject_codes).toEqual(
      expect.arrayContaining([
        'WIN_B_SOURCE_COMMIT_NOT_PINNED',
        'WIN_B_WORKFLOW_NOT_MANUAL',
        'WIN_B_FORK_CONTEXT_FORBIDDEN',
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
      { expected_repository: 'MathiasHeinke/command-eve-windows-lab', memory_class: 'lowmem-8gb' }
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
      { expected_repository: 'MathiasHeinke/command-eve-windows-lab', memory_class: 'lowmem-8gb' }
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
      { expected_repository: 'MathiasHeinke/command-eve-windows-lab', memory_class: 'lowmem-8gb' }
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
      { expected_repository: 'MathiasHeinke/command-eve-windows-lab', memory_class: 'lowmem-8gb' }
    );

    expect(unsafe.reject_codes).toContain('WIN_B_RUNNER_WORK_FOLDER_INVALID');
    expect(
      evaluatePhaseBRunnerPolicy(null, {
        expected_repository: 'MathiasHeinke/command-eve-windows-lab',
        memory_class: 'lowmem-8gb',
      }).reject_codes
    ).toContain('WIN_B_RUNNER_POLICY_SCHEMA_INVALID');
  });
});
