// Command EVE — metered-credits core (pure, dependency-free, testable).
//
// PREPARED, NOT DEPLOYED. The Mastermind deploys after audit.
//
// This is the pricing/credits engine for the metered-credits billing system. The
// war-game #3 shape it was born in (single Starter 79€ + a bundled allowance, top-up
// packs sold at a PURCHASE markup, a hidden Solo 49€ floor) is history: packs sell at
// FACE value now and PACK_MARKUP is 1.0, so the purchase-markup percentage that used
// to be quoted here described nothing this file does. NO unlimited / flat tier
// anywhere — that part is unchanged and load-bearing. It is pure: no
// I/O, no DB, no env, no clock — so the margin invariant can be proven by unit
// test. The eve-inference function calls applyDebit / canAfford / spend-cap here;
// the (later) Stripe webhook lane calls grantPack / the allowance grant.
//
// Run the tests with node's native TypeScript type-stripping:
//   node --test supabase/functions/_shared/credits-core.test.mjs
//
// ──────────────────────────────────────────────────────────────────────────
// THE CREDIT UNIT  (founder model 2026-06-27: per-token markup at CONSUMPTION)
// ──────────────────────────────────────────────────────────────────────────
// 1 credit == a FIXED € of RETAIL spending power. We anchor it at 1 credit =
// 0.1 € cent of RETAIL value, so the 79€ Starter's ~60€ bundled allowance reads
// as a big, generous 60,000 credits (gamified wallet) and top-up packs price
// cleanly (10€ pack = 10,000 credits). A € retail amount converts to credits by
// `eurToCredits` and back by `creditsToEur`.
//
// WHERE THE MARGIN LIVES (changed): the margin is NO LONGER taken at purchase.
// Packs sell at FACE value (10€ → 10,000 credits, 1:1 with the credit unit). The
// margin is taken at CONSUMPTION via a per-tier markup FACTOR (see
// TIER_MARKUP_FACTOR): the eve-inference core multiplies the RAW OpenRouter cost
// of a call by the tier factor to get the RETAIL € it debits in credits. So a
// Flash (standard, 10x) call that costs us 0.0149 € CENT raw debits 0.149 € cent
// retail = 1.49 credits; the 9/10 of that is our margin. The factor is the single,
// founder-tunable margin lever (adjustable later vs real usage).
//
// CRITICAL margin invariant (load-bearing — proven by test, see marginInvariant):
//   EVERY tier's markup FACTOR must be strictly > 1 (we always charge more retail
//   than the call costs us raw), AND no pack may sell credits BELOW face value
//   (effective €/credit >= the credit unit). The factor is the margin; there is
//   intentionally NO unlimited / flat tier — the war-game proved a flat tier is
//   the only structural margin drain.

// 1 credit = 0.1 € cent of RETAIL value, i.e. 10 credits per € cent. We store the
// ratio as the INTEGER credits-per-cent so the conversions are FLOAT-EXACT — they
// multiply/divide by an integer, never `/0.1` (which is float-unsafe: 30/0.1 =
// 299.9999… in JS). With integer € cents in, credits stay exact integer multiples
// of 10 and eur_value_cents stays integer on the way back.
export const CREDITS_PER_EUR_CENT = 10;
// Derived display anchor: the € cents one credit is worth (0.1). Used for the
// face-value margin check; NOT used in the hot conversion (that uses the integer
// ratio above). Changing the ratio is a recalibration: it changes how future €
// amounts map to credits, NOT the meaning of past ledger rows (those carry their
// own eur_value_cents).
export const CREDIT_UNIT_EUR_CENTS = 1 / CREDITS_PER_EUR_CENT; // 0.1

