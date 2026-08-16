import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ProjectWorkspaceArtifactDTO,
  ProjectWorkspaceArtifactState,
  ProjectWorkspaceConversationArtifactDTO,
} from '@/common/types/project-workspace/ui';
import {
  COMMAND_EVE_OFFICE_LINEAGE_VERSION,
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  COMMAND_EVE_OFFICE_ABANDONMENT_REASON,
  commandEveOfficeExtension,
  parseCommandEveOfficeConversationArtifact,
  parseCommandEveOfficeOperationAbandonmentRecord,
  parseCommandEveOfficeOperationCompletionRecord,
  parseCommandEveOfficeOperationRecord,
  type CommandEveOfficeConversationArtifact,
  type CommandEveOfficeConversationArtifactPayload,
  type CommandEveOfficeArtifactMode,
  type CommandEveOfficeOperationAbandonmentRecord,
  type CommandEveOfficeOperationCompletionRecord,
  type CommandEveOfficeOperationRecord,
} from '@/common/types/office/artifactLineage';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import {
  ensurePrivateDirectory,
  readJson,
  withExclusiveFileLock,
  writeFileCreateOnly,
  writeJsonAtomic,
} from './atomicJson';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const SENSITIVE_KEY =
  /(?:^|_)(?:absolute_?path|canonical_?path|file_?path|ticket|capability|owner_?token|lease|journal|environment_?hint|attestation|compact_?jws|secret|password|token)(?:$|_)/i;
const ABSOLUTE_PATH = /^(?:file:\/\/|~(?:\/|\\)|\/|[a-z]:[\\/]|\\\\)/i;
const EMBEDDED_HOME_PATH = /(?:^|\s)(?:\/Users\/|\/home\/|[a-z]:\\Users\\|\\\\[^\s\\]+\\[^\s\\]+)/i;
const TRANSITIONS: Record<ProjectWorkspaceArtifactState, ReadonlySet<ProjectWorkspaceArtifactState>> = {
  preview: new Set(['awaiting_confirmation', 'committing', 'completed', 'rejected', 'recovery_required']),
  awaiting_confirmation: new Set(['committing', 'completed', 'rejected', 'recovery_required']),
  committing: new Set(['completed', 'rejected', 'recovery_required']),
  completed: new Set(),
  rejected: new Set(),
  recovery_required: new Set(['committing', 'completed', 'rejected']),
};

export function commandEveOfficeArtifactRelativePath(
  conversationId: string,
  artifactId: string,
  sha256: string,
  mode: CommandEveOfficeArtifactMode
): string {
  const conversationKey = crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
  const artifactKey = crypto.createHash('sha256').update(artifactId).digest('hex').slice(0, 24);
  return path.posix.join(
    '.command-eve',
    'conversation-artifacts',
    conversationKey,
    artifactKey + '-' + sha256 + commandEveOfficeExtension(mode)
  );
}

export function commandEveOfficeSourceOperationId(input: {
  seatId: string;
  seatContextRevision: number;
  conversationId: string;
  artifactId: string;
  mode: CommandEveOfficeArtifactMode;
  resultSha256: string;
  resultSize: number;
  sourceTool: CommandEveOfficeConversationArtifactPayload['source_tool'];
  sourceMessageId: string | null;
  sourceTurnId: string | null;
  sourceDirectiveIndex: number | null;
}): string {
  return (
    'officeop_' +
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          'source',
          input.seatId,
          input.seatContextRevision,
          input.conversationId,
          input.artifactId,
          input.mode,
          input.resultSha256,
          input.resultSize,
          input.sourceTool,
          input.sourceMessageId,
          input.sourceTurnId,
          input.sourceDirectiveIndex,
        ])
      )
      .digest('hex')
  );
}

export function commandEveOfficeArtifactPayloadSha256(payload: CommandEveOfficeConversationArtifactPayload): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        payload.artifact_type,
        payload.artifact_id,
        payload.title,
        payload.file_name,
        payload.mime_type,
        payload.path,
        payload.size,
        payload.hash,
        payload.managed_office,
        payload.office_mode,
        payload.origin_capability,
        payload.origin_action,
        payload.parent_artifact_id,
        payload.source_sha256,
        payload.source_size,
        payload.source_fingerprint,
        payload.result_sha256,
        payload.result_fingerprint,
        payload.operation_id,
        payload.seat_id,
        payload.seat_context_revision,
        payload.source_message_id,
        payload.source_turn_id,
        payload.source_directive_index,
        payload.source_tool,
      ])
    )
    .digest('hex');
}

