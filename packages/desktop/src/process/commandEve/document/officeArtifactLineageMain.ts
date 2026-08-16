/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import path from 'node:path';
import {
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  buildCommandEveOfficeOperationMarker,
  commandEveOfficeExtension,
  commandEveOfficeFingerprint,
  commandEveOfficeMimeType,
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
  if (authority.status !== 'ready') return authority;
  const capturedSeatId = authority.seatId;
  const capturedSeatRevision = authority.seatContextRevision;
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
      conversation_id: request.conversationId,
      action: request.action,
      mode: request.mode,
      parent_artifact_id: parentArtifactId,
      source_sha256: sourceSha256,
      source_size: sourceSize,
      source_fingerprint: sourceFingerprint,
    });
    if (!seatStillMatches()) return { status: 'refused', reasonCode: 'seat-changed' };
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
}

export interface CommandEveOfficeArtifactReconcileDeps extends CommandEveOfficeArtifactRuntimeDeps {
  fetchTranscript: (conversationId: string, window: number) => Promise<unknown>;
  window?: number;
  log?: (line: string) => void;
  onFreshArtifact?: (conversationId: string) => void;
}

const DEFAULT_WINDOW = 100;
const MAX_OFFICE_RESULTS_PER_OPERATION = 32;
// Two bounded 64 MiB reads cap reconciliation memory without serializing independent results.
const MAX_OFFICE_RESULT_CONCURRENCY = 2;

function runtimeDeps(deps: CommandEveOfficeArtifactRuntimeDeps) {
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
    writeImmutable: deps.writeImmutable ?? writePrivateDocumentImmutable,
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

/**
 * Give every operation from a dead boot a terminal receipt, and answer how many
 * were sealed in this pass.
 *
 * Without this the fence is correct but unbounded: the operation stays pending
 * forever, its document never becomes an artifact, and the marker accumulates
 * for the life of the profile. Sealing changes no authority — a sealed
 * operation is still refused by the same fence; it simply stops being counted
 * as open work.
 */
function sealOperationsFromGoneBoots(input: {
  conversationId: string;
  isProcessAlive: typeof processPidIsAlive;
  operations: readonly CommandEveOfficeOperationRecord[];
  seatId: string;
  store: ProjectWorkspaceConversationArtifactStore;
  summary: CommandEveOfficeArtifactReconcileSummary;
}): number {
  const witnessDirectory = input.store.officeOperationBootWitnessDirectory(input.seatId, input.conversationId);
  let sealed = 0;
  for (const operation of input.operations) {
    try {
      if (
        input.store.readOfficeOperationAbandonment(input.seatId, input.conversationId, operation.operation_id) ||
        input.store.readOfficeOperationCompletion(input.seatId, input.conversationId, operation.operation_id) ||
        !operationBootIsGone(operation, witnessDirectory, input.isProcessAlive)
      ) {
        continue;
      }
      input.store.createOfficeOperationAbandonment({
        seat_id: input.seatId,
        seat_context_revision: operation.seat_context_revision,
        conversation_id: input.conversationId,
        operation_id: operation.operation_id,
      });
      sealed += 1;
    } catch {
      // A seal that cannot be written leaves the operation pending, which is the
      // pre-existing state — never a reason to abort the reconcile that follows.
      input.summary.refused.push({ operationId: operation.operation_id, reason: 'abandonment-failed' });
    }
  }
  return sealed;
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
  result: { buffer: Buffer; sha256: string };
  seatId: string;
}): CommandEveOfficeConversationArtifactPayload {
  const { artifactId, candidate, operation, relativePath, result, seatId } = input;
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
    const relativePath = commandEveOfficeArtifactRelativePath(
      input.conversationId,
      artifactId,
      result.sha256,
      operation.mode
    );
    input.runtime.writeImmutable(
      input.workspace,
      path.resolve(input.workspace, ...relativePath.split('/')),
      result.buffer
    );
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
  let operations: CommandEveOfficeOperationRecord[];
  let existingArtifacts: CommandEveOfficeConversationArtifact[];
  try {
    allOperations = store.listOfficeOperations(seatId, conversationId);
    operations = allOperations.filter((operation) =>
      operationBelongsToActiveGeneration(operation, { seatId, seatRevision, processId, processNonce, conversationId })
    );
    existingArtifacts = store.listOfficeArtifacts(seatId, conversationId);
  } catch {
    summary.refused.push({ operationId: 'office-store', reason: 'store-corrupt' });
    return summary;
  }
  summary.abandoned = sealOperationsFromGoneBoots({
    conversationId,
    isProcessAlive: runtime.isProcessAlive,
    operations: allOperations,
    seatId,
    store,
    summary,
  });
  const existingById = new Map(existingArtifacts.map((artifact) => [artifact.id, artifact]));
  let completedOperationIds: Set<string>;
  try {
    completedOperationIds = store.completedOfficeOperationIdsWithExactReceipts(
      seatId,
      conversationId,
      operations,
      existingArtifacts
    );
  } catch {
    summary.refused.push({ operationId: 'office-store', reason: 'store-corrupt' });
    return summary;
  }
  const pending = operations.filter((operation) => !completedOperationIds.has(operation.operation_id));
  summary.pendingOperations = pending.length;
  summary.alreadyPersisted = operations.length - pending.length;
  if (pending.length === 0) return summary;

  const authority = await runtime.resolveAuthority(conversationId);
  if (authority.status !== 'ready' || authority.seatId !== seatId || authority.seatContextRevision !== seatRevision) {
    summary.refused.push({
      operationId: 'office-authority',
      reason: authority.status === 'ready' ? 'seat-changed' : authority.reasonCode,
    });
    return summary;
  }
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
    const records = store.listOfficeArtifactsWithVerifiedRecordLineage(seatId, conversationId);
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
