/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMAND_EVE_OFFICE_ABANDONMENT_REASON,
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  COMMAND_EVE_OFFICE_SEAT_CHANGE_ABANDONMENT_REASON,
  buildCommandEveOfficeOperationMarker,
  commandEveOfficeOperationTranscriptEvidence,
  commandEveOfficeExtension,
  commandEveOfficeFingerprint,
  commandEveOfficeMimeType,
  commandEveOfficeTranscriptItemCount,
  extractCommandEveOfficeResultCandidates,
  isCommandEveOfficeArtifactMode,
  type CommandEveOfficeArtifactAction,
  type CommandEveOfficeArtifactMode,
  type CommandEveOfficeConversationArtifact,
  type CommandEveOfficeConversationArtifactPayload,
  type CommandEveOfficeOperationRecord,
  type CommandEveOfficeResultCandidate,
} from '@/common/types/office/artifactLineage';
import { getActiveSeatContextRevision, getActiveSeatId } from '@process/commandEve/seatContextCore';
import {
  commandEveOfficeArtifactMatchesOperation,
  commandEveOfficeArtifactPayloadSha256,
  commandEveOfficeArtifactRelativePath,
  ProjectWorkspaceConversationArtifactStore,
} from '@process/services/project-workspace/storage/conversationArtifactStore';
import {
  currentProcessNonceSha256,
  processPidIsAlive,
  processWitnessMatches,
} from '@process/services/project-workspace/storage/atomicJson';
import {
  readBoundedOfficeSource,
  resolveCommandEveOfficeConversationAuthority,
  type CommandEveOfficeArtifactRefusalReason,
  type CommandEveOfficeArtifactResolution,
  type CommandEveOfficeConversationAuthority,
} from '@process/commandEve/officeArtifactAttachmentCore';
import { writePrivateDocumentImmutable } from './privateDocumentCache';
import { isSafeOpaqueRecordId } from '@/common/config/eveOpaqueTokenCore';
import {
  publishCanonicalArtifact,
  recordCanonicalArtifactWrite,
  resolveCanonicalArtifactPlacement,
} from '@process/services/project-workspace/storage/canonicalArtifactPlacement';

type ReadyOfficeParent = Extract<CommandEveOfficeArtifactResolution, { status: 'ready' }>;

export type CommandEveOfficeOperationBeginRequest = {
  conversationId: string;
  requestId: string;
  action: CommandEveOfficeArtifactAction;
  mode: CommandEveOfficeArtifactMode;
  parent?: ReadyOfficeParent;
};

export type CommandEveOfficeOperationBeginResult =
  | { status: 'ready'; marker: string }
  | { status: 'refused'; reasonCode: CommandEveOfficeArtifactRefusalReason };

export interface CommandEveOfficeOperationBeginDeps {
  getActiveSeatId: typeof getActiveSeatId;
  getActiveSeatContextRevision: typeof getActiveSeatContextRevision;
  getProcessNonceSha256?: typeof currentProcessNonceSha256;
  getProcessId?: () => number;
  resolveAuthority: (conversationId: string) => Promise<CommandEveOfficeConversationAuthority>;
}

const productionBeginDeps: CommandEveOfficeOperationBeginDeps = {
  getActiveSeatId,
  getActiveSeatContextRevision,
  getProcessNonceSha256: currentProcessNonceSha256,
  getProcessId: () => process.pid,
  resolveAuthority: (conversationId) => resolveCommandEveOfficeConversationAuthority(conversationId),
};

export function commandEveOfficeOperationIdForRequest(requestId: string): string {
  return 'officeop_' + crypto.createHash('sha256').update(requestId).digest('hex');
}

function workspaceIdentitySha256(workspace: string): string {
  return crypto.createHash('sha256').update(fs.realpathSync.native(workspace)).digest('hex');
}

/**
 * The workspace digest, or `null` when the path cannot be resolved right now.
 *
 * A deleted workspace or a broken symlink is an ordinary, recoverable state —
 * never an unhandled rejection escaping into a caller that expects a structured
 * refusal. `null` compares equal to nothing, so an unresolvable workspace can
 * only ever refuse, never adopt.
 */
function workspaceIdentityOrNull(workspace: string): string | null {
  try {
    return workspaceIdentitySha256(workspace);
  } catch {
    return null;
  }
}

function artifactStore(dataPath: string): ProjectWorkspaceConversationArtifactStore {
  return new ProjectWorkspaceConversationArtifactStore({
    state_root: path.join(dataPath, 'project-workspace'),
  });
}

