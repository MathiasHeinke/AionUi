/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The desktop half of the video EDIT lane — MAT-1747.
 *
 * The gateway half already exists and is finished; this module's only job is to
 * speak its contract exactly, and to speak it the SAME WAY twice.
 *
 * That last part is the whole point of this file. Under Variant C the same
 * approved edit can arrive at the gateway from two directions: the desktop's own
 * confirmation path, and a Hermes tool call the model made. The gateway's credit
 * ledger key is content-only — `(tenantId, promptSha256, tierId, sourceSha256)` —
 * precisely so those two arrivals collapse into ONE debit. If this side stamped
 * a fresh uuid, a timestamp, or a "channel" marker into the body, the two would
 * still collapse in the ledger, but the receipt would disagree with itself and
 * any future key that included the request id would double-bill. So the request
 * id here is DERIVED from the content, not generated: identical edits produce a
 * byte-identical body, and a test can prove it rather than a comment claiming it.
 *
 * PURE: no fetch, no crypto, no Electron. The hashing the derived id needs is
 * expressed as a canonical string the caller hashes, so this module stays
 * testable in plain Node and the bridge keeps the only import of `node:crypto`.
 */

import { hasAsciiPrefix } from './eveOpaqueTokenCore';
import { getVideoTier, resolveVideoPlan, type VideoQualityTier } from './videoCostCore';
import {
  describeVideoRefusal,
  MAX_VIDEO_EDIT_SOURCE_SECONDS,
  type CommandEveVideoConversationArtifact,
  type VideoGenerationArtifact,
} from './videoGenerationRequestCore';

/**
 * What the edit path accepts. HANDLE, PERMIT AND INSTRUCTION ONLY.
 *
 * Lives here rather than in the process bridge because the IPC declaration needs
 * it and `common/` must never import from `process/` — the layering only allows
 * a look downwards.
 *
 * There is deliberately no artifact id, no path and no tier: the model can say
 * anything, so the tier is inherited from the source record and nothing the
 * caller writes names a clip.
 *
 * The two credentials do different jobs and that separation is the correction at
 * the heart of this slice. `handle` is long-lived and identifies WHICH artifact;
 * on its own it now buys only a read. `permit` is ephemeral, single-use, minted
 * on a real user send, and is what authorises SPENDING — so a handle recovered
 * from an old transcript cannot pay for anything, and one user turn cannot pay
 * twice.
 *
 * `conversationId` is a FENCE, not a credential: when the caller independently
 * knows the active conversation a mismatch refuses. It can never grant, which is
 * why the authoritative conversation comparison at redeem is grant-record
 * against permit-record and not anything the caller supplied.
 */
export interface CommandEveVideoEditRequest {
  handle: string;
  instruction: string;
  /**
   * The ephemeral single-use spend permit for THIS user turn.
   *
   * OPTIONAL in the type and MANDATORY in behaviour, and the gap between those
   * two words is deliberate rather than sloppy: both lanes must be able to
   * present an absent credential explicitly, so the loopback forwards `''`
   * instead of inventing one, and the shared handler is the single place that
   * decides what absence means. It decides `permit-missing`, which is a refusal.
   * A required field here would force the lanes to fabricate a value.
   */
  permit?: string;
  conversationId?: string;
}

