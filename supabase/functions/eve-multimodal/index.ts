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
  extractEveMultimodalTtsText,
} from "./multimodal-core.ts";
import { verifyLicenseCode } from "../_shared/license-code-core.ts";

type FetchLike = typeof fetch;

type EveMultimodalHandlerDeps = {
  fetch?: FetchLike;
};

type EveMultimodalTtsSuccessResponse =
  & Omit<
    EveMultimodalSkeletonResponse,
    "ok" | "reason" | "message" | "artifact"
  >
  & {
    ok: true;
    reason: "provider-complete";
    message: string;
    artifact: {
      status: "created";
      kind: "audio";
      mime_type: string;
      encoding: "base64";
      data_base64: string;
      bytes: number;
    };
  };

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "app://command-eve",
  "http://localhost:1420",
  "http://localhost:5173",
]);

const XAI_TTS_ENDPOINT = "https://api.x.ai/v1/tts";
const MAX_TTS_AUDIO_BYTES = 10 * 1024 * 1024;

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

function isTtsProviderEnabled(): boolean {
  return Deno.env.get("EVE_MULTIMODAL_ENABLE_XAI_TTS") === "true";
}

function ttsTimeoutMs(): number {
  const raw = Deno.env.get("EVE_MULTIMODAL_TTS_TIMEOUT_MS");
  const parsed = raw ? Number(raw) : 30_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function callXaiTts(
  args: {
    apiKey: string;
    text: string;
    voiceId: string;
    language: string;
    timeoutMs: number;
    fetchFn: FetchLike;
  },
): Promise<
  | { ok: true; bytes: Uint8Array; mimeType: string }
  | { ok: false; status: number; reason: string; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await args.fetchFn(XAI_TTS_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: args.text,
        voice_id: args.voiceId,
        language: args.language,
      }),
    });
    if (!response.ok) {
      return {
        ok: false,
        status: 502,
        reason: "provider-error",
        message: `xAI TTS returned HTTP ${response.status}.`,
      };
    }

    const mimeType = response.headers.get("content-type");
    if (!mimeType || !mimeType.toLowerCase().startsWith("audio/")) {
      return {
        ok: false,
        status: 502,
        reason: "provider-error",
        message: "xAI TTS returned a non-audio content type.",
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return {
        ok: false,
        status: 502,
        reason: "provider-empty-audio",
        message: "xAI TTS returned an empty audio body.",
      };
    }
    if (bytes.byteLength > MAX_TTS_AUDIO_BYTES) {
      return {
        ok: false,
        status: 502,
        reason: "provider-audio-too-large",
        message: "xAI TTS returned audio larger than the gateway limit.",
      };
    }

    return {
      ok: true,
      bytes,
      mimeType,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? "provider-timeout" : "provider-error",
      message: aborted ? "xAI TTS timed out." : "xAI TTS request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleEveMultimodal(
  req: Request,
  deps: EveMultimodalHandlerDeps = {},
): Promise<Response> {
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

  if (
    decision.body.reason === "provider-not-enabled" &&
    decision.body.capability === "tts" &&
    decision.body.tts &&
    isTtsProviderEnabled()
  ) {
    const apiKey = Deno.env.get("XAI_API_KEY");
    if (!apiKey) {
      return blocked(
        req,
        "provider-not-configured",
        "xAI TTS is enabled but XAI_API_KEY is not configured server-side.",
        503,
        now,
      );
    }
    const text = extractEveMultimodalTtsText(body);
    if (!text) {
      return jsonResponse(req, responseBody, decision.status);
    }
    const tts = await callXaiTts({
      apiKey,
      text,
      voiceId: decision.body.tts.voice_id,
      language: decision.body.tts.language,
      timeoutMs: ttsTimeoutMs(),
      fetchFn: deps.fetch ?? fetch,
    });
    if (!tts.ok) {
      return blocked(req, tts.reason, tts.message, tts.status, now);
    }

    const successBody: EveMultimodalTtsSuccessResponse = {
      ...responseBody,
      ok: true,
      reason: "provider-complete",
      message: "xAI TTS audio generated.",
      artifact: {
        status: "created",
        kind: "audio",
        mime_type: tts.mimeType,
        encoding: "base64",
        data_base64: bytesToBase64(tts.bytes),
        bytes: tts.bytes.byteLength,
      },
    };
    return jsonResponse(req, successBody, 200);
  }

  return jsonResponse(req, responseBody, decision.status);
}

if (typeof Deno !== "undefined" && (import.meta as { main?: boolean }).main) {
  Deno.serve((req) => handleEveMultimodal(req));
}
