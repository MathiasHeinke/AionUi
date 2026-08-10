import crypto from "node:crypto";
import {
  billableOperation,
  billedFetch,
  type ReserveReceipt,
  UnbilledCallError,
} from "../_shared/billable-operations.ts";
import {
  type ImageModelRegistryEntry,
  resolveImageGenerationModel,
} from "./image-model-registry.ts";

/**
 * The endpoint is READ from the registry, never spelled here. Image generation
 * is NOT chat/completions, and the first draft of the old metering gate learned
 * that the hard way — it scanned only completions endpoints and failed against
 * its own allowlist. One place declares the URL; every lane asks for it.
 */
const IMAGE_GENERATION_OPERATION = billableOperation(
  "multimodal.image_generation",
)!;

export const EVE_IMAGE_GENERATION_MAX_PROMPT_CHARS = 12_000;
export const EVE_IMAGE_GENERATION_MAX_REFERENCES = 4;
export const EVE_IMAGE_GENERATION_MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
export const EVE_IMAGE_GENERATION_MAX_TOTAL_REFERENCE_BYTES = 8 * 1024 * 1024;
export const EVE_IMAGE_GENERATION_MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
export const EVE_IMAGE_GENERATION_MAX_PROVIDER_RESPONSE_BYTES =
  Math.ceil((EVE_IMAGE_GENERATION_MAX_OUTPUT_BYTES * 4) / 3) + 256 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const ALLOWED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);
const ALLOWED_RESOLUTIONS = new Set(["1K", "2K"]);

export type EveImageGenerationReference = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  sha256: string;
  bytes: Uint8Array;
};

export type EveImageGenerationInput = {
  prompt: string;
  aspectRatio: string;
  resolution: "1K" | "2K";
  references: EveImageGenerationReference[];
  /**
   * The RESOLVED registry entry, never a client-supplied slug. The client
   * sends a tier id in `image_model`; the registry turns it into the slug,
   * the price and the routing here, at the parse, so nothing downstream can
   * quote one model and run another.
   */
  imageModel: ImageModelRegistryEntry;
};

