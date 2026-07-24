/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import {
  COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS,
  COMMAND_EVE_MANAGED_IMAGE_ENABLED,
  COMMAND_EVE_MANAGED_IMAGE_GATEWAY_DEPLOYED,
  COMMAND_EVE_MANAGED_IMAGE_MAX_PROMPT_CHARS,
  COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES,
  COMMAND_EVE_MANAGED_IMAGE_MAX_RESPONSE_BYTES,
  COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES,
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS,
  parseCommandEveManagedImageEdgeResponse,
  type CommandEveManagedImageAspectRatio,
  type CommandEveManagedImageEdgeRequest,
  type CommandEveManagedImageMimeType,
  type CommandEveManagedImageResolution,
} from '@/common/config/eveManagedImageGenerationCore';
import { EVE_MULTIMODAL_FUNCTION_URL, resolveCommandEveMultimodalGate } from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { readCommandEveLimitedResponseText } from './limitedFetchResponse';
import { getDataPath } from '@process/utils/utils';

const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 130_000;

type OpenAiImageReference = {
  type?: unknown;
  image_url?: { url?: unknown };
};

export type CommandEveManagedImageLocalRequest = {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  aspect_ratio?: unknown;
  resolution?: unknown;
  input_references?: unknown;
};

export type CommandEveManagedImageLocalResult = {
  status: number;
  body: Record<string, unknown>;
};

function failure(status: number, code: string, message: string): CommandEveManagedImageLocalResult {
  return { status, body: { error: { code, message } } };
}

function parseReferenceDataUrl(value: unknown): { mimeType: CommandEveManagedImageMimeType; bytes: Buffer } | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase() as CommandEveManagedImageMimeType;
  if (!COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES.includes(mimeType)) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 8 || bytes.length > MAX_REFERENCE_BYTES) return null;
  if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) return null;
  return { mimeType, bytes };
}

function buildEdgeRequest(
  raw: CommandEveManagedImageLocalRequest
):
  | { ok: true; body: CommandEveManagedImageEdgeRequest; promptSha256: string }
  | { ok: false; result: CommandEveManagedImageLocalResult } {
  if (raw.model !== COMMAND_EVE_MANAGED_IMAGE_MODEL) {
    return { ok: false, result: failure(400, 'model_not_supported', 'Managed image model is not supported.') };
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.replace(/\r\n?/g, '\n').trim() : '';
  if (!prompt || prompt.length > COMMAND_EVE_MANAGED_IMAGE_MAX_PROMPT_CHARS) {
    return { ok: false, result: failure(400, 'invalid_prompt', 'Image prompt is missing or too long.') };
  }
  if (raw.n !== undefined && raw.n !== 1) {
    return {
      ok: false,
      result: failure(400, 'invalid_image_count', 'Generate one independent visual direction per request.'),
    };
  }
  const aspectRatio = typeof raw.aspect_ratio === 'string' ? raw.aspect_ratio.trim() : '16:9';
  const resolution = typeof raw.resolution === 'string' ? raw.resolution.trim() : '1K';
  if (!COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS.includes(aspectRatio as CommandEveManagedImageAspectRatio)) {
    return { ok: false, result: failure(400, 'invalid_aspect_ratio', 'Unsupported image aspect ratio.') };
  }
  if (!COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS.includes(resolution as CommandEveManagedImageResolution)) {
    return { ok: false, result: failure(400, 'invalid_resolution', 'Unsupported image resolution.') };
  }
  const references = raw.input_references === undefined ? [] : raw.input_references;
  if (!Array.isArray(references) || references.length > COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES) {
    return { ok: false, result: failure(400, 'invalid_references', 'Too many image references.') };
  }
  let totalBytes = 0;
  const inputReferences: CommandEveManagedImageEdgeRequest['input_references'] = [];
  for (const candidate of references as OpenAiImageReference[]) {
    if (candidate?.type !== 'image_url' || !candidate.image_url || typeof candidate.image_url !== 'object') {
      return { ok: false, result: failure(400, 'invalid_reference', 'Image reference must be a data URL.') };
    }
    const parsed = parseReferenceDataUrl(candidate.image_url.url);
    if (!parsed) {
      return { ok: false, result: failure(400, 'invalid_reference', 'Image reference is invalid or too large.') };
    }
    totalBytes += parsed.bytes.length;
    if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
      return { ok: false, result: failure(400, 'invalid_references', 'Image references exceed the total limit.') };
    }
    inputReferences.push({
      mime_type: parsed.mimeType,
      sha256: crypto.createHash('sha256').update(parsed.bytes).digest('hex'),
      data_base64: parsed.bytes.toString('base64'),
    });
  }
  const promptSha256 = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  return {
    ok: true,
    promptSha256,
    body: {
      provider: 'openrouter',
      capability: 'image_generation',
      privacyLane: 'cloud_auto',
      directProviderKeyPresentInDesktop: false,
      requestId: `image-${crypto.randomUUID()}`,
      prompt,
      aspect_ratio: aspectRatio as CommandEveManagedImageAspectRatio,
      resolution: resolution as CommandEveManagedImageResolution,
      input_references: inputReferences,
    },
  };
}

