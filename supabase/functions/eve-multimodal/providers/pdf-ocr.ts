import { bytesToBase64 } from './encoding.ts';
import type { FetchLike, PdfOcrUsageReservation, ReservePdfOcrUsage } from './types.ts';

const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_PDF_MODEL = 'google/gemini-2.5-flash';
const MAX_OPENROUTER_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_PDF_OCR_TENANT_PAGE_CAP = 500;
const DEFAULT_PDF_OCR_GLOBAL_PAGE_CAP = 10_000;

type OpenRouterFileAnnotation = {
  type: 'file';
  file: {
    hash: string;
    content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  };
};

export function isPdfOcrProviderEnabled(): boolean {
  return Deno.env.get('EVE_MULTIMODAL_ENABLE_OPENROUTER_PDF_OCR') === 'true';
}

export function openRouterPdfModel(): string {
  const configured = Deno.env.get('EVE_MULTIMODAL_OPENROUTER_PDF_MODEL')?.trim();
  return configured && /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(configured) ? configured : DEFAULT_OPENROUTER_PDF_MODEL;
}

export function pdfOcrTimeoutMs(): number {
  const raw = Deno.env.get('EVE_MULTIMODAL_PDF_OCR_TIMEOUT_MS');
  const parsed = raw ? Number(raw) : 80_000;
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 120_000 ? parsed : 80_000;
}

function boundedPositiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const raw = Deno.env.get(name);
  const parsed = raw ? Number(raw) : fallback;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export function pdfOcrTenantPageCap(): number {
  return boundedPositiveIntegerEnv(
    'EVE_MULTIMODAL_PDF_OCR_TENANT_PAGE_CAP',
    DEFAULT_PDF_OCR_TENANT_PAGE_CAP,
    1_000_000
  );
}

export function pdfOcrGlobalPageCap(): number {
  return boundedPositiveIntegerEnv(
    'EVE_MULTIMODAL_PDF_OCR_GLOBAL_PAGE_CAP',
    DEFAULT_PDF_OCR_GLOBAL_PAGE_CAP,
    10_000_000
  );
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function reservePdfOcrUsage(input: Parameters<ReservePdfOcrUsage>[0]): Promise<PdfOcrUsageReservation> {
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

export async function callOpenRouterPdfOcr(args: {
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
