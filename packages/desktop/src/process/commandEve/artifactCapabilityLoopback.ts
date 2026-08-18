/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 C3 — the main-process side of the app-owned artifact capability.
 *
 * The doctrine is verbatim the one the managed image generator already proved
 * (`runtimeBootstrapCore.ts`): "an app-owned capability, not a user connector.
 * Hermes therefore receives it directly in its private 0600 config instead of
 * through the external-connector vault flag." Nothing here touches
 * `COMMAND_EVE_MCP_VAULT_ENABLED`, which gates a different path entirely.
 *
 * What crosses the loopback is a capability handle and an operation name. What
 * NEVER crosses it, in either direction, is a credential, a provider key, a
 * filesystem path or a base64 clip. The CEVE bearer, the credit authority and
 * the idempotency key all stay on this side.
 *
 * `eve_video_edit` is advertised DEFAULT-ON for an ELIGIBLE seat as of 1.820.2
 * (it shipped default-off in 1.820.1, behind the same opt-in posture the
 * gateway half keeps with `EVE_MULTIMODAL_ENABLE_XAI_VIDEO_EDIT`). ELIGIBLE
 * means the seat's CEVE licence wire is present and readable, and exactly `'0'`
 * in `COMMAND_EVE_ENABLE_AGENT_VIDEO_EDIT` is the kill-switch that closes even
 * an eligible seat. The decision is made ONCE, in `agentVideoEditFlag.ts`, and
 * every surface — this loopback, the envelope, the emitted child env — reads
 * that one resolver. The read operation is unaffected — it costs nothing and
 * cannot spend.
 *
 * The gate is checked HERE for a good message and AGAIN inside the shared paid
 * handler, which is where it actually binds. That is not belt-and-braces
 * decoration: the first build checked it only here, and the identical paid
 * handler was registered without any gate on the renderer IPC lane. A gate that
 * lives in one lane's wrapper is not a gate.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hydrateVideoArtifactPayload, isVideoArtifactEditable } from '@/common/config/videoGenerationRequestCore';
import {
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_MIME_TYPE,
  TYPED_UI_SCHEMA_VERSION,
  validateTypedUIEnvelope,
} from '@/common/typedUI';
import { handleCommandEveVideoEdit, handleCommandEveVideoGenerate } from '@process/bridge/commandEveVideoBridge';
import { handleCommandEveImageEdit } from '@process/bridge/commandEveImageArtifactBridge';
import { getDataPath } from '@process/utils/utils';
import {
  COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG,
  isAgentVideoEditAdvertisingEnabled,
  isAgentVideoEditEnabled,
  resolveAgentVideoEditAdvertisement,
} from './agentVideoEditFlag';
import { isAgentImageEditAdvertisingEnabled } from './agentImageEditFlag';
import { AGENT_VIDEO_GENERATE_DURATION_SECONDS, AGENT_VIDEO_GENERATE_TIER_ID } from './agentVideoGenerateFlag';
import { productionAgentVideoGenerateGate } from './agentVideoGenerateGateMain';
import { readArtifactCapabilityGrant } from './artifactCapabilityHandleStore';
import { getActiveSeatId } from './seatContextCore';
import { listVideoArtifactRecords } from './videoArtifactStore';
import { readImageArtifactRecordById } from './imageArtifactStore';
import {
  resolveCommandEveOfficeConversationAuthority,
  type CommandEveOfficeConversationAuthority,
} from './officeArtifactAttachmentCore';
import { verifyCanonicalArtifact } from '@process/services/project-workspace/storage/canonicalArtifactPlacement';

export {
  COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG,
  isAgentVideoEditAdvertisingEnabled,
  isAgentVideoEditEnabled,
  resolveAgentVideoEditAdvertisement,
};

const BEARER_FILE_NAME = 'artifact-capability-bearer';

let bootBearer = '';

/** A per-boot nonce protecting the loopback route. Same width as the shim token. */
export function ensureArtifactCapabilityBearer(): string {
  if (!bootBearer) bootBearer = crypto.randomBytes(32).toString('hex');
  return bootBearer;
}