// Per-tier CONSUMPTION markup factor — the retail price of a call is its RAW
// OpenRouter cost multiplied by this factor; the factor IS the gross margin.
// Founder spec 2026-06-27, adjusted 2026-06-30, standard raised 8x→10x in 1.820.1:
// the cheaper the model, the higher the multiple (a big multiple on a tiny base still
// yields a low absolute price), over a UNIVERSAL 2× FLOOR (DEFAULT_MARKUP_FACTOR) so
// nothing is ever billed below raw×2:
//   standard (Flash) 10x   high (Pro) 4x   xhigh 2x   max 2x
//
// THE MULTIPLE IS THE PROPERTY; A MARGIN PERCENTAGE IS AN OPINION. Each rung above
// used to carry a pinned margin percentage beside it. Those figures are not facts about
// this table: they silently assume zero VAT, zero payment fees and zero refunds, so
// they are an accounting position asserted as arithmetic — and they keep PASSING every
// gate after the next fee renegotiation makes them false. The multiple is what the code
// actually does (retailCostEurCents multiplies the raw cost by it); state that, and let
// whoever needs such a figure state their own fee and VAT assumptions with it. The
// deleted digits are NOT quoted here on purpose — a number lifted out of the money core
// into a deck reads the same whether it sat in a claim or in its obituary. The category
// is gated by margin-claim-honesty.test.mjs.
//
// WHY 10x IS NOT A PRICE RISE THE USER FEELS (1.820.1). The subscription grants a FLAT
// 100,000 credits for 99 €; the markup does not change what is granted, only how fast
// the wallet drains. At the pinned Flash-0731 catalog price ($0.09/M in, $0.18/M out) an
// ordinary 4K-in/800-out turn costs 5 credits at 10x (4 at 8x) — 20,000 turns a month
// rather than 25,000. Even a punishing 100K-in/8K-out agentic turn is 97 credits, i.e.
// ~1,030 such turns a month. The binding constraint on this plan is not the wallet.
// What 10x DOES change is the worst case: a fully-spent 100,000-credit wallet is at most
// 10 € of raw upstream COGS, down from 12.50 € at 8x. Stated without accounting
// assumptions: 10 € of COGS against the 100 € of RETAIL CREDIT VALUE the wallet grants.
//
// NO NET-MARGIN PERCENTAGE IS PINNED HERE, deliberately. Any such figure bakes in a VAT
// jurisdiction, a payment-fee rate and a usage mix — none of which are ours to fix or
// stable — and the subscription grosses 99 €, not the 100 € of credit value it grants.
// Whoever needs a margin number must state the fee and VAT assumptions with it.
// The two frontier rungs are DIFFERENT models since MAT-1749: xhigh serves GLM 5.2 at
// reasoning effort "high", max serves moonshotai/kimi-k3 at effort "max". They still
// share the 2× margin because this table is keyed by TIER, never by model slug — the
// model swap therefore did NOT move any factor (and could not silently drop `max` onto
// the DEFAULT_MARKUP_FACTOR fallback; a ladder test pins that). max simply costs more
// ABSOLUTELY because it spends more thinking tokens (raw × 2 on a bigger raw). Tunable
// later vs real usage. Keys mirror eve-inference-core KNOWN_TIERS.
export const TIER_MARKUP_FACTOR: Readonly<Record<string, number>> = Object.freeze({
  standard: 10,
  high: 4,
  xhigh: 2,
  max: 2,
});

// Universal FLOOR / fallback markup. ANY call whose tier we don't recognise —
// image, video, music, or a brand-new model we haven't explicitly priced — is
// billed at raw OpenRouter cost × this factor. Founder 2026-06-30: "1 € auf
// OpenRouter = 2 € = 2000 Credits" — the margin floor is ALWAYS present, so we can
// never lose money on an unpriced model. Every TIER_MARKUP_FACTOR value is >= this.
export const DEFAULT_MARKUP_FACTOR = 2;

// The retail € (cents) a call is billed for: raw OpenRouter cost × the tier
// factor. Unknown tier → the universal 2× FLOOR (DEFAULT_MARKUP_FACTOR), never
// below raw×2. This is the single chokepoint where the per-token margin is applied;
// eve-inference-core calls it for BOTH the reserve estimate and the post-call actual
// cost, and the metered production lane (image/video/music) calls it with an
// un-tiered key → the floor.
export function retailCostEurCents(rawCostEurCents: number, tier: string): number {
  if (!Number.isFinite(rawCostEurCents) || rawCostEurCents < 0) {
    throw new RangeError('retailCostEurCents: rawCostEurCents must be a finite >= 0 number');
  }
  const factor = TIER_MARKUP_FACTOR[tier] ?? DEFAULT_MARKUP_FACTOR;
  return rawCostEurCents * factor;
}

// DEPRECATED placeholder kept for import-surface stability. Packs now sell at FACE
// value (1.0 = no purchase markup); the margin moved to TIER_MARKUP_FACTOR at
// consumption. packCredits divides by this, so 1.0 yields face-value credits.
export const PACK_MARKUP = 1.0;