export function commandEveOfficeArtifactMatchesOperation(
  artifact: CommandEveOfficeConversationArtifact,
  operation: CommandEveOfficeOperationRecord
): boolean {
  const sourceMatches =
    operation.action === 'edit'
      ? artifact.payload.source_sha256 === operation.source_sha256 &&
        artifact.payload.source_size === operation.source_size &&
        artifact.payload.source_fingerprint === operation.source_fingerprint
      : operation.source_sha256 === null &&
        operation.source_size === null &&
        operation.source_fingerprint === null &&
        artifact.payload.source_sha256 === artifact.payload.result_sha256 &&
        artifact.payload.source_size === artifact.payload.size &&
        artifact.payload.source_fingerprint === artifact.payload.result_fingerprint;
  return (
    artifact.conversation_id === operation.conversation_id &&
    artifact.payload.operation_id === operation.operation_id &&
    artifact.payload.office_mode === operation.mode &&
    artifact.payload.origin_action === operation.action &&
    artifact.payload.parent_artifact_id === operation.parent_artifact_id &&
    artifact.payload.seat_id === operation.seat_id &&
    artifact.payload.seat_context_revision === operation.seat_context_revision &&
    artifact.payload.source_tool === 'hermes_media_directive' &&
    sourceMatches
  );
}

