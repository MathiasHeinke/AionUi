/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  COMMAND_EVE_PRESENTATION_MAX_BATCH_BYTES,
  COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES,
  COMMAND_EVE_PRESENTATION_MAX_CLOUD_RESPONSE_BYTES,
  COMMAND_EVE_PRESENTATION_MAX_CONTEXT_CHARS,
  COMMAND_EVE_PRESENTATION_MAX_IMAGE_BYTES,
  COMMAND_EVE_PRESENTATION_MAX_SLIDES,
  type BuildCommandEvePresentationVisionRequestResult,
  type CommandEvePresentationLocale,
  type CommandEvePresentationSlideContext,
  type CommandEvePresentationVisionEdgeRequest,
  type CommandEvePresentationVisionEdgeSuccess,
  type CommandEvePresentationVisionImageInput,
  type ParseCommandEvePresentationVisionResponseResult,
} from './evePresentationTypesCore';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function cleanPptxFileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const base = value.trim().replace(/\\/g, '/').split('/').pop() || '';
  if (!base.toLowerCase().endsWith('.pptx')) return '';
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

export function buildCommandEvePresentationVisionRequest(input: {
  fileName: unknown;
  fileSha256: unknown;
  slideCount: unknown;
  contextText: unknown;
  locale: unknown;
  images: readonly CommandEvePresentationVisionImageInput[];
  privacyLane?: unknown;
  requestId?: unknown;
}): BuildCommandEvePresentationVisionRequestResult {
  const privacyLane = input.privacyLane === undefined ? 'cloud_auto' : input.privacyLane;
  if (privacyLane === 'local_only') {
    return {
      ok: false,
      reason_code: 'EVE_PRESENTATION_LOCAL_ONLY_PRIVACY',
      message: 'Cloud presentation analysis is blocked while local-only privacy mode is active.',
    };
  }
  if (privacyLane !== 'cloud_auto') {
    return {
      ok: false,
      reason_code: 'EVE_PRESENTATION_RESIDENCY_UNAVAILABLE',
      message: 'Presentation analysis is currently available only through the explicit global ZDR cloud lane.',
    };
  }

  const fileName = cleanPptxFileName(input.fileName);
  if (!fileName) {
    return {
      ok: false,
      reason_code: 'EVE_PRESENTATION_BAD_FILE_NAME',
      message: 'Presentation analysis requires a safe .pptx filename.',
    };
  }
  if (!isSha256(input.fileSha256)) {
    return {
      ok: false,
      reason_code: 'EVE_PRESENTATION_BAD_SHA256',
      message: 'Presentation analysis requires a SHA-256 digest.',
    };
  }
  if (
    !Number.isInteger(input.slideCount) ||
    Number(input.slideCount) < 1 ||
    Number(input.slideCount) > COMMAND_EVE_PRESENTATION_MAX_SLIDES
  ) {
    return {
      ok: false,
      reason_code: 'EVE_PRESENTATION_BAD_SLIDE_COUNT',
      message: `Presentation analysis requires 1 to ${COMMAND_EVE_PRESENTATION_MAX_SLIDES} slides.`,
    };
  }
  const contextText = typeof input.contextText === 'string' ? input.contextText.trim() : '';
  if (contextText.length > COMMAND_EVE_PRESENTATION_MAX_CONTEXT_CHARS) {
    return {
      ok: false,
      reason_code: 'EVE_PRESENTATION_CONTEXT_TOO_LARGE',
      message: 'Locally extracted presentation text exceeded the batch context limit.',
    };
  }
  const locale: CommandEvePresentationLocale = input.locale === 'en-US' ? 'en-US' : 'de-DE';
  if (
    !Array.isArray(input.images) ||
    input.images.length < 1 ||
    input.images.length > COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES
  ) {
    return {
      ok: false,
      reason_code: 'EVE_PRESENTATION_BAD_IMAGE_COUNT',
      message: `Presentation analysis requires 1 to ${COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES} rendered slides per batch.`,
    };
  }

  const seenSlides = new Set<number>();
  let totalBytes = 0;
  const images: CommandEvePresentationVisionEdgeRequest['images'] = [];
  for (const image of input.images) {
    const slideNumber = Number(image.slideNumber);
    if (
      !Number.isInteger(image.slideNumber) ||
      slideNumber < 1 ||
      slideNumber > Number(input.slideCount) ||
      seenSlides.has(slideNumber) ||
      image.mimeType !== 'image/jpeg' ||
      !isSha256(image.sha256) ||
      !isLikelyBase64(image.dataBase64)
    ) {
      return {
        ok: false,
        reason_code: 'EVE_PRESENTATION_BAD_IMAGE',
        message: 'Presentation analysis received an invalid or duplicate rendered slide.',
      };
    }
    const bytes = decodedBase64ByteLength(image.dataBase64);
    totalBytes += bytes;
    if (
      bytes < 4 ||
      bytes > COMMAND_EVE_PRESENTATION_MAX_IMAGE_BYTES ||
      totalBytes > COMMAND_EVE_PRESENTATION_MAX_BATCH_BYTES
    ) {
      return {
        ok: false,
        reason_code: 'EVE_PRESENTATION_IMAGE_TOO_LARGE',
        message: 'Rendered presentation slides exceeded the cloud batch size limit.',
      };
    }
    seenSlides.add(slideNumber);
    images.push({
      slide_number: slideNumber,
      mime_type: 'image/jpeg',
      sha256: image.sha256,
      data_base64: image.dataBase64,
    });
  }
  images.sort((left, right) => left.slide_number - right.slide_number);

  const requestId = cleanRequestId(input.requestId);
  return {
    ok: true,
    body: {
      provider: 'openrouter',
      capability: 'vision',
      privacyLane: 'cloud_auto',
      directProviderKeyPresentInDesktop: false,
      source_kind: 'presentation',
      file_name: fileName,
      file_sha256: input.fileSha256,
      slide_count: Number(input.slideCount),
      context_text: contextText,
      locale,
      images,
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function parsePresentationVisionMarkdownSections(
  markdown: string,
  expectedSlideNumbers: readonly number[]
): CommandEvePresentationSlideContext[] | null {
  const normalized = normalizeMarkdown(markdown);
  const headings = Array.from(normalized.matchAll(/^##\s+Slide\s+(\d+)\s*$/gim));
  const allHeadings = Array.from(normalized.matchAll(/^(#{1,6})\s+.+$/gm));
  const headingNumbers = headings.map((heading) => Number(heading[1]));
  if (
    allHeadings.length !== headings.length ||
    headings.length !== expectedSlideNumbers.length ||
    headingNumbers.some((slideNumber, index) => slideNumber !== expectedSlideNumbers[index])
  ) {
    return null;
  }
  return headings.map((heading, index) => {
    const bodyStart = (heading.index ?? 0) + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? normalized.length;
    return {
      slideNumber: Number(heading[1]),
      localText: '',
      visualAnalysis: normalized.slice(bodyStart, bodyEnd).trim() || '[No reliable visual analysis returned.]',
    };
  });
}

export function parseCommandEvePresentationVisionResponse(
  raw: unknown
): ParseCommandEvePresentationVisionResponseResult {
  if (!isRecord(raw)) return { ok: false, reason_code: 'EVE_PRESENTATION_VISION_BAD_BODY' };
  if (raw.ok !== true) {
    return {
      ok: false,
      reason_code:
        typeof raw.reason === 'string'
          ? `EVE_PRESENTATION_${raw.reason.toUpperCase().replace(/-/g, '_')}`
          : 'EVE_PRESENTATION_VISION_FAILED',
      message: safeMessage(raw.message),
    };
  }
  if (
    raw.gateway !== 'eve-multimodal' ||
    raw.provider !== 'openrouter' ||
    raw.capability !== 'vision' ||
    raw.reason !== 'provider-complete' ||
    !isRecord(raw.artifact) ||
    raw.artifact.status !== 'created' ||
    raw.artifact.kind !== 'text' ||
    raw.artifact.mime_type !== 'text/markdown' ||
    raw.artifact.encoding !== 'utf8' ||
    typeof raw.artifact.text !== 'string' ||
    !Number.isInteger(raw.artifact.bytes) ||
    !isRecord(raw.residency) ||
    raw.residency.requestedPrivacyLane !== 'cloud_auto' ||
    raw.residency.effectiveResidency !== 'global_cloud' ||
    raw.residency.confirmation !== 'zdr-enforced-global' ||
    !isRecord(raw.vision) ||
    raw.vision.source_kind !== 'presentation' ||
    typeof raw.vision.model !== 'string' ||
    !isSha256(raw.vision.file_sha256) ||
    !Number.isInteger(raw.vision.slide_count) ||
    !Array.isArray(raw.vision.slide_numbers) ||
    raw.vision.slide_numbers.some((slideNumber) => !Number.isInteger(slideNumber) || Number(slideNumber) < 1) ||
    raw.vision.image_count !== raw.vision.slide_numbers.length ||
    raw.vision.zdr_enforced !== true ||
    raw.vision.data_collection !== 'deny'
  ) {
    return { ok: false, reason_code: 'EVE_PRESENTATION_VISION_BAD_BODY' };
  }
  const textBytes = new TextEncoder().encode(raw.artifact.text).byteLength;
  if (textBytes !== raw.artifact.bytes || textBytes > COMMAND_EVE_PRESENTATION_MAX_CLOUD_RESPONSE_BYTES) {
    return { ok: false, reason_code: 'EVE_PRESENTATION_VISION_BAD_SIZE' };
  }
  const slideNumbers = raw.vision.slide_numbers.map(Number);
  if (!parsePresentationVisionMarkdownSections(raw.artifact.text, slideNumbers)) {
    return { ok: false, reason_code: 'EVE_PRESENTATION_VISION_BAD_BOUNDARIES' };
  }
  return { ok: true, data: raw as CommandEvePresentationVisionEdgeSuccess };
}
