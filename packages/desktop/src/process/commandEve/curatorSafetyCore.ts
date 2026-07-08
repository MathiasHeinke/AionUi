/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE curator / compression / memory substrate gate (1.7.6 SG-02).
 *
 * The Hermes curator and compressor are useful only when their safety contract is
 * visible and staged. This module is pure: it evaluates receipts and state only,
 * and never edits skills, memory or SOUL.md by itself.
 */

export type CompressionExemptionState = 'exempt' | 'not_exempt' | 'unknown';

export type CompressionSafetyProbe = {
  beforeSoulHash: string;
  afterSoulHash: string;
  beforeSafetyHash: string;
  afterSafetyHash: string;
  compressionCount: number;
  pass: boolean;
};

export type StickySafetyInput = {
  soulExemption: CompressionExemptionState;
  safetyExemption: CompressionExemptionState;
  compressionCount: number;
  compressionPass: boolean;
};

export type CuratorRuntimeState = 'disabled' | 'manual_staged' | 'scheduled_staged' | 'active_staged';
export type CuratorTriggerMode = 'manual' | 'scheduled' | 'active';
export type CuratorRuntimeReasonCode =
  | 'curator.disabled'
  | 'curator.disabled-budget-hidden'
  | 'curator.disabled-unstaged'
  | 'curator.manual-staged'
  | 'curator.scheduled-staged'
  | 'curator.active-staged';

export type CuratorRuntimeInput = {
  enabled: boolean;
  triggerMode: CuratorTriggerMode;
  stagedReview: boolean;
  budgetVisible: boolean;
};

export type CuratorRuntimeTruth = {
  state: CuratorRuntimeState;
  canRun: boolean;
  reasonCode: CuratorRuntimeReasonCode;
};

export type CuratorSkillWriteAction = 'propose' | 'stage' | 'write_active_skill';
export type CuratorSkillWriteReasonCode =
  | 'curator.skill-write.pass'
  | 'curator.skill-write.disabled'
  | 'curator.skill-write.stage-required'
  | 'curator.skill-write.human-required';

export type CuratorSkillWriteDecision = {
  ok: boolean;
  reasonCode: CuratorSkillWriteReasonCode;
  humanGate: 'HG-0' | 'HG-2' | 'HG-2.5';
};

export type MemoryGrowthProbe = {
  beforeBytes: number;
  afterBytes: number;
  maxGrowthBytes: number;
  visibleFailureMode: boolean;
};

function nonEmpty(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function compressionSafetyPass(probe: CompressionSafetyProbe): boolean {
  return (
    probe.pass === true &&
    finiteNonNegative(probe.compressionCount) &&
    probe.compressionCount > 0 &&
    nonEmpty(probe.beforeSoulHash) &&
    nonEmpty(probe.afterSoulHash) &&
    nonEmpty(probe.beforeSafetyHash) &&
    nonEmpty(probe.afterSafetyHash) &&
    probe.beforeSoulHash === probe.afterSoulHash &&
    probe.beforeSafetyHash === probe.afterSafetyHash
  );
}

export function shouldReinjectStickySafety(input: StickySafetyInput): boolean {
  if (!finiteNonNegative(input.compressionCount) || input.compressionCount === 0) {
    return false;
  }
  if (input.compressionPass !== true) {
    return true;
  }
  return input.soulExemption !== 'exempt' || input.safetyExemption !== 'exempt';
}

export function resolveCuratorRuntimeState(input: CuratorRuntimeInput): CuratorRuntimeTruth {
  if (!input.enabled) {
    return { state: 'disabled', canRun: false, reasonCode: 'curator.disabled' };
  }

  if (!input.budgetVisible) {
    return { state: 'disabled', canRun: false, reasonCode: 'curator.disabled-budget-hidden' };
  }

  if (!input.stagedReview) {
    return { state: 'disabled', canRun: false, reasonCode: 'curator.disabled-unstaged' };
  }

  if (input.triggerMode === 'manual') {
    return { state: 'manual_staged', canRun: true, reasonCode: 'curator.manual-staged' };
  }

  if (input.triggerMode === 'scheduled') {
    return { state: 'scheduled_staged', canRun: true, reasonCode: 'curator.scheduled-staged' };
  }

  return { state: 'active_staged', canRun: true, reasonCode: 'curator.active-staged' };
}

export function decideCuratorSkillWrite(input: {
  curatorState: CuratorRuntimeState;
  action: CuratorSkillWriteAction;
  stagedReviewApproved: boolean;
}): CuratorSkillWriteDecision {
  if (input.curatorState === 'disabled') {
    return { ok: false, reasonCode: 'curator.skill-write.disabled', humanGate: 'HG-2' };
  }

  if (input.action !== 'write_active_skill') {
    return { ok: true, reasonCode: 'curator.skill-write.pass', humanGate: 'HG-0' };
  }

  if (!input.stagedReviewApproved) {
    return { ok: false, reasonCode: 'curator.skill-write.stage-required', humanGate: 'HG-2.5' };
  }

  if (input.curatorState !== 'active_staged') {
    return { ok: false, reasonCode: 'curator.skill-write.human-required', humanGate: 'HG-2.5' };
  }

  return { ok: true, reasonCode: 'curator.skill-write.pass', humanGate: 'HG-0' };
}

export function memoryGrowthWithinBound(probe: MemoryGrowthProbe): boolean {
  if (
    !finiteNonNegative(probe.beforeBytes) ||
    !finiteNonNegative(probe.afterBytes) ||
    !finiteNonNegative(probe.maxGrowthBytes) ||
    probe.visibleFailureMode !== true
  ) {
    return false;
  }

  return probe.afterBytes - probe.beforeBytes <= probe.maxGrowthBytes;
}
