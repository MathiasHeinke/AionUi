/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { buildMemoryTruth } from '@/process/commandEve/memoryTruthCore';
import {
  HONCHO_REASON_DECLINED,
  HONCHO_REASON_DERIVER_UNREACHABLE,
  HONCHO_STATE_DEGRADED,
  HONCHO_STATE_READY,
  type HonchoReadinessState,
} from '@/process/commandEve/honchoReadinessCore';

const NOW = Date.parse('2026-07-08T10:00:00.000Z');

function readyState(overrides: Partial<HonchoReadinessState> = {}): HonchoReadinessState {
  return {
    seatId: 'seat-1',
    state: HONCHO_STATE_READY,
    serverUp: true,
    deriverReachable: true,
    branch: 'cloud-flash-via-shim',
    probedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('Command EVE memory truth core', () => {
  it('claims advanced memory only for fresh Honcho readiness plus MCP config', () => {
    expect(
      buildMemoryTruth({
        honchoState: readyState(),
        honchoReceiptPath: '/tmp/honcho-readiness.json',
        mcpConfigPresent: true,
        claudeDelegateMemoryPathVerified: true,
        now: NOW + 1000,
      })
    ).toEqual({
      state: 'advanced_active',
      reasonCode: 'memory.advanced-active',
      firstValueBlocked: false,
      companyBrainActive: true,
      advancedMemoryActive: true,
      canClaimSharedDelegateMemory: true,
      setupCardVisible: false,
      humanGate: 'HG-0',
      honchoReceiptPath: '/tmp/honcho-readiness.json',
    });
  });

  it('does not claim advanced memory when MCP config is missing even if health is ready', () => {
    const truth = buildMemoryTruth({
      honchoState: readyState(),
      mcpConfigPresent: false,
      now: NOW + 1000,
    });

    expect(truth).toMatchObject({
      state: 'degraded',
      reasonCode: 'memory.honcho-mcp-missing',
      firstValueBlocked: false,
      advancedMemoryActive: false,
      setupCardVisible: true,
      humanGate: 'HG-2',
    });
    expect(truth.canClaimSharedDelegateMemory).toBe(false);
  });

  it('treats stale readiness as company-brain fallback, not active Honcho', () => {
    const truth = buildMemoryTruth({
      honchoState: readyState(),
      mcpConfigPresent: true,
      now: NOW + 60_000,
    });

    expect(truth).toMatchObject({
      state: 'company_brain_active',
      reasonCode: 'memory.company-brain-fallback',
      firstValueBlocked: false,
      advancedMemoryActive: false,
    });
  });

  it('surfaces setup-required when provisioning needs install consent', () => {
    expect(
      buildMemoryTruth({
        mcpConfigPresent: false,
        provisionPlan: {
          honchoEnabled: true,
          consentRequired: true,
          steps: [{ id: 'honcho-postgres', needsConsent: true, alreadySatisfied: false }],
        },
      })
    ).toMatchObject({
      state: 'setup_required',
      reasonCode: 'memory.honcho-setup-consent-required',
      firstValueBlocked: false,
      setupCardVisible: true,
      humanGate: 'HG-2',
    });
  });

  it('degrades operational misses to Company Brain without blocking first value', () => {
    expect(
      buildMemoryTruth({
        honchoState: readyState({
          state: HONCHO_STATE_DEGRADED,
          serverUp: true,
          deriverReachable: false,
          reasonCode: HONCHO_REASON_DERIVER_UNREACHABLE,
        }),
        mcpConfigPresent: true,
        now: NOW + 1000,
      })
    ).toMatchObject({
      state: 'degraded',
      reasonCode: 'memory.honcho-degraded',
      firstValueBlocked: false,
      companyBrainActive: true,
      advancedMemoryActive: false,
      setupCardVisible: true,
      honchoReasonCode: HONCHO_REASON_DERIVER_UNREACHABLE,
    });
  });

  it('keeps declined Honcho as visible fallback instead of a startup blocker', () => {
    expect(
      buildMemoryTruth({
        honchoState: readyState({
          state: 'off',
          serverUp: false,
          deriverReachable: false,
          reasonCode: HONCHO_REASON_DECLINED,
        }),
        mcpConfigPresent: false,
        now: NOW + 1000,
      })
    ).toMatchObject({
      state: 'company_brain_active',
      reasonCode: 'memory.honcho-declined',
      firstValueBlocked: false,
      companyBrainActive: true,
      advancedMemoryActive: false,
      humanGate: 'HG-1',
    });
  });

  it('does not claim shared delegate memory until the Claude memory path is verified', () => {
    expect(
      buildMemoryTruth({
        honchoState: readyState(),
        mcpConfigPresent: true,
        claudeDelegateMemoryPathVerified: false,
        now: NOW + 1000,
      }).canClaimSharedDelegateMemory
    ).toBe(false);
  });
});
