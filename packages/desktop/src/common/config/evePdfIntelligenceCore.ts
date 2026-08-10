/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandEvePrivacyLane } from './eveMultimodalGatewayCore';

export const COMMAND_EVE_PDF_INTELLIGENCE_VERSION = 'command-eve-pdf-intelligence/v0' as const;
export const COMMAND_EVE_PDF_MAX_LOCAL_BYTES = 25 * 1024 * 1024;
export const COMMAND_EVE_PDF_MAX_CLOUD_OCR_BYTES = 12 * 1024 * 1024;
export const COMMAND_EVE_PDF_MAX_CLOUD_RESPONSE_BYTES = 12 * 1024 * 1024;

export type CommandEvePdfExtractionMode = 'local_text' | 'cloud_ocr';

export type CommandEvePdfPrepareRequest = {
  filePaths?: string[];
  allowCloudOcr?: boolean;
  privacyLane?: CommandEvePrivacyLane;
  requestId?: string;
};

export type CommandEvePreparedPdfDocument = {
  source_path: string;
  source_name: string;
  sha256: string;
  bytes: number;
  page_count: number;
  extracted_characters: number;
  extraction_mode: CommandEvePdfExtractionMode;
  sidecar_path: string;
  citation_format: '[PDF p. N]';
  cache_hit: boolean;
};

export type CommandEvePdfPrepareSuccess = {
  version: typeof COMMAND_EVE_PDF_INTELLIGENCE_VERSION;
  ok: true;
  documents: CommandEvePreparedPdfDocument[];
  prepared_files: string[];
  cloud_ocr_used: boolean;
  requires_cloud_ocr_consent: false;
};

export type CommandEvePdfPrepareFailure = {
  version: typeof COMMAND_EVE_PDF_INTELLIGENCE_VERSION;
  ok: false;
  reason_code: string;
  message?: string;
  documents: CommandEvePreparedPdfDocument[];
  prepared_files: string[];
  requires_cloud_ocr_consent: boolean;
  pending_source_names?: string[];
};

export type CommandEvePdfPrepareResult = CommandEvePdfPrepareSuccess | CommandEvePdfPrepareFailure;

export type ValidateCommandEvePdfPrepareReceiptResult =
  | { ok: true; documents: CommandEvePreparedPdfDocument[] }
  | { ok: false; reason_code: 'EVE_PDF_PREPARE_RECEIPT_INVALID' };

export type CommandEvePdfOcrEdgeRequest = {
  provider: 'openrouter';
  capability: 'document_ocr';
  privacyLane: CommandEvePrivacyLane;
  directProviderKeyPresentInDesktop: false;
  file_name: string;
  file_sha256: string;
  page_count: number;
  file_data_base64: string;
  requestId?: string;
};

export type CommandEvePdfOcrEdgeReceipt = {
  engine: 'mistral-ocr';
  model: string;
  page_count: number;
  parsed_file_hash?: string;
  zdr_enforced: true;
  data_collection: 'deny';
};

export type CommandEvePdfOcrEdgeSuccess = {
  ok: true;
  gateway: 'eve-multimodal';
  provider: 'openrouter';
  capability: 'document_ocr';
  reason: 'provider-complete';
  artifact: {
    status: 'created';
    kind: 'document';
    mime_type: 'text/markdown';
    encoding: 'utf8';
    text: string;
    bytes: number;
  };
  residency: {
    requestedPrivacyLane: CommandEvePrivacyLane;
    effectiveResidency: 'global_cloud';
    confirmation: 'zdr-enforced-global';
  };
  document: CommandEvePdfOcrEdgeReceipt;
};

export type BuildCommandEvePdfOcrRequestResult =
  | { ok: true; body: CommandEvePdfOcrEdgeRequest; privacyLane: CommandEvePrivacyLane }
  | { ok: false; reason_code: string; message: string };

export type ParseCommandEvePdfOcrResponseResult =
  | { ok: true; data: CommandEvePdfOcrEdgeSuccess }
  | { ok: false; reason_code: string; message?: string };

const PRIVACY_LANES: readonly CommandEvePrivacyLane[] = [
  'local_only',
  'cloud_auto',
  'cloud_us',
  'cloud_eu',
  'cloud_de',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPrivacyLane(value: unknown): value is CommandEvePrivacyLane {
  return typeof value === 'string' && PRIVACY_LANES.includes(value as CommandEvePrivacyLane);
}

function stripAsciiControlCharacters(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f) cleaned += character;
  }
  return cleaned;
}

function cleanFileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const base = value.trim().replace(/\\/g, '/').split('/').pop() || '';
  if (!base.toLowerCase().endsWith('.pdf')) return '';
  return stripAsciiControlCharacters(base).slice(0, 180);
}

function cleanRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().slice(0, 128);
  return /^[A-Za-z0-9._-]+$/.test(cleaned) ? cleaned : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isAbsoluteFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/]/.test(value);
}

function isLikelyBase64(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function safeMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-or-v1|sk|xai)-[A-Za-z0-9._-]{6,}\b/gi, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function isCommandEvePdfPath(value: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().endsWith('.pdf');
}

export function mergeCommandEvePreparedPdfFiles(
  originalFiles: readonly string[],
  documents: readonly CommandEvePreparedPdfDocument[]
): string[] {
  const sidecarBySource = new Map(documents.map((document) => [document.source_path, document.sidecar_path]));
  const merged: string[] = [];
  for (const file of originalFiles) {
    merged.push(file);
    const sidecar = sidecarBySource.get(file);
    if (sidecar) merged.push(sidecar);
  }
  return Array.from(new Set(merged));
}

/**
 * Fail closed when MAIN claims that PDFs were prepared but the receipt cannot
 * prove every source and its content-addressed sidecar handoff. Identical PDF
 * bytes may legitimately share one sidecar. This guard intentionally performs
 * no filesystem reads in the renderer; AionCore validates the files themselves
 * before forwarding them to Hermes.
 */
export function validateCommandEvePdfPrepareReceipt(
  pdfFiles: readonly string[],
  raw: unknown
): ValidateCommandEvePdfPrepareReceiptResult {
  const failure = (): ValidateCommandEvePdfPrepareReceiptResult => ({
    ok: false,
    reason_code: 'EVE_PDF_PREPARE_RECEIPT_INVALID',
  });
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.documents)) return failure();

  const expectedSources = new Set(pdfFiles);
  if (expectedSources.size !== pdfFiles.length || pdfFiles.length === 0 || raw.documents.length !== pdfFiles.length) {
    return failure();
  }

  const seenSources = new Set<string>();
  const sidecarDocuments = new Map<string, Record<string, unknown>>();
  const documents: CommandEvePreparedPdfDocument[] = [];
  for (const candidate of raw.documents) {
    if (!isRecord(candidate)) return failure();
    const sourcePath = candidate.source_path;
    const sidecarPath = candidate.sidecar_path;
    if (
      typeof sourcePath !== 'string' ||
      !expectedSources.has(sourcePath) ||
      seenSources.has(sourcePath) ||
      !isAbsoluteFilePath(sidecarPath)
    ) {
      return failure();
    }
    const existingSidecar = sidecarDocuments.get(sidecarPath);
    if (
      existingSidecar &&
      (existingSidecar.sha256 !== candidate.sha256 ||
        existingSidecar.bytes !== candidate.bytes ||
        existingSidecar.page_count !== candidate.page_count ||
        existingSidecar.extracted_characters !== candidate.extracted_characters ||
        existingSidecar.extraction_mode !== candidate.extraction_mode ||
        existingSidecar.citation_format !== candidate.citation_format)
    ) {
      return failure();
    }
    seenSources.add(sourcePath);
    sidecarDocuments.set(sidecarPath, candidate);
    documents.push(candidate as CommandEvePreparedPdfDocument);
  }

  if (seenSources.size !== expectedSources.size) return failure();

  return { ok: true, documents };
}

