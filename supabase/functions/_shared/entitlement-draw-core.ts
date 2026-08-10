// Command EVE — entitlement DRAW core (pure, no network).
//
// Decides which entitlements row the METERING path (eve-inference) may draw
// against. This closes the no-online-revocation gap: previously
// resolveEntitlementId did `data.find(active) ?? data[0]`, so a tenant whose only
// entitlement was canceled/revoked/refunded still resolved to that row and KEPT
// DRAWING credits offline forever. The fix makes a non-live
// tenant resolve to null ⇒ loadBalance → null and commitDebit → a reported
// `no_entitlement` miss, which the core turns into a refusal rather than a served
// turn (see eve-inference-core's DebitCommit contract).
//
// Consistent with entitlement-status/status-core.ts (the desktop's online-revoke
// decision): only `active | trialing` are live. A `trialing` row PAST its
// trial_ends_at is lapsed and must not draw even if a webhook has not flipped its
// status yet. For `active` (paid) we trust the status and deliberately do NOT
// enforce expires_at — Stripe keeps a paying subscription `active` and flips it to
// canceled/past_due on failure; enforcing the period-end here would FALSE-DENY a
// paying customer in the window between period-end and the renewal webhook.

export interface DrawableEntitlementRow {
  id: string;
  status: string;
  spend_cap_eur_cents?: number | null;
  created_at?: string | null;
  trial_ends_at?: string | null;
  expires_at?: string | null;
}

export interface DrawableEntitlement {
  entitlementId: string;
  spendCapEurCents: number | null;
}

// at-or-after the bound ⇒ past. null/absent bound ⇒ perpetual (never past).
// NaN-safe: an unparseable date is treated as NOT past (conservative — a present
// status still gates it; we never want a parse glitch to deny a live trial).
function isPastBound(boundIso: string | null | undefined, nowIso: string): boolean {
  if (!boundIso) return false;
  const boundMs = Date.parse(boundIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(boundMs) || Number.isNaN(nowMs)) return false;
  return nowMs >= boundMs;
}

// created_at as ms for newest-first sorting. An unparseable/absent date sorts as
// the OLDEST (−Infinity) so a row with a junk created_at can never out-rank a row
// with a real (even pre-1970, hence negative-ms) timestamp. Only ever decides
// WHICH already-drawable row a debit keys against — never whether a draw is allowed.
function createdAtMs(iso: string | null | undefined): number {
  const ms = Date.parse(iso ?? "");
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Is this row entitled to DRAW metered credit at `nowIso`? */
export function isDrawable(row: DrawableEntitlementRow, nowIso: string): boolean {
  const status = (row?.status ?? "").toLowerCase();
  if (status === "active") return true; // trust Stripe's status (see header note).
  if (status === "trialing") return !isPastBound(row.trial_ends_at, nowIso);
  return false; // canceled | past_due | incomplete | refunded | expired | unknown ⇒ NO.
}

/**
 * Pick the entitlement the metering may draw against, or null (FAIL-CLOSED).
 * Among drawable rows, prefer an `active` paid one; otherwise the most recently
 * created drawable row. Returns null when NO row is drawable — the fix that
 * stops a canceled/revoked/lapsed tenant from drawing.
 */
export function pickDrawableEntitlement(
  rows: DrawableEntitlementRow[],
  nowIso: string,
): DrawableEntitlement | null {
  const drawable = (rows ?? []).filter((r) => isDrawable(r, nowIso));
  if (drawable.length === 0) return null;
  const sorted = [...drawable].sort(
    (a, b) => createdAtMs(b.created_at) - createdAtMs(a.created_at),
  );
  const pick = sorted.find((r) => (r.status ?? "").toLowerCase() === "active") ?? sorted[0];
  return {
    entitlementId: pick.id,
    spendCapEurCents: (pick.spend_cap_eur_cents ?? null) as number | null,
  };
}
