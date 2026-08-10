// Command EVE 1.820.1 — video generation ATOMIC credit debit/reversal adapter.
//
// e45379a5 admitted that video's "credit reservation" was only `canAfford`: a
// READ, not a debit. Two concurrent paid video requests both pass, and the
// balance never moves. This module is the fix: it drives the ALREADY-TESTED
// atomic ledger substrate — canAfford/applyDebit in ../_shared/credits-core.ts,
// command_eve_commit_debit in 20260704180000_commit_debit_rpc.sql, the exact RPC
// eve-inference already uses for text inference — to actually reserve money
// BEFORE xAI is called, and to reverse that exact debit if the video is never
// produced.
//
// No second balance algorithm: the debit split (from_allowance / from_purchased)
// is computed by the pure, unit-tested canAfford/applyDebit core, exactly like
// eve-inference's commitDebit. This module only adds what video specifically
// needs on top of that shared substrate:
//   * resolving the AUTHORITATIVE drawable entitlement for a tenant, reusing
//     ../_shared/entitlement-draw-core.ts (the same pick eve-inference uses —
//     not a second "which entitlement" algorithm),
//   * an explicit four-way outcome (applied | already | insufficient |
//     unavailable) in place of eve-multimodal's old true/false canAfford read,
//   * the reversal call for a debit that must not survive an unproduced video.

import {
  type AffordDecision,
  applyDebit,
  canAfford,
  type CreditBalance,
  type CreditLedgerRow,
  creditsToEur,
  netPurchasedSpendCredits,
} from '../_shared/credits-core.ts';
import { type DrawableEntitlementRow, pickDrawableEntitlement } from '../_shared/entitlement-draw-core.ts';
import { pickLatestPurchasedCreditCarryover } from '../_shared/purchased-credit-carryover-core.ts';

// Re-exported so existing imports (this module's own tests) keep working —
// the canonical implementation lives in _shared/credits-core.ts because
// eve-inference needs the SAME netting algorithm (see that file's header).
export { netPurchasedSpendCredits };
export type { CreditLedgerRow };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type VideoDebitOutcome =
  | {
      status: 'applied';
      entitlementId: string;
      externalRef: string;
      fromAllowance: number;
      fromPurchased: number;
    }
  | { status: 'already'; entitlementId: string; externalRef: string }
  | {
      status: 'insufficient';
      reason: 'insufficient_credits' | 'spend_cap_exceeded';
    }
  | { status: 'unavailable' };

type CommitDebitRpcResult = 'applied' | 'already' | 'insufficient' | 'no_balance' | 'tenant_mismatch';

/**
 * PURE: maps a canAfford decision + the atomic RPC's result string to the
 * explicit outcome the handler acts on. No I/O, no env — exhaustively
 * unit-testable without a database.
 *
 * `rpcResult` is null whenever the RPC was never reached at all (no drawable
 * entitlement, no readable balance, a network/DB error before the call) — every
 * one of those fails closed as "unavailable", never as an inferred debit.
 * `no_balance` from the RPC itself (the locked row vanished between our read and
 * the lock) fails closed the same way, for the same reason. `tenant_mismatch`
 * (the RPC's own tenant-identity guard) is an integrity signal, not a money
 * question — it also fails closed as "unavailable", never conflated with an
 * ordinary insufficient-funds refusal.
 */
export function resolveCommitDebitOutcome(args: {
  decision: AffordDecision;
  entitlementId: string | null;
  externalRef: string;
  rpcResult: CommitDebitRpcResult | null;
}): VideoDebitOutcome {
  if (!args.decision.ok) {
    return {
      status: 'insufficient',
      reason: args.decision.reason === 'spend_cap_exceeded' ? 'spend_cap_exceeded' : 'insufficient_credits',
    };
  }
  if (
    !args.entitlementId ||
    args.rpcResult === null ||
    args.rpcResult === 'no_balance' ||
    args.rpcResult === 'tenant_mismatch'
  ) {
    return { status: 'unavailable' };
  }
  if (args.rpcResult === 'already') {
    return {
      status: 'already',
      entitlementId: args.entitlementId,
      externalRef: args.externalRef,
    };
  }
  if (args.rpcResult === 'insufficient') {
    // Almost always a concurrent debit that drained the bucket between our
    // read and the RPC's lock — a fresh, real shortfall at the moment of
    // truth, reported the same as any other insufficient-funds refusal. The
    // RPC's own ledger-shape validation (malformed/zero/mismatched ledger)
    // also returns this string, but that path is unreachable from THIS
    // module's own well-formed callers (commitVideoDebit always builds the
    // ledger from applyDebit's decision) — it exists as a defense-in-depth
    // guard, not a normal outcome.
    return { status: 'insufficient', reason: 'insufficient_credits' };
  }
  return {
    status: 'applied',
    entitlementId: args.entitlementId,
    externalRef: args.externalRef,
    fromAllowance: args.decision.from_allowance,
    fromPurchased: args.decision.from_purchased,
  };
}

