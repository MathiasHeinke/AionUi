// Command EVE — entitlement-status DECISION CORE (pure, §2a).
//
// Given the live entitlements row (or null) for a verified license and the
// wire's own time bounds, decide the conclusive verdict. Split out from index.ts
// so it is unit-testable (deno test) with no network / no Supabase.
//
// SAFETY: 'unknown' is the conservative default the desktop treats as
// NON-CONCLUSIVE (it leaves the offline entitlement untouched). We only emit
// 'revoked'/'expired' when the row (or the wire's own expiry) makes that
// definite, and 'valid' only when the row is active/trialing AND not past its
// time bound.

export type Decision = "valid" | "revoked" | "expired" | "unknown";

export interface EntitlementStatusResponse {
  decision: Decision;
  edition?: string;
  expires_at?: string | null;
  trial_ends_at?: string | null;
  checked_at?: string;
  /** Diagnostic only (never consumed by the desktop gate). */
  error?: string;
}

/** The subset of the entitlements row this decision needs. */
export interface EntitlementRow {
  status: string; // active | trialing | past_due | canceled | incomplete
  edition?: string | null;
  expires_at?: string | null;
  trial_ends_at?: string | null;
  code_serial?: string | null;
  tenant_id?: string | null;
}

export interface DecideArgs {
  /** The live row, or null when no matching entitlement exists. */
  row: EntitlementRow | null;
  /** The verified wire's own fields (offline-truth fallback for time bounds). */
  wire: { edition?: string | null; expires_at?: string | null; trial_ends_at?: string | null };
  /** ISO timestamp for the decision clock. */
  now: string;
}

/** Active server statuses that can still be valid (vs hard-revoked). */
const LIVE_STATUSES = new Set(["active", "trialing"]);
/** Statuses that are a definitive server NO. */
const REVOKED_STATUSES = new Set(["canceled", "past_due", "incomplete"]);

function isPastBound(boundIso: string | null | undefined, nowIso: string): boolean {
  if (!boundIso) return false; // null/absent ⇒ perpetual (never past).
  const boundMs = Date.parse(boundIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(boundMs) || Number.isNaN(nowMs)) return false;
  // Inclusive: at-or-after the bound is past.
  return nowMs >= boundMs;
}

/**
 * Decide the conclusive entitlement verdict.
 *
 *   - no row for an issued + verified code  -> 'revoked' (account/tenant removed);
 *   - row status canceled/past_due/incomplete -> 'revoked';
 *   - row status active/trialing:
 *       * past its trial_ends_at (trial) or expires_at (paid) -> 'expired';
 *       * else -> 'valid';
 *   - any unrecognized status               -> 'unknown' (non-conclusive).
 *
 * The row's time bounds win when present; otherwise the wire's own bounds are the
 * fallback (the wire is signed, so its dates are trustworthy offline truth).
 */
export function decideEntitlementStatus(args: DecideArgs): EntitlementStatusResponse {
  const { row, wire, now } = args;

  // No live row for a code that DID verify ⇒ the server no longer recognizes this
  // entitlement (refund hard-delete / tenant removed) ⇒ a definitive revoke.
  if (!row) {
    return { decision: "revoked" };
  }

  const status = (row.status ?? "").toLowerCase();

  if (REVOKED_STATUSES.has(status)) {
    return { decision: "revoked" };
  }

  if (LIVE_STATUSES.has(status)) {
    // Resolve effective time bounds: prefer the row, fall back to the wire.
    const trialEndsAt = row.trial_ends_at ?? wire.trial_ends_at ?? null;
    const expiresAt = row.expires_at ?? wire.expires_at ?? null;
    const edition = row.edition ?? wire.edition ?? undefined;

    // A trialing entitlement (or any row carrying trial_ends_at) is gated by
    // trial_ends_at; otherwise by expires_at.
    if (trialEndsAt) {
      if (isPastBound(trialEndsAt, now)) {
        return { decision: "expired", ...(edition ? { edition } : {}), trial_ends_at: trialEndsAt };
      }
      return { decision: "valid", ...(edition ? { edition } : {}), trial_ends_at: trialEndsAt, expires_at: expiresAt };
    }

    if (isPastBound(expiresAt, now)) {
      return { decision: "expired", ...(edition ? { edition } : {}), expires_at: expiresAt };
    }
    return { decision: "valid", ...(edition ? { edition } : {}), expires_at: expiresAt };
  }

  // An unrecognized status ⇒ do NOT guess; non-conclusive.
  return { decision: "unknown" };
}
