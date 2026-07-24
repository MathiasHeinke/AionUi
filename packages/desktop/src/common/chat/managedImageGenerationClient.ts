/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS,
  COMMAND_EVE_MANAGED_IMAGE_MAX_RESPONSE_BYTES,
  COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES,
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS,
  type CommandEveManagedImageAspectRatio,
  type CommandEveManagedImageMimeType,
  type CommandEveManagedImageResolution,
} from '@/common/config/eveManagedImageGenerationCore';
import type { TProviderWithModel } from '@/common/config/storage';

export type ManagedImageGenerationClientResult =
  | { ok: true; dataUrl: string; model?: string; costUsd?: number }
  | { ok: false; error: string };

function localImagesEndpoint(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    const path = parsed.pathname.replace(/\/+$/, '');
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      !parsed.port ||
      (path !== '' && path !== '/v1') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    parsed.pathname = `${path || '/v1'}/images`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function executeManagedImageGenerationViaShim(input: {
  provider: TProviderWithModel;
  prompt: string;
  referenceDataUrls: string[];
  aspectRatio?: string;
  resolution?: string;
  signal?: AbortSignal;
}): Promise<ManagedImageGenerationClientResult> {
  const endpoint = localImagesEndpoint(input.provider.base_url);
  if (!endpoint || !input.provider.api_key || input.provider.use_model !== COMMAND_EVE_MANAGED_IMAGE_MODEL) {
    return { ok: false, error: 'Managed image provider is not ready.' };
  }
  const aspectRatio = COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS.includes(
    input.aspectRatio as CommandEveManagedImageAspectRatio
  )
    ? (input.aspectRatio as CommandEveManagedImageAspectRatio)
    : '16:9';
  const resolution = COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS.includes(
    input.resolution as CommandEveManagedImageResolution
  )
    ? (input.resolution as CommandEveManagedImageResolution)
    : '1K';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.provider.api_key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
        prompt: input.prompt,
        n: 1,
        aspect_ratio: aspectRatio,
        resolution,
        input_references: input.referenceDataUrls.map((url) => ({
          type: 'image_url',
          image_url: { url },
        })),
      }),
      signal: input.signal,
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > COMMAND_EVE_MANAGED_IMAGE_MAX_RESPONSE_BYTES) {
      return { ok: false, error: 'Managed image response was too large.' };
    }
    const responseText = await response.text();
    if (Buffer.byteLength(responseText, 'utf8') > COMMAND_EVE_MANAGED_IMAGE_MAX_RESPONSE_BYTES) {
      return { ok: false, error: 'Managed image response was too large.' };
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(responseText);
    } catch {
      raw = null;
    }
    if (!response.ok || !isRecord(raw) || !Array.isArray(raw.data) || raw.data.length !== 1) {
      const message =
        isRecord(raw) && isRecord(raw.error) && typeof raw.error.message === 'string'
          ? raw.error.message.slice(0, 300)
          : `Managed image request failed with HTTP ${response.status}.`;
      return { ok: false, error: message };
    }
    const artifact = raw.data[0];
    if (!isRecord(artifact) || typeof artifact.b64_json !== 'string') {
      return { ok: false, error: 'Managed image response did not contain an image.' };
    }
    const mimeType = typeof artifact.media_type === 'string' ? artifact.media_type.toLowerCase() : 'image/png';
    if (!COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES.includes(mimeType as CommandEveManagedImageMimeType)) {
      return { ok: false, error: 'Managed image response used an unsupported format.' };
    }
    const bytes = Buffer.from(artifact.b64_json, 'base64');
    if (bytes.length < 8 || bytes.toString('base64').replace(/=+$/, '') !== artifact.b64_json.replace(/=+$/, '')) {
      return { ok: false, error: 'Managed image response contained invalid image data.' };
    }
    const usage = isRecord(raw.usage) ? raw.usage : undefined;
    const cost = usage?.cost;
    const model = usage?.model;
    return {
      ok: true,
      dataUrl: `data:${mimeType};base64,${artifact.b64_json}`,
      ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
      ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    };
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    return {
      ok: false,
      error: name === 'AbortError' ? 'Managed image request was cancelled.' : 'Managed image request failed.',
    };
  }
}
