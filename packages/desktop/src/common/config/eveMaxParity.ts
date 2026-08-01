/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable */
// ── THE MAX PARITY TABLE ────────────────────────────────────────────────────
// THE SAME INPUTS AND THE SAME EXPECTED ANSWER ON BOTH SIDES. The block below,
// from EveMaxParityCase to the end of eveMaxParityFingerprint, is kept
// BYTE-IDENTICAL in:
//   client  packages/desktop/src/common/config/eveMaxParity.ts        (this file)
//   server  supabase/functions/_shared/eve-inference-max-parity.ts
//
// WHY A SHARED TABLE. Every defect on this ticket in this area has been the
// CLIENT offering a lane the SERVER refuses. Testing the two sides separately
// cannot catch that — both can be internally consistent and still disagree, which
// is exactly what `has_active_topup` did: the client unlocked MAX on a top-up the
// seat had already spent, and the server 402'd it. The AGREEMENT is what needs a
// gate, so both suites run THIS table against their own real gate.
//
// EVERY COLUMN IS A RAW INPUT, AND THAT IS THE FIX (1.820.1). The previous shape
// carried a single `paidPlan: boolean` which each suite fed to BOTH of its paid
// signals — `has_paid_seat: c.paidPlan, has_paid_plan: c.paidPlan`. Two columns
// from one input means the REAL predicates (isPaidSeatEdition / isPaidCreditsTier
// / entitlementFromPayload) were never invoked, so the table was blind to the
// blacklist living inside them: it could not have gone red when a 0 € `pilot`
// seat read as PAID. The columns below are the licence and the meter as they
// actually arrive — the suites derive the booleans with production code.
//
// HONEST LIMITATION, stated rather than implied: the two copies are not
// mechanically linked (separate repos, separate runtimes). What the tests enforce
// is that each side matches the table, and a checksum test on each side fails if
// its own copy is edited. Keeping the copies identical is still a human step —
// but a drift now requires editing a file whose only purpose is this contract,
// under a comment saying so, and it reddens a test named for the parity.
//
// THE RULE: MAX unlocks IFF (explicit paid plan/seat) OR (purchased_credits_remaining > 0).
// Nothing else. Not "has a top-up". Not "isn't free". Not "a top-up exists". And
// per the Founder's binding rule (1.820.1): a 100%-discount / zero-euro seat gets
// STANDARD ONLY — `pilot` is NOT paid for MAX purposes.
//
// SCOPE: `maxUnlocked` is the GATE's answer, not "the turn succeeds". Affordability
// is a separate question the server asks afterwards, so rows that unlock MAX carry
// enough balance to pay for the call — otherwise they would 402 on the wallet and
// the parity assertion would be measuring the wrong refusal.

export type EveMaxParityCase = {
  name: string;
  /**
   * The SIGNED licence edition on the seat. Server: minted into a real CEVE
   * payload and re-derived by entitlementFromPayload. Client: fed to the REAL
   * isPaidSeatEdition. NEVER a pre-computed boolean.
   */
  licenseEdition: 'standard' | 'pilot' | 'free';
  /**
   * The wire version the payload was minted at. THIS MATTERS: the live mint path
   * emits CEVE.v1, whose payload has NO trial_ends_at FIELD AT ALL — which is why
   * a rule keyed on "v2 AND trial_ends_at set" was structurally false in
   * production and let everything fall through to "paid".
   */
  licenseVersion: 'v1' | 'v2';
  /** trial_ends_at on a v2 payload. Ignored on v1, where the field does not exist. */
  trialEndsAt: string | null;
  /**
   * The credits-status TIER the SAME seat reports, as credits-billing-core's
   * resolveTier would derive it. Client: fed to the REAL isPaidPlanForSeat. Note
   * a 0 € `pilot` reports 'starter' — its seeded allowance is a Starter
   * allowance — which is precisely why the tier alone may not assert a paid plan.
   */
  creditsTier: 'free' | 'trial' | 'solo' | 'starter';
  /** balance.purchased_credits_remaining — money that was actually paid. */
  purchasedCredits: number;
  /** Present on the seat but irrelevant to the gate — pinned so it STAYS irrelevant. */
  activeTopup: boolean;
  /** Promotional / trial / bundled credits. Never an unlock. */
  allowanceCredits: number;
  /** THE ANSWER both sides must give. */
  maxUnlocked: boolean;
};

