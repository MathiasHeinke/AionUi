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
import fs from 'node:fs';
import { commandEveMediaSeedAttribution, EVE_MULTIMODAL_FUNCTION_URL } from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { getDataPath } from '@process/utils/utils';
import { areCommandEveFileSelectionPathsGranted } from '@process/commandEve/fileSelectionGrantCore';
import {
  getActiveSeatContextRevision,
  getActiveSeatId,
  getCommandEvePaidArtifactBlockReason,
  tryBeginCommandEvePaidArtifactOperation,
} from '@process/commandEve/seatContextCore';
import { readBoundedImageSource } from '@process/commandEve/document/imageIntelligenceService';
import {
  saveGeneratedVideoFile,
  saveVideoArtifactRecord,
  listVideoArtifactRecords,
} from '@process/commandEve/videoArtifactStore';
import {
  imageArtifactIdForSha256,
  imageMimeTypeFromPath,
  listImageArtifactRecords,
  saveImageArtifactRecord,
} from '@process/commandEve/visual/imageArtifactRecordStore';
import {
  buildConversationArtifactEnvelopeEntries,
  ensureVideoEditCapabilityHandle,
  ensureImageEditCapabilityHandle,
  readArtifactCapabilityGrant,
  resolveVideoEditCapability,
} from '@process/commandEve/artifactCapabilityHandleStore';
import {
  listActiveImageArtifacts,
  readImageArtifactBytes,
  readImageArtifactRecordById,
} from '@process/commandEve/imageArtifactStore';
import { isAgentImageEditAdvertisingEnabled } from '@process/commandEve/agentImageEditFlag';
import {
  acquireVideoEditInflightLock,
  consumeVideoEditSpendPermit,
  denyVideoEditSpend,
  evaluateStoredVideoEditSpendPermit,
  isVideoEditSpendDenied,
  isVideoEditSpendStoreHealthy,
  issueVideoEditSpendPermit,
  readVideoEditSpendCompletion,
  readVideoEditSpendPermitRecord,
  recordActiveUserTurn,
  recordVideoEditSpendCompletion,
  releaseVideoEditInflightLock,
  revokeVideoEditSpendOnUserSteer,
} from '@process/commandEve/videoEditSpendPermitStore';
import { emitCommandEveArtifactsChanged } from '@process/commandEve/artifactsChangedEmitter';
import { hasVisibleCharacters } from '@/common/config/eveOpaqueTokenCore';
import { isAgentVideoEditAdvertisingEnabled, readVideoSeatCapabilities } from '@process/commandEve/agentVideoEditFlag';
import {
  ARTIFACT_ENVELOPE_MAX_ARTIFACTS,
  buildEveArtifactContextEnvelope,
  type EveArtifactEnvelopeEntry,
} from '@/common/config/eveArtifactContextEnvelopeCore';
import { describeSpendPermitRefusal } from '@/common/config/eveVideoEditSpendPermitCore';
import { getVideoTier } from '@/common/config/videoCostCore';
import { describeArtifactCapabilityRefusal } from '@/common/config/eveArtifactCapabilityHandleCore';
import {
  buildVideoEditBody,
  buildVideoEditRequestIdMaterial,
  MAX_VIDEO_EDIT_INSTRUCTION_CHARS,
  parseVideoEditResponse,
  type CommandEveVideoEditRequest,
  type CommandEveVideoEditResult,
  type VideoEditOutcome,
} from '@/common/config/videoEditRequestCore';
import {
  buildVideoConversationArtifact,
  buildVideoGenerationBody,
  hydrateVideoArtifactPayload,
  isVideoArtifactEditable,
  parseVideoGenerationResponse,
  refuseUnproducibleVideoRequest,
  resolveVideoArtifactTier,
  type CommandEveVideoConversationArtifact,
  type CommandEveVideoGenerateRequest,
  type CommandEveVideoGenerateResult,
  type VideoAssetPayload,
} from '@/common/config/videoGenerationRequestCore';
import {
  buildVideoRequestMode,
  describeVideoModeRefusal,
  MAX_VIDEO_REFERENCE_IMAGES,
  type VideoRequestMode,
  type VideoSeatCapabilities,
} from '@/common/config/videoCostCore';
import type { VideoCatalogEntry } from '@/common/config/videoCatalogCore';
import { readVideoCatalogWire } from '@process/commandEve/videoCatalogWireMain';

export type { CommandEveVideoGenerateRequest };

export interface CommandEveVideoBridgeDeps {
  getDataPath: typeof getDataPath;
  fetch: typeof fetch;
  newRequestId: () => string;
  /** A separate id for the durable artifact record — distinct from the wire request id. */
  newArtifactId: () => string;
  getActiveSeatId: typeof getActiveSeatId;
  /** Optional only for compatibility with older test seams; production always
   * supplies the monotonic revision and binds it to the captured seat id. */
  getActiveSeatContextRevision?: typeof getActiveSeatContextRevision;
  getPaidArtifactBlockReason?: typeof getCommandEvePaidArtifactBlockReason;
  areFileSelectionPathsGranted: typeof areCommandEveFileSelectionPathsGranted;
  /** Reads and validates the attached image at rest — the same bounded local
   * boundary `imageIntelligenceService` uses for the vision lane. */
  readImageSource: (filePath: string) => { bytes: Uint8Array };
  /** Resolve a pathless managed image inside Main's active Seat-scoped store. */
  readManagedImageRecord?: typeof readImageArtifactRecordById;
  readManagedImageBytes?: typeof readImageArtifactBytes;
  saveVideoFile: typeof saveGeneratedVideoFile;
  saveArtifactRecord: typeof saveVideoArtifactRecord;
  /**
   * The seat's video model capabilities (MAT-1753). Optional for the same reason
   * every MAT-1747 member is: an existing test literal must stay valid. Absent
   * means the release defaults are read (HD 1.5 offered; preset voices gated).
   * The paid gateway still re-authorizes the concrete request independently.
   */
  getVideoSeatCapabilities?: () => VideoSeatCapabilities;
  /**
   * MAT-1747. EVERY member below is OPTIONAL, and that is a hard requirement of
   * this interface rather than a style choice: `CommandEveVideoBridgeDeps` has
   * no optional members today and the tests build the full literal, so a new
   * REQUIRED dep breaks fifteen-plus call sites at once. Optional keeps every
   * existing construction of this object valid.
   */
  ensureCapabilityHandle?: typeof ensureVideoEditCapabilityHandle;
  /**
   * THE DISPLAY-GAP FIX. Called once, in Main, AFTER a finished edit is durably
   * on disk — never before it and never on a refusal.
   *
   * Why it lives here and not in either lane: `artifactCapabilityLoopback` (the
   * agent/MCP lane) and the renderer IPC provider both funnel through THIS
   * handler, so one call site is one refresh per edit. Emitting in the lanes
   * instead would mean two places to keep honest and, the day both are used, two
   * refreshes for one clip.
   *
   * Optional like every MAT-1747 member above, for the same stated reason: a
   * required dep would break fifteen-plus existing test literals at once. Absent
   * ⇒ no emission ⇒ byte-identical to the prior behaviour.
   */
  emitArtifactsChanged?: (conversationId: string) => void;
  listArtifactRecords?: typeof listVideoArtifactRecords;
  readCapabilityGrant?: typeof readArtifactCapabilityGrant;
  resolveCapability?: typeof resolveVideoEditCapability;
  /** Reads the source clip at rest, bounded. Returns raw bytes, never a path. */
  readVideoSource?: (filePath: string) => Uint8Array;
  /**
   * The spend-permit half. Injected as a group because a test that could stub
   * one of these and not the others could accidentally prove a lane is safe
   * while the real path is not.
   */
  isVideoEditEnabled?: () => boolean;
  /**
   * Has THIS PROCESS proven the spend store? Round 5, and process-wide: no
   * conversation is named when it is asked, because a live authority that
   * outlived a restart is not a property of any one conversation.
   */
  isSpendStoreHealthy?: typeof isVideoEditSpendStoreHealthy;
  /**
   * Is this conversation RETIRED? Checked by its own read of its own state,
   * never inferred from the permit record — the whole reason the deny exists is
   * that deleting that record is the operation which may have failed.
   */
  isSpendDenied?: typeof isVideoEditSpendDenied;
  evaluateSpendPermit?: typeof evaluateStoredVideoEditSpendPermit;
  /** Reads the permit's own record, for the conversation fence that precedes recovery. */
  readSpendPermitRecord?: typeof readVideoEditSpendPermitRecord;
  readSpendCompletion?: typeof readVideoEditSpendCompletion;
  consumeSpendPermit?: typeof consumeVideoEditSpendPermit;
  recordSpendCompletion?: typeof recordVideoEditSpendCompletion;
  acquireInflightLock?: typeof acquireVideoEditInflightLock;
  releaseInflightLock?: typeof releaseVideoEditInflightLock;
  /**
   * MAT-1773 (F8) — the live video catalog read. Optional for the same reason
   * as the other late additions: every existing deps construction stays valid,
   * and an absent dep simply means "no live catalog" (the picker falls back to
   * the bundled snapshot marked approximate).
   */
  getVideoCatalogWire?: () => Promise<VideoCatalogEntry[] | null>;
}

