/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The desktop half of the video lane: build the request the gateway expects, and
 * read its answer HONESTLY.
 *
 * Honestly is the operative word. The gateway refuses in several distinct ways —
 * out of credits, over the spend cap, a resolution the model cannot produce, a
 * replayed request, a daily cap — and each of those is a different thing to tell
 * the user. Collapsing them into "video failed" is the same defect as the visual
 * lane's generic error text: the cause exists, and we throw it away.
 *
 * PURE: no fetch, no Electron. The bridge owns the socket; this owns the meaning.
 */

import { getVideoTier, type VideoQualityTier } from './videoCostCore';

/** The multimodal gateway endpoint, shared with the image/vision/TTS lanes. */
export const VIDEO_GENERATION_CAPABILITY = 'video_generation' as const;

/**
 * What the renderer asks MAIN for. Lives here, not in the process bridge, because
 * `common/` must never import from `process/` — the IPC declaration needs this
 * type and the layering only allows it to look downwards.
 *
 * There is deliberately no `imageBase64`/`imageSha256` here. The renderer never
 * reads file bytes or computes a hash itself — that would be exactly the
 * arbitrary-path-read this lane must refuse. It sends `imagePath`, a path Main
 * has ALREADY grant-verified (the same native-file-selection grant every other
 * EVE visual lane uses); Main re-reads that exact file and re-hashes what it
 * actually read before anything reaches the gateway.
 */
export interface CommandEveVideoGenerateRequest {
  prompt: string;
  tierId: VideoQualityTier;
  durationSeconds: number;
  /**
   * Optional so the pre-existing gateway-communication tests keep exercising the
   * gateway call in isolation. Every real caller (the send-path) always supplies
   * it; when it is absent, the local durable-artifact save is skipped rather than
   * faked — a video that cannot be attributed to a conversation is not persisted
   * as one.
   */
  conversationId?: string;
  /** The attached, grant-verified image path for image->video (see above). */
  imagePath?: string;
}

export interface VideoGenerationRequest {
  prompt: string;
  tierId: VideoQualityTier;
  durationSeconds: number;
  /** Base64 source image for image->video, with its SHA-256 receipt. */
  imageBase64?: string;
  imageSha256?: string;
  requestId: string;
}

/**
 * Build the gateway body. The tier travels as an id, not as a resolution string:
 * the SERVER owns the mapping from tier to model and resolution, so a desktop that
 * is one release behind cannot talk a newer gateway into a wrong model.
 */
export function buildVideoGenerationBody(request: VideoGenerationRequest): Record<string, unknown> {
  return {
    provider: 'xai',
    capability: VIDEO_GENERATION_CAPABILITY,
    privacyLane: 'cloud_auto',
    directProviderKeyPresentInDesktop: false,
    requestId: request.requestId,
    video_generation: {
      prompt: request.prompt,
      tier: request.tierId,
      duration_seconds: request.durationSeconds,
      ...(request.imageBase64 === undefined
        ? {}
        : { image_base64: request.imageBase64, image_sha256: request.imageSha256 }),
    },
  };
}

/** A generated video, as the renderer needs it. */
export interface VideoGenerationArtifact {
  mimeType: string;
  dataBase64: string;
  bytes: number;
  sha256: string;
  /** What was ACTUALLY produced — not what was requested. */
  resolution: string;
  model: string;
  tierId: VideoQualityTier;
  durationSeconds: number;
  estimatedCredits: number;
}

export type VideoGenerationOutcome =
  | { ok: true; artifact: VideoGenerationArtifact }
  | { ok: false; reasonCode: string; message: string; retryable: boolean };

/**
 * Map a gateway refusal to something worth showing a person.
 *
 * `retryable` distinguishes "try again in a moment" from "this will never work
 * as asked" — a user who is told to retry a request that is structurally
 * impossible will retry it, and be wrong twice.
 */
