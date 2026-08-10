// Command EVE — eve-multimodal gateway core (pure).
//
// This is the pure server-side contract for xAI/Grok and OpenRouter multimodal
// work. Successful validation returns provider-not-enabled; the handler may
// execute only capabilities that have an explicit, server-side feature gate.

import { extractEveImageGenerationInput } from "./image-generation-core.ts";

export type EveMultimodalCapability =
  | "vision"
  | "image_generation"
  | "video_generation"
  // Editing an existing clip is its own capability, not a mode of
  // video_generation: it has a different wire contract (no duration, no
  // resolution), a different price basis (source seconds count as input) and
  // its own feature gate. Folding it into video_generation would let one flag
  // enable two different ways to spend money.
  | "video_edit"
  | "tts"
  | "stt"
  | "realtime_voice"
  | "document_ocr";

export type EveMultimodalProvider = "xai" | "openrouter";

export type EveMultimodalPrivacyLane =
  | "local_only"
  | "cloud_auto"
  | "cloud_us"
  | "cloud_eu"
  | "cloud_de";

export type EveMultimodalArtifactKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document";

export type EveMultimodalReason =
  | "invalid-request"
  | "provider-key-field"
  | "desktop-provider-key-present"
  | "unsupported-capability"
  | "local-only-privacy"
  | "residency-unavailable"
  | "provider-not-enabled";

export type EveMultimodalRequestBody = {
  provider?: string;
  capability?: string;
  privacyLane?: string;
  directProviderKeyPresentInDesktop?: unknown;
  requestId?: string;
};

export type EveMultimodalResidencyReceipt = {
  requestedPrivacyLane: EveMultimodalPrivacyLane;
  effectiveResidency: "us_cloud" | "global_cloud";
  confirmation:
    | "explicit-us-cloud"
    | "server-must-confirm-us-cloud"
    | "zdr-enforced-global";
};

export type EveMultimodalArtifactEnvelope = {
  status: "not_created";
  kind: EveMultimodalArtifactKind;
};

export type EveMultimodalTtsReceipt = {
  voice_id: string;
  language: string;
  text_length: number;
  output_format: { codec: "mp3" };
};

export type EveMultimodalDocumentReceipt = {
  engine: "mistral-ocr";
  file_sha256: string;
  input_bytes: number;
  page_count: number;
};

export type EveMultimodalVisionReceipt = {
  source_kind: "presentation" | "image";
  file_name: string;
  file_sha256: string;
  slide_count: number;
  image_count: number;
  input_bytes: number;
};

export type EveMultimodalImageGenerationReceipt = {
  prompt_chars: number;
  aspect_ratio: string;
  resolution: "1K" | "2K";
  input_reference_count: number;
  input_reference_bytes: number;
};

export type EveMultimodalSkeletonResponse = {
  ok: false;
  gateway: "eve-multimodal";
  provider: EveMultimodalProvider;
  reason: EveMultimodalReason;
  message: string;
  checked_at: string;
  request_id: string;
  capability?: EveMultimodalCapability;
  residency?: EveMultimodalResidencyReceipt;
  artifact?: EveMultimodalArtifactEnvelope;
  tts?: EveMultimodalTtsReceipt;
  document?: EveMultimodalDocumentReceipt;
  vision?: EveMultimodalVisionReceipt;
  image_generation?: EveMultimodalImageGenerationReceipt;
  license?: { verified: true; edition: string };
};

export type EveMultimodalDecision = {
  status: number;
  body: EveMultimodalSkeletonResponse;
};

export type DecideEveMultimodalArgs = {
  body: unknown;
  now: string;
  requestId: string;
};

const CAPABILITIES = Object.freeze(
  [
    "vision",
    "image_generation",
    "video_generation",
    "video_edit",
    "tts",
    "stt",
    "realtime_voice",
    "document_ocr",
  ] as const,
);

const PRIVACY_LANES = Object.freeze(
  ["local_only", "cloud_auto", "cloud_us", "cloud_eu", "cloud_de"] as const,
);