export type OpenRouterGeneratedImage = {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  costUsd?: number;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64(value: unknown): Uint8Array | null {
  if (
    typeof value !== "string" || value.length < 4 ||
    value.length >
      Math.ceil((EVE_IMAGE_GENERATION_MAX_REFERENCE_BYTES * 4) / 3) + 8 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function normalizePrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").trim();
}

export function extractEveImageGenerationInput(
  body: unknown,
): EveImageGenerationInput | null {
  if (!isRecord(body)) return null;
  const prompt = normalizePrompt(body.prompt);
  if (!prompt || prompt.length > EVE_IMAGE_GENERATION_MAX_PROMPT_CHARS) {
    return null;
  }
  const aspectRatio = typeof body.aspect_ratio === "string"
    ? body.aspect_ratio.trim()
    : "16:9";
  const resolution = typeof body.resolution === "string"
    ? body.resolution.trim()
    : "1K";
  if (
    !ALLOWED_ASPECT_RATIOS.has(aspectRatio) ||
    !ALLOWED_RESOLUTIONS.has(resolution)
  ) return null;

  // THE TIER IS RESOLVED AT THE PARSE, before any debit can exist. Absent
  // means the registry default; an unknown or non-string tier fails CLOSED —
  // a request that named a model we do not price must never silently bill the
  // default one.
  const imageModel = body.image_model === undefined
    ? resolveImageGenerationModel(undefined)
    : typeof body.image_model === "string"
    ? resolveImageGenerationModel(body.image_model.trim())
    : null;
  if (!imageModel) return null;

  const rawReferences = body.input_references === undefined
    ? []
    : body.input_references;
  if (
    !Array.isArray(rawReferences) ||
    rawReferences.length > EVE_IMAGE_GENERATION_MAX_REFERENCES
  ) return null;

  let totalBytes = 0;
  const references: EveImageGenerationReference[] = [];
  for (const reference of rawReferences) {
    if (!isRecord(reference)) return null;
    const mimeType = typeof reference.mime_type === "string"
      ? reference.mime_type.toLowerCase().trim()
      : "";
    const sha256 = typeof reference.sha256 === "string"
      ? reference.sha256.toLowerCase().trim()
      : "";
    const bytes = decodeBase64(reference.data_base64);
    if (
      !ALLOWED_MIME_TYPES.has(mimeType) ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !bytes || bytes.byteLength < 8 ||
      bytes.byteLength > EVE_IMAGE_GENERATION_MAX_REFERENCE_BYTES
    ) return null;
    totalBytes += bytes.byteLength;
    if (totalBytes > EVE_IMAGE_GENERATION_MAX_TOTAL_REFERENCE_BYTES) {
      return null;
    }
    references.push({
      mimeType: mimeType as EveImageGenerationReference["mimeType"],
      sha256,
      bytes,
    });
  }

  // Reference/edit inputs are a PER-MODEL capability. A tier whose registry
  // entry carries no evidence for them refuses them here — at the parse,
  // before a debit — rather than discovering the refusal at the provider.
  if (references.length > 0 && !imageModel.supportsReferenceImages) {
    return null;
  }

  return {
    prompt,
    aspectRatio,
    resolution: resolution as EveImageGenerationInput["resolution"],
    references,
    imageModel,
  };
}

function extractProviderImage(value: unknown): OpenRouterGeneratedImage | null {
  if (
    !isRecord(value) || !Array.isArray(value.data) || value.data.length !== 1
  ) {
    return null;
  }
  const image = value.data[0];
  if (!isRecord(image) || typeof image.b64_json !== "string") return null;
  const mimeType = typeof image.media_type === "string"
    ? image.media_type.toLowerCase().trim()
    : "image/png";
  if (!ALLOWED_MIME_TYPES.has(mimeType)) return null;
  const bytes = decodeBase64(image.b64_json);
  if (
    !bytes || bytes.byteLength < 8 ||
    bytes.byteLength > EVE_IMAGE_GENERATION_MAX_OUTPUT_BYTES
  ) return null;
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const rawCost = usage?.cost;
  const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) &&
      rawCost >= 0 && rawCost <= 10
    ? rawCost
    : undefined;
  return {
    bytes,
    mimeType: mimeType as OpenRouterGeneratedImage["mimeType"],
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export async function callOpenRouterImageGeneration(args: {
  apiKey: string;
  input: EveImageGenerationInput;
  timeoutMs: number;
  fetchFn: FetchLike;
  /**
   * REQUIRED. Proof that a durable debit for this operation already landed.
   *
   * This core used to be declared metered BY DELEGATION: the old metering gate
   * carried an entry saying `meteredBy: "eve-multimodal/index.ts"`, on the
   * strength of that orchestrator reserving `images_reserved: 1`. That
   * reservation was a per-day UNIT CAP — `command_eve_draw_multimodal_usage`
   * touches neither credit_balances nor credit_transactions — so the delegation
   * terminated at no debit at all. Metering must terminate at money; it does
   * now, and the proof is a parameter rather than a comment.
   */
  receipt: ReserveReceipt;
}): Promise<
  | { ok: true; image: OpenRouterGeneratedImage }
  | { ok: false; status: number; reason: string; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await billedFetch({
      operationId: IMAGE_GENERATION_OPERATION.id,
      url: IMAGE_GENERATION_OPERATION.endpoint,
      fetchFn: args.fetchFn,
      receipt: args.receipt,
      init: {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": Deno.env.get("OPENROUTER_HTTP_REFERER") ??
          "https://command-eve.com",
        "X-Title": Deno.env.get("OPENROUTER_X_TITLE") ??
          "Command EVE Visual Direction Gate",
      },
      body: JSON.stringify({
        model: args.input.imageModel.providerSlug,
        prompt: args.input.prompt,
        n: 1,
        aspect_ratio: args.input.aspectRatio,
        resolution: args.input.resolution,
        input_references: args.input.references.map((reference) => ({
          type: "image_url",
          image_url: {
            url: `data:${reference.mimeType};base64,${
              bytesToBase64(reference.bytes)
            }`,
          },
        })),
        // ROUTING IS PER-MODEL, from the registry. The google slug keeps the
        // ZDR-capable google-vertex/global pin; the x-ai/openai slugs carry no
        // `only` pin — one hard-coded vertex route for every model would
        // structurally exclude the providers the other two slugs name. What is
        // NOT per-model: fallbacks stay OFF, ZDR stays ON, collection stays
        // DENIED, on every tier.
        provider: {
          ...(args.input.imageModel.openRouterProviderOnly
            ? { only: [...args.input.imageModel.openRouterProviderOnly] }
            : {}),
          allow_fallbacks: false,
          zdr: true,
          data_collection: "deny",
        },
      }),
      },
    });

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > EVE_IMAGE_GENERATION_MAX_PROVIDER_RESPONSE_BYTES
    ) {
      return {
        ok: false,
        status: 502,
        reason: "provider-response-too-large",
        message: "OpenRouter image generation returned too much data.",
      };
    }
    const responseText = await response.text();
    if (
      new TextEncoder().encode(responseText).byteLength >
        EVE_IMAGE_GENERATION_MAX_PROVIDER_RESPONSE_BYTES
    ) {
      return {
        ok: false,
        status: 502,
        reason: "provider-response-too-large",
        message: "OpenRouter image generation returned too much data.",
      };
    }
    let responseJson: unknown = null;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status === 429 ? 429 : 502,
        reason: response.status === 429
          ? "provider-rate-limit"
          : "provider-error",
        message:
          `OpenRouter image generation returned HTTP ${response.status}.`,
      };
    }
    const image = extractProviderImage(responseJson);
    if (!image) {
      return {
        ok: false,
        status: 502,
        reason: "provider-invalid-image",
        message:
          "OpenRouter image generation returned an invalid image artifact.",
      };
    }
    return { ok: true, image };
  } catch (error) {
    if (error instanceof UnbilledCallError) {
      return {
        ok: false,
        status: 500,
        reason: "unbilled-call-refused",
        message:
          `The image-generation call was refused before the provider: ${error.code}.`,
      };
    }
    const aborted = error instanceof DOMException &&
      error.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      reason: aborted ? "provider-timeout" : "provider-error",
      message: aborted
        ? "OpenRouter image generation timed out."
        : "OpenRouter image generation request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function imageGenerationPromptSha256(
  input: EveImageGenerationInput,
): string {
  return crypto.createHash("sha256").update(input.prompt, "utf8").digest("hex");
}