export function describeVideoRefusal(
  reasonCode: string,
  serverMessage?: string
): {
  message: string;
  retryable: boolean;
} {
  switch (reasonCode) {
    case 'insufficient_credits':
      return { message: 'Nicht genug Credits für dieses Video.', retryable: false };
    case 'spend_cap_exceeded':
      return {
        message: 'Dieses Video würde das Ausgabenlimit für den aktuellen Zeitraum überschreiten.',
        retryable: false,
      };
    case 'video-tier-unavailable':
      // The server knows exactly why (text prompt vs entitlement); it says so.
      return {
        message: serverMessage || 'Diese Videoqualität ist für diese Anfrage nicht verfügbar.',
        retryable: false,
      };
    case 'request-replayed':
      return { message: 'Dieses Video wurde bereits erstellt.', retryable: false };
    case 'video-daily-cap':
      return { message: 'Das Tageslimit für Videos ist erreicht.', retryable: false };
    case 'entitlement-not-drawable':
      return { message: 'Für Videos wird ein aktives Command-EVE-Konto benötigt.', retryable: false };
    case 'credit-gate-unavailable':
    case 'usage-gate-unavailable':
      return {
        message: 'Die Abrechnung ist gerade nicht erreichbar — das Video wurde nicht gestartet.',
        retryable: true,
      };
    case 'provider-timeout':
      return { message: 'Die Videoerstellung hat zu lange gedauert.', retryable: true };
    case 'provider-not-configured':
      return { message: 'Die Videoerstellung ist auf dem Server nicht konfiguriert.', retryable: false };
    case 'video-request-invalid':
      return { message: 'Die Videoanfrage war unvollständig oder außerhalb der erlaubten Länge.', retryable: false };
    default:
      return {
        message: serverMessage || 'Die Videoerstellung ist fehlgeschlagen.',
        retryable: true,
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the gateway answer. A non-2xx status is NOT enough on its own — the body
 * carries the reason, and the reason is what the user needs. Equally, a 200 with
 * a malformed artifact is a failure, not a success: claiming a video exists when
 * we cannot show one is the dishonesty this lane is meant to end.
 */
export function parseVideoGenerationResponse(status: number, raw: unknown): VideoGenerationOutcome {
  const body = isRecord(raw) ? raw : null;
  const serverReason = body && typeof body.reason === 'string' ? body.reason : '';
  const serverMessage = body && typeof body.message === 'string' ? body.message : undefined;

  if (status < 200 || status >= 300 || !body || body.ok !== true) {
    const reasonCode = serverReason || `http_${status}`;
    const described = describeVideoRefusal(reasonCode, serverMessage);
    return { ok: false, reasonCode, message: described.message, retryable: described.retryable };
  }

  const artifact = isRecord(body.artifact) ? body.artifact : null;
  const meta = isRecord(body.video_generation) ? body.video_generation : null;
  const dataBase64 = artifact && typeof artifact.data_base64 === 'string' ? artifact.data_base64 : '';
  const mimeType = artifact && typeof artifact.mime_type === 'string' ? artifact.mime_type : '';

  if (!artifact || !meta || dataBase64.length === 0 || !mimeType.startsWith('video/')) {
    return {
      ok: false,
      reasonCode: 'video-artifact-malformed',
      message: 'Der Server meldete Erfolg, lieferte aber kein abspielbares Video.',
      retryable: true,
    };
  }

  const tierId = (typeof meta.tier === 'string' ? meta.tier : 'fast') as VideoQualityTier;
  return {
    ok: true,
    artifact: {
      mimeType,
      dataBase64,
      bytes: typeof artifact.bytes === 'number' ? artifact.bytes : 0,
      sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : '',
      // The RESOLVED spec from the server, never the requested one. If the server
      // produced something different from what was asked, the user sees what they
      // actually got.
      resolution: typeof meta.resolution === 'string' ? meta.resolution : getVideoTier(tierId).resolution,
      model: typeof meta.model === 'string' ? meta.model : '',
      tierId,
      durationSeconds: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
      estimatedCredits: typeof meta.estimated_credits === 'number' ? meta.estimated_credits : 0,
    },
  };
}

/**
 * Shape a generated video for display.
 *
 * NOT YET WIRED, and the reason is written here rather than discovered later.
 * The chat's artifact renderer derives artifacts from a `MEDIA: <source>` line in
 * a message, and it resolves that source as an https URL or a file path
 * (`hermesMediaDirectiveCore.ts:148,186`). A `data:` URL is neither, so a video
 * handed over this way would not render. Making it visible therefore needs MAIN
 * to write the bytes to a seat-scoped file and emit its path — a real slice with
 * storage and cleanup, not a call site.
 *
 * Until that exists, a successful generation is reported to the user but not
 * displayed, and this function has no production caller. It is kept because the
 * label logic is the part worth preserving: the description carries the RESOLVED
 * resolution and the credits estimate, so what the user reads matches what the
 * server produced rather than what was requested.
 */
export function buildVideoArtifactPayload(artifact: VideoGenerationArtifact): {
  artifact_type: 'video';
  title: string;
  description: string;
  data_url: string;
  mime_type: string;
  sha256: string;
  bytes: number;
} {
  return {
    artifact_type: 'video',
    title: `Video ${artifact.resolution}`,
    description: `${artifact.resolution} · ${artifact.durationSeconds}s · ca. ${artifact.estimatedCredits} Credits · ${artifact.model}`,
    data_url: `data:${artifact.mimeType};base64,${artifact.dataBase64}`,
    mime_type: artifact.mimeType,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
  };
}

// ---------------------------------------------------------------------------
// The DURABLE artifact (survives a conversation reload)
// ---------------------------------------------------------------------------

/**
 * `buildVideoArtifactPayload` above embeds the whole clip as a `data_url` —
 * fine for an immediate in-memory preview, but a `data_url` lives only in
 * renderer JS memory and is gone the moment the conversation view remounts.
 * That is the exact "ephemeral toast-only" failure this lane must not repeat
 * (see the read-aloud audio artifact, which does the same thing and says so).
 *
 * The durable form instead references a `path` MAIN already saved to disk
 * (mirrors how generated images are saved: bytes to a real file, referenced by
 * path, never re-shipped as base64). `MessageGeneratedArtifact` already knows
 * how to read and play a `path`-based artifact.
 */
export interface CommandEveVideoConversationArtifactPayload {
  artifact_type: 'video';
  title: string;
  description: string;
  path: string;
  mime_type: string;
  hash: string;
  size: number;
}

export interface CommandEveVideoConversationArtifact {
  id: string;
  conversation_id: string;
  kind: 'video';
  status: 'active';
  payload: CommandEveVideoConversationArtifactPayload;
  created_at: number;
  updated_at: number;
}

export function buildVideoConversationArtifactPayload(
  artifact: VideoGenerationArtifact,
  path: string
): CommandEveVideoConversationArtifactPayload {
  return {
    artifact_type: 'video',
    title: `Video ${artifact.resolution}`,
    description: `${artifact.resolution} · ${artifact.durationSeconds}s · ca. ${artifact.estimatedCredits} Credits · ${artifact.model}`,
    path,
    mime_type: artifact.mimeType,
    hash: artifact.sha256,
    size: artifact.bytes,
  };
}

export function buildVideoConversationArtifact(input: {
  artifact: VideoGenerationArtifact;
  path: string;
  id: string;
  conversationId: string;
  createdAtMs: number;
}): CommandEveVideoConversationArtifact {
  return {
    id: input.id,
    conversation_id: input.conversationId,
    kind: 'video',
    status: 'active',
    payload: buildVideoConversationArtifactPayload(input.artifact, input.path),
    created_at: input.createdAtMs,
    updated_at: input.createdAtMs,
  };
}

// ---------------------------------------------------------------------------
// Image->video safety: 1080p is unreachable without a validated image
// ---------------------------------------------------------------------------

/**
 * `hd` (1080p) is `grok-imagine-video-1.5`, which is IMAGE->VIDEO ONLY (see
 * `videoCostCore`). The renderer already hides the picker option, but a picker
 * is UI, not a boundary — this is the fail-closed check that refuses the tier
 * server-request-side when no validated image made it through, so a stale
 * client, a replayed request, or a future regression cannot buy a 1080p promise
 * the provider cannot keep.
 */
export function refuseVideoTierWithoutImage(
  tierId: VideoQualityTier,
  hasImage: boolean
): { ok: false; reasonCode: 'video-tier-unavailable'; message: string; retryable: false } | null {
  if (!getVideoTier(tierId).requiresImageInput || hasImage) return null;
  return {
    ok: false,
    reasonCode: 'video-tier-unavailable',
    message: 'Diese Videoqualität benötigt ein angehängtes Bild (Bild-zu-Video).',
    retryable: false,
  };
}

/**
 * The wire result of `command-eve.video-generate`. Identical to
 * {@link VideoGenerationOutcome} on the failure branch; on success it carries
 * BOTH the raw artifact (unchanged, for any caller still reading it directly)
 * and — whenever a `conversationId` was supplied — the durable, path-based
 * artifact the renderer must upsert into the conversation's artifact list.
 */
export type CommandEveVideoGenerateResult =
  | { ok: true; artifact: VideoGenerationArtifact; conversationArtifact?: CommandEveVideoConversationArtifact }
  | { ok: false; reasonCode: string; message: string; retryable: boolean };
