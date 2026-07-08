/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  compressionSafetyPass,
  decideCuratorSkillWrite,
  memoryGrowthWithinBound,
  resolveCuratorRuntimeState,
  shouldReinjectStickySafety,
  type CompressionSafetyProbe,
} from '@/process/commandEve/curatorSafetyCore';

const PASSING_PROBE: CompressionSafetyProbe = {
  beforeSoulHash: 'soul-hash',
  afterSoulHash: 'soul-hash',
  beforeSafetyHash: 'safety-hash',
  afterSafetyHash: 'safety-hash',
  compressionCount: 1,
  pass: true,
};

describe('Command EVE curator safety core — compression', () => {
  it('passes only when compression happened and SOUL/safety hashes survive unchanged', () => {
    expect(compressionSafetyPass(PASSING_PROBE)).toBe(true);
  });

  it('fails closed when compression did not run, receipt failed or hashes drifted', () => {
    expect(compressionSafetyPass({ ...PASSING_PROBE, compressionCount: 0 })).toBe(false);
    expect(compressionSafetyPass({ ...PASSING_PROBE, pass: false })).toBe(false);
    expect(compressionSafetyPass({ ...PASSING_PROBE, afterSoulHash: 'changed' })).toBe(false);
    expect(compressionSafetyPass({ ...PASSING_PROBE, beforeSafetyHash: '' })).toBe(false);
  });

  it('re-injects sticky safety after compression when exemption is unknown or not proven', () => {
    expect(
      shouldReinjectStickySafety({
        soulExemption: 'unknown',
        safetyExemption: 'exempt',
        compressionCount: 1,
        compressionPass: true,
      })
    ).toBe(true);
    expect(
      shouldReinjectStickySafety({
        soulExemption: 'exempt',
        safetyExemption: 'not_exempt',
        compressionCount: 1,
        compressionPass: true,
      })
    ).toBe(true);
  });

  it('does not re-inject when no compression happened or both safety anchors are proven exempt', () => {
    expect(
      shouldReinjectStickySafety({
        soulExemption: 'unknown',
        safetyExemption: 'unknown',
        compressionCount: 0,
        compressionPass: false,
      })
    ).toBe(false);
    expect(
      shouldReinjectStickySafety({
        soulExemption: 'exempt',
        safetyExemption: 'exempt',
        compressionCount: 2,
        compressionPass: true,
      })
    ).toBe(false);
  });
});

describe('Command EVE curator safety core — runtime state', () => {
  it('keeps curator disabled when not enabled', () => {
    expect(
      resolveCuratorRuntimeState({
        enabled: false,
        triggerMode: 'active',
        stagedReview: true,
        budgetVisible: true,
      })
    ).toEqual({
      state: 'disabled',
      canRun: false,
      reasonCode: 'curator.disabled',
    });
  });

  it('disables curator when budget is hidden or staged review is missing', () => {
    expect(
      resolveCuratorRuntimeState({
        enabled: true,
        triggerMode: 'scheduled',
        stagedReview: true,
        budgetVisible: false,
      })
    ).toMatchObject({
      state: 'disabled',
      reasonCode: 'curator.disabled-budget-hidden',
    });
    expect(
      resolveCuratorRuntimeState({
        enabled: true,
        triggerMode: 'active',
        stagedReview: false,
        budgetVisible: true,
      })
    ).toMatchObject({
      state: 'disabled',
      reasonCode: 'curator.disabled-unstaged',
    });
  });

  it('reports only staged live states when curator can run', () => {
    expect(
      resolveCuratorRuntimeState({
        enabled: true,
        triggerMode: 'manual',
        stagedReview: true,
        budgetVisible: true,
      })
    ).toEqual({
      state: 'manual_staged',
      canRun: true,
      reasonCode: 'curator.manual-staged',
    });
    expect(
      resolveCuratorRuntimeState({
        enabled: true,
        triggerMode: 'scheduled',
        stagedReview: true,
        budgetVisible: true,
      }).state
    ).toBe('scheduled_staged');
    expect(
      resolveCuratorRuntimeState({
        enabled: true,
        triggerMode: 'active',
        stagedReview: true,
        budgetVisible: true,
      }).state
    ).toBe('active_staged');
  });
});

describe('Command EVE curator safety core — skill writes and memory growth', () => {
  it('allows proposals/staging but blocks active skill writes without reviewed staging', () => {
    expect(
      decideCuratorSkillWrite({
        curatorState: 'manual_staged',
        action: 'propose',
        stagedReviewApproved: false,
      })
    ).toMatchObject({ ok: true, humanGate: 'HG-0' });
    expect(
      decideCuratorSkillWrite({
        curatorState: 'active_staged',
        action: 'write_active_skill',
        stagedReviewApproved: false,
      })
    ).toEqual({
      ok: false,
      reasonCode: 'curator.skill-write.stage-required',
      humanGate: 'HG-2.5',
    });
  });

  it('allows active skill writes only from active_staged after reviewed staging approval', () => {
    expect(
      decideCuratorSkillWrite({
        curatorState: 'scheduled_staged',
        action: 'write_active_skill',
        stagedReviewApproved: true,
      })
    ).toEqual({
      ok: false,
      reasonCode: 'curator.skill-write.human-required',
      humanGate: 'HG-2.5',
    });
    expect(
      decideCuratorSkillWrite({
        curatorState: 'active_staged',
        action: 'write_active_skill',
        stagedReviewApproved: true,
      })
    ).toEqual({
      ok: true,
      reasonCode: 'curator.skill-write.pass',
      humanGate: 'HG-0',
    });
  });

  it('requires bounded memory growth and a visible failure mode', () => {
    expect(
      memoryGrowthWithinBound({
        beforeBytes: 10_000,
        afterBytes: 12_500,
        maxGrowthBytes: 3_000,
        visibleFailureMode: true,
      })
    ).toBe(true);
    expect(
      memoryGrowthWithinBound({
        beforeBytes: 10_000,
        afterBytes: 15_000,
        maxGrowthBytes: 3_000,
        visibleFailureMode: true,
      })
    ).toBe(false);
    expect(
      memoryGrowthWithinBound({
        beforeBytes: 10_000,
        afterBytes: 10_100,
        maxGrowthBytes: 3_000,
        visibleFailureMode: false,
      })
    ).toBe(false);
  });
});
