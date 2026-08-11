/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandEvePrivacyLane } from './eveMultimodalGatewayCore';
import type { CommandEveCloudVisualPolicyReceipt } from './visual/cloudVisualPolicyCore';

export const COMMAND_EVE_IMAGE_INTELLIGENCE_VERSION = 'command-eve-image-intelligence/v1' as const;
export const COMMAND_EVE_IMAGE_MAX_LOCAL_BYTES = 20 * 1024 * 1024;
export const COMMAND_EVE_IMAGE_MAX_CLOUD_BYTES = 4 * 1024 * 1024;
export const COMMAND_EVE_IMAGE_MAX_CLOUD_RESPONSE_BYTES = 4 * 1024 * 1024;
export const COMMAND_EVE_IMAGE_MAX_PIXELS = 40_000_000;
export const COMMAND_EVE_IMAGE_MAX_EDGE_PIXELS = 2_048;

export type CommandEveImageLocale = 'de-DE' | 'en-US';

export type CommandEveImagePrepareRequest = {
  filePaths?: string[];
  /** @deprecated Wire-compatible only. Main never treats this as authority. */
  allowCloudVision?: boolean;
  flowId?: string;
  visualPolicyReceipt?: CommandEveCloudVisualPolicyReceipt;
  privacyLane?: CommandEvePrivacyLane;
  locale?: CommandEveImageLocale;
  requestId?: string;
};

export type CommandEvePreparedImageDocument = {
  source_path: string;
  source_name: string;
  sha256: string;
  bytes: number;
  extraction_mode: 'cloud_vision';
  sidecar_path: string;
  sidecar_sha256: string;
  sidecar_bytes: number;
  /** Bounded, verified sidecar content for the conversational prompt. */
  prompt_context: string;
  citation_format: '[Image 1]';
  model: string;
  cache_hit: boolean;
};

export type CommandEveImagePrepareSuccess = {
  version: typeof COMMAND_EVE_IMAGE_INTELLIGENCE_VERSION;
  ok: true;
  documents: CommandEvePreparedImageDocument[];
  prepared_files: string[];
  cloud_vision_used: boolean;
  requires_cloud_vision_consent: false;
};

export type CommandEveImagePrepareFailure = {
  version: typeof COMMAND_EVE_IMAGE_INTELLIGENCE_VERSION;
  ok: false;
  reason_code: string;
  message?: string;
  documents: CommandEvePreparedImageDocument[];
  prepared_files: string[];
  requires_cloud_vision_consent: boolean;
  pending_source_names?: string[];
};

export type CommandEveImagePrepareResult = CommandEveImagePrepareSuccess | CommandEveImagePrepareFailure;

export type CommandEveImageVisionEdgeRequest = {
  provider: 'openrouter';
  capability: 'vision';
  privacyLane: 'cloud_auto';
  directProviderKeyPresentInDesktop: false;
  source_kind: 'image';
  file_name: string;
  file_sha256: string;
  slide_count: 1;
  context_text: '';
  locale: CommandEveImageLocale;
  images: [
    {
      slide_number: 1;
      mime_type: 'image/jpeg';
      sha256: string;
      data_base64: string;
    },
  ];
  requestId?: string;
};

export type CommandEveImageVisionEdgeSuccess = {
  ok: true;
  gateway: 'eve-multimodal';
  provider: 'openrouter';
  capability: 'vision';
  reason: 'provider-complete';
  artifact: {
    status: 'created';
    kind: 'text';
    mime_type: 'text/markdown';
    encoding: 'utf8';
    text: string;
    bytes: number;
  };
  residency: {
    requestedPrivacyLane: 'cloud_auto';
    effectiveResidency: 'global_cloud';
    confirmation: 'zdr-enforced-global';
  };
  vision: {
    source_kind: 'image';
    model: string;
    file_sha256: string;
    slide_count: 1;
    slide_numbers: [1];
    image_count: 1;
    zdr_enforced: true;
    data_collection: 'deny';
  };
};

export type BuildCommandEveImageVisionRequestResult =
  | { ok: true; body: CommandEveImageVisionEdgeRequest }
  | { ok: false; reason_code: string; message: string };

export type ParseCommandEveImageVisionResponseResult =
  | { ok: true; data: CommandEveImageVisionEdgeSuccess }
  | { ok: false; reason_code: string; message?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function cleanImageFileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const base = value.trim().replace(/\\/g, '/').split('/').pop() || '';
  if (!/\.(?:jpe?g|png|webp)$/i.test(base)) return '';
  return base
    .replace(/\p{Cc}/gu, '')
    .slice(0, 180)
    .trim();
}

function cleanRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim().slice(0, 128);
  return /^[A-Za-z0-9._-]+$/.test(cleaned) ? cleaned : undefined;
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