const productionDeps: CommandEveVideoBridgeDeps = {
  getDataPath,
  fetch: (...args) => fetch(...args),
  newRequestId: () => randomUUID(),
  newArtifactId: () => randomUUID(),
  getActiveSeatId,
  getActiveSeatContextRevision,
  getPaidArtifactBlockReason: getCommandEvePaidArtifactBlockReason,
  areFileSelectionPathsGranted: areCommandEveFileSelectionPathsGranted,
  readImageSource: (filePath: string) => readBoundedImageSource(filePath),
  readManagedImageRecord: readImageArtifactRecordById,
  readManagedImageBytes: readImageArtifactBytes,
  saveVideoFile: saveGeneratedVideoFile,
  saveArtifactRecord: saveVideoArtifactRecord,
  getVideoSeatCapabilities: () => readVideoSeatCapabilities(),
  ensureCapabilityHandle: ensureVideoEditCapabilityHandle,
  emitArtifactsChanged: emitCommandEveArtifactsChanged,
  listArtifactRecords: listVideoArtifactRecords,
  readCapabilityGrant: readArtifactCapabilityGrant,
  resolveCapability: resolveVideoEditCapability,
  readVideoSource: (filePath: string) => readBoundedVideoSource(filePath),
  isVideoEditEnabled: () => isAgentVideoEditAdvertisingEnabled(getDataPath()),
  isSpendStoreHealthy: isVideoEditSpendStoreHealthy,
  isSpendDenied: isVideoEditSpendDenied,
  evaluateSpendPermit: evaluateStoredVideoEditSpendPermit,
  readSpendPermitRecord: readVideoEditSpendPermitRecord,
  readSpendCompletion: readVideoEditSpendCompletion,
  consumeSpendPermit: consumeVideoEditSpendPermit,
  recordSpendCompletion: recordVideoEditSpendCompletion,
  acquireInflightLock: acquireVideoEditInflightLock,
  releaseInflightLock: releaseVideoEditInflightLock,
  getVideoCatalogWire: () => readVideoCatalogWire(getDataPath()),
};

/**
 * Largest source clip we will read and forward.
 *
 * Mirrors the gateway's own `MAX_VIDEO_SOURCE_BASE64_CHARS` — 40,000,000 base64
 * characters, refused with a STRICT `>` in
 * `supabase/functions/eve-multimodal/video-generation-core.ts:383`. Base64 of n
 * bytes is `4 * ceil(n / 3)` characters, so 30,000,000 bytes encodes to exactly
 * 40,000,000 characters: the largest source that still fits, and one byte more
 * overshoots by four characters.
 *
 * It is 30,000,000 and NOT `30 * 1024 * 1024`. The MiB form is 31,457,280 bytes,
 * which encodes to 41,943,040 characters — a 1.39 MiB band of sources that the
 * desktop would accept, read, base64 and upload, only for the gateway to refuse
 * them on arrival. That is precisely the paid round trip this constant exists to
 * prevent, so the two must be derived from the same arithmetic rather than from
 * two plausible-looking spellings of "30 MB".
 *
 * Checking it here means an oversized source is refused before the licence read
 * and before the upload, rather than after we paid to discover it. `lstatSync`
 * first so an enormous file is never loaded into memory at all.
 */
export const MAX_VIDEO_EDIT_SOURCE_BYTES = 30_000_000;

function readBoundedVideoSource(filePath: string): Uint8Array {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('EVE_VIDEO_SOURCE_NOT_A_FILE');
  if (stat.size <= 0 || stat.size > MAX_VIDEO_EDIT_SOURCE_BYTES) throw new Error('EVE_VIDEO_SOURCE_OUT_OF_BOUNDS');
  return new Uint8Array(fs.readFileSync(filePath));
}

/**
 * A generation can legitimately take minutes (the gateway polls xAI), but it must
 * not be able to hang a renderer forever. Slightly above the server's own window
 * so the server's precise reason wins the race against a blunt client timeout.
 */
const VIDEO_REQUEST_TIMEOUT_MS = 200_000;

/** Ceiling on the response we will read — a 1080p/15s clip plus base64 overhead. */
const MAX_VIDEO_RESPONSE_BYTES = 160 * 1024 * 1024;

function videoSeatChangedResult(): CommandEveVideoGenerateResult {
  return {
    ok: false,
    reasonCode: 'video-seat-changed',
    message: 'Der aktive Seed wurde während der Vorbereitung gewechselt. Starte die Videoerstellung erneut.',
    retryable: true,
  };
}

function videoSeatRecoveryRequiredResult(): CommandEveVideoGenerateResult {
  return {
    ok: false,
    reasonCode: 'video-seat-recovery-required',
    message:
      'Der letzte Seed-Wechsel wurde nicht abgeschlossen. Starte Command EVE neu, bevor du erneut ein Video erstellst.',
    retryable: false,
  };
}
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

  const readSeatRevision = deps.getActiveSeatContextRevision ?? (() => 0);
  let capturedSeatId: string;
  let capturedSeatContextRevision: number;
  let originDataPath: string;
  try {
    capturedSeatId = deps.getActiveSeatId();
    capturedSeatContextRevision = readSeatRevision();
    originDataPath = deps.getDataPath();
  } catch {
    return {
      ok: false,
      reasonCode: 'video-seat-unavailable',
      message: 'Der aktive Seed konnte nicht sicher bestimmt werden.',
      retryable: true,
    };
  }
  const seatStillMatches = (): boolean => {
    try {
      return deps.getActiveSeatId() === capturedSeatId && readSeatRevision() === capturedSeatContextRevision;
    } catch {
      return false;
    }
  };
  // THE MODE IS DECIDED ONCE, HERE, AND IT IS DECIDED BY CONSTRUCTION.
  //
  // IPC carries plain JSON, so the renderer's request record has an `imagePath`
  // field AND a `referenceImagePaths` field and nothing about the wire can stop
  // both arriving. This is the boundary at which that stops being possible: from
  // the line below onward the request holds a `VideoRequestMode`, which has no
  // shape that carries two input families, so nothing downstream re-checks it
  // and nothing downstream can get it wrong.
  const capabilities = (deps.getVideoSeatCapabilities ?? readVideoSeatCapabilities)();
  type ImageSource = { kind: 'file'; path: string } | { kind: 'managed'; artifactId: string };
  const fileImageSource = typeof request.imagePath === 'string' ? request.imagePath : null;
  const managedImageSource = typeof request.imageArtifactId === 'string' ? request.imageArtifactId : null;
  if (fileImageSource !== null && managedImageSource !== null) {
    return {
      ok: false,
      reasonCode: 'video-mode-ambiguous',
      message: describeVideoModeRefusal('video-mode-ambiguous'),
      retryable: false,
    };
  }
  const modeResult = buildVideoRequestMode<ImageSource>({
    image:
      managedImageSource !== null
        ? { kind: 'managed', artifactId: managedImageSource }
        : fileImageSource !== null
          ? { kind: 'file', path: fileImageSource }
          : null,
    referenceImages: Array.isArray(request.referenceImagePaths)
      ? request.referenceImagePaths.map((path) => ({ kind: 'file' as const, path }))
      : null,
    presetVoiceIds: Array.isArray(request.presetVoiceIds) ? request.presetVoiceIds : null,
    capabilities,
  });
  if (modeResult.ok === false) {
    return {
      ok: false,
      reasonCode: modeResult.reason,
      message: describeVideoModeRefusal(modeResult.reason),
      retryable: false,
    };
  }
  const pathMode = modeResult.mode;

  // Cheap, local, BEFORE the license/network round trip: a spec this seat and
  // this mode cannot produce is refused here — never silently downgraded and
  // never forwarded to spend a round trip finding out. It asks the same plan
  // resolver the picker asked, so the two cannot disagree. The live catalog is
  // loaded alongside so a catalog model the picker priced is not refused here
  // as unknown; a failed catalog read refuses only NON-legacy models, which is
  // the fail-closed direction (no proven price, no render).
  const catalog = deps.getVideoCatalogWire ? await deps.getVideoCatalogWire().catch((): null => null) : null;
  if (!seatStillMatches()) return videoSeatChangedResult();
  const tierGateRefusal = refuseUnproducibleVideoRequest({
    tierId: request.tierId,
    ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
    modeKind: pathMode.kind,
    capabilities,
    ...(catalog === null ? {} : { catalog }),
    ...(request.resolution === undefined ? {} : { resolutionOverride: request.resolution }),
  });
  if (tierGateRefusal) return tierGateRefusal;

  // Every attached path — the single image->video source and each of the up-to-7
  // reference images — goes through the SAME grant check and the SAME bounded
  // read. Reference images are not a lighter class of attachment: they are user
  // files leaving the machine, so they get the identical boundary rather than a
  // second, more permissive one written next to it.
  const imagePaths =
    pathMode.kind === 'image' && pathMode.image.kind === 'file'
      ? [pathMode.image.path]
      : pathMode.kind === 'reference'
        ? pathMode.referenceImages.flatMap((source) => (source.kind === 'file' ? [source.path] : []))
        : [];
  const assets: VideoAssetPayload[] = [];
  let parentArtifactId: string | undefined;
  if (imagePaths.length > 0) {
    if (!deps.areFileSelectionPathsGranted({ filePaths: imagePaths, seatId: capturedSeatId, purpose: 'read' })) {
      return {
        ok: false,
        reasonCode: 'video-image-not-granted',
        message: 'Für deine Sicherheit: Wähle das Bild erneut aus, bevor daraus ein Video erstellt wird.',
        retryable: false,
      };
    }
    for (const imagePath of imagePaths) {
      try {
        const source = deps.readImageSource(imagePath);
        assets.push({
          base64: Buffer.from(source.bytes).toString('base64'),
          sha256: crypto.createHash('sha256').update(source.bytes).digest('hex'),
        });
      } catch {
        return {
          ok: false,
          reasonCode: 'video-image-unreadable',
          message: 'Das angehängte Bild konnte nicht gelesen werden. Wähle es erneut aus.',
          retryable: false,
        };
      }
    }
  }

  if (pathMode.kind === 'image' && pathMode.image.kind === 'managed') {
    if (!request.conversationId) {
      return {
        ok: false,
        reasonCode: 'video-image-artifact-conversation-required',
        message: 'Das ausgewählte Bild gehört zu keiner aktiven Unterhaltung.',
        retryable: false,
      };
    }
    try {
      const readRecord = deps.readManagedImageRecord ?? readImageArtifactRecordById;
      const readBytes = deps.readManagedImageBytes ?? readImageArtifactBytes;
      const record = readRecord(originDataPath, pathMode.image.artifactId);
      const bytes = readBytes(originDataPath, pathMode.image.artifactId);
      if (
        !record ||
        record.status !== 'active' ||
        record.conversation_id !== request.conversationId ||
        !bytes ||
        bytes.byteLength === 0
      ) {
        throw new Error('EVE_VIDEO_IMAGE_ARTIFACT_UNAVAILABLE');
      }
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== record.payload.sha256) throw new Error('EVE_VIDEO_IMAGE_ARTIFACT_CHANGED');
      assets.push({ base64: bytes.toString('base64'), sha256 });
      parentArtifactId = record.id;
    } catch {
      return {
        ok: false,
        reasonCode: 'video-image-artifact-unavailable',
        message: 'Das ausgewählte Bild ist nicht mehr verfügbar. Wähle es im Artefaktbereich erneut aus.',
        retryable: false,
      };
    }
  }

  // Only after every local source has been re-authorized, loaded and hashed do
  // we touch the account wire. A stale/cross-conversation managed artifact is a
  // local refusal and must neither draw credentials nor approach a paid lane.
  const wireResult = readLicenseWire(originDataPath);
  if (!wireResult.ok || !wireResult.wire) {
    return {
      ok: false,
      reasonCode: 'entitlement-not-drawable',
      message: 'Für Videos wird ein aktives Command-EVE-Konto benötigt.',
      retryable: false,
    };
  }

  // The mode is re-expressed over the BYTES, never rebuilt from the loose fields:
  // the branch is carried across, so the exclusivity decided above is the
  // exclusivity that reaches the wire.
  const wireMode: VideoRequestMode<VideoAssetPayload> =
    pathMode.kind === 'image'
      ? { kind: 'image', image: assets[0]! }
      : pathMode.kind === 'reference'
        ? { kind: 'reference', referenceImages: assets, presetVoiceIds: pathMode.presetVoiceIds }
        : { kind: 'text' };

  const body = {
    ...buildVideoGenerationBody({
      prompt: request.prompt.trim(),
      tierId: request.tierId,
      ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
      ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      durationSeconds: request.durationSeconds,
      mode: wireMode,
      requestId: deps.newRequestId(),
    }),
    ...commandEveMediaSeedAttribution(capturedSeatId),
  };

  if (!seatStillMatches()) return videoSeatChangedResult();

  const paidArtifactBlockReason = (deps.getPaidArtifactBlockReason ?? getCommandEvePaidArtifactBlockReason)();
  if (paidArtifactBlockReason === 'seat_recovery_required') return videoSeatRecoveryRequiredResult();
  if (paidArtifactBlockReason === 'seat_transition_in_progress') return videoSeatChangedResult();
  const releasePaidArtifactOperation = tryBeginCommandEvePaidArtifactOperation();
  if (!releasePaidArtifactOperation) return videoSeatChangedResult();
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
        ...(parentArtifactId === undefined ? {} : { parentArtifactId }),
      });
      deps.saveArtifactRecord(originDataPath, conversationArtifact);
      // Its OWN try/catch, deliberately. The enclosing catch collapses every
      // throw into `video-artifact-save-failed`, so a handle-minting failure
      // inside it would report that a successfully saved video was not saved —
      // the exact lie this reason code was written to avoid. A missing handle
      // only means "not editable yet"; the next envelope re-mints it.
      try {
        deps.ensureCapabilityHandle?.(originDataPath, conversationArtifact);
      } catch {
        /* the clip is saved and playable; only the edit affordance is deferred */
      }
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
    releasePaidArtifactOperation();
  }
}