export function buildCommandEvePdfOcrRequest(input: {
  fileName: unknown;
  fileSha256: unknown;
  pageCount: unknown;
  fileDataBase64: unknown;
  privacyLane?: unknown;
  requestId?: unknown;
}): BuildCommandEvePdfOcrRequestResult {
  const privacyLane = input.privacyLane === undefined ? 'cloud_auto' : input.privacyLane;
  if (!isPrivacyLane(privacyLane)) {
    return { ok: false, reason_code: 'EVE_PDF_INVALID_PRIVACY_LANE', message: 'Unknown PDF privacy lane.' };
  }
  if (privacyLane === 'local_only') {
    return {
      ok: false,
      reason_code: 'EVE_PDF_LOCAL_ONLY_PRIVACY',
      message: 'Cloud OCR is blocked while local-only privacy mode is active.',
    };
  }
  if (privacyLane !== 'cloud_auto') {
    return {
      ok: false,
      reason_code: 'EVE_PDF_RESIDENCY_UNAVAILABLE',
      message: 'OpenRouter PDF OCR is currently available only through the explicit global cloud lane.',
    };
  }

  const fileName = cleanFileName(input.fileName);
  if (!fileName) {
    return { ok: false, reason_code: 'EVE_PDF_BAD_FILE_NAME', message: 'PDF OCR requires a safe .pdf filename.' };
  }
  if (!isSha256(input.fileSha256)) {
    return { ok: false, reason_code: 'EVE_PDF_BAD_SHA256', message: 'PDF OCR requires a SHA-256 digest.' };
  }
  if (!Number.isInteger(input.pageCount) || Number(input.pageCount) < 1 || Number(input.pageCount) > 500) {
    return { ok: false, reason_code: 'EVE_PDF_BAD_PAGE_COUNT', message: 'PDF OCR requires 1 to 500 pages.' };
  }
  if (!isLikelyBase64(input.fileDataBase64)) {
    return { ok: false, reason_code: 'EVE_PDF_BAD_BASE64', message: 'PDF OCR requires valid base64 PDF data.' };
  }
  if (decodedBase64ByteLength(input.fileDataBase64) > COMMAND_EVE_PDF_MAX_CLOUD_OCR_BYTES) {
    return {
      ok: false,
      reason_code: 'EVE_PDF_CLOUD_OCR_TOO_LARGE',
      message: 'PDF exceeds the cloud OCR upload limit.',
    };
  }

  const requestId = cleanRequestId(input.requestId);
  return {
    ok: true,
    privacyLane,
    body: {
      provider: 'openrouter',
      capability: 'document_ocr',
      privacyLane,
      directProviderKeyPresentInDesktop: false,
      file_name: fileName,
      file_sha256: input.fileSha256,
      page_count: Number(input.pageCount),
      file_data_base64: input.fileDataBase64,
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function parseCommandEvePdfOcrResponse(raw: unknown): ParseCommandEvePdfOcrResponseResult {
  if (!isRecord(raw)) {
    return { ok: false, reason_code: 'EVE_PDF_OCR_BAD_BODY', message: 'Cloud OCR returned a non-object response.' };
  }
  if (raw.ok !== true) {
    const reason =
      typeof raw.reason === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(raw.reason) ? raw.reason : 'EVE_PDF_OCR_FAILED';
    return { ok: false, reason_code: reason, message: safeMessage(raw.message) };
  }
  if (
    raw.gateway !== 'eve-multimodal' ||
    raw.provider !== 'openrouter' ||
    raw.capability !== 'document_ocr' ||
    raw.reason !== 'provider-complete' ||
    !isRecord(raw.artifact) ||
    raw.artifact.status !== 'created' ||
    raw.artifact.kind !== 'document' ||
    raw.artifact.mime_type !== 'text/markdown' ||
    raw.artifact.encoding !== 'utf8' ||
    typeof raw.artifact.text !== 'string' ||
    raw.artifact.text.trim().length === 0 ||
    new TextEncoder().encode(raw.artifact.text).byteLength > COMMAND_EVE_PDF_MAX_CLOUD_RESPONSE_BYTES ||
    !isRecord(raw.residency) ||
    raw.residency.requestedPrivacyLane !== 'cloud_auto' ||
    raw.residency.effectiveResidency !== 'global_cloud' ||
    raw.residency.confirmation !== 'zdr-enforced-global' ||
    !isRecord(raw.document) ||
    raw.document.engine !== 'mistral-ocr' ||
    typeof raw.document.model !== 'string' ||
    !Number.isInteger(raw.document.page_count) ||
    Number(raw.document.page_count) < 1 ||
    raw.document.zdr_enforced !== true ||
    raw.document.data_collection !== 'deny'
  ) {
    return { ok: false, reason_code: 'EVE_PDF_OCR_BAD_BODY', message: 'Cloud OCR returned an invalid receipt.' };
  }

  return { ok: true, data: raw as CommandEvePdfOcrEdgeSuccess };
}
