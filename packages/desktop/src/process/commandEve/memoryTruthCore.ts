/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE memory truth (1.7.6 SG-06).
 *
 * Honcho is an enhancement, not the first-value gate. This core turns Honcho
 * readiness + setup state into one UI/prompt-readable memory truth without ever
 * claiming advanced memory from stale health or missing MCP config.
 */

import type { RuntimeGateHumanGate } from './runtimeGateCore';
import {
  honchoReadyFromSnapshot,
  HONCHO_REASON_DECLINED,
  HONCHO_REASON_DERIVER_UNREACHABLE,
  HONCHO_REASON_PROCESS_DOWN,
  HONCHO_REASON_PROBE_TIMEOUT,
  type HonchoReadinessState,
} from './honchoReadinessCore';
import type { HonchoProvisionPlan } from './honchoProvisionPlanCore';

export type MemoryTruthState = 'advanced_active' | 'company_brain_active' | 'setup_required' | 'degraded';
export type MemoryTruthReasonCode =
  | 'memory.advanced-active'
  | 'memory.company-brain-fallback'
  | 'memory.honcho-setup-consent-required'
  | 'memory.honcho-mcp-missing'
  | 'memory.honcho-degraded'
  | 'memory.honcho-declined';

export type MemoryTruthInput = {
  honchoState?: HonchoReadinessState;
  honchoReceiptPath?: string;
  provisionPlan?: HonchoProvisionPlan;
  mcpConfigPresent: boolean;
  claudeDelegateMemoryPathVerified?: boolean;
  now?: number;
};

export type MemoryTruth = {
  state: MemoryTruthState;
  reasonCode: MemoryTruthReasonCode;
  firstValueBlocked: false;
  companyBrainActive: true;
  advancedMemoryActive: boolean;
  canClaimSharedDelegateMemory: boolean;
  setupCardVisible: boolean;
  humanGate: RuntimeGateHumanGate;
  honchoReceiptPath?: string;
  honchoReasonCode?: string;
};

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOperationalMiss(reasonCode: string | undefined): boolean {
  return (
    reasonCode === HONCHO_REASON_PROCESS_DOWN ||
    reasonCode === HONCHO_REASON_PROBE_TIMEOUT ||
    reasonCode === HONCHO_REASON_DERIVER_UNREACHABLE
  );
}

function truth(input: Omit<MemoryTruth, 'firstValueBlocked' | 'companyBrainActive'>): MemoryTruth {
  return {
    ...input,
    firstValueBlocked: false,
    companyBrainActive: true,
  };
}

export function buildMemoryTruth(input: MemoryTruthInput): MemoryTruth {
  const ready = honchoReadyFromSnapshot(input.honchoState, { now: input.now });
  const receiptPath = hasText(input.honchoReceiptPath) ? input.honchoReceiptPath : undefined;

  if (ready && input.mcpConfigPresent === true) {
    const shared = input.claudeDelegateMemoryPathVerified === true;
    return truth({
      state: 'advanced_active',
      reasonCode: 'memory.advanced-active',
      advancedMemoryActive: true,
      canClaimSharedDelegateMemory: shared,
      setupCardVisible: false,
      humanGate: 'HG-0',
      ...(receiptPath ? { honchoReceiptPath: receiptPath } : {}),
    });
  }

  if (ready && input.mcpConfigPresent !== true) {
    return truth({
      state: 'degraded',
      reasonCode: 'memory.honcho-mcp-missing',
      advancedMemoryActive: false,
      canClaimSharedDelegateMemory: false,
      setupCardVisible: true,
      humanGate: 'HG-2',
      honchoReasonCode: 'HONCHO_MCP_CONFIG_MISSING',
    });
  }

  if (input.provisionPlan?.consentRequired === true) {
    return truth({
      state: 'setup_required',
      reasonCode: 'memory.honcho-setup-consent-required',
      advancedMemoryActive: false,
      canClaimSharedDelegateMemory: false,
      setupCardVisible: true,
      humanGate: 'HG-2',
      honchoReasonCode: input.provisionPlan.skipReason,
    });
  }

  const reasonCode = input.honchoState?.reasonCode || input.provisionPlan?.skipReason;
  if (reasonCode === HONCHO_REASON_DECLINED) {
    return truth({
      state: 'company_brain_active',
      reasonCode: 'memory.honcho-declined',
      advancedMemoryActive: false,
      canClaimSharedDelegateMemory: false,
      setupCardVisible: true,
      humanGate: 'HG-1',
      honchoReasonCode: reasonCode,
    });
  }

  if (isOperationalMiss(reasonCode)) {
    return truth({
      state: 'degraded',
      reasonCode: 'memory.honcho-degraded',
      advancedMemoryActive: false,
      canClaimSharedDelegateMemory: false,
      setupCardVisible: true,
      humanGate: 'HG-1',
      honchoReasonCode: reasonCode,
    });
  }

  return truth({
    state: 'company_brain_active',
    reasonCode: 'memory.company-brain-fallback',
    advancedMemoryActive: false,
    canClaimSharedDelegateMemory: false,
    setupCardVisible: true,
    humanGate: 'HG-1',
    honchoReasonCode: reasonCode,
  });
}
