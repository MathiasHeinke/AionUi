/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildEveLaneViews,
  laneOfSelection,
  eveTierValue,
  localTierValue,
  type PickerLaneView,
} from '@/common/config/eveInferenceCore';

const byLane = (views: PickerLaneView[]) => Object.fromEntries(views.map((v) => [v.lane, v]));

describe('buildEveLaneViews — lane axis (Lokal · EVE Free · EVE Pro)', () => {
  it('TRIAL/free user: Lokal + EVE Free selectable, EVE Pro LOCKED (shown, greyed)', () => {
    const v = byLane(buildEveLaneViews({ trial_ends_at: '2026-12-31T00:00:00Z' }));
    expect(v.local.state).toBe('available');
    expect(v.local.items.every((i) => !i.disabled)).toBe(true);

    expect(v.free.state).toBe('available');
    expect(v.free.items.length).toBeGreaterThan(0);
    expect(v.free.items.every((i) => !i.disabled)).toBe(true);

    expect(v.pro.state).toBe('locked');
    // Pro is SHOWN (items present) but every strength is greyed.
    expect(v.pro.items.length).toBeGreaterThan(0);
    expect(v.pro.items.every((i) => i.disabled && i.disabledReasonCode === 'PAID_TIER_REQUIRED')).toBe(true);
  });

  it('PAYING user (no trial_ends_at): EVE Free HIDDEN, EVE Pro available + selectable', () => {
    const v = byLane(buildEveLaneViews({}));
    expect(v.local.state).toBe('available');
    expect(v.free.state).toBe('hidden');
    expect(v.pro.state).toBe('available');
    expect(v.pro.items.length).toBeGreaterThan(0);
    expect(v.pro.items.every((i) => !i.disabled)).toBe(true);
  });

  it('accents are stable per lane (grey/blue/gold)', () => {
    const v = byLane(buildEveLaneViews({ trial_ends_at: '2026-12-31T00:00:00Z' }));
    expect(v.local.accent).toBe('grey');
    expect(v.free.accent).toBe('blue');
    expect(v.pro.accent).toBe('gold');
  });

  it('does not change wire values — lane items reuse the existing selection values', () => {
    const v = byLane(buildEveLaneViews({ trial_ends_at: '2026-12-31T00:00:00Z' }));
    // EVE Free carries the eve-standard selection verbatim (router contract intact).
    expect(v.free.items.some((i) => i.value === eveTierValue('eve-standard'))).toBe(true);
    expect(v.pro.items.some((i) => i.value === eveTierValue('eve-max'))).toBe(true);
    expect(v.local.items.some((i) => i.value === localTierValue('local-standard'))).toBe(true);
  });
});

describe('laneOfSelection', () => {
  it('maps a selection value back to its lane', () => {
    expect(laneOfSelection(localTierValue('local-standard'))).toBe('local');
    expect(laneOfSelection(eveTierValue('eve-standard'))).toBe('free');
    expect(laneOfSelection(eveTierValue('eve-high'))).toBe('free');
    expect(laneOfSelection(eveTierValue('eve-max'))).toBe('pro');
    expect(laneOfSelection(eveTierValue('eve-maximum'))).toBe('pro');
  });
});
