// Command EVE — entitlement-status decision core, deno test (§2a).
//
// Proves the conclusive-verdict logic the desktop online re-verify depends on:
//   - no live row for a verified code        -> revoked (account removed);
//   - canceled / past_due / incomplete       -> revoked;
//   - active + past expires_at               -> expired;
//   - trialing + past trial_ends_at          -> expired;
//   - active / trialing within bounds        -> valid (+ edition surfaced);
//   - unrecognized status                    -> unknown (non-conclusive);
//   - the wire's own bounds are the fallback when the row omits them.
//
// Run: deno test supabase/functions/entitlement-status/status-core.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { decideEntitlementStatus, type EntitlementRow } from "./status-core.ts";

const NOW = "2026-06-22T12:00:00.000Z";
const PAST = "2026-06-01T00:00:00.000Z";
const FUTURE = "2026-12-31T00:00:00.000Z";

function row(over: Partial<EntitlementRow>): EntitlementRow {
  return { status: "active", edition: "standard", expires_at: null, trial_ends_at: null, ...over };
}

Deno.test("no live row for a verified code => revoked (account/tenant removed)", () => {
  const r = decideEntitlementStatus({ row: null, wire: {}, now: NOW });
  assertEquals(r.decision, "revoked");
});

Deno.test("canceled / past_due / incomplete => revoked", () => {
  for (const status of ["canceled", "past_due", "incomplete"]) {
    const r = decideEntitlementStatus({ row: row({ status }), wire: {}, now: NOW });
    assertEquals(r.decision, "revoked", `status=${status}`);
  }
});

Deno.test("active + within expires_at => valid (edition surfaced)", () => {
  const r = decideEntitlementStatus({ row: row({ status: "active", expires_at: FUTURE }), wire: {}, now: NOW });
  assertEquals(r.decision, "valid");
  assertEquals(r.edition, "standard");
  assertEquals(r.expires_at, FUTURE);
});

Deno.test("active + perpetual (null expires_at) => valid", () => {
  const r = decideEntitlementStatus({ row: row({ status: "active", expires_at: null }), wire: {}, now: NOW });
  assertEquals(r.decision, "valid");
});

Deno.test("active + past expires_at => expired", () => {
  const r = decideEntitlementStatus({ row: row({ status: "active", expires_at: PAST }), wire: {}, now: NOW });
  assertEquals(r.decision, "expired");
  assertEquals(r.expires_at, PAST);
});

Deno.test("trialing + within trial_ends_at => valid", () => {
  const r = decideEntitlementStatus({ row: row({ status: "trialing", trial_ends_at: FUTURE }), wire: {}, now: NOW });
  assertEquals(r.decision, "valid");
  assertEquals(r.trial_ends_at, FUTURE);
});

Deno.test("trialing + past trial_ends_at => expired (trial gates on trial_ends_at)", () => {
  const r = decideEntitlementStatus({ row: row({ status: "trialing", trial_ends_at: PAST, expires_at: FUTURE }), wire: {}, now: NOW });
  assertEquals(r.decision, "expired");
  assertEquals(r.trial_ends_at, PAST);
});

Deno.test("unrecognized status => unknown (non-conclusive)", () => {
  const r = decideEntitlementStatus({ row: row({ status: "mystery" }), wire: {}, now: NOW });
  assertEquals(r.decision, "unknown");
});

Deno.test("the wire's bounds are the fallback when the row omits them", () => {
  // Row is active with no expires_at, but the wire carries a past expiry.
  const r = decideEntitlementStatus({
    row: row({ status: "active", expires_at: null, trial_ends_at: null }),
    wire: { expires_at: PAST },
    now: NOW,
  });
  assertEquals(r.decision, "expired");

  // Row active, wire carries a future expiry => valid.
  const r2 = decideEntitlementStatus({
    row: row({ status: "active", expires_at: null }),
    wire: { expires_at: FUTURE },
    now: NOW,
  });
  assertEquals(r2.decision, "valid");
});