/**
 * IPC-facing envelope for the raw video outcome.
 *
 * `@office-ai/platform` forwards provider return values verbatim. The renderer's
 * bridge contract expects `{ success, data }`, so registering the raw handler
 * directly makes every refusal — and even a saved success — look like an empty
 * transport failure. Keep the raw handler independently testable and wrap only
 * at the IPC boundary.
 */
export async function handleCommandEveVideoGenerateBridge(
  request?: CommandEveVideoGenerateRequest,
  deps: CommandEveVideoBridgeDeps = productionDeps
): Promise<{ success: true; data: CommandEveVideoGenerateResult }> {
  return { success: true, data: await handleCommandEveVideoGenerate(request, deps) };
}

export interface CommandEveVideoArtifactsListDeps {
  getDataPath: typeof getDataPath;
  listArtifactRecords: typeof listVideoArtifactRecords;
  /**
   * MAT-1773 (Package B): run the remote-video hydration reconcile before the
   * list is served, so a clip the agent lane only ever had as a CDN URL is
   * downloaded to the durable store at load time. Optional + best-effort: a
   * failed hydrate never blocks the list.
   */
  hydrateBeforeList?: (conversationId: string) => Promise<unknown>;
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
  if (deps.hydrateBeforeList) {
    try {
      await deps.hydrateBeforeList(request.conversationId);
    } catch {
      // Best-effort: a failed download must never block the artifact list.
    }
  }
  return deps.listArtifactRecords(deps.getDataPath(), request.conversationId);
}

/** IPC-facing envelope matching `ipcBridge.commandEve.videoArtifactsList`. */
export async function handleCommandEveVideoArtifactsListBridge(
  request?: { conversationId?: string },
  deps: CommandEveVideoArtifactsListDeps = productionListDeps
): Promise<{ success: true; data: CommandEveVideoConversationArtifact[] }> {
  return { success: true, data: await handleCommandEveVideoArtifactsList(request, deps) };
}

// ---------------------------------------------------------------------------
// MAT-1747 — the context envelope every real turn carries
// ---------------------------------------------------------------------------

export interface CommandEveArtifactContextEnvelopeDeps {
  getDataPath: typeof getDataPath;
  buildEntries: typeof buildConversationArtifactEnvelopeEntries;
  /** Mints THE spend permit for this turn. Optional so existing literals still typecheck. */
  issuePermit?: typeof issueVideoEditSpendPermit;
  /**
   * Notes which turn this conversation is on, on every send that comes THROUGH
   * THIS HANDLER — whether or not that send mints anything. Redeem compares
   * against this, so it has to move independently of minting or the comparison
   * is circular.
   *
   * NOT "every real send": a user STEER is a real send and never reaches this
   * function. It moves the same pointer through the store's own call in
   * `handleCommandEveArtifactTurnSteer` (`videoEditSpendPermitStore.ts:705`),
   * which is a different call site and not this dep. The scope correction at the
   * `recordActiveTurn` call below applies verbatim here; this sentence was the
   * copy of the old overclaim that the correction there did not reach.
   *
   * The two call sites also hash DIFFERENT bytes, and that is intended: this one
   * hashes the raw ordinary turn, the steer one hashes the text as delivered to
   * the runtime. Only the first of the two ever mints.
   */
  recordActiveTurn?: typeof recordActiveUserTurn;
  /** Retires the conversation when turn state could not be established. */
  denySpend?: typeof denyVideoEditSpend;
  /**
   * Whether the PAID path is advertised for this seat. Default-ON for an
   * eligible seat since 1.820.2 (licence wire readable), with `'0'` as the
   * kill-switch — see `agentVideoEditFlag.ts`.
   */
  isVideoEditEnabled?: () => boolean;
  /**
   * MAT-1753. Turns the reference images pending on the DRAFT into envelope
   * entries. Grant-verified and hashed here, in Main, exactly as the render path
   * does — the renderer supplies paths and never bytes, and no path reaches the
   * envelope.
   */
  getActiveSeatId?: typeof getActiveSeatId;
  areFileSelectionPathsGranted?: typeof areCommandEveFileSelectionPathsGranted;
  readImageSource?: (filePath: string) => { bytes: Uint8Array };
  /**
   * MAT-1769 (requirement 9). The durable SENT-IMAGE registry: records of
   * images attached to earlier turns, re-listed as kind=image entries so a
   * follow-up resolves the latest visible image without reattachment.
   */
  listImageRecords?: typeof listImageArtifactRecords;
  saveImageRecord?: typeof saveImageArtifactRecord;
  /**
   * 1.820.3 — the MANAGED GENERATED image store: active records ride the
   * envelope as EDITABLE kind=image entries with an `evecap_` handle, minted
   * through the same one-handle-per-(conversation, artifact, bytes) rule as
   * the video lane.
   */
  listManagedImageRecords?: typeof listActiveImageArtifacts;
  ensureImageEditHandle?: typeof ensureImageEditCapabilityHandle;
  /**
   * Whether the paid IMAGE edit is advertised for this seat. One resolver
   * (`agentImageEditFlag.ts`), same posture as the video flag.
   */
  isImageEditEnabled?: () => boolean;
}

const productionEnvelopeDeps: CommandEveArtifactContextEnvelopeDeps = {
  getDataPath,
  buildEntries: buildConversationArtifactEnvelopeEntries,
  issuePermit: issueVideoEditSpendPermit,
  recordActiveTurn: recordActiveUserTurn,
  denySpend: denyVideoEditSpend,
  isVideoEditEnabled: () => isAgentVideoEditAdvertisingEnabled(getDataPath()),
  getActiveSeatId,
  areFileSelectionPathsGranted: areCommandEveFileSelectionPathsGranted,
  readImageSource: (filePath: string) => readBoundedImageSource(filePath),
  listImageRecords: listImageArtifactRecords,
  saveImageRecord: saveImageArtifactRecord,
  listManagedImageRecords: listActiveImageArtifacts,
  ensureImageEditHandle: ensureImageEditCapabilityHandle,
  isImageEditEnabled: () => isAgentImageEditAdvertisingEnabled(getDataPath()),
};

/**
 * At most this many sent-image records ride one envelope. The per-turn visual
 * source limit is six, so the newest six images always cover "the image the
 * user is talking about" — and a long conversation of attachments cannot
 * starve the video clips out of the shared entry budget.
 */
const IMAGE_ARTIFACT_ENVELOPE_MAX_ENTRIES = 6;

