// Command EVE — entitlement-status Edge Function (§2a, with CORS).
//
// ONLINE REVOCATION CHECK. The desktop gate verifies a CEVE license offline; a
// refunded / canceled / deleted account otherwise stays 'entitled' forever
// offline. This function lets the desktop ask the server "is this license still
// good?" — it takes the raw CEVE WIRE as the Bearer credential (NOT a Supabase
// JWT), verifies its Ed25519 signature SERVER-SIDE with the public key derived
// from COMMAND_EVE_LICENSE_SIGNING_KEY (exactly like eve-inference), looks up the
// live entitlements row by the payload's tenant_serial (= tenant_id) + serial
// (= code_serial), and returns a conclusive decision.
//
// AUTH MODEL (mirrors eve-inference, NOT my-license): the license wire is the
// credential, so this MUST be deployed with verify_jwt = FALSE:
//   `supabase functions deploy entitlement-status --no-verify-jwt`
//
// Response: { decision: 'valid'|'revoked'|'expired'|'unknown', edition?,
//             expires_at?, trial_ends_at?, checked_at }
//   - valid   : the license verifies AND the entitlements row is active/trialing
//               and not past its time bound;
//   - expired : the license/entitlement is past its expires_at / trial_ends_at;
//   - revoked : the entitlements row exists but is canceled/past_due/incomplete,
//               OR there is NO live row for a once-issued code (account/tenant
//               removed) — the desktop drops the local entitlement on this;
//   - unknown : we could NOT reach a definitive verdict (bad/forged wire, no
//               matching code, backend lookup error). The desktop treats
//               'unknown' as NON-CONCLUSIVE and leaves the offline state intact.
//
// The DESKTOP is fail-safe: it only acts on a conclusive 'revoked'/'expired'. So
// emitting 'unknown' whenever we are unsure is the safe, no-lockout default here.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";
import crypto from "node:crypto";
import {
  decideEntitlementStatus,
  type EntitlementRow,
  type EntitlementStatusResponse,
} from "./status-core.ts";
import { verifyLicenseCode } from "../_shared/license-code-core.ts";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

/** A non-conclusive 'unknown' verdict (the desktop leaves its state untouched). */
function unknown(req: Request, now: string, status = 200): Response {
  const body: EntitlementStatusResponse = { decision: "unknown", checked_at: now };
  return jsonResponse(req, body, status);
}

// Derive the Ed25519 PUBLIC verify key from the server signing PEM ONCE (mirrors
// eve-inference/index.ts). A missing key is an operator/config error.
let cachedPublicKeyPem: string | null = null;
function publicKeyPem(): string {
  if (cachedPublicKeyPem) return cachedPublicKeyPem;
  const signingKeyPem = Deno.env.get("COMMAND_EVE_LICENSE_SIGNING_KEY");
  if (!signingKeyPem) {
    throw new Error("signing_key_not_configured");
  }
  cachedPublicKeyPem = crypto
    .createPublicKey(signingKeyPem)
    .export({ type: "spki", format: "pem" }) as string;
  return cachedPublicKeyPem;
}

export async function handleEntitlementStatus(req: Request): Promise<Response> {
  const now = new Date().toISOString();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse(req, { decision: "unknown", checked_at: now, error: "method_not_allowed" }, 405);
  }

  // The Bearer credential is the raw CEVE WIRE (not a JWT).
  const authHeader = req.headers.get("Authorization") ?? "";
  const wire = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!wire) {
    // No credential ⇒ nothing to decide ⇒ non-conclusive (401 so the desktop's
    // non-2xx path keeps it inert).
    return unknown(req, now, 401);
  }

  // 1) Verify the wire's Ed25519 signature SERVER-SIDE. A bad/forged/expired wire
  //    is non-conclusive for revocation purposes EXCEPT a clean EXPIRED verdict,
  //    which we surface as conclusive 'expired' (the wire itself proves expiry).
  let verify: ReturnType<typeof verifyLicenseCode>;
  try {
    verify = verifyLicenseCode({ code: wire, publicKeyPem: publicKeyPem(), now });
  } catch (_err) {
    // Signing key not configured / invalid ⇒ operator error ⇒ non-conclusive.
    return unknown(req, now, 500);
  }

  if (!verify.ok) {
    // A signed-but-EXPIRED wire is conclusively expired; everything else
    // (malformed / bad signature / version) is non-conclusive ('unknown').
    if (verify.reason_code === "LICENSE_EXPIRED") {
      const body: EntitlementStatusResponse = { decision: "expired", checked_at: now };
      return jsonResponse(req, body);
    }
    return unknown(req, now);
  }

  const payload = verify.payload as {
    serial: string;
    tenant_serial: string;
    edition?: string;
    expires_at?: string | null;
    trial_ends_at?: string | null;
  };

  // 2) Look up the live entitlements row (service-role; clients can't read it).
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    // Backend not configured ⇒ non-conclusive (never lock the user out on our gap).
    return unknown(req, now, 500);
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // tenant_serial defaults to tenant_id (the multi-tenant seam, trial-mint-core),
  // and serial is the code_serial (stringified).
  let row: EntitlementRow | null = null;
  try {
    const { data, error } = await admin
      .from("entitlements")
      .select("status, edition, expires_at, trial_ends_at, code_serial, tenant_id")
      .eq("tenant_id", payload.tenant_serial)
      .eq("code_serial", String(payload.serial))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      // A lookup error is non-conclusive — do NOT invalidate on our backend hiccup.
      return unknown(req, now, 500);
    }
    row = (data as EntitlementRow | null) ?? null;
  } catch (_err) {
    return unknown(req, now, 500);
  }

  // 3) Decide (pure). The wire payload supplies the offline-truth fallbacks.
  const decision = decideEntitlementStatus({
    row,
    wire: {
      edition: payload.edition,
      expires_at: payload.expires_at ?? null,
      trial_ends_at: payload.trial_ends_at ?? null,
    },
    now,
  });

  return jsonResponse(req, { ...decision, checked_at: now });
}

if (typeof Deno !== "undefined" && (import.meta as { main?: boolean }).main) {
  Deno.serve(handleEntitlementStatus);
}