export type CommandEveVideoEditResult =
  | {
      ok: true;
      artifact: VideoGenerationArtifact;
      conversationArtifact: CommandEveVideoConversationArtifact;
      /**
       * A `MEDIA: <path>` line that is CONSTRUCTED AND READ BY NOBODY.
       *
       * An earlier version of this sentence claimed the chat renderer "already
       * turns it into a player". That described a different mechanism: the
       * renderer's MEDIA-line parser (`hermesMediaDirectiveCore`) consumes
       * Hermes CHAT TEXT, and nothing ever feeds this field into chat text —
       * so this field never reaches that parser, and never did.
       *
       * What is actually true, verified by search rather than intended: the
       * model's single route into this handler is the MCP loopback, which
       * constructs its success payload from named fields and never reads this
       * one (`process/commandEve/artifactCapabilityLoopback.ts`, the
       * `video_edit` branch). Nothing under `renderer/` reads it either, so it
       * reaches no transcript, export or support bundle. The registered IPC
       * forwarder (`command-eve.video-edit`) would carry it, but has no
       * production invoker. The user SEES the paid edit through the durable
       * artifact store plus the `command-eve.image-artifacts-changed` refresh
       * — never through this field.
       *
       * Kept (for now) because the shape is load-bearing for the handler's two
       * construction sites and their tests; whoever removes it removes those in
       * the same change. A real filesystem path handed to a model would
       * contradict the envelope's own no-paths rule and leak the account name
       * out of `/Users/<name>/` into a third-party API — one more reason this
       * field must stay away from every model-facing payload.
       */
      mediaDirective: string;
      sourceArtifactId: string;
      /**
       * True when this is a RECOVERED result — the permit had already produced
       * this clip and the retry was answered from the receipt instead of being
       * charged again. Honest to surface: "it worked, twice asked, once paid".
       */
      replayed?: boolean;
    }
  | { ok: false; reasonCode: string; message: string; retryable: boolean };

export const VIDEO_EDIT_CAPABILITY = 'video_edit' as const;

/** The provider-side credit rate for the SOURCE seconds, mirrored from the gateway. */
export const VIDEO_EDIT_INPUT_CREDITS_PER_SECOND = 100;

/** Longest instruction we will forward. Mirrors the gateway's prompt bound. */
export const MAX_VIDEO_EDIT_INSTRUCTION_CHARS = 2000;

export interface VideoEditGatewayRequest {
  /** The user's editing instruction, already trimmed. */
  prompt: string;
  /** Inherited from the SOURCE clip — never chosen by the caller or the model. */
  tierId: VideoQualityTier;
  sourceBase64: string;
  sourceSha256: string;
  sourceDurationSeconds: number;
}

/**
 * The canonical string whose SHA-256 becomes the request id.
 *
 * Deliberately made of exactly the four things the gateway's own ledger key is
 * made of. Nothing about HOW the request arrived appears here — no session, no
 * nonce, no timestamp, no surface marker — because the same approved edit must
 * produce the same id from either arrival path.
 */
export function buildVideoEditRequestIdMaterial(input: {
  promptSha256: string;
  tierId: VideoQualityTier;
  sourceSha256: string;
}): string {
  return ['command-eve-video-edit-request-v1', input.promptSha256, input.tierId, input.sourceSha256].join('|');
}

/**
 * Build the gateway body.
 *
 * `requestId` is a parameter rather than something generated in here so the
 * derivation stays visible at the call site — a future edit that reaches for
 * `randomUUID()` has to do it in the open, where the test that compares two
 * bodies will catch it.
 */
export function buildVideoEditBody(request: VideoEditGatewayRequest, requestId: string): Record<string, unknown> {
  return {
    provider: 'xai',
    capability: VIDEO_EDIT_CAPABILITY,
    privacyLane: 'cloud_auto',
    directProviderKeyPresentInDesktop: false,
    requestId,
    video_edit: {
      prompt: request.prompt,
      tier: request.tierId,
      source_base64: request.sourceBase64,
      source_sha256: request.sourceSha256,
      source_duration_seconds: request.sourceDurationSeconds,
    },
  };
}

/**
 * The local price preview for an edit — source seconds as INPUT plus the same
 * seconds as OUTPUT, ceil'd ONCE.
 *
 * Mirrors `estimateVideoEditCredits` on the gateway exactly, including the
 * single rounding. Two separate ceils would drift upward against the user, and a
 * preview that is higher than the charge is as dishonest as one that is lower.
 */
