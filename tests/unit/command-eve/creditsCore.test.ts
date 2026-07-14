/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE credits core (Lane 3) — the load-bearing UX decisions, all pure:
 *
 *   (1) credit-math DISPLAY: meter model (%, free vs paid), value-receipt €/hours.
 *   (2) the WALL: 402 parse/detect, transparent math, DEFAULT-PACK selection
 *       (100 → 250 → largest), margin-invariant guard.
 *   (3) IDLE-SUPPRESSION: the wall surfaces only when a job is in-flight.
 *   (4) SPEND-CAP validation/normalization.
 *   (+) Day-0 onboarding gate, pricing rows (hidden Solo on churn).
 *
 * No Electron/fs/network — exactly the pattern of eveInferenceCore.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCreditMeterModel,
  buildSeatBillingStatus,
  buildValueReceiptModel,
  buildWallModel,
  CLIENT_SEAT_FROM_EUR,
  detectQuotaExhausted,
  detectDailyCapReached,
  DEFAULT_CREDIT_PACKS,
  isClientSeedSatisfied,
  isNearAllowanceWall,
  marginInvariantHolds,
  OWN_SEAT_EUR,
  packEffectiveCostPerCredit,
  parseQuotaExhaustedBody,
  RECURRING_TOP_UP_BONUS_FACTOR,
  selectDefaultPackIndex,
  shouldForceDayZeroOnboarding,
  shouldSurfaceQuotaWall,
  showsFreeActionMeter,
  validateSpendCapEur,
  type CreditPack,
  type CreditsStatus,
} from '@/common/config/creditsCore';

// NEW server billing model: the Starter grant is 60,000 credits (1 credit = 0.1 ct).
const STARTER_GRANT = 60_000;

function status(overrides: Partial<CreditsStatus> = {}): CreditsStatus {
  return {
    tier: 'starter',
    included_allowance_credits_remaining: STARTER_GRANT / 2, // half-used by default
    purchased_credits_remaining: 0,
    spend_cap_eur_cents: 0,
    free_actions_used_this_period: 0,
    free_cap: 40,
    period_start: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) credit-math display — meter model
// ---------------------------------------------------------------------------

describe('buildCreditMeterModel — allowance used fraction', () => {
  it('computes used fraction from grant minus remaining (Starter 60,000 grant)', () => {
    const remaining = STARTER_GRANT / 2;
    const m = buildCreditMeterModel(status({ tier: 'starter', included_allowance_credits_remaining: remaining }));
    // 60,000 grant, 30,000 left ⇒ 30,000 used ⇒ 0.5
    expect(m.allowanceUsedFraction).toBeCloseTo(0.5, 5);
    expect(m.isFree).toBe(false);
    expect(m.allowanceRemaining).toBe(remaining);
  });

  it('clamps used fraction to [0,1] when remaining exceeds the grant (top-up drift)', () => {
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: STARTER_GRANT + 99_999 }));
    expect(m.allowanceUsedFraction).toBe(0);
  });

  it('never goes negative and clamps to 1 when fully drained', () => {
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: 0 }));
    expect(m.allowanceUsedFraction).toBe(1);
  });

  it('free tier meters ACTIONS against the free cap, not credits', () => {
    // 1.6.2: the action metering owns the CREDIT-LESS free seat (a free seat
    // holding a balance is tank-referenced now) — zero the balances explicitly.
    const m = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 0,
        free_actions_used_this_period: 34,
        free_cap: 40,
      })
    );
    expect(m.isFree).toBe(true);
    expect(m.allowanceUsedFraction).toBeCloseTo(34 / 40, 5);
  });

  it('totalRemaining sums allowance + purchased', () => {
    const m = buildCreditMeterModel(
      status({ included_allowance_credits_remaining: 10_000, purchased_credits_remaining: 25_000 })
    );
    expect(m.totalRemaining).toBe(35_000);
  });
});

