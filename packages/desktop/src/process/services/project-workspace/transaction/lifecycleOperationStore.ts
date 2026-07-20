import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import type { ProjectWorkspaceUiReasonCode } from '@/common/types/project-workspace/ui';
import { ensurePrivateDirectory, readJson, withExclusiveFileLock, writeJsonAtomic } from '../storage/atomicJson';

export const PROJECT_LIFECYCLE_OPERATION_VERSION = 'command-eve-project-lifecycle-operation/v1' as const;

export type ProjectLifecycleOperationName = 'update_metadata' | 'archive' | 'restore' | 'bind' | 'unbind';

export type ProjectLifecycleOperationPhase = 'planned' | 'mutating' | 'committed' | 'rejected' | 'recovery_required';

export type ProjectLifecycleOperationReceipt = {
  receipt_id: string;
  outcome: 'completed' | 'rejected' | 'recovery_required';
  completed_at: number;
  reason_code?: ProjectWorkspaceUiReasonCode;
};

export type ProjectLifecycleOperationV1 = {
  schema_version: typeof PROJECT_LIFECYCLE_OPERATION_VERSION;
  idempotency_key: string;
  request_sha256: string;
  operation: ProjectLifecycleOperationName;
  phase: ProjectLifecycleOperationPhase;
  seat_id: string;
  project_id: string;
  expected_revision: number;
  seat_context_revision: number;
  conversation_id?: string;
  expected_project_binding_revision?: number;
  expected_project_binding_receipt_id?: string | null;
  expected_title?: string;
  desired_title?: string;
  expected_status?: 'active' | 'archived' | 'recovery_required';
  desired_status?: 'active' | 'archived' | 'recovery_required';
  receipt?: ProjectLifecycleOperationReceipt;
  created_at: string;
  updated_at: string;
};

export type PrepareProjectLifecycleOperationInput = Omit<
  ProjectLifecycleOperationV1,
  'schema_version' | 'request_sha256' | 'phase' | 'receipt' | 'created_at' | 'updated_at'
