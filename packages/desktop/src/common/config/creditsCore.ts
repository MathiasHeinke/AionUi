/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE credits/billing — pure core (Lane 3 desktop UX).
 *
 * This module is PURE (no Electron, no fs, no network) so every piece of
 * credit MATH and every UX DECISION (meter %, default-pack selection, the
 * 402-wall body parse, the idle-suppression rule, the €-value receipt) is
 * unit-testable in a plain Node (vitest) environment — mirroring
 * `eveInferenceCore.ts`.
 *
 * It builds the desktop UX against the WG#3 credits-billing spec
 * (docs/specs/command-eve-credits-billing-spec-2026-06-18.md) and the backend
 * Lane-1+2 CONTRACTS. The desktop never decides entitlement or charges money;
 * it renders the backend truth and opens the Lane-2 checkout.
 *
 * Two backend contracts this module is shaped against (NOT called here):
 *   1. `credits-status` Edge Function (CEVE bearer) →
 *      { tier, included_allowance_credits_remaining, purchased_credits_remaining,
 *        spend_cap_eur_cents, free_actions_used_this_period, free_cap, period_start }
 *   2. An EVE-inference call may return HTTP 402 with a structured body:
 *      { error:'quota_exhausted', credits_needed, packs:[{ eur, credits, bonus }] }
 *
 * Credit unit (NEW server billing model): 1 credit = 0.1 ct (0.001 €), so a
 * face-value pack of N euros delivers N × 1000 credits and ships with NO
 * purchase-time bonus — margin is taken at CONSUMPTION via the per-tier factors.
 *
 * Hard invariant, enforced here in `packEffectiveCostPerCredit` and asserted by
 * `marginInvariantHolds`: the effective €/credit a buyer pays ALWAYS exceeds raw
 * inference cost — there is NO unlimited tier anywhere.
 */

// ---------------------------------------------------------------------------
// Backend contract shapes (mirrored; the backend is the source of truth)
// ---------------------------------------------------------------------------

/** The Command EVE credits-status Edge Function. Same Supabase project as eve-inference. */
export const CREDITS_STATUS_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/credits-status';

/**
 * The credits tiers the credits-status contract can report. `free` is the Gen-B
 * 0€-forever own seat; `starter` maps to a paid CLIENT seat's allowance. `solo`
 * is a LEGACY tier the server may still report for a grandfathered 49€ sub — the
 * desktop keeps it in the union so an old status parses, but no Gen-B surface
 * SELLS it (the legacy 79€/49€ plan UI was removed).
 */
export type CreditsTier = 'free' | 'solo' | 'starter';

/**
 * The credits-status response (Lane-1 contract). All credit counts are in
 * CREDITS (NEW model: 1 credit = 0.1 ct; margin is taken at CONSUMPTION via the
 * tier factors, never at purchase). `spend_cap_eur_cents` is the user's optional
 * hard cap.
 */
export interface CreditsStatus {
  tier: CreditsTier;
  /** Remaining credits from the monthly bundled allowance (Starter 60,000 cr, Solo 38,000 cr). */
  included_allowance_credits_remaining: number;
  /** Remaining credits the user bought as packs (carry over; consumed after allowance). */
  purchased_credits_remaining: number;
  /** User's hard spend cap in EUR cents (0/absent ⇒ no cap). */
  spend_cap_eur_cents: number;
  /** Free-tier action counter this period (free models, no debit). */
  free_actions_used_this_period: number;
  /** Free-tier hard cap (anti-abuse; spec §2). */
  free_cap: number;
  /** ISO start of the current billing/allowance period. */
  period_start: string;
  /**
   * v1.5 M7: an ACTIVE credit subscription (recurring top-up, from 25 €/month)
   * that unlocks Pro features (BYOK / add-own-model) WITHOUT a paid client seat.
   * Additive — an absent field ⇒ false ⇒ today's behavior. Cancelling the
   * subscription flips this off on the next status read (re-locks for free).
   */
  has_active_topup?: boolean;
}