export function resolveArtifactCapabilityBearer(): string {
  return bootBearer;
}

export function artifactCapabilityBearerFilePath(dataPath: string): string {
  return path.join(path.resolve(dataPath), 'command-eve-runtime', BEARER_FILE_NAME);
}

/**
 * File-deliver the per-boot bearer to the MCP child. Only the PATH enters the
 * child environment; the secret itself never appears in config.yaml or in an
 * inherited env var, exactly as the shim auth token is delivered.
 */
export function provisionArtifactCapabilityBearerFile(dataPath: string): string {
  const file = artifactCapabilityBearerFilePath(dataPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ensureArtifactCapabilityBearer(), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } catch {
    // Fail closed: no file means no bearer means the route stays a 404.
    return '';
  }
}

export interface ArtifactCapabilityLoopbackDeps {
  getDataPath: typeof getDataPath;
  listArtifactRecords: typeof listVideoArtifactRecords;
  readImageRecord?: typeof readImageArtifactRecordById;
  resolveWorkspace?: (conversationId: string) => Promise<CommandEveOfficeConversationAuthority>;
  readGrant: typeof readArtifactCapabilityGrant;
  /**
   * The seat a capability call is answered as. The loopback route is reached by
   * the agent, which never names a seat, so the ACTIVE seat is the only honest
   * authority — and it must be passed explicitly rather than defaulted, or a
   * forgotten argument would silently read every grant as the legacy seat.
   */
  getActiveSeatId?: typeof getActiveSeatId;
  videoEdit: typeof handleCommandEveVideoEdit;
  isVideoEditEnabled: () => boolean;
  /**
   * 1.820.3 — the managed IMAGE edit. Optional for the same reason every
   * MAT-1747 dep is optional: existing test literals must stay valid. Absent
   * falls back to the production handler and the production flag.
   */
  imageEdit?: typeof handleCommandEveImageEdit;
  isImageEditEnabled?: () => boolean;
  /**
   * CEVE-18205 — the paid video GENERATE. Optional for the same reason every
   * MAT-1747 dep is optional: existing test literals must stay valid. Absent
   * falls back to the production handler and the production gate.
   *
   * `isVideoGenerateEnabled` is ASYNC, unlike its two edit siblings, because the
   * release it reads is a PER-SEAT config value in the backend settings store —
   * an HTTP read, deliberately performed fresh per call so a flip takes effect on
   * the next call rather than at the next boot. See
   * `agentVideoGenerateSeatResolver.ts` for the fail-closed direction.
   */
  videoGenerate?: typeof handleCommandEveVideoGenerate;
  isVideoGenerateEnabled?: () => Promise<boolean>;
}