export async function beginCommandEveOfficeArtifactOperation(
  dataPath: string,
  request: CommandEveOfficeOperationBeginRequest,
  deps: CommandEveOfficeOperationBeginDeps = productionBeginDeps
): Promise<CommandEveOfficeOperationBeginResult> {
  if (
    !isSafeOpaqueRecordId(request?.conversationId ?? '') ||
    !isSafeOpaqueRecordId(request?.requestId ?? '') ||
    !isCommandEveOfficeArtifactMode(request?.mode) ||
    (request?.action !== 'create' && request?.action !== 'edit') ||
    (request.action === 'create' && request.parent !== undefined) ||
    (request.action === 'edit' && request.parent?.status !== 'ready')
  ) {
    return { status: 'refused', reasonCode: 'invalid-request' };
  }

  const authority = await deps.resolveAuthority(request.conversationId);
  if (authority.status === 'temporary') return { status: 'refused', reasonCode: 'conversation-unavailable' };
  if (authority.status !== 'ready') return authority;
  const capturedSeatId = authority.seatId;
  const capturedSeatRevision = authority.seatContextRevision;
  // An unresolvable workspace is stored as `null`, which can never match a
  // digest later. The operation still runs; it simply forfeits cross-boot
  // recovery instead of failing the user's request outright.
  const workspaceIdentity = workspaceIdentityOrNull(authority.workspace);
  const seatStillMatches = () =>
    deps.getActiveSeatId() === capturedSeatId && deps.getActiveSeatContextRevision() === capturedSeatRevision;
  if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };

  try {
    const store = artifactStore(dataPath);
    let parentArtifactId: string | null = null;
    let sourceSha256: string | null = null;
    let sourceSize: number | null = null;
    let sourceFingerprint: string | null = null;
    if (request.action === 'edit') {
      const parent = request.parent!;
      if (parent.seatId !== capturedSeatId || parent.seatContextRevision !== capturedSeatRevision) {
        return { status: 'refused', reasonCode: 'seat-changed' };
      }
      let persistedParent: CommandEveOfficeConversationArtifact | null;
      try {
        persistedParent = store.readOfficeArtifactWithVerifiedRecordLineage(
          capturedSeatId,
          request.conversationId,
          parent.parentArtifactId
        );
      } catch {
        return { status: 'refused', reasonCode: 'artifact-unavailable' };
      }
      if (
        !persistedParent ||
        persistedParent.payload.seat_id !== capturedSeatId ||
        persistedParent.payload.office_mode !== request.mode ||
        persistedParent.payload.result_sha256 !== parent.sourceSha256 ||
        persistedParent.payload.size !== parent.sourceSize ||
        persistedParent.payload.result_fingerprint !== parent.sourceFingerprint
      ) {
        return { status: 'refused', reasonCode: 'artifact-unavailable' };
      }
      parentArtifactId = persistedParent.id;
      sourceSha256 = parent.sourceSha256;
      sourceSize = parent.sourceSize;
      sourceFingerprint = parent.sourceFingerprint;
    }

    const operationId = commandEveOfficeOperationIdForRequest(request.requestId);
    store.createOfficeOperation({
      operation_id: operationId,
      request_id: request.requestId,
      seat_id: capturedSeatId,
      seat_context_revision: capturedSeatRevision,
      process_id: (deps.getProcessId ?? (() => process.pid))(),
      process_nonce_sha256: (deps.getProcessNonceSha256 ?? currentProcessNonceSha256)(),
      workspace_identity_sha256: workspaceIdentity,
      conversation_id: request.conversationId,
      action: request.action,
      mode: request.mode,
      parent_artifact_id: parentArtifactId,
      source_sha256: sourceSha256,
      source_size: sourceSize,
      source_fingerprint: sourceFingerprint,
    });
    if (!seatStillMatches()) {
      try {
        store.createOfficeOperationAbandonment({
          seat_id: capturedSeatId,
          seat_context_revision: capturedSeatRevision,
          conversation_id: request.conversationId,
          operation_id: operationId,
          reason: COMMAND_EVE_OFFICE_SEAT_CHANGE_ABANDONMENT_REASON,
        });
      } catch {
        // Keep the operation recoverable when the terminal receipt cannot be
        // persisted; never pretend a cancellation was recorded.
      }
      return { status: 'refused', reasonCode: 'seat-changed' };
    }
    return { status: 'ready', marker: buildCommandEveOfficeOperationMarker(operationId) };
  } catch {
    return { status: 'refused', reasonCode: 'operation-conflict' };
  }
}

function safeOfficeFileName(title: string, mode: CommandEveOfficeArtifactMode): string {
  const fallback = mode === 'word' ? 'document.docx' : 'workbook.xlsx';
  const candidate = title
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return candidate.toLowerCase().endsWith(commandEveOfficeExtension(mode)) ? candidate : fallback;
}

export type CommandEveOfficeArtifactReconcileSummary = {
  conversationId: string;
  pendingOperations: number;
  candidates: number;
  persisted: number;
  alreadyPersisted: number;
  abandoned: number;
  refused: Array<{ operationId: string; reason: CommandEveOfficeArtifactReconcileRefusalReason }>;
  transcriptFetched: boolean;
};

export type CommandEveOfficeArtifactReconcileRefusalReason =
  | CommandEveOfficeArtifactRefusalReason
  | 'store-corrupt'
  | 'transcript-unavailable'
  | 'parent-mismatch'
  | 'existing-artifact-mismatch'
  | 'invalid-artifact-id'
  | 'result-limit-exceeded'
  | 'persist-failed'
  | 'completion-membership-mismatch'
  | 'completion-failed'
  | 'abandonment-conflict'
  | 'abandonment-failed';

