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
  it('TRIAL/free user: Lokal + EVE Free selectable, EVE Pro LOCKED (every offered rung greyed)', () => {
    const v = byLane(buildEveLaneViews({ trial_ends_at: '2026-12-31T00:00:00Z' }));
    expect(v.local.state).toBe('available');
    expect(v.local.items.every((i) => !i.disabled)).toBe(true);

    expect(v.free.state).toBe('available');
    // EVE Free = exactly ONE model (DeepSeek V4 Flash), no cost badge, "· 100/Tag".
    expect(v.free.items).toHaveLength(1);
    expect(v.free.items[0].disabled).toBe(false);
    expect(v.free.items[0].costBadge).toBeUndefined();
    expect(v.free.items[0].sublabel).toContain('100/Tag');

    expect(v.pro.state).toBe('locked');
    // EVE Pro = the OFFERED rungs only (Standard · MAX), both greyed on a trial.
    expect(v.pro.items).toHaveLength(2);
    expect(v.pro.items.every((i) => i.disabled && i.disabledReasonCode === 'PAID_TIER_REQUIRED')).toBe(true);
    expect(v.pro.items.map((i) => i.label)).toEqual(['Standard', 'MAX']);
  });

  it('the FREE lane is derived from the OFFER, not from a raw registry scan (latent defect closed)', () => {
    // It used to filter the FULL registry by `!paidOnly`, so any future
    // free-eligible rung the server had not been taught would have been offered
    // here and refused on every turn. It now shares the picker's derived list.
    const v = byLane(buildEveLaneViews({ trial_ends_at: '2026-12-31T00:00:00Z' }));
    const offeredValues = v.pro.items.map((i) => i.value);
    for (const item of v.free.items) {
      expect(offeredValues).toContain(item.value);
    }
    expect(v.free.items.map((i) => i.value)).toEqual([eveTierValue('eve-standard')]);
  });

  it('PURCHASED seat: EVE Free HIDDEN, both offered rungs selectable', () => {
    const v = byLane(buildEveLaneViews({ trial_ends_at: null, has_paid_seat: true }));
    expect(v.local.state).toBe('available');
    expect(v.free.state).toBe('hidden');
    expect(v.pro.state).toBe('available');
    expect(v.pro.items).toHaveLength(2);
    expect(v.pro.items.every((i) => !i.disabled)).toBe(true);
    // Relative cost is surfaced as a badge on every Pro rung.
    expect(v.pro.items.every((i) => typeof i.costBadge === 'string')).toBe(true);
  });

  it('per-rung gating: a promotional-credit seat gets Pro open but MAX still LOCKED', () => {
    // The lane state is not one flag any more — MAX keys on the stricter
    // purchase gate, so an allowance-funded seat sees the cheap rung open and
    // the strong lane greyed with the upsell reason.
    const v = byLane(
      buildEveLaneViews({
        trial_ends_at: null,
        has_metered_credits: true,
        metered_credit_access_known: true,
        has_purchased_credits: false,
      })
    );
    expect(v.pro.state).toBe('available');
    const byValue = Object.fromEntries(v.pro.items.map((i) => [i.value, i]));
    expect(byValue[eveTierValue('eve-standard')].disabled).toBe(false);
    expect(byValue[eveTierValue('eve-max')].disabled).toBe(true);
    expect(byValue[eveTierValue('eve-max')].disabledReasonCode).toBe('PAID_TIER_REQUIRED');
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
    // The retired rung is never offered as a lane item.
    expect(v.pro.items.some((i) => i.value === eveTierValue('eve-ultra'))).toBe(false);
    expect(v.local.items.some((i) => i.value === localTierValue('local-standard'))).toBe(true);
  });
});

describe('laneOfSelection', () => {
  it('maps a selection value back to its lane', () => {
    expect(laneOfSelection(localTierValue('local-standard'))).toBe('local');
    // eve-standard is the free-eligible rung (the Free lane + Pro "Standard").
    expect(laneOfSelection(eveTierValue('eve-standard'))).toBe('free');
    // MAX is paid → Pro.
    expect(laneOfSelection(eveTierValue('eve-max'))).toBe('pro');
    // A legacy rung reports the lane it MIGRATES to, not the one it used to be:
    // eve-high lands on Standard (free), eve-xhigh/eve-ultra land on MAX (pro).
    expect(laneOfSelection(eveTierValue('eve-high'))).toBe('free');
    expect(laneOfSelection(eveTierValue('eve-xhigh'))).toBe('pro');
    expect(laneOfSelection(eveTierValue('eve-ultra'))).toBe('pro');
  });
});