/** A single buyable credit pack as advertised in the 402 body (Lane-2 contract). */
export interface CreditPack {
  /** Pack price in EUR (whole euros, per spec pack table 25/50/100/250). */
  eur: number;
  /** Base credits the pack is worth at our calibration constant. */
  credits: number;
  /**
   * Bonus credits granted on top of the face-value `credits`. Gen-B RECURRING
   * top-ups grant +20% (server `TOP_UP_BONUS_FACTOR = 1.2`), so the resting
   * catalog carries a 20% bonus per pack (see DEFAULT_CREDIT_PACKS). A one-time
   * pack would be 0; the desktop only advertises the recurring +20% packs. The
   * server is authoritative on the actual grant — the 402 body may override.
   */
  bonus: number;
}

/** The structured body of an HTTP 402 quota_exhausted response (Lane-1 contract). */
export interface QuotaExhaustedBody {
  error: 'quota_exhausted';
  /** Credits the in-flight job still needs to complete. */
  credits_needed: number;
  /** The packs offered at the wall (server-advertised, in display order). */
  packs: CreditPack[];
}

// ---------------------------------------------------------------------------
// Canonical pack table + margin invariant (spec §1, §2)
// ---------------------------------------------------------------------------

/**
 * Legacy markup hint, RETAINED for the transparent-math display fallback only.
 * SUPERSEDED by the per-token markup billing model (margin at CONSUMPTION via
 * tier factors, not a flat purchase-time markup). The binding €→credits
 * conversion + margin live server-side; the desktop never re-derives money here.
 */
export const CREDIT_PACK_MARKUP = 0.4;

/**
 * The credit UNIT in EUR. NEW server billing model: 1 credit = 0.1 cent (0.001 €),
 * so a face-value pack of N euros buys N × 1000 credits (25€ → 25,000 cr). This is
 * the float-safe display constant; the server is authoritative on every debit.
 */
export const CREDIT_UNIT_EUR = 0.001;

/** Credits delivered per euro at the credit unit (1 / CREDIT_UNIT_EUR = 1000). */
export const CREDITS_PER_EUR = 1000;

/**
 * The recurring top-up bonus the SERVER grants on a RECURRING credit pack. This
 * mirrors the backend `TOP_UP_BONUS_FACTOR = 1.2` (a recurring top-up delivers
 * +20% credits over face value). One-time packs get NO bonus server-side, so the
 * desktop advertises ONLY the recurring 20% packs to stay consistent with the
 * Gen-B website (command-eve.com/account) AND the server code. This is a DISPLAY
 * constant; the server is authoritative on every actual grant.
 */
export const RECURRING_TOP_UP_BONUS_FACTOR = 0.2;

/**
 * Default catalog the pricing UI shows when offline / before the first 402.
 * GEN-B ALIGNMENT: these mirror the RECURRING credit packs sold on the Gen-B
 * website (25/50/100/250 €/month) which the server grants at +20% (recurring
 * `TOP_UP_BONUS_FACTOR = 1.2`). So each pack's `bonus` is 20% of the face-value
 * credits: 25€ → 25,000 + 5,000 = 30,000 cr, etc. (1 credit = 0.1 ct). One-time
 * packs (server: 0% bonus) are deliberately NOT advertised here — advertising a
 * bonus the server would not honour on a one-time buy would be dishonest. The
 * LIVE numbers always come from the 402 body; this is only the resting UI.
 */
export const DEFAULT_CREDIT_PACKS: readonly CreditPack[] = [
  { eur: 25, credits: 25_000, bonus: 5_000 },
  { eur: 50, credits: 50_000, bonus: 10_000 },
  { eur: 100, credits: 100_000, bonus: 20_000 },
  { eur: 250, credits: 250_000, bonus: 50_000 },
] as const;

/**
 * The Gen-B CLIENT-SEAT floor. The operator's OWN seat is 0 € forever (EVE Solo);
 * a paid CLIENT seat (the reseller expansion) starts at 99 €/month and ships a
 * 60,000-credit monthly allowance. The legacy 79€ Starter / hidden 49€ Solo plans
 * (and `buildPricingPlans`) were removed with the Gen-B pricing switch — the
 * desktop no longer sells a "plan"; it sells the free own-seat + paid client-seats.
 */
export const CLIENT_SEAT_FROM_EUR = 99;
/** The always-free own-seat price (Gen-B: EVE Solo is 0 € for ever). */
export const OWN_SEAT_EUR = 0;

/**
 * Effective €/credit a buyer actually pays for a pack: total price divided by
 * total credits delivered (base + bonus). The margin invariant requires this to
 * stay ABOVE raw cost-per-credit at every pack including max bonus.
 */
