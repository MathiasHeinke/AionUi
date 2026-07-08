/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE runtime gate skeleton (1.7.6 SG-01).
 *
 * This core deliberately owns no fs/net/spawn/UI state. It answers one question:
 * may the requested capability/action proceed under the current smoke, privacy,
 * sensitivity, autonomy and consent state? Prompt text is not an input, so a
 * model cannot bypass this gate by promising it has user approval.
 */

export type SensitivityClass = 'S0-public' | 'S1-internal-low' | 'S2-confidential' | 'S3-restricted';

export type CapabilityState =
  | 'available'
  | 'active'
  | 'needs_auth'
  | 'needs_consent'
  | 'smoke_failed'
  | 'deferred'
  | 'disabled_by_privacy'
  | 'blocked';

export type RuntimeGateAction =
  | 'read'
  | 'write'
  | 'delegate'
  | 'cloud_inference'
  | 'browser'
  | 'computer_use'
  | 'skill_write';

export type RuntimeGateAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type RuntimeGatePrivacyMode = 'cloud_balanced' | 'privacy_first' | 'local_only';
export type RuntimeGateReasonCode =
  | 'gate.pass'
  | 'gate.needs-consent'
  | 'gate.disabled-by-privacy'
  | 'gate.smoke-not-active'
  | 'gate.human-required'
  | 'gate.blocked';
export type RuntimeGateHumanGate = 'HG-0' | 'HG-1' | 'HG-2' | 'HG-2.5' | 'HG-3' | 'HG-4';

export type RuntimeGateInput = {
  capabilityId: string;
  requestedAction: RuntimeGateAction;
  sensitivity: SensitivityClass;
  autonomyLevel: RuntimeGateAutonomyLevel;
  privacyMode: RuntimeGatePrivacyMode;
  userConsent: boolean;
  smokeState: CapabilityState;
};

export type RuntimeGateDecision = {
  ok: boolean;
  reasonCode: RuntimeGateReasonCode;
  humanGate: RuntimeGateHumanGate;
};

const CONSENT_REQUIRED_ACTIONS: RuntimeGateAction[] = [
  'delegate',
  'cloud_inference',
  'browser',
  'computer_use',
  'skill_write',
];

const NON_READ_ACTIONS: RuntimeGateAction[] = [
  'write',
  'delegate',
  'cloud_inference',
  'browser',
  'computer_use',
  'skill_write',
];

const L3_HUMAN_REQUIRED_ACTIONS: RuntimeGateAction[] = ['write', 'delegate', 'browser', 'computer_use', 'skill_write'];

function decision(
  ok: boolean,
  reasonCode: RuntimeGateReasonCode,
  humanGate: RuntimeGateHumanGate
): RuntimeGateDecision {
  return { ok, reasonCode, humanGate };
}

function requiresConsent(action: RuntimeGateAction): boolean {
  return CONSENT_REQUIRED_ACTIONS.includes(action);
}

function isNonReadAction(action: RuntimeGateAction): boolean {
  return NON_READ_ACTIONS.includes(action);
}

function requiresL3HumanGate(action: RuntimeGateAction): boolean {
  return L3_HUMAN_REQUIRED_ACTIONS.includes(action);
}

export function decideRuntimeGate(input: RuntimeGateInput): RuntimeGateDecision {
  const capabilityId = typeof input.capabilityId === 'string' ? input.capabilityId.trim() : '';
  if (!capabilityId || input.smokeState === 'blocked') {
    return decision(false, 'gate.blocked', 'HG-4');
  }

  if (input.smokeState === 'disabled_by_privacy') {
    return decision(false, 'gate.disabled-by-privacy', 'HG-2');
  }

  if (input.smokeState === 'needs_consent') {
    return decision(false, 'gate.needs-consent', 'HG-2');
  }

  if (input.smokeState !== 'active') {
    return decision(false, 'gate.smoke-not-active', 'HG-1');
  }

  if (input.privacyMode === 'local_only' && input.requestedAction === 'cloud_inference') {
    return decision(false, 'gate.disabled-by-privacy', 'HG-2');
  }

  if (input.sensitivity === 'S3-restricted' && isNonReadAction(input.requestedAction)) {
    return decision(false, 'gate.human-required', 'HG-3');
  }

  if (!input.userConsent && requiresConsent(input.requestedAction)) {
    return decision(false, 'gate.needs-consent', 'HG-2');
  }

  if (input.autonomyLevel === 'L3' && requiresL3HumanGate(input.requestedAction)) {
    return decision(false, 'gate.human-required', 'HG-2.5');
  }

  return decision(true, 'gate.pass', 'HG-0');
}
