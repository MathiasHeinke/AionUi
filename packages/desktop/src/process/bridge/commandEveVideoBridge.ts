/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process bridge for managed video generation.
 *
 * The socket lives here; the meaning lives in `videoGenerationRequestCore`. The
 * split matters because the interesting behaviour of this lane is what it does
 * when the gateway says no, and that has to be testable without a network.
 *
 * The bearer is the CEVE licence wire, exactly as the image/vision/TTS lanes do
 * it — Main attaches it, the renderer never sees it, and no provider key exists
 * on this side at all.
 */

import { randomUUID } from 'node:crypto';
import { EVE_MULTIMODAL_FUNCTION_URL } from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { getDataPath } from '@process/utils/utils';
import {
  buildVideoGenerationBody,
  parseVideoGenerationResponse,
  type CommandEveVideoGenerateRequest,
  type VideoGenerationOutcome,
} from '@/common/config/videoGenerationRequestCore';

export type { CommandEveVideoGenerateRequest };

export interface CommandEveVideoBridgeDeps {
  getDataPath: typeof getDataPath;
  fetch: typeof fetch;
  newRequestId: () => string;
}

const productionDeps: CommandEveVideoBridgeDeps = {
  getDataPath,
  fetch: (...args) => fetch(...args),
  newRequestId: () => randomUUID(),
};

/**
 * A generation can legitimately take minutes (the gateway polls xAI), but it must
 * not be able to hang a renderer forever. Slightly above the server's own window
 * so the server's precise reason wins the race against a blunt client timeout.
 */
const VIDEO_REQUEST_TIMEOUT_MS = 200_000;

/** Ceiling on the response we will read — a 1080p/15s clip plus base64 overhead. */
const MAX_VIDEO_RESPONSE_BYTES = 160 * 1024 * 1024;

export async function handleCommandEveVideoGenerate(
  request?: CommandEveVideoGenerateRequest,
  deps: CommandEveVideoBridgeDeps = productionDeps
): Promise<VideoGenerationOutcome> {
  if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    return {
      ok: false,
      reasonCode: 'video-request-invalid',
      message: 'Die Videoanfrage war unvollständig.',
      retryable: false,
    };
  }

  const wireResult = readLicenseWire(deps.getDataPath());
  if (!wireResult.ok || !wireResult.wire) {
    return {
      ok: false,
      reasonCode: 'entitlement-not-drawable',
      message: 'Für Videos wird ein aktives Command-EVE-Konto benötigt.',
      retryable: false,
    };
  }

  const body = buildVideoGenerationBody({
    prompt: request.prompt.trim(),
    tierId: request.tierId,
    durationSeconds: request.durationSeconds,
    ...(request.imageBase64 === undefined
      ? {}
      : { imageBase64: request.imageBase64, imageSha256: request.imageSha256 }),
    requestId: deps.newRequestId(),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetch(EVE_MULTIMODAL_FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${wireResult.wire}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      redirect: 'error',
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (text.length > MAX_VIDEO_RESPONSE_BYTES) {
      return {
        ok: false,
        reasonCode: 'video-response-too-large',
        message: 'Die Antwort des Servers war zu groß.',
        retryable: false,
      };
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = null;
    }
    // Status AND body together — the body carries the reason, and a malformed 200
    // is a failure, not a success. Both judgements live in the pure core.
    return parseVideoGenerationResponse(response.status, raw);
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    return name === 'AbortError'
      ? {
          ok: false,
          reasonCode: 'provider-timeout',
          message: 'Die Videoerstellung hat zu lange gedauert.',
          retryable: true,
        }
      : {
          ok: false,
          reasonCode: 'video-request-failed',
          message: 'Die Videoerstellung konnte nicht gestartet werden.',
          retryable: true,
        };
  } finally {
    clearTimeout(timer);
  }
}