export interface CommandEveOfficeArtifactRuntimeDeps {
  getActiveSeatId?: typeof getActiveSeatId;
  getActiveSeatContextRevision?: typeof getActiveSeatContextRevision;
  getProcessNonceSha256?: typeof currentProcessNonceSha256;
  getProcessId?: () => number;
  isProcessAlive?: typeof processPidIsAlive;
  resolveAuthority?: (conversationId: string) => Promise<CommandEveOfficeConversationAuthority>;
  readOfficeSource?: typeof readBoundedOfficeSource;
  writeImmutable?: typeof writePrivateDocumentImmutable;
  publishCanonical?: typeof publishCanonicalArtifact;
  /** Records withheld artifacts. A listing never throws, so this is the only trace. */
  log?: (line: string) => void;
}

export interface CommandEveOfficeArtifactReconcileDeps extends CommandEveOfficeArtifactRuntimeDeps {
  fetchTranscript: (conversationId: string, window: number) => Promise<unknown>;
  window?: number;
  onFreshArtifact?: (conversationId: string) => void;
}

const DEFAULT_WINDOW = 100;
const MAX_OFFICE_RESULTS_PER_OPERATION = 32;
// Two bounded 64 MiB reads cap reconciliation memory without serializing independent results.
const MAX_OFFICE_RESULT_CONCURRENCY = 2;

function runtimeDeps(deps: CommandEveOfficeArtifactRuntimeDeps) {
  const writeImmutable = deps.writeImmutable ?? writePrivateDocumentImmutable;
  return {
    getSeatId: deps.getActiveSeatId ?? getActiveSeatId,
    getSeatRevision: deps.getActiveSeatContextRevision ?? getActiveSeatContextRevision,
    getProcessNonce: deps.getProcessNonceSha256 ?? currentProcessNonceSha256,
    getProcessId: deps.getProcessId ?? (() => process.pid),
    isProcessAlive: deps.isProcessAlive ?? processPidIsAlive,
    resolveAuthority:
      deps.resolveAuthority ??
      ((conversationId: string) => resolveCommandEveOfficeConversationAuthority(conversationId)),
    readSource: deps.readOfficeSource ?? readBoundedOfficeSource,
    writeImmutable,
    publishCanonical:
      deps.publishCanonical ??
      (deps.writeImmutable
        ? (input: Parameters<typeof publishCanonicalArtifact>[0]) => {
            const placement = resolveCanonicalArtifactPlacement(input);
            writeImmutable(input.workspaceRoot, placement.absolutePath, input.bytes!);
            const cleanupNotice = recordCanonicalArtifactWrite(input.dataPath, input.workspaceRoot, input.folder);
            return { ...placement, ...(cleanupNotice === undefined ? {} : { cleanupNotice }) };
          }
        : publishCanonicalArtifact),
  };
}

async function artifactBytesMatchManifest(
  workspace: string,
  artifact: CommandEveOfficeConversationArtifact,
  readSource: typeof readBoundedOfficeSource
): Promise<boolean> {
  const sourcePath = path.resolve(workspace, ...artifact.payload.path.split('/'));
  const source = await readSource(workspace, sourcePath, artifact.payload.office_mode);
  return Boolean(
    source &&
    source.sha256 === artifact.payload.result_sha256 &&
    source.buffer.length === artifact.payload.size &&
    commandEveOfficeFingerprint(artifact.payload.office_mode, source.sha256, source.buffer.length) ===
      artifact.payload.result_fingerprint
  );
}

function operationBelongsToActiveGeneration(
  operation: CommandEveOfficeOperationRecord,
  active: {
    seatId: string;
    seatRevision: number;
    processId: number;
    processNonce: string;
    conversationId: string;
  }
): boolean {
  // Seat revisions are process-local, so pending work survives renderer reloads but never an unverifiable Main restart.
  if (operation.seat_id !== active.seatId || operation.conversation_id !== active.conversationId) return false;
  return (
    operation.process_id === active.processId &&
    operation.process_nonce_sha256 === active.processNonce &&
    operation.seat_context_revision === active.seatRevision
  );
}

/**
 * An operation whose owning Main boot is provably gone can never satisfy the
 * process fence again, so it is terminally abandoned rather than pending.
 *
 * A LIVE pid whose witness still matches the recorded boot nonce is NOT gone:
 * that is this same running Main under a stale seat revision, and its work may
 * still complete. Missing witness evidence answers "unknown" and stays pending,
 * because sealing on absent evidence would strand a recoverable operation.
 */
function operationBootIsGone(
  operation: CommandEveOfficeOperationRecord,
  witnessDirectory: string,
  isProcessAlive: typeof processPidIsAlive
): boolean {
  if (!isProcessAlive(operation.process_id)) return true;
  return processWitnessMatches(witnessDirectory, operation.process_id, operation.process_nonce_sha256) === false;
}

function deadOperationCanRecoverHere(input: {
  operation: CommandEveOfficeOperationRecord;
  seatId: string;
  conversationId: string;
  workspace: string;
  witnessDirectory: string;
  isProcessAlive: typeof processPidIsAlive;
}): boolean {
  const workspaceIdentity = workspaceIdentityOrNull(input.workspace);
  return (
    workspaceIdentity !== null &&
    input.operation.workspace_identity_sha256 === workspaceIdentity &&
    input.operation.seat_id === input.seatId &&
    input.operation.conversation_id === input.conversationId &&
    operationBootIsGone(input.operation, input.witnessDirectory, input.isProcessAlive)
  );
}