export function packEffectiveCostPerCredit(pack: CreditPack): number {
  const totalCredits = pack.credits + pack.bonus;
  if (totalCredits <= 0) return Number.POSITIVE_INFINITY;
  return pack.eur / totalCredits;
}

/**
 * Spec §2 margin invariant (non-negotiable): the effective €/credit charged
 * ALWAYS exceeds our raw inference cost. With 1 credit calibrated to
 * `rawEurPerCredit` of inference at cost, the +40% markup means the effective
 * price must be ≥ rawEurPerCredit. Returns true iff the pack honours it.
 *
 * This is a desktop-side GUARD on whatever the server advertised — if a 402
 * body ever carried a margin-negative pack, the wall must NOT default-select it.
 */
export function marginInvariantHolds(pack: CreditPack, rawEurPerCredit: number): boolean {
  if (rawEurPerCredit <= 0) return false;
  return packEffectiveCostPerCredit(pack) > rawEurPerCredit;
}

// ---------------------------------------------------------------------------
// The live credit meter (spec §3: "X of allowance used / cap")
// ---------------------------------------------------------------------------

export interface CreditMeterModel {
  tier: CreditsTier;
  /** Free-tier path: show actions used / cap instead of credit allowance. */
  isFree: boolean;
  /** Allowance credits remaining (paid tiers). */
  allowanceRemaining: number;
  /** Purchased credits remaining (paid tiers; survive the period). */
  purchasedRemaining: number;
  /** Total spendable credits remaining (allowance + purchased). */
  totalRemaining: number;
  /** Fraction of the allowance ALREADY USED, in [0,1]. Drives the bar fill. */
  allowanceUsedFraction: number;
  /** Free-tier actions used / cap (only meaningful when isFree). */
  freeActionsUsed: number;
  freeCap: number;
  /** The user's spend cap in EUR cents (0 ⇒ uncapped). */
  spendCapEurCents: number;
}

/**
 * Allowance constants in CREDITS (NEW server billing model: 1 credit = 0.1 ct).
 * A full Starter seat ships a 60,000-credit monthly allowance (= 60€ face value);
 * Solo ≈ 38,000. We compute the "used" fraction from the period grant minus what
 * remains; the grant is derived from the tier (the server is authoritative, but
 * the meter is a read-only display and only needs the resting full-grant size).
 */
export const TIER_ALLOWANCE_CREDITS: Record<CreditsTier, number> = {
  free: 0,
  solo: 38_000,
  starter: 60_000,
};

/**
 * Build the meter view-model from a credits-status snapshot. Pure: the bar fill,
 * the "used/cap" copy and the free-vs-paid split all derive from this.
 *
 * `allowanceUsedFraction` is clamped to [0,1] so a server drift (remaining >
 * grant after a top-up, or a negative) can never produce a broken bar.
 */
export function buildCreditMeterModel(status: CreditsStatus): CreditMeterModel {
  const allowanceRemaining = Math.max(0, status.included_allowance_credits_remaining);
  const purchasedRemaining = Math.max(0, status.purchased_credits_remaining);
  const totalRemaining = allowanceRemaining + purchasedRemaining;
  const hasCreditTank = totalRemaining > 0;
  const effectiveTier: CreditsTier = status.tier === 'free' && hasCreditTank ? 'starter' : status.tier;
  const isFree = effectiveTier === 'free' && !hasCreditTank;
  const grant = TIER_ALLOWANCE_CREDITS[effectiveTier] ?? 0;

  let allowanceUsedFraction: number;
  if (status.tier === 'free' && hasCreditTank) {
    // 1.6.2: a FREE seat WITH a credit balance renders the TANK (showsFreeActionMeter
    // routes it into the paid branches) — so the fraction MUST be tank-referenced
    // too. Metering it on daily actions painted "100% of allowance used" in warn-red
    // next to a full tank (review finding). Reference = the starter grant, the same
    // fallback the popover uses for an unknown grant size.
    const reference = TIER_ALLOWANCE_CREDITS.starter;
    allowanceUsedFraction = clamp01((reference - totalRemaining) / reference);
  } else if (isFree) {
    // Free tier meters ACTIONS against the free cap, not credits.
    const cap = status.free_cap > 0 ? status.free_cap : 1;
    allowanceUsedFraction = clamp01(status.free_actions_used_this_period / cap);
  } else if (grant <= 0) {
    allowanceUsedFraction = 0;
  } else {
    const used = grant - allowanceRemaining;
    allowanceUsedFraction = clamp01(used / grant);
  }

  return {
    tier: effectiveTier,
    isFree,
    allowanceRemaining,
    purchasedRemaining,
    totalRemaining,
    allowanceUsedFraction,
    freeActionsUsed: Math.max(0, status.free_actions_used_this_period),
    freeCap: Math.max(0, status.free_cap),
    spendCapEurCents: Math.max(0, status.spend_cap_eur_cents),
  };
}

