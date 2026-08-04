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
  | {
      ok: true;
      /** The opaque staged reference (`img_h_…`) — the ONLY artifact identity the model ever sees. */
      artifactHandle: string;
      mediaType: string;
      sha256: string;
      bytesCount: number;
      /** Echoed from the verified request — the tool text states what was asked for. */
      resolution: string;
      aspectRatio: string;
      model?: string;
      costUsd?: number;
    }
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
    // 1.820.3 — the managed lane is PATH-FREE and BYTE-FREE: the shim stages
    // the image privately in Main and answers with an opaque staged handle
    // plus typed metadata. There is deliberately no `b64_json` fallback here:
    // this client exists only for the managed lane, and re-inflating provider
    // bytes into the MCP transport is exactly the payload the contract removes.
    if (!isRecord(artifact) || typeof artifact.artifact_handle !== 'string') {
      return { ok: false, error: 'Managed image response did not contain an image reference.' };
    }
    const mimeType = typeof artifact.media_type === 'string' ? artifact.media_type.toLowerCase() : 'image/png';
    if (!COMMAND_EVE_MANAGED_IMAGE_MIME_TYPES.includes(mimeType as CommandEveManagedImageMimeType)) {
      return { ok: false, error: 'Managed image response used an unsupported format.' };
    }
    const sha256 = typeof artifact.sha256 === 'string' ? artifact.sha256 : '';
    const bytesCount = typeof artifact.bytes_count === 'number' ? artifact.bytes_count : 0;
    if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isFinite(bytesCount) || bytesCount <= 0) {
      return { ok: false, error: 'Managed image response carried incomplete artifact metadata.' };
    }
    const usage = isRecord(raw.usage) ? raw.usage : undefined;
    const cost = usage?.cost;
    const model = usage?.model;
    return {
      ok: true,
      artifactHandle: artifact.artifact_handle,
      mediaType: mimeType,
      sha256,
      bytesCount,
      resolution,
      aspectRatio,
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