async function editParentMatchesOperation(
  store: ProjectWorkspaceConversationArtifactStore,
  operation: CommandEveOfficeOperationRecord,
  seatId: string,
  conversationId: string,
  workspace: string,
  readSource: typeof readBoundedOfficeSource
): Promise<boolean> {
  if (operation.action !== 'edit') return true;
  let parent: CommandEveOfficeConversationArtifact | null;
  try {
    parent = operation.parent_artifact_id
      ? store.readOfficeArtifactWithVerifiedRecordLineage(seatId, conversationId, operation.parent_artifact_id)
      : null;
  } catch {
    return false;
  }
  return Boolean(
    parent &&
    parent.payload.seat_id === seatId &&
    parent.payload.office_mode === operation.mode &&
    parent.payload.result_sha256 === operation.source_sha256 &&
    parent.payload.size === operation.source_size &&
    parent.payload.result_fingerprint === operation.source_fingerprint &&
    (await artifactBytesMatchManifest(workspace, parent, readSource))
  );
}

async function existingArtifactMatchesCandidate(
  artifact: CommandEveOfficeConversationArtifact,
  operation: CommandEveOfficeOperationRecord,
  candidate: CommandEveOfficeResultCandidate,
  seatId: string,
  workspace: string,
  readSource: typeof readBoundedOfficeSource
): Promise<boolean> {
  return (
    operation.seat_id === seatId &&
    commandEveOfficeArtifactMatchesOperation(artifact, operation) &&
    artifact.payload.source_message_id === candidate.messageId &&
    artifact.payload.source_turn_id === candidate.turnId &&
    artifact.payload.source_directive_index === candidate.directiveIndex &&
    artifact.payload.source_tool === 'hermes_media_directive' &&
    (await artifactBytesMatchManifest(workspace, artifact, readSource))
  );
}

function rememberSatisfiedArtifact(
  satisfiedByOperation: Map<string, Map<string, CommandEveOfficeConversationArtifact>>,
  operationId: string,
  artifact: CommandEveOfficeConversationArtifact
): void {
  const artifacts = satisfiedByOperation.get(operationId) ?? new Map<string, CommandEveOfficeConversationArtifact>();
  artifacts.set(artifact.id, artifact);
  satisfiedByOperation.set(operationId, artifacts);
}

function buildOfficeResultPayload(input: {
  artifactId: string;
  candidate: CommandEveOfficeResultCandidate;
  operation: CommandEveOfficeOperationRecord;
  relativePath: string;
  cleanupNotice?: string;
  result: { buffer: Buffer; sha256: string };
  seatId: string;
}): CommandEveOfficeConversationArtifactPayload {
  const { artifactId, candidate, operation, relativePath, cleanupNotice, result, seatId } = input;
  const fileName = safeOfficeFileName(candidate.title, operation.mode);
  const sourceSha256 = operation.source_sha256 ?? result.sha256;
  const sourceSize = operation.source_size ?? result.buffer.length;
  return {
    artifact_type: 'file',
    artifact_id: artifactId,
    title: fileName,
    file_name: fileName,
    mime_type: commandEveOfficeMimeType(operation.mode),
    path: relativePath,
    ...(cleanupNotice === undefined ? {} : { cleanup_notice: cleanupNotice }),
    size: result.buffer.length,
    hash: result.sha256,
    managed_office: true,
    office_mode: operation.mode,
    origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
    origin_action: operation.action,
    parent_artifact_id: operation.parent_artifact_id,
    source_sha256: sourceSha256,
    source_size: sourceSize,
    source_fingerprint:
      operation.source_fingerprint ?? commandEveOfficeFingerprint(operation.mode, sourceSha256, sourceSize),
    result_sha256: result.sha256,
    result_fingerprint: commandEveOfficeFingerprint(operation.mode, result.sha256, result.buffer.length),
    operation_id: operation.operation_id,
    seat_id: seatId,
    seat_context_revision: operation.seat_context_revision,
    source_message_id: candidate.messageId,
    source_turn_id: candidate.turnId,
    source_directive_index: candidate.directiveIndex,
    source_tool: 'hermes_media_directive',
  };
}

type PreparedOfficeResultCandidate = {
  artifactId: string;
  candidate: CommandEveOfficeResultCandidate;
  operation: CommandEveOfficeOperationRecord;
};