describe('isNearAllowanceWall — the ~85% trigger', () => {
  it('is true at/over 85% used (paid)', () => {
    // 9,000 of 60,000 remaining ⇒ 51,000 used ⇒ 0.85
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: 9_000 }));
    expect(m.allowanceUsedFraction).toBeGreaterThanOrEqual(0.85);
    expect(isNearAllowanceWall(m)).toBe(true);
  });

  it('is false well under threshold', () => {
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: 50_000 }));
    expect(isNearAllowanceWall(m)).toBe(false);
  });

  it('respects the free-tier action cap', () => {
    const near = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 0,
        free_actions_used_this_period: 38,
        free_cap: 40,
      })
    );
    expect(isNearAllowanceWall(near)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (1) credit-math display — value receipt
// ---------------------------------------------------------------------------

describe('buildValueReceiptModel — €-value framing', () => {
  it('monetizes hours × rate and rounds € to the nearest 10', () => {
    const r = buildValueReceiptModel({ artifact: '32 ad variants', estimatedHours: 3.6, hourlyRateEur: 90 });
    expect(r.hours).toBe(4); // rounded
    expect(r.eurValue).toBe(360); // 4 * 90 = 360
    expect(r.headline).toContain('32 ad variants');
    expect(r.headline).toContain('~4h');
    expect(r.headline).toContain('~360€');
  });

  it('floors hours to a minimum of 1 so it never reads ~0h', () => {
    const r = buildValueReceiptModel({ artifact: 'a brief', estimatedHours: 0.2, hourlyRateEur: 100 });
    expect(r.hours).toBe(1);
    expect(r.eurValue).toBe(100);
  });

  it('falls back to a default rate when given a non-positive rate', () => {
    const r = buildValueReceiptModel({ artifact: 'x', estimatedHours: 2, hourlyRateEur: 0 });
    expect(r.eurValue).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (2) the WALL — 402 parse/detect
// ---------------------------------------------------------------------------

describe('parseQuotaExhaustedBody', () => {
  it('parses a well-formed body', () => {
    const body = parseQuotaExhaustedBody({
      error: 'quota_exhausted',
      credits_needed: 12,
      packs: [{ eur: 100, credits: 100, bonus: 8 }],
    });
    expect(body).not.toBeNull();
    expect(body?.credits_needed).toBe(12);
    expect(body?.packs).toHaveLength(1);
  });

  it('rejects a non-quota body', () => {
    expect(parseQuotaExhaustedBody({ error: 'rate_limited' })).toBeNull();
    expect(parseQuotaExhaustedBody(null)).toBeNull();
    expect(parseQuotaExhaustedBody('nope')).toBeNull();
  });

  it('drops malformed packs but keeps valid ones', () => {
    const body = parseQuotaExhaustedBody({
      error: 'quota_exhausted',
      credits_needed: 5,
      packs: [{ eur: 50, credits: 50 }, { eur: 'x' }, null, { credits: 1 }],
    });
    expect(body?.packs).toHaveLength(1);
    expect(body?.packs[0]).toEqual({ eur: 50, credits: 50, bonus: 0 });
  });
});

describe('detectQuotaExhausted — from a thrown inference error', () => {
  it('recovers a preserved structured body on error.body', () => {
    const err = { status: 402, body: { error: 'quota_exhausted', credits_needed: 7, packs: [] } };
    const parsed = detectQuotaExhausted(err);
    expect(parsed?.credits_needed).toBe(7);
  });

  it('recovers a body embedded in the message string', () => {
    const err = new Error('402 quota_exhausted {"error":"quota_exhausted","credits_needed":9,"packs":[]}');
    const parsed = detectQuotaExhausted(err);
    expect(parsed?.credits_needed).toBe(9);
  });

  it('returns a minimal body for a 402 quota message without JSON', () => {
    const parsed = detectQuotaExhausted({ status: 402, message: 'quota_exhausted' });
    expect(parsed).not.toBeNull();
    expect(parsed?.credits_needed).toBe(0);
  });

  it('returns null for a non-quota error', () => {
    expect(detectQuotaExhausted(new Error('network down'))).toBeNull();
    expect(detectQuotaExhausted({ status: 500 })).toBeNull();
    expect(detectQuotaExhausted(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (2) the WALL — default-pack selection
// ---------------------------------------------------------------------------

describe('selectDefaultPackIndex — 100 → 250 → largest', () => {
  const packs: CreditPack[] = [
    { eur: 25, credits: 25, bonus: 0 },
    { eur: 50, credits: 50, bonus: 0 },
    { eur: 100, credits: 100, bonus: 8 },
    { eur: 250, credits: 250, bonus: 38 },
  ];

  it('defaults to the 100€ pack when present', () => {
    expect(selectDefaultPackIndex(packs)).toBe(2);
  });

  it('falls back to the 250€ pack when no 100€ pack', () => {
    const noHundred = packs.filter((p) => p.eur !== 100);
    const idx = selectDefaultPackIndex(noHundred);
    expect(noHundred[idx].eur).toBe(250);
  });

  it('falls back to the largest pack by total credits when neither 100 nor 250', () => {
    const small: CreditPack[] = [
      { eur: 25, credits: 25, bonus: 0 },
      { eur: 50, credits: 50, bonus: 0 },
    ];
    const idx = selectDefaultPackIndex(small);
    expect(small[idx].eur).toBe(50);
  });

  it('returns -1 for an empty pack list', () => {
    expect(selectDefaultPackIndex([])).toBe(-1);
  });

  it('skips a margin-negative pack when a raw cost is supplied', () => {
    // raw cost 0.9 €/credit; a 100-pack giving 200 credits = 0.5 €/credit is BELOW raw
    // (margin-negative) and must NOT be default-selected; the 250 pack at 0.87 holds.
    const risky: CreditPack[] = [
      { eur: 100, credits: 180, bonus: 20 }, // 0.5 €/credit — below raw 0.9 ⇒ ineligible
      { eur: 250, credits: 250, bonus: 38 }, // 0.868 €/credit — below 0.9 too here
      { eur: 50, credits: 50, bonus: 0 }, // 1.0 €/credit — ABOVE raw ⇒ the only eligible
    ];
    const idx = selectDefaultPackIndex(risky, 0.9);
    expect(risky[idx].eur).toBe(50);
  });
});

describe('buildWallModel — transparent credit math', () => {
  it('computes "M more jobs like this" per pack from credits_needed', () => {
    const wall = buildWallModel({
      error: 'quota_exhausted',
      credits_needed: 8,
      packs: [
        { eur: 100, credits: 100, bonus: 8 }, // 108 / 8 = 13 jobs
        { eur: 250, credits: 250, bonus: 38 }, // 288 / 8 = 36 jobs
      ],
    });
    expect(wall.creditsNeeded).toBe(8);
    const hundred = wall.packs.find((p) => p.eur === 100)!;
    expect(hundred.jobsLikeThis).toBe(13);
    expect(hundred.isDefaultSelected).toBe(true); // 100-pack is default
    const twoFifty = wall.packs.find((p) => p.eur === 250)!;
    expect(twoFifty.jobsLikeThis).toBe(36);
    expect(twoFifty.isDefaultSelected).toBe(false);
  });

  it('falls back to the default catalog when the 402 body carries no packs', () => {
    const wall = buildWallModel({ error: 'quota_exhausted', credits_needed: 5, packs: [] });
    expect(wall.packs).toHaveLength(DEFAULT_CREDIT_PACKS.length);
    expect(wall.packs.some((p) => p.isDefaultSelected)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (2) margin invariant
// ---------------------------------------------------------------------------

describe('marginInvariant — effective €/credit must exceed raw cost', () => {
  it('packEffectiveCostPerCredit divides price by total (base + bonus) credits', () => {
    expect(packEffectiveCostPerCredit({ eur: 100, credits: 100, bonus: 8 })).toBeCloseTo(100 / 108, 5);
  });

  it('holds when effective price is above raw cost', () => {
    expect(marginInvariantHolds({ eur: 100, credits: 100, bonus: 8 }, 0.5)).toBe(true);
  });

  it('fails when bonus pushes effective price below raw cost', () => {
    expect(marginInvariantHolds({ eur: 100, credits: 100, bonus: 200 }, 0.5)).toBe(false);
  });

  it('the default catalog holds the margin invariant at the recurring +20% bonus', () => {
    // GEN-B: recurring top-ups grant +20% (server TOP_UP_BONUS_FACTOR=1.2), so each
    // pack delivers N×1000 face + 20% bonus. Effective €/credit = eur/(1.2 × N×1000)
    // = 0.001/1.2 ≈ 0.000833. The raw at-cost per credit is sub-cent (margin is
    // taken at CONSUMPTION via the tier factors), so any raw below ~0.000833 clears
    // the invariant even WITH the bonus.
    const rawSubCent = 0.0005; // below the bonus-effective 0.000833 €/credit
    for (const pack of DEFAULT_CREDIT_PACKS) {
      expect(packEffectiveCostPerCredit(pack)).toBeCloseTo(0.001 / 1.2, 6);
      expect(pack.bonus).toBeGreaterThan(0);
      expect(marginInvariantHolds(pack, rawSubCent)).toBe(true);
    }
  });

  it('the default catalog ships the RECURRING packs: N€ → N×1000 credits + 20% bonus', () => {
    expect(RECURRING_TOP_UP_BONUS_FACTOR).toBe(0.2);
    expect(DEFAULT_CREDIT_PACKS.map((p) => [p.eur, p.credits, p.bonus])).toEqual([
      [25, 25_000, 5_000],
      [50, 50_000, 10_000],
      [100, 100_000, 20_000],
      [250, 250_000, 50_000],
    ]);
    // Each bonus is exactly 20% of the face-value credits.
    for (const pack of DEFAULT_CREDIT_PACKS) {
      expect(pack.bonus).toBe(pack.credits * RECURRING_TOP_UP_BONUS_FACTOR);
    }
  });
});

// ---------------------------------------------------------------------------
// (3) idle-suppression
// ---------------------------------------------------------------------------

describe('shouldSurfaceQuotaWall — idle suppression', () => {
  it('surfaces only when a job is in-flight AND there is a quota signal', () => {
    expect(shouldSurfaceQuotaWall({ jobInFlight: true, hasQuotaSignal: true })).toBe(true);
  });

  it('suppresses when idle (no in-flight job) even with a quota signal', () => {
    expect(shouldSurfaceQuotaWall({ jobInFlight: false, hasQuotaSignal: true })).toBe(false);
  });

  it('suppresses when there is no quota signal', () => {
    expect(shouldSurfaceQuotaWall({ jobInFlight: true, hasQuotaSignal: false })).toBe(false);
    expect(shouldSurfaceQuotaWall({ jobInFlight: false, hasQuotaSignal: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (4) spend-cap validation
// ---------------------------------------------------------------------------

describe('validateSpendCapEur', () => {
  it('treats 0 / null / undefined as uncapped', () => {
    expect(validateSpendCapEur(0)).toEqual({ ok: true, eurCents: 0 });
    expect(validateSpendCapEur(null)).toEqual({ ok: true, eurCents: 0 });
    expect(validateSpendCapEur(undefined)).toEqual({ ok: true, eurCents: 0 });
  });

  it('normalizes euros to integer cents', () => {
    expect(validateSpendCapEur(250)).toEqual({ ok: true, eurCents: 25000 });
    expect(validateSpendCapEur(49.99)).toEqual({ ok: true, eurCents: 4999 });
  });

  it('rejects negatives', () => {
    const r = validateSpendCapEur(-5);
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('NEGATIVE');
  });

  it('rejects absurdly large caps', () => {
    const r = validateSpendCapEur(2_000_000);
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('ABOVE_MAX');
  });

  it('rejects NaN', () => {
    const r = validateSpendCapEur(Number.NaN);
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('NOT_INTEGER');
  });
});

// ---------------------------------------------------------------------------
// (+) Day-0 onboarding gate
// ---------------------------------------------------------------------------

describe('Day-0 onboarding gate', () => {
  it('a whitespace-only seed does not satisfy the requirement', () => {
    expect(isClientSeedSatisfied({ kind: 'paste_brief', value: '   ' })).toBe(false);
    expect(isClientSeedSatisfied({ kind: 'paste_brief', value: 'real brief' })).toBe(true);
    expect(isClientSeedSatisfied(null)).toBe(false);
  });

  it('forces onboarding only when not already seeded and no real seed yet', () => {
    expect(shouldForceDayZeroOnboarding({ alreadySeeded: false, seed: null })).toBe(true);
    expect(shouldForceDayZeroOnboarding({ alreadySeeded: true, seed: null })).toBe(false);
    expect(shouldForceDayZeroOnboarding({ alreadySeeded: false, seed: { kind: 'paste_brief', value: 'brief' } })).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// (+) Gen-B seat billing — free own seat + client-seat expansion
// ---------------------------------------------------------------------------

describe('buildSeatBillingStatus — Gen-B 0€-forever own seat + client-seat from 99€', () => {
  it('the free tier is the 0€-forever own seat', () => {
    const s = buildSeatBillingStatus({ tier: 'free' });
    expect(s.isFreeOwnSeat).toBe(true);
    expect(s.ownSeatEur).toBe(OWN_SEAT_EUR);
    expect(s.ownSeatEur).toBe(0);
    expect(s.clientSeatFromEur).toBe(CLIENT_SEAT_FROM_EUR);
    expect(s.clientSeatFromEur).toBe(99);
  });

  it('a paid tier (starter/solo) is NOT the free own seat but still shows the 99€ client floor', () => {
    for (const tier of ['starter', 'solo'] as const) {
      const s = buildSeatBillingStatus({ tier });
      expect(s.isFreeOwnSeat).toBe(false);
      expect(s.clientSeatFromEur).toBe(99);
    }
  });
});

describe('detectDailyCapReached — the free 429 daily-cap wall (v1.6.x)', () => {
  it('matches the structured shim type eve_daily_cap (flat + nested)', () => {
    expect(detectDailyCapReached({ type: 'eve_daily_cap' })).toEqual({ reached: true });
    expect(detectDailyCapReached({ error: { type: 'eve_daily_cap' } })).toEqual({ reached: true });
    expect(detectDailyCapReached({ response: { data: { type: 'eve_daily_cap' } } })).toEqual({ reached: true });
  });

  it('matches a flattened string carrying the marker or a 429 + cap wording', () => {
    expect(detectDailyCapReached('error type eve_daily_cap')).toEqual({ reached: true });
    expect(detectDailyCapReached({ status: 429, message: 'Tageskontingent erreicht' })).toEqual({ reached: true });
    expect(detectDailyCapReached({ message: '429 daily limit hit' })).toEqual({ reached: true });
  });

  it('does NOT match a 402 credits exhaust (detectQuotaExhausted owns that) or generic errors', () => {
    expect(detectDailyCapReached({ status: 402, message: 'quota_exhausted' })).toBeNull();
    expect(detectDailyCapReached({ status: 500, message: 'boom' })).toBeNull();
    expect(detectDailyCapReached({ status: 429, message: 'too many requests' })).toBeNull();
    expect(detectDailyCapReached(null)).toBeNull();
    expect(detectDailyCapReached('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1.6.2 — showsFreeActionMeter: free WITH balance renders the TANK
// ---------------------------------------------------------------------------

describe('1.6.2 — showsFreeActionMeter (free seat with a balance shows the tank)', () => {
  it('genuinely credit-less free seat → free action view', () => {
    const m = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 0,
        free_actions_used_this_period: 3,
        free_cap: 100,
      })
    );
    expect(m.isFree).toBe(true);
    expect(showsFreeActionMeter(m)).toBe(true);
  });

  it('free seat HOLDING purchased credits (M6 pack / manual grant) → non-free tank view, never the action meter', () => {
    // The live incident 2026-07-03: tier resolved 'free' while 35k purchased
    // credits were on the balance — every surface hid the paid-for tank.
    const m = buildCreditMeterModel(
      status({ tier: 'free', included_allowance_credits_remaining: 0, purchased_credits_remaining: 35_516 })
    );
    expect(m.tier).toBe('starter');
    expect(m.isFree).toBe(false);
    expect(showsFreeActionMeter(m)).toBe(false);
  });

  it('paid tiers never show the free action view', () => {
    const m = buildCreditMeterModel(status({ tier: 'starter' }));
    expect(showsFreeActionMeter(m)).toBe(false);
  });
});

describe('1.6.2 — tank-referenced fraction + wall for free WITH balance (review finding)', () => {
  it('free seat with a balance meters the TANK, not the daily actions', () => {
    // Incident shape: daily actions AT the cap, 35k credits in the tank — the
    // badge must NOT read "100% used"/warn-red beside a full tank.
    const m = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 35_516,
        free_actions_used_this_period: 100,
        free_cap: 100,
      })
    );
    expect(m.allowanceUsedFraction).toBeLessThan(0.85); // tank-referenced (starter grant)
    expect(isNearAllowanceWall(m)).toBe(false);
  });

  it('credit-less free seat keeps the action-based fraction + wall', () => {
    const m = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 0,
        free_actions_used_this_period: 90,
        free_cap: 100,
      })
    );
    expect(m.allowanceUsedFraction).toBeCloseTo(0.9, 5);
    expect(isNearAllowanceWall(m)).toBe(true);
  });

  it('free seat with a NEARLY DRAINED tank warns on the tank fraction', () => {
    const m = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 3_000,
        free_actions_used_this_period: 0,
        free_cap: 100,
      })
    );
    expect(m.allowanceUsedFraction).toBeGreaterThanOrEqual(0.85);
    expect(isNearAllowanceWall(m)).toBe(true);
  });
});