const ARTIFACT_BY_CAPABILITY: Record<
  EveMultimodalCapability,
  EveMultimodalArtifactKind
> = {
  vision: "text",
  image_generation: "image",
  video_generation: "video",
  video_edit: "video",
  tts: "audio",
  stt: "text",
  realtime_voice: "audio",
  document_ocr: "document",
};

export const EVE_MULTIMODAL_TTS_MAX_TEXT_CHARS = 15_000;
export const EVE_MULTIMODAL_PDF_MAX_BYTES = 12 * 1024 * 1024;
export const EVE_MULTIMODAL_VISION_MAX_IMAGES = 8;
export const EVE_MULTIMODAL_VISION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const EVE_MULTIMODAL_VISION_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const EVE_MULTIMODAL_VISION_MAX_CONTEXT_CHARS = 32_000;

const FORBIDDEN_PROVIDER_KEY_FIELDS = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "openrouter-api-key",
  "openrouterApiKey",
  "openrouter_api_key",
  "provider-key",
  "providerKey",
  "provider_key",
  "xai-api-key",
  "xaiApiKey",
  "xai_api_key",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapability(value: unknown): value is EveMultimodalCapability {
  return typeof value === "string" &&
    (CAPABILITIES as readonly string[]).includes(value);
}

function isPrivacyLane(value: unknown): value is EveMultimodalPrivacyLane {
  return typeof value === "string" &&
    (PRIVACY_LANES as readonly string[]).includes(value);
}

function containsForbiddenProviderKeyField(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsForbiddenProviderKeyField(entry, depth + 1)
    );
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    return (
      FORBIDDEN_PROVIDER_KEY_FIELDS.has(key) ||
      FORBIDDEN_PROVIDER_KEY_FIELDS.has(key.toLowerCase()) ||
      containsForbiddenProviderKeyField(nested, depth + 1)
    );
  });
}

function response(
  status: number,
  reason: EveMultimodalReason,
  message: string,
  args: DecideEveMultimodalArgs,
  extra: Partial<
    Pick<
      EveMultimodalSkeletonResponse,
      | "capability"
      | "residency"
      | "artifact"
      | "tts"
      | "document"
      | "vision"
      | "image_generation"
    >
  > = {},
  provider: EveMultimodalProvider = "xai",
): EveMultimodalDecision {
  return {
    status,
    body: {
      ok: false,
      gateway: "eve-multimodal",
      provider,
      reason,
      message,
      checked_at: args.now,
      request_id: args.requestId,
      ...extra,
    },
  };
}

function residencyReceipt(
  privacyLane: EveMultimodalPrivacyLane,
): EveMultimodalResidencyReceipt {
  return {
    requestedPrivacyLane: privacyLane,
    effectiveResidency: "us_cloud",
    confirmation: privacyLane === "cloud_auto"
      ? "server-must-confirm-us-cloud"
      : "explicit-us-cloud",
  };
}

function openRouterResidencyReceipt(
  privacyLane: EveMultimodalPrivacyLane,
): EveMultimodalResidencyReceipt {
  return {
    requestedPrivacyLane: privacyLane,
    effectiveResidency: "global_cloud",
    confirmation: "zdr-enforced-global",
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function stripAsciiControlCharacters(value: string): string {
  let cleaned = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f) {
      cleaned += character;
    }
  }
  return cleaned;
}

function cleanPdfFileName(value: unknown): string {
  if (typeof value !== "string") return "";
  const base = value.trim().replace(/\\/g, "/").split("/").pop() || "";
  if (!base.toLowerCase().endsWith(".pdf")) return "";
  return stripAsciiControlCharacters(base).slice(0, 180);
}

function decodePdfBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  try {
    const binary = atob(value);
    if (
      binary.length === 0 || binary.length > EVE_MULTIMODAL_PDF_MAX_BYTES ||
      !binary.startsWith("%PDF-")
    ) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export type EveMultimodalPdfInput = {
  fileName: string;
  fileSha256: string;
  pageCount: number;
  bytes: Uint8Array;
};

export function extractEveMultimodalPdfInput(
  body: unknown,
): EveMultimodalPdfInput | null {
  if (!isRecord(body)) return null;
  const fileName = cleanPdfFileName(body.file_name);
  const bytes = decodePdfBase64(body.file_data_base64);
  const pageCount = body.page_count;
  if (
    !fileName ||
    !bytes ||
    !isSha256(body.file_sha256) ||
    !Number.isInteger(pageCount) ||
    Number(pageCount) < 1 ||
    Number(pageCount) > 500
  ) {
    return null;
  }
  return {
    fileName,
    fileSha256: body.file_sha256,
    pageCount: Number(pageCount),
    bytes,
  };
}

const VISION_MIME_TYPES = Object.freeze(
  ["image/jpeg", "image/png", "image/webp"] as const,
);
type EveMultimodalVisionMimeType = (typeof VISION_MIME_TYPES)[number];
export type EveMultimodalVisionSourceKind = "presentation" | "image";

function cleanVisionFileName(
  value: unknown,
  sourceKind: EveMultimodalVisionSourceKind,
): string {
  if (typeof value !== "string") return "";
  const base = value.trim().replace(/\\/g, "/").split("/").pop() || "";
  const extension = base.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (
    (sourceKind === "presentation" && extension !== ".pptx") ||
    (sourceKind === "image" &&
      ![".jpg", ".jpeg", ".png", ".webp"].includes(extension))
  ) return "";
  return stripAsciiControlCharacters(base).slice(0, 180);
}

function decodeVisionImageBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }
  try {
    const binary = atob(value);
    if (
      binary.length === 0 ||
      binary.length > EVE_MULTIMODAL_VISION_MAX_IMAGE_BYTES
    ) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function hasVisionImageMagic(
  bytes: Uint8Array,
  mimeType: EveMultimodalVisionMimeType,
): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length &&
      signature.every((value, index) => bytes[index] === value);
  }
  return (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  );
}

export type EveMultimodalVisionImage = {
  slideNumber: number;
  mimeType: EveMultimodalVisionMimeType;
  sha256: string;
  bytes: Uint8Array;
};

export type EveMultimodalVisionInput = {
  sourceKind: EveMultimodalVisionSourceKind;
  fileName: string;
  fileSha256: string;
  slideCount: number;
  contextText: string;
  locale: "de-DE" | "en-US";
  images: EveMultimodalVisionImage[];
};

export function extractEveMultimodalVisionInput(
  body: unknown,
): EveMultimodalVisionInput | null {
  if (!isRecord(body)) return null;
  const sourceKind = body.source_kind === undefined
    ? "presentation"
    : body.source_kind === "presentation" || body.source_kind === "image"
    ? body.source_kind
    : null;
  if (!sourceKind) return null;
  const fileName = cleanVisionFileName(body.file_name, sourceKind);
  const slideCount = body.slide_count;
  const images = body.images;
  const contextText = typeof body.context_text === "string"
    ? body.context_text.trim()
    : "";
  const locale = body.locale === "en-US"
    ? "en-US"
    : body.locale === undefined || body.locale === "de-DE"
    ? "de-DE"
    : null;
  if (
    !fileName ||
    !isSha256(body.file_sha256) ||
    !Number.isInteger(slideCount) ||
    Number(slideCount) < 1 ||
    Number(slideCount) > 200 ||
    !Array.isArray(images) ||
    images.length < 1 ||
    images.length > EVE_MULTIMODAL_VISION_MAX_IMAGES ||
    contextText.length > EVE_MULTIMODAL_VISION_MAX_CONTEXT_CHARS ||
    !locale
  ) {
    return null;
  }
  if (
    sourceKind === "image" &&
    (Number(slideCount) !== 1 || images.length !== 1)
  ) return null;

  const parsed: EveMultimodalVisionImage[] = [];
  const seenSlides = new Set<number>();
  let totalBytes = 0;
  for (const image of images) {
    if (!isRecord(image)) return null;
    const slideNumber = image.slide_number;
    const mimeType = image.mime_type;
    const bytes = decodeVisionImageBase64(image.data_base64);
    if (
      !Number.isInteger(slideNumber) ||
      Number(slideNumber) < 1 ||
      Number(slideNumber) > Number(slideCount) ||
      seenSlides.has(Number(slideNumber)) ||
      typeof mimeType !== "string" ||
      !(VISION_MIME_TYPES as readonly string[]).includes(mimeType) ||
      !isSha256(image.sha256) ||
      !bytes ||
      !hasVisionImageMagic(bytes, mimeType as EveMultimodalVisionMimeType)
    ) {
      return null;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > EVE_MULTIMODAL_VISION_MAX_TOTAL_BYTES) return null;
    seenSlides.add(Number(slideNumber));
    parsed.push({
      slideNumber: Number(slideNumber),
      mimeType: mimeType as EveMultimodalVisionMimeType,
      sha256: image.sha256,
      bytes,
    });
  }

  return {
    sourceKind,
    fileName,
    fileSha256: body.file_sha256,
    slideCount: Number(slideCount),
    contextText,
    locale,
    images: parsed.sort((left, right) => left.slideNumber - right.slideNumber),
  };
}