function preflightOfficeResultCandidates(input: {
  candidates: CommandEveOfficeResultCandidate[];
  failedOperationIds: Set<string>;
  pendingById: Map<string, CommandEveOfficeOperationRecord>;
  summary: CommandEveOfficeArtifactReconcileSummary;
}): PreparedOfficeResultCandidate[] {
  const groups = new Map<
    string,
    {
      operation: CommandEveOfficeOperationRecord;
      candidates: PreparedOfficeResultCandidate[];
      invalidArtifactId: boolean;
    }
  >();
  for (const candidate of input.candidates) {
    const operation = input.pendingById.get(candidate.operationId);
    if (!operation) continue;
    if (
      path.extname(candidate.source).toLowerCase() !== commandEveOfficeExtension(operation.mode) ||
      !isSafeOpaqueRecordId(candidate.messageId) ||
      !isSafeOpaqueRecordId(candidate.turnId)
    ) {
      input.summary.refused.push({ operationId: operation.operation_id, reason: 'source-format-mismatch' });
      continue;
    }
    const artifactId = 'hermes-media-' + candidate.messageId + '-' + String(candidate.directiveIndex);
    const group = groups.get(operation.operation_id) ?? {
      operation,
      candidates: [],
      invalidArtifactId: false,
    };
    group.invalidArtifactId ||=
      !isSafeOpaqueRecordId(artifactId) || candidate.directiveIndex < 0 || candidate.directiveIndex > 99;
    group.candidates.push({ artifactId, candidate, operation });
    groups.set(operation.operation_id, group);
  }

  const prepared: PreparedOfficeResultCandidate[] = [];
  for (const group of groups.values()) {
    if (group.candidates.length > MAX_OFFICE_RESULTS_PER_OPERATION) {
      input.summary.refused.push({
        operationId: group.operation.operation_id,
        reason: 'result-limit-exceeded',
      });
      input.failedOperationIds.add(group.operation.operation_id);
      continue;
    }
    if (group.invalidArtifactId) {
      input.summary.refused.push({
        operationId: group.operation.operation_id,
        reason: 'invalid-artifact-id',
      });
      input.failedOperationIds.add(group.operation.operation_id);
      continue;
    }
    prepared.push(...group.candidates);
  }
  return prepared;
}

async function mapWithinOfficeReadBudget<Input, Output>(
  items: readonly Input[],
  work: (item: Input, index: number) => Promise<Output>
): Promise<Output[]> {
  const results: Output[] = [];
  let cursor = 0;
  const workNext = async (): Promise<void> => {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    results[index] = await work(items[index], index);
    return workNext();
  };
  await Promise.all(Array.from({ length: Math.min(MAX_OFFICE_RESULT_CONCURRENCY, items.length) }, () => workNext()));
  return results;
}

async function reconcileOfficeResultCandidate(input: {
  dataPath: string;
  prepared: PreparedOfficeResultCandidate;
  conversationId: string;
  existingById: Map<string, CommandEveOfficeConversationArtifact>;
  failedOperationIds: Set<string>;
  satisfiedByOperation: Map<string, Map<string, CommandEveOfficeConversationArtifact>>;
  seatId: string;
  seatStillMatches: () => boolean;
  store: ProjectWorkspaceConversationArtifactStore;
  summary: CommandEveOfficeArtifactReconcileSummary;
  workspace: string;
  runtime: ReturnType<typeof runtimeDeps>;
}): Promise<void> {
  const { artifactId, candidate, operation } = input.prepared;
  const { summary, failedOperationIds } = input;

  try {
    if (
      !(await editParentMatchesOperation(
        input.store,
        operation,
        input.seatId,
        input.conversationId,
        input.workspace,
        input.runtime.readSource
      ))
    ) {
      summary.refused.push({ operationId: operation.operation_id, reason: 'parent-mismatch' });
      failedOperationIds.add(operation.operation_id);
      return;
    }
    const existingArtifact = input.existingById.get(artifactId);
    if (existingArtifact) {
      if (
        !(await existingArtifactMatchesCandidate(
          existingArtifact,
          operation,
          candidate,
          input.seatId,
          input.workspace,
          input.runtime.readSource
        ))
      ) {
        summary.refused.push({ operationId: operation.operation_id, reason: 'existing-artifact-mismatch' });
        failedOperationIds.add(operation.operation_id);
        return;
      }
      rememberSatisfiedArtifact(input.satisfiedByOperation, operation.operation_id, existingArtifact);
      return;
    }
    const result = await input.runtime.readSource(input.workspace, candidate.source, operation.mode);
    if (!result) {
      summary.refused.push({ operationId: operation.operation_id, reason: 'source-unsafe' });
      failedOperationIds.add(operation.operation_id);
      return;
    }
    if (!input.seatStillMatches()) {
      summary.refused.push({ operationId: operation.operation_id, reason: 'seat-changed' });
      failedOperationIds.add(operation.operation_id);
      return;
    }
    const placement = input.runtime.publishCanonical({
      dataPath: input.dataPath,
      workspaceRoot: input.workspace,
      folder: 'dokumente',
      nameHint: candidate.title,
      fallbackName: operation.mode === 'word' ? 'dokument' : 'tabelle',
      extension: commandEveOfficeExtension(operation.mode),
      bytes: result.buffer,
    });
    const relativePath = placement.relativePath;
    if (!input.seatStillMatches()) {
      summary.refused.push({ operationId: operation.operation_id, reason: 'seat-changed' });
      failedOperationIds.add(operation.operation_id);
      return;
    }
    const artifact = input.store.createOfficeArtifact({
      seat_id: input.seatId,
      conversation_id: input.conversationId,
      artifact_id: artifactId,
      payload: buildOfficeResultPayload({
        artifactId,
        candidate,
        operation,
        relativePath,
        ...(placement.cleanupNotice === undefined ? {} : { cleanupNotice: placement.cleanupNotice }),
        result,
        seatId: input.seatId,
      }),
    });
    input.existingById.set(artifact.id, artifact);
    summary.persisted += 1;
    rememberSatisfiedArtifact(input.satisfiedByOperation, operation.operation_id, artifact);
  } catch {
    summary.refused.push({ operationId: operation.operation_id, reason: 'persist-failed' });
    failedOperationIds.add(operation.operation_id);
  }
}

