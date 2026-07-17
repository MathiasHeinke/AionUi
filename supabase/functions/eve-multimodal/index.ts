// Command EVE — eve-multimodal Edge Function skeleton.
//
// AUTH MODEL: the Bearer credential is the raw CEVE license WIRE, not a
// Supabase JWT. Deploy with:
//   supabase functions deploy eve-multimodal --no-verify-jwt
//
// This function verifies the CEVE license server-side, validates the multimodal
// request envelope, and executes only explicitly enabled provider capabilities.
// Provider credentials remain server-side and provider payloads are redacted
// before a bounded artifact/receipt is returned to the desktop.

import crypto from 'node:crypto';
import {
  decideEveMultimodalSkeletonRequest,
  type EveMultimodalSkeletonResponse,
  extractEveMultimodalPdfInput,
  extractEveMultimodalTtsText,
} from './multimodal-core.ts';
import { verifyLicenseCode } from '../_shared/license-code-core.ts';

type FetchLike = typeof fetch;

type PdfOcrUsageReservation =
  | {
      ok: true;
      allowed: boolean;
      reason: string;
      tenantUnits: number;
      tenantCap: number;
      globalUnits: number;
      globalCap: number;
      replayed: boolean;
    }
  | { ok: false; reason: string };

type ReservePdfOcrUsage = (input: {
  tenantId: string;
  pages: number;
  tenantCap: number;
  globalCap: number;
  requestFingerprint: string;
}) => Promise<PdfOcrUsageReservation>;

type EveMultimodalHandlerDeps = {
  fetch?: FetchLike;
  reservePdfOcrUsage?: ReservePdfOcrUsage;
};

type EveMultimodalTtsSuccessResponse = Omit<EveMultimodalSkeletonResponse, 'ok' | 'reason' | 'message' | 'artifact'> & {
  ok: true;
  reason: 'provider-complete';
  message: string;
  artifact: {
    status: 'created';
    kind: 'audio';
    mime_type: string;
    encoding: 'base64';
    data_base64: string;
    bytes: number;
  };
};

type EveMultimodalPdfSuccessResponse = Omit<
  EveMultimodalSkeletonResponse,
  'ok' | 'reason' | 'message' | 'artifact' | 'document'
> & {
  ok: true;
  provider: 'openrouter';
  capability: 'document_ocr';
  reason: 'provider-complete';
  message: string;
  artifact: {
    status: 'created';
    kind: 'document';
    mime_type: 'text/markdown';
    encoding: 'utf8';
    text: string;
    bytes: number;
  };
  document: {
    engine: 'mistral-ocr';
    model: string;
    page_count: number;
    parsed_file_hash?: string;
    zdr_enforced: true;
    data_collection: 'deny';
  };
  residency: {
    requestedPrivacyLane: 'cloud_auto';
    effectiveResidency: 'global_cloud';
    confirmation: 'zdr-enforced-global';
  };
  usage: {
    metering: 'daily-page-cap';
    pages_reserved: number;
    tenant_pages_used_today: number;
    tenant_page_cap: number;
    global_pages_used_today: number;
    global_page_cap: number;
  };
};

const DEFAULT_ALLOWED_ORIGINS = Object.freeze(['app://command-eve', 'http://localhost:1420', 'http://localhost:5173']);

const XAI_TTS_ENDPOINT = 'https://api.x.ai/v1/tts';
const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_PDF_MODEL = 'google/gemini-2.5-flash';
const MAX_TTS_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_OPENROUTER_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_PDF_OCR_TENANT_PAGE_CAP = 500;
const DEFAULT_PDF_OCR_GLOBAL_PAGE_CAP = 10_000;

function allowedOrigins(): readonly string[] {
  const configured = Deno.env.get('EVE_MULTIMODAL_ALLOWED_ORIGINS');
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

function blocked(
  req: Request,
  reason: string,
  message: string,
  status: number,
  now: string,
  provider: 'xai' | 'openrouter' = 'xai'
): Response {
  const body = {
    ok: false,
    gateway: 'eve-multimodal',
    provider,
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
  const signingKeyPem = Deno.env.get('COMMAND_EVE_LICENSE_SIGNING_KEY');
  if (!signingKeyPem) {
    throw new Error('signing_key_not_configured');
  }
  cachedPublicKeyPem = crypto.createPublicKey(signingKeyPem).export({ type: 'spki', format: 'pem' }) as string;
  return cachedPublicKeyPem;
}

function requestIdFromBody(body: unknown): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const requestId = (body as { requestId?: unknown }).requestId;
    if (typeof requestId === 'string' && requestId.trim().length > 0) {
      return requestId.trim();
    }
  }
  return crypto.randomUUID();
}

