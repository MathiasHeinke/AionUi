/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE FREE LANE IS GONE — and this file is the INVERSION of what used to be here,
 * not its deletion.
 *
 * What this file asserted before 1.820.1:
 *   describe('buildEveLaneViews — lane axis (Lokal · EVE Free · EVE Pro)')
 *     · "EVE Free = exactly ONE model (DeepSeek V4 Flash), no cost badge, '· 100/Tag'"
 *     · expect(v.free.items[0].sublabel).toContain('100/Tag')
 *     · expect(laneOfSelection(eveTierValue('eve-standard'))).toBe('free')
 *
 * That last line is the whole finding in one assertion: the STANDARD cloud rung —
 * a metered, billable turn — classified as the FREE lane, asserted as a contract,
 * green on every run. Every cloud turn is credit-metered; Standard is INCLUDED in
 * the plan, which is not the same thing as free, and the difference is money.
 *
 * The lane model it tested was already dead code (nothing but this file imported
 * it; the rendered picker is `buildEvePickerGroups`), so it was deleted rather
 * than relabelled — a free-lane vocabulary nobody can see is one the next surface
 * picks up by accident.
 *
 * The assertions below are what remains true after the removal, stated so the case
 * still has a gate: the symbols are gone, and the picker the product ACTUALLY
 * renders has no free lane and no free-quota affordance in it.
 */

import { describe, expect, it } from 'vitest';

import * as eveInferenceCore from '@/common/config/eveInferenceCore';
import { buildEvePickerGroups, eveTierValue, EVE_INFERENCE_MAX_TIER_ID } from '@/common/config/eveInferenceCore';

describe('there is no free lane — the three-lane picker model is gone', () => {
  it('exports none of the free-lane symbols any more', () => {
    // Named individually, not counted: a count stays green while a symbol is
    // swapped for another, and it is the NAMES that carry the free-lane promise.
    for (const symbol of ['buildEveLaneViews', 'laneOfSelection', 'buildFreeLaneItems']) {
      expect(Object.keys(eveInferenceCore), `${symbol} must not come back`).not.toContain(symbol);
    }
  });

  it('the picker the product actually renders has exactly two cloud rungs, and neither is free', () => {
    // `buildEvePickerGroups` is what `useEveInferenceSelection` renders. The old
    // model would have put `eve-standard` on a lane literally called 'free'.
    const entitled = {
      trial_ends_at: null,
      has_paid_seat: true,
      has_metered_credits: true,
      metered_credit_access_known: true,
    };
    const groups = buildEvePickerGroups(entitled);
    const cloud = groups.find((group) => group.kind === 'eve');
    expect(cloud).toBeDefined();
    expect(cloud!.items).toHaveLength(2);

    const serialised = JSON.stringify(groups);
    for (const promise of ['100/Tag', 'Gratis', 'gratis', 'kostenlos', 'Free', 'free']) {
      expect(serialised, `the picker must not advertise "${promise}"`).not.toContain(promise);
    }
  });

  it('a trial seat sees the SAME two rungs — a trial is not a free lane either', () => {
    // The old model hid/showed the "EVE Free" lane depending on whether the seat
    // was paying, which is what made a free lane look like a real product tier.
    const trial = { trial_ends_at: '2030-01-01T00:00:00.000Z', has_metered_credits: true };
    const cloud = buildEvePickerGroups(trial).find((group) => group.kind === 'eve');
    expect(cloud!.items).toHaveLength(2);
    // ...and MAX is still LOCKED for it: promotional allowance funds Standard, never MAX.
    const max = cloud!.items.find((item) => item.value === eveTierValue(EVE_INFERENCE_MAX_TIER_ID));
    expect(max?.disabled).toBe(true);
  });
});