/**
 * Whether a meter surface should render the FREE daily-action view. A free-tier
 * seat that HOLDS a credit balance (a recurring pack without a client seat — the
 * M6 free-seat ladder — or a manual grant) must render the credit TANK instead:
 * hiding a paid-for balance behind the action meter made it invisible on every
 * surface at once (live incident 2026-07-03, founder account). The free view
 * belongs only to the genuinely credit-less seat.
 */
export function showsFreeActionMeter(model: CreditMeterModel): boolean {
  return model.isFree && model.totalRemaining <= 0;
}

/** Spec §3 wall trigger: the allowance has crossed ~85% used. */
export const WALL_THRESHOLD_FRACTION = 0.85;

/** True iff the balance has crossed the ~85% wall threshold (display hint). */
export function isNearAllowanceWall(model: CreditMeterModel): boolean {
  // 1.6.2: the free ACTION wall only owns the credit-less free seat — a free seat
  // rendering the tank (balance > 0) must warn on the TANK fraction, or a spent
  // daily allowance would flag "Tank fast leer" beside a full tank.
  if (showsFreeActionMeter(model)) {
    if (model.freeCap <= 0) return false;
    return model.freeActionsUsed / model.freeCap >= WALL_THRESHOLD_FRACTION;
  }
  return model.allowanceUsedFraction >= WALL_THRESHOLD_FRACTION;
}

// ---------------------------------------------------------------------------
// Idle-suppression (spec §3: "SUPPRESS the wall when idle")
// ---------------------------------------------------------------------------

/**
 * The wall / upsell may ONLY surface when a job is IN-FLIGHT (mid-flow). An idle
 * wall = no urgency + scares skeptics (spec §3). This is the single decision the
 * whole wall pipeline gates on. Pure so it is exhaustively unit-tested.
 *
 * @param jobInFlight  true iff a conversation turn / deliverable is currently running
 * @param hasQuotaSignal true iff a 402 quota_exhausted was just received for this job
 */
export function shouldSurfaceQuotaWall(args: { jobInFlight: boolean; hasQuotaSignal: boolean }): boolean {
  return args.jobInFlight === true && args.hasQuotaSignal === true;
}

// ---------------------------------------------------------------------------
// The 402 quota_exhausted WALL (spec §3: framed "finish THIS job")
// ---------------------------------------------------------------------------

/**
 * Parse an unknown response body into a typed QuotaExhaustedBody, or null if it
 * is not a well-formed quota_exhausted body. Defensive: the renderer must never
 * crash on a malformed 402; a null result simply means "render the generic
 * error path, not the wall".
 */
export function parseQuotaExhaustedBody(body: unknown): QuotaExhaustedBody | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.error !== 'quota_exhausted') return null;
  const creditsNeeded = typeof b.credits_needed === 'number' && b.credits_needed >= 0 ? b.credits_needed : null;
  if (creditsNeeded === null) return null;
  const rawPacks = Array.isArray(b.packs) ? b.packs : [];
  const packs: CreditPack[] = [];
  for (const p of rawPacks) {
    if (!p || typeof p !== 'object') continue;
    const pk = p as Record<string, unknown>;
    if (typeof pk.eur !== 'number' || typeof pk.credits !== 'number') continue;
    packs.push({
      eur: pk.eur,
      credits: pk.credits,
      bonus: typeof pk.bonus === 'number' ? pk.bonus : 0,
    });
  }
  return { error: 'quota_exhausted', credits_needed: creditsNeeded, packs };
}