function isTtsProviderEnabled(): boolean {
  return Deno.env.get('EVE_MULTIMODAL_ENABLE_XAI_TTS') === 'true';
}

function isPdfOcrProviderEnabled(): boolean {
  return Deno.env.get('EVE_MULTIMODAL_ENABLE_OPENROUTER_PDF_OCR') === 'true';
}

function openRouterPdfModel(): string {
  const configured = Deno.env.get('EVE_MULTIMODAL_OPENROUTER_PDF_MODEL')?.trim();
  return configured && /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(configured) ? configured : DEFAULT_OPENROUTER_PDF_MODEL;
}

function pdfOcrTimeoutMs(): number {
  const raw = Deno.env.get('EVE_MULTIMODAL_PDF_OCR_TIMEOUT_MS');
  const parsed = raw ? Number(raw) : 80_000;
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 120_000 ? parsed : 80_000;
}

function boundedPositiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const raw = Deno.env.get(name);
  const parsed = raw ? Number(raw) : fallback;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function pdfOcrTenantPageCap(): number {
  return boundedPositiveIntegerEnv(
    'EVE_MULTIMODAL_PDF_OCR_TENANT_PAGE_CAP',
    DEFAULT_PDF_OCR_TENANT_PAGE_CAP,
    1_000_000
  );
}

function pdfOcrGlobalPageCap(): number {
  return boundedPositiveIntegerEnv(
    'EVE_MULTIMODAL_PDF_OCR_GLOBAL_PAGE_CAP',
    DEFAULT_PDF_OCR_GLOBAL_PAGE_CAP,
    10_000_000
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function reservePdfOcrUsage(input: Parameters<ReservePdfOcrUsage>[0]): Promise<PdfOcrUsageReservation> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) return { ok: false, reason: 'usage-gate-not-configured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let data: unknown;
  try {
    const endpoint = new URL('/rest/v1/rpc/command_eve_draw_multimodal_usage', url);
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_tenant_id: input.tenantId,
        p_capability: 'document_ocr',
        p_units: input.pages,
        p_tenant_cap: input.tenantCap,
        p_global_cap: input.globalCap,
        p_request_fingerprint: input.requestFingerprint,
      }),
    });
    const text = await response.text();
    if (!response.ok || new TextEncoder().encode(text).byteLength > 16_384) {
      return { ok: false, reason: 'usage-gate-error' };
    }
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'usage-gate-error' };
  } finally {
    clearTimeout(timeout);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) return { ok: false, reason: 'usage-gate-invalid-response' };

  const tenantUnits = Number(row.tenant_units);
  const tenantCap = Number(row.tenant_cap);
  const globalUnits = Number(row.global_units);
  const globalCap = Number(row.global_cap);
  if (
    typeof row.allowed !== 'boolean' ||
    typeof row.reason !== 'string' ||
    typeof row.replayed !== 'boolean' ||
    !Number.isInteger(tenantUnits) ||
    tenantUnits < 0 ||
    !Number.isInteger(tenantCap) ||
    tenantCap < 1 ||
    !Number.isInteger(globalUnits) ||
    globalUnits < 0 ||
    !Number.isInteger(globalCap) ||
    globalCap < 1
  ) {
    return { ok: false, reason: 'usage-gate-invalid-response' };
  }
  return {
    ok: true,
    allowed: row.allowed,
    reason: row.reason.slice(0, 80),
    tenantUnits,
    tenantCap,
    globalUnits,
    globalCap,
    replayed: row.replayed,
  };
}

