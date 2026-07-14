/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsGateAssertionReceipt, WindowsGateStatus } from './types';

export type PhaseACreditsSnapshot = {
  ok: boolean;
  tier: string;
  included_allowance_credits_remaining: number;
  purchased_credits_remaining: number;
  free_actions_used_this_period: number;
  free_cap: number;
  period_start: string;
};

export type PhaseALifecycleEvidence = {
  harness_errors: string[];
  install: {
    exit_code: number;
    app_executable_found: boolean;
    uninstaller_found: boolean;
    shortcut_found: boolean;
  };
  first_launch: {
    started: boolean;
    root_pid: number;
    aioncore_observed: boolean;
  };
  restart: {
    started: boolean;
    root_pid: number;
    aioncore_observed: boolean;
  };
  shutdown: {
    first_launch_surviving_owned_pids: number[];
    restart_surviving_owned_pids: number[];
  };
  uninstall: {
    exit_code: number;
    process_residue_count: number;
    install_residue_count: number;
    shortcut_residue_count: number;
    registry_residue_count: number;
    disposable_profile_removed: boolean;
  };
  runtime: {
    receipt_status: string;
    receipt_platform: string;
    runtime_profile: string;
    python_source: string;
    hermes_executable_path: string;
    hermes_executable_found: boolean;
    hermes_required_version: string;
    hermes_installed_version: string;
    hermes_version_probe_exit_code: number;
    hermes_version_probe_output: string;
    ollama_stage_status: string;
    model_stage_status: string;
  };
  cloud: {
    credential_available: boolean;
    registration_ok: boolean;
    entitlement_activation_ok: boolean;
    encrypted_license_wire_present: boolean;
    license_wire_profile_binding_verified: boolean;
    plaintext_license_wire_present: boolean;
    plaintext_test_seat_finding_count: number;
    hermes_exit_code: number;
    response_marker_found: boolean;
    response_complete: boolean;
    prompt_proof_ok: boolean;
    prompt_proof_marker: string;
    egress_provider_kind: string;
    egress_decision: string;
    egress_raw_text_stored: boolean;
    provider_secret_finding_count: number;
    cancel_requested: boolean;
    cancel_surviving_owned_pids: number[];
    restart_turn_exit_code: number;
    restart_turn_marker_found: boolean;
    credits_before: PhaseACreditsSnapshot | null;
    credits_after: PhaseACreditsSnapshot | null;
  };
};

export type PhaseAGateEvaluation = {
  status: WindowsGateStatus;
  reject_code: string | null;
  assertions: WindowsGateAssertionReceipt[];
  metrics: Record<string, string | number | boolean | null>;
};

function assertion(id: string, ok: boolean, passDetail: string, rejectDetail: string): WindowsGateAssertionReceipt {
  return {
    id,
    status: ok ? 'PASS' : 'REJECT',
    detail: ok ? passDetail : rejectDetail,
  };
}