function officeOperationArtifactReceipts(
  operation: CommandEveOfficeOperationRecord,
  artifacts: readonly CommandEveOfficeConversationArtifact[]
): Array<{ artifact_id: string; payload_sha256: string }> {
  const claimed = artifacts.filter((artifact) => artifact.payload.operation_id === operation.operation_id);
  if (claimed.some((artifact) => !commandEveOfficeArtifactMatchesOperation(artifact, operation))) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  return claimed
    .map((artifact) => ({
      artifact_id: artifact.id,
      payload_sha256: commandEveOfficeArtifactPayloadSha256(artifact.payload),
    }))
    .toSorted((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function officeArtifactParentMatchesSource(
  artifact: CommandEveOfficeConversationArtifact,
  parent: CommandEveOfficeConversationArtifact
): boolean {
  return (
    parent.conversation_id === artifact.conversation_id &&
    parent.payload.seat_id === artifact.payload.seat_id &&
    parent.payload.office_mode === artifact.payload.office_mode &&
    parent.payload.result_sha256 === artifact.payload.source_sha256 &&
    parent.payload.size === artifact.payload.source_size &&
    parent.payload.result_fingerprint === artifact.payload.source_fingerprint
  );
}

function assertOfficeArtifactParentChain(
  artifact: CommandEveOfficeConversationArtifact,
  artifactsById: ReadonlyMap<string, CommandEveOfficeConversationArtifact>,
  visiting: Set<string>,
  verified: Set<string>
): void {
  if (verified.has(artifact.id)) return;
  if (visiting.has(artifact.id)) throw new ProjectWorkspaceError('workspace.journal-corrupt');
  visiting.add(artifact.id);
  if (artifact.payload.origin_action === 'edit') {
    const parentId = artifact.payload.parent_artifact_id;
    const parent = parentId ? artifactsById.get(parentId) : undefined;
    if (!parent || !officeArtifactParentMatchesSource(artifact, parent)) {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
    assertOfficeArtifactParentChain(parent, artifactsById, visiting, verified);
  }
  visiting.delete(artifact.id);
  verified.add(artifact.id);
}

function assertOfficeArtifactParentClosure(artifacts: readonly CommandEveOfficeConversationArtifact[]): void {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const visiting = new Set<string>();
  const verified = new Set<string>();
  for (const artifact of artifacts) assertOfficeArtifactParentChain(artifact, artifactsById, visiting, verified);
}

function assertSafeValue(value: unknown, key = ''): void {
  if (SENSITIVE_KEY.test(key)) throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  if (typeof value === 'string') {
    if (
      value.length === 0 ||
      value.length > 500 ||
      value.includes('\0') ||
      ABSOLUTE_PATH.test(value) ||
      EMBEDDED_HOME_PATH.test(value)
    ) {
      throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    value.forEach((item) => assertSafeValue(item, key));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([nestedKey, nested]) =>
      assertSafeValue(nested, nestedKey)
    );
  }
}

function parseArtifact(value: unknown): ProjectWorkspaceConversationArtifactDTO {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  const artifact = value as Record<string, unknown>;
  const keys = ['id', 'conversation_id', 'kind', 'status', 'payload', 'created_at', 'updated_at'];
  if (
    Object.keys(artifact).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(artifact, key)) ||
    typeof artifact.id !== 'string' ||
    !SAFE_ID.test(artifact.id) ||
    typeof artifact.conversation_id !== 'string' ||
    !SAFE_ID.test(artifact.conversation_id) ||
    artifact.kind !== 'project_workspace' ||
    artifact.status !== 'active' ||
    typeof artifact.created_at !== 'number' ||
    !Number.isSafeInteger(artifact.created_at) ||
    artifact.created_at < 0 ||
    typeof artifact.updated_at !== 'number' ||
    !Number.isSafeInteger(artifact.updated_at) ||
    artifact.updated_at < artifact.created_at ||
    !artifact.payload ||
    typeof artifact.payload !== 'object' ||
    Array.isArray(artifact.payload)
  ) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  assertSafeValue(artifact.payload);
  const payload = artifact.payload as Record<string, unknown>;
  if (payload.artifact_id !== artifact.id || !TRANSITIONS[payload.state as ProjectWorkspaceArtifactState]) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  return artifact as ProjectWorkspaceConversationArtifactDTO;
}

type StoredConversationArtifact = ProjectWorkspaceConversationArtifactDTO | CommandEveOfficeConversationArtifact;

function parseStoredArtifact(value: unknown): StoredConversationArtifact {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === 'file'
  ) {
    try {
      return parseCommandEveOfficeConversationArtifact(value);
    } catch {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
  }
  return parseArtifact(value);
}

function artifactMatchesOfficeStoreLocation(
  artifact: CommandEveOfficeConversationArtifact,
  seatId: string,
  conversationId: string,
  fileName: string
): boolean {
  const sourceOperationMatches =
    artifact.payload.origin_action !== 'source' ||
    artifact.payload.operation_id ===
      commandEveOfficeSourceOperationId({
        seatId,
        seatContextRevision: artifact.payload.seat_context_revision,
        conversationId,
        artifactId: artifact.id,
        mode: artifact.payload.office_mode,
        resultSha256: artifact.payload.result_sha256,
        resultSize: artifact.payload.size,
        sourceTool: artifact.payload.source_tool,
        sourceMessageId: artifact.payload.source_message_id,
        sourceTurnId: artifact.payload.source_turn_id,
        sourceDirectiveIndex: artifact.payload.source_directive_index,
      });
  return (
    artifact.conversation_id === conversationId &&
    artifact.payload.seat_id === seatId &&
    fileName === artifact.id + '.json' &&
    artifact.payload.path ===
      commandEveOfficeArtifactRelativePath(
        conversationId,
        artifact.id,
        artifact.payload.result_sha256,
        artifact.payload.office_mode
      ) &&
    sourceOperationMatches
  );
}

function assertOfficeRecordDirectoryDurable(directory: string): void {
  const named = fs.lstatSync(directory);
  if (!named.isDirectory() || named.isSymbolicLink()) {
    throw new ProjectWorkspaceError('workspace.io-failed');
  }
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new ProjectWorkspaceError('workspace.io-failed');
    }
    fs.fsyncSync(descriptor);
    const current = fs.lstatSync(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new ProjectWorkspaceError('workspace.io-failed');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readImmutableOfficeRecordText(file: string): string {
  let descriptor: number | undefined;
  try {
    const named = fs.lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) {
      throw new Error('Office record identity is not immutable.');
    }
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== named.size ||
      before.mtimeMs !== named.mtimeMs ||
      before.ctimeMs !== named.ctimeMs
    ) {
      throw new Error('Office record identity changed before read.');
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs ||
      current.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('Office record identity changed during read.');
    }
    return text;
  } catch {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readImmutableOfficeRecord(file: string): unknown {
  try {
    return JSON.parse(readImmutableOfficeRecordText(file)) as unknown;
  } catch {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
}

function assertPublishedOfficeRecord(file: string, expected: string): void {
  try {
    if (readImmutableOfficeRecordText(file) !== expected) throw new Error('Office record bytes changed.');
  } catch {
    throw new ProjectWorkspaceError('workspace.io-failed');
  }
}

function assertOfficeRecordChainDurable(stateRoot: string, directory: string): void {
  const root = path.resolve(stateRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProjectWorkspaceError('workspace.io-failed');
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ProjectWorkspaceError('workspace.io-failed');
  }
  assertOfficeRecordDirectoryDurable(path.dirname(root));
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    const child = path.join(current, component);
    const childStat = fs.lstatSync(child);
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new ProjectWorkspaceError('workspace.io-failed');
    }
    assertOfficeRecordDirectoryDurable(current);
    current = child;
  }
  assertOfficeRecordDirectoryDurable(current);
}

function ensureOfficeRecordChainDurable(stateRoot: string, directory: string): void {
  const root = path.resolve(stateRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProjectWorkspaceError('workspace.io-failed');
  }
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ProjectWorkspaceError('workspace.io-failed');
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    const child = path.join(current, component);
    try {
      fs.mkdirSync(child, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const childStat = fs.lstatSync(child);
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new ProjectWorkspaceError('workspace.io-failed');
    }
    current = child;
  }
  assertOfficeRecordChainDurable(root, target);
}

function publishOfficeRecordOnce(stateRoot: string, file: string, value: unknown): boolean {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  assertOfficeRecordChainDurable(stateRoot, path.dirname(file));
  try {
    writeFileCreateOnly(file, serialized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  assertOfficeRecordChainDurable(stateRoot, path.dirname(file));
  assertPublishedOfficeRecord(file, serialized);
  return true;
}

export type ProjectWorkspaceConversationArtifactStoreOptions = {
  state_root: string;
  now?: () => number;
  on_changed?: (artifact: ProjectWorkspaceConversationArtifactDTO) => void;
  on_office_changed?: (artifact: CommandEveOfficeConversationArtifact) => void;
};

export class ProjectWorkspaceConversationArtifactStore {
  private readonly now: () => number;

  constructor(private readonly options: ProjectWorkspaceConversationArtifactStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  private directory(seatId: string, conversationId: string): string {
    if (!SAFE_ID.test(seatId) || !SAFE_ID.test(conversationId)) throw new ProjectWorkspaceError('identity.invalid');
    return path.join(this.options.state_root, 'conversation-artifacts', seatId, conversationId);
  }

  private file(seatId: string, conversationId: string, artifactId: string): string {
    if (!SAFE_ID.test(artifactId)) throw new ProjectWorkspaceError('identity.invalid');
    return path.join(this.directory(seatId, conversationId), `${artifactId}.json`);
  }

  private lock(seatId: string, conversationId: string, artifactId: string): string {
    return path.join(this.directory(seatId, conversationId), '.locks', `${artifactId}.lock`);
  }

  private officeOperationDirectory(seatId: string, conversationId: string): string {
    return path.join(this.directory(seatId, conversationId), '.office-operations');
  }

  private officeOperationFile(seatId: string, conversationId: string, operationId: string): string {
    if (!SAFE_ID.test(operationId)) throw new ProjectWorkspaceError('identity.invalid');
    return path.join(this.officeOperationDirectory(seatId, conversationId), `${operationId}.json`);
  }

  /**
   * Where `withExclusiveFileLock` publishes the boot witness for these
   * operations. A caller comparing an operation against a live process needs
   * this exact directory, or it judges the wrong boot.
   */
  officeOperationBootWitnessDirectory(seatId: string, conversationId: string): string {
    return path.join(this.officeOperationDirectory(seatId, conversationId), '.locks');
  }

  private officeOperationLock(seatId: string, conversationId: string, operationId: string): string {
    return path.join(this.officeOperationBootWitnessDirectory(seatId, conversationId), `${operationId}.lock`);
  }

  private officeOperationCompletionDirectory(seatId: string, conversationId: string): string {
    return path.join(this.officeOperationDirectory(seatId, conversationId), '.completed');
  }

  private officeOperationCompletionFile(seatId: string, conversationId: string, operationId: string): string {
    if (!SAFE_ID.test(operationId)) throw new ProjectWorkspaceError('identity.invalid');
    return path.join(this.officeOperationCompletionDirectory(seatId, conversationId), `${operationId}.json`);
  }

  private officeOperationCompletionLock(seatId: string, conversationId: string, operationId: string): string {
    return path.join(this.officeOperationCompletionDirectory(seatId, conversationId), '.locks', `${operationId}.lock`);
  }

  private officeOperationAbandonmentDirectory(seatId: string, conversationId: string): string {
    return path.join(this.officeOperationDirectory(seatId, conversationId), '.abandoned');
  }

  private officeOperationAbandonmentFile(seatId: string, conversationId: string, operationId: string): string {
    if (!SAFE_ID.test(operationId)) throw new ProjectWorkspaceError('identity.invalid');
    return path.join(this.officeOperationAbandonmentDirectory(seatId, conversationId), `${operationId}.json`);
  }

  private officeOperationAbandonmentLock(seatId: string, conversationId: string, operationId: string): string {
    return path.join(this.officeOperationAbandonmentDirectory(seatId, conversationId), '.locks', `${operationId}.lock`);
  }

  list(seatId: string, conversationId: string): ProjectWorkspaceConversationArtifactDTO[] {
    const directory = this.directory(seatId, conversationId);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => parseStoredArtifact(readJson(path.join(directory, entry.name))))
      .filter((artifact): artifact is ProjectWorkspaceConversationArtifactDTO => artifact.kind === 'project_workspace')
      .toSorted((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
  }

  listOfficeArtifacts(seatId: string, conversationId: string): CommandEveOfficeConversationArtifact[] {
    const directory = this.directory(seatId, conversationId);
    if (!fs.existsSync(directory)) return [];
    assertOfficeRecordChainDurable(this.options.state_root, directory);
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.json'))
      .map((entry) => {
        const artifact = parseStoredArtifact(readImmutableOfficeRecord(path.join(directory, entry.name)));
        if (
          artifact.kind === 'file' &&
          !artifactMatchesOfficeStoreLocation(artifact, seatId, conversationId, entry.name)
        ) {
          throw new ProjectWorkspaceError('workspace.journal-corrupt');
        }
        return artifact;
      })
      .filter((artifact): artifact is CommandEveOfficeConversationArtifact => artifact.kind === 'file')
      .toSorted((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
  }

  readOfficeArtifact(
    seatId: string,
    conversationId: string,
    artifactId: string
  ): CommandEveOfficeConversationArtifact | null {
    const file = this.file(seatId, conversationId, artifactId);
    if (!fs.existsSync(file)) return null;
    assertOfficeRecordChainDurable(this.options.state_root, path.dirname(file));
    const artifact = parseStoredArtifact(readImmutableOfficeRecord(file));
    if (
      artifact.kind !== 'file' ||
      artifact.id !== artifactId ||
      !artifactMatchesOfficeStoreLocation(artifact, seatId, conversationId, artifactId + '.json')
    ) {
      throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    }
    return artifact;
  }

  completedOfficeOperationIdsWithExactReceipts(
    seatId: string,
    conversationId: string,
    operations: readonly CommandEveOfficeOperationRecord[],
    artifacts: readonly CommandEveOfficeConversationArtifact[]
  ): Set<string> {
    const completed = new Set<string>();
    const seenOperationIds = new Set<string>();
    for (const operation of operations) {
      if (
        operation.seat_id !== seatId ||
        operation.conversation_id !== conversationId ||
        seenOperationIds.has(operation.operation_id)
      ) {
        throw new ProjectWorkspaceError('workspace.journal-corrupt');
      }
      seenOperationIds.add(operation.operation_id);
      const expectedReceipts = officeOperationArtifactReceipts(operation, artifacts);
      const completion = this.readOfficeOperationCompletion(seatId, conversationId, operation.operation_id);
      if (!completion) continue;
      if (
        completion.seat_context_revision !== operation.seat_context_revision ||
        !isDeepStrictEqual(completion.artifact_receipts, expectedReceipts)
      ) {
        throw new ProjectWorkspaceError('workspace.journal-corrupt');
      }
      completed.add(operation.operation_id);
    }
    return completed;
  }

  listOfficeArtifactsWithVerifiedRecordLineage(
    seatId: string,
    conversationId: string
  ): CommandEveOfficeConversationArtifact[] {
    const artifacts = this.listOfficeArtifacts(seatId, conversationId);
    const operationsById = new Map<string, CommandEveOfficeOperationRecord>();
    for (const artifact of artifacts) {
      if (artifact.payload.origin_action === 'source') continue;
      const operation =
        operationsById.get(artifact.payload.operation_id) ??
        this.readOfficeOperation(seatId, conversationId, artifact.payload.operation_id);
      if (!operation || !commandEveOfficeArtifactMatchesOperation(artifact, operation)) {
        throw new ProjectWorkspaceError('workspace.journal-corrupt');
      }
      operationsById.set(operation.operation_id, operation);
    }
    const completedOperationIds = this.completedOfficeOperationIdsWithExactReceipts(
      seatId,
      conversationId,
      [...operationsById.values()],
      artifacts
    );
    const verified = artifacts.filter(
      (artifact) =>
        artifact.payload.origin_action === 'source' || completedOperationIds.has(artifact.payload.operation_id)
    );
    assertOfficeArtifactParentClosure(verified);
    return verified;
  }

  readOfficeArtifactWithVerifiedRecordLineage(
    seatId: string,
    conversationId: string,
    artifactId: string
  ): CommandEveOfficeConversationArtifact | null {
    const verified = this.listOfficeArtifactsWithVerifiedRecordLineage(seatId, conversationId).find(
      (artifact) => artifact.id === artifactId
    );
    if (verified) return verified;
    if (this.readOfficeArtifact(seatId, conversationId, artifactId)) {
      throw new ProjectWorkspaceError('workspace.recovery-required');
    }
    return null;
  }

  createOfficeArtifact(input: {
    seat_id: string;
    conversation_id: string;
    artifact_id: string;
    payload: CommandEveOfficeConversationArtifactPayload;
  }): CommandEveOfficeConversationArtifact {
    if (input.payload.artifact_id !== input.artifact_id || input.payload.seat_id !== input.seat_id) {
      throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    }
    const lock = this.lock(input.seat_id, input.conversation_id, input.artifact_id);
    ensureOfficeRecordChainDurable(this.options.state_root, path.dirname(lock));
    return withExclusiveFileLock(lock, () => {
      const file = this.file(input.seat_id, input.conversation_id, input.artifact_id);
      if (fs.existsSync(file)) {
        const existing = this.readOfficeArtifact(input.seat_id, input.conversation_id, input.artifact_id);
        if (!existing || !isDeepStrictEqual(existing.payload, input.payload)) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return existing;
      }
      const timestamp = Math.max(0, Math.trunc(this.now()));
      let artifact: CommandEveOfficeConversationArtifact;
      try {
        artifact = parseCommandEveOfficeConversationArtifact({
          id: input.artifact_id,
          conversation_id: input.conversation_id,
          kind: 'file',
          status: 'active',
          payload: input.payload,
          created_at: timestamp,
          updated_at: timestamp,
        });
      } catch {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      if (
        !artifactMatchesOfficeStoreLocation(artifact, input.seat_id, input.conversation_id, input.artifact_id + '.json')
      ) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      if (!publishOfficeRecordOnce(this.options.state_root, file, artifact)) {
        const winner = this.readOfficeArtifact(input.seat_id, input.conversation_id, input.artifact_id);
        if (!winner || !isDeepStrictEqual(winner.payload, input.payload)) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return winner;
      }
      this.options.on_office_changed?.(artifact);
      return artifact;
    });
  }

  listOfficeOperations(seatId: string, conversationId: string): CommandEveOfficeOperationRecord[] {
    const directory = this.officeOperationDirectory(seatId, conversationId);
    if (!fs.existsSync(directory)) return [];
    assertOfficeRecordChainDurable(this.options.state_root, directory);
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.json'))
      .map((entry) => {
        try {
          const operation = parseCommandEveOfficeOperationRecord(
            readImmutableOfficeRecord(path.join(directory, entry.name))
          );
          if (
            operation.seat_id !== seatId ||
            operation.conversation_id !== conversationId ||
            entry.name !== operation.operation_id + '.json'
          ) {
            throw new Error('Office operation membership mismatch');
          }
          return operation;
        } catch {
          throw new ProjectWorkspaceError('workspace.journal-corrupt');
        }
      })
      .toSorted(
        (left, right) => left.created_at - right.created_at || left.operation_id.localeCompare(right.operation_id)
      );
  }

  readOfficeOperation(
    seatId: string,
    conversationId: string,
    operationId: string
  ): CommandEveOfficeOperationRecord | null {
    const file = this.officeOperationFile(seatId, conversationId, operationId);
    if (!fs.existsSync(file)) return null;
    assertOfficeRecordChainDurable(this.options.state_root, path.dirname(file));
    try {
      const operation = parseCommandEveOfficeOperationRecord(readImmutableOfficeRecord(file));
      if (
        operation.operation_id !== operationId ||
        operation.seat_id !== seatId ||
        operation.conversation_id !== conversationId
      ) {
        throw new Error('Office operation membership mismatch');
      }
      return operation;
    } catch {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
  }

  createOfficeOperation(
    input: Omit<CommandEveOfficeOperationRecord, 'version' | 'origin_capability' | 'created_at'>
  ): CommandEveOfficeOperationRecord {
    const lock = this.officeOperationLock(input.seat_id, input.conversation_id, input.operation_id);
    ensureOfficeRecordChainDurable(this.options.state_root, path.dirname(lock));
    return withExclusiveFileLock(lock, () => {
      const file = this.officeOperationFile(input.seat_id, input.conversation_id, input.operation_id);
      const build = (createdAt: number): CommandEveOfficeOperationRecord => ({
        version: COMMAND_EVE_OFFICE_LINEAGE_VERSION,
        operation_id: input.operation_id,
        request_id: input.request_id,
        seat_id: input.seat_id,
        seat_context_revision: input.seat_context_revision,
        process_id: input.process_id,
        process_nonce_sha256: input.process_nonce_sha256,
        conversation_id: input.conversation_id,
        action: input.action,
        mode: input.mode,
        origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
        parent_artifact_id: input.parent_artifact_id,
        source_sha256: input.source_sha256,
        source_size: input.source_size,
        source_fingerprint: input.source_fingerprint,
        created_at: createdAt,
      });
      if (fs.existsSync(file)) {
        const existing = this.readOfficeOperation(input.seat_id, input.conversation_id, input.operation_id);
        if (!existing || !isDeepStrictEqual(existing, build(existing.created_at))) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return existing;
      }
      let operation: CommandEveOfficeOperationRecord;
      try {
        operation = parseCommandEveOfficeOperationRecord(build(Math.max(0, Math.trunc(this.now()))));
      } catch {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      if (!publishOfficeRecordOnce(this.options.state_root, file, operation)) {
        const winner = this.readOfficeOperation(input.seat_id, input.conversation_id, input.operation_id);
        if (!winner || !isDeepStrictEqual(winner, build(winner.created_at))) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return winner;
      }
      return operation;
    });
  }

  readOfficeOperationCompletion(
    seatId: string,
    conversationId: string,
    operationId: string
  ): CommandEveOfficeOperationCompletionRecord | null {
    const file = this.officeOperationCompletionFile(seatId, conversationId, operationId);
    if (!fs.existsSync(file)) return null;
    assertOfficeRecordChainDurable(this.options.state_root, path.dirname(file));
    try {
      const completion = parseCommandEveOfficeOperationCompletionRecord(readImmutableOfficeRecord(file));
      if (
        completion.operation_id !== operationId ||
        completion.seat_id !== seatId ||
        completion.conversation_id !== conversationId
      ) {
        throw new Error('Office operation completion membership mismatch');
      }
      return completion;
    } catch {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
  }

  createOfficeOperationCompletion(input: {
    seat_id: string;
    seat_context_revision: number;
    conversation_id: string;
    operation_id: string;
    artifact_receipts: Array<{ artifact_id: string; payload_sha256: string }>;
  }): CommandEveOfficeOperationCompletionRecord {
    const lock = this.officeOperationCompletionLock(input.seat_id, input.conversation_id, input.operation_id);
    ensureOfficeRecordChainDurable(this.options.state_root, path.dirname(lock));
    return withExclusiveFileLock(lock, () => {
      const file = this.officeOperationCompletionFile(input.seat_id, input.conversation_id, input.operation_id);
      const build = (completedAt: number): CommandEveOfficeOperationCompletionRecord => ({
        version: COMMAND_EVE_OFFICE_LINEAGE_VERSION,
        operation_id: input.operation_id,
        seat_id: input.seat_id,
        seat_context_revision: input.seat_context_revision,
        conversation_id: input.conversation_id,
        artifact_receipts: input.artifact_receipts
          .map((receipt) => ({ ...receipt }))
          .toSorted((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
        completed_at: completedAt,
      });
      if (fs.existsSync(file)) {
        const existing = this.readOfficeOperationCompletion(input.seat_id, input.conversation_id, input.operation_id);
        if (!existing || !isDeepStrictEqual(existing, build(existing.completed_at))) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return existing;
      }
      let completion: CommandEveOfficeOperationCompletionRecord;
      try {
        completion = parseCommandEveOfficeOperationCompletionRecord(build(Math.max(0, Math.trunc(this.now()))));
      } catch {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      if (!publishOfficeRecordOnce(this.options.state_root, file, completion)) {
        const winner = this.readOfficeOperationCompletion(input.seat_id, input.conversation_id, input.operation_id);
        if (!winner || !isDeepStrictEqual(winner, build(winner.completed_at))) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return winner;
      }
      return completion;
    });
  }

  readOfficeOperationAbandonment(
    seatId: string,
    conversationId: string,
    operationId: string
  ): CommandEveOfficeOperationAbandonmentRecord | null {
    const file = this.officeOperationAbandonmentFile(seatId, conversationId, operationId);
    if (!fs.existsSync(file)) return null;
    assertOfficeRecordChainDurable(this.options.state_root, path.dirname(file));
    try {
      const abandonment = parseCommandEveOfficeOperationAbandonmentRecord(readImmutableOfficeRecord(file));
      if (
        abandonment.operation_id !== operationId ||
        abandonment.seat_id !== seatId ||
        abandonment.conversation_id !== conversationId
      ) {
        throw new Error('Office operation abandonment membership mismatch');
      }
      return abandonment;
    } catch {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
  }

  /**
   * Seal an operation whose owning Main boot is gone as terminally abandoned.
   *
   * The operation record itself is immutable by contract, so the terminal state
   * is a separate create-only receipt: the pending marker keeps its evidence,
   * and the operation stops being reported as open work forever.
   */
  createOfficeOperationAbandonment(input: {
    seat_id: string;
    seat_context_revision: number;
    conversation_id: string;
    operation_id: string;
  }): CommandEveOfficeOperationAbandonmentRecord {
    const lock = this.officeOperationAbandonmentLock(input.seat_id, input.conversation_id, input.operation_id);
    ensureOfficeRecordChainDurable(this.options.state_root, path.dirname(lock));
    return withExclusiveFileLock(lock, () => {
      const file = this.officeOperationAbandonmentFile(input.seat_id, input.conversation_id, input.operation_id);
      const build = (abandonedAt: number): CommandEveOfficeOperationAbandonmentRecord => ({
        version: COMMAND_EVE_OFFICE_LINEAGE_VERSION,
        operation_id: input.operation_id,
        seat_id: input.seat_id,
        seat_context_revision: input.seat_context_revision,
        conversation_id: input.conversation_id,
        reason: COMMAND_EVE_OFFICE_ABANDONMENT_REASON,
        abandoned_at: abandonedAt,
      });
      if (fs.existsSync(file)) {
        const existing = this.readOfficeOperationAbandonment(input.seat_id, input.conversation_id, input.operation_id);
        if (!existing || !isDeepStrictEqual(existing, build(existing.abandoned_at))) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return existing;
      }
      let abandonment: CommandEveOfficeOperationAbandonmentRecord;
      try {
        abandonment = parseCommandEveOfficeOperationAbandonmentRecord(build(Math.max(0, Math.trunc(this.now()))));
      } catch {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      if (!publishOfficeRecordOnce(this.options.state_root, file, abandonment)) {
        const winner = this.readOfficeOperationAbandonment(input.seat_id, input.conversation_id, input.operation_id);
        if (!winner || !isDeepStrictEqual(winner, build(winner.abandoned_at))) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return winner;
      }
      return abandonment;
    });
  }

  create(input: {
    seat_id: string;
    conversation_id: string;
    artifact_id: string;
    payload: ProjectWorkspaceArtifactDTO;
  }): ProjectWorkspaceConversationArtifactDTO {
    return withExclusiveFileLock(this.lock(input.seat_id, input.conversation_id, input.artifact_id), () => {
      const file = this.file(input.seat_id, input.conversation_id, input.artifact_id);
      if (fs.existsSync(file)) {
        const existing = parseArtifact(readJson(file));
        if (JSON.stringify(existing.payload) !== JSON.stringify(input.payload)) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return existing;
      }
      if (input.payload.artifact_id !== input.artifact_id || input.payload.state !== 'preview') {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      assertSafeValue(input.payload);
      const timestamp = Math.max(0, Math.trunc(this.now()));
      const artifact: ProjectWorkspaceConversationArtifactDTO = {
        id: input.artifact_id,
        conversation_id: input.conversation_id,
        kind: 'project_workspace',
        status: 'active',
        payload: input.payload,
        created_at: timestamp,
        updated_at: timestamp,
      };
      ensurePrivateDirectory(this.directory(input.seat_id, input.conversation_id));
      writeJsonAtomic(file, artifact);
      this.options.on_changed?.(artifact);
      return artifact;
    });
  }

  transition(input: {
    seat_id: string;
    conversation_id: string;
    artifact_id: string;
    expected_state: ProjectWorkspaceArtifactState;
    payload: ProjectWorkspaceArtifactDTO;
  }): ProjectWorkspaceConversationArtifactDTO {
    return withExclusiveFileLock(this.lock(input.seat_id, input.conversation_id, input.artifact_id), () => {
      const file = this.file(input.seat_id, input.conversation_id, input.artifact_id);
      if (!fs.existsSync(file)) throw new ProjectWorkspaceError('workspace.recovery-required');
      const current = parseArtifact(readJson(file));
      if (
        current.payload.state !== input.expected_state ||
        input.payload.artifact_id !== input.artifact_id ||
        !TRANSITIONS[input.expected_state].has(input.payload.state)
      ) {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }
      assertSafeValue(input.payload);
      const next: ProjectWorkspaceConversationArtifactDTO = {
        ...current,
        payload: input.payload,
        updated_at: Math.max(current.updated_at + 1, Math.trunc(this.now())),
      };
      writeJsonAtomic(file, next);
      this.options.on_changed?.(next);
      return next;
    });
  }

  /**
   * Revision-guarded correction of a completed assignment artifact.
   *
   * This is deliberately separate from the lifecycle transition graph: a
   * user is finalizing the metadata of an already completed assignment, not
   * reopening the original create/bind operation. The exact `updated_at`
   * compare-and-swap prevents a stale dialog from overwriting a newer choice.
   */
  reviseCompleted(input: {
    seat_id: string;
    conversation_id: string;
    artifact_id: string;
    expected_updated_at: number;
    payload: ProjectWorkspaceArtifactDTO;
  }): ProjectWorkspaceConversationArtifactDTO {
    return withExclusiveFileLock(this.lock(input.seat_id, input.conversation_id, input.artifact_id), () => {
      const file = this.file(input.seat_id, input.conversation_id, input.artifact_id);
      if (!fs.existsSync(file)) throw new ProjectWorkspaceError('catalog.revision-conflict');
      const current = parseArtifact(readJson(file));
      if (
        current.updated_at !== input.expected_updated_at ||
        current.payload.state !== 'completed' ||
        input.payload.state !== 'completed' ||
        input.payload.artifact_id !== input.artifact_id
      ) {
        throw new ProjectWorkspaceError('catalog.revision-conflict');
      }
      assertSafeValue(input.payload);
      const next: ProjectWorkspaceConversationArtifactDTO = {
        ...current,
        payload: input.payload,
        updated_at: Math.max(current.updated_at + 1, Math.trunc(this.now())),
      };
      writeJsonAtomic(file, next);
      this.options.on_changed?.(next);
      return next;
    });
  }
}
