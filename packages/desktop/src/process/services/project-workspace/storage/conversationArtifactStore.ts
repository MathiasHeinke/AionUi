import fs from 'node:fs';
import path from 'node:path';
import type {
  ProjectWorkspaceArtifactDTO,
  ProjectWorkspaceArtifactState,
  ProjectWorkspaceConversationArtifactDTO,
} from '@/common/types/project-workspace/ui';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import { ensurePrivateDirectory, readJson, withExclusiveFileLock, writeJsonAtomic } from './atomicJson';

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

export type ProjectWorkspaceConversationArtifactStoreOptions = {
  state_root: string;
  now?: () => number;
  on_changed?: (artifact: ProjectWorkspaceConversationArtifactDTO) => void;
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

  list(seatId: string, conversationId: string): ProjectWorkspaceConversationArtifactDTO[] {
    const directory = this.directory(seatId, conversationId);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => parseArtifact(readJson(path.join(directory, entry.name))))
      .toSorted((left, right) => left.created_at - right.created_at);
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
