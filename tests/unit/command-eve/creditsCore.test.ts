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
 *       (100 → 200 → largest), margin-invariant guard.
 *   (3) IDLE-SUPPRESSION: the wall surfaces only when a job is in-flight.
 *   (4) SPEND-CAP validation/normalization.
 *   (+) Day-0 onboarding gate, the ONE-PLAN billing status.
 *
 * THE PRICE CONTRACT THESE TESTS ENCODE (Founder ruling 1.820.1). Not the code —
 * the ruling. A 14-day / 100,000-credit trial that ends in an EXPLICIT decision;
 * then ONE subscription, "Standard", at 99 €/month including 100,000 credits and
 * EVERY seat at no per-seat charge; optional monthly top-ups at 25/50/100/200 €
 * sold at FACE VALUE. Deleted and guarded against here: the 99 €-per-CLIENT-SEAT
 * ladder, the +20 % purchase-time bonus, the 250 € pack, the 0 €-forever own-seat
 * promise, and the 79 € Starter / 49 € Solo plans.
 *
 * No Electron/fs/network — exactly the pattern of eveInferenceCore.test.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADDITIONAL_SEAT_EUR,
  buildCreditMeterModel,
  buildSeatBillingStatus,
  buildValueReceiptModel,
  buildWallModel,
  CREDITS_PER_EUR,
  detectQuotaExhausted,
  detectDailyCapReached,
  DEFAULT_CREDIT_PACKS,
  isClientSeedSatisfied,
  isNearAllowanceWall,
  marginInvariantHolds,
  packEffectiveCostPerCredit,
  parseQuotaExhaustedBody,
  selectDefaultPackIndex,
  shouldForceDayZeroOnboarding,
  shouldSurfaceQuotaWall,
  STANDARD_PLAN_EUR_PER_MONTH,
  STANDARD_PLAN_INCLUDED_CREDITS,
  TIER_ALLOWANCE_CREDITS,
  TRIAL_INCLUDED_CREDITS,
  TRIAL_LENGTH_DAYS,
  validateSpendCapEur,
  type CreditPack,
  type CreditsStatus,
} from '@/common/config/creditsCore';
import * as creditsCoreModule from '@/common/config/creditsCore';

// The ONE sold subscription's monthly grant (1 credit = 0.1 ct). `starter` is the
// WIRE name the server still reports for it; 1.820.1 raised the grant to 100,000.
const STANDARD_GRANT = 100_000;

