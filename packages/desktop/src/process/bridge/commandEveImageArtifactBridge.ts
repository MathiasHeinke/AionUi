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
import { describeArtifactCapabilityRefusal } from '@/common/config/eveArtifactCapabilityHandleCore';
import { describeSpendPermitRefusal } from '@/common/config/eveVideoEditSpendPermitCore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';
import { getDataPath } from '@process/utils/utils';
import { isAgentImageEditAdvertisingEnabled } from '@process/commandEve/agentImageEditFlag';
import {
  readArtifactCapabilityGrant,
  resolveImageEditCapability,
} from '@process/commandEve/artifactCapabilityHandleStore';
import {
  bindStagedImageArtifact,
  importLegacyImageArtifact,
  listActiveImageArtifacts,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  type ImageArtifactBindResult,
  type ImageArtifactImportResult,
} from '@process/commandEve/imageArtifactStore';
import {
  executeCommandEveManagedImageGeneration,
  type CommandEveManagedImageLocalResult,
} from '@process/commandEve/managedImageGenerationService';
import {
  acquireVideoEditInflightLock,
  consumeVideoEditSpendPermit,
  evaluateStoredVideoEditSpendPermit,
  isVideoEditSpendDenied,
  isVideoEditSpendStoreHealthy,
  readVideoEditSpendPermitRecord,
  releaseVideoEditInflightLock,
} from '@process/commandEve/videoEditSpendPermitStore';

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
  bind?: typeof bindStagedImageArtifact;
}

const productionBindDeps: CommandEveImageArtifactBindDeps = {
  getDataPath,
  bind: bindStagedImageArtifact,
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
    return (deps.bind ?? bindStagedImageArtifact)(deps.getDataPath(), {
      conversationId,
      handle: request?.handle,
      toolCallId,
    });
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
  listRecords?: typeof listActiveImageArtifacts;
  /**
   * 1.820.3 load recovery: a best-effort durable reconcile that binds any
   * staged handle the volatile renderer path missed (the R2 orphan class)
   * BEFORE the list is served. Optional so unit tests can isolate the list;
   * production wires the Main transcript reconcile from commandEveBridge.
   * Never throws into the list.
   */
  reconcileBeforeList?: (conversationId: string) => Promise<unknown>;
}

const productionListDeps: CommandEveImageArtifactsListDeps = {
  getDataPath,
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
    // Load recovery first: an orphan staged child binds idempotently, then the
    // list below already contains it. A reconcile failure costs nothing here.
    if (deps.reconcileBeforeList) {
      await deps.reconcileBeforeList(request.conversationId).catch((): undefined => undefined);
    }
    return (deps.listRecords ?? listActiveImageArtifacts)(deps.getDataPath(), request.conversationId);
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
  readRecord?: typeof readImageArtifactRecordById;
  readBytes?: typeof readImageArtifactBytes;
}

const productionPreviewDeps: CommandEveImageArtifactPreviewDeps = {
  getDataPath,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
};

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
    const record = (deps.readRecord ?? readImageArtifactRecordById)(dataPath, artifactId);
    if (!record || record.status !== 'active' || record.conversation_id !== conversationId) return null;
    const bytes = (deps.readBytes ?? readImageArtifactBytes)(dataPath, artifactId);
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
    return (deps.importLegacy ?? importLegacyImageArtifact)(deps.getDataPath(), {
      conversationId,
      legacyWorkspaceId,
      expectedFileName,
      workspaceRoot: (deps.workspaceRootForLegacyId ?? productionImportDeps.workspaceRootForLegacyId!)(
        legacyWorkspaceId
      ),
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
  permit?: string;
  instruction?: string;
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
  isImageEditEnabled?: () => boolean;
  isSpendStoreHealthy?: typeof isVideoEditSpendStoreHealthy;
  isSpendDenied?: typeof isVideoEditSpendDenied;
  readGrant?: typeof readArtifactCapabilityGrant;
  resolveCapability?: typeof resolveImageEditCapability;
  readRecord?: typeof readImageArtifactRecordById;
  readBytes?: typeof readImageArtifactBytes;
  readSpendPermitRecord?: typeof readVideoEditSpendPermitRecord;
  evaluateSpendPermit?: typeof evaluateStoredVideoEditSpendPermit;
  consumeSpendPermit?: typeof consumeVideoEditSpendPermit;
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
  }) => Promise<CommandEveManagedImageLocalResult>;
}