function normalizeMarkdown(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

export function isCommandEveImagePath(value: string): boolean {
  return typeof value === 'string' && /\.(?:jpe?g|png|webp)$/i.test(value.trim());
}

export function mergeCommandEvePreparedImageFiles(
  originalFiles: readonly string[],
  documents: readonly CommandEvePreparedImageDocument[]
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

export function buildCommandEveImageVisionRequest(input: {
  fileName: unknown;
  fileSha256: unknown;
  imageSha256: unknown;
  imageDataBase64: unknown;
  locale: unknown;
  privacyLane?: unknown;
  requestId?: unknown;
}): BuildCommandEveImageVisionRequestResult {
  const privacyLane = input.privacyLane === undefined ? 'cloud_auto' : input.privacyLane;
  if (privacyLane === 'local_only') {
    return {
      ok: false,
      reason_code: 'EVE_IMAGE_LOCAL_ONLY_PRIVACY',
      message: 'Cloud image analysis is blocked while local-only privacy mode is active.',
    };
  }
  if (privacyLane !== 'cloud_auto') {
    return {
      ok: false,
      reason_code: 'EVE_IMAGE_RESIDENCY_UNAVAILABLE',
      message: 'Image analysis is currently available only through the explicit global ZDR cloud lane.',
    };
  }
  const fileName = cleanImageFileName(input.fileName);
  if (!fileName) {
    return {
      ok: false,
      reason_code: 'EVE_IMAGE_BAD_FILE_NAME',
      message: 'Image analysis requires a safe JPEG, PNG or WebP filename.',
    };
  }
  if (!isSha256(input.fileSha256) || !isSha256(input.imageSha256)) {
    return {
      ok: false,
      reason_code: 'EVE_IMAGE_BAD_SHA256',
      message: 'Image analysis requires source and preview SHA-256 receipts.',
    };
  }
  if (!isLikelyBase64(input.imageDataBase64)) {
    return {
      ok: false,
      reason_code: 'EVE_IMAGE_BAD_BASE64',
      message: 'Image analysis requires a valid bounded JPEG preview.',
    };
  }
  const imageBytes = decodedBase64ByteLength(input.imageDataBase64);
  if (imageBytes < 4 || imageBytes > COMMAND_EVE_IMAGE_MAX_CLOUD_BYTES) {
    return {
      ok: false,
      reason_code: 'EVE_IMAGE_BAD_SIZE',
      message: 'Image preview is empty or exceeds the managed vision size limit.',
    };
  }
  const locale =
    input.locale === 'en-US' ? 'en-US' : input.locale === undefined || input.locale === 'de-DE' ? 'de-DE' : null;
  if (!locale) {
    return { ok: false, reason_code: 'EVE_IMAGE_BAD_LOCALE', message: 'Image analysis locale is invalid.' };
  }
  const requestId = cleanRequestId(input.requestId);
  if (input.requestId !== undefined && !requestId) {
    return { ok: false, reason_code: 'EVE_IMAGE_BAD_REQUEST_ID', message: 'Image request id is invalid.' };
  }
  return {
    ok: true,
    body: {
      provider: 'openrouter',
      capability: 'vision',
      privacyLane: 'cloud_auto',
      directProviderKeyPresentInDesktop: false,
      source_kind: 'image',
      file_name: fileName,
      file_sha256: input.fileSha256,
      slide_count: 1,
      context_text: '',
      locale,
      images: [
        {
          slide_number: 1,
          mime_type: 'image/jpeg',
          sha256: input.imageSha256,
          data_base64: input.imageDataBase64,
        },
      ],
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function parseCommandEveImageVisionResponse(raw: unknown): ParseCommandEveImageVisionResponseResult {
  if (!isRecord(raw)) return { ok: false, reason_code: 'EVE_IMAGE_RESPONSE_INVALID' };
  if (raw.ok !== true) {
    return {
      ok: false,
      reason_code: typeof raw.reason === 'string' ? raw.reason.slice(0, 96) : 'EVE_IMAGE_PROVIDER_FAILED',
      message: safeMessage(raw.message),
    };
  }
  const artifact = isRecord(raw.artifact) ? raw.artifact : null;
  const residency = isRecord(raw.residency) ? raw.residency : null;
  const vision = isRecord(raw.vision) ? raw.vision : null;
  const markdown = normalizeMarkdown(artifact?.text);
  const encodedBytes = new TextEncoder().encode(markdown).byteLength;
  const headings = Array.from(markdown.matchAll(/^##\s+Image\s+(\d+)\s*$/gim)).map((match) => Number(match[1]));
  if (
    raw.gateway !== 'eve-multimodal' ||
    raw.provider !== 'openrouter' ||
    raw.capability !== 'vision' ||
    raw.reason !== 'provider-complete' ||
    artifact?.status !== 'created' ||
    artifact.kind !== 'text' ||
    artifact.mime_type !== 'text/markdown' ||
    artifact.encoding !== 'utf8' ||
    markdown.length === 0 ||
    encodedBytes > COMMAND_EVE_IMAGE_MAX_CLOUD_RESPONSE_BYTES ||
    artifact.bytes !== encodedBytes ||
    residency?.requestedPrivacyLane !== 'cloud_auto' ||
    residency.effectiveResidency !== 'global_cloud' ||
    residency.confirmation !== 'zdr-enforced-global' ||
    vision?.source_kind !== 'image' ||
    typeof vision.model !== 'string' ||
    vision.model.trim().length === 0 ||
    !isSha256(vision.file_sha256) ||
    vision.slide_count !== 1 ||
    !Array.isArray(vision.slide_numbers) ||
    vision.slide_numbers.length !== 1 ||
    vision.slide_numbers[0] !== 1 ||
    vision.image_count !== 1 ||
    vision.zdr_enforced !== true ||
    vision.data_collection !== 'deny' ||
    headings.length !== 1 ||
    headings[0] !== 1
  ) {
    return { ok: false, reason_code: 'EVE_IMAGE_RESPONSE_INVALID' };
  }
  return { ok: true, data: raw as unknown as CommandEveImageVisionEdgeSuccess };
}