export const EVE_MAX_PARITY_CASES: readonly EveMaxParityCase[] = [
  {
    // NO purchased credits: the SOLD SEAT is what unlocks it. Allowance is present
    // only so the server can AFFORD the call — the gate and the wallet are
    // different questions, and a row that cannot pay would 402 for the wrong reason.
    name: 'sold seat (edition standard, v2), no purchased credits -> unlocked',
    licenseEdition: 'standard',
    licenseVersion: 'v2',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: true,
  },
  {
    // The v1 wire the live mint path actually emits. A sold seat must unlock on
    // v1 too, or the fix would have locked out every real customer.
    name: 'sold seat on a v1 payload (no trial_ends_at field at all) -> unlocked',
    licenseEdition: 'standard',
    licenseVersion: 'v1',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: true,
  },
  {
    name: 'sold seat regardless of top-up -> unlocked',
    licenseEdition: 'standard',
    licenseVersion: 'v2',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 0,
    activeTopup: true,
    allowanceCredits: 100000,
    maxUnlocked: true,
  },
  {
    // A standard seat can still be INSIDE a trial window. The window beats the
    // edition: promotional allowance may fund Standard, never MAX.
    name: 'standard seat INSIDE its trial window -> LOCKED',
    licenseEdition: 'standard',
    licenseVersion: 'v2',
    trialEndsAt: '2030-01-01T00:00:00.000Z',
    creditsTier: 'trial',
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    // ── THE BLOCKER ROW ────────────────────────────────────────────────────
    // The ALOIS100 100%-discount founding seat exactly as the live mint path
    // emits it: edition 'pilot', CEVE.v1, no trial_ends_at field, never billed a
    // cent — and reporting tier 'starter' because planForEdition seeds it the
    // Starter allowance. Both blacklists used to call this PAID. It must be
    // LOCKED out of MAX, and Standard must keep working (asserted separately).
    name: 'PILOT (ALOIS100 100%-off) on v1, ZERO purchased credits -> MAX LOCKED',
    licenseEdition: 'pilot',
    licenseVersion: 'v1',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    name: 'PILOT on v2, outside any trial window, with a top-up -> still LOCKED',
    licenseEdition: 'pilot',
    licenseVersion: 'v2',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 0,
    activeTopup: true,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    name: 'PILOT inside its 7-day rich window -> LOCKED',
    licenseEdition: 'pilot',
    licenseVersion: 'v2',
    trialEndsAt: '2030-01-01T00:00:00.000Z',
    creditsTier: 'trial',
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    // The seat did not become paid; the PURCHASE did. Same rule, other disjunct.
    name: 'PILOT that BOUGHT credits -> unlocked (the purchase, not the seat)',
    licenseEdition: 'pilot',
    licenseVersion: 'v1',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 5000,
    activeTopup: false,
    allowanceCredits: 0,
    maxUnlocked: true,
  },
  {
    name: 'PERMANENT FREE seat with promotional allowance ONLY -> LOCKED',
    licenseEdition: 'free',
    licenseVersion: 'v2',
    trialEndsAt: null,
    creditsTier: 'free',
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    name: 'PERMANENT FREE seat that BOUGHT credits -> unlocked',
    licenseEdition: 'free',
    licenseVersion: 'v2',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 5000,
    activeTopup: false,
    allowanceCredits: 0,
    maxUnlocked: true,
  },
  {
    name: 'exhausted top-up: subscription active, wallet empty -> LOCKED',
    licenseEdition: 'pilot',
    licenseVersion: 'v1',
    trialEndsAt: null,
    creditsTier: 'trial',
    purchasedCredits: 0,
    activeTopup: true,
    allowanceCredits: 0,
    maxUnlocked: false,
  },
  {
    name: 'exhausted top-up WITH promotional allowance -> LOCKED',
    licenseEdition: 'pilot',
    licenseVersion: 'v1',
    trialEndsAt: null,
    creditsTier: 'trial',
    purchasedCredits: 0,
    activeTopup: true,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    name: 'active top-up WITH purchased credits -> unlocked (the credits unlock it)',
    licenseEdition: 'pilot',
    licenseVersion: 'v1',
    trialEndsAt: null,
    creditsTier: 'starter',
    purchasedCredits: 5000,
    activeTopup: true,
    allowanceCredits: 0,
    maxUnlocked: true,
  },
  {
    name: 'nothing at all -> LOCKED',
    licenseEdition: 'free',
    licenseVersion: 'v2',
    trialEndsAt: null,
    creditsTier: 'free',
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 0,
    maxUnlocked: false,
  },
];

/**
 * A cheap structural fingerprint of the table. Both sides assert this, so editing
 * one copy without the other reddens a test named for the parity instead of
 * drifting silently. It carries the LICENCE and the TIER, not a paid-boolean —
 * a fingerprint over a pre-computed answer could not have seen this blocker.
 */
export function eveMaxParityFingerprint(cases: readonly EveMaxParityCase[] = EVE_MAX_PARITY_CASES): string {
  return cases
    .map(
      (c) =>
        `${c.licenseEdition}/${c.licenseVersion}/${c.trialEndsAt === null ? 0 : 1}/${c.creditsTier}/` +
        `${c.purchasedCredits > 0 ? 1 : 0}${c.activeTopup ? 1 : 0}${c.allowanceCredits > 0 ? 1 : 0}` +
        `=${c.maxUnlocked ? 1 : 0}`
    )
    .join('|');
}