function rejectionCode(assertions: WindowsGateAssertionReceipt[], code: string): string | null {
  return assertions.every((item) => item.status === 'PASS') ? null : code;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

const PHASE_A_CREDITS_TIERS = new Set(['free', 'solo', 'starter']);

function validCreditsSnapshot(snapshot: PhaseACreditsSnapshot | null): snapshot is PhaseACreditsSnapshot {
  return Boolean(
    snapshot?.ok &&
    PHASE_A_CREDITS_TIERS.has(snapshot.tier) &&
    snapshot.period_start &&
    finiteNonNegative(snapshot.included_allowance_credits_remaining) &&
    finiteNonNegative(snapshot.purchased_credits_remaining) &&
    finiteNonNegative(snapshot.free_actions_used_this_period) &&
    finiteNonNegative(snapshot.free_cap)
  );
}

export function phaseACreditsConsumed(
  before: PhaseACreditsSnapshot | null,
  after: PhaseACreditsSnapshot | null
): boolean {
  if (!validCreditsSnapshot(before) || !validCreditsSnapshot(after)) return false;
  if (before.period_start !== after.period_start) return false;
  if (before.tier !== after.tier) return false;
  if (before.tier === 'free' && before.purchased_credits_remaining <= 0) return false;
  return (
    after.included_allowance_credits_remaining < before.included_allowance_credits_remaining ||
    after.purchased_credits_remaining < before.purchased_credits_remaining
  );
}

export function evaluatePhaseAInstallLifecycle(evidence: PhaseALifecycleEvidence): PhaseAGateEvaluation {
  const assertions = [
    assertion(
      'harness-errors-empty',
      evidence.harness_errors.length === 0,
      'Lifecycle harness completed without internal errors.',
      'Lifecycle harness recorded one or more internal errors.'
    ),
    assertion(
      'installer-exit',
      evidence.install.exit_code === 0,
      'Installer exited successfully.',
      'Installer failed.'
    ),
    assertion(
      'installed-app-present',
      evidence.install.app_executable_found,
      'Installed application executable was found.',
      'Installed application executable was not found.'
    ),
    assertion(
      'uninstaller-present',
      evidence.install.uninstaller_found,
      'Uninstaller was found.',
      'Uninstaller was not found.'
    ),
    assertion(
      'shortcut-present',
      evidence.install.shortcut_found,
      'Installed shortcut was found.',
      'Installed shortcut was not found.'
    ),
    assertion(
      'first-packaged-launch',
      evidence.first_launch.started && evidence.first_launch.root_pid > 0 && evidence.first_launch.aioncore_observed,
      'First packaged launch started the desktop and AionCore.',
      'First packaged launch did not prove the desktop and AionCore process tree.'
    ),
    assertion(
      'first-shutdown-tree-clean',
      evidence.shutdown.first_launch_surviving_owned_pids.length === 0,
      'First launch process tree stopped without survivors.',
      'First launch left owned processes running.'
    ),
    assertion(
      'restart-packaged-launch',
      evidence.restart.started && evidence.restart.root_pid > 0 && evidence.restart.aioncore_observed,
      'Restart started the desktop and AionCore.',
      'Restart did not prove the desktop and AionCore process tree.'
    ),
    assertion(
      'restart-shutdown-tree-clean',
      evidence.shutdown.restart_surviving_owned_pids.length === 0,
      'Restart process tree stopped without survivors.',
      'Restart left owned processes running.'
    ),
    assertion(
      'uninstaller-exit',
      evidence.uninstall.exit_code === 0,
      'Uninstaller exited successfully.',
      'Uninstaller failed.'
    ),
    assertion(
      'no-process-residue',
      evidence.uninstall.process_residue_count === 0,
      'No Command EVE process residue remained.',
      'Command EVE process residue remained after uninstall.'
    ),
    assertion(
      'no-install-residue',
      evidence.uninstall.install_residue_count === 0,
      'No installation files remained.',
      'Installation files remained after uninstall.'
    ),
    assertion(
      'no-shortcut-residue',
      evidence.uninstall.shortcut_residue_count === 0,
      'No shortcuts remained.',
      'Shortcuts remained after uninstall.'
    ),
    assertion(
      'no-registry-residue',
      evidence.uninstall.registry_residue_count === 0,
      'No product registry entries remained.',
      'Product registry entries remained after uninstall.'
    ),
    assertion(
      'disposable-profile-removed',
      evidence.uninstall.disposable_profile_removed,
      'Disposable proof profile was removed.',
      'Disposable proof profile remained after the proof.'
    ),
  ];
  const rejectCode = rejectionCode(assertions, 'WIN_INSTALL_LIFECYCLE_REJECT');
  return {
    status: rejectCode ? 'REJECT' : 'PASS',
    reject_code: rejectCode,
    assertions,
    metrics: {
      first_launch_root_pid: evidence.first_launch.root_pid,
      restart_root_pid: evidence.restart.root_pid,
      process_residue_count: evidence.uninstall.process_residue_count,
      install_residue_count: evidence.uninstall.install_residue_count,
      shortcut_residue_count: evidence.uninstall.shortcut_residue_count,
      registry_residue_count: evidence.uninstall.registry_residue_count,
    },
  };
}

export function evaluatePhaseAHermesTurnHolder(evidence: PhaseALifecycleEvidence): PhaseAGateEvaluation {
  const runtime = evidence.runtime;
  const versionMatches =
    runtime.hermes_required_version.length > 0 &&
    runtime.hermes_required_version === runtime.hermes_installed_version &&
    runtime.hermes_version_probe_output.trim() === runtime.hermes_required_version;
  const normalizedHermesPath = runtime.hermes_executable_path.replaceAll('\\', '/').toLowerCase();
  const assertions = [
    assertion(
      'runtime-ready',
      runtime.receipt_status === 'ready',
      'Runtime bootstrap receipt is ready.',
      'Runtime bootstrap did not become ready.'
    ),
    assertion(
      'runtime-win32',
      runtime.receipt_platform === 'win32',
      'Runtime receipt targets win32.',
      'Runtime receipt does not target win32.'
    ),
    assertion(
      'cloud-turn-holder-profile',
      runtime.runtime_profile === 'cloud_turn_holder_only',
      'Cloud turn-holder profile is active.',
      'Cloud turn-holder profile is not active.'
    ),
    assertion(
      'bundled-python',
      runtime.python_source === 'bundled',
      'Runtime uses bundled Python.',
      'Runtime did not prove bundled Python provenance.'
    ),
    assertion(
      'windows-hermes-entrypoint',
      runtime.hermes_executable_found && normalizedHermesPath.endsWith('/scripts/hermes.exe'),
      'Windows Hermes console entry point exists in the managed venv.',
      'Windows Hermes console entry point is missing or outside the managed venv.'
    ),
    assertion(
      'hermes-version',
      runtime.hermes_version_probe_exit_code === 0 && versionMatches,
      'Hermes version probe matched the required version.',
      'Hermes version probe failed or reported the wrong version.'
    ),
    assertion(
      'ollama-not-started',
      runtime.ollama_stage_status === 'skip',
      'Ollama stage was skipped for Phase A.',
      'Ollama stage was not skipped for Phase A.'
    ),
    assertion(
      'local-model-not-started',
      runtime.model_stage_status === 'skip',
      'Local model stage was skipped for Phase A.',
      'Local model stage was not skipped for Phase A.'
    ),
    assertion(
      'turn-holder-process-trees-clean',
      evidence.shutdown.first_launch_surviving_owned_pids.length === 0 &&
        evidence.shutdown.restart_surviving_owned_pids.length === 0,
      'Packaged turn-holder launches left no owned orphan processes.',
      'A packaged turn-holder launch left owned orphan processes.'
    ),
  ];
  const rejectCode = rejectionCode(assertions, 'WIN_HERMES_TURN_HOLDER_REJECT');
  return {
    status: rejectCode ? 'REJECT' : 'PASS',
    reject_code: rejectCode,
    assertions,
    metrics: {
      runtime_profile: runtime.runtime_profile,
      python_source: runtime.python_source,
      hermes_required_version: runtime.hermes_required_version,
      hermes_installed_version: runtime.hermes_installed_version,
      ollama_stage_status: runtime.ollama_stage_status,
      model_stage_status: runtime.model_stage_status,
    },
  };
}

export function evaluatePhaseACloudTurn(evidence: PhaseALifecycleEvidence): PhaseAGateEvaluation {
  const cloud = evidence.cloud;
  if (!cloud.credential_available) {
    return {
      status: 'BLOCKED_AUTH',
      reject_code: 'WIN_PHASE_A_TEST_SEAT_REQUIRED',
      assertions: [
        assertion(
          'dedicated-test-seat-available',
          false,
          'Dedicated Phase A test-seat credential is available.',
          'Dedicated Phase A test-seat credential is unavailable; cloud proof was not attempted.'
        ),
      ],
      metrics: {
        credential_available: false,
        metering_delta_observed: false,
      },
    };
  }

  const before = cloud.credits_before;
  const after = cloud.credits_after;
  const creditsConsumed = phaseACreditsConsumed(before, after);
  const samePeriod =
    validCreditsSnapshot(before) && validCreditsSnapshot(after) && before.period_start === after.period_start;
  const paidCreditCapability =
    validCreditsSnapshot(before) &&
    validCreditsSnapshot(after) &&
    before.tier === after.tier &&
    (before.tier !== 'free' || before.purchased_credits_remaining > 0);
  const assertions = [
    assertion(
      'dedicated-test-seat-available',
      true,
      'Dedicated Phase A test-seat credential is available.',
      'Dedicated Phase A test-seat credential is unavailable.'
    ),
    assertion(
      'seat-activated',
      cloud.registration_ok && cloud.entitlement_activation_ok,
      'Disposable test identity registered and entitlement activated.',
      'Test identity registration or entitlement activation failed.'
    ),
    assertion(
      'license-wire-encrypted',
      cloud.encrypted_license_wire_present &&
        cloud.license_wire_profile_binding_verified &&
        !cloud.plaintext_license_wire_present,
      'License wire exists only as an encrypted safeStorage record bound to the disposable profile.',
      'Encrypted license wire is missing, bound to the wrong profile, or plaintext wire material was detected.'
    ),
    assertion(
      'no-plaintext-test-seat-credential',
      cloud.plaintext_test_seat_finding_count === 0,
      'No plaintext test-seat credential was found in the disposable profile or evidence.',
      'Plaintext test-seat credential material was found in the disposable profile or evidence.'
    ),
    assertion(
      'hermes-cloud-answer',
      cloud.hermes_exit_code === 0 && cloud.response_complete && cloud.response_marker_found,
      'Hermes returned the complete deterministic cloud answer.',
      'Hermes did not return the complete deterministic cloud answer.'
    ),
    assertion(
      'prompt-proof',
      cloud.prompt_proof_ok && cloud.prompt_proof_marker !== 'none',
      'Prompt proof confirms the EVE system context without storing raw text.',
      'Prompt proof is missing, invalid, or lacks the EVE context marker.'
    ),
    assertion(
      'cloud-egress-receipt',
      cloud.egress_provider_kind === 'cloud' &&
        (cloud.egress_decision === 'allow' || cloud.egress_decision === 'redact') &&
        cloud.egress_raw_text_stored === false,
      'Egress receipt proves a permitted cloud route without raw text storage.',
      'Egress receipt does not prove the permitted cloud boundary.'
    ),
    assertion(
      'credits-same-period',
      samePeriod,
      'Credits snapshots belong to the same billing period.',
      'Credits snapshots are invalid or cross a billing-period boundary.'
    ),
    assertion(
      'paid-credit-capability',
      paidCreditCapability,
      'Credits snapshots prove a stable paid tier or purchased-credit tank.',
      'Credits snapshots do not prove a stable paid tier or purchased-credit tank.'
    ),
    assertion(
      'metering-delta',
      creditsConsumed,
      'Cloud turn produced an observable server-side metering delta.',
      'Cloud turn produced no observable server-side metering delta.'
    ),
    assertion(
      'no-provider-secrets',
      cloud.provider_secret_finding_count === 0,
      'No provider credential material was found in the proof surface.',
      'Provider credential material was found in the proof surface.'
    ),
    assertion(
      'cancel-process-tree',
      cloud.cancel_requested && cloud.cancel_surviving_owned_pids.length === 0,
      'Cancellation stopped the owned Hermes process tree.',
      'Cancellation was not exercised or left owned processes running.'
    ),
    assertion(
      'post-cancel-restart-turn',
      cloud.restart_turn_exit_code === 0 && cloud.restart_turn_marker_found,
      'A second Hermes turn succeeded after cancellation.',
      'Hermes did not recover for a second turn after cancellation.'
    ),
  ];
  const rejectCode = rejectionCode(assertions, 'WIN_CLOUD_CHAT_REJECT');
  return {
    status: rejectCode ? 'REJECT' : 'PASS',
    reject_code: rejectCode,
    assertions,
    metrics: {
      credential_available: true,
      credits_period_same: samePeriod,
      paid_credit_capability: paidCreditCapability,
      credits_tier: validCreditsSnapshot(before) ? before.tier : null,
      metering_delta_observed: creditsConsumed,
      allowance_delta:
        validCreditsSnapshot(before) && validCreditsSnapshot(after)
          ? before.included_allowance_credits_remaining - after.included_allowance_credits_remaining
          : null,
      purchased_delta:
        validCreditsSnapshot(before) && validCreditsSnapshot(after)
          ? before.purchased_credits_remaining - after.purchased_credits_remaining
          : null,
      free_action_delta:
        validCreditsSnapshot(before) && validCreditsSnapshot(after)
          ? after.free_actions_used_this_period - before.free_actions_used_this_period
          : null,
      egress_decision: cloud.egress_decision,
      prompt_proof_marker: cloud.prompt_proof_marker,
    },
  };
}