const productionEditDeps: CommandEveImageEditDeps = {
  getDataPath,
  isImageEditEnabled: () => isAgentImageEditAdvertisingEnabled(getDataPath()),
  isSpendStoreHealthy: isVideoEditSpendStoreHealthy,
  isSpendDenied: isVideoEditSpendDenied,
  readGrant: readArtifactCapabilityGrant,
  resolveCapability: resolveImageEditCapability,
  readRecord: readImageArtifactRecordById,
  readBytes: readImageArtifactBytes,
  readSpendPermitRecord: readVideoEditSpendPermitRecord,
  evaluateSpendPermit: evaluateStoredVideoEditSpendPermit,
  consumeSpendPermit: consumeVideoEditSpendPermit,
  acquireInflightLock: acquireVideoEditInflightLock,
  releaseInflightLock: releaseVideoEditInflightLock,
  runManagedEdit: ({ instruction, referenceDataUrl, parentArtifactId }) =>
    executeCommandEveManagedImageGeneration(
      {
        model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
        prompt: instruction,
        n: 1,
        input_references: [{ type: 'image_url', image_url: { url: referenceDataUrl } }],
      },
      { stagedParentArtifactId: parentArtifactId }
    ),
};

function refuseEdit(reasonCode: string, message: string, retryable = false): CommandEveImageEditResult {
  return { ok: false, reasonCode, message, retryable };
}