function ttsReceiptFromBody(body: Record<string, unknown>):
  | { ok: true; receipt: EveMultimodalTtsReceipt; text: string }
  | {
    ok: false;
    message: string;
  } {
  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return { ok: false, message: "TTS requests require non-empty text." };
  }
  if (body.text.length > EVE_MULTIMODAL_TTS_MAX_TEXT_CHARS) {
    return {
      ok: false,
      message:
        `TTS text exceeds ${EVE_MULTIMODAL_TTS_MAX_TEXT_CHARS} characters.`,
    };
  }
  const voiceId =
    typeof body.voice_id === "string" && body.voice_id.trim().length > 0
      ? body.voice_id.trim()
      : "eve";
  const language =
    typeof body.language === "string" && body.language.trim().length > 0
      ? body.language.trim()
      : "en";

  return {
    ok: true,
    text: body.text,
    receipt: {
      voice_id: voiceId,
      language,
      text_length: body.text.length,
      output_format: { codec: "mp3" },
    },
  };
}

export function decideEveMultimodalSkeletonRequest(
  args: DecideEveMultimodalArgs,
): EveMultimodalDecision {
  if (!isRecord(args.body)) {
    return response(
      400,
      "invalid-request",
      "eve-multimodal requires a JSON object request body.",
      args,
    );
  }

  if (containsForbiddenProviderKeyField(args.body)) {
    return response(
      400,
      "provider-key-field",
      "Provider API keys must never be sent to eve-multimodal.",
      args,
    );
  }

  const provider = args.body.provider ?? "xai";
  if (
    (provider !== "xai" && provider !== "openrouter") ||
    !isCapability(args.body.capability) ||
    (provider === "openrouter" && args.body.capability !== "document_ocr" &&
      args.body.capability !== "vision" &&
      args.body.capability !== "image_generation") ||
    (provider === "xai" && args.body.capability === "document_ocr")
  ) {
    return response(
      400,
      "unsupported-capability",
      "Unsupported eve-multimodal provider or capability.",
      args,
    );
  }

  const capability = args.body.capability;
  const privacyLane = args.body.privacyLane === undefined
    ? "cloud_auto"
    : isPrivacyLane(args.body.privacyLane)
    ? args.body.privacyLane
    : null;
  if (privacyLane === null) {
    return response(
      400,
      "invalid-request",
      "Unknown privacyLane. Valid lanes: local_only, cloud_auto, cloud_us, cloud_eu, cloud_de.",
      args,
      { capability },
      provider,
    );
  }
  const base = {
    capability,
    artifact: {
      status: "not_created",
      kind: ARTIFACT_BY_CAPABILITY[capability],
    },
  } satisfies Partial<
    Pick<EveMultimodalSkeletonResponse, "capability" | "artifact">
  >;

  if (args.body.directProviderKeyPresentInDesktop !== false) {
    return response(
      400,
      "desktop-provider-key-present",
      "Desktop must explicitly attest that no provider key is bundled before the gateway can run.",
      args,
      base,
      provider,
    );
  }

  if (privacyLane === "local_only") {
    return response(
      403,
      "local-only-privacy",
      `${
        provider === "openrouter"
          ? "OpenRouter multimodal processing"
          : "xAI multimodal"
      } is blocked while local-only privacy mode is active.`,
      args,
      base,
      provider,
    );
  }

  if (
    (provider === "xai" &&
      (privacyLane === "cloud_eu" || privacyLane === "cloud_de")) ||
    (provider === "openrouter" && privacyLane !== "cloud_auto")
  ) {
    return response(
      403,
      "residency-unavailable",
      provider === "openrouter"
        ? "OpenRouter multimodal processing is currently an explicit global ZDR cloud lane; no US, EU or German residency is claimed."
        : "xAI multimodal is currently available only as a US cloud lane in this gateway.",
      args,
      base,
      provider,
    );
  }

  const pdfInput = provider === "openrouter" && capability === "document_ocr"
    ? extractEveMultimodalPdfInput(args.body)
    : null;
  if (provider === "openrouter" && capability === "document_ocr" && !pdfInput) {
    return response(
      400,
      "invalid-request",
      "OpenRouter document OCR requires a valid PDF, safe filename and matching SHA-256 field.",
      args,
      base,
      provider,
    );
  }

  const visionInput = provider === "openrouter" && capability === "vision"
    ? extractEveMultimodalVisionInput(args.body)
    : null;
  if (provider === "openrouter" && capability === "vision" && !visionInput) {
    return response(
      400,
      "invalid-request",
      "OpenRouter vision requires a valid PPTX or supported image receipt and one to eight bounded visual inputs.",
      args,
      base,
      provider,
    );
  }

  const imageGenerationInput = provider === "openrouter" &&
      capability === "image_generation"
    ? extractEveImageGenerationInput(args.body)
    : null;
  if (
    provider === "openrouter" && capability === "image_generation" &&
    !imageGenerationInput
  ) {
    return response(
      400,
      "invalid-request",
      "OpenRouter image generation requires a bounded prompt, supported aspect ratio/resolution, an optional known image_model tier (fast, quality, max) and zero to four bounded reference images the resolved tier supports.",
      args,
      base,
      provider,
    );
  }

  const tts = capability === "tts" ? ttsReceiptFromBody(args.body) : null;
  if (tts && !tts.ok) {
    return response(400, "invalid-request", tts.message, args, base, provider);
  }

  return response(
    501,
    "provider-not-enabled",
    "eve-multimodal gateway is deployed but provider execution is not enabled yet.",
    args,
    {
      ...base,
      residency: provider === "openrouter"
        ? openRouterResidencyReceipt(privacyLane)
        : residencyReceipt(privacyLane),
      ...(tts?.ok ? { tts: tts.receipt } : {}),
      ...(pdfInput
        ? {
          document: {
            engine: "mistral-ocr" as const,
            file_sha256: pdfInput.fileSha256,
            input_bytes: pdfInput.bytes.byteLength,
            page_count: pdfInput.pageCount,
          },
        }
        : {}),
      ...(visionInput
        ? {
          vision: {
            source_kind: visionInput.sourceKind,
            file_name: visionInput.fileName,
            file_sha256: visionInput.fileSha256,
            slide_count: visionInput.slideCount,
            image_count: visionInput.images.length,
            input_bytes: visionInput.images.reduce(
              (sum, image) => sum + image.bytes.byteLength,
              0,
            ),
          },
        }
        : {}),
      ...(imageGenerationInput
        ? {
          image_generation: {
            prompt_chars: imageGenerationInput.prompt.length,
            aspect_ratio: imageGenerationInput.aspectRatio,
            resolution: imageGenerationInput.resolution,
            input_reference_count: imageGenerationInput.references.length,
            input_reference_bytes: imageGenerationInput.references.reduce(
              (sum, reference) => sum + reference.bytes.byteLength,
              0,
            ),
          },
        }
        : {}),
    },
    provider,
  );
}

export function extractEveMultimodalTtsText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const tts = ttsReceiptFromBody(body);
  return tts.ok ? tts.text : null;
}
