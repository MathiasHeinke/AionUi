// Command EVE - eve-title Edge Function.
//
// AUTH MODEL: the Bearer credential is the raw CEVE license WIRE, not a
// Supabase JWT. Deploy with:
//   supabase functions deploy eve-title --no-verify-jwt
//
// The OpenRouter key is server-side only (`OPENROUTER_API_KEY`). Desktop builds
// never carry the provider key and this endpoint does not draw seat credits.

import crypto from 'node:crypto';
import {
  buildEveTitlePrompt,
  EVE_TITLE_DEFAULT_MODEL,
  type EveTitleRequest,
  prepareEveTitleRequestBody,
  sanitizeEveGeneratedTitle,
} from './title-core.ts';
import { verifyLicenseCode } from '../_shared/license-code-core.ts';

type FetchLike = typeof fetch;

type EveTitleHandlerDeps = {
  fetch?: FetchLike;
};

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['app://command-eve', 'http://localhost:1420', 'http://localhost:5173']);

function allowedOrigins(): readonly string[] {
  const configured = Deno.env.get('EVE_TITLE_ALLOWED_ORIGINS');
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  const allowOrigin = !origin ? '*' : allowedOrigins().includes(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(req) },
  });
}

function blocked(req: Request, error: string, status: number, checkedAt: string): Response {
  return jsonResponse(req, { ok: false, error, checked_at: checkedAt }, status);
}

let cachedPublicKeyPem: string | null = null;
export function resetEveTitlePublicKeyCacheForTests(): void {
  cachedPublicKeyPem = null;
}

function publicKeyPem(): string {
  if (cachedPublicKeyPem) return cachedPublicKeyPem;
  const signingKeyPem = Deno.env.get('COMMAND_EVE_LICENSE_SIGNING_KEY');
  if (!signingKeyPem) {
    throw new Error('signing_key_not_configured');
  }
  cachedPublicKeyPem = crypto.createPublicKey(signingKeyPem).export({ type: 'spki', format: 'pem' }) as string;
  return cachedPublicKeyPem;
}

function titleTimeoutMs(): number {
  const raw = Deno.env.get('EVE_TITLE_OPENROUTER_TIMEOUT_MS');
  const parsed = raw ? Number(raw) : 12_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12_000;
}

async function callOpenRouterTitle(args: {
  apiKey: string;
  request: EveTitleRequest;
  timeoutMs: number;
  fetchFn: FetchLike;
}): Promise<{ ok: true; title: string } | { ok: false; error: string; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await args.fetchFn(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: Deno.env.get('EVE_TITLE_OPENROUTER_MODEL') || EVE_TITLE_DEFAULT_MODEL,
        messages: buildEveTitlePrompt(args.request),
        temperature: 0.2,
        max_tokens: 64,
      }),
    });
    if (!response.ok) {
      return { ok: false, error: 'provider_error', status: 502 };
    }
    const raw = await response.json().catch((): null => null);
    const content = (raw as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message
      ?.content;
    const title = sanitizeEveGeneratedTitle(content);
    if (!title) {
      return { ok: false, error: 'provider_empty_title', status: 502 };
    }
    return { ok: true, title };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? 'provider_timeout' : 'provider_error',
      status: aborted ? 504 : 502,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleEveTitle(req: Request, deps: EveTitleHandlerDeps = {}): Promise<Response> {
  const now = new Date().toISOString();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== 'POST') {
    return blocked(req, 'method_not_allowed', 405, now);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const wire = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!wire) {
    return blocked(req, 'license_missing', 401, now);
  }

  let verify: ReturnType<typeof verifyLicenseCode>;
  try {
    verify = verifyLicenseCode({
      code: wire,
      publicKeyPem: publicKeyPem(),
      now,
    });
  } catch (_err) {
    return blocked(req, 'server_not_configured', 503, now);
  }

  if (!verify.ok) {
    if (verify.reason_code === 'LICENSE_EXPIRED') {
      return blocked(req, 'license_expired', 403, now);
    }
    return blocked(req, 'license_invalid', 401, now);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (_err) {
    return blocked(req, 'invalid_json', 400, now);
  }

  const prepared = prepareEveTitleRequestBody(body);
  if (!prepared.ok) {
    return blocked(req, prepared.error, prepared.status, now);
  }

  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) {
    return blocked(req, 'provider_not_configured', 503, now);
  }

  const title = await callOpenRouterTitle({
    apiKey,
    request: prepared.request,
    timeoutMs: titleTimeoutMs(),
    fetchFn: deps.fetch ?? fetch,
  });
  if (!title.ok) {
    return blocked(req, title.error, title.status, now);
  }

  return jsonResponse(req, { ok: true, title: title.title, checked_at: now }, 200);
}

if (typeof Deno !== 'undefined' && (import.meta as { main?: boolean }).main) {
  Deno.serve((req) => handleEveTitle(req));
}
