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

import crypto, { randomUUID } from 'node:crypto';
import { EVE_MULTIMODAL_FUNCTION_URL } from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { getDataPath } from '@process/utils/utils';
import { areCommandEveFileSelectionPathsGranted } from '@process/commandEve/fileSelectionGrantCore';
import { getActiveSeatId } from '@process/commandEve/seatContextCore';
import { readBoundedImageSource } from '@process/commandEve/document/imageIntelligenceService';
import {
  saveGeneratedVideoFile,
  saveVideoArtifactRecord,
  listVideoArtifactRecords,
} from '@process/commandEve/videoArtifactStore';
import {
  buildVideoConversationArtifact,
  buildVideoGenerationBody,
  parseVideoGenerationResponse,
  refuseVideoTierWithoutImage,
  type CommandEveVideoConversationArtifact,
  type CommandEveVideoGenerateRequest,
  type CommandEveVideoGenerateResult,
} from '@/common/config/videoGenerationRequestCore';

export type { CommandEveVideoGenerateRequest };

export interface CommandEveVideoBridgeDeps {
  getDataPath: typeof getDataPath;
  fetch: typeof fetch;
  newRequestId: () => string;
  /** A separate id for the durable artifact record — distinct from the wire request id. */
  newArtifactId: () => string;
  getActiveSeatId: typeof getActiveSeatId;
  areFileSelectionPathsGranted: typeof areCommandEveFileSelectionPathsGranted;
  /** Reads and validates the attached image at rest — the same bounded local
   * boundary `imageIntelligenceService` uses for the vision lane. */
  readImageSource: (filePath: string) => { bytes: Uint8Array };
  saveVideoFile: typeof saveGeneratedVideoFile;
  saveArtifactRecord: typeof saveVideoArtifactRecord;
}

const productionDeps: CommandEveVideoBridgeDeps = {
  getDataPath,
  fetch: (...args) => fetch(...args),
  newRequestId: () => randomUUID(),
  newArtifactId: () => randomUUID(),
  getActiveSeatId,
  areFileSelectionPathsGranted: areCommandEveFileSelectionPathsGranted,
  readImageSource: (filePath: string) => readBoundedImageSource(filePath),
  saveVideoFile: saveGeneratedVideoFile,
  saveArtifactRecord: saveVideoArtifactRecord,
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
): Promise<CommandEveVideoGenerateResult> {
  if (!request || typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    return {
      ok: false,
      reasonCode: 'video-request-invalid',
      message: 'Die Videoanfrage war unvollständig.',
      retryable: false,
    };
  }

  // Cheap, local, BEFORE the license/network round trip: 1080p (`hd`) is
  // grok-imagine-video-1.5, which is image->video ONLY. A request claiming it
  // without an attached image is refused here — never silently downgraded and
  // never forwarded to spend a round trip finding out.
  const tierGateRefusal = refuseVideoTierWithoutImage(request.tierId, typeof request.imagePath === 'string');
  if (tierGateRefusal) return tierGateRefusal;

  const wireResult = readLicenseWire(deps.getDataPath());
  if (!wireResult.ok || !wireResult.wire) {
    return {
      ok: false,
      reasonCode: 'entitlement-not-drawable',
      message: 'Für Videos wird ein aktives Command-EVE-Konto benötigt.',
      retryable: false,
    };
  }

  let imageBase64: string | undefined;
  let imageSha256: string | undefined;
  if (typeof request.imagePath === 'string') {
    let seatId: string;
    try {
      seatId = deps.getActiveSeatId();
    } catch {
      return {
        ok: false,
        reasonCode: 'video-image-not-granted',
        message: 'Für deine Sicherheit: Wähle das Bild erneut aus, bevor daraus ein Video erstellt wird.',
        retryable: false,
      };
    }
    if (!deps.areFileSelectionPathsGranted({ filePaths: [request.imagePath], seatId, purpose: 'read' })) {
      return {
        ok: false,
        reasonCode: 'video-image-not-granted',
        message: 'Für deine Sicherheit: Wähle das Bild erneut aus, bevor daraus ein Video erstellt wird.',
        retryable: false,
      };
    }
    try {
      const source = deps.readImageSource(request.imagePath);
      imageBase64 = Buffer.from(source.bytes).toString('base64');
      imageSha256 = crypto.createHash('sha256').update(source.bytes).digest('hex');
    } catch {
      return {
        ok: false,
        reasonCode: 'video-image-unreadable',
        message: 'Das angehängte Bild konnte nicht gelesen werden. Wähle es erneut aus.',
        retryable: false,
      };
    }
  }

  const body = buildVideoGenerationBody({
    prompt: request.prompt.trim(),
    tierId: request.tierId,
    durationSeconds: request.durationSeconds,
    ...(imageBase64 === undefined ? {} : { imageBase64, imageSha256 }),
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
    const outcome = parseVideoGenerationResponse(response.status, raw);
    if (!outcome.ok) return outcome;

    // A successful generation must become a playable, locally persisted
    // conversation artifact — not just a value that lives in this response.
    // Persistence is skipped, never faked, when no conversationId was supplied
    // (the pre-existing gateway-communication tests do not need it); every real
    // caller (the send-path) always supplies one.
    if (!request.conversationId) return outcome;

    try {
      const artifactId = deps.newArtifactId();
      const path = deps.saveVideoFile({
        conversationId: request.conversationId,
        artifactId,
        dataBase64: outcome.artifact.dataBase64,
        mimeType: outcome.artifact.mimeType,
      });
      const conversationArtifact = buildVideoConversationArtifact({
        artifact: outcome.artifact,
        path,
        id: artifactId,
        conversationId: request.conversationId,
        createdAtMs: Date.now(),
      });
      deps.saveArtifactRecord(deps.getDataPath(), conversationArtifact);
      return { ...outcome, conversationArtifact };
    } catch {
      // The clip was genuinely generated (and billed) upstream — telling the
      // user it "failed" would be as dishonest as a fake success. This reason
      // code says exactly what happened: produced, not saved.
      return {
        ok: false,
        reasonCode: 'video-artifact-save-failed',
        message: 'Das Video wurde erstellt, konnte aber nicht lokal gespeichert werden.',
        retryable: false,
      };
    }
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

export interface CommandEveVideoArtifactsListDeps {
  getDataPath: typeof getDataPath;
  listArtifactRecords: typeof listVideoArtifactRecords;
}

const productionListDeps: CommandEveVideoArtifactsListDeps = {
  getDataPath,
  listArtifactRecords: listVideoArtifactRecords,
};

/**
 * Everything this desktop has locally and durably saved for a conversation —
 * the counterpart AionCore's own `listArtifacts` cannot provide, since AionCore
 * never learns about a video generated through this direct Main -> gateway
 * call. The renderer merges this list with AionCore's on load, so a video
 * survives switching away from the conversation and back.
 */
export async function handleCommandEveVideoArtifactsList(
  request?: { conversationId?: string },
  deps: CommandEveVideoArtifactsListDeps = productionListDeps
): Promise<CommandEveVideoConversationArtifact[]> {
  if (!request || typeof request.conversationId !== 'string' || request.conversationId.length === 0) return [];
  return deps.listArtifactRecords(deps.getDataPath(), request.conversationId);
}