export type CommitVideoDebitInput = {
  tenantId: string;
  costEurCents: number;
  externalRef: string;
  model: string;
  /**
   * Optional route-time entitlement binding. Vision resolves model quality from
   * one authoritative balance; the debit must land on that same row or fail.
   */
  expectedEntitlementId?: string;
  /**
   * The ledger `reason` for this debit. Defaults to the video wording this
   * module was born for.
   *
   * THE MODULE NAME IS NOW NARROWER THAN ITS JOB, deliberately and visibly. Since
   * MAT-1749 every paid lane in eve-multimodal — TTS, vision, PDF OCR, image
   * generation — reserves through this same atomic substrate, because inventing
   * a second debit adapter per lane is exactly how the first four lanes ended up
   * with no debit at all. Renaming it would touch the injected dep name every
   * handler test drives, and a rename is not a fix; the ledger reason is
   * parameterised instead so each lane's rows say what they are.
   */
  reason?: string;
};

export type CommitVideoDebitFn = (input: CommitVideoDebitInput) => Promise<VideoDebitOutcome>;

export type ReverseVideoDebitInput = {
  entitlementId: string;
  tenantId: string;
  externalRef: string;
  /**
   * The ledger reason written with the reversal. Optional and DEFAULTED to the
   * video wording below so every existing video caller keeps its semantics
   * byte-identically; non-video lanes (image generation) pass their own noun
   * instead of being mislabeled as a video refund (ledger-truth fix 1.820.3).
   */
  reason?: string;
};

export type ReverseVideoDebitFn = (input: ReverseVideoDebitInput) => Promise<{ ok: boolean; reason?: string }>;

const REST_TIMEOUT_MS = 5_000;

type ServiceConfig = { url: string; serviceRoleKey: string };