> & {
  request: unknown;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const OPERATIONS = new Set<ProjectLifecycleOperationName>(['update_metadata', 'archive', 'restore', 'bind', 'unbind']);
const PHASES = new Set<ProjectLifecycleOperationPhase>([
  'planned',
  'mutating',
  'committed',
  'rejected',
  'recovery_required',
]);
const TRANSITIONS: Record<ProjectLifecycleOperationPhase, ReadonlySet<ProjectLifecycleOperationPhase>> = {
  planned: new Set(['mutating', 'rejected']),
  mutating: new Set(['committed', 'recovery_required']),
  committed: new Set(),
  rejected: new Set(),
  recovery_required: new Set(['mutating', 'committed', 'rejected']),
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

export function hashProjectLifecycleRequest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex');
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const RECORD_KEYS = new Set([
  'schema_version',
  'idempotency_key',
  'request_sha256',
  'operation',
  'phase',
  'seat_id',
  'project_id',
  'expected_revision',
  'seat_context_revision',
  'conversation_id',
  'expected_project_binding_revision',
  'expected_project_binding_receipt_id',
  'expected_title',
  'desired_title',
  'expected_status',
  'desired_status',
  'receipt',
  'created_at',
  'updated_at',
]);
const RECEIPT_KEYS = new Set(['receipt_id', 'outcome', 'completed_at', 'reason_code']);

export function parseProjectLifecycleOperation(value: unknown): ProjectLifecycleOperationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  const record = value as Record<string, unknown>;
  const receipt = record.receipt;
  const validReceipt =
    receipt === undefined ||
    (typeof receipt === 'object' &&
      receipt !== null &&
      !Array.isArray(receipt) &&
      exactKeys(receipt as Record<string, unknown>, RECEIPT_KEYS) &&
      typeof (receipt as Record<string, unknown>).receipt_id === 'string' &&
      SAFE_ID.test((receipt as Record<string, unknown>).receipt_id as string) &&
      ['completed', 'rejected', 'recovery_required'].includes((receipt as Record<string, unknown>).outcome as string) &&
      typeof (receipt as Record<string, unknown>).completed_at === 'number' &&
      Number.isSafeInteger((receipt as Record<string, unknown>).completed_at) &&
      ((receipt as Record<string, unknown>).completed_at as number) >= 0 &&
      ((receipt as Record<string, unknown>).reason_code === undefined ||
        typeof (receipt as Record<string, unknown>).reason_code === 'string'));
  if (
    !exactKeys(record, RECORD_KEYS) ||
    record.schema_version !== PROJECT_LIFECYCLE_OPERATION_VERSION ||
    typeof record.idempotency_key !== 'string' ||
    !UUID_V4.test(record.idempotency_key) ||
    typeof record.request_sha256 !== 'string' ||
    !SHA256.test(record.request_sha256) ||
    !OPERATIONS.has(record.operation as ProjectLifecycleOperationName) ||
    !PHASES.has(record.phase as ProjectLifecycleOperationPhase) ||
    typeof record.seat_id !== 'string' ||
    !SAFE_ID.test(record.seat_id) ||
    typeof record.project_id !== 'string' ||
    !SAFE_ID.test(record.project_id) ||
    typeof record.expected_revision !== 'number' ||
    !Number.isSafeInteger(record.expected_revision) ||
    record.expected_revision < 0 ||
    typeof record.seat_context_revision !== 'number' ||
    !Number.isSafeInteger(record.seat_context_revision) ||
    record.seat_context_revision < 0 ||
    (record.conversation_id !== undefined &&
      (typeof record.conversation_id !== 'string' || !SAFE_ID.test(record.conversation_id))) ||
    (record.expected_project_binding_revision !== undefined &&
      (typeof record.expected_project_binding_revision !== 'number' ||
        !Number.isSafeInteger(record.expected_project_binding_revision) ||
        record.expected_project_binding_revision < 0)) ||
    (record.expected_project_binding_receipt_id !== undefined &&
      record.expected_project_binding_receipt_id !== null &&
      (typeof record.expected_project_binding_receipt_id !== 'string' ||
        !SAFE_ID.test(record.expected_project_binding_receipt_id))) ||
    (record.expected_title !== undefined &&
      (typeof record.expected_title !== 'string' ||
        !record.expected_title.trim() ||
        record.expected_title.length > 200)) ||
    (record.desired_title !== undefined &&
      (typeof record.desired_title !== 'string' ||
        !record.desired_title.trim() ||
        record.desired_title.length > 200)) ||
    (record.expected_status !== undefined &&
      !['active', 'archived', 'recovery_required'].includes(record.expected_status as string)) ||
    (record.desired_status !== undefined &&
      !['active', 'archived', 'recovery_required'].includes(record.desired_status as string)) ||
    typeof record.created_at !== 'string' ||
    !TIMESTAMP.test(record.created_at) ||
    typeof record.updated_at !== 'string' ||
    !TIMESTAMP.test(record.updated_at) ||
    !validReceipt
  ) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  return record as ProjectLifecycleOperationV1;
}

export class ProjectLifecycleOperationStore {
  constructor(
    private readonly stateRoot: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private directory(seatId: string): string {
    if (!SAFE_ID.test(seatId)) throw new ProjectWorkspaceError('identity.invalid');
    return path.join(this.stateRoot, 'lifecycle-operations', seatId);
  }

  private file(seatId: string, idempotencyKey: string): string {
    if (!UUID_V4.test(idempotencyKey)) throw new ProjectWorkspaceError('identity.invalid');
    return path.join(this.directory(seatId), `${idempotencyKey}.json`);
  }

  private lock(seatId: string, idempotencyKey: string): string {
    return path.join(this.directory(seatId), '.locks', `${idempotencyKey}.lock`);
  }

  read(seatId: string, idempotencyKey: string): ProjectLifecycleOperationV1 | undefined {
    const file = this.file(seatId, idempotencyKey);
    if (!fs.existsSync(file)) return undefined;
    try {
      return parseProjectLifecycleOperation(readJson(file));
    } catch (error) {
      if (error instanceof ProjectWorkspaceError) throw error;
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
  }

  prepare(input: PrepareProjectLifecycleOperationInput): { record: ProjectLifecycleOperationV1; replay: boolean } {
    const requestSha256 = hashProjectLifecycleRequest(input.request);
    return withExclusiveFileLock(this.lock(input.seat_id, input.idempotency_key), () => {
      const existing = this.read(input.seat_id, input.idempotency_key);
      if (existing) {
        if (
          existing.request_sha256 !== requestSha256 ||
          existing.operation !== input.operation ||
          existing.project_id !== input.project_id
        ) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return { record: existing, replay: true };
      }
      const timestamp = this.now().toISOString();
      const { request: _request, ...identity } = input;
      const record: ProjectLifecycleOperationV1 = {
        schema_version: PROJECT_LIFECYCLE_OPERATION_VERSION,
        ...identity,
        request_sha256: requestSha256,
        phase: 'planned',
        created_at: timestamp,
        updated_at: timestamp,
      };
      ensurePrivateDirectory(this.directory(input.seat_id));
      writeJsonAtomic(this.file(input.seat_id, input.idempotency_key), record);
      return { record, replay: false };
    });
  }

  transition(
    seatId: string,
    idempotencyKey: string,
    expectedPhase: ProjectLifecycleOperationPhase,
    nextPhase: ProjectLifecycleOperationPhase,
    receipt?: ProjectLifecycleOperationReceipt
  ): ProjectLifecycleOperationV1 {
    return withExclusiveFileLock(this.lock(seatId, idempotencyKey), () => {
      const current = this.read(seatId, idempotencyKey);
      if (!current || current.phase !== expectedPhase || !TRANSITIONS[expectedPhase].has(nextPhase)) {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }
      if (['committed', 'rejected', 'recovery_required'].includes(nextPhase) !== Boolean(receipt)) {
        throw new ProjectWorkspaceError('workspace.journal-corrupt');
      }
      const next: ProjectLifecycleOperationV1 = {
        ...current,
        phase: nextPhase,
        ...(receipt ? { receipt } : {}),
        updated_at: this.now().toISOString(),
      };
      writeJsonAtomic(this.file(seatId, idempotencyKey), next);
      return next;
    });
  }

  listRecoverable(seatId: string, projectId?: string): ProjectLifecycleOperationV1[] {
    const directory = this.directory(seatId);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => parseProjectLifecycleOperation(readJson(path.join(directory, entry.name))))
      .filter(
        (entry) =>
          (entry.phase === 'mutating' || entry.phase === 'recovery_required') &&
          (projectId === undefined || entry.project_id === projectId)
      )
      .toSorted((left, right) => left.created_at.localeCompare(right.created_at));
  }
}