export interface CommandEveArtifactContextEnvelopeRequest {
  conversationId?: string;
  selectedArtifactIds?: string[];
  /**
   * The reference images pending on the DRAFT (MAT-1753 item C).
   *
   * PATHS, and they stop here: Main grant-verifies and hashes them, and what
   * reaches the envelope is an ordinal id plus a mime type. The envelope's
   * no-path rule is absolute and this does not bend it — a path in a transcript
   * is a path the model can quote back and a filename shipped to a third party.
   */
  referenceImagePaths?: string[];
  /**
   * The RAW text of the ORDINARY TURN the user is sending — the exact bytes,
   * verbatim.
   *
   * Hashed as received. Nothing trims it, folds its case, normalises its line
   * endings or touches its Unicode before the digest, because the digest is what
   * every binding downstream compares: a normalising step here would silently
   * merge two different requests into one authority, which is precisely the
   * defect this round fixes.
   *
   * SCOPE, because a blanket "raw bytes everywhere" claim is false: this is the
   * MINT path, and the raw-byte rule is this path's rule. The retirement path
   * (`CommandEveArtifactTurnSteerRequest.steerText`) binds the bytes the runtime
   * was actually given instead, and mints nothing.
   *
   * What it does NOT prove is that a human pressed send — that would need an
   * active-turn observation the pinned AionCore does not expose to Main. It
   * proves that whatever reached the mint path named THESE bytes, and it is that
   * name the permit is bound to.
   *
   * Hashed immediately; never stored, logged or forwarded.
   */
  userTurnText?: string;
  /**
   * 1.820.3 (CoS fail-closed gate) — the ONE spend operation this turn may
   * carry, resolved by the RENDERER through `resolveEditAuthorization`
   * (mutation semantics + canonical source truth) and passed explicitly.
   *
   * Main VALIDATES it: exactly `'video_edit'` or `'image_edit'`, anything else
   * is treated as absent. And ABSENT MEANS NO PERMIT — no legacy `video_edit`
   * default, no derivation from which artifact kinds happen to exist. A turn
   * whose edit intent the app could not resolve carries no spending credential
   * at all; the model choosing a medium is precisely what this field removes.
   */
  requestedEditOperation?: string;
}

/**
 * The sanitized artifact envelope for one conversation, or `''`.
 *
 * `''` matters as much as the content: a conversation with no artifacts adds
 * nothing to the turn, so this feature costs exactly zero tokens until it has
 * something true to contribute. There is no hidden turn and no announcement —
 * the envelope rides the message the user was already sending.
 *
 * This is also the ONLY place a spend permit is minted, and only when four
 * things are simultaneously true: the paid path is enabled, the request carried
 * turn text, that turn's pointer is provably on disk, and there is at least one
 * editable clip to spend it on. Anything less and the envelope carries no
 * spending credential at all. (It is reachable
 * only over IPC from the renderer — the model's loopback exposes no mint
 * operation — but Main cannot itself observe that a person pressed send, so
 * that is a property of the exposed surface, not a check made here.)
 */
export async function handleCommandEveArtifactContextEnvelope(
  request?: CommandEveArtifactContextEnvelopeRequest,
  deps: CommandEveArtifactContextEnvelopeDeps = productionEnvelopeDeps
): Promise<{ envelope: string }> {
  const conversationId = request?.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length === 0) return { envelope: '' };
  try {
    const dataPath = deps.getDataPath();
    // POLICY F: advertise the paid capability only when the paid path is really
    // enabled. The previous build advertised `eve_video_edit` whenever anything
    // was editable — including while the spending flag was off — which put an
    // offer we would refuse into every transcript. Since 1.820.2 "really
    // enabled" is ONE resolver decision (`agentVideoEditFlag.ts`): an eligible
    // seat (licence wire readable) advertises by default, `'0'` kill-switches
    // it, and no wire fails closed.
    const paidEnabled = (deps.isVideoEditEnabled ?? (() => isAgentVideoEditAdvertisingEnabled(dataPath)))();
    // The image half of the same question, resolved HERE (not later) because
    // the turn pointer below must move on every send while EITHER paid path is
    // open — an image permit judged against a pointer only the video lane
    // moved would refuse its own turn.
    const imagePaidEnabled = (deps.isImageEditEnabled ?? (() => isAgentImageEditAdvertisingEnabled(dataPath)))();

    // THE RAW BYTES. Read once, never reassigned, never normalised. `rawUserTurn`
    // is the only thing that reaches the digest; `userTurnPresent` is a separate
    // predicate that judges it without producing a second, different value that
    // could be hashed by mistake. Round 1 wrote `request.userTurnText.trim()`
    // into one variable and used it for both jobs, which made two distinct turns
    // — one with a trailing space, one without — into the same authority.
    const rawUserTurn = typeof request?.userTurnText === 'string' ? request.userTurnText : '';
    const userTurnPresent = hasVisibleCharacters(rawUserTurn);
    const userTurnSha256 = userTurnPresent ? crypto.createHash('sha256').update(rawUserTurn).digest('hex') : '';

    // The turn pointer moves on every send that comes THROUGH HERE while the
    // paid path is open, before anything is minted and regardless of whether
    // anything is. That is what lets redeem ask "is this permit's turn still the
    // current turn?" and get an answer that was not written by the mint it is
    // judging.
    //
    // BE EXACT ABOUT THE SCOPE, because the earlier version of this comment said
    // "every real send" and an independent audit was right that this is not that
    // place. A user STEER is a real send, the agent reads it, and it never
    // reaches this function — it is an HTTP call straight to the runtime. The
    // other half of the pointer therefore lives in
    // `handleCommandEveArtifactTurnSteer`, which retires the permit outright
    // rather than minting a new one. Between the two, the claim "a live permit
    // does not survive the user saying something else" is enforced; neither one
    // alone enforces it.
    //
    // ROUND 4: the pointer write now REPORTS. A write that did not land used to
    // be swallowed here, which left the redeem check comparing against whatever
    // stale turn was on disk. If it fails we deny the conversation and mint
    // nothing — a send that could not establish its own turn state has no
    // business handing out authority bound to that turn.
    let turnStateEstablished = false;
    if ((paidEnabled || imagePaidEnabled) && userTurnPresent) {
      try {
        turnStateEstablished =
          (deps.recordActiveTurn ?? recordActiveUserTurn)(dataPath, conversationId, userTurnSha256) === true;
      } catch {
        turnStateEstablished = false;
      }
      if (!turnStateEstablished) (deps.denySpend ?? denyVideoEditSpend)(dataPath, conversationId);
    }

    const selectedArtifactIds = Array.isArray(request?.selectedArtifactIds)
      ? request.selectedArtifactIds
          .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256)
          .slice(0, ARTIFACT_ENVELOPE_MAX_ARTIFACTS)
      : [];
    const selectedArtifactIdSet = new Set(selectedArtifactIds);
    const storedEntries = deps.buildEntries(
      dataPath,
      conversationId,
      selectedArtifactIds.length === 0 ? {} : { selectedArtifactIds }
    );
    // MAT-1753 item C. The reference images pending on the draft ride the SAME
    // envelope, ahead of the stored clips, because they are what the user is
    // looking at right now. Their PATHS never leave this function: what the model
    // sees is an ordinal id, and the SHA-256 travels only in the non-rendered
    // field the spend permit binds.
    const referenceEntries = buildReferenceImageEnvelopeEntries(request?.referenceImagePaths, deps);
    // MAT-1769 (requirement 9). The images attached to EARLIER turns ride the
    // same envelope, between the pending references and the stored clips:
    // newer than the clips the user saw before them, older than the files
    // still on the draft. Read-only entries — no handle, no capability, and
    // deliberately NOT part of the spend-permit binding below.
    const imageEntries = buildStoredImageEnvelopeEntries(dataPath, conversationId, selectedArtifactIdSet, deps);
    // 1.820.3 — the MANAGED GENERATED images. EDITABLE kind=image entries with
    // an `evecap_` handle, between the read-only sent images and the clips.
    const managedImageEntries = buildManagedImageEnvelopeEntries(dataPath, conversationId, selectedArtifactIdSet, deps);
    const entries = [...referenceEntries, ...imageEntries, ...managedImageEntries, ...storedEntries];
    // And THIS turn's attached images become next turns' durable records. The
    // write happens after the listing so the current envelope never shows the
    // same image twice (once pending, once stored), and first-write-wins makes
    // a restored or retried send idempotent. A failed send leaves a record for
    // an image that is still on the user's draft — which is exactly the image
    // the user is looking at, so the reference stays truthful.
    recordSentImageArtifacts(dataPath, conversationId, request?.referenceImagePaths, referenceEntries, deps);
    const editableVideos = entries.filter((entry) => entry.editable && entry.kind === 'video');
    const editableImages = managedImageEntries.filter((entry) => entry.editable);
    // Clicking "edit this" is a hard target boundary, not a hint. When an
    // explicit selection was supplied, a permit may cover only matching,
    // editable selected entries. An unknown, stale or wrong-medium id therefore
    // mints nothing instead of falling back to the newest artifact. The legacy
    // no-selection path remains bounded to the visible editable set.
    const permitVideos =
      selectedArtifactIds.length === 0 ? editableVideos : editableVideos.filter((entry) => entry.selected === true);
    const permitImages =
      selectedArtifactIds.length === 0 ? editableImages : editableImages.filter((entry) => entry.selected === true);
    // POLICY F per medium: a capability is advertised only when the paid path
    // is really enabled AND there is something editable to spend it on. The
    // two media are advertised INDEPENDENTLY — kill-switching one never
    // darkens the other.
    const allowedCapabilities = [
      ...(paidEnabled && editableVideos.length > 0 ? ['eve_video_edit'] : []),
      ...(imagePaidEnabled && editableImages.length > 0 ? ['eve_image_edit'] : []),
    ];

    // 1.820.3 CoS FAIL-CLOSED GATE — the turn's ONE permit is minted ONLY for
    // the operation the renderer's authorization resolver named, and ONLY when
    // that operation is enabled here and has editable artifacts to bind. An
    // absent or unrecognised `requestedEditOperation` mints NOTHING: no legacy
    // `video_edit` default, no derivation from artifact kinds. The model never
    // picks the medium a permit covers; the app decided before the model call.
    const requestedEditOperation =
      request?.requestedEditOperation === 'video_edit' || request?.requestedEditOperation === 'image_edit'
        ? request.requestedEditOperation
        : undefined;

    let spendPermit: string | undefined;
    if (requestedEditOperation !== undefined && userTurnPresent && turnStateEstablished) {
      const issue = deps.issuePermit ?? issueVideoEditSpendPermit;
      // `undefined` here is an ordinary outcome, and one of its causes is POLICY
      // C: a turn that already bought its edit gets no second permit, however
      // many times this path is driven for it. Another is that the mint itself
      // hit a storage failure — in which case it has already denied the
      // conversation on its way out.
      if (requestedEditOperation === 'video_edit' && paidEnabled && permitVideos.length > 0) {
        spendPermit = issue(dataPath, {
          conversationId,
          userTurnSha256,
          operation: 'video_edit',
          // MAT-1753 item F. Reference images ride the SAME single-use, byte-bound
          // permit as the editable clips — one permit per turn, one store, one TTL,
          // one turn binding. There is deliberately no second spend authority for
          // reference work and no second popup: a new mechanism is exactly what
          // "no second spend authority" forbids.
          //
          // WHAT THESE REFERENCE DIGESTS DO **NOT** DO, said plainly rather than
          // left to be assumed from the word "bound": they are NOT re-verified at
          // redeem time, because the path that consumes reference images —
          // `handleCommandEveVideoGenerate` — takes no permit and redeems none. The
          // only enforced binding is on the EDIT path, where
          // `evaluateStoredVideoEditSpendPermit` / `consumeVideoEditSpendPermit`
          // check ONE `observedArtifactSha256` (the clip being edited) against this
          // list. So a reference digest here is a RECORD of what the turn asked
          // for, not a gate on what the render may use.
          //
          // That is a deliberate, stated limitation and not an oversight to be
          // closed by widening this comment: binding on the redeem side would mean
          // threading a permit through the generate IPC and refusing renders
          // without one, which is a spend-authority change, not a comment fix.
          // `videoReferenceEnvelope.test.ts` pins BOTH halves — the mint-side
          // contents AND the absence of a redeem — so whoever adds one has to come
          // past a red test and correct this paragraph.
          allowedArtifactSha256: [...referenceEntries, ...permitVideos]
            .map((entry) => entry.artifactSha256)
            .filter((sha): sha is string => typeof sha === 'string'),
        });
      } else if (requestedEditOperation === 'image_edit' && imagePaidEnabled && permitImages.length > 0) {
        // The image half, bound by the same store, TTL and turn digest — but
        // operation `image_edit`, so a video permit can never buy an image edit
        // and this permit can never buy a video one.
        spendPermit = issue(dataPath, {
          conversationId,
          userTurnSha256,
          operation: 'image_edit',
          allowedArtifactSha256: permitImages
            .map((entry) => entry.artifactSha256)
            .filter((sha): sha is string => typeof sha === 'string'),
        });
      }
    }

    return {
      envelope: buildEveArtifactContextEnvelope({
        entries,
        allowedCapabilities,
        ...(spendPermit === undefined ? {} : { spendPermit }),
      }),
    };
  } catch {
    // A turn must never fail because the envelope could not be built. Sending
    // the user's message without the registry is a smaller loss than not
    // sending it at all.
    return { envelope: '' };
  }
}