// Bundled monthly allowance, expressed as the € of RETAIL spending power it grants
// (NOT our cost — at the consumption factor the allowance costs us allowance/factor
// raw). Starter 79€ plan → 60€ allowance = 60,000 credits; hidden Solo 49€ floor →
// 38€ allowance (same mechanics; save-offer only).
export const STARTER_ALLOWANCE_EUR_CENTS = 6000; // 60.00 € retail = 60,000 credits
export const SOLO_ALLOWANCE_EUR_CENTS = 3800; // 38.00 € retail = 38,000 credits

// THE STANDARD SUBSCRIPTION ALLOWANCE (founder ruling, release 1.820.1): the ONE
// subscription is 99 €/month INCLUDING 100,000 credits. 100.00 € retail spending
// power = 100,000 credits at the face-value credit unit.
//
// It is its own allowance plan rather than a re-pricing of STARTER_ALLOWANCE because
// the legacy 79 € Starter is GRANDFATHERED at 60,000 and must keep granting that.
// Re-pointing "starter" would silently re-grant every existing subscriber — a
// migration decision nobody made. New buyers land on "standard".
export const STANDARD_ALLOWANCE_EUR_CENTS = 10000; // 100.00 € retail = 100,000 credits

// Treue-Bonus (loyalty): bonus credits granted on every paid invoice into the
// INCLUDED-ALLOWANCE bucket — `bucket: "included"` at credits-webhook-core.ts:245.
// A retention lever (founder 2026-06-27). 10,000 cr = 10 € of RETAIL spend; at the
// per-tier consumption factor it costs us ~1–3 € raw. Tunable.
//
// THE BUCKET IS THE RULE, NOT A DETAIL. This comment previously said "granted to
// the PURCHASED bucket (they roll over / survive the period)" and the runtime has
// never done that. Both halves of the claim were wrong in the dangerous direction:
//   * the allowance is RESET each period, so the bonus is spendable WITHIN its
//     period and does not accumulate;
//   * `purchased_credits_remaining > 0` is a MAX UNLOCK (eve-inference-core), so a
//     loyalty bonus landing there would hand the frontier lane to a seat that
//     bought nothing. Comped credit funds the metered lane; it never buys MAX.
// A comment that describes the opposite of the code is worse than no comment —
// the next reader "restores" the runtime to match it. Fix the comment here, at the
// DEFINITION, not only at the usage site.
export const LOYALTY_BONUS_CREDITS = 10_000;

// DELETED in 1.820.1: FREE_TIER_ACTION_CAP and TRIAL_FREE_ACTION_CAP.
//
// They defined the daily allowance of the zero-debit "free model" lane. That lane
// was removed in 1.820.1 — every cloud turn is credit-metered — but the constants
// were left dormant, and a dormant constant is not inert: FREE_TIER_ACTION_CAP was
// still being re-exported through credits-billing-core into the credits-status
// response, where the web account page rendered it as a live
// "100 / 100 Gratis-Aktionen heute übrig" meter to seats whose every turn was in
// fact metered and 402'd. The cap outlived the lane it capped and became a promise.
// They are deleted, not zeroed, so nothing can read them again.
//
// This paragraph used to end by pointing at eve-inference-core's DAILY_CAP_PER_USER as
// "what remains" — a live abuse ceiling on metered turns. That cap has now been deleted
// too: it was guarded by `if (deps.usage)` and the production entrypoint never injected
// a usage store, so it never ran once. Nothing daily bounds a seat. The WALLET is the
// bound: a turn that the credit balance cannot cover is refused before the upstream
// call, and every turn that proceeds is debited at actual cost.

// ──────────────────────────────────────────────────────────────────────────
// Pack table — the four top-up packs (€ the USER PAYS). The ladder is 25 / 50 /
// 100 / 200 € (founder ruling, release 1.820.1: "optional monthly credit top-ups at
// EUR 25 / 50 / 100 / 200"). Every pack sells at FACE value with ZERO bonus; the
// margin is taken at CONSUMPTION (TIER_MARKUP_FACTOR), never at the purchase.
// marginInvariant proves no pack sells credits below face value.
// ──────────────────────────────────────────────────────────────────────────
export interface CreditPack {
  // Stable id used by Stripe price mapping + the desktop wall.
  id: string;
  // The € the user pays for this pack (in cents).
  price_eur_cents: number;
  // Bonus fraction on the base credits (0 = none). The base credits are the
  // markup-adjusted credits the € buys; the bonus is added on top. CAPPED.
  bonus_fraction: number;
}