const productionDeps: ArtifactCapabilityLoopbackDeps = {
  getDataPath,
  listArtifactRecords: listVideoArtifactRecords,
  readImageRecord: readImageArtifactRecordById,
  resolveWorkspace: (conversationId) => resolveCommandEveOfficeConversationAuthority(conversationId),
  readGrant: readArtifactCapabilityGrant,
  getActiveSeatId,
  videoEdit: handleCommandEveVideoEdit,
  isVideoEditEnabled: () => isAgentVideoEditAdvertisingEnabled(getDataPath()),
  imageEdit: handleCommandEveImageEdit,
  isImageEditEnabled: () => isAgentImageEditAdvertisingEnabled(getDataPath()),
  videoGenerate: handleCommandEveVideoGenerate,
  isVideoGenerateEnabled: productionAgentVideoGenerateGate,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serve one capability call.
 *
 * Every branch returns a status AND a machine-readable reason, because the
 * caller is a model: "it did not work" teaches it to retry, while "this handle
 * is unknown" teaches it to ask the user which clip they mean.
 */
export async function artifactCapabilityCallHandler(
  body: unknown,
  deps: ArtifactCapabilityLoopbackDeps = productionDeps
): Promise<{ status: number; payload: unknown }> {
  if (!isRecord(body)) {
    return { status: 400, payload: { ok: false, reason: 'invalid-request' } };
  }
  const operation = typeof body.operation === 'string' ? body.operation : '';
  const handle = body.handle;

  if (operation === 'typed_ui_publish') {
    const validation = validateTypedUIEnvelope(body.envelope);
    if (!validation.ok) {
      return { status: 400, payload: { ok: false, reason: 'typed-ui-envelope-invalid' } };
    }
    return {
      status: 200,
      payload: {
        ok: true,
        artifact_type: 'file',
        mime_type: TYPED_UI_MIME_TYPE,
        schema_version: TYPED_UI_SCHEMA_VERSION,
        catalog_version: TYPED_UI_CATALOG_VERSION,
        content: JSON.stringify(validation.value),
      },
    };
  }

  if (operation === 'artifact_get') {
    const dataPath = deps.getDataPath();
    const grant = deps.readGrant(dataPath, handle, Date.now(), (deps.getActiveSeatId ?? getActiveSeatId)());
    if (!grant) return { status: 404, payload: { ok: false, reason: 'handle-unknown' } };
    const authority = await deps.resolveWorkspace?.(grant.conversation_id);
    const workspace =
      authority?.status === 'ready'
        ? authority.workspace
        : path.join(dataPath, 'command-eve-temp-artifacts', grant.conversation_id);
    if (grant.operation === 'image_edit') {
      const image = (deps.readImageRecord ?? readImageArtifactRecordById)(dataPath, grant.artifact_id, grant.seat_id);
      if (!image || image.status !== 'active' || !image.payload.path) {
        return { status: 404, payload: { ok: false, reason: 'artifact-missing' } };
      }
      const verified = verifyCanonicalArtifact({
        workspaceRoot: workspace,
        relativePath: image.payload.path,
        sha256: image.payload.sha256,
        size: image.payload.size,
      });
      if (verified.ok === false) {
        return {
          status: 409,
          payload: { ok: false, reason: 'artifact-changed', message: verified.message },
        };
      }
      return {
        status: 200,
        payload: {
          ok: true,
          artifact: {
            artifact_id: image.id,
            kind: 'image',
            mime_type: image.payload.mime_type,
            editable: true,
            ...(authority?.status === 'ready' ? { file_path: image.payload.path } : {}),
            ...(image.payload.cleanup_notice === undefined ? {} : { notice: image.payload.cleanup_notice }),
          },
        },
      };
    }
    const artifact = deps
      .listArtifactRecords(dataPath, grant.conversation_id, grant.seat_id)
      .find((record) => record.id === grant.artifact_id);
    if (!artifact) return { status: 404, payload: { ok: false, reason: 'artifact-missing' } };
    const payload = hydrateVideoArtifactPayload(artifact.payload);
    if (payload.relative_path) {
      const verified = verifyCanonicalArtifact({
        workspaceRoot: workspace,
        relativePath: payload.relative_path,
        sha256: payload.hash,
        size: payload.size,
      });
      if (verified.ok === false) {
        return {
          status: 409,
          payload: { ok: false, reason: 'artifact-changed', message: verified.message },
        };
      }
    }
    return {
      status: 200,
      payload: {
        ok: true,
        artifact: {
          artifact_id: artifact.id,
          kind: 'video',
          mime_type: payload.mime_type,
          duration_seconds: payload.duration_seconds,
          capability: payload.origin_capability,
          editable: isVideoArtifactEditable(payload),
          ...(authority?.status === 'ready' && payload.relative_path !== undefined
            ? { file_path: payload.relative_path }
            : {}),
          ...(payload.cleanup_notice === undefined ? {} : { notice: payload.cleanup_notice }),
          ...(payload.parent_artifact_id === undefined ? {} : { parent_artifact_id: payload.parent_artifact_id }),
        },
      },
    };
  }

  if (operation === 'video_edit') {
    if (!deps.isVideoEditEnabled()) {
      // 403, not 404: the capability exists and is deliberately closed. Saying
      // "unknown" would teach the model to retry a path that will never open on
      // its own.
      return { status: 403, payload: { ok: false, reason: 'agent-video-edit-disabled' } };
    }
    const instruction = typeof body.instruction === 'string' ? body.instruction : '';
    // The permit is REQUIRED and is not defaulted or repaired here. A missing
    // permit reaches the shared handler as `''` and is refused there, so the two
    // lanes cannot disagree about what an absent credential means.
    const permit = typeof body.permit === 'string' ? body.permit : '';
    const result = await deps.videoEdit({
      handle: typeof handle === 'string' ? handle : '',
      instruction,
      permit,
    });
    if (result.ok === false) {
      return { status: 400, payload: { ok: false, reason: result.reasonCode, message: result.message } };
    }
    return {
      status: 200,
      payload: {
        ok: true,
        artifact_id: result.conversationArtifact.id,
        parent_artifact_id: result.sourceArtifactId,
        // NO `media` line and NO path. `MEDIA: /Users/<name>/…` handed to a model
        // contradicts the envelope's own no-paths rule and ships the account name
        // to a third-party API. The clip is saved and reachable by artifact id;
        // the renderer resolves it from the local artifact store.
        //
        // CLOSED IN 1.821.0 — and the record of what it cost is kept here on
        // purpose. This comment used to end with an admitted, live display gap:
        // a clip finished through this lane was saved and then never shown,
        // because Main told nobody. Measured before the fix it was worse than
        // the admission said — `videoEdit` has ZERO renderer callers, so this
        // lane is not one path among two, it is the only way a video edit
        // happens, and the gap was every edit rather than an edge case.
        //
        // What closed it is NOT a path in this payload. The shared handler
        // (`handleCommandEveVideoEdit`, which both lanes funnel through) emits
        // `command-eve.image-artifacts-changed` with a conversation id and
        // nothing else, once, after the durable write and never on a refusal;
        // the renderer's existing handler reloads the artifact list and finds
        // the clip by id. The no-paths rule above therefore still holds by
        // construction, not by restraint — see `artifactsChangedEmitter.ts` and
        // `tests/unit/command-eve/videoEditDisplayRefresh.test.ts`.
        replayed: result.replayed === true,
      },
    };
  }

  if (operation === 'image_edit') {
    const isImageEditEnabled =
      deps.isImageEditEnabled ?? (() => isAgentImageEditAdvertisingEnabled(deps.getDataPath()));
    if (!isImageEditEnabled()) {
      // 403, not 404 — same doctrine as the video branch: the capability exists
      // and is deliberately closed, and "unknown" would teach the model to retry.
      return { status: 403, payload: { ok: false, reason: 'agent-image-edit-disabled' } };
    }
    const instruction = typeof body.instruction === 'string' ? body.instruction : '';
    // The permit is REQUIRED and is not defaulted or repaired here — a missing
    // permit reaches the shared handler as `''` and is refused there BEFORE the
    // grant read, so the two lanes cannot disagree about what an absent
    // credential means.
    const permit = typeof body.permit === 'string' ? body.permit : '';
    const imageEdit = deps.imageEdit ?? handleCommandEveImageEdit;
    const result = await imageEdit({
      handle: typeof handle === 'string' ? handle : '',
      instruction,
      permit,
    });
    if (result.ok === false) {
      return { status: 400, payload: { ok: false, reason: result.reasonCode, message: result.message } };
    }
    return {
      status: 200,
      payload: {
        ok: true,
        // The STAGED handle of the child — never a path, never bytes. The child
        // binds to the conversation through the same terminal flow as a fresh
        // generation, which is what puts its card in the chat.
        artifact_id: result.artifactHandle,
        parent_artifact_id: result.parentArtifactId,
      },
    };
  }

  if (operation === 'video_generate') {
    const isVideoGenerateEnabled = deps.isVideoGenerateEnabled ?? productionAgentVideoGenerateGate;
    // AWAITED, unlike the two edit gates: the release is a per-seat config value
    // read fresh from the backend settings store, so this is an HTTP round trip.
    // It is deliberately not cached — an operator who unticks the box closes the
    // tool on the very next call, not at the next boot.
    if (!(await isVideoGenerateEnabled())) {
      // 403, not 404 — same doctrine as the two edit branches: the capability
      // exists and is deliberately closed, and "unknown" would teach the model
      // to retry a path that will never open on its own.
      //
      // This branch is closed by DEFAULT, unlike the edit ones. See
      // `agentVideoGenerateFlag.ts`: generate has no turn-bound spend permit —
      // `handleCommandEveVideoGenerate` takes none and redeems none — so
      // nothing on this side bounds how many times a model may spend. The flag
      // is the whole containment until that permit exists.
      return { status: 403, payload: { ok: false, reason: 'agent-video-generate-disabled' } };
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.trim().length === 0) {
      return { status: 400, payload: { ok: false, reason: 'prompt-required' } };
    }

    // THE CONVERSATION IS OURS TO STATE, NEVER THE MODEL'S TO CLAIM.
    //
    // The handle store says it in its own words: "A handle must resolve without
    // anyone's claim about where it belongs — the grant it resolves to is what
    // states the conversation, and that statement is ours." So this branch takes
    // no `conversation_id` field. It resolves an opaque handle the model already
    // holds and reads the conversation off OUR grant. A `conversation_id`
    // parameter would let a model aim a paid render at any conversation whose id
    // it could guess or had seen, and bind the artifact there.
    //
    // THE COST OF THAT CHOICE, STATED RATHER THAN HIDDEN: a conversation with no
    // EVE artifact yet has no handle, so the agent cannot generate in it. The
    // first clip in any conversation still comes from the renderer lane, where a
    // human picks the tier in front of the price. That is a real product
    // limitation of this slice, not a solved problem — closing it needs the
    // envelope to mint a conversation-scoped generate grant, which is the same
    // change that would give this lane its missing spend permit.
    const grant = deps.readGrant(deps.getDataPath(), handle, Date.now(), (deps.getActiveSeatId ?? getActiveSeatId)());
    if (!grant) return { status: 404, payload: { ok: false, reason: 'handle-unknown' } };

    // The expensive axes are PINNED (see `agentVideoGenerateFlag.ts`): the model
    // names a prompt, never a tier, model, duration or resolution. Those live in
    // a server-owned frozen catalog the model cannot read and must not quote.
    const result = await (deps.videoGenerate ?? handleCommandEveVideoGenerate)({
      prompt,
      tierId: AGENT_VIDEO_GENERATE_TIER_ID,
      durationSeconds: AGENT_VIDEO_GENERATE_DURATION_SECONDS,
      conversationId: grant.conversation_id,
    });
    if (result.ok === false) {
      return { status: 400, payload: { ok: false, reason: result.reasonCode, message: result.message } };
    }
    // `conversationArtifact` is OPTIONAL on the success branch: the handler skips
    // the durable save rather than faking one. Reaching here without it means the
    // clip was rendered AND BILLED upstream but has no record to name, so the
    // honest answer is a distinct reason — not `ok: true` with a fabricated id,
    // and not `ok: false`, which would tell the user nothing was spent.
    if (!result.conversationArtifact) {
      return { status: 200, payload: { ok: true, artifact_id: null, reason: 'artifact-not-persisted' } };
    }
    return {
      status: 200,
      payload: {
        ok: true,
        // No `media` line and no path, for the reason the edit branch states at
        // length: a path handed to a model contradicts the envelope's no-paths
        // rule and ships the account name to a third-party API. The same known
        // display consequence applies — a clip produced through THIS lane does
        // not render inline in chat the way a renderer-lane one does.
        artifact_id: result.conversationArtifact.id,
      },
    };
  }

  return { status: 400, payload: { ok: false, reason: 'unsupported-operation' } };
}