export async function reconcileConversationOfficeArtifacts(
  dataPath: string,
  conversationId: string,
  deps: CommandEveOfficeArtifactReconcileDeps
): Promise<CommandEveOfficeArtifactReconcileSummary> {
  const summary: CommandEveOfficeArtifactReconcileSummary = {
    conversationId,
    pendingOperations: 0,
    candidates: 0,
    persisted: 0,
    alreadyPersisted: 0,
    abandoned: 0,
    refused: [],
    transcriptFetched: false,
  };
  if (!isSafeOpaqueRecordId(conversationId)) return summary;
  const runtime = runtimeDeps(deps);
  const seatId = runtime.getSeatId();
  const seatRevision = runtime.getSeatRevision();
  const processNonce = runtime.getProcessNonce();
  const processId = runtime.getProcessId();
  const seatStillMatches = () => runtime.getSeatId() === seatId && runtime.getSeatRevision() === seatRevision;
  const store = artifactStore(dataPath);

  let allOperations: CommandEveOfficeOperationRecord[];
  let existingArtifacts: CommandEveOfficeConversationArtifact[];
  try {
    allOperations = store.listOfficeOperations(seatId, conversationId);
    existingArtifacts = store.listOfficeArtifacts(seatId, conversationId);
  } catch {
    summary.refused.push({ operationId: 'office-store', reason: 'store-corrupt' });
    return summary;
  }

  const authority = await runtime.resolveAuthority(conversationId);
  if (authority.status !== 'ready' || authority.seatId !== seatId || authority.seatContextRevision !== seatRevision) {
    summary.refused.push({
      operationId: 'office-authority',
      reason: authority.status === 'ready' ? 'seat-changed' : 'conversation-unavailable',
    });
    return summary;
  }
  const activeOperations = allOperations.filter((operation) =>
    operationBelongsToActiveGeneration(operation, { seatId, seatRevision, processId, processNonce, conversationId })
  );
  const witnessDirectory = store.officeOperationBootWitnessDirectory(seatId, conversationId);
  // Every operation this seat owns whose authoring boot is provably gone. The
  // workspace-matched subset is the only one eligible for adoption, but the
  // wider set still has to be observable: a record sealed by an earlier build
  // (before workspace identity existed) must be able to REPORT that a result
  // exists after all, instead of disappearing from every summary.
  const deadOperations = allOperations.filter(
    (operation) =>
      !operationBelongsToActiveGeneration(operation, {
        seatId,
        seatRevision,
        processId,
        processNonce,
        conversationId,
      }) &&
      operation.seat_id === seatId &&
      operation.conversation_id === conversationId &&
      operationBootIsGone(operation, witnessDirectory, runtime.isProcessAlive)
  );
  const deadWorkspaceMatchedOperations = deadOperations.filter((operation) =>
    deadOperationCanRecoverHere({
      operation,
      seatId,
      conversationId,
      workspace: authority.workspace,
      witnessDirectory,
      isProcessAlive: runtime.isProcessAlive,
    })
  );
  const candidateOperations = [...activeOperations, ...deadWorkspaceMatchedOperations];
  const existingById = new Map(existingArtifacts.map((artifact) => [artifact.id, artifact]));
  let completedOperationIds: Set<string>;
  try {
    completedOperationIds = store.completedOfficeOperationIdsWithExactReceipts(
      seatId,
      conversationId,
      candidateOperations,
      existingArtifacts
    );
  } catch {
    summary.refused.push({ operationId: 'office-store', reason: 'store-corrupt' });
    return summary;
  }
  const abandonmentByOperation = new Map<string, boolean>();
  try {
    for (const operation of deadOperations) {
      abandonmentByOperation.set(
        operation.operation_id,
        Boolean(store.readOfficeOperationAbandonment(seatId, conversationId, operation.operation_id))
      );
    }
  } catch {
    summary.refused.push({ operationId: 'office-store', reason: 'store-corrupt' });
    return summary;
  }
  const activePending = activeOperations.filter((operation) => !completedOperationIds.has(operation.operation_id));
  const deadPending = deadWorkspaceMatchedOperations.filter(
    (operation) =>
      !completedOperationIds.has(operation.operation_id) && !abandonmentByOperation.get(operation.operation_id)
  );
  summary.alreadyPersisted = completedOperationIds.size;
  // Open work is what this pass is answering for, so it is reported BEFORE the
  // transcript can fail. A transcript error must read as "still open", never as
  // "nothing was pending".
  summary.pendingOperations = activePending.length + deadPending.length;
  // A sealed record alone never justifies a fetch: conflict reporting rides
  // along on a transcript some real pending work already required.
  if (summary.pendingOperations === 0) return summary;
  let transcript: unknown;
  try {
    transcript = await deps.fetchTranscript(conversationId, deps.window ?? DEFAULT_WINDOW);
    summary.transcriptFetched = true;
  } catch {
    summary.refused.push({ operationId: 'office-transcript', reason: 'transcript-unavailable' });
    return summary;
  }
  if (!seatStillMatches()) {
    summary.refused.push({ operationId: 'office-authority', reason: 'seat-changed' });
    return summary;
  }

  const candidates = extractCommandEveOfficeResultCandidates(transcript, conversationId);
  summary.candidates = candidates.length;
  // A saturated window is indistinguishable from a truncated history, so a
  // missing marker inside it proves nothing. Only a demonstrably COMPLETE
  // history may support the negative conclusion "this was never dispatched".
  const requestedWindow = deps.window ?? DEFAULT_WINDOW;
  const transcriptIsComplete = commandEveOfficeTranscriptItemCount(transcript) < requestedWindow;
  const workspaceMatchedIds = new Set(deadWorkspaceMatchedOperations.map((operation) => operation.operation_id));
  const recoveryPending: CommandEveOfficeOperationRecord[] = [];
  for (const operation of deadOperations) {
    const evidence = commandEveOfficeOperationTranscriptEvidence(transcript, conversationId, operation.operation_id);
    const exactTurn = evidence.markerEvents === 1 && evidence.terminalResultEvents === 1;
    // EXACTLY one result, not "at least one": a single terminal turn carrying
    // two MEDIA lines is ambiguous about what the user actually paid for, and
    // adopting both would publish an unreviewed second artifact.
    const exactCandidate =
      candidates.filter((candidate) => candidate.operationId === operation.operation_id).length === 1;
    const recoverable = exactTurn && exactCandidate;
    // Reported for EVERY dead operation of this seat, including one sealed by
    // an earlier build that never recorded a workspace identity. A conflict is
    // an observation, not an adoption, so it needs no workspace proof — and
    // staying silent is what made this class invisible before.
    if (abandonmentByOperation.get(operation.operation_id)) {
      if (recoverable) {
        summary.refused.push({ operationId: operation.operation_id, reason: 'abandonment-conflict' });
      }
      continue;
    }
    // Everything below either seals or adopts, and both require the exact
    // workspace that authorized this operation.
    if (!workspaceMatchedIds.has(operation.operation_id)) continue;
    if (completedOperationIds.has(operation.operation_id)) continue;
    if (transcriptIsComplete && evidence.markerTurnIds.length === 0 && evidence.terminalResultTurnIds.length === 0) {
      try {
        store.createOfficeOperationAbandonment({
          seat_id: seatId,
          seat_context_revision: operation.seat_context_revision,
          conversation_id: conversationId,
          operation_id: operation.operation_id,
          reason: COMMAND_EVE_OFFICE_ABANDONMENT_REASON,
        });
        summary.abandoned += 1;
      } catch {
        summary.refused.push({ operationId: operation.operation_id, reason: 'abandonment-failed' });
      }
      continue;
    }
    if (recoverable) recoveryPending.push(operation);
  }
  const pending = [...activePending, ...recoveryPending];
  // Open work minus whatever this pass sealed. `pending` is only the subset
  // this pass can ACT on; an ambiguous or out-of-window dead operation stays
  // open and must keep saying so, or a caller reads "0 pending" as "nothing
  // left to recover".
  summary.pendingOperations = activePending.length + deadPending.length - summary.abandoned;
  if (pending.length === 0) return summary;
  const pendingById = new Map(pending.map((operation) => [operation.operation_id, operation]));
  const expectedArtifactIdsByOperation = new Map<string, string[]>();
  const satisfiedArtifactsByOperation = new Map<string, Map<string, CommandEveOfficeConversationArtifact>>();
  const failedOperationIds = new Set<string>();
  const preparedCandidates = preflightOfficeResultCandidates({
    candidates,
    failedOperationIds,
    pendingById,
    summary,
  });
  for (const prepared of preparedCandidates) {
    const expected = expectedArtifactIdsByOperation.get(prepared.operation.operation_id) ?? [];
    expected.push(prepared.artifactId);
    expectedArtifactIdsByOperation.set(prepared.operation.operation_id, expected);
  }

  await mapWithinOfficeReadBudget(preparedCandidates, (prepared) =>
    reconcileOfficeResultCandidate({
      dataPath,
      prepared,
      conversationId,
      existingById,
      failedOperationIds,
      satisfiedByOperation: satisfiedArtifactsByOperation,
      seatId,
      seatStillMatches,
      store,
      summary,
      workspace: authority.workspace,
      runtime,
    })
  );

  for (const operation of pending) {
    const expectedArtifactIds = expectedArtifactIdsByOperation.get(operation.operation_id);
    const satisfiedArtifacts = satisfiedArtifactsByOperation.get(operation.operation_id);
    if (
      !expectedArtifactIds ||
      expectedArtifactIds.length === 0 ||
      failedOperationIds.has(operation.operation_id) ||
      !satisfiedArtifacts ||
      expectedArtifactIds.some((artifactId) => !satisfiedArtifacts.has(artifactId))
    ) {
      continue;
    }
    if (!seatStillMatches()) {
      summary.refused.push({ operationId: operation.operation_id, reason: 'seat-changed' });
      break;
    }
    const completedArtifacts = [...existingById.values()]
      .filter((artifact) => commandEveOfficeArtifactMatchesOperation(artifact, operation))
      .toSorted((left, right) => left.id.localeCompare(right.id));
    const canonicalArtifactIds = completedArtifacts.map((artifact) => artifact.id);
    const expectedSorted = [...expectedArtifactIds].toSorted();
    if (
      canonicalArtifactIds.length !== expectedSorted.length ||
      canonicalArtifactIds.some((artifactId, index) => artifactId !== expectedSorted[index])
    ) {
      summary.refused.push({
        operationId: operation.operation_id,
        reason: 'completion-membership-mismatch',
      });
      continue;
    }
    try {
      store.createOfficeOperationCompletion({
        seat_id: seatId,
        seat_context_revision: operation.seat_context_revision,
        conversation_id: conversationId,
        operation_id: operation.operation_id,
        artifact_receipts: completedArtifacts.map((artifact) => ({
          artifact_id: artifact.id,
          payload_sha256: commandEveOfficeArtifactPayloadSha256(artifact.payload),
        })),
      });
    } catch {
      summary.refused.push({ operationId: operation.operation_id, reason: 'completion-failed' });
    }
  }

  if (summary.persisted > 0) {
    try {
      deps.onFreshArtifact?.(conversationId);
    } catch (error) {
      deps.log?.(
        '[office-artifact-reconcile] refresh-notification-failed ' +
          conversationId +
          ': ' +
          (error instanceof Error ? error.message : 'unknown-error')
      );
    }
  }
  if (summary.refused.length > 0) {
    deps.log?.(
      '[office-artifact-reconcile] ' +
        conversationId +
        ': pending=' +
        String(summary.pendingOperations) +
        ' candidates=' +
        String(summary.candidates) +
        ' persisted=' +
        String(summary.persisted) +
        ' refused=' +
        String(summary.refused.length)
    );
  }
  return summary;
}