// MAX bonus any pack may carry. Packs now sell at FACE value (the margin is the
// per-tier consumption factor, not a purchase discount), so the shipped packs carry
// ZERO bonus. The cap is retained as a guard: a bonus grants extra RETAIL credits
// without adding any raw cost, so it dilutes the effective consumption multiple and
// must stay bounded.
//
// THE JUSTIFICATION USED TO BE DOUBLY STALE. It argued the cap was safe "at the lowest
// factor", named a multiplier the tier table had already stopped using, and converted
// it into a margin percentage. The lowest factor is DEFAULT_MARKUP_FACTOR (2), and the
// percentage beside it was an accounting claim, not a property of this file. Both are
// gone, digits included. What holds without either: at the universal 2× floor a pack
// sold at face value with a bonus of b buys raw work worth (1+b)/2 of what the buyer
// paid, which stays under 1 for every b <= 1 — so 0.15 is a conservative ceiling, and
// it is the invariant test, not a number in a comment, that keeps it honest.
// marginInvariant asserts every pack's bonus_fraction <= this cap AND that no pack
// sells credits below face value.
export const MAX_BONUS_FRACTION = 0.15;

// Face-value top-up packs (€ the USER PAYS → credits 1:1 at the credit unit; no
// purchase markup, no bonus). 25€ = 25,000 cr · 50€ = 50,000 cr · 100€ = 100,000 cr ·
// 200€ = 200,000 cr. The quantities are DERIVED from CREDITS_PER_EUR_CENT (10), never
// typed by hand — see packCredits. The margin is taken when the credits are SPENT
// (TIER_MARKUP_FACTOR).
//
// 1.820.1: the top tier moved 250€ -> 200€ (founder ruling supersedes the older pack
// table). There is no 250€ pack any more; a Stripe price for it must not be offered.
export const CREDIT_PACKS: readonly CreditPack[] = Object.freeze([
  { id: 'pack-25', price_eur_cents: 2500, bonus_fraction: 0.0 },
  { id: 'pack-50', price_eur_cents: 5000, bonus_fraction: 0.0 },
  { id: 'pack-100', price_eur_cents: 10000, bonus_fraction: 0.0 },
  { id: 'pack-200', price_eur_cents: 20000, bonus_fraction: 0.0 },
]) as readonly CreditPack[];

// ──────────────────────────────────────────────────────────────────────────
// €  ↔  credits conversion (raw-cost anchored)
// ──────────────────────────────────────────────────────────────────────────

// Retail € (cents) → credits. 1 credit = CREDIT_UNIT_EUR_CENTS of RETAIL value.
// Callers pass the RETAIL amount: for a debit, eve-inference-core has already
// multiplied the raw OpenRouter cost by the tier factor (retailCostEurCents); for
// a grant/pack it is the face € the user paid. The margin is in that factor, not here.
export function eurToCredits(eurCents: number): number {
  if (!Number.isFinite(eurCents) || eurCents < 0) {
    throw new RangeError('eurToCredits: eurCents must be a finite >= 0 number');
  }
  // Integer multiply (float-exact). With integer cents in → integer credits out.
  return eurCents * CREDITS_PER_EUR_CENT;
}

// Credits → raw-cost € (cents). Inverse of eurToCredits.
export function creditsToEur(credits: number): number {
  if (!Number.isFinite(credits) || credits < 0) {
    throw new RangeError('creditsToEur: credits must be a finite >= 0 number');
  }
  // Integer divide (float-exact for credit amounts that are multiples of the ratio,
  // which all grant/pack/debit amounts are — see eurToCredits).
  return credits / CREDITS_PER_EUR_CENT;
}

// ──────────────────────────────────────────────────────────────────────────
// Pack credits — how many credits a pack grants (markup + capped bonus applied)
// ──────────────────────────────────────────────────────────────────────────

