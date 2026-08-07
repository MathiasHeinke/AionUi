/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  evaluatePhaseACloudTurn,
  evaluatePhaseAHermesTurnHolder,
  evaluatePhaseAInstallLifecycle,
  phaseACreditsConsumed,
  type PhaseALifecycleEvidence,
} from '@/process/commandEve/windows/phaseALifecycleCore';
import { COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256 } from '@/process/commandEve/runtimeBootstrapCore';

function evidence(): PhaseALifecycleEvidence {
  return {
    harness_errors: [],
    install: {
      exit_code: 0,
      app_executable_found: true,
      uninstaller_found: true,
      shortcut_found: true,
    },
    first_launch: { started: true, root_pid: 101, aioncore_observed: true },
    restart: { started: true, root_pid: 202, aioncore_observed: true },
    shutdown: { first_launch_surviving_owned_pids: [], restart_surviving_owned_pids: [] },
    uninstall: {
      exit_code: 0,
      process_residue_count: 0,
      install_residue_count: 0,
      shortcut_residue_count: 0,
      registry_residue_count: 0,
      disposable_profile_removed: true,
    },
    runtime: {
      receipt_status: 'ready',
      receipt_platform: 'win32',
      runtime_profile: 'cloud_turn_holder_only',
      python_source: 'bundled',
      hermes_executable_path: 'C:\\proof\\command-eve-runtime\\hermes\\venv\\Scripts\\hermes.exe',
      hermes_executable_found: true,
      hermes_required_version: '0.20.0',
      hermes_installed_version: '0.20.0',
      hermes_wheel_sha256: COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256,
      hermes_expected_wheel_sha256: COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256,
      hermes_wheel_sha256_verified: true,
      hermes_version_probe_exit_code: 0,
      hermes_version_probe_output: '0.20.0',
      ollama_stage_status: 'skip',
      model_stage_status: 'skip',
    },
    cloud: {
      credential_available: true,
      registration_ok: true,
      entitlement_activation_ok: true,
      encrypted_license_wire_present: true,
      license_wire_profile_binding_verified: true,
      plaintext_license_wire_present: false,
      plaintext_test_seat_finding_count: 0,
      hermes_exit_code: 0,
      response_marker_found: true,
      response_complete: true,
      prompt_proof_ok: true,
      prompt_proof_marker: 'eve_soul',
      egress_provider_kind: 'cloud',
      egress_decision: 'allow',
      egress_raw_text_stored: false,
      provider_secret_finding_count: 0,
      cancel_requested: true,
      cancel_surviving_owned_pids: [],
      restart_turn_exit_code: 0,
      restart_turn_marker_found: true,
      credits_before: {
        ok: true,
        tier: 'starter',
        included_allowance_credits_remaining: 10_000,
        purchased_credits_remaining: 1_000,
        free_actions_used_this_period: 0,
        free_cap: 100,
        period_start: '2026-07-01T00:00:00.000Z',
      },
      credits_after: {
        ok: true,
        tier: 'starter',
        included_allowance_credits_remaining: 9_900,
        purchased_credits_remaining: 1_000,
        free_actions_used_this_period: 0,
        free_cap: 100,
        period_start: '2026-07-01T00:00:00.000Z',
      },
    },
  };
}

describe('Windows Phase A packaged lifecycle evaluation', () => {
  it('passes a clean install, launch, restart, and uninstall lifecycle', () => {
    const result = evaluatePhaseAInstallLifecycle(evidence());

    expect(result.status).toBe('PASS');
    expect(result.reject_code).toBeNull();
    expect(result.assertions.every((item) => item.status === 'PASS')).toBe(true);
  });

  it('rejects surviving processes and residual installation state', () => {
    const input = evidence();
    input.shutdown.restart_surviving_owned_pids = [303];
    input.uninstall.registry_residue_count = 1;

    const result = evaluatePhaseAInstallLifecycle(input);
    expect(result.status).toBe('REJECT');
    expect(result.reject_code).toBe('WIN_INSTALL_LIFECYCLE_REJECT');
    expect(result.assertions.filter((item) => item.status === 'REJECT').map((item) => item.id)).toEqual([
      'restart-shutdown-tree-clean',
      'no-registry-residue',
    ]);
  });

  it('rejects a caught harness error even when surface booleans look healthy', () => {
    const input = evidence();
    input.harness_errors = ['bounded synthetic harness failure'];

    const result = evaluatePhaseAInstallLifecycle(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'harness-errors-empty')?.status).toBe('REJECT');
  });
});

describe('Windows Phase A Hermes turn-holder evaluation', () => {
  it('passes the managed Windows venv while proving local inference stayed off', () => {
    const result = evaluatePhaseAHermesTurnHolder(evidence());

    expect(result.status).toBe('PASS');
    expect(result.metrics.runtime_profile).toBe('cloud_turn_holder_only');
  });

  it('rejects a hidden local model start or non-bundled Python', () => {
    const input = evidence();
    input.runtime.python_source = 'system';
    input.runtime.ollama_stage_status = 'pass';

    const result = evaluatePhaseAHermesTurnHolder(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.filter((item) => item.status === 'REJECT').map((item) => item.id)).toEqual([
      'bundled-python',
      'ollama-not-started',
    ]);
  });

  it('rejects an orphaned packaged turn-holder process', () => {
    const input = evidence();
    input.shutdown.first_launch_surviving_owned_pids = [404];

    const result = evaluatePhaseAHermesTurnHolder(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'turn-holder-process-trees-clean')?.status).toBe('REJECT');
  });

  it('rejects a version probe whose output does not match the managed Hermes version', () => {
    const input = evidence();
    input.runtime.hermes_version_probe_output = '0.16.0';

    const result = evaluatePhaseAHermesTurnHolder(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'hermes-version')?.status).toBe('REJECT');
  });

  it('rejects same-version Hermes bytes that do not match the committed wheel pin', () => {
    const input = evidence();
    input.runtime.hermes_wheel_sha256 = 'f'.repeat(64);
    input.runtime.hermes_wheel_sha256_verified = false;

    const result = evaluatePhaseAHermesTurnHolder(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'hermes-wheel-sha256-pinned')?.status).toBe('REJECT');
  });
});

