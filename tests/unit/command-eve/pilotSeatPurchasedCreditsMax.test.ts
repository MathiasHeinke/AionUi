/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FOUNDER RULING (CEVE-18205/1.820.5): PURCHASED CREDITS OVERRIDE THE `pilot`
 * EDITION FOR MAX.
 *
 *   "Wenn ein Seat reale gekaufte Credits > 0 hat (nicht comped, nicht trial),
 *    soll die Edition `pilot` NICHT mehr MAX blockieren … Comped/100%-Seats und
 *    Trial bleiben ausgeschlossen. Der Trigger ist 'purchased credits > 0',
 *    NICHT 'hat überhaupt Credits'."
 *
 * THIS FILE ADDS NO POLICY. It PINS the ruling against the code that already
 * implements it, because the obvious way to "apply" the ruling — adding `pilot`
 * to `PAID_SEAT_EDITIONS` — would break the ruling's own exclusion clause.
 *
 * WHY. The MAX gate is `hasEveMaxAccess`, and it has three independent unlocks:
 * `has_paid_seat`, `has_paid_plan`, `has_purchased_credits`. Only the SECOND
 * consults `isPaidPlanForSeat(tier, edition)` — the allowlist `pilot` is absent
 * from. The THIRD is `purchased_credits_remaining > 0`, which is exactly the
 * ruling's trigger and does not look at the edition at all. The 1.820.1 ruling
 * recorded in `creditsCore.ts` already said so in its last line: a pilot seat
 * "NEVER gets MAX **without genuinely purchased credits** or an explicitly paid
 * plan."
 *
 * The harm the obvious change would do is concrete, and the first case below is
 * the proof: an ALOIS100 0 € `pilot` seat is seeded the STARTER allowance, so it
 * reports `tier: 'starter'`. Putting `pilot` on the paid-edition allowlist would
 * make `isPaidPlanForSeat('starter', 'pilot')` true and hand MAX to every comped
 * seat with zero purchased credits — the case the ruling explicitly excludes.
 *
 * So the ruling is enforced HERE, as tests, rather than by a production edit that
 * would contradict it.
 */

import { describe, expect, it } from 'vitest';
import { isPaidPlanForSeat, PAID_SEAT_EDITIONS } from '@/common/config/creditsCore';
import { buildEveEntitlementView, hasEveMaxAccess } from '@/common/config/eveInferenceCore';

/** Build the view the picker and the persisted `maxEntitled` are derived from. */
function view(opts: {
  edition: string;
  tier: string;
  purchased: number;
  allowance?: number;
  trialEndsAt?: string;
  ok?: boolean;
}) {
  return buildEveEntitlementView(
    {
      edition: opts.edition,
      ...(opts.trialEndsAt === undefined ? {} : { trial_ends_at: opts.trialEndsAt }),
    },
    {
      ok: opts.ok ?? true,
      tier: opts.tier,
      purchased_credits_remaining: opts.purchased,
      included_allowance_credits_remaining: opts.allowance ?? 0,
    },
    isPaidPlanForSeat
  );
}

describe('the ruling: purchased credits > 0 override the pilot edition', () => {
  it('a pilot seat WITH purchased credits gets MAX', () => {
    // The Mathias seat after the founder top-up: edition still `pilot`, real
    // bought credits on the ledger.
    const v = view({ edition: 'pilot', tier: 'starter', purchased: 2500 });
    expect(v.has_purchased_credits).toBe(true);
    expect(hasEveMaxAccess(v)).toBe(true);
  });

  it('…and it is the PURCHASED bucket that does it, not the edition allowlist', () => {
    // The load-bearing distinction: the edition is still NOT a paid seat edition.
    // If someone "fixes" the ruling by widening that allowlist, this assertion is
    // the one that should stop them.
    const v = view({ edition: 'pilot', tier: 'starter', purchased: 2500 });
    expect(v.has_paid_plan).toBe(false);
    expect(PAID_SEAT_EDITIONS).not.toContain('pilot');
  });
});

describe('the exclusions the ruling keeps', () => {
  it('a COMPED pilot seat (starter allowance, zero purchased) stays Standard', () => {
    // ALOIS100: seeded the starter allowance, so the TIER alone would say "paid".
    const v = view({ edition: 'pilot', tier: 'starter', purchased: 0, allowance: 5000 });
    expect(v.has_purchased_credits).toBe(false);
    expect(v.has_paid_plan).toBe(false);
    expect(hasEveMaxAccess(v)).toBe(false);
  });

  it('free start-credits are NOT the trigger — allowance never unlocks MAX', () => {
    // "Der Trigger ist 'purchased credits > 0', NICHT 'hat überhaupt Credits'."
    const v = view({ edition: 'pilot', tier: 'starter', purchased: 0, allowance: 100_000 });
    expect(v.has_metered_credits).toBe(true); // it CAN send on Standard…
    expect(hasEveMaxAccess(v)).toBe(false); // …and still gets no MAX.
  });

  it('a TRIAL seat without purchased credits stays Standard', () => {
    const v = view({ edition: 'pilot', tier: 'trial', purchased: 0, allowance: 5000, trialEndsAt: '2026-09-01' });
    expect(hasEveMaxAccess(v)).toBe(false);
  });

  it('an unreadable credits status cannot unlock MAX, whatever it claims', () => {
    // Fail-closed: `ok: false` makes every credits-derived signal unauthoritative.
    const v = view({ edition: 'pilot', tier: 'starter', purchased: 9999, ok: false });
    expect(v.has_purchased_credits).toBe(false);
    expect(hasEveMaxAccess(v)).toBe(false);
  });
});

describe('the paid editions are untouched by this ruling', () => {
  it('a standard seat on a paid tier still gets MAX with no purchased balance', () => {
    const v = view({ edition: 'standard', tier: 'starter', purchased: 0 });
    expect(v.has_paid_plan).toBe(true);
    expect(hasEveMaxAccess(v)).toBe(true);
  });
});