export function estimateVideoEditCredits(tierId: VideoQualityTier, sourceDurationSeconds: number): number {
  // The output rate comes from the (model, resolution) matrix through the EDIT
  // mode, not from the tier record — the tier no longer carries a price, because
  // one resolution can be served by two models at two different rates. Editing is
  // capped at 720p and therefore always the base model, so this is the same
  // number it has always been; it now arrives by the route that stays correct.
  const resolved = resolveVideoPlan({ modeKind: 'edit', tierId, capabilities: { hd15Available: true } });
  // An ineligible tier (1080p) has no edit output rate at all. Returning 0 would
  // preview a free edit; callers gate on `isVideoEditEligibleTier` first, and an
  // infinite estimate keeps the arithmetic honest for the one that forgets.
  if (resolved.ok === false) return Number.POSITIVE_INFINITY;
  const perSecond = VIDEO_EDIT_INPUT_CREDITS_PER_SECOND + resolved.plan.creditsPerSecond;
  return Math.ceil(sourceDurationSeconds * perSecond);
}

export type VideoEditOutcome =
  | { ok: true; artifact: VideoGenerationArtifact }
  | { ok: false; reasonCode: string; message: string; retryable: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Edit-specific refusals the generation lane has never had to name. */
export function describeVideoEditRefusal(
  reasonCode: string,
  serverMessage?: string
): { message: string; retryable: boolean } {
  switch (reasonCode) {
    case 'video-edit-request-invalid':
      return {
        message: `Für eine Bearbeitung braucht es eine Anweisung und einen Clip von höchstens ${MAX_VIDEO_EDIT_SOURCE_SECONDS}s.`,
        retryable: false,
      };
    case 'video-source-malformed':
      return { message: 'Die Quelldatei konnte nicht gelesen werden — es wurde nichts bearbeitet.', retryable: false };
    case 'video-source-mismatch':
      return {
        message: 'Die Quelldatei stimmt nicht mit dem erwarteten Video überein — die Bearbeitung wurde abgebrochen.',
        retryable: false,
      };
    default:
      // Everything the two lanes share — credits, spend cap, replay, daily cap,
      // provider timeouts — already has an honest sentence. Reusing it keeps one
      // wording per cause instead of two that drift apart.
      return describeVideoRefusal(reasonCode, serverMessage);
  }
}

/**
 * Read the gateway's answer to an edit.
 *
 * Same posture as the generation parser and for the same reason: a 200 that
 * carries no playable clip is a failure. The edit lane adds one honesty rule of
 * its own — the RESOLVED duration is taken from the source echo, because the
 * provider preserves length and reporting anything else would misprice the
 * artifact the user now owns.
 */
export function parseVideoEditResponse(status: number, raw: unknown): VideoEditOutcome {
  const body = isRecord(raw) ? raw : null;
  const serverReason = body && typeof body.reason === 'string' ? body.reason : '';
  const serverMessage = body && typeof body.message === 'string' ? body.message : undefined;

  if (status < 200 || status >= 300 || !body || body.ok !== true) {
    const reasonCode = serverReason || `http_${status}`;
    const described = describeVideoEditRefusal(reasonCode, serverMessage);
    return { ok: false, reasonCode, message: described.message, retryable: described.retryable };
  }

  const artifact = isRecord(body.artifact) ? body.artifact : null;
  const meta = isRecord(body.video_edit) ? body.video_edit : null;
  const dataBase64 = artifact && typeof artifact.data_base64 === 'string' ? artifact.data_base64 : '';
  const mimeType = artifact && typeof artifact.mime_type === 'string' ? artifact.mime_type : '';

  // `hasAsciiPrefix`, not `startsWith`: the semantic gate over this path bans
  // every string-matching primitive outright rather than trying to tell a shape
  // check from a keyword classifier, which a structural test cannot do.
  if (!artifact || !meta || dataBase64.length === 0 || !hasAsciiPrefix(mimeType, 'video/')) {
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
      resolution: getVideoTier(tierId).resolution,
      model: typeof meta.model === 'string' ? meta.model : '',
      tierId,
      durationSeconds: typeof meta.source_duration_seconds === 'number' ? meta.source_duration_seconds : 0,
      estimatedCredits: typeof meta.estimated_credits === 'number' ? meta.estimated_credits : 0,
    },
  };
}
