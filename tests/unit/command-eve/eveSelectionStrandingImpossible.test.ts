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
 * ROUND-4 RE-EVALUATION (with the fixtures repaired — see ENTITLEMENTS below).
 * The round-3 "unreachable" verdict was reached with fixtures that could not have
 * disproved it, so it was re-run against PRODUCTION-COMPLETE views spanning both
 * credit answers, a trialing seat and the comped pilot edition. The verdict HOLDS,
 * and for a structural reason rather than a lucky fixture: `eve-standard` declares
 * `paidOnly: false`, and `isEveTierSelectable` returns TRUE for a non-paidOnly rung
 * before it ever consults the entitlement — so no entitlement, however poor, can
 * disable it. The offered set is exactly {standard, max}, so "disabled and not MAX"
 * still has no inhabitant, and the deleted effect stays deleted. What changed is
 * that the two sabotages below now genuinely redden this file (2/4 and 1/4), where
 * before they reddened nothing.
 *
 * NAMING: `.test.ts` — the vitest `node` project takes `tests/unit/**\/*.test.ts`.
 * No DOM is needed; both invariants are pure data.
 */

import { describe, expect, it } from 'vitest';
import { isPaidPlanForSeat } from '@/common/config/creditsCore';
import {
  buildEveEntitlementView,
  buildEvePickerGroups,
  EVE_INFERENCE_MAX_TIER_ID,
  EVE_INFERENCE_TIERS,
  eveTierValue,
  isEveInferenceSelection,
  migrateLegacyEveSelection,
  type EveEntitlementView,
} from '@/common/config/eveInferenceCore';

/**
 * THE FIXTURES ARE PRODUCTION-BUILT, AND THAT REPAIR IS THE POINT OF THIS ROUND.
 *
 * They used to be hand-typed partials — `{}`, `{ has_purchased_credits: true }` —
 * which omitted `metered_credit_access_known`, a field the hook ALWAYS supplies
 * (it is `creditsStatus?.ok === true`, never absent). With it missing, every
 * fixture fell into `hasEvePaidInferenceAccess`'s compatibility branch for an
 * unavailable credits endpoint and read FUNDED. So both sabotages this file
 * advertises — making Standard `paidOnly`, and adding a paid-only offered rung —
 * changed NOTHING: the file passed sabotaged and unsabotaged alike, which is the
 * defect class this remediation exists to end.
 *
 * So the views are now built by the SAME constructor the hook calls, from the two
 * real transports (entitlement status + credits status). A signal the product adds
 * tomorrow lands in these fixtures with no edit here, and a fixture can no longer
 * be a view of a program that does not ship.
 */
const ENTITLEMENTS: Array<{ name: string; view: EveEntitlementView }> = (
  [
    // The UNKNOWN window: entitled, but the credits read is NOT authoritative.
    // This is the ONLY shape in which `metered_credit_access_known` is false.
    {
      name: 'nothing known (the UNKNOWN window)',
      status: { ok: true, state: 'entitled' },
      credits: { ok: false, tier: 'free' },
    },
    // Every shape below is ANSWERED (`credits.ok === true`), poorest to richest.
    {
      name: 'authoritatively unentitled',
      status: { ok: true, state: 'entitled', has_paid_seat: false },
      credits: { ok: true, tier: 'free' },
    },
    {
      name: 'trialing on a promotional allowance',
      status: { ok: true, state: 'entitled', trial_ends_at: '2099-01-01T00:00:00Z' },
      credits: { ok: true, tier: 'trial', included_allowance_credits_remaining: 12_000 },
    },
    {
      name: 'purchased credits',
      status: { ok: true, state: 'entitled' },
      credits: { ok: true, tier: 'free', purchased_credits_remaining: 5_000 },
    },
    {
      name: 'paid seat',
      status: { ok: true, state: 'entitled', has_paid_seat: true },
      credits: { ok: true, tier: 'free' },
    },
    {
      name: 'paid plan',
      status: { ok: true, state: 'entitled', edition: 'standard' },
      credits: { ok: true, tier: 'starter' },
    },
    // The comped ALOIS100 pilot: a starter ALLOWANCE without a bought plan.
    {
      name: 'comped pilot seat (starter allowance, pilot edition)',
      status: { ok: true, state: 'entitled', edition: 'pilot' },
      credits: { ok: true, tier: 'starter' },
    },
  ] as const
).map((row) => ({ name: row.name, view: buildEveEntitlementView(row.status, row.credits, isPaidPlanForSeat) }));

/** The fixture set must actually EXERCISE both answers, or the sweep proves nothing. */
const ANSWER_STATES = new Set(ENTITLEMENTS.map((e) => e.view.metered_credit_access_known));

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
  it('INVARIANT 0: the fixtures are PRODUCTION-COMPLETE and cover BOTH credit answers', () => {
    // The guard on the repair itself. If a future edit drops back to hand-typed
    // partials, or the fixture set stops covering the authoritative answer, the
    // two invariants below go inert again — silently — exactly as they were.
    expect(ANSWER_STATES, 'fixtures must span the unknown AND the answered credits read').toEqual(
      new Set([false, true])
    );
    for (const { name, view } of ENTITLEMENTS) {
      for (const field of [
        'has_active_topup',
        'has_metered_credits',
        'metered_credit_access_known',
        'has_paid_plan',
        'has_purchased_credits',
      ] as const) {
        expect(typeof view[field], `${name} is missing the always-supplied ${field}`).toBe('boolean');
      }
    }
  });

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