/**
 * Detect a 402 quota_exhausted from a thrown inference error. The EVE-inference
 * call runs through the OpenAI-compatible client; an HTTP 402 surfaces as an
 * error whose message/status carries the structured body. This mirrors the
 * existing `errorDetection.ts` string-match style but is 402-specific and also
 * recovers the structured body when the client preserved it.
 */
export function detectQuotaExhausted(error: unknown): QuotaExhaustedBody | null {
  if (!error) return null;
  // Prefer a preserved structured body / response.
  const e = error as Record<string, unknown>;
  const directBody =
    parseQuotaExhaustedBody(e.body) ??
    parseQuotaExhaustedBody((e.response as Record<string, unknown> | undefined)?.data) ??
    parseQuotaExhaustedBody(e.data);
  if (directBody) return directBody;
  // Fall back to a status + message string sniff.
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const message = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  const looks402 = status === 402 || /\b402\b/.test(message);
  const looksQuota = /quota_exhausted|quota.exhausted/i.test(message);
  if (looks402 && looksQuota) {
    // Try to extract an embedded JSON body from the message.
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = parseQuotaExhaustedBody(JSON.parse(jsonMatch[0]));
        if (parsed) return parsed;
      } catch {
        /* fall through to a minimal body */
      }
    }
    return { error: 'quota_exhausted', credits_needed: 0, packs: [] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The 429 free-DAILY-cap wall (v1.6.x). NOT the 402 credits wall: the free tier
// has no credit tank — it has a per-day action allowance. When it is spent, the
// shim rewrites the upstream 429 into a friendly chat error (type
// 'eve_daily_cap'). Today that lands as a COLD chat bubble; this detector lets
// the renderer surface a WARM wall instead. Founder doctrine (free tier): NEVER
// a buy link — the allowance simply resets tomorrow.
// ---------------------------------------------------------------------------

/**
 * Detect the free-tier daily-cap signal from a thrown/relayed inference error.
 * Prefers the structured `type: 'eve_daily_cap'` the shim sets; falls back to a
 * string sniff (the ACP layers can flatten the structured error to a string).
 * Returns null for anything else (a 402 credits-exhaust is handled by
 * detectQuotaExhausted and must win — call this AFTER it).
 */
export function detectDailyCapReached(error: unknown): { reached: true } | null {
  if (!error) return null;
  const e = error as Record<string, unknown>;
  // Structured: the shim sets error.type = 'eve_daily_cap' (also check nested).
  const typeOf = (o: unknown): string =>
    o && typeof o === 'object' && typeof (o as Record<string, unknown>).type === 'string'
      ? ((o as Record<string, unknown>).type as string)
      : '';
  if (
    typeOf(e) === 'eve_daily_cap' ||
    typeOf(e.error) === 'eve_daily_cap' ||
    typeOf((e.response as Record<string, unknown> | undefined)?.data) === 'eve_daily_cap' ||
    typeOf(e.data) === 'eve_daily_cap'
  ) {
    return { reached: true };
  }
  // String sniff: explicit marker, or a 429 paired with the German cap wording.
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const message = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  if (/eve_daily_cap/i.test(message)) return { reached: true };
  const looks429 = status === 429 || /\b429\b/.test(message);
  const looksCap = /tageskontingent|tageslimit|daily (cap|limit|allowance)/i.test(message);
  if (looks429 && looksCap) return { reached: true };
  return null;
}

export interface WallPack extends CreditPack {
  /** Total credits delivered (base + bonus). */
  totalCredits: number;
  /** How many MORE jobs like this the pack buys, given credits_needed. */
  jobsLikeThis: number;
  /** Effective €/credit (transparent-math + margin guard). */
  effectiveCostPerCredit: number;
  /** True for the pack the wall default-selects (the 100€, else 250€, else largest). */
  isDefaultSelected: boolean;
}

export interface WallModel {
  /** Credits this in-flight job still needs. */
  creditsNeeded: number;
  /** The packs, enriched with transparent math + the default selection flag. */
  packs: WallPack[];
  /** Index of the default-selected pack in `packs`, or -1 if no packs. */
  defaultPackIndex: number;
}

/**
 * Pick the default-select pack index (spec §3: "default-select the 100/250
 * pack"). Preference order: the 100€ pack, else the 250€ pack, else the largest
 * pack by total credits. A pack that fails the margin invariant (when a raw cost
 * is supplied) is never default-selected.
 */
export function selectDefaultPackIndex(packs: CreditPack[], rawEurPerCredit?: number): number {
  if (packs.length === 0) return -1;
  const eligible = (i: number): boolean =>
    rawEurPerCredit === undefined || marginInvariantHolds(packs[i], rawEurPerCredit);

  const find = (eur: number): number => packs.findIndex((p, i) => p.eur === eur && eligible(i));
  const hundred = find(100);
  if (hundred >= 0) return hundred;
  const twoFifty = find(250);
  if (twoFifty >= 0) return twoFifty;

  // Fall back to the largest eligible pack by total credits.
  let best = -1;
  let bestCredits = -1;
  for (let i = 0; i < packs.length; i++) {
    if (!eligible(i)) continue;
    const total = packs[i].credits + packs[i].bonus;
    if (total > bestCredits) {
      bestCredits = total;
      best = i;
    }
  }
  // If nothing is eligible (all margin-negative), fall back to the first pack so
  // the wall still renders — but it is flagged via marginInvariantHolds upstream.
  return best >= 0 ? best : 0;
}

/**
 * Build the full wall view-model from a parsed 402 body. Computes the
 * TRANSPARENT CREDIT MATH ("this job ≈ N credits; the 100-pack ≈ M more jobs
 * like this") and the DEFAULT-SELECTED pack. `rawEurPerCredit` (optional) lets
 * the desktop margin-guard the server packs.
 */
export function buildWallModel(body: QuotaExhaustedBody, rawEurPerCredit?: number): WallModel {
  const packsSrc = body.packs.length > 0 ? body.packs : [...DEFAULT_CREDIT_PACKS];
  const defaultIndex = selectDefaultPackIndex(packsSrc, rawEurPerCredit);
  const needed = body.credits_needed > 0 ? body.credits_needed : 0;

  const packs: WallPack[] = packsSrc.map((pack, i) => {
    const totalCredits = pack.credits + pack.bonus;
    // "≈ M more jobs like this": how many jobs of `credits_needed` the pack buys.
    const jobsLikeThis = needed > 0 ? Math.floor(totalCredits / needed) : totalCredits;
    return {
      ...pack,
      totalCredits,
      jobsLikeThis,
      effectiveCostPerCredit: packEffectiveCostPerCredit(pack),
      isDefaultSelected: i === defaultIndex,
    };
  });

  return { creditsNeeded: needed, packs, defaultPackIndex: defaultIndex };
}

// ---------------------------------------------------------------------------
// €-value receipt (spec §3: "EVE shipped X ≈ 3-4h / ~350€ of your work")
// ---------------------------------------------------------------------------

export interface ValueReceiptInput {
  /** What EVE shipped, in the persona's own verb (e.g. "32 ad variants"). */
  artifact: string;
  /** Estimated hours of the user's own work this deliverable replaced. */
  estimatedHours: number;
  /**
   * The user's blended €/h rate used to monetize the hours. The desktop carries
   * a sensible default (an agency hourly), founder-overridable in settings.
   */
  hourlyRateEur: number;
}

/** A conservative default agency hourly rate for the value-receipt monetization. */
export const DEFAULT_VALUE_RECEIPT_HOURLY_EUR = 90;

export interface ValueReceiptModel {
  artifact: string;
  /** Rounded hours, min 1 so a deliverable never reads "~0h". */
  hours: number;
  /** Monetized €-value (hours × rate), rounded to a tidy figure. */
  eurValue: number;
  /** The headline string the receipt component renders. */
  headline: string;
}

/**
 * Build the €-value receipt — the value framing that fires the take-the-max
 * trigger (spec §3). Pure + deterministic so the displayed €/hours are tested.
 * Hours are floored to a minimum of 1; €-value is rounded to the nearest 10€
 * for a clean "~350€" feel.
 */
export function buildValueReceiptModel(input: ValueReceiptInput): ValueReceiptModel {
  const hours = Math.max(1, Math.round(input.estimatedHours));
  const rate = input.hourlyRateEur > 0 ? input.hourlyRateEur : DEFAULT_VALUE_RECEIPT_HOURLY_EUR;
  const rawEur = hours * rate;
  const eurValue = Math.round(rawEur / 10) * 10;
  const headline = `EVE shipped ${input.artifact} ≈ ~${hours}h / ~${eurValue}€ of your work`;
  return { artifact: input.artifact, hours, eurValue, headline };
}

// ---------------------------------------------------------------------------
// Spend-cap validation (spec §3: user spend-cap setting)
// ---------------------------------------------------------------------------

/** Hard ceiling on the user-settable spend cap (sanity bound; 100k€ in cents). */
export const SPEND_CAP_MAX_EUR_CENTS = 100_000_00;

export interface SpendCapValidation {
  ok: boolean;
  /** Normalized cents value to persist (0 ⇒ uncapped). Only meaningful when ok. */
  eurCents: number;
  reasonCode?: 'NEGATIVE' | 'NOT_INTEGER' | 'ABOVE_MAX';
}

/**
 * Validate + normalize a user-entered spend cap (euros, possibly fractional)
 * into integer cents to write to `spend_cap_eur_cents`. 0/empty ⇒ uncapped.
 * Rejects negatives and absurd values; rounds to whole cents.
 */
export function validateSpendCapEur(eur: number | null | undefined): SpendCapValidation {
  if (eur === null || eur === undefined || eur === 0) {
    return { ok: true, eurCents: 0 };
  }
  if (typeof eur !== 'number' || Number.isNaN(eur)) {
    return { ok: false, eurCents: 0, reasonCode: 'NOT_INTEGER' };
  }
  if (eur < 0) {
    return { ok: false, eurCents: 0, reasonCode: 'NEGATIVE' };
  }
  const cents = Math.round(eur * 100);
  if (cents > SPEND_CAP_MAX_EUR_CENTS) {
    return { ok: false, eurCents: 0, reasonCode: 'ABOVE_MAX' };
  }
  return { ok: true, eurCents: cents };
}

// ---------------------------------------------------------------------------
// Day-0 onboarding hook (spec §3: force ONE real client input)
// ---------------------------------------------------------------------------

export type ClientSeedKind = 'connect_client' | 'paste_brief';

export interface ClientSeedInput {
  kind: ClientSeedKind;
  /** The pasted brief text, or a connector/client identifier. */
  value: string;
}

/**
 * Whether the Day-0 onboarding requirement is satisfied: ONE real client input
 * has seeded the Company-Brain. A blank/whitespace brief does NOT count — the
 * point is a real switching-cost seed (spec §3).
 */
export function isClientSeedSatisfied(seed: ClientSeedInput | null | undefined): boolean {
  if (!seed) return false;
  return typeof seed.value === 'string' && seed.value.trim().length > 0;
}

/**
 * Whether to FORCE the Day-0 onboarding (show the one-client-input prompt). It
 * fires once, on first run, until a real seed is recorded. `alreadySeeded`
 * comes from a persisted config flag so it never re-nags after the seed.
 */
export function shouldForceDayZeroOnboarding(args: {
  alreadySeeded: boolean;
  seed: ClientSeedInput | null | undefined;
}): boolean {
  if (args.alreadySeeded) return false;
  return !isClientSeedSatisfied(args.seed);
}

// ---------------------------------------------------------------------------
// Gen-B seat-pricing model (0€-forever own seat + client-seat expansion)
// ---------------------------------------------------------------------------

/** The desktop billing-status view a Gen-B money surface renders. */
export interface SeatBillingStatus {
  /** True for the free own-seat (EVE Solo, 0 € for ever). */
  isFreeOwnSeat: boolean;
  /** The own-seat monthly price in € (0 for the free own seat). */
  ownSeatEur: number;
  /** The price a NEW client seat starts at (the +99€/seat expansion). */
  clientSeatFromEur: number;
}

/**
 * Build the Gen-B billing status the desktop money surfaces render. Replaces the
 * legacy `buildPricingPlans` (79€ Starter + hidden 49€ Solo) which sold a "plan".
 * Gen-B sells the operator's OWN seat FREE for ever and CLIENT seats from 99 €;
 * `isFreeOwnSeat` is true when the current tier is the free own seat.
 */
export function buildSeatBillingStatus(args: { tier: CreditsTier }): SeatBillingStatus {
  return {
    isFreeOwnSeat: args.tier === 'free',
    ownSeatEur: OWN_SEAT_EUR,
    clientSeatFromEur: CLIENT_SEAT_FROM_EUR,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