// ---------------------------------------------------------------------------
// MAT-1747 — a STEER is a real user turn too
// ---------------------------------------------------------------------------

export interface CommandEveArtifactTurnSteerDeps {
  getDataPath: typeof getDataPath;
  revokeOnSteer?: typeof revokeVideoEditSpendOnUserSteer;
  /** The fallback when the retirement above could not be carried out at all. */
  denySpend?: typeof denyVideoEditSpend;
}

const productionSteerDeps: CommandEveArtifactTurnSteerDeps = {
  getDataPath,
  revokeOnSteer: revokeVideoEditSpendOnUserSteer,
  denySpend: denyVideoEditSpend,
};

export interface CommandEveArtifactTurnSteerRequest {
  conversationId?: string;
  /**
   * The correction text AS DELIVERED TO THE RUNTIME. Hashed as received — this
   * handler and the store below apply no trim, no case fold and no
   * normalisation of their own.
   *
   * NOT the user's raw keystrokes, and an earlier version of this line said
   * "RAW ... verbatim", which was false for the only caller there is:
   * `AcpSendBox.dispatchSteer` passes the same `normalizedInput` string it posts
   * to `/api/conversations/<id>/steer`, and that string is `input.trim()`. So
   * the pointer this moves binds what the AGENT was given. That is the right
   * binding for a RETIREMENT — nothing is minted on this path — and it is
   * deliberately a different rule from the mint path's raw-turn binding.
   */
  steerText?: string;
}

/**
 * Retire this conversation's spend authority because the person said something
 * new while the model was still working.
 *
 * A steer never builds a context envelope — it is an HTTP call straight to the
 * runtime — so nothing on that path could move the turn pointer or retire a
 * permit. Without this handler a permit minted for the previous turn survived
 * the correction, and the guarantee written on the box was wider than the code.
 *
 * It grants NOTHING. There is no mint here and there is deliberately no way to
 * reach one from a steer, so the only direction this can move a seat is closed.
 *
 * ROUND 4 — WHAT HAPPENS WHEN THE RETIREMENT ITSELF FAILS.
 *
 * Round 3 answered "nothing", and wrote the cost down as a permit that outlives
 * one steer. That is fail-open on spend authority, and it is the defect this
 * handler now closes. The rule is split rather than traded:
 *
 *   the CORRECTION still goes through — this never throws, so the renderer's
 *   `await` always continues on to post the steer. A user fixing a running model
 *   is not refused because a local file operation failed;
 *
 *   the PAID EDIT AUTHORITY fails closed — every path out of here that reached a
 *   permit store at all denies the conversation, whether the revoke worked or
 *   threw, and the edit handler checks that deny by its own read before it
 *   fetches or debits anything. The two paths that do NOT deny are the two where
 *   no permit can exist to begin with: a request that named no conversation, and
 *   a seat whose permit directory has never been created.
 *
 * The returned `denied` is a report, not the enforcement: nothing downstream
 * consults it. The enforcement is the state written into the store.
 */
