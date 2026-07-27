import crypto from 'node:crypto';
import {
  decideEveMultimodalSkeletonRequest,
  type EveMultimodalSkeletonResponse,
  extractEveMultimodalPdfInput,
  extractEveMultimodalTtsText,
} from '../multimodal-core.ts';
import {
  callOpenRouterPdfOcr,
  isPdfOcrProviderEnabled,
  isUuid,
  openRouterPdfModel,
  pdfOcrGlobalPageCap,
  pdfOcrTenantPageCap,
  pdfOcrTimeoutMs,
  reservePdfOcrUsage,
} from '../providers/pdf-ocr.ts';
import { bytesToBase64, callXaiTts, isTtsProviderEnabled, ttsTimeoutMs } from '../providers/tts.ts';
import type { FetchLike, ReservePdfOcrUsage } from '../providers/types.ts';
import { blocked, corsHeaders, jsonResponse } from './http.ts';
import { requestIdFromBody, verifyEveMultimodalLicense } from './license.ts';

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

  let verify: ReturnType<typeof verifyEveMultimodalLicense>;
  try {
    verify = verifyEveMultimodalLicense(wire, now);
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