// The credits a pack grants. Packs sell at FACE value now (PACK_MARKUP = 1.0): the
// user pays `price_eur_cents` and gets exactly that many € of RETAIL credits
// (price / 1.0 → credits at the credit unit), plus any (currently zero) capped
// bonus. The margin is NOT here — it is taken at consumption (TIER_MARKUP_FACTOR).
export function packCredits(pack: CreditPack): {
  base_credits: number;
  bonus_credits: number;
  total_credits: number;
} {
  if (pack.bonus_fraction < 0 || pack.bonus_fraction > MAX_BONUS_FRACTION) {
    // Fail closed: a pack whose bonus exceeds the cap would threaten the margin.
    throw new RangeError(
      `packCredits: ${pack.id} bonus_fraction ${pack.bonus_fraction} exceeds MAX_BONUS_FRACTION ${MAX_BONUS_FRACTION}`
    );
  }
  // €-of-raw-cost the pay buys after removing the markup, then → credits.
  const base_credits = eurToCredits(pack.price_eur_cents / PACK_MARKUP);
  const bonus_credits = base_credits * pack.bonus_fraction;
  const total_credits = base_credits + bonus_credits;
  return { base_credits, bonus_credits, total_credits };
}

// The effective € (cents) the user pays per credit on a pack, INCLUDING bonus.
// This is the number the margin invariant compares against raw cost
// (CREDIT_UNIT_EUR_CENTS). It must always be strictly greater than raw cost.
export function effectiveEurCentsPerCredit(pack: CreditPack): number {
  const { total_credits } = packCredits(pack);
  return pack.price_eur_cents / total_credits;
}

// ──────────────────────────────────────────────────────────────────────────
// marginInvariant — the load-bearing, non-negotiable check
// ──────────────────────────────────────────────────────────────────────────
// The margin now lives at CONSUMPTION, so the invariant has two obligations:
//   (1) MARGIN: every tier's markup FACTOR must be strictly > 1 — we always charge
//       more RETAIL for a call than it costs us RAW. The factor IS the margin.
//   (2) FACE VALUE: no pack may sell credits BELOW face value — the effective
//       €/credit a user pays must be >= the credit unit (a pack giving MORE than
//       face-value credits would silently hand back consumption margin). Bonuses
//       stay <= MAX_BONUS_FRACTION.
// Returns a detailed result; `ok` is false if ANY tier factor <= 1, ANY pack sells
// below face value, or any bonus exceeds the cap.
export interface MarginInvariantTierResult {
  tier: string;
  factor: number;
  ok: boolean; // factor > 1
}

export interface MarginInvariantPackResult {
  id: string;
  effective_eur_cents_per_credit: number;
  face_eur_cents_per_credit: number; // the credit unit (face value)
  face_ratio: number; // effective / face; must be >= 1 (never sell below face)
  bonus_fraction: number;
  ok: boolean;
}

export interface MarginInvariantResult {
  ok: boolean;
  face_eur_cents_per_credit: number;
  max_bonus_fraction: number;
  tiers: MarginInvariantTierResult[];
  packs: MarginInvariantPackResult[];
  violations: string[];
}