function ttsTimeoutMs(): number {
  const raw = Deno.env.get('EVE_MULTIMODAL_TTS_TIMEOUT_MS');
  const parsed = raw ? Number(raw) : 30_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function callXaiTts(args: {
  apiKey: string;
  text: string;
  voiceId: string;
  language: string;
  timeoutMs: number;
  fetchFn: FetchLike;
}): Promise<
  { ok: true; bytes: Uint8Array; mimeType: string } | { ok: false; status: number; reason: string; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await args.fetchFn(XAI_TTS_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
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
        reason: 'provider-error',
        message: `xAI TTS returned HTTP ${response.status}.`,
      };
    }

    const mimeType = response.headers.get('content-type');
    if (!mimeType || !mimeType.toLowerCase().startsWith('audio/')) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-error',
        message: 'xAI TTS returned a non-audio content type.',
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-empty-audio',
        message: 'xAI TTS returned an empty audio body.',
      };
    }
    if (bytes.byteLength > MAX_TTS_AUDIO_BYTES) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-audio-too-large',
        message: 'xAI TTS returned audio larger than the gateway limit.',
      };
    }

    return {
      ok: true,
      bytes,
      mimeType,
    };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? 'provider-timeout' : 'provider-error',
      message: aborted ? 'xAI TTS timed out.' : 'xAI TTS request failed.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripMarkdownFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function hasExactPageHeadings(markdown: string, expectedPageCount: number): boolean {
  const pages = Array.from(markdown.matchAll(/^##\s+(?:PDF\s+)?(?:Page|p\.)\s*(\d+)\s*$/gim)).map((match) =>
    Number(match[1])
  );
  return pages.length === expectedPageCount && pages.every((page, index) => page === index + 1);
}

type OpenRouterFileAnnotation = {
  type: 'file';
  file: {
    hash: string;
    content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  };
};

function isOpenRouterFileAnnotation(value: unknown): value is OpenRouterFileAnnotation {
  if (!isRecord(value) || value.type !== 'file' || !isRecord(value.file)) return false;
  return typeof value.file.hash === 'string' && Array.isArray(value.file.content);
}

function extractOpenRouterFileAnnotations(value: unknown): OpenRouterFileAnnotation[] {
  if (!isRecord(value)) return [];
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const firstChoice = choices[0];
  const message = isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : undefined;
  const fromMessage = message && Array.isArray(message.annotations) ? message.annotations : [];
  const error = isRecord(value.error) ? value.error : undefined;
  const metadata = error && isRecord(error.metadata) ? error.metadata : undefined;
  const fromError = metadata && Array.isArray(metadata.file_annotations) ? metadata.file_annotations : [];
  const seen = new Set<string>();
  const annotations: OpenRouterFileAnnotation[] = [];
  for (const candidate of [...fromMessage, ...fromError]) {
    if (!isOpenRouterFileAnnotation(candidate) || seen.has(candidate.file.hash)) continue;
    seen.add(candidate.file.hash);
    annotations.push(candidate);
  }
  return annotations;
}

function extractOpenRouterPdfMarkdown(
  value: unknown,
  expectedPageCount: number
): { markdown: string; parsedFileHash?: string } | null {
  if (!isRecord(value)) return null;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const firstChoice = choices[0];
  const message = isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : undefined;
  const assistantContent = message && typeof message.content === 'string' ? stripMarkdownFence(message.content) : '';
  if (assistantContent && hasExactPageHeadings(assistantContent, expectedPageCount)) {
    return {
      markdown: assistantContent,
      parsedFileHash: extractOpenRouterFileAnnotations(value)[0]?.file.hash,
    };
  }

  for (const annotation of extractOpenRouterFileAnnotations(value)) {
    const textParts = annotation.file.content
      .filter((part): part is { type: 'text'; text: string } => {
        return isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0;
      })
      .map((part) => part.text.trim());
    const formFeedPages = textParts.flatMap((text) =>
      text
        .split(/\f+/)
        .map((part) => part.trim())
        .filter(Boolean)
    );
    if (formFeedPages.length === expectedPageCount) {
      return {
        markdown: formFeedPages.map((text, index) => `## Page ${index + 1}\n\n${text}`).join('\n\n'),
        parsedFileHash: annotation.file.hash,
      };
    }
    if (textParts.length === expectedPageCount) {
      return {
        markdown: textParts.map((text, index) => `## Page ${index + 1}\n\n${text}`).join('\n\n'),
        parsedFileHash: annotation.file.hash,
      };
    }
  }
  return null;
}