function supabaseServiceConfig(): ServiceConfig | null {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

async function loadDrawableEntitlement(
  config: ServiceConfig,
  tenantId: string
): Promise<{ entitlementId: string; spendCapEurCents: number | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const endpoint = new URL(
      `/rest/v1/entitlements?tenant_id=eq.${encodeURIComponent(
        tenantId
      )}&select=id,status,spend_cap_eur_cents,created_at,trial_ends_at,expires_at&order=created_at.desc`,
      config.url
    );
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
    });
    if (!response.ok) return null;
    const rows = await response.json();
    if (!Array.isArray(rows)) return null;
    const picked = pickDrawableEntitlement(rows as DrawableEntitlementRow[], new Date().toISOString());
    if (picked) return picked;

    // Purchased credits are owned ledger value, not a trial permission. Mirror
    // eve-inference's canonical carry-over fallback so a lapsed Pilot with a
    // positive purchased bucket can still spend it.
    const ids = rows.map((row) => (isRecord(row) && typeof row.id === 'string' ? row.id : '')).filter(Boolean);
    if (ids.length === 0) return null;
    const balanceEndpoint = new URL('/rest/v1/credit_balances', config.url);
    balanceEndpoint.searchParams.set('entitlement_id', `in.(${ids.join(',')})`);
    balanceEndpoint.searchParams.set('select', 'entitlement_id,purchased_credits_remaining');
    const balanceResponse = await fetch(balanceEndpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
    });
    if (!balanceResponse.ok) return null;
    const balances = await balanceResponse.json();
    if (!Array.isArray(balances)) return null;
    const carryover = pickLatestPurchasedCreditCarryover(rows, balances);
    return carryover
      ? {
          entitlementId: carryover.entitlementId,
          spendCapEurCents: carryover.spendCapEurCents,
        }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Loads the balance for a KNOWN entitlement id (not by tenant — a tenant can
 * have more than one entitlement row over its lifetime, and only the
 * caller-resolved DRAWABLE one is authoritative). `purchased_eur_cents_spent_
 * this_period` is not a stored column (mirrors eve-inference's loadBalance): it
 * is summed from the exact `credits` ledger column, never from the rounded
 * display cents, so the spend-cap check stays exact under sub-cent debits.
 */
async function loadEntitlementBalance(
  config: ServiceConfig,
  entitlementId: string,
  spendCapEurCents: number | null
): Promise<CreditBalance | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const balanceEndpoint = new URL(
      `/rest/v1/credit_balances?entitlement_id=eq.${encodeURIComponent(
        entitlementId
      )}&select=included_allowance_credits_remaining,purchased_credits_remaining,period_start&limit=1`,
      config.url
    );
    const balanceResponse = await fetch(balanceEndpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
    });
    if (!balanceResponse.ok) return null;
    const rows = await balanceResponse.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!isRecord(row)) return null;
    const allowance = Number(row.included_allowance_credits_remaining);
    const purchased = Number(row.purchased_credits_remaining);
    if (!Number.isFinite(allowance) || !Number.isFinite(purchased)) return null;

    const periodStart = typeof row.period_start === 'string' ? row.period_start : '1970-01-01';
    // Pull BOTH the purchased-bucket debits AND every reversal row for the
    // period (a reversal is a single row with bucket=null — see
    // command_eve_reverse_debit — so it cannot be selected by bucket). The
    // NET is computed by the pure netPurchasedSpendCredits below: a debit
    // whose external_ref has a matching reversal is excluded from spend, so a
    // fully-refunded video does not permanently consume the period spend cap.
    const spentEndpoint = new URL(
      `/rest/v1/credit_transactions?entitlement_id=eq.${encodeURIComponent(
        entitlementId
      )}&created_at=gte.${encodeURIComponent(
        periodStart
      )}&or=(kind.eq.reversal,and(kind.eq.debit,bucket.eq.purchased))&select=kind,bucket,credits,external_ref`,
      config.url
    );
    const spentResponse = await fetch(spentEndpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
    });
    if (!spentResponse.ok) return null;
    const spentRows = await spentResponse.json();
    if (!Array.isArray(spentRows)) return null;
    const ledgerRows: CreditLedgerRow[] = [];
    for (const spentRow of spentRows) {
      if (!isRecord(spentRow)) continue;
      const kind = spentRow.kind;
      if (kind !== 'debit' && kind !== 'reversal') continue;
      const bucket = spentRow.bucket;
      const credits = Number(spentRow.credits);
      if (!Number.isFinite(credits)) continue;
      ledgerRows.push({
        kind,
        bucket: bucket === 'included' || bucket === 'purchased' ? bucket : null,
        credits,
        external_ref: typeof spentRow.external_ref === 'string' ? spentRow.external_ref : null,
      });
    }
    const purchasedCreditsSpent = netPurchasedSpendCredits(ledgerRows);

    return {
      included_allowance_credits_remaining: allowance,
      purchased_credits_remaining: purchased,
      spend_cap_eur_cents: spendCapEurCents,
      purchased_eur_cents_spent_this_period: creditsToEur(purchasedCreditsSpent),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callCommitDebitRpc(
  config: ServiceConfig,
  args: {
    entitlementId: string;
    tenantId: string;
    externalRef: string;
    fromAllowance: number;
    fromPurchased: number;
    ledger: unknown[];
  }
): Promise<CommitDebitRpcResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const endpoint = new URL('/rest/v1/rpc/command_eve_commit_debit', config.url);
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_entitlement_id: args.entitlementId,
        p_tenant_id: args.tenantId,
        p_external_ref: args.externalRef,
        p_from_allowance: args.fromAllowance,
        p_from_purchased: args.fromPurchased,
        p_ledger: args.ledger,
      }),
    });
    if (!response.ok) return null;
    const result = await response.json();
    const value = typeof result === 'string' ? result : Array.isArray(result) ? result[0] : null;
    if (
      value === 'applied' ||
      value === 'already' ||
      value === 'insufficient' ||
      value === 'no_balance' ||
      value === 'tenant_mismatch'
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Real, wired implementation: resolves the drawable entitlement, computes the
 * debit split with the pure credits core, and commits it through
 * command_eve_commit_debit. FAIL-CLOSED on every I/O edge — no entitlement, no
 * balance, or any RPC/network failure resolves to "unavailable", never
 * "applied". Bounded retry (at most one re-read) absorbs a concurrent-drain
 * 'insufficient' from the RPC, mirroring eve-inference's commitDebit.
 */
export async function commitVideoDebit(input: CommitVideoDebitInput): Promise<VideoDebitOutcome> {
  const config = supabaseServiceConfig();
  if (!config) return { status: 'unavailable' };

  const entitlement = await loadDrawableEntitlement(config, input.tenantId);
  if (!entitlement) return { status: 'unavailable' };
  if (input.expectedEntitlementId && entitlement.entitlementId !== input.expectedEntitlementId) {
    return { status: 'unavailable' };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const balance = await loadEntitlementBalance(config, entitlement.entitlementId, entitlement.spendCapEurCents);
    if (!balance) return { status: 'unavailable' };

    const decision = canAfford(balance, input.costEurCents);
    if (!decision.ok) {
      return resolveCommitDebitOutcome({
        decision,
        entitlementId: entitlement.entitlementId,
        externalRef: input.externalRef,
        rpcResult: null,
      });
    }

    const applied = applyDebit(balance, input.costEurCents, {
      model: input.model,
      reason: input.reason ?? 'video generation debit',
    });
    if (!applied.ok || !applied.entries) return { status: 'unavailable' };

    const ledger = applied.entries.map((entry) => ({
      credits: entry.credits,
      eur_value_cents: entry.eur_value_cents,
      bucket: entry.bucket,
      reason: entry.reason,
      model: entry.model,
    }));

    const rpcResult = await callCommitDebitRpc(config, {
      entitlementId: entitlement.entitlementId,
      tenantId: input.tenantId,
      externalRef: input.externalRef,
      fromAllowance: decision.from_allowance,
      fromPurchased: decision.from_purchased,
      ledger,
    });

    if (rpcResult === 'insufficient' && attempt === 0) continue; // concurrent drain -> re-read once

    return resolveCommitDebitOutcome({
      decision,
      entitlementId: entitlement.entitlementId,
      externalRef: input.externalRef,
      rpcResult,
    });
  }
  return { status: 'unavailable' };
}

/**
 * The exact JSON body posted to the reverse-debit RPC — pure and exported so
 * the ledger reason can be unit-tested without env or network. The default
 * keeps the video wording byte-identically; a lane passes its own noun
 * through `input.reason` (1.820.3 ledger-truth fix).
 */
export function buildReverseDebitRpcBody(input: ReverseVideoDebitInput): Record<string, string> {
  return {
    p_entitlement_id: input.entitlementId,
    p_tenant_id: input.tenantId,
    p_external_ref: input.externalRef,
    p_reason: input.reason ?? 'video generation not produced',
  };
}

/**
 * Real, wired reversal: calls command_eve_reverse_debit (the additive migration
 * in this same slice). FAIL-CLOSED: any network/DB error or an unrecognised
 * result reports ok:false — the caller must never claim a refund it cannot
 * prove happened. 'reversed' and 'already_reversed' both count as ok (the
 * latter makes a retried reversal call itself idempotent).
 */
export async function reverseVideoDebit(input: ReverseVideoDebitInput): Promise<{ ok: boolean; reason?: string }> {
  const config = supabaseServiceConfig();
  if (!config) return { ok: false, reason: 'reversal-not-configured' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const endpoint = new URL('/rest/v1/rpc/command_eve_reverse_debit', config.url);
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildReverseDebitRpcBody(input)),
    });
    if (!response.ok) {
      return { ok: false, reason: `reversal-http-${response.status}` };
    }
    const result = await response.json();
    const value = typeof result === 'string' ? result : Array.isArray(result) ? result[0] : null;
    if (value === 'reversed' || value === 'already_reversed') {
      return { ok: true };
    }
    return { ok: false, reason: `reversal-unexpected-result-${String(value)}` };
  } catch {
    return { ok: false, reason: 'reversal-network-error' };
  } finally {
    clearTimeout(timeout);
  }
}
