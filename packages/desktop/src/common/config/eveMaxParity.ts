/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable */
// ── THE MAX PARITY TABLE ────────────────────────────────────────────────────
// THE SAME INPUTS AND THE SAME EXPECTED ANSWER ON BOTH SIDES. The block below,
// from EVE_MAX_PARITY_CASES to the closing bracket, is kept BYTE-IDENTICAL in:
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
// HONEST LIMITATION, stated rather than implied: the two copies are not
// mechanically linked (separate repos, separate runtimes). What the tests enforce
// is that each side matches the table, and a checksum test on each side fails if
// its own copy is edited. Keeping the copies identical is still a human step —
// but a drift now requires editing a file whose only purpose is this contract,
// under a comment saying so, and it reddens a test named for the parity.
//
// THE RULE: MAX unlocks IFF (explicit paid plan/seat) OR (purchased_credits_remaining > 0).
// Nothing else. Not "has a top-up". Not "isn't free". Not "a top-up exists".
//
// SCOPE: `maxUnlocked` is the GATE's answer, not "the turn succeeds". Affordability
// is a separate question the server asks afterwards, so rows that unlock MAX carry
// enough balance to pay for the call — otherwise they would 402 on the wallet and
// the parity assertion would be measuring the wrong refusal.

export type EveMaxParityCase = {
  name: string;
  /** Server: entitlement.kind === "paid". Client: has_paid_seat / has_paid_plan. */
  paidPlan: boolean;
  /** Server: balance.purchased_credits_remaining. Client: has_purchased_credits. */
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
    name: 'exhausted top-up: subscription active, wallet empty -> LOCKED',
    paidPlan: false,
    purchasedCredits: 0,
    activeTopup: true,
    allowanceCredits: 0,
    maxUnlocked: false,
  },
  {
    name: 'exhausted top-up WITH promotional allowance -> LOCKED',
    paidPlan: false,
    purchasedCredits: 0,
    activeTopup: true,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    name: 'active top-up WITH purchased credits -> unlocked (the credits unlock it)',
    paidPlan: false,
    purchasedCredits: 5000,
    activeTopup: true,
    allowanceCredits: 0,
    maxUnlocked: true,
  },
  {
    name: 'purchased credits, NO top-up -> unlocked',
    paidPlan: false,
    purchasedCredits: 5000,
    activeTopup: false,
    allowanceCredits: 0,
    maxUnlocked: true,
  },
  {
    // NO purchased credits: the PLAN is what unlocks it. Allowance is present only
    // so the server can AFFORD the call — the gate and the wallet are different
    // questions, and a row that cannot pay would 402 for the wrong reason.
    name: 'paid plan/seat with NO purchased credits -> unlocked',
    paidPlan: true,
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: true,
  },
  {
    name: 'paid plan/seat regardless of top-up -> unlocked',
    paidPlan: true,
    purchasedCredits: 0,
    activeTopup: true,
    allowanceCredits: 100000,
    maxUnlocked: true,
  },
  {
    name: 'promotional allowance ONLY -> LOCKED',
    paidPlan: false,
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 100000,
    maxUnlocked: false,
  },
  {
    name: 'nothing at all -> LOCKED',
    paidPlan: false,
    purchasedCredits: 0,
    activeTopup: false,
    allowanceCredits: 0,
    maxUnlocked: false,
  },
];

/**
 * A cheap structural fingerprint of the table. Both sides assert this, so editing
 * one copy without the other reddens a test named for the parity instead of
 * drifting silently.
 */
export function eveMaxParityFingerprint(cases: readonly EveMaxParityCase[] = EVE_MAX_PARITY_CASES): string {
  return cases
    .map(
      (c) =>
        `${c.paidPlan ? 1 : 0}${c.purchasedCredits > 0 ? 1 : 0}${c.activeTopup ? 1 : 0}` +
        `${c.allowanceCredits > 0 ? 1 : 0}=${c.maxUnlocked ? 1 : 0}`
    )
    .join('|');
}