describe('Windows Phase A managed cloud turn evaluation', () => {
  it('passes a complete Hermes cloud answer with server-side metering evidence', () => {
    const result = evaluatePhaseACloudTurn(evidence());

    expect(result.status).toBe('PASS');
    expect(result.metrics.metering_delta_observed).toBe(true);
    expect(result.metrics.allowance_delta).toBe(100);
  });

  it('blocks honestly when the dedicated test-seat credential is unavailable', () => {
    const input = evidence();
    input.cloud.credential_available = false;

    expect(evaluatePhaseACloudTurn(input)).toMatchObject({
      status: 'BLOCKED_AUTH',
      reject_code: 'WIN_PHASE_A_TEST_SEAT_REQUIRED',
    });
  });

  it('rejects a response without metering delta, prompt proof, or post-cancel recovery', () => {
    const input = evidence();
    input.cloud.credits_after = { ...input.cloud.credits_before! };
    input.cloud.prompt_proof_ok = false;
    input.cloud.restart_turn_marker_found = false;

    const result = evaluatePhaseACloudTurn(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.filter((item) => item.status === 'REJECT').map((item) => item.id)).toEqual([
      'prompt-proof',
      'metering-delta',
      'post-cancel-restart-turn',
    ]);
  });

  it('rejects plaintext test-seat material anywhere in the disposable proof surface', () => {
    const input = evidence();
    input.cloud.plaintext_test_seat_finding_count = 1;

    const result = evaluatePhaseACloudTurn(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'no-plaintext-test-seat-credential')?.status).toBe('REJECT');
  });

  it('rejects an encrypted license wire created for a different safeStorage profile', () => {
    const input = evidence();
    input.cloud.license_wire_profile_binding_verified = false;

    const result = evaluatePhaseACloudTurn(input);
    expect(result.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'license-wire-encrypted')?.status).toBe('REJECT');
  });

  it('rejects a free-tier counter change as paid-seat metering evidence', () => {
    const input = evidence();
    input.cloud.credits_before = {
      ...input.cloud.credits_before!,
      tier: 'free',
      included_allowance_credits_remaining: 0,
      purchased_credits_remaining: 0,
      free_actions_used_this_period: 4,
    };
    input.cloud.credits_after = {
      ...input.cloud.credits_after!,
      tier: 'free',
      included_allowance_credits_remaining: 0,
      purchased_credits_remaining: 0,
      free_actions_used_this_period: 5,
    };

    expect(phaseACreditsConsumed(input.cloud.credits_before, input.cloud.credits_after)).toBe(false);
    const result = evaluatePhaseACloudTurn(input);
    expect(result.assertions.filter((item) => item.status === 'REJECT').map((item) => item.id)).toEqual([
      'paid-credit-capability',
      'metering-delta',
    ]);
  });

  it('accepts a free-labelled account when its purchased credit tank is actually debited', () => {
    const input = evidence();
    input.cloud.credits_before = {
      ...input.cloud.credits_before!,
      tier: 'free',
      included_allowance_credits_remaining: 0,
      purchased_credits_remaining: 1_000,
    };
    input.cloud.credits_after = {
      ...input.cloud.credits_after!,
      tier: 'free',
      included_allowance_credits_remaining: 0,
      purchased_credits_remaining: 900,
    };

    expect(phaseACreditsConsumed(input.cloud.credits_before, input.cloud.credits_after)).toBe(true);
    expect(evaluatePhaseACloudTurn(input).status).toBe('PASS');
  });

  it('rejects a tier change between metering snapshots', () => {
    const input = evidence();
    input.cloud.credits_after = { ...input.cloud.credits_after!, tier: 'growth' };

    expect(phaseACreditsConsumed(input.cloud.credits_before, input.cloud.credits_after)).toBe(false);
    const result = evaluatePhaseACloudTurn(input);
    expect(result.assertions.find((item) => item.id === 'paid-credit-capability')?.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'metering-delta')?.status).toBe('REJECT');
  });

  it('rejects an unknown billing tier instead of inferring that it is paid', () => {
    const input = evidence();
    input.cloud.credits_before = { ...input.cloud.credits_before!, tier: 'enterprise-unknown' };
    input.cloud.credits_after = { ...input.cloud.credits_after!, tier: 'enterprise-unknown' };

    const result = evaluatePhaseACloudTurn(input);
    expect(result.assertions.find((item) => item.id === 'credits-same-period')?.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'paid-credit-capability')?.status).toBe('REJECT');
    expect(result.assertions.find((item) => item.id === 'metering-delta')?.status).toBe('REJECT');
  });

  it('rejects a billing-period rollover even if counters differ', () => {
    const input = evidence();
    input.cloud.credits_after = {
      ...input.cloud.credits_after!,
      period_start: '2026-08-01T00:00:00.000Z',
    };

    expect(phaseACreditsConsumed(input.cloud.credits_before, input.cloud.credits_after)).toBe(false);
    const result = evaluatePhaseACloudTurn(input);
    expect(result.assertions.find((item) => item.id === 'credits-same-period')?.status).toBe('REJECT');
  });
});