function status(overrides: Partial<CreditsStatus> = {}): CreditsStatus {
  return {
    tier: 'starter',
    included_allowance_credits_remaining: STANDARD_GRANT / 2, // half-used by default
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
  it('computes used fraction from grant minus remaining (Standard 100,000 grant)', () => {
    const remaining = STANDARD_GRANT / 2;
    const m = buildCreditMeterModel(status({ tier: 'starter', included_allowance_credits_remaining: remaining }));
    // 100,000 grant, 50,000 left ⇒ 50,000 used ⇒ 0.5
    expect(m.allowanceUsedFraction).toBeCloseTo(0.5, 5);
    expect(m.isFree).toBe(false);
    expect(m.allowanceRemaining).toBe(remaining);
  });

  it('clamps used fraction to [0,1] when remaining exceeds the grant (top-up drift)', () => {
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: STANDARD_GRANT + 99_999 }));
    expect(m.allowanceUsedFraction).toBe(0);
  });

  it('never goes negative and clamps to 1 when fully drained', () => {
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: 0 }));
    expect(m.allowanceUsedFraction).toBe(1);
  });

  it('INVERTED: a credit-less seat reads as an EMPTY TANK, never as free actions used', () => {
    // This case used to assert `allowanceUsedFraction === 34/40` — the daily
    // ACTION counter driving the credit bar. That number is what let the UI say
    // "34 / 40 Gratis-Aktionen heute": a free allowance the product does not sell.
    // Every cloud turn is credit-metered (R1), so a seat with nothing left is at
    // 100% of what it had, and the anti-abuse counters do not enter the meter.
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
    expect(m.allowanceUsedFraction).toBe(1);
    // The counters are NOT on the view-model at all — a value the view cannot see
    // is a promise it cannot make.
    expect(m).not.toHaveProperty('freeActionsUsed');
    expect(m).not.toHaveProperty('freeCap');
    // ...and the fraction is INDEPENDENT of them: moving the counter must not move
    // the bar, which is the property the deleted branch violated.
    const other = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 0,
        free_actions_used_this_period: 0,
        free_cap: 40,
      })
    );
    expect(other.allowanceUsedFraction).toBe(m.allowanceUsedFraction);
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
    // 15,000 of 100,000 remaining ⇒ 85,000 used ⇒ 0.85
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: 15_000 }));
    expect(m.allowanceUsedFraction).toBeGreaterThanOrEqual(0.85);
    expect(isNearAllowanceWall(m)).toBe(true);
  });

  it('is false well under threshold', () => {
    const m = buildCreditMeterModel(status({ included_allowance_credits_remaining: 80_000 }));
    expect(isNearAllowanceWall(m)).toBe(false);
  });

  it('warns a credit-less seat on the EMPTY TANK, not on an action cap', () => {
    // Same seat, same verdict — reached honestly. The wall used to have a second
    // rule that compared `free_actions_used / free_cap`; there is no free action
    // budget to be near the end of.
    for (const used of [0, 38, 40]) {
      const near = buildCreditMeterModel(
        status({
          tier: 'free',
          included_allowance_credits_remaining: 0,
          purchased_credits_remaining: 0,
          free_actions_used_this_period: used,
          free_cap: 40,
        })
      );
      expect(isNearAllowanceWall(near), `action counter ${used} must not move the wall`).toBe(true);
    }
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

describe('selectDefaultPackIndex — 100 → 200 → largest', () => {
  const packs: CreditPack[] = [
    { eur: 25, credits: 25, bonus: 0 },
    { eur: 50, credits: 50, bonus: 0 },
    { eur: 100, credits: 100, bonus: 8 },
    { eur: 200, credits: 200, bonus: 38 },
  ];

  it('defaults to the 100€ pack when present', () => {
    expect(selectDefaultPackIndex(packs)).toBe(2);
  });

  it('falls back to the 200€ pack when no 100€ pack', () => {
    const noHundred = packs.filter((p) => p.eur !== 100);
    const idx = selectDefaultPackIndex(noHundred);
    expect(noHundred[idx].eur).toBe(200);
  });

  it('does NOT steer to the retired 250€ pack over a shipped 200€ one (1.820.1)', () => {
    // The retired second preference. A 250 the server still advertises may still
    // win — but only by being the LARGEST, never because the client keeps naming
    // it. Here 200 and 250 are both present and 200 has to win on the named rule.
    const withRetired: CreditPack[] = [
      { eur: 25, credits: 25_000, bonus: 0 },
      { eur: 200, credits: 200_000, bonus: 0 },
      { eur: 250, credits: 250_000, bonus: 0 },
    ];
    const idx = selectDefaultPackIndex(withRetired);
    expect(withRetired[idx].eur).toBe(200);
  });

  it('falls back to the largest pack by total credits when neither 100 nor 200', () => {
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
    // (margin-negative) and must NOT be default-selected; the 200 pack at 0.84 fails too.
    const risky: CreditPack[] = [
      { eur: 100, credits: 180, bonus: 20 }, // 0.5 €/credit — below raw 0.9 ⇒ ineligible
      { eur: 200, credits: 200, bonus: 38 }, // 0.840 €/credit — below 0.9 too here
      { eur: 50, credits: 50, bonus: 0 }, // 1.0 €/credit — ABOVE raw ⇒ the only eligible
    ];
    const idx = selectDefaultPackIndex(risky, 0.9);
    expect(risky[idx].eur).toBe(50);
  });
});

describe('buildWallModel — transparent credit math', () => {
  it('computes "M more jobs like this" per pack from credits_needed', () => {
    // THIS FIXTURE USED TO CARRY A 250 € PACK and assert its output as correct, in a
    // file whose own header lists "the 250 € pack" among the things it guards AGAINST.
    // A test that feeds a retired rung through the production wall model and calls the
    // result right is a committed statement that the rung is live — the exact defect
    // class this suite exists to catch, shipped inside the suite.
    //
    // The fixture is now built from rungs the product actually sells, at the FACE
    // value it sells them at (1 € = 1000 credits). The `bonus` field is still exercised
    // on one rung because the 402 body is the SERVER's to write and it stays
    // authoritative on the grant: if it ever advertises a bonus (a promo, a migration
    // credit) the wall must render what the buyer will actually receive.
    const wall = buildWallModel({
      error: 'quota_exhausted',
      credits_needed: 8,
      packs: [
        { eur: 100, credits: 100_000, bonus: 0 }, // 100000 / 8 = 12500 jobs
        { eur: 200, credits: 200_000, bonus: 8_000 }, // 208000 / 8 = 26000 jobs
      ],
    });
    expect(wall.creditsNeeded).toBe(8);
    const hundred = wall.packs.find((p) => p.eur === 100)!;
    expect(hundred.jobsLikeThis).toBe(12_500);
    expect(hundred.isDefaultSelected).toBe(true); // 100-pack is default
    const twoHundred = wall.packs.find((p) => p.eur === 200)!;
    expect(twoHundred.totalCredits).toBe(208_000); // a server-advertised bonus is rendered
    expect(twoHundred.jobsLikeThis).toBe(26_000);
    expect(twoHundred.isDefaultSelected).toBe(false);
  });

  it('every pack rung these tests exercise is one the product actually sells', () => {
    // The header of this file already CLAIMED the 250 € pack was guarded against; two
    // fixtures below that claim used it anyway, and nothing could report the
    // contradiction because no assertion read the file. This one does: every `eur:`
    // literal in this suite must be a rung in the shipped catalog, so a retired price
    // cannot re-enter as a test fixture — which is how the last one got in.
    //
    // NAMING A RETIRED RUNG IN ORDER TO REJECT IT IS LEGAL — asserting its output as
    // correct is not. That is the same distinction the web-copy gate draws between a
    // tombstone and an advertisement, and it needs the same escape hatch: an ALLOWLIST
    // of EXACT lines with a reason, so admitting one is a decision a reviewer can see
    // rather than a hole nobody notices. A stale entry reds too — an exemption that no
    // longer names a real line is exactly where the next retired fixture would hide.
    //
    // AN EXEMPTION CARRIES A BUDGET, NOT JUST A TEXT. A first cut of this allowlist
    // exempted any line whose text matched, and a sabotage run proved the hole
    // immediately: pasting the SAME line into the wall-model fixture — where its
    // output IS asserted as correct — kept the gate at 58 passed. Text-matching
    // exempts every copy, including the ones nobody reviewed. So each entry pins how
    // many times it may occur, and the count is asserted exactly: a second copy reds,
    // and so does a deletion that leaves a stale exemption behind.
    const REVIEWED_RETIRED_FIXTURES = [
      {
        line: '{ eur: 250, credits: 250_000, bonus: 0 },',
        times: 1,
        why: 'the rejection test above: 250 must NOT out-rank a shipped 200 in selectDefaultPackIndex',
      },
    ];
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const live = new Set(DEFAULT_CREDIT_PACKS.map((p) => p.eur));
    expect([...live].toSorted((a, b) => a - b)).toEqual([25, 50, 100, 200]);

    const lines = source.split('\n');
    for (const { line, times, why } of REVIEWED_RETIRED_FIXTURES) {
      const seen = lines.filter((l) => l.trim() === line).length;
      expect(
        seen,
        `the reviewed exemption "${line}" (${why}) is budgeted for ${times} occurrence(s) but the file has ` +
          `${seen}. ${seen === 0 ? 'Remove it rather than leaving a hole.' : 'A copy of an exempted fixture is not itself reviewed — the extra one must justify itself or go.'}`
      ).toBe(times);
    }

    let scanned = 0;
    const offenders: string[] = [];
    lines.forEach((raw, i) => {
      const trimmed = raw.trim();
      for (const m of raw.matchAll(/\beur:\s*([0-9_]+)/g)) {
        scanned += 1;
        const eur = Number(m[1].replace(/_/g, ''));
        if (live.has(eur)) continue;
        if (REVIEWED_RETIRED_FIXTURES.some((r) => r.line === trimmed)) continue;
        // …and the allowlist's own DECLARATION of that line, which necessarily quotes
        // it. Matched exactly (`line: '<entry>',`) rather than by prefix, so the
        // exemption cannot be used to smuggle a rung that is not already allowlisted.
        if (REVIEWED_RETIRED_FIXTURES.some((r) => trimmed === `line: '${r.line}',`)) continue;
        offenders.push(`line ${i + 1}: ${eur} € — ${trimmed}`);
      }
    });
    expect(scanned, 'the fixture scan found no pack rungs — the regex is broken, not the file').toBeGreaterThan(8);
    expect(
      offenders,
      `a retired pack rung is exercised as a fixture. The catalog is ` +
        `${[...live].toSorted((a, b) => a - b).join(' / ')} € — a rung the product cannot sell must not be ` +
        `asserted as correct. If it is being REJECTED on purpose, add the exact line to ` +
        `REVIEWED_RETIRED_FIXTURES with a reason.\n${offenders.join('\n')}`
    ).toEqual([]);
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

  it('the default catalog holds the margin invariant at FACE VALUE', () => {
    // Face-value packs deliver exactly N×1000 credits for N €, so the effective
    // price is exactly CREDIT_UNIT_EUR (0.001 €/credit) — the highest it can be,
    // because no bonus dilutes it. The raw at-cost per credit is sub-cent (margin
    // is taken at CONSUMPTION via the tier factors), so the invariant clears.
    const rawSubCent = 0.0005;
    for (const pack of DEFAULT_CREDIT_PACKS) {
      expect(packEffectiveCostPerCredit(pack)).toBeCloseTo(0.001, 6);
      expect(marginInvariantHolds(pack, rawSubCent)).toBe(true);
    }
  });

  it('the shipped catalog is 25/50/100/200 € at FACE VALUE, with NO purchase-time bonus', () => {
    // THE CONTRACT (Founder ruling 1.820.1), not the code: 1 € = 1,000 credits and
    // what the chip advertises is what the checkout grants. The retired table was
    // [[25,25k,+5k],[50,50k,+10k],[100,100k,+20k],[250,250k,+50k]] — a 250 € pack
    // that is no longer sold and a +20 % bonus that is no longer given.
    expect(DEFAULT_CREDIT_PACKS.map((p) => [p.eur, p.credits, p.bonus])).toEqual([
      [25, 25_000, 0],
      [50, 50_000, 0],
      [100, 100_000, 0],
      [200, 200_000, 0],
    ]);
    for (const pack of DEFAULT_CREDIT_PACKS) {
      expect(pack.credits, `${pack.eur}€ must be face value`).toBe(pack.eur * CREDITS_PER_EUR);
      expect(pack.bonus, `${pack.eur}€ must carry no purchase-time bonus`).toBe(0);
    }
    // The two retired prices, named so a re-introduction fails HERE and loudly.
    expect(DEFAULT_CREDIT_PACKS.some((p) => p.eur === 250)).toBe(false);
    expect(DEFAULT_CREDIT_PACKS.some((p) => p.bonus > 0)).toBe(false);
  });

  it('no purchase-time bonus FACTOR is exported any more — the catalog cannot be inflated by import', () => {
    // A structural assertion on the MODULE, mirroring the showsFreeActionMeter
    // guard below. `RECURRING_TOP_UP_BONUS_FACTOR = 0.2` multiplied every
    // advertised pack; re-exporting it is how "+20 %" would silently return to a
    // catalog that is contractually face value.
    expect(Object.keys(creditsCoreModule)).not.toContain('RECURRING_TOP_UP_BONUS_FACTOR');
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

describe('buildSeatBillingStatus — the ONE Standard subscription (1.820.1)', () => {
  // THIS BLOCK USED TO ASSERT THE SEAT LADDER: `isFreeOwnSeat` plus a
  // `clientSeatFromEur` of 99 — "your own seat is 0 € forever, the NEXT CLIENT seat
  // costs 99 €". The Founder ruling deletes that contract: there are no paid seats.
  // After the 14-day trial there is ONE subscription at 99 €/month including 100,000
  // credits, and EVERY further seat is included at no charge. The 99 survives, but it
  // means something else now — the plan, not a seat — so the field it lives on changed
  // with it rather than being quietly re-pointed.
  it('a paid tier is a Standard subscriber; the plan is 99 €/month incl. 100,000 credits', () => {
    for (const tier of ['starter', 'solo'] as const) {
      const s = buildSeatBillingStatus({ tier });
      expect(s.isStandardSubscriber).toBe(true);
      expect(s.isTrial).toBe(false);
      expect(s.standardPlanEur).toBe(STANDARD_PLAN_EUR_PER_MONTH);
      expect(s.standardPlanEur).toBe(99);
      expect(s.standardIncludedCredits).toBe(STANDARD_PLAN_INCLUDED_CREDITS);
      expect(s.standardIncludedCredits).toBe(100_000);
    }
  });

  it('free and trial tiers are NOT subscribers', () => {
    expect(buildSeatBillingStatus({ tier: 'free' }).isStandardSubscriber).toBe(false);
    const t = buildSeatBillingStatus({ tier: 'trial' });
    expect(t.isStandardSubscriber).toBe(false);
    expect(t.isTrial).toBe(true);
  });

  // MULTISEAT INCLUDED, asserted as a positive claim — not merely an absent price.
  it('every additional seat is included at 0 €, on every tier', () => {
    for (const tier of ['free', 'trial', 'starter', 'solo'] as const) {
      const s = buildSeatBillingStatus({ tier });
      expect(s.additionalSeatEur).toBe(ADDITIONAL_SEAT_EUR);
      expect(s.additionalSeatEur).toBe(0);
    }
  });

  // The retired seat ladder must not come back on this shape.
  it('exposes NO per-seat price and NO seat-ladder field', () => {
    const s = buildSeatBillingStatus({ tier: 'starter' }) as Record<string, unknown>;
    for (const gone of ['clientSeatFromEur', 'isFreeOwnSeat', 'ownSeatEur', 'seatLadder']) {
      expect(s[gone]).toBeUndefined();
    }
    // …and no exported number on the status is a retired seat price.
    for (const v of Object.values(s)) {
      expect([129, 149, 249, 599, 792, 990]).not.toContain(v);
    }
  });
});

describe('the 1.820.1 trial + allowance contract', () => {
  // The trial the ruling names: 14 days, 100,000 credits, then an EXPLICIT upgrade.
  it('the trial is 14 days with 100,000 credits', () => {
    expect(TRIAL_LENGTH_DAYS).toBe(14);
    expect(TRIAL_INCLUDED_CREDITS).toBe(100_000);
  });

  // The paid subscription grants what the page advertises. This is the client-side
  // half of the flat-allowance contract: the trial and the plan both land on 100,000,
  // and the retired 60,000 per-seat allowance is gone.
  it('the paid tier and the trial both allow 100,000 credits — never the retired 60,000', () => {
    expect(TIER_ALLOWANCE_CREDITS.starter).toBe(STANDARD_PLAN_INCLUDED_CREDITS);
    expect(TIER_ALLOWANCE_CREDITS.starter).toBe(100_000);
    expect(TIER_ALLOWANCE_CREDITS.trial).toBe(TRIAL_INCLUDED_CREDITS);
    expect(TIER_ALLOWANCE_CREDITS.starter).not.toBe(60_000);
    expect(TIER_ALLOWANCE_CREDITS.free).toBe(0);
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
// THERE IS ONE METER (1.820.1). `showsFreeActionMeter` — the switch that routed a
// credit-less seat onto a second, action-counting view — is DELETED, not made to
// return false: a dormant free-lane branch is a live one after the next refactor.
// ---------------------------------------------------------------------------

describe('one meter for every seat — the free-action view is gone', () => {
  it('the credit-less seat is still IDENTIFIABLE, it just has no second view to route to', () => {
    // `isFree` survives because "this tank is empty and this seat has no plan" is
    // a true fact a surface may need (the 429 wall gates on it). What is gone is
    // the parallel meter it used to select.
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
    expect(m.totalRemaining).toBe(0);
    expect(m.allowanceUsedFraction).toBe(1);
  });

  it('free seat HOLDING purchased credits (M6 pack / manual grant) → the tank, unchanged', () => {
    // The live incident 2026-07-03: tier resolved 'free' while 35k purchased
    // credits were on the balance — every surface hid the paid-for tank. That
    // behaviour is preserved: this seat is NOT `isFree` and reads its real tank.
    const m = buildCreditMeterModel(
      status({ tier: 'free', included_allowance_credits_remaining: 0, purchased_credits_remaining: 35_516 })
    );
    expect(m.tier).toBe('starter');
    expect(m.isFree).toBe(false);
    expect(m.totalRemaining).toBe(35_516);
  });

  it('the free-action predicate is not exported any more — the branch cannot come back by import', () => {
    // A structural assertion on the MODULE, not on a value: if someone reinstates
    // the switch, this names the reason rather than leaving a behaviour test to
    // fail obscurely somewhere downstream.
    expect(Object.keys(creditsCoreModule)).not.toContain('showsFreeActionMeter');
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

  it('INVERTED: a credit-less seat is at 1, not at its action ratio', () => {
    // Was `toBeCloseTo(0.9)` — 90 of 100 daily actions. The bar now reports the
    // only thing that is true: the tank is empty.
    const m = buildCreditMeterModel(
      status({
        tier: 'free',
        included_allowance_credits_remaining: 0,
        purchased_credits_remaining: 0,
        free_actions_used_this_period: 90,
        free_cap: 100,
      })
    );
    expect(m.allowanceUsedFraction).toBe(1);
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