/**
 * Edit a managed image the user already has.
 *
 * TWO credentials, exactly as on the video lane: the `handle` says WHICH image
 * (long-lived, envelope-borne, read authority), the `permit` says THIS PERSON
 * JUST ASKED, ONCE (ephemeral, turn-bound, single-use, consumed atomically
 * before the provider is called). The guard order is the video order:
 * flag -> STORE HEALTH -> instruction -> PERMIT PRESENT -> grant -> caller
 * conversation fence -> CONVERSATION DENY -> artifact -> bytes -> hash match ->
 * permit conversation fence -> permit judgement (operation `image_edit`,
 * CURRENT TURN, covered bytes, expiry) -> in-flight lock -> ATOMIC TURN +
 * PERMIT CONSUME -> managed service.
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

  // THE PROCESS-WIDE STORE-HEALTH GATE — shared with the video lane, because a
  // live authority that outlived a restart is not a property of a medium.
  let storeProven = false;
  try {
    storeProven = (deps.isSpendStoreHealthy ?? isVideoEditSpendStoreHealthy)() === true;
  } catch {
    storeProven = false;
  }
  if (!storeProven) {
    return refuseEdit('image-edit-spend-store-unreconciled', describeSpendPermitRefusal('spend-store-unreconciled'));
  }

  const instruction = typeof request?.instruction === 'string' ? request.instruction.trim() : '';
  if (!request || instruction.length === 0 || instruction.length > MAX_IMAGE_EDIT_INSTRUCTION_CHARS) {
    return refuseEdit('image-edit-request-invalid', 'Sag kurz, was am Bild geändert werden soll.');
  }

  // The permit is REQUIRED and is checked BEFORE anything that costs work. A
  // missing permit is not repaired or defaulted — it is the one credential that
  // says "the user just asked", and everything after this line assumes it.
  const permit = typeof request.permit === 'string' ? request.permit : '';
  if (!permit) {
    return refuseEdit('image-edit-permit-missing', describeSpendPermitRefusal('permit-missing'));
  }

  const dataPath = deps.getDataPath();
  const readGrant = deps.readGrant ?? readArtifactCapabilityGrant;
  const resolveCapability = deps.resolveCapability ?? resolveImageEditCapability;
  const readRecord = deps.readRecord ?? readImageArtifactRecordById;
  const readBytes = deps.readBytes ?? readImageArtifactBytes;
  const isDenied = deps.isSpendDenied ?? isVideoEditSpendDenied;
  const readPermitRecord = deps.readSpendPermitRecord ?? readVideoEditSpendPermitRecord;
  const evaluatePermit = deps.evaluateSpendPermit ?? evaluateStoredVideoEditSpendPermit;
  const consumePermit = deps.consumeSpendPermit ?? consumeVideoEditSpendPermit;
  const acquireLock = deps.acquireInflightLock ?? acquireVideoEditInflightLock;
  const releaseLock = deps.releaseInflightLock ?? releaseVideoEditInflightLock;

  // The grant is read FIRST so the artifact identity comes from OUR record,
  // never from anything the caller supplied.
  const grant = readGrant(dataPath, request.handle);
  if (!grant) {
    return refuseEdit('image-edit-handle-unknown', describeArtifactCapabilityRefusal('handle-unknown'));
  }
  if (request.conversationId !== undefined && request.conversationId !== grant.conversation_id) {
    return refuseEdit('image-edit-conversation-mismatch', describeArtifactCapabilityRefusal('conversation-mismatch'));
  }

  // THE DENY GATE — checked by its own read of its own state, before the source
  // read, before the permit judgement, before the lock, before the consume and
  // before the provider. A throw reads as DENIED.
  let conversationRetired = true;
  try {
    conversationRetired = isDenied(dataPath, grant.conversation_id);
  } catch {
    conversationRetired = true;
  }
  if (conversationRetired) {
    return refuseEdit('image-edit-conversation-retired', describeSpendPermitRefusal('conversation-retired'));
  }

  const source = readRecord(dataPath, grant.artifact_id);
  if (!source || source.status !== 'active' || source.conversation_id !== grant.conversation_id) {
    return refuseEdit('image-edit-source-missing', 'Das Ausgangsbild ist nicht mehr vorhanden.');
  }

  const sourceBytes = readBytes(dataPath, source.id);
  if (!sourceBytes) {
    return refuseEdit('image-edit-source-unreadable', 'Die Bilddatei konnte nicht gelesen werden.');
  }

  // Hash what we ACTUALLY read, then judge the handle against that — the same
  // time-of-check/time-of-use discipline as the video lane.
  const observedArtifactSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const capability = resolveCapability(dataPath, {
    handle: request.handle,
    observedArtifactSha256,
    expectedConversationId: grant.conversation_id,
  });
  if (capability.ok === false) {
    return refuseEdit(`image-edit-${capability.reason}`, describeArtifactCapabilityRefusal(capability.reason));
  }

  // THE permit conversation fence — record against record, before the judgement.
  const permitRecord = readPermitRecord(dataPath, permit);
  if (permitRecord && permitRecord.conversation_id !== grant.conversation_id) {
    return refuseEdit(
      'image-edit-permit-conversation-mismatch',
      describeSpendPermitRefusal('permit-conversation-mismatch')
    );
  }

  // THE spend authority, judged with operation `image_edit`: a video permit
  // cannot buy an image edit, and a permit not covering THESE bytes buys none.
  const permitEvaluation = evaluatePermit(dataPath, {
    permit,
    conversationId: grant.conversation_id,
    observedArtifactSha256,
    operation: 'image_edit',
  });
  if (permitEvaluation.ok === false) {
    return refuseEdit(`image-edit-${permitEvaluation.reason}`, describeSpendPermitRefusal(permitEvaluation.reason));
  }

  // At most ONE paid edit in flight per conversation — shared with the video
  // lane, because two tool calls in the same breath must not spend twice.
  if (!acquireLock(dataPath, grant.conversation_id)) {
    return refuseEdit('image-edit-already-in-flight', describeSpendPermitRefusal('edit-already-in-flight'), true);
  }

  try {
    // ATOMIC, and before the provider call. The turn claim is
    // operation-agnostic — one spend per turn across media.
    const consumption = consumePermit(dataPath, {
      permit,
      conversationId: grant.conversation_id,
      userTurnSha256: permitEvaluation.record.user_turn_sha256,
      instructionSha256: crypto.createHash('sha256').update(instruction).digest('hex'),
      artifactSha256: observedArtifactSha256,
    });
    if (consumption.ok === false) {
      return refuseEdit(
        `image-edit-${consumption.reason}`,
        describeSpendPermitRefusal(consumption.reason),
        consumption.reason === 'permit-in-flight'
      );
    }

    const managed = await (deps.runManagedEdit ?? productionEditDeps.runManagedEdit!)({
      instruction,
      referenceDataUrl: `data:${source.payload.mime_type};base64,${sourceBytes.toString('base64')}`,
      parentArtifactId: source.id,
    });
    if (managed.status !== 200) {
      const error = managed.body.error as { code?: unknown; message?: unknown } | undefined;
      const code = error && typeof error.code === 'string' ? error.code : 'managed_image_failed';
      const message =
        error && typeof error.message === 'string' ? error.message : 'Die Bildbearbeitung ist fehlgeschlagen.';
      return refuseEdit(`image-edit-${code}`, message, true);
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
    // PATH-FREE by construction: the staged handle and the parent id are the
    // whole answer. The child binds through the terminal flow, exactly like a
    // fresh generation.
    return { ok: true, artifactHandle, parentArtifactId: source.id };
  } finally {
    releaseLock(dataPath, grant.conversation_id);
  }
}