export function marginInvariant(
  packs: readonly CreditPack[] = CREDIT_PACKS,
  factors: Readonly<Record<string, number>> = TIER_MARKUP_FACTOR
): MarginInvariantResult {
  const face = CREDIT_UNIT_EUR_CENTS; // retail € cents per credit at face value
  const violations: string[] = [];

  // (1) MARGIN: every tier factor strictly > 1.
  const tiers: MarginInvariantTierResult[] = Object.entries(factors).map(([tier, factor]) => {
    const ok = Number.isFinite(factor) && factor > 1;
    if (!ok) {
      violations.push(`tier ${tier}: markup factor ${factor} must be > 1`);
    }
    return { tier, factor, ok };
  });

  // (2) FACE VALUE: no pack sells credits below face value.
  const results: MarginInvariantPackResult[] = packs.map((pack) => {
    let effective = NaN;
    let bonusOk = true;
    try {
      // packCredits throws if bonus exceeds the cap — that is itself a violation.
      effective = effectiveEurCentsPerCredit(pack);
    } catch (e) {
      bonusOk = false;
      violations.push(`${pack.id}: ${(e as Error).message}`);
    }
    const face_ratio = effective / face;
    // effective €/credit must be >= face value (allow exact face value). A pack
    // below face (face_ratio < 1) would hand the user more retail credits than they
    // paid for, draining the consumption margin.
    const packOk =
      bonusOk && Number.isFinite(effective) && effective >= face - 1e-9 && pack.bonus_fraction <= MAX_BONUS_FRACTION;
    if (!packOk && bonusOk) {
      violations.push(`${pack.id}: effective ${effective} < face ${face} (face_ratio ${face_ratio})`);
    }
    return {
      id: pack.id,
      effective_eur_cents_per_credit: effective,
      face_eur_cents_per_credit: face,
      face_ratio,
      bonus_fraction: pack.bonus_fraction,
      ok: packOk,
    };
  });

  return {
    ok: violations.length === 0 && tiers.every((t) => t.ok) && results.every((r) => r.ok),
    face_eur_cents_per_credit: face,
    max_bonus_fraction: MAX_BONUS_FRACTION,
    tiers,
    packs: results,
    violations,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Monthly allowance grant (Starter / Solo)
// ──────────────────────────────────────────────────────────────────────────
export type Plan = 'standard' | 'starter' | 'solo';

// The credits the bundled monthly allowance grants for a plan. The allowance is
// expressed as € of RETAIL spending power (Standard 100€ → 100,000 cr / legacy
// Starter 60€ → 60,000 cr / Solo 38€ → 38,000 cr), converted to credits at the
// face-value credit unit. At the per-tier consumption factor this retail allowance
// costs us allowance/factor raw.
export function allowanceCreditsForPlan(plan: Plan): number {
  switch (plan) {
    case 'standard':
      return eurToCredits(STANDARD_ALLOWANCE_EUR_CENTS);
    case 'starter':
      return eurToCredits(STARTER_ALLOWANCE_EUR_CENTS);
    case 'solo':
      return eurToCredits(SOLO_ALLOWANCE_EUR_CENTS);
    default: {
      const _exhaustive: never = plan;
      throw new RangeError(`allowanceCreditsForPlan: unknown plan ${_exhaustive}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Balance + debit engine (pure)
// ──────────────────────────────────────────────────────────────────────────
// CreditBalance mirrors the credit_balances row, but in pure number form. The
// inference path loads this (under a row lock), runs canAfford/applyDebit here,
// and persists the new balance + an append-only ledger row.
export interface CreditBalance {
  included_allowance_credits_remaining: number;
  purchased_credits_remaining: number;
  // The user-set hard cap on PURCHASED spend within the period, in € cents.
  // null = no cap. The allowance is pre-paid and not governed by the cap.
  spend_cap_eur_cents: number | null;
  // The € (cents) of PURCHASED credits already spent this period — used to enforce
  // the spend cap. Allowance spend does NOT count against the cap.
  purchased_eur_cents_spent_this_period: number;
}

// Total credits available to spend right now (allowance + purchased).
export function totalCreditsAvailable(balance: CreditBalance): number {
  return balance.included_allowance_credits_remaining + balance.purchased_credits_remaining;
}

// Can this balance afford a job costing `costEurCents` of RETAIL inference (raw
// OpenRouter cost already × the tier factor), WITHOUT breaching the user-set spend
// cap? Allowance is spent first (pre-paid, not capped), then purchased (capped).
// Returns a structured decision the wall can render.
export interface AffordDecision {
  ok: boolean;
  reason: 'ok' | 'insufficient_credits' | 'spend_cap_exceeded';
  credits_needed: number; // total credits this job needs
  credits_available: number; // total credits on hand
  // The split this job would draw if allowed: from allowance first, then purchased.
  from_allowance: number;
  from_purchased: number;
  // Shortfall in credits if insufficient (0 otherwise).
  shortfall_credits: number;
}

export function canAfford(balance: CreditBalance, costEurCents: number): AffordDecision {
  if (!Number.isFinite(costEurCents) || costEurCents < 0) {
    throw new RangeError('canAfford: costEurCents must be a finite >= 0 number');
  }
  // PER-TOKEN HONESTY (2026-07-01): costEurCents is the PRECISE retail (raw × tier
  // factor, sub-cent possible) — the raw cost is NO LONGER pre-ceiled to a whole
  // €-cent upstream (that ceil-before-factor defeated per-token billing: every call
  // floored to a flat tier-factor-cents charge regardless of token count). The credit
  // (0.1 €-cent = 1/CREDITS_PER_EUR_CENT) is the finest billable unit, so this ceil at
  // CREDIT granularity is the SINGLE rounding: a small call bills a few credits, a big
  // call bills proportionally more, min 1 credit for any non-zero cost.
  const credits_needed = Math.ceil(eurToCredits(costEurCents));
  const credits_available = totalCreditsAvailable(balance);

  // Draw allowance first, then purchased.
  const from_allowance = Math.min(credits_needed, balance.included_allowance_credits_remaining);
  const remaining_after_allowance = credits_needed - from_allowance;
  const from_purchased = Math.min(remaining_after_allowance, balance.purchased_credits_remaining);
  const shortfall_credits = remaining_after_allowance - from_purchased;

  if (shortfall_credits > 1e-9) {
    return {
      ok: false,
      reason: 'insufficient_credits',
      credits_needed,
      credits_available,
      from_allowance,
      from_purchased,
      shortfall_credits,
    };
  }

  // Spend-cap check: only the PURCHASED portion counts against the user cap (the
  // allowance is pre-paid). The € value charged against the cap is the purchased
  // credits drawn, converted back to € at raw cost. If after this debit the
  // period's purchased spend would exceed the cap, block.
  if (balance.spend_cap_eur_cents !== null) {
    const purchased_eur_this_job = creditsToEur(from_purchased);
    const projected = balance.purchased_eur_cents_spent_this_period + purchased_eur_this_job;
    if (projected > balance.spend_cap_eur_cents + 1e-9) {
      return {
        ok: false,
        reason: 'spend_cap_exceeded',
        credits_needed,
        credits_available,
        from_allowance,
        from_purchased,
        shortfall_credits: 0,
      };
    }
  }

  return {
    ok: true,
    reason: 'ok',
    credits_needed,
    credits_available,
    from_allowance,
    from_purchased,
    shortfall_credits: 0,
  };
}

// Apply a debit for a job costing `costEurCents` of RETAIL inference (raw cost ×
// tier factor). PURE: returns the new balance + the ledger entries to append;
// throws nothing on the
// insufficient/cap path — instead returns ok:false and leaves the balance
// untouched (the caller turns ok:false into a 402). Allowance is debited before
// purchased.
export interface LedgerEntry {
  kind: 'debit';
  credits: number; // negative — the EXACT billed unit (0.1 €-cent each)
  eur_value_cents: number; // >= 0, the € cents drawn, ROUNDED to the integer bigint
  // column — a display/audit echo, NOT the accounting source of truth. Sub-cent
  // debits (most calls) round here; the exact amount lives in `credits`. The
  // spend-cap running total is summed from `credits`, never from this rounded field.
  bucket: 'included' | 'purchased';
  reason: string;
  model: string | null;
}

export interface DebitResult {
  ok: boolean;
  decision: AffordDecision;
  // Present only when ok. The new balance after the debit and the ledger rows to
  // append (one per bucket touched).
  new_balance?: CreditBalance;
  entries?: LedgerEntry[];
}

export function applyDebit(
  balance: CreditBalance,
  costEurCents: number,
  opts: { model?: string | null; reason?: string } = {}
): DebitResult {
  const decision = canAfford(balance, costEurCents);
  if (!decision.ok) {
    return { ok: false, decision };
  }
  const model = opts.model ?? null;
  const reason = opts.reason ?? 'inference debit';
  const entries: LedgerEntry[] = [];

  if (decision.from_allowance > 0) {
    entries.push({
      kind: 'debit',
      credits: -decision.from_allowance,
      // Round to the integer bigint column — display echo only; `credits` is exact.
      eur_value_cents: Math.round(creditsToEur(decision.from_allowance)),
      bucket: 'included',
      reason,
      model,
    });
  }
  if (decision.from_purchased > 0) {
    entries.push({
      kind: 'debit',
      credits: -decision.from_purchased,
      eur_value_cents: Math.round(creditsToEur(decision.from_purchased)),
      bucket: 'purchased',
      reason,
      model,
    });
  }

  const new_balance: CreditBalance = {
    included_allowance_credits_remaining: balance.included_allowance_credits_remaining - decision.from_allowance,
    purchased_credits_remaining: balance.purchased_credits_remaining - decision.from_purchased,
    spend_cap_eur_cents: balance.spend_cap_eur_cents,
    purchased_eur_cents_spent_this_period:
      balance.purchased_eur_cents_spent_this_period + creditsToEur(decision.from_purchased),
  };

  return { ok: true, decision, new_balance, entries };
}

// ──────────────────────────────────────────────────────────────────────────
// Reversal-aware purchased-spend netting — the ONE shared algorithm every
// caller of command_eve_commit_debit / command_eve_reverse_debit must use to
// compute purchased_eur_cents_spent_this_period. Introduced with the video
// debit/reversal slice (1.820.1) and immediately load-bearing for
// eve-inference too: both lanes debit the SAME credit_balances row per
// entitlement, so a reversal recorded by ONE lane must be netted by every
// lane that computes the period's purchased spend for the spend-cap check —
// otherwise a fully-refunded video (or any other reversed debit) would
// permanently over-count against the tenant's spend cap.
// ──────────────────────────────────────────────────────────────────────────
export interface CreditLedgerRow {
  kind: 'debit' | 'reversal';
  bucket: 'included' | 'purchased' | null;
  credits: number;
  external_ref: string | null;
}

/**
 * PURE: nets purchased-bucket spend for the period from raw debit + reversal
 * ledger rows.
 *
 * command_eve_reverse_debit appends exactly ONE reversal row per external_ref
 * with `bucket = null` (a unique partial index on (entitlement_id,
 * external_ref) WHERE kind = 'reversal' forbids a second row for a split
 * debit — see that migration's header). So netting cannot join reversal to
 * debit by bucket; it joins by external_ref instead: a purchased-bucket debit
 * whose external_ref has ANY matching reversal row is excluded from the spend
 * total, regardless of the reversal row's own (null) bucket.
 */
export function netPurchasedSpendCredits(rows: readonly CreditLedgerRow[]): number {
  const reversedRefs = new Set(
    rows.filter((row) => row.kind === 'reversal' && row.external_ref).map((row) => row.external_ref as string)
  );
  let total = 0;
  for (const row of rows) {
    if (row.kind !== 'debit' || row.bucket !== 'purchased') continue;
    if (row.external_ref && reversedRefs.has(row.external_ref)) continue;
    total += Math.abs(row.credits);
  }
  return total;
}

// ──────────────────────────────────────────────────────────────────────────
// 402 quota-exhausted body — the structured shape the desktop renders as the
// credit-wall. Built from an AffordDecision (insufficient or cap-exceeded).
// ──────────────────────────────────────────────────────────────────────────
export interface QuotaWallBody {
  error: 'quota_exhausted';
  reason: 'insufficient_credits' | 'spend_cap_exceeded';
  // Credits this job needs and what is on hand, so the wall can say "needs X, you
  // have Y".
  credits_needed: number;
  credits_available: number;
  shortfall_credits: number;
  // The pack options to top up, with the credits each grants (incl. bonus) and the
  // effective €/credit — so the desktop can render the buy-credits choices.
  packs: Array<{
    id: string;
    price_eur_cents: number;
    total_credits: number;
    bonus_credits: number;
    effective_eur_cents_per_credit: number;
  }>;
}

export function buildQuotaWallBody(decision: AffordDecision): QuotaWallBody {
  if (decision.ok) {
    throw new Error('buildQuotaWallBody: decision is ok; no wall to build');
  }
  return {
    error: 'quota_exhausted',
    reason: decision.reason === 'spend_cap_exceeded' ? 'spend_cap_exceeded' : 'insufficient_credits',
    credits_needed: decision.credits_needed,
    credits_available: decision.credits_available,
    shortfall_credits: decision.shortfall_credits,
    packs: CREDIT_PACKS.map((pack) => {
      const { total_credits, bonus_credits } = packCredits(pack);
      return {
        id: pack.id,
        price_eur_cents: pack.price_eur_cents,
        total_credits,
        bonus_credits,
        effective_eur_cents_per_credit: effectiveEurCentsPerCredit(pack),
      };
    }),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// DELETED in 1.820.1: checkFreeTierAction/FreeTierDecision and the GLM-Kostprobe
// (GLM_TASTE_CAP_PER_MONTH / checkGlmTaste / GlmTasteDecision).
//
// The first decided whether a free-model call was within its daily allowance; the
// second granted a free monthly taste of the frontier model — explicitly "NO credit
// debit, served on the free lane". Neither lane exists: R2 says every cloud turn is
// credit-metered, and eve-inference has had no un-metered path since 1.820.1.
//
// They are DELETED rather than left unused. A dormant free-lane primitive is one
// refactor away from being live again, and this file already proved it: the
// action-cap constant sat "unused" while still feeding a free-quota number onto the
// web account page. The DB side (command_eve_draw_free_action,
// command_eve_draw_glm_taste, and their credit_balances counters) is left in place
// because dropping it needs its own migration; nothing reads it.
