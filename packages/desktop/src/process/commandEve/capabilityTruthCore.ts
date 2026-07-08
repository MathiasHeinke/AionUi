/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE capability truth contract (1.7.6 SG-03).
 *
 * Prompts, onboarding, settings and privacy UI must not each invent their own
 * capability status. This module builds one deterministic snapshot from privacy
 * mode + smoke evidence + desired state, then exposes tiny read helpers.
 */

import type {
  CapabilityState,
  RuntimeGateHumanGate,
  RuntimeGatePrivacyMode,
  SensitivityClass,
} from './runtimeGateCore';

export type CapabilityTruthKind = 'worker' | 'model' | 'tool' | 'connector' | 'memory' | 'artifact' | 'privacy_lane';

export type CapabilitySmokeStatus = 'pass' | 'fail' | 'not_run';

export type CapabilityTruthSmoke = {
  status: CapabilitySmokeStatus;
  checkedAt?: string;
  reportPath?: string;
};

export type CapabilityTruthReceipt = {
  provider?: string;
  model?: string;
  route?: string;
  costLabel?: string;
};

export type CapabilityTruthDescriptor = {
  id: string;
  label: string;
  kind: CapabilityTruthKind;
  desiredState: CapabilityState;
  suitedFor: string[];
  sensitivityAllowed: SensitivityClass[];
  privacyModesAllowed: RuntimeGatePrivacyMode[];
  requiresHumanGate: RuntimeGateHumanGate;
  smoke: CapabilityTruthSmoke;
  receipt?: CapabilityTruthReceipt;
};

export type CapabilityTruth = Omit<CapabilityTruthDescriptor, 'desiredState'> & {
  state: CapabilityState;
};

export type CapabilityTruthSnapshot = {
  generatedAt: string;
  privacyMode: RuntimeGatePrivacyMode;
  capabilities: CapabilityTruth[];
};

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function resolveCapabilityState(
  descriptor: Pick<CapabilityTruthDescriptor, 'desiredState' | 'privacyModesAllowed' | 'smoke'>,
  privacyMode: RuntimeGatePrivacyMode
): CapabilityState {
  if (descriptor.desiredState === 'blocked') {
    return 'blocked';
  }

  if (!descriptor.privacyModesAllowed.includes(privacyMode)) {
    return 'disabled_by_privacy';
  }

  if (descriptor.smoke.status === 'fail') {
    return 'smoke_failed';
  }

  if (descriptor.desiredState === 'active' && descriptor.smoke.status !== 'pass') {
    return 'deferred';
  }

  return descriptor.desiredState;
}

export function buildCapabilityTruthSnapshot(input: {
  generatedAt: string;
  privacyMode: RuntimeGatePrivacyMode;
  capabilities: CapabilityTruthDescriptor[];
}): CapabilityTruthSnapshot {
  return {
    generatedAt: input.generatedAt,
    privacyMode: input.privacyMode,
    capabilities: input.capabilities.map((capability) => ({
      id: capability.id,
      label: capability.label,
      kind: capability.kind,
      state: resolveCapabilityState(capability, input.privacyMode),
      suitedFor: uniqueNonEmpty(capability.suitedFor),
      sensitivityAllowed: capability.sensitivityAllowed,
      privacyModesAllowed: capability.privacyModesAllowed,
      requiresHumanGate: capability.requiresHumanGate,
      smoke: capability.smoke,
      ...(capability.receipt ? { receipt: capability.receipt } : {}),
    })),
  };
}

export function activeCapabilityInstructions(snapshot: CapabilityTruthSnapshot): string {
  return snapshot.capabilities
    .filter((capability) => capability.state === 'active')
    .map((capability) => `- ${capability.label}: ${capability.suitedFor.join(', ')}`)
    .join('\n');
}

export function shouldAdvertiseCapability(snapshot: CapabilityTruthSnapshot, id: string): boolean {
  return snapshot.capabilities.some((capability) => capability.id === id && capability.state === 'active');
}

export function capabilityById(snapshot: CapabilityTruthSnapshot, id: string): CapabilityTruth | undefined {
  return snapshot.capabilities.find((capability) => capability.id === id);
}
