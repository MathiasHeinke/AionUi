// Command EVE — eve-multimodal Edge Function skeleton.
//
// AUTH MODEL: the Bearer credential is the raw CEVE license WIRE, not a
// Supabase JWT. Deploy with:
//   supabase functions deploy eve-multimodal --no-verify-jwt
//
// This function verifies the CEVE license server-side, validates the multimodal
// request envelope, returns residency/artifact receipt shape, and deliberately
// stops before any provider call.

import crypto from "node:crypto";
import {
  decideEveMultimodalSkeletonRequest,
  type EveMultimodalSkeletonResponse,
} from "./multimodal-core.ts";
import { verifyLicenseCode } from "../_shared/license-code-core.ts";

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "app://command-eve",
  "http://localhost:1420",
  "http://localhost:5173",
]);

function allowedOrigins(): readonly string[] {
  const configured = Deno.env.get("EVE_MULTIMODAL_ALLOWED_ORIGINS");
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowOrigin = !origin
    ? "*"
    : allowedOrigins().includes(origin)
    ? origin
    : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, content-type, apikey, x-client-info",
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

function blocked(
  req: Request,
  reason: string,
  message: string,
  status: number,
  now: string,
): Response {
  const body = {
    ok: false,
    gateway: "eve-multimodal",
    provider: "xai",
    reason,
    message,
    checked_at: now,
  };
  return jsonResponse(req, body, status);
}

let cachedPublicKeyPem: string | null = null;
export function resetEveMultimodalPublicKeyCacheForTests(): void {
  cachedPublicKeyPem = null;
}

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

function requestIdFromBody(body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const requestId = (body as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && requestId.trim().length > 0) {
      return requestId.trim();
    }
  }
  return crypto.randomUUID();
}

export async function handleEveMultimodal(req: Request): Promise<Response> {
  const now = new Date().toISOString();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return blocked(
      req,
      "method-not-allowed",
      "eve-multimodal only accepts POST requests.",
      405,
      now,
    );
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const wire = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!wire) {
    return blocked(
      req,
      "missing-license",
      "A CEVE license bearer is required.",
      401,
      now,
    );
  }

  let verify: ReturnType<typeof verifyLicenseCode>;
  try {
    verify = verifyLicenseCode({
      code: wire,
      publicKeyPem: publicKeyPem(),
      now,
    });
  } catch (_err) {
    return blocked(
      req,
      "server-not-configured",
      "eve-multimodal license verification is not configured.",
      503,
      now,
    );
  }

  if (!verify.ok) {
    if (verify.reason_code === "LICENSE_EXPIRED") {
      return blocked(
        req,
        "license-expired",
        "The CEVE license is expired.",
        403,
        now,
      );
    }
    return blocked(
      req,
      "invalid-license",
      "The CEVE license bearer could not be verified.",
      401,
      now,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (_err) {
    return blocked(
      req,
      "invalid-json",
      "eve-multimodal requires a valid JSON body.",
      400,
      now,
    );
  }

  const decision = decideEveMultimodalSkeletonRequest({
    body,
    now,
    requestId: requestIdFromBody(body),
  });
  const responseBody: EveMultimodalSkeletonResponse = {
    ...decision.body,
    license: {
      verified: true,
      edition: verify.payload.edition,
    },
  };

  return jsonResponse(req, responseBody, decision.status);
}

if (typeof Deno !== "undefined" && (import.meta as { main?: boolean }).main) {
  Deno.serve(handleEveMultimodal);
}
