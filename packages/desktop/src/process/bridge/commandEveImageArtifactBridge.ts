/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — Main-process bridge for MANAGED IMAGE artifacts.
 *
 * The image counterpart of `commandEveVideoBridge.ts`, covering the four things
 * the staged-handle contract needs Main to own:
 *
 *   - BIND: the renderer read the staged handle out of the finished turn's tool
 *     output; this is where display authority is granted (staged -> active,
 *     conversation set, durable edit grant minted);
 *   - LIST/PREVIEW: the durable records the renderer merges into its artifact
 *     provider, and the private bytes behind them — by artifact id, never by
 *     path, with the SHA-256 re-verified on every read;
 *   - IMPORT: the one-time, strictly confined adoption of the pre-contract P1
 *     proof file;
 *   - EDIT: the paid lane. Handle + permit, mirroring `handleCommandEveVideoEdit`
 *     guard for guard, but the provider call goes through the MANAGED IMAGE
 *     service (receipt-verified, reference-capable tier resolved request-side)
 *     and the result is STAGED, not activated — the child binds through the
 *     same terminal flow as a fresh generation.
 *
 * What NEVER leaves this file: a filesystem path, provider bytes in clear, the
 * licence wire. The loopback payload names an artifact handle and a parent id
 * and nothing else.
 *
 * NAMED `commandEveImageArtifactBridge` because `commandEveImageBridge.ts`
 * already exists and owns the image-PREPARE (vision) lane — a different
 * feature on the same noun.
 */

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_EVE_MANAGED_IMAGE_MODEL } from '@/common/config/eveManagedImageGenerationCore';
import { describeArtifactCapabilityRefusal } from '@process/commandEve/artifactCapabilityRefusalCopy';
import { isSha256Hex } from '@/common/config/eveOpaqueTokenCore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';
import type {
  CommandEveManagedArtifactInputRequest,
  CommandEveManagedArtifactInputResolution,
} from '@/common/config/managedArtifactInputCore';
import { getDataPath } from '@process/utils/utils';
import { isAgentImageEditAdvertisingEnabled } from '@process/commandEve/agentImageEditFlag';
import {
  readArtifactCapabilityGrant,
  resolveImageEditCapability,
} from '@process/commandEve/artifactCapabilityHandleStore';
import {
  bindStagedImageArtifact,
  findRecoverableStagedImageEditArtifact,
  importLegacyImageArtifact,
  listActiveImageArtifacts,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  readImageArtifactRecordByStagedHandle,
  type ImageArtifactBindResult,
  type ImageArtifactImportResult,
} from '@process/commandEve/imageArtifactStore';
import {
  executeCommandEveManagedImageGeneration,
  type CommandEveManagedImageLocalResult,
} from '@process/commandEve/managedImageGenerationService';
import {
  getActiveSeatContextRevision,
  getActiveSeatId,
  getCommandEvePaidArtifactBlockReason,
  tryBeginCommandEvePaidArtifactOperation,
} from '@process/commandEve/seatContextCore';
import {
  acquireVideoEditInflightLock,
  releaseVideoEditInflightLock,
} from '@process/commandEve/videoEditSpendPermitStore';
import {
  resolveCommandEveOfficeConversationAuthority,
  type CommandEveOfficeConversationAuthority,
} from '@process/commandEve/officeArtifactAttachmentCore';
import {
  resolveCommandEveManagedArtifactInput,
  type CommandEveManagedArtifactInputResolverDeps,
} from '@process/commandEve/managedArtifactInputResolver';
import { registerCommandEveFileSelectionGrant } from '@process/commandEve/fileSelectionGrantCore';
import {
  publishCanonicalArtifact,
  verifyCanonicalArtifact,
} from '@process/services/project-workspace/storage/canonicalArtifactPlacement';
import { readApprovedGeneratedArtifactPreview } from '@process/bridge/generatedArtifactPreviewCore';

// ---------------------------------------------------------------------------
// BIND — display authority, granted at the end of the turn that produced it
// ---------------------------------------------------------------------------

export interface CommandEveImageArtifactBindRequest {
  conversationId?: string;
  handle?: string;
  toolCallId?: string;
}

export interface CommandEveImageArtifactBindDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId?: typeof getActiveSeatId;
  bind?: typeof bindStagedImageArtifact;
  resolveWorkspace?: (conversationId: string) => Promise<CommandEveOfficeConversationAuthority>;
  /**
   * 1.820.3 same-turn insertion: invoked with the canonical conversation id
   * after a FRESH bind (never on alreadyBound/refusal) so Main can notify the
   * renderer — renderer-side turn events have proven unreliable on this lane
   * for triggering the render refresh, the store-level bind is the one
   * trigger that cannot be missed.
   */
  onFreshBind?: (conversationId: string) => void;
}

const productionBindDeps: CommandEveImageArtifactBindDeps = {
  getDataPath,
  getActiveSeatId,
  bind: bindStagedImageArtifact,
  resolveWorkspace: (conversationId) => resolveCommandEveOfficeConversationAuthority(conversationId),
};

/**
 * Bind a staged image to its conversation. Never throws and never blocks the
 * turn's `finish`: a refusal here costs the inline card, not the message.
 */
export async function handleCommandEveImageArtifactBind(
  request?: CommandEveImageArtifactBindRequest,
  deps: CommandEveImageArtifactBindDeps = productionBindDeps
): Promise<ImageArtifactBindResult> {
  const conversationId = request?.conversationId;
  const toolCallId = request?.toolCallId;
  if (typeof conversationId !== 'string' || conversationId.length === 0)
    return { ok: false, reason: 'handle-malformed' };
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return { ok: false, reason: 'handle-malformed' };
  try {
    const expectedSeatId = (deps.getActiveSeatId ?? getActiveSeatId)();
    const authority = await deps.resolveWorkspace?.(conversationId);
    if (authority?.status === 'refused') return { ok: false, reason: 'artifact-missing' };
    const result = (deps.bind ?? bindStagedImageArtifact)(deps.getDataPath(), {
      conversationId,
      handle: request?.handle,
      toolCallId,
      expectedSeatId,
      ...(authority?.status === 'ready' ? { workspaceRoot: authority.workspace } : {}),
    });
    if (result.ok && !result.alreadyBound) {
      // Best-effort, isolated: a throwing notifier must NEVER turn a
      // successful bind into `artifact-missing` — the record IS active, and a
      // retry would read alreadyBound and never notify again.
      try {
        deps.onFreshBind?.(conversationId);
      } catch {
        /* the bind stands; the render refresh has the terminal relay behind it */
      }
    }
    return result;
  } catch {
    return { ok: false, reason: 'artifact-missing' };
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactBind`. */
export async function handleCommandEveImageArtifactBindBridge(
  request?: CommandEveImageArtifactBindRequest,
  deps: CommandEveImageArtifactBindDeps = productionBindDeps
): Promise<{ success: true; data: ImageArtifactBindResult }> {
  return { success: true, data: await handleCommandEveImageArtifactBind(request, deps) };
}

// ---------------------------------------------------------------------------
// LIST — the durable records the renderer merges into its artifact provider
// ---------------------------------------------------------------------------

export interface CommandEveImageArtifactsListDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId?: typeof getActiveSeatId;
  getActiveSeatContextRevision?: typeof getActiveSeatContextRevision;
  listRecords?: typeof listActiveImageArtifacts;
  /**
   * 1.820.3 load recovery: a best-effort durable reconcile that binds any
   * staged handle the volatile renderer path missed (the R2 orphan class)
   * BEFORE the list is served. Optional so unit tests can isolate the list;
   * production wires the Main transcript reconcile from commandEveBridge.
   * Never throws into the list.
   */
  reconcileBeforeList?: (
    conversationId: string,
    expectedSeatId: string,
    expectedSeatContextRevision: number
  ) => Promise<unknown>;
}

const productionListDeps: CommandEveImageArtifactsListDeps = {
  getDataPath,
  getActiveSeatId,
  getActiveSeatContextRevision,
  listRecords: listActiveImageArtifacts,
};

/**
 * Every ACTIVE managed image this desktop holds for a conversation. The payload
 * carries NO path by construction (`managedImageArtifactCore.ts`), so what the
 * renderer receives can be merged into its artifact provider verbatim.
 */
export async function handleCommandEveImageArtifactsList(
  request?: { conversationId?: string },
  deps: CommandEveImageArtifactsListDeps = productionListDeps
): Promise<CommandEveActiveImageArtifact[]> {
  if (!request || typeof request.conversationId !== 'string' || request.conversationId.length === 0) return [];
  try {
    const readSeatId = deps.getActiveSeatId ?? getActiveSeatId;
    const readSeatRevision = deps.getActiveSeatContextRevision ?? getActiveSeatContextRevision;
    const expectedSeatId = readSeatId();
    const expectedSeatContextRevision = readSeatRevision();
    // Load recovery first: an orphan staged child binds idempotently, then the
    // list below already contains it. A reconcile failure costs nothing here.
    if (deps.reconcileBeforeList) {
      await deps
        .reconcileBeforeList(request.conversationId, expectedSeatId, expectedSeatContextRevision)
        .catch((): undefined => undefined);
    }
    if (readSeatId() !== expectedSeatId || readSeatRevision() !== expectedSeatContextRevision) {
      return [];
    }
    return (deps.listRecords ?? listActiveImageArtifacts)(deps.getDataPath(), request.conversationId, expectedSeatId);
  } catch {
    return [];
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactsList`. */
export async function handleCommandEveImageArtifactsListBridge(
  request?: { conversationId?: string },
  deps: CommandEveImageArtifactsListDeps = productionListDeps
): Promise<{ success: true; data: CommandEveActiveImageArtifact[] }> {
  return { success: true, data: await handleCommandEveImageArtifactsList(request, deps) };
}

// ---------------------------------------------------------------------------
// PREVIEW — the private bytes, by artifact id, hash re-verified on every read
// ---------------------------------------------------------------------------

export type CommandEveImageArtifactPreview = {
  data_base64: string;
  mime_type: string;
  size: number;
};

export interface CommandEveImageArtifactPreviewDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId?: typeof getActiveSeatId;
  readRecord?: typeof readImageArtifactRecordById;
  readBytes?: typeof readImageArtifactBytes;
}

const productionPreviewDeps: CommandEveImageArtifactPreviewDeps = {
  getDataPath,
  getActiveSeatId,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
};

// ---------------------------------------------------------------------------
// AGENT INPUT — one conversation-bound managed image as a private agent file
// ---------------------------------------------------------------------------

export interface CommandEveImageArtifactInputResolveDeps extends CommandEveManagedArtifactInputResolverDeps {}

const productionArtifactInputResolveDeps: CommandEveImageArtifactInputResolveDeps = {
  getDataPath,
  getActiveSeatId,
  getActiveSeatContextRevision,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
  resolveConversationAuthority: resolveCommandEveOfficeConversationAuthority,
  publishCanonicalArtifact,
  verifyCanonicalArtifact,
  registerFileSelectionGrant: registerCommandEveFileSelectionGrant,
  readGeneratedArtifactPreview: readApprovedGeneratedArtifactPreview,
  getDownloadsRoot: () => path.join(os.homedir(), 'Downloads'),
  getBackendPort: () => (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort,
  fetch: (input, init) => globalThis.fetch(input, init),
};

export async function handleCommandEveImageArtifactInputResolve(
  request?: CommandEveManagedArtifactInputRequest,
  deps: CommandEveImageArtifactInputResolveDeps = productionArtifactInputResolveDeps
): Promise<CommandEveManagedArtifactInputResolution> {
  return await resolveCommandEveManagedArtifactInput(request, deps);
}

/** IPC-facing resolver for `ipcBridge.commandEve.artifactInputResolve`. */
export async function handleCommandEveImageArtifactInputResolveBridge(
  request?: CommandEveManagedArtifactInputRequest,
  deps: CommandEveImageArtifactInputResolveDeps = productionArtifactInputResolveDeps
): Promise<{ success: true; data: CommandEveManagedArtifactInputResolution }> {
  return { success: true, data: await handleCommandEveImageArtifactInputResolve(request, deps) };
}

/**
 * The renderer's ONLY window onto the private blob. Three independent checks,
 * all cheap and all before a byte crosses the bridge: the record exists and is
 * ACTIVE, it belongs to the conversation the caller named, and the bytes read
 * back hash to exactly what the record claims — a blob that changed underneath
 * us is served to nobody.
 */
export async function handleCommandEveImageArtifactPreview(
  request?: { conversationId?: string; artifactId?: string },
  deps: CommandEveImageArtifactPreviewDeps = productionPreviewDeps
): Promise<CommandEveImageArtifactPreview | null> {
  const conversationId = request?.conversationId;
  const artifactId = request?.artifactId;
  if (typeof conversationId !== 'string' || typeof artifactId !== 'string' || !conversationId || !artifactId) {
    return null;
  }
  try {
    const dataPath = deps.getDataPath();
    const expectedSeatId = (deps.getActiveSeatId ?? getActiveSeatId)();
    const record = (deps.readRecord ?? readImageArtifactRecordById)(dataPath, artifactId, expectedSeatId);
    if (!record || record.status !== 'active' || record.conversation_id !== conversationId) return null;
    const bytes = (deps.readBytes ?? readImageArtifactBytes)(dataPath, artifactId, expectedSeatId);
    if (!bytes) return null;
    const observed = crypto.createHash('sha256').update(bytes).digest('hex');
    if (observed !== record.payload.sha256) return null;
    return {
      data_base64: bytes.toString('base64'),
      mime_type: record.payload.mime_type,
      size: bytes.length,
    };
  } catch {
    return null;
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactPreview`. */
export async function handleCommandEveImageArtifactPreviewBridge(
  request?: { conversationId?: string; artifactId?: string },
  deps: CommandEveImageArtifactPreviewDeps = productionPreviewDeps
): Promise<{ success: true; data: CommandEveImageArtifactPreview | null }> {
  return { success: true, data: await handleCommandEveImageArtifactPreview(request, deps) };
}

// ---------------------------------------------------------------------------
// LEGACY IMPORT — the one-time, strictly confined adoption of the P1 proof file
// ---------------------------------------------------------------------------

export interface CommandEveImageArtifactImportLegacyDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId?: typeof getActiveSeatId;
  /**
   * The legacy workspace root for a WORKSPACE FOLDER id. Injectable so tests
   * point at a temp fixture; production is the pre-contract image lane's one
   * save location, `~/Developer/conversations/<legacyWorkspaceId>`.
   */
  workspaceRootForLegacyId?: (legacyWorkspaceId: string) => string;
  importLegacy?: typeof importLegacyImageArtifact;
}

const productionImportDeps: CommandEveImageArtifactImportLegacyDeps = {
  getDataPath,
  getActiveSeatId,
  workspaceRootForLegacyId: (legacyWorkspaceId) =>
    path.join(os.homedir(), 'Developer', 'conversations', legacyWorkspaceId),
  importLegacy: importLegacyImageArtifact,
};

/**
 * Adopt the pre-contract P1 proof file. `conversationId` is the CANONICAL
 * conversation the record binds to (and renders under); `legacyWorkspaceId`
 * is the Hermes workspace folder the file actually lives in, and the store
 * refuses anything but the exact `hermes-temp-<canonical>` shape.
 */
export async function handleCommandEveImageArtifactImportLegacy(
  request?: { conversationId?: string; legacyWorkspaceId?: string; expectedFileName?: string },
  deps: CommandEveImageArtifactImportLegacyDeps = productionImportDeps
): Promise<ImageArtifactImportResult> {
  const conversationId = request?.conversationId;
  const legacyWorkspaceId = request?.legacyWorkspaceId;
  const expectedFileName = request?.expectedFileName;
  if (
    typeof conversationId !== 'string' ||
    conversationId.length === 0 ||
    typeof legacyWorkspaceId !== 'string' ||
    legacyWorkspaceId.length === 0 ||
    typeof expectedFileName !== 'string' ||
    expectedFileName.length === 0
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  try {
    const capturedSeatId = (deps.getActiveSeatId ?? getActiveSeatId)();
    return (deps.importLegacy ?? importLegacyImageArtifact)(deps.getDataPath(), {
      conversationId,
      legacyWorkspaceId,
      expectedFileName,
      workspaceRoot: (deps.workspaceRootForLegacyId ?? productionImportDeps.workspaceRootForLegacyId!)(
        legacyWorkspaceId
      ),
      capturedSeatId,
    });
  } catch {
    return { ok: false, reason: 'file-unreadable' };
  }
}

/** IPC-facing envelope matching `ipcBridge.commandEve.imageArtifactImportLegacy`. */
export async function handleCommandEveImageArtifactImportLegacyBridge(
  request?: { conversationId?: string; legacyWorkspaceId?: string; expectedFileName?: string },
  deps: CommandEveImageArtifactImportLegacyDeps = productionImportDeps
): Promise<{ success: true; data: ImageArtifactImportResult }> {
  return { success: true, data: await handleCommandEveImageArtifactImportLegacy(request, deps) };
}

// ---------------------------------------------------------------------------
// EDIT — the paid lane. Handle + permit; the child is STAGED, never activated
// ---------------------------------------------------------------------------

/** Mirrors the video lane's 2000-character instruction ceiling. */
export const MAX_IMAGE_EDIT_INSTRUCTION_CHARS = 2000;

export interface CommandEveImageEditRequest {
  handle?: string;
  instruction?: string;
  /** Hermes-owned MCP logicalCallId, forwarded internally by the MCP child. */
  requestId?: string;
  /** Optional fence only — never consulted as authority. */
  conversationId?: string;
}

export type CommandEveImageEditResult =
  | {
      ok: true;
      /** The STAGED handle of the child image — it binds via the same terminal flow as a generation. */
      artifactHandle: string;
      parentArtifactId: string;
    }
  | { ok: false; reasonCode: string; message: string; retryable: boolean };

export interface CommandEveImageEditDeps {
  getDataPath: typeof getDataPath;
  getActiveSeatId?: typeof getActiveSeatId;
  getActiveSeatContextRevision?: typeof getActiveSeatContextRevision;
  getPaidArtifactBlockReason?: typeof getCommandEvePaidArtifactBlockReason;
  tryBeginPaidArtifactOperation?: typeof tryBeginCommandEvePaidArtifactOperation;
  isImageEditEnabled?: () => boolean;
  readGrant?: typeof readArtifactCapabilityGrant;
  resolveCapability?: typeof resolveImageEditCapability;
  readRecord?: typeof readImageArtifactRecordById;
  readBytes?: typeof readImageArtifactBytes;
  readRecordByStagedHandle?: typeof readImageArtifactRecordByStagedHandle;
  findRecoverableStagedEdit?: typeof findRecoverableStagedImageEditArtifact;
  acquireInflightLock?: typeof acquireVideoEditInflightLock;
  releaseInflightLock?: typeof releaseVideoEditInflightLock;
  /**
   * The managed image service call, injected so tests can spy on EXACTLY what
   * reaches the provider lane — and prove the refusal order by what the spy
   * never saw.
   */
  runManagedEdit?: (input: {
    instruction: string;
    referenceDataUrl: string;
    parentArtifactId: string;
    dataPath: string;
    expectedSeat: { id: string; revision: number };
    requestId: string;
  }) => Promise<CommandEveManagedImageLocalResult>;
}

const productionEditDeps: CommandEveImageEditDeps = {
  getDataPath,
  getActiveSeatId,
  getActiveSeatContextRevision,
  getPaidArtifactBlockReason: getCommandEvePaidArtifactBlockReason,
  tryBeginPaidArtifactOperation: tryBeginCommandEvePaidArtifactOperation,
  isImageEditEnabled: () => isAgentImageEditAdvertisingEnabled(getDataPath()),
  readGrant: readArtifactCapabilityGrant,
  resolveCapability: resolveImageEditCapability,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
  readRecordByStagedHandle: readImageArtifactRecordByStagedHandle,
  findRecoverableStagedEdit: findRecoverableStagedImageEditArtifact,
  acquireInflightLock: acquireVideoEditInflightLock,
  releaseInflightLock: releaseVideoEditInflightLock,
  runManagedEdit: ({ instruction, referenceDataUrl, parentArtifactId, dataPath, expectedSeat, requestId }) =>
    executeCommandEveManagedImageGeneration(
      {
        model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
        prompt: instruction,
        n: 1,
        input_references: [{ type: 'image_url', image_url: { url: referenceDataUrl } }],
      },
      {
        dataPath,
        expectedSeat,
        getActiveSeatId,
        getActiveSeatContextRevision,
        requestId,
        stagedParentArtifactId: parentArtifactId,
      }
    ),
};

function refuseEdit(reasonCode: string, message: string, retryable = false): CommandEveImageEditResult {
  return { ok: false, reasonCode, message, retryable };
}

/**
 * Edit a managed image the user already has.
 *
 * The `handle` names the source image through Main's existing capability
 * checks. Hermes' native ACP approval is the only user-facing approval layer;
 * its opaque logical call id is a stable recovery identity, never a credential
 * visible to the model. The guard order is:
 * flag -> instruction + logical id -> grant -> caller conversation fence ->
 * artifact -> bytes -> hash match -> staged-child recovery -> in-flight lock ->
 * managed service.
 *
 * The result is STAGED with `parent_artifact_id` set and its own fresh staged
 * handle; the source record and its bytes are never touched. The child becomes
 * visible through the SAME terminal bind as a fresh generation — Main does not
 * shortcut display authority just because it holds spend authority.
 */
export async function handleCommandEveImageEdit(
  request?: CommandEveImageEditRequest,
  deps: CommandEveImageEditDeps = productionEditDeps
): Promise<CommandEveImageEditResult> {
  // THE flag gate, in the shared handler rather than in one lane's wrapper —
  // the lesson the video lane learned the expensive way.
  const paidEnabled = (deps.isImageEditEnabled ?? (() => isAgentImageEditAdvertisingEnabled(deps.getDataPath())))();
  if (!paidEnabled) {
    return refuseEdit(
      'image-edit-disabled',
      'Das Bearbeiten von Bildern ist auf diesem Platz noch nicht freigeschaltet.'
    );
  }

  const instruction = typeof request?.instruction === 'string' ? request.instruction.trim() : '';
  if (!request || instruction.length === 0 || instruction.length > MAX_IMAGE_EDIT_INSTRUCTION_CHARS) {
    return refuseEdit('image-edit-request-invalid', 'Sag kurz, was am Bild geändert werden soll.');
  }
  const requestId = request.requestId;
  if (!isSha256Hex(requestId)) {
    return refuseEdit(
      'image-edit-request-identity-missing',
      'Die Bildbearbeitung hat keine gültige Hermes-Aufrufkennung erhalten.'
    );
  }

  const readSeatId = deps.getActiveSeatId ?? getActiveSeatId;
  const readSeatRevision = deps.getActiveSeatContextRevision ?? getActiveSeatContextRevision;
  let dataPath: string;
  let capturedSeatId: string;
  let capturedSeatContextRevision: number;
  try {
    dataPath = deps.getDataPath();
    capturedSeatId = readSeatId();
    capturedSeatContextRevision = readSeatRevision();
  } catch {
    return refuseEdit('image-edit-seat-unavailable', 'Der aktive Seed konnte nicht sicher bestimmt werden.', true);
  }
  const seatStillMatches = (): boolean => {
    try {
      return readSeatId() === capturedSeatId && readSeatRevision() === capturedSeatContextRevision;
    } catch {
      return false;
    }
  };
  const readGrant = deps.readGrant ?? readArtifactCapabilityGrant;
  const resolveCapability = deps.resolveCapability ?? resolveImageEditCapability;
  const readRecord = deps.readRecord ?? readImageArtifactRecordById;
  const readBytes = deps.readBytes ?? readImageArtifactBytes;
  const readStagedRecord = deps.readRecordByStagedHandle ?? readImageArtifactRecordByStagedHandle;
  const findRecoverableStagedEdit = deps.findRecoverableStagedEdit ?? findRecoverableStagedImageEditArtifact;
  const acquireLock = deps.acquireInflightLock ?? acquireVideoEditInflightLock;
  const releaseLock = deps.releaseInflightLock ?? releaseVideoEditInflightLock;

  // The grant is read FIRST so the artifact identity comes from OUR record,
  // never from anything the caller supplied.
  const grant = readGrant(dataPath, request.handle, Date.now(), capturedSeatId);
  if (!grant) {
    return refuseEdit(
      'image-edit-handle-unknown',
      await describeArtifactCapabilityRefusal({ operation: 'image_edit', reason: 'handle-unknown' })
    );
  }
  if (grant.operation !== 'image_edit') {
    return refuseEdit(
      'image-edit-operation-mismatch',
      await describeArtifactCapabilityRefusal({ operation: 'image_edit', reason: 'operation-mismatch' })
    );
  }
  if (grant.seat_id !== capturedSeatId) {
    return refuseEdit(
      'image-edit-handle-unknown',
      await describeArtifactCapabilityRefusal({ operation: 'image_edit', reason: 'handle-unknown' })
    );
  }
  if (request.conversationId !== undefined && request.conversationId !== grant.conversation_id) {
    return refuseEdit(
      'image-edit-conversation-mismatch',
      await describeArtifactCapabilityRefusal({ operation: 'image_edit', reason: 'conversation-mismatch' })
    );
  }

  const source = readRecord(dataPath, grant.artifact_id, capturedSeatId);
  if (!source || source.status !== 'active' || source.conversation_id !== grant.conversation_id) {
    return refuseEdit('image-edit-source-missing', 'Das Ausgangsbild ist nicht mehr vorhanden.');
  }

  const sourceBytes = readBytes(dataPath, source.id, capturedSeatId);
  if (!sourceBytes) {
    return refuseEdit(
      'image-edit-artifact-changed',
      'Die Bilddatei hat sich seit dem Erstellen geändert — die Bearbeitung wurde abgebrochen.'
    );
  }

  // Hash what we ACTUALLY read, then judge the handle against that — the same
  // time-of-check/time-of-use discipline as the video lane.
  const observedArtifactSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const capability = resolveCapability(dataPath, {
    handle: request.handle,
    observedArtifactSha256,
    expectedSeatId: capturedSeatId,
    expectedConversationId: grant.conversation_id,
  });
  if (capability.ok === false) {
    return refuseEdit(
      `image-edit-${capability.reason}`,
      await describeArtifactCapabilityRefusal({ operation: 'image_edit', reason: capability.reason })
    );
  }

  const editRequestSha256 = requestId;
  const exactStagedChild = (
    artifactHandle: unknown,
    expectedArtifactId?: string
  ): { artifactHandle: string; artifactId: string } | undefined => {
    if (typeof artifactHandle !== 'string') return undefined;
    const child = readStagedRecord(dataPath, artifactHandle, capturedSeatId);
    if (
      !child ||
      (expectedArtifactId !== undefined && child.id !== expectedArtifactId) ||
      child.seat_id !== capturedSeatId ||
      child.status !== 'staged' ||
      child.conversation_id !== null ||
      child.payload.parent_artifact_id !== source.id ||
      child.payload.edit_request_sha256 !== editRequestSha256 ||
      !readBytes(dataPath, child.id, capturedSeatId)
    ) {
      return undefined;
    }
    return { artifactHandle, artifactId: child.id };
  };
  // A provider response can be lost after the managed service staged the child.
  // Recover that exact logical call before acquiring another operation lock or
  // asking the gateway again.
  const stagedRecovery = findRecoverableStagedEdit(dataPath, {
    expectedSeatId: capturedSeatId,
    parentArtifactId: source.id,
    editRequestSha256,
  });
  if (stagedRecovery) {
    const recovered = exactStagedChild(stagedRecovery.handle, stagedRecovery.record.id);
    if (!recovered || !seatStillMatches()) {
      return refuseEdit(
        'image-edit-result-unavailable',
        'Das bereits bezahlte Bearbeitungsergebnis konnte nicht eindeutig geprüft werden. Es wurde nichts erneut berechnet.'
      );
    }
    return { ok: true, artifactHandle: recovered.artifactHandle, parentArtifactId: source.id };
  }

  if (!seatStillMatches()) {
    return refuseEdit(
      'image-edit-seat-changed',
      'Der aktive Seed wurde während der Vorbereitung gewechselt. Starte die Bildbearbeitung erneut.',
      true
    );
  }
  const paidArtifactBlockReason = (deps.getPaidArtifactBlockReason ?? getCommandEvePaidArtifactBlockReason)();
  if (paidArtifactBlockReason === 'seat_recovery_required') {
    return refuseEdit(
      'image-edit-seat-recovery-required',
      'Der letzte Seed-Wechsel wurde nicht abgeschlossen. Starte Command EVE neu, bevor du die Bildbearbeitung erneut versuchst.'
    );
  }
  if (paidArtifactBlockReason === 'seat_transition_in_progress') {
    return refuseEdit(
      'image-edit-seat-changed',
      'Der aktive Seed wird gerade gewechselt. Starte die Bildbearbeitung danach erneut.',
      true
    );
  }
  const releasePaidArtifactOperation = (
    deps.tryBeginPaidArtifactOperation ?? tryBeginCommandEvePaidArtifactOperation
  )();
  if (!releasePaidArtifactOperation) {
    return refuseEdit(
      'image-edit-seat-changed',
      'Der aktive Seed wird gerade gewechselt. Starte die Bildbearbeitung danach erneut.',
      true
    );
  }

  // At most ONE paid edit in flight per conversation — shared with the video
  // lane, because two native tool calls in the same breath must not overlap.
  let conversationLockAcquired = false;
  try {
    conversationLockAcquired = acquireLock(dataPath, grant.conversation_id);
  } catch {
    releasePaidArtifactOperation();
    return refuseEdit(
      'image-edit-lock-unavailable',
      'Die Bildbearbeitung konnte nicht exklusiv gesperrt werden.',
      true
    );
  }
  if (!conversationLockAcquired) {
    releasePaidArtifactOperation();
    return refuseEdit(
      'image-edit-already-in-flight',
      'Für diese Unterhaltung läuft bereits eine Bildbearbeitung.',
      true
    );
  }

  try {
    const managed = await (deps.runManagedEdit ?? productionEditDeps.runManagedEdit!)({
      instruction,
      referenceDataUrl: `data:${source.payload.mime_type};base64,${sourceBytes.toString('base64')}`,
      parentArtifactId: source.id,
      dataPath,
      expectedSeat: { id: capturedSeatId, revision: capturedSeatContextRevision },
      requestId,
    });
    if (!seatStillMatches()) {
      return refuseEdit(
        'image-edit-seat-changed',
        'Der aktive Seed wurde während der Bildbearbeitung gewechselt. Das Ergebnis bleibt dem ursprünglichen Seed zugeordnet.',
        false
      );
    }
    if (managed.status !== 200) {
      const error = managed.body.error as { code?: unknown; message?: unknown } | undefined;
      const code = error && typeof error.code === 'string' ? error.code : 'managed_image_failed';
      const message =
        error && typeof error.message === 'string' ? error.message : 'Die Bildbearbeitung ist fehlgeschlagen.';
      return refuseEdit(`image-edit-${code}`, message, false);
    }
    const data = Array.isArray(managed.body.data)
      ? (managed.body.data[0] as Record<string, unknown> | undefined)
      : undefined;
    const artifactHandle = data && typeof data.artifact_handle === 'string' ? data.artifact_handle : '';
    if (!artifactHandle) {
      return refuseEdit(
        'image-edit-stage-failed',
        'Das bearbeitete Bild wurde erstellt, konnte aber nicht lokal gespeichert werden.'
      );
    }
    const stagedChild = exactStagedChild(artifactHandle);
    if (!stagedChild) {
      return refuseEdit(
        'image-edit-stage-failed',
        'Das bearbeitete Bild wurde erstellt, konnte aber nicht als exaktes lokales Ergebnis bestätigt werden.',
        true
      );
    }
    // PATH-FREE by construction: the staged handle and the parent id are the
    // whole answer. The child binds through the terminal flow, exactly like a
    // fresh generation.
    return { ok: true, artifactHandle: stagedChild.artifactHandle, parentArtifactId: source.id };
  } finally {
    try {
      releaseLock(dataPath, grant.conversation_id);
    } finally {
      releasePaidArtifactOperation();
    }
  }
}
