/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WHY THE UNKNOWN-LANE FALLBACK IS GONE, PINNED AS A PROPERTY.
 *
 * `useEveInferenceSelection` carried an effect that reset a "stranded" EVE
 * selection to Standard, on two conditions:
 *
 *   isUnknownEve            — an EVE value that resolves to no lane in the model;
 *   isConfirmedUnfundedTier — an EVE lane present in the model but DISABLED.
 *
 * Its comment described it as the thing standing between a user and a silent
 * downgrade, and a sibling test file stated that deleting its guard would turn
 * cases red. Both claims were false: deleting the guard reddened 0 of 4486 tests,
 * and deleting the entire effect reddened 0 as well. It could not fire.
 *
 * That is not an accident of the tests — it is a PROPERTY of the core, and this
 * file is that property. Two invariants make both arms unreachable:
 *
 *   1. NORMALISATION IS TOTAL over the EVE prefix. `migrateLegacyEveSelection`
 *      maps ANY `command-eve-inference:*` string — retired, unknown, corrupt —
 *      onto the OFFERED surface, and `isEveInferenceSelection` is the very same
 *      prefix test. Every writer in the hook normalises before exposing, so an
 *      EVE selection outside `items` cannot be held.
 *   2. THE ONLY DISABLE-ABLE EVE ROW IS MAX, and MAX is deliberately exempt from
 *      the reset (an unfunded MAX keeps its intent while MAIN clamps the wire).
 *      So "present but disabled and not MAX" has no inhabitant.
 *
 * IF EITHER INVARIANT BREAKS — a third selectable EVE rung, a paid-only Standard,
 * a migration that leaves a value unresolved — THIS FILE GOES RED, and whoever
 * broke it has to bring back a reset that is gated on `authorityResolved`.
 * Deleting an assertion here is not a fix.
 *
 * NAMING: `.test.ts` — the vitest `node` project takes `tests/unit/**\/*.test.ts`.
 * No DOM is needed; both invariants are pure data.
 */

import { describe, expect, it } from 'vitest';
import {
  buildEvePickerGroups,
  EVE_INFERENCE_MAX_TIER_ID,
  EVE_INFERENCE_TIERS,
  eveTierValue,
  isEveInferenceSelection,
  migrateLegacyEveSelection,
  type EveEntitlementView,
} from '@/common/config/eveInferenceCore';

/** Every entitlement shape the hook can hand the model, poorest to richest. */
const ENTITLEMENTS: Array<{ name: string; view: EveEntitlementView }> = [
  { name: 'nothing known (the UNKNOWN window)', view: {} },
  { name: 'authoritatively unentitled', view: { has_paid_seat: false, has_paid_plan: false } },
  { name: 'purchased credits', view: { has_purchased_credits: true } },
  { name: 'paid seat', view: { has_paid_seat: true } },
  { name: 'paid plan', view: { has_paid_plan: true } },
];

/** Selections a real install can hold: every registry rung, plus junk on the same prefix. */
const EVE_SELECTIONS: string[] = [
  ...EVE_INFERENCE_TIERS.map((tier) => eveTierValue(tier.id)),
  'command-eve-inference:eve-maximum', // a wire id that was removed outright
  'command-eve-inference:eve-does-not-exist',
  'command-eve-inference:', // truncated write
  'command-eve-inference:../../etc/passwd', // hostile garbage on the prefix
];

const eveItems = (view: EveEntitlementView) =>
  buildEvePickerGroups(view).find((group) => group.kind === 'eve')?.items ?? [];

describe('an EVE selection can never be stranded (so no ungated reset is needed)', () => {
  it('INVARIANT 1: normalisation is TOTAL over the EVE prefix — every value lands in the model', () => {
    for (const { name, view } of ENTITLEMENTS) {
      const values = eveItems(view).map((item) => item.value);
      for (const raw of EVE_SELECTIONS) {
        // Exactly what the hook holds: the migration when there is one, else the input.
        const held = migrateLegacyEveSelection(raw) ?? raw;
        expect(isEveInferenceSelection(held), `${raw} left the EVE namespace`).toBe(true);
        expect(values, `${raw} is stranded outside the model under "${name}"`).toContain(held);
      }
    }
  });

  it('INVARIANT 2: MAX is the ONLY EVE row that can be disabled', () => {
    // The reset's second arm required a DISABLED eve row that is NOT MAX. If a rung
    // like that ever exists, an unfunded seat can hold a lane it may not use and
    // nothing resets it — bring back the gated reset.
    const maxValue = eveTierValue(EVE_INFERENCE_MAX_TIER_ID);
    for (const { name, view } of ENTITLEMENTS) {
      const disabled = eveItems(view)
        .filter((item) => item.disabled)
        .map((item) => item.value);
      for (const value of disabled) {
        expect(value, `a non-MAX EVE rung is disabled under "${name}"`).toBe(maxValue);
      }
    }
  });

  it('INVARIANT 2b: Standard is selectable for EVERY entitlement — including none at all', () => {
    // The non-brick floor. If Standard could be disabled, the "present but disabled
    // and not MAX" case would have an inhabitant AND a seat could be bricked.
    const standardValue = eveTierValue('eve-standard');
    for (const { name, view } of ENTITLEMENTS) {
      const standard = eveItems(view).find((item) => item.value === standardValue);
      expect(standard, `Standard missing from the offer under "${name}"`).toBeDefined();
      expect(standard?.disabled, `Standard is disabled under "${name}"`).toBe(false);
    }
  });
});