async function artifactLineageIsReadable(input: {
  artifact: CommandEveOfficeConversationArtifact;
  conversationId: string;
  readSource: typeof readBoundedOfficeSource;
  seatId: string;
  verifiedById: Map<string, CommandEveOfficeConversationArtifact>;
  workspace: string;
}): Promise<boolean> {
  const { artifact, conversationId, readSource, seatId, verifiedById, workspace } = input;
  if (
    artifact.conversation_id !== conversationId ||
    artifact.payload.seat_id !== seatId ||
    !(await artifactBytesMatchManifest(workspace, artifact, readSource))
  ) {
    return false;
  }
  if (artifact.payload.origin_action !== 'edit') return true;
  const parentId = artifact.payload.parent_artifact_id;
  const parent = parentId ? verifiedById.get(parentId) : null;
  return Boolean(
    parent &&
    parent.payload.result_sha256 === artifact.payload.source_sha256 &&
    parent.payload.size === artifact.payload.source_size &&
    parent.payload.result_fingerprint === artifact.payload.source_fingerprint &&
    (await artifactBytesMatchManifest(workspace, parent, readSource))
  );
}

export async function listCommandEveOfficeArtifactRecords(
  dataPath: string,
  conversationId: string,
  deps: CommandEveOfficeArtifactRuntimeDeps = {}
): Promise<CommandEveOfficeConversationArtifact[]> {
  if (!isSafeOpaqueRecordId(conversationId)) return [];
  const runtime = runtimeDeps(deps);
  const seatId = runtime.getSeatId();
  const seatRevision = runtime.getSeatRevision();
  const authority = await runtime.resolveAuthority(conversationId);
  if (authority.status !== 'ready' || authority.seatId !== seatId || authority.seatContextRevision !== seatRevision) {
    return [];
  }
  const seatStillMatches = () => runtime.getSeatId() === seatId && runtime.getSeatRevision() === seatRevision;
  try {
    const store = artifactStore(dataPath);
    // Display read: a single unreadable record withholds itself, not every other
    // document of this conversation. Every returned record still passed the full
    // identity, operation, receipt and parent-chain verification.
    const listed = store.listReadableOfficeArtifactsWithVerifiedRecordLineage(seatId, conversationId);
    const records = listed.artifacts;
    if (listed.skipped > 0) {
      deps.log?.(
        '[command-eve-office-artifacts] withheld ' +
          String(listed.skipped) +
          ' unverifiable record(s) for this conversation'
      );
    }
    const verifiedById = new Map(records.map((artifact) => [artifact.id, artifact]));
    const readable = await mapWithinOfficeReadBudget(records, async (record) =>
      (await artifactLineageIsReadable({
        artifact: record,
        conversationId,
        readSource: runtime.readSource,
        seatId,
        verifiedById,
        workspace: authority.workspace,
      }))
        ? record
        : null
    );
    const valid = readable.filter((record): record is CommandEveOfficeConversationArtifact => record !== null);
    return seatStillMatches() ? valid : [];
  } catch {
    return [];
  }
}