export async function handleCommandEveArtifactTurnSteer(
  request?: CommandEveArtifactTurnSteerRequest,
  deps: CommandEveArtifactTurnSteerDeps = productionSteerDeps
): Promise<{ revoked: number; denied: boolean }> {
  const conversationId = request?.conversationId;
  // Nothing named, nothing to retire — and nothing that could be spent under a
  // name we were not given.
  if (typeof conversationId !== 'string' || conversationId.length === 0) return { revoked: 0, denied: false };
  const deny = deps.denySpend ?? denyVideoEditSpend;
  let dataPath: string;
  try {
    dataPath = deps.getDataPath();
  } catch {
    // We cannot even name the store, so there is nowhere to write a durable
    // marker. The process-scoped deny is the whole answer here, with the
    // restart residual that implies.
    return { revoked: 0, denied: deny(undefined, conversationId) !== 'none' };
  }
  try {
    const revoke = deps.revokeOnSteer ?? revokeVideoEditSpendOnUserSteer;
    const steerText = typeof request?.steerText === 'string' ? request.steerText : '';
    const retirement = revoke(dataPath, conversationId, steerText);
    return { revoked: retirement.revoked, denied: retirement.denied };
  } catch {
    // Anything that escaped the store's own handling. The correction is still
    // unaffected; the conversation loses its paid-edit authority until the next
    // successful ordinary send.
    return { revoked: 0, denied: deny(dataPath, conversationId) !== 'none' };
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.artifactTurnSteer`. */
export async function handleCommandEveArtifactTurnSteerBridge(
  request?: CommandEveArtifactTurnSteerRequest,
  deps: CommandEveArtifactTurnSteerDeps = productionSteerDeps
): Promise<{ success: true; data: { revoked: number; denied: boolean } }> {
  return { success: true, data: await handleCommandEveArtifactTurnSteer(request, deps) };
}

/**
 * Turn the draft's pending reference images into envelope entries.
 *
 * THREE rules, and each one is a boundary rather than a nicety:
 *
 *   - the paths are GRANT-VERIFIED, once, as a set — the same check and the same
 *     bounded read the render path uses. A reference image is not a lighter class
 *     of file because it happens to be describing something;
 *   - NO PATH is emitted. The model sees `reference_image_1`, `reference_image_2`
 *     …, in the order the user attached them, so "the second one" resolves;
 *   - anything unreadable or ungranted yields NO entries at all rather than a
 *     partial list. A short list would tell the model the user attached fewer
 *     images than they did, which is worse than telling it nothing.
 */
function buildReferenceImageEnvelopeEntries(
  paths: readonly string[] | undefined,
  deps: CommandEveArtifactContextEnvelopeDeps
): EveArtifactEnvelopeEntry[] {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  if (paths.length > MAX_VIDEO_REFERENCE_IMAGES) return [];
  const granted = deps.areFileSelectionPathsGranted;
  const readImage = deps.readImageSource;
  const seat = deps.getActiveSeatId;
  if (!granted || !readImage || !seat) return [];
  try {
    if (!granted({ filePaths: [...paths], seatId: seat(), purpose: 'read' })) return [];
    return paths.map((filePath, index) => ({
      artifactId: `reference_image_${index + 1}`,
      kind: 'reference_image' as const,
      mimeType: 'image/*',
      durationSeconds: 0,
      // A pending input is never editable: there is nothing produced to edit, so
      // no handle is minted and none is rendered.
      editable: false,
      artifactSha256: crypto.createHash('sha256').update(readImage(filePath).bytes).digest('hex'),
      selected: true,
    }));
  } catch {
    return [];
  }
}

/**
 * MAT-1769 (requirement 9) — the durable sent-image records as envelope entries.
 *
 * Read-only by construction: `editable` is false, no handle is minted, and the
 * record's content hash travels only in the non-rendered field, exactly like
 * the reference entries. Newest first and capped, so "das Bild" resolves to
 * the image the user most recently sent and a long attachment history cannot
 * crowd the clips out of the envelope.
 */
function buildStoredImageEnvelopeEntries(
  dataPath: string,
  conversationId: string,
  selectedArtifactIds: ReadonlySet<string>,
  deps: CommandEveArtifactContextEnvelopeDeps
): EveArtifactEnvelopeEntry[] {
  const list = deps.listImageRecords;
  if (!list) return [];
  try {
    const ordered = list(dataPath, conversationId).toSorted((a, b) => b.created_at - a.created_at);
    const selected = ordered.filter((record) => selectedArtifactIds.has(record.id));
    const remaining = ordered.filter((record) => !selectedArtifactIds.has(record.id));
    return [...selected, ...remaining].slice(0, IMAGE_ARTIFACT_ENVELOPE_MAX_ENTRIES).map((record) => {
      const entry: EveArtifactEnvelopeEntry = {
        artifactId: record.id,
        kind: 'image',
        mimeType: record.mimeType,
        durationSeconds: 0,
        editable: false,
        artifactSha256: record.sha256,
      };
      if (selectedArtifactIds.has(record.id)) entry.selected = true;
      return entry;
    });
  } catch {
    return [];
  }
}

/**
 * 1.820.3 — the MANAGED GENERATED images as envelope entries.
 *
 * The editable counterpart of the read-only sent-image entries above: every
 * ACTIVE record in the managed image store rides newest-first, and each one
 * gets its durable `evecap_` edit handle through the same
 * one-handle-per-(conversation, artifact, bytes) rule the video lane uses.
 * A record whose handle cannot be minted is still listed — visible but not
 * editable — and the envelope says so by omitting the handle, never by
 * inventing one. STAGED records are absent by construction: the store only
 * lists active ones, because an unbound image has no conversation to ride.
 */
function buildManagedImageEnvelopeEntries(
  dataPath: string,
  conversationId: string,
  selectedArtifactIds: ReadonlySet<string>,
  deps: CommandEveArtifactContextEnvelopeDeps
): EveArtifactEnvelopeEntry[] {
  const list = deps.listManagedImageRecords;
  if (!list) return [];
  const nowMs = Date.now();
  try {
    const ordered = list(dataPath, conversationId).toSorted((a, b) => b.created_at - a.created_at);
    const selected = ordered.filter((record) => selectedArtifactIds.has(record.id));
    const remaining = ordered.filter((record) => !selectedArtifactIds.has(record.id));
    return [...selected, ...remaining].slice(0, IMAGE_ARTIFACT_ENVELOPE_MAX_ENTRIES).map((record) => {
      let editHandle: string | undefined;
      try {
        editHandle = (deps.ensureImageEditHandle ?? ensureImageEditCapabilityHandle)(
          dataPath,
          {
            conversation_id: record.conversation_id,
            artifact_id: record.id,
            artifact_sha256: record.payload.sha256,
          },
          { nowMs }
        );
      } catch {
        editHandle = undefined;
      }
      const entry: EveArtifactEnvelopeEntry = {
        artifactId: record.id,
        kind: 'image',
        mimeType: record.payload.mime_type,
        durationSeconds: 0,
        // A handle is minted ONLY for an editable image, so the envelope can
        // never name an image the edit lane would refuse.
        editable: Boolean(editHandle),
        artifactSha256: record.payload.sha256,
      };
      if (editHandle !== undefined) entry.editHandle = editHandle;
      if (record.payload.parent_artifact_id !== undefined) entry.parentArtifactId = record.payload.parent_artifact_id;
      if (selectedArtifactIds.has(record.id)) entry.selected = true;
      return entry;
    });
  } catch {
    return [];
  }
}

/**
 * Persist this turn's reference images as next turns' sent-image records.
 *
 * The paths were already grant-verified and the bytes already hashed by
 * `buildReferenceImageEnvelopeEntries` — this reuses BOTH results and touches
 * no file again. Dedupe is by content hash against the records already on
 * disk, so attaching the same image twice across turns yields one registry
 * entry, and a record only ever claims what was actually attached to a send.
 */
function recordSentImageArtifacts(
  dataPath: string,
  conversationId: string,
  paths: readonly string[] | undefined,
  referenceEntries: readonly EveArtifactEnvelopeEntry[],
  deps: CommandEveArtifactContextEnvelopeDeps
): void {
  const save = deps.saveImageRecord;
  if (!save || !Array.isArray(paths) || paths.length === 0) return;
  if (referenceEntries.length !== paths.length) return;
  let known: Set<string>;
  try {
    known = new Set((deps.listImageRecords?.(dataPath, conversationId) ?? []).map((record) => record.sha256));
  } catch {
    known = new Set();
  }
  paths.forEach((filePath, index) => {
    const sha256 = referenceEntries[index]?.artifactSha256;
    if (!sha256 || known.has(sha256)) return;
    try {
      save(dataPath, {
        id: imageArtifactIdForSha256(sha256),
        conversation_id: conversationId,
        sha256,
        mimeType: imageMimeTypeFromPath(filePath),
        created_at: Date.now(),
      });
      known.add(sha256);
    } catch {
      // A record that could not be written costs the NEXT envelope one entry,
      // never this send — the reference entries above already name the image.
    }
  });
}

/**
 * MAT-1753 — what this seat's video lane may actually offer.
 *
 * The renderer must never answer this for itself. A picker that decides its own
 * capabilities is a picker that can promise a render nobody is entitled to, and
 * the refusal then arrives after the wait instead of before the click. Main reads
 * the release-aligned flags and the renderer displays the answer; the gateway
 * decides again on every request, because a client-side capability is a display,
 * never a grant.
 */
export async function handleCommandEveVideoCapabilitiesBridge(
  _request?: unknown,
  deps: CommandEveVideoBridgeDeps = productionDeps
): Promise<{
  success: true;
  data: VideoSeatCapabilities & {
    /** The live OpenRouter video catalog, or null when the read failed (F8). */
    catalog: VideoCatalogEntry[] | null;
    catalog_source: 'live' | 'none';
  };
}> {
  const capabilities = (deps.getVideoSeatCapabilities ?? readVideoSeatCapabilities)();
  // The catalog read is best-effort and self-quiet: a failed read yields
  // `none`, and the renderer falls back to the bundled snapshot marked
  // approximate. It must never delay or break the capability answer itself.
  const catalog = deps.getVideoCatalogWire ? await deps.getVideoCatalogWire().catch((): null => null) : null;
  return {
    success: true,
    data: {
      hd15Available: capabilities.hd15Available === true,
      presetVoicesAvailable: capabilities.presetVoicesAvailable === true,
      catalog,
      catalog_source: catalog !== null && catalog.length > 0 ? 'live' : 'none',
    },
  };
}

/** IPC-facing envelope matching `ipcBridge.commandEve.artifactContextEnvelope`. */
export async function handleCommandEveArtifactContextEnvelopeBridge(
  request?: CommandEveArtifactContextEnvelopeRequest,
  deps: CommandEveArtifactContextEnvelopeDeps = productionEnvelopeDeps
): Promise<{ success: true; data: { envelope: string } }> {
  return { success: true, data: await handleCommandEveArtifactContextEnvelope(request, deps) };
}

// ---------------------------------------------------------------------------
// MAT-1747 — the edit itself
// ---------------------------------------------------------------------------

export type { CommandEveVideoEditRequest };

function refuseEdit(reasonCode: string, message: string, retryable = false): CommandEveVideoEditResult {
  return { ok: false, reasonCode, message, retryable };
}

/**
 * Rebuild a success result from a record we already saved.
 *
 * Used only on the idempotent-retry path. `dataBase64` is empty because the
 * bytes are on disk and re-encoding them would be pure waste — the renderer
 * resolves the artifact by path, and the model never receives either.
 */
function recoveredEditResult(
  artifact: CommandEveVideoConversationArtifact,
  sourceArtifactId: string
): CommandEveVideoEditResult {
  const payload = hydrateVideoArtifactPayload(artifact.payload);
  const tierId = resolveVideoArtifactTier(payload);
  return {
    ok: true,
    artifact: {
      mimeType: payload.mime_type,
      dataBase64: '',
      bytes: payload.size,
      sha256: payload.hash,
      // The record stores the tier, not the resolution string; deriving it back
      // from the tier is the only honest direction — inventing a resolution the
      // record never held would be a fact we made up on a recovery path.
      resolution: tierId === undefined ? '' : getVideoTier(tierId).resolution,
      model: '',
      tierId: tierId as never,
      durationSeconds: payload.duration_seconds,
      estimatedCredits: 0,
    },
    conversationArtifact: artifact,
    mediaDirective: `MEDIA: ${payload.path}`,
    sourceArtifactId,
    replayed: true,
  };
}

/**
 * Edit a clip the user already has.
 *
 * TWO credentials, and the separation is the whole correction of this slice:
 *
 *   `handle` says WHICH clip. It is long-lived, it rides every context envelope,
 *   and on its own it now buys nothing that costs money.
 *
 *   `permit` says THIS PERSON JUST ASKED, ONCE. It is minted only when a real
 *   user send builds an envelope, it is bound server-side to the conversation,
 *   the operation, the covered artifact bytes and the hash of the raw ORDINARY
 *   user turn — that path's exact bytes, untrimmed — it expires in minutes, and
 *   it is consumed atomically before the provider is called. (A correction mints
 *   no permit at all, and its own turn pointer binds the delivered bytes rather
 *   than the raw ones; see `CommandEveArtifactTurnSteerRequest.steerText`.)
 *
 * BOTH lanes — the renderer IPC provider and the Hermes MCP loopback — enter
 * here, so neither can bypass what the other enforces. That is deliberate: the
 * first build gated only the loopback, which left the identical paid handler
 * registered without a gate a few lines away in `commandEveBridge`.
 *
 * Guard order, all of it local and free until the very last step:
 * flag -> STORE HEALTH -> instruction -> grant -> caller conversation fence ->
 * CONVERSATION DENY -> artifact -> editability -> bytes -> hash match ->
 * PERMIT CONVERSATION FENCE -> retry recovery (conversation-scoped) -> permit
 * judgement (conversation, operation, CURRENT TURN, covered bytes, expiry) ->
 * licence -> in-flight lock -> ATOMIC TURN + PERMIT CONSUME -> network.
 *
 * STORE HEALTH is round 5's addition and it is PROCESS-WIDE rather than
 * per-conversation. Round 4 left a residual it pinned honestly: when the durable
 * deny write was itself the thing that failed, the deny lived only in memory and
 * a restart forgot it, while the permit record it compensated for was still on
 * disk and still inside its window. No marker could fix that — writing was the
 * failure. So a live authority is no longer allowed to outlive its process, and
 * until this process has PROVEN that by sweeping the store, the paid path is
 * refused everywhere.
 *
 * The DENY is round 4's addition and it is checked by its own read of its own
 * state — not derived from the permit record, because deleting that record is
 * precisely the operation whose failure raises the deny. Two earlier guards
 * moved after an independent audit: the permit's own conversation is fenced
 * BEFORE recovery rather than after it, and the permit's stored user-turn hash
 * is actually compared instead of merely stored.
 *
 * The result is persisted BESIDE the source with `parent_artifact_id` pointing
 * at it. The source is never overwritten: a bad edit must not be data loss, and
 * the user asked to change a video, not to lose one.
 */
export async function handleCommandEveVideoEdit(
  request?: CommandEveVideoEditRequest,
  deps: CommandEveVideoBridgeDeps = productionDeps
): Promise<CommandEveVideoEditResult> {
  // THE flag gate, in the shared handler rather than in one lane's wrapper.
  // Since 1.820.2 the question is decided by ONE resolver
  // (`agentVideoEditFlag.ts`): an eligible seat — licence wire present and
  // readable — is open by default, exactly `'0'` in the env is the kill-switch,
  // and an unreadable or absent wire fails closed. The two packaged/dry proofs
  // that unlocked default-on are named in that module's header.
  const paidEnabled = (deps.isVideoEditEnabled ?? (() => isAgentVideoEditAdvertisingEnabled(deps.getDataPath())))();
  if (!paidEnabled) {
    return refuseEdit(
      'video-edit-disabled',
      'Das Bearbeiten von Videos ist auf diesem Platz noch nicht freigeschaltet.'
    );
  }

  // THE PROCESS-WIDE STORE-HEALTH GATE — round 5, and it is second only to the
  // flag because it needs nothing: no conversation, no grant, no permit, no
  // disk read of its own.
  //
  // It answers "has THIS process proven that no pre-restart spend authority is
  // still lying around?". Until it has, every edit in every conversation is
  // refused here — before the provider fetch and before the debit — which is
  // what makes "a restart never revives spendability" true rather than hoped.
  // Both lanes (renderer IPC and the Hermes MCP loopback) enter this function,
  // so neither can walk past it.
  //
  // A throw reads as unhealthy for the same reason everything else here does: if
  // the state cannot be established, the answer is no.
  let storeProven = false;
  try {
    storeProven = (deps.isSpendStoreHealthy ?? isVideoEditSpendStoreHealthy)() === true;
  } catch {
    storeProven = false;
  }
  if (!storeProven) {
    return refuseEdit('video-edit-spend-store-unreconciled', describeSpendPermitRefusal('spend-store-unreconciled'));
  }

  const instruction = typeof request?.instruction === 'string' ? request.instruction.trim() : '';
  if (!request || instruction.length === 0 || instruction.length > MAX_VIDEO_EDIT_INSTRUCTION_CHARS) {
    return refuseEdit('video-edit-request-invalid', 'Sag kurz, was am Video geändert werden soll.');
  }

  const resolveCapability = deps.resolveCapability ?? resolveVideoEditCapability;
  const listRecords = deps.listArtifactRecords ?? listVideoArtifactRecords;
  const readGrant = deps.readCapabilityGrant ?? readArtifactCapabilityGrant;
  const readSource = deps.readVideoSource ?? readBoundedVideoSource;
  const isDenied = deps.isSpendDenied ?? isVideoEditSpendDenied;
  const evaluatePermit = deps.evaluateSpendPermit ?? evaluateStoredVideoEditSpendPermit;
  const readPermitRecord = deps.readSpendPermitRecord ?? readVideoEditSpendPermitRecord;
  const readCompletion = deps.readSpendCompletion ?? readVideoEditSpendCompletion;
  const consumePermit = deps.consumeSpendPermit ?? consumeVideoEditSpendPermit;
  const recordCompletion = deps.recordSpendCompletion ?? recordVideoEditSpendCompletion;
  const acquireLock = deps.acquireInflightLock ?? acquireVideoEditInflightLock;
  const releaseLock = deps.releaseInflightLock ?? releaseVideoEditInflightLock;
  const readSeatRevision = deps.getActiveSeatContextRevision ?? (() => 0);
  let capturedSeatId: string;
  let capturedSeatContextRevision: number;
  let dataPath: string;
  try {
    capturedSeatId = deps.getActiveSeatId();
    capturedSeatContextRevision = readSeatRevision();
    dataPath = deps.getDataPath();
  } catch {
    return refuseEdit('video-seat-unavailable', 'Der aktive Seed konnte nicht sicher bestimmt werden.', true);
  }
  const seatStillMatches = (): boolean => {
    try {
      return deps.getActiveSeatId() === capturedSeatId && readSeatRevision() === capturedSeatContextRevision;
    } catch {
      return false;
    }
  };

  // The grant is read FIRST so the source path comes from OUR record, never from
  // anything the caller supplied. A path that arrived with the request would be
  // an arbitrary-file-read dressed as an edit.
  const grant = readGrant(dataPath, request.handle);
  if (!grant) {
    return refuseEdit('video-edit-handle-unknown', describeArtifactCapabilityRefusal('handle-unknown'));
  }
  if (request.conversationId !== undefined && request.conversationId !== grant.conversation_id) {
    return refuseEdit('video-edit-conversation-mismatch', describeArtifactCapabilityRefusal('conversation-mismatch'));
  }

  // THE DENY GATE — round 4, and the earliest point at which the conversation
  // can be named from a record of ours rather than from the request.
  //
  // It sits BEFORE the source read, before retry recovery, before the permit
  // judgement, before the licence, before the lock, before the atomic consume
  // and before the fetch. That ordering is the requirement itself: while a
  // conversation is retired, an edit must reach neither the provider nor the
  // debit.
  //
  // It is deliberately ahead of RECOVERY too, even though a recovered result
  // spends nothing. Recovery is a decision made out of the same local store
  // whose write or delete is what failed; trusting it to answer while
  // distrusting everything around it would be incoherent. The cost is that a
  // free retry is refused for as long as the conversation is retired — a
  // refusal, never a charge, and the clip itself is already saved and listed.
  //
  // A throw here reads as DENIED. If the state cannot be established, the answer
  // is no.
  let conversationRetired = true;
  try {
    conversationRetired = isDenied(dataPath, grant.conversation_id);
  } catch {
    conversationRetired = true;
  }
  if (conversationRetired) {
    return refuseEdit('video-edit-conversation-retired', describeSpendPermitRefusal('conversation-retired'));
  }

  const source = listRecords(dataPath, grant.conversation_id).find((record) => record.id === grant.artifact_id);
  if (!source) {
    return refuseEdit('video-edit-source-missing', 'Das Ausgangsvideo ist nicht mehr vorhanden.');
  }

  const sourcePayload = hydrateVideoArtifactPayload(source.payload);
  const tierId = resolveVideoArtifactTier(sourcePayload);
  if (!isVideoArtifactEditable(sourcePayload) || tierId === undefined) {
    return refuseEdit('video-edit-source-not-editable', 'Dieses Video lässt sich nicht bearbeiten.');
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = readSource(sourcePayload.path);
  } catch {
    return refuseEdit('video-edit-source-unreadable', 'Die Videodatei konnte nicht gelesen werden.');
  }

  // Hash what we ACTUALLY read, then judge the handle against that. Hashing the
  // path separately would leave a window in which the file changed between the
  // check and the upload — and we would have paid to edit bytes nobody approved.
  const observedArtifactSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const capability = resolveCapability(dataPath, {
    handle: request.handle,
    observedArtifactSha256,
    expectedConversationId: grant.conversation_id,
  });
  if (capability.ok === false) {
    const reason = capability.reason;
    return refuseEdit(
      `video-edit-${reason}`,
      reason === 'artifact-missing'
        ? 'Das Ausgangsvideo ist nicht mehr vorhanden.'
        : describeArtifactCapabilityRefusal(reason)
    );
  }

  const promptSha256 = crypto.createHash('sha256').update(instruction).digest('hex');
  const permit = typeof request.permit === 'string' ? request.permit : '';

  // POLICY L, PART ONE — THE CONVERSATION FENCE, AND IT RUNS BEFORE RECOVERY.
  //
  // Round 1 put recovery first and matched only (instruction, source bytes), so
  // a permit from conversation A presented in conversation B — with a clip whose
  // bytes matched, which two conversations holding the same video is enough for
  // — returned A's artifact and A's `MEDIA: /Users/<name>/…` path. A fence that
  // runs after the thing it is meant to fence is not a fence.
  //
  // Record against record: the permit's stored conversation against the one the
  // GRANT named. Nothing the caller supplied is on either side.
  const permitRecord = readPermitRecord(dataPath, permit);
  if (permitRecord && permitRecord.conversation_id !== grant.conversation_id) {
    return refuseEdit(
      'video-edit-permit-conversation-mismatch',
      describeSpendPermitRefusal('permit-conversation-mismatch')
    );
  }

  // RETRY RECOVERY, before anything can charge again. A permit that already
  // produced this exact clip answers from its receipt. Without this, the honest
  // single-use rule would turn every dropped response into either a bare failure
  // the user paid for or a second debit — and "no false completion" has to cut
  // both ways.
  //
  // POLICY L, PART TWO — recovery is CONVERSATION-SCOPED in its own right, not
  // only behind the fence above. The fence needs a permit record, and a receipt
  // deliberately outlives the record that produced it (a slow edit whose permit
  // the next turn retired must still be recoverable). So the receipt is matched
  // on the conversation as well, and the prior artifact is looked up in the
  // GRANT's conversation — never in the one the receipt names.
  const completion = readCompletion(dataPath, permit, {
    conversationId: grant.conversation_id,
    instructionSha256: promptSha256,
    artifactSha256: observedArtifactSha256,
  });
  if (completion) {
    const prior = listRecords(dataPath, grant.conversation_id).find((record) => record.id === completion.artifact_id);
    if (prior) return recoveredEditResult(prior, completion.source_artifact_id);
    return refuseEdit(
      'video-edit-result-unavailable',
      'Diese Bearbeitung wurde bereits ausgeführt, das Ergebnis ist aber nicht mehr auffindbar. Es wurde nichts erneut berechnet.'
    );
  }

  // THE spend authority. `grant.conversation_id` on both sides of the comparison
  // inside: one server-side record judged against another, never a conversation
  // id the caller supplied. That is what makes the binding non-tautological.
  const permitEvaluation = evaluatePermit(dataPath, {
    permit,
    conversationId: grant.conversation_id,
    observedArtifactSha256,
  });
  if (permitEvaluation.ok === false) {
    return refuseEdit(`video-edit-${permitEvaluation.reason}`, describeSpendPermitRefusal(permitEvaluation.reason));
  }

  const wireResult = readLicenseWire(dataPath);
  if (!wireResult.ok || !wireResult.wire) {
    return refuseEdit('entitlement-not-drawable', 'Für Videos wird ein aktives Command-EVE-Konto benötigt.');
  }

  // Bind the already-authorized edit to the Seed that supplied its handle,
  // permit and storage root. A switch that finished during local preparation
  // is rejected here; once the process-local fence is acquired, Main cannot
  // switch Seeds until the billed response has been persisted or refused.
  if (!seatStillMatches()) {
    return refuseEdit(
      'video-seat-changed',
      'Der aktive Seed wurde während der Vorbereitung gewechselt. Starte die Videobearbeitung erneut.',
      true
    );
  }
  const paidArtifactBlockReason = (deps.getPaidArtifactBlockReason ?? getCommandEvePaidArtifactBlockReason)();
  if (paidArtifactBlockReason === 'seat_recovery_required') {
    return refuseEdit(
      'video-seat-recovery-required',
      'Der letzte Seed-Wechsel wurde nicht abgeschlossen. Starte Command EVE neu, bevor du die Videobearbeitung erneut versuchst.',
      false
    );
  }
  if (paidArtifactBlockReason === 'seat_transition_in_progress') {
    return refuseEdit(
      'video-seat-changed',
      'Der aktive Seed wird gerade gewechselt. Starte die Videobearbeitung danach erneut.',
      true
    );
  }
  const releasePaidArtifactOperation = tryBeginCommandEvePaidArtifactOperation();
  if (!releasePaidArtifactOperation) {
    return refuseEdit(
      'video-seat-changed',
      'Der aktive Seed wird gerade gewechselt. Starte die Videobearbeitung danach erneut.',
      true
    );
  }

  // At most ONE paid edit in flight per conversation. Taken BEFORE the consume so
  // two simultaneous tool calls cannot both get past the ledger check in the
  // window before either has written its claim.
  let conversationLockAcquired = false;
  try {
    conversationLockAcquired = acquireLock(dataPath, grant.conversation_id);
  } catch {
    releasePaidArtifactOperation();
    return refuseEdit('video-edit-lock-unavailable', describeSpendPermitRefusal('edit-already-in-flight'), true);
  }
  if (!conversationLockAcquired) {
    releasePaidArtifactOperation();
    return refuseEdit('video-edit-already-in-flight', describeSpendPermitRefusal('edit-already-in-flight'), true);
  }

  try {
    // ATOMIC, and before the provider call. An exclusive create, not a
    // read-then-write: the second arrival loses the race at the filesystem
    // rather than at a comparison it also thought it had won.
    // The TURN travels with the consume, taken from the permit record the
    // evaluation just judged — so the atomic claim is on the thing the user
    // actually said, not merely on the credential that names it.
    const consumption = consumePermit(dataPath, {
      permit,
      conversationId: grant.conversation_id,
      userTurnSha256: permitEvaluation.record.user_turn_sha256,
      instructionSha256: promptSha256,
      artifactSha256: observedArtifactSha256,
    });
    if (consumption.ok === false) {
      // A DIFFERENT instruction on the same permit lands here as
      // `permit-consumed`. That is the varied-instruction loop, failing closed.
      return refuseEdit(
        `video-edit-${consumption.reason}`,
        describeSpendPermitRefusal(consumption.reason),
        consumption.reason === 'permit-in-flight'
      );
    }

    // Content-derived, NOT a uuid. The same approved edit arriving from the
    // desktop confirmation and from a Hermes tool call must produce a byte-
    // identical body, so the gateway's content-only ledger key collapses them
    // into one debit instead of billing an approved edit twice.
    const requestId = crypto
      .createHash('sha256')
      .update(buildVideoEditRequestIdMaterial({ promptSha256, tierId, sourceSha256: observedArtifactSha256 }))
      .digest('hex');

    const body = {
      ...buildVideoEditBody(
        {
          prompt: instruction,
          tierId,
          sourceBase64: Buffer.from(sourceBytes).toString('base64'),
          sourceSha256: observedArtifactSha256,
          // PROVIDER-REPORTED, never measured from the file. See the honesty note
          // on `MAX_VIDEO_EDIT_SOURCE_SECONDS` — the desktop pins the BYTES with a
          // hash but takes the LENGTH on the record's word, so a record claiming
          // 5s for a 12s clip would pass the ceiling and misprice the preview. The
          // gateway re-derives the charge, so the money is right; the local
          // estimate is the part that can be wrong.
          sourceDurationSeconds: sourcePayload.duration_seconds,
        },
        requestId
      ),
      ...commandEveMediaSeedAttribution(capturedSeatId),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_REQUEST_TIMEOUT_MS);
    let outcome: VideoEditOutcome;
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
        return refuseEdit('video-response-too-large', 'Die Antwort des Servers war zu groß.');
      }
      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
      outcome = parseVideoEditResponse(response.status, raw);
    } catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
      // The permit stays consumed on a timeout or a transport error, and that is
      // the deliberate choice: we do not know whether the gateway debited, so
      // silently re-arming the permit would be the one move that could bill
      // twice. `retryable` still tells the user to ask again — which mints a new
      // permit through a new send, which is exactly the intended shape.
      return name === 'AbortError'
        ? refuseEdit('provider-timeout', 'Die Bearbeitung hat zu lange gedauert.', true)
        : refuseEdit('video-request-failed', 'Die Bearbeitung konnte nicht gestartet werden.', true);
    } finally {
      clearTimeout(timer);
    }

    if (outcome.ok === false) return outcome;

    try {
      const artifactId = deps.newArtifactId();
      const savedPath = deps.saveVideoFile({
        conversationId: grant.conversation_id,
        artifactId,
        dataBase64: outcome.artifact.dataBase64,
        mimeType: outcome.artifact.mimeType,
      });
      const conversationArtifact = buildVideoConversationArtifact({
        artifact: outcome.artifact,
        path: savedPath,
        id: artifactId,
        conversationId: grant.conversation_id,
        createdAtMs: Date.now(),
        // BESIDE the source, never over it.
        originCapability: 'video_edit',
        parentArtifactId: source.id,
      });
      deps.saveArtifactRecord(dataPath, conversationArtifact);
      // THE EDIT IS NOW ON DISK — tell the renderer, or the user pays for a clip
      // they cannot see.
      //
      // Placed exactly here and nowhere else: after the durable write, and after
      // `if (outcome.ok === false) return outcome` above, so a refusal can never
      // reach it. A refresh for an edit that did not happen is a second lie, not
      // a smaller one.
      //
      // ON THE CHANNEL NAME, deliberately reused rather than quietly abused: the
      // channel is called `image-artifacts-changed`, but the renderer's only
      // handler for it calls `loadArtifacts()`, which re-reads remote artifacts,
      // `videoArtifactsList` AND `imageArtifactsList` (artifacts.tsx). It is
      // already an "all artifacts changed" signal in everything but its name, and
      // one refresh channel is what keeps a single edit from producing two
      // refreshes once both lanes are in use. Renaming it would touch the
      // channel, the renderer and every bridge mock for a cosmetic gain; stating
      // it here is the honest alternative to renaming, and to silence.
      //
      // NO PATH TRAVELS. The payload is a conversation id and nothing else, so
      // the no-paths contract of the model-facing envelope is untouched — this
      // event goes to the renderer, never toward a model.
      try {
        deps.emitArtifactsChanged?.(grant.conversation_id);
      } catch {
        /* the clip is saved; a failed notify costs the same-turn refresh only */
      }
      // Its OWN try/catch, like the handle mint below: the receipt is what makes
      // a retry free, but failing to write it must not turn a saved clip into a
      // reported failure.
      try {
        recordCompletion(dataPath, permit, {
          artifact_id: artifactId,
          source_artifact_id: source.id,
          conversation_id: grant.conversation_id,
          instruction_sha256: promptSha256,
          artifact_sha256: observedArtifactSha256,
          completed_at_ms: Date.now(),
        });
      } catch {
        /* the clip is saved; only the free-retry affordance is lost */
      }
      try {
        deps.ensureCapabilityHandle?.(dataPath, conversationArtifact);
      } catch {
        /* saved and playable; the edit affordance re-mints on the next envelope */
      }
      return {
        ok: true,
        artifact: outcome.artifact,
        conversationArtifact,
        // A path, never a `data:` URL — the chat's artifact renderer resolves an
        // https URL or a file path and nothing else, so a data URL would simply
        // not render.
        //
        // IT CANNOT REACH THE MODEL, and that is checked rather than asserted.
        // The model's only route into this handler is the MCP loopback, and
        // `artifactCapabilityLoopback.ts` builds its success payload from four
        // NAMED fields (`ok`, `artifact_id`, `parent_artifact_id`, `replayed`) —
        // it never spreads this result and never reads this key, so there is no
        // spelling of the model-facing response that contains a path. The
        // renderer IPC provider is the other caller, and its response goes to the
        // renderer; nothing in `packages/desktop/src/renderer` reads
        // `mediaDirective` today, so it is on no transcript, export or
        // support-bundle path either. `artifactCapabilityLoopback.test.ts` pins
        // the loopback half with a positive control that proves this handler DID
        // return a path-bearing directive.
        mediaDirective: `MEDIA: ${savedPath}`,
        sourceArtifactId: source.id,
      };
    } catch {
      return refuseEdit(
        'video-artifact-save-failed',
        'Das bearbeitete Video wurde erstellt, konnte aber nicht lokal gespeichert werden.'
      );
    }
  } finally {
    try {
      releaseLock(dataPath, grant.conversation_id);
    } finally {
      releasePaidArtifactOperation();
    }
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.videoEdit`. */
export async function handleCommandEveVideoEditBridge(
  request?: CommandEveVideoEditRequest,
  deps: CommandEveVideoBridgeDeps = productionDeps
): Promise<{ success: true; data: CommandEveVideoEditResult }> {
  return { success: true, data: await handleCommandEveVideoEdit(request, deps) };
}
