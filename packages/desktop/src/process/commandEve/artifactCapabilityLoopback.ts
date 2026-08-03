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
import { handleCommandEveVideoEdit } from '@process/bridge/commandEveVideoBridge';
import { getDataPath } from '@process/utils/utils';
import {
  COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG,
  isAgentVideoEditAdvertisingEnabled,
  isAgentVideoEditEnabled,
  resolveAgentVideoEditAdvertisement,
} from './agentVideoEditFlag';
import { readArtifactCapabilityGrant } from './artifactCapabilityHandleStore';
import { listVideoArtifactRecords } from './videoArtifactStore';

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
  readGrant: typeof readArtifactCapabilityGrant;
  videoEdit: typeof handleCommandEveVideoEdit;
  isVideoEditEnabled: () => boolean;
}

const productionDeps: ArtifactCapabilityLoopbackDeps = {
  getDataPath,
  listArtifactRecords: listVideoArtifactRecords,
  readGrant: readArtifactCapabilityGrant,
  videoEdit: handleCommandEveVideoEdit,
  isVideoEditEnabled: () => isAgentVideoEditAdvertisingEnabled(getDataPath()),
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

  if (operation === 'artifact_get') {
    const dataPath = deps.getDataPath();
    const grant = deps.readGrant(dataPath, handle);
    if (!grant) return { status: 404, payload: { ok: false, reason: 'handle-unknown' } };
    const artifact = deps
      .listArtifactRecords(dataPath, grant.conversation_id)
      .find((record) => record.id === grant.artifact_id);
    if (!artifact) return { status: 404, payload: { ok: false, reason: 'artifact-missing' } };
    const payload = hydrateVideoArtifactPayload(artifact.payload);
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
          // No path and no bytes. A model that can name a path can ask for one.
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
        // KNOWN CONSEQUENCE, stated rather than hidden: a clip produced through
        // THIS lane does not render inline in the chat the way one produced
        // through the renderer lane does. It used to regress nothing because the
        // paid path shipped default-off; since 1.820.2 eligible seats reach this
        // lane by default, so the gap is live — an open display gap, not a
        // solved problem.
        replayed: result.replayed === true,
      },
    };
  }

  return { status: 400, payload: { ok: false, reason: 'unsupported-operation' } };
}