export async function executeCommandEveManagedImageGeneration(
  raw: CommandEveManagedImageLocalRequest,
  options: { fetchFn?: typeof fetch; dataPath?: string } = {}
): Promise<CommandEveManagedImageLocalResult> {
  const built = buildEdgeRequest(raw);
  if (built.ok === false) return built.result;
  if (!COMMAND_EVE_MANAGED_IMAGE_ENABLED) {
    return failure(503, 'managed_image_disabled', 'Managed image generation is not enabled.');
  }
  const wireResult = readLicenseWire(options.dataPath ?? getDataPath());
  const gate = resolveCommandEveMultimodalGate({
    provider: 'openrouter',
    capability: 'image_generation',
    privacyLane: 'cloud_auto',
    hasServerGateway: Boolean(EVE_MULTIMODAL_FUNCTION_URL) && COMMAND_EVE_MANAGED_IMAGE_GATEWAY_DEPLOYED,
    hasLicense: Boolean(wireResult.ok && wireResult.wire),
    directProviderKeyPresentInDesktop: false,
  });
  if (gate.ok === false) return failure(503, gate.reason, gate.message);
  if (!wireResult.ok || !wireResult.wire) {
    return failure(401, wireResult.reason_code || 'missing_license', 'Command EVE license is unavailable.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchFn ?? fetch)(gate.functionUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${wireResult.wire}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      redirect: 'error',
      cache: 'no-store',
      body: JSON.stringify(built.body),
      signal: controller.signal,
    });
    const responseText = await readCommandEveLimitedResponseText(
      response,
      COMMAND_EVE_MANAGED_IMAGE_MAX_RESPONSE_BYTES
    );
    if (!responseText.ok) {
      return failure(502, 'provider_response_too_large', 'Managed image response exceeded the local limit.');
    }
    let rawResponse: unknown = null;
    try {
      rawResponse = JSON.parse(responseText.text);
    } catch {
      rawResponse = null;
    }
    const parsed = parseCommandEveManagedImageEdgeResponse(rawResponse);
    if (!response.ok || parsed.ok === false) {
      return failure(
        response.status === 429 ? 429 : response.status >= 400 && response.status < 500 ? response.status : 502,
        parsed.ok === false ? parsed.reason_code : `managed_image_http_${response.status}`,
        parsed.ok === false ? parsed.message || 'Managed image generation failed.' : 'Managed image generation failed.'
      );
    }
    const artifactBytes = Buffer.from(parsed.data.artifact.data_base64, 'base64');
    const artifactSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
    if (
      artifactSha256 !== parsed.data.artifact.sha256 ||
      parsed.data.image_generation.prompt_sha256 !== built.promptSha256 ||
      parsed.data.image_generation.aspect_ratio !== built.body.aspect_ratio ||
      parsed.data.image_generation.resolution !== built.body.resolution ||
      parsed.data.image_generation.input_reference_sha256.length !== built.body.input_references.length ||
      parsed.data.image_generation.input_reference_sha256.some(
        (value, index) => value !== built.body.input_references[index]?.sha256
      )
    ) {
      return failure(502, 'managed_image_receipt_mismatch', 'Managed image receipt did not match the request.');
    }
    return {
      status: 200,
      body: {
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            b64_json: parsed.data.artifact.data_base64,
            media_type: parsed.data.artifact.mime_type,
          },
        ],
        usage: {
          ...(parsed.data.image_generation.cost_usd === undefined
            ? {}
            : { cost: parsed.data.image_generation.cost_usd }),
          model: parsed.data.image_generation.model,
        },
      },
    };
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    return failure(
      name === 'AbortError' ? 504 : 502,
      name === 'AbortError' ? 'managed_image_timeout' : 'managed_image_failed',
      name === 'AbortError' ? 'Managed image generation timed out.' : 'Managed image generation failed.'
    );
  } finally {
    clearTimeout(timer);
  }
}