async function callOpenRouterPdfOcr(args: {
  apiKey: string;
  fileName: string;
  fileBytes: Uint8Array;
  pageCount: number;
  model: string;
  timeoutMs: number;
  fetchFn: FetchLike;
}): Promise<
  | { ok: true; markdown: string; parsedFileHash?: string }
  | { ok: false; status: number; reason: string; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await args.fetchFn(OPENROUTER_CHAT_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': Deno.env.get('OPENROUTER_HTTP_REFERER') ?? 'https://command-eve.com',
        'X-Title': Deno.env.get('OPENROUTER_X_TITLE') ?? 'Command EVE PDF OCR',
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  `Transcribe all ${args.pageCount} physical PDF pages without summarizing or omitting text.`,
                  'Return Markdown only. Start every page with exactly `## Page N`, sequentially from 1.',
                  'Do not add analysis, a preface, a code fence, or content that is not present in the document.',
                ].join(' '),
              },
              {
                type: 'file',
                file: {
                  filename: args.fileName,
                  file_data: `data:application/pdf;base64,${bytesToBase64(args.fileBytes)}`,
                },
              },
            ],
          },
        ],
        plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
        provider: { zdr: true, data_collection: 'deny' },
        temperature: 0,
        stream: false,
        usage: { include: true },
      }),
    });

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_OPENROUTER_RESPONSE_BYTES) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-response-too-large',
        message: 'OpenRouter OCR response was too large.',
      };
    }
    const responseText = await response.text();
    if (new TextEncoder().encode(responseText).byteLength > MAX_OPENROUTER_RESPONSE_BYTES) {
      return {
        ok: false,
        status: 502,
        reason: 'provider-response-too-large',
        message: 'OpenRouter OCR response was too large.',
      };
    }
    let responseJson: unknown = null;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = null;
    }
    const parsed = extractOpenRouterPdfMarkdown(responseJson, args.pageCount);
    if (parsed) return { ok: true, ...parsed };
    return {
      ok: false,
      status: 502,
      reason: response.ok ? 'provider-page-boundaries-unavailable' : 'provider-error',
      message: response.ok
        ? 'OpenRouter OCR did not return trustworthy physical page boundaries.'
        : `OpenRouter OCR returned HTTP ${response.status}.`,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? 'provider-timeout' : 'provider-error',
      message: aborted ? 'OpenRouter PDF OCR timed out.' : 'OpenRouter PDF OCR request failed.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function handleEveMultimodal(req: Request, deps: EveMultimodalHandlerDeps = {}): Promise<Response> {
  const now = new Date().toISOString();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== 'POST') {
    return blocked(req, 'method-not-allowed', 'eve-multimodal only accepts POST requests.', 405, now);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const wire = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if (!wire) {
    return blocked(req, 'missing-license', 'A CEVE license bearer is required.', 401, now);
  }

  let verify: ReturnType<typeof verifyLicenseCode>;
  try {
    verify = verifyLicenseCode({
      code: wire,
      publicKeyPem: publicKeyPem(),
      now,
    });
  } catch (_err) {
    return blocked(req, 'server-not-configured', 'eve-multimodal license verification is not configured.', 503, now);
  }

  if (!verify.ok) {
    if (verify.reason_code === 'LICENSE_EXPIRED') {
      return blocked(req, 'license-expired', 'The CEVE license is expired.', 403, now);
    }
    return blocked(req, 'invalid-license', 'The CEVE license bearer could not be verified.', 401, now);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (_err) {
    return blocked(req, 'invalid-json', 'eve-multimodal requires a valid JSON body.', 400, now);
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
    decision.body.reason === 'provider-not-enabled' &&
    decision.body.provider === 'openrouter' &&
    decision.body.capability === 'document_ocr' &&
    decision.body.document &&
    isPdfOcrProviderEnabled()
  ) {
    const apiKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!apiKey) {
      return blocked(
        req,
        'provider-not-configured',
        'OpenRouter PDF OCR is enabled but OPENROUTER_API_KEY is not configured server-side.',
        503,
        now,
        'openrouter'
      );
    }
    const pdf = extractEveMultimodalPdfInput(body);
    if (!pdf) return jsonResponse(req, responseBody, decision.status);
    const actualSha256 = crypto.createHash('sha256').update(pdf.bytes).digest('hex');
    if (actualSha256 !== pdf.fileSha256) {
      return blocked(
        req,
        'pdf-sha256-mismatch',
        'PDF content did not match its SHA-256 receipt.',
        400,
        now,
        'openrouter'
      );
    }

    const tenantId = verify.payload.tenant_serial;
    if (!isUuid(tenantId)) {
      return blocked(
        req,
        'entitlement-not-drawable',
        'PDF OCR requires an online drawable Command EVE entitlement.',
        403,
        now,
        'openrouter'
      );
    }
    const requestFingerprint = crypto
      .createHash('sha256')
      .update(`${tenantId}\n${responseBody.request_id}\n${actualSha256}\n${pdf.pageCount}`)
      .digest('hex');
    const usage = await (deps.reservePdfOcrUsage ?? reservePdfOcrUsage)({
      tenantId,
      pages: pdf.pageCount,
      tenantCap: pdfOcrTenantPageCap(),
      globalCap: pdfOcrGlobalPageCap(),
      requestFingerprint,
    });
    if (!usage.ok) {
      return blocked(
        req,
        'usage-gate-unavailable',
        'PDF OCR usage accounting is temporarily unavailable.',
        503,
        now,
        'openrouter'
      );
    }
    if (!usage.allowed) {
      const replayed = usage.replayed || usage.reason === 'request-replayed';
      const entitlementBlocked = usage.reason === 'entitlement-not-drawable';
      return blocked(
        req,
        replayed ? 'request-replayed' : entitlementBlocked ? 'entitlement-not-drawable' : 'pdf-ocr-daily-cap',
        replayed
          ? 'This PDF OCR request was already consumed.'
          : entitlementBlocked
            ? 'PDF OCR requires an online drawable Command EVE entitlement.'
            : 'The daily PDF OCR page allowance has been reached.',
        replayed ? 409 : entitlementBlocked ? 403 : 429,
        now,
        'openrouter'
      );
    }

    const model = openRouterPdfModel();
    const ocr = await callOpenRouterPdfOcr({
      apiKey,
      fileName: pdf.fileName,
      fileBytes: pdf.bytes,
      pageCount: pdf.pageCount,
      model,
      timeoutMs: pdfOcrTimeoutMs(),
      fetchFn: deps.fetch ?? fetch,
    });
    if (!ocr.ok) {
      return blocked(req, ocr.reason, ocr.message, ocr.status, now, 'openrouter');
    }

    const successBody: EveMultimodalPdfSuccessResponse = {
      ok: true,
      gateway: 'eve-multimodal',
      provider: 'openrouter',
      capability: 'document_ocr',
      reason: 'provider-complete',
      message: 'OpenRouter PDF OCR completed with page boundaries.',
      checked_at: responseBody.checked_at,
      request_id: responseBody.request_id,
      license: responseBody.license,
      artifact: {
        status: 'created',
        kind: 'document',
        mime_type: 'text/markdown',
        encoding: 'utf8',
        text: ocr.markdown,
        bytes: new TextEncoder().encode(ocr.markdown).byteLength,
      },
      residency: {
        requestedPrivacyLane: 'cloud_auto',
        effectiveResidency: 'global_cloud',
        confirmation: 'zdr-enforced-global',
      },
      document: {
        engine: 'mistral-ocr',
        model,
        page_count: pdf.pageCount,
        ...(ocr.parsedFileHash && /^[A-Za-z0-9._-]{1,256}$/.test(ocr.parsedFileHash)
          ? { parsed_file_hash: ocr.parsedFileHash }
          : {}),
        zdr_enforced: true,
        data_collection: 'deny',
      },
      usage: {
        metering: 'daily-page-cap',
        pages_reserved: pdf.pageCount,
        tenant_pages_used_today: usage.tenantUnits,
        tenant_page_cap: usage.tenantCap,
        global_pages_used_today: usage.globalUnits,
        global_page_cap: usage.globalCap,
      },
    };
    return jsonResponse(req, successBody, 200);
  }

  if (
    decision.body.reason === 'provider-not-enabled' &&
    decision.body.capability === 'tts' &&
    decision.body.tts &&
    isTtsProviderEnabled()
  ) {
    const apiKey = Deno.env.get('XAI_API_KEY');
    if (!apiKey) {
      return blocked(
        req,
        'provider-not-configured',
        'xAI TTS is enabled but XAI_API_KEY is not configured server-side.',
        503,
        now
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
      reason: 'provider-complete',
      message: 'xAI TTS audio generated.',
      artifact: {
        status: 'created',
        kind: 'audio',
        mime_type: tts.mimeType,
        encoding: 'base64',
        data_base64: bytesToBase64(tts.bytes),
        bytes: tts.bytes.byteLength,
      },
    };
    return jsonResponse(req, successBody, 200);
  }

  return jsonResponse(req, responseBody, decision.status);
}

if (typeof Deno !== 'undefined' && (import.meta as { main?: boolean }).main) {
  Deno.serve((req) => handleEveMultimodal(req));
}
