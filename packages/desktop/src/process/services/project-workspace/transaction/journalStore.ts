import fs from 'node:fs';
import path from 'node:path';
import { assertIdentityTuple } from '@/common/types/project-workspace/identity';
import {
  PROJECT_JOURNAL_VERSION,
  type ProjectJournalPhase,
  type ProjectTransactionJournalV1,
} from '@/common/types/project-workspace/transaction';
import { PROJECT_WORKSPACE_REASON_CODES, ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import { ensurePrivateDirectory, readJson, writeJsonAtomic } from '../storage/atomicJson';

const JOURNAL_PHASES: ReadonlySet<ProjectJournalPhase> = new Set([
  'planned',
  'leased',
  'preflighted',
  'semantic_staged',
  'staging',
  'staged',
  'promoted',
  'semantic_committed',
  'cataloged',
  'committed',
  'rollback_pending',
  'recovery_required',
  'undone',
]);
const JOURNAL_KEYS = new Set([
  'schema_version',
  'transaction_id',
  'conversation_id',
  'operation',
  'phase',
  'identity',
  'slug',
  'staging_path',
  'final_path',
  'lease_path',
  'owner_token_sha256',
  'semantic_base_bundle_sha256',
  'semantic_bundle_sha256',
  'semantic_preflight_receipt_id',
  'semantic_context_ref',
  'semantic_context_sha256',
  'proposed_domains_sha256',
  'created_files',
  'created_directories',
  'created_at',
  'updated_at',
  'reason_code',
]);
const IDENTITY_KEYS = new Set(['seat_id', 'realm_id', 'root_id', 'project_id', 'workspace_root_ref']);
const FILE_KEYS = new Set(['relative_path', 'sha256']);
const REASON_CODES = new Set<string>(PROJECT_WORKSPACE_REASON_CODES);

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function projectJournalDirectory(stateRoot: string): string {
  return path.join(stateRoot, 'transactions');
}

export function projectJournalPath(stateRoot: string, transactionId: string): string {
  return path.join(projectJournalDirectory(stateRoot), `${transactionId}.journal.json`);
}

export function validateProjectJournal(value: unknown): ProjectTransactionJournalV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  const journal = value as Record<string, unknown>;
  const identity = journal.identity;
  const requiresSemanticBinding =
    typeof journal.phase === 'string' &&
    [
      'preflighted',
      'semantic_staged',
      'staging',
      'staged',
      'promoted',
      'semantic_committed',
      'cataloged',
      'committed',
      'rollback_pending',
    ].includes(journal.phase);
  const hasAnySemanticBinding =
    journal.semantic_base_bundle_sha256 !== undefined ||
    journal.semantic_bundle_sha256 !== undefined ||
    journal.semantic_preflight_receipt_id !== undefined ||
    journal.semantic_context_ref !== undefined ||
    journal.semantic_context_sha256 !== undefined ||
    journal.proposed_domains_sha256 !== undefined;
  if (
    Object.keys(journal).some((key) => !JOURNAL_KEYS.has(key)) ||
    journal.schema_version !== PROJECT_JOURNAL_VERSION ||
    typeof journal.transaction_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.transaction_id) ||
    typeof journal.conversation_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(journal.conversation_id) ||
    (journal.operation !== 'create' && journal.operation !== 'adopt') ||
    typeof journal.phase !== 'string' ||
    !JOURNAL_PHASES.has(journal.phase as ProjectJournalPhase) ||
    typeof journal.slug !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(journal.slug) ||
    typeof journal.staging_path !== 'string' ||
    !path.isAbsolute(journal.staging_path) ||
    typeof journal.final_path !== 'string' ||
    !path.isAbsolute(journal.final_path) ||
    typeof journal.lease_path !== 'string' ||
    !path.isAbsolute(journal.lease_path) ||
    typeof journal.owner_token_sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(journal.owner_token_sha256) ||
    ((requiresSemanticBinding || hasAnySemanticBinding) &&
      (typeof journal.semantic_base_bundle_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(journal.semantic_base_bundle_sha256) ||
        typeof journal.semantic_bundle_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(journal.semantic_bundle_sha256) ||
        typeof journal.semantic_preflight_receipt_id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(journal.semantic_preflight_receipt_id) ||
        typeof journal.semantic_context_ref !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(journal.semantic_context_ref) ||
        typeof journal.semantic_context_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(journal.semantic_context_sha256) ||
        typeof journal.proposed_domains_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(journal.proposed_domains_sha256))) ||
    !Array.isArray(journal.created_files) ||
    journal.created_files.length > 128 ||
    !Array.isArray(journal.created_directories) ||
    journal.created_directories.length > 64 ||
    !isTimestamp(journal.created_at) ||
    !isTimestamp(journal.updated_at) ||
    Date.parse(journal.updated_at as string) < Date.parse(journal.created_at as string) ||
    (journal.reason_code !== undefined &&
      (typeof journal.reason_code !== 'string' || !REASON_CODES.has(journal.reason_code))) ||
    typeof identity !== 'object' ||
    identity === null ||
    Array.isArray(identity) ||
    Object.keys(identity).some((key) => !IDENTITY_KEYS.has(key)) ||
    Object.keys(identity).length !== IDENTITY_KEYS.size
  ) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  try {
    assertIdentityTuple(identity as ProjectTransactionJournalV1['identity']);
  } catch {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  for (const file of journal.created_files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      Array.isArray(file) ||
      Object.keys(file).some((key) => !FILE_KEYS.has(key)) ||
      Object.keys(file).length !== FILE_KEYS.size ||
      !isSafeRelativePath((file as Record<string, unknown>).relative_path) ||
      !/^[0-9a-f]{64}$/.test(String((file as Record<string, unknown>).sha256))
    ) {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
  }
  if (
    journal.created_directories.some((entry) => !isSafeRelativePath(entry)) ||
    new Set(journal.created_directories).size !== journal.created_directories.length ||
    new Set(journal.created_files.map((entry) => (entry as { relative_path: string }).relative_path)).size !==
      journal.created_files.length
  ) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt');
  }
  return journal as ProjectTransactionJournalV1;
}

export function writeProjectJournal(stateRoot: string, journal: ProjectTransactionJournalV1): string {
  const validated = validateProjectJournal(journal);
  const file = projectJournalPath(stateRoot, validated.transaction_id);
  ensurePrivateDirectory(path.dirname(file));
  writeJsonAtomic(file, validated);
  return file;
}

export function readProjectJournal(file: string): ProjectTransactionJournalV1 {
  try {
    return validateProjectJournal(readJson(file));
  } catch (error) {
    if (error instanceof ProjectWorkspaceError) throw error;
    throw new ProjectWorkspaceError('workspace.journal-corrupt', file);
  }
}

export function listProjectJournals(stateRoot: string): Array<{ file: string; journal: ProjectTransactionJournalV1 }> {
  const directory = projectJournalDirectory(stateRoot);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.journal.json'))
    .toSorted()
    .map((name) => {
      const file = path.join(directory, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        throw new ProjectWorkspaceError('workspace.journal-corrupt', file);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ProjectWorkspaceError('workspace.journal-corrupt', file);
      }
      const journal = readProjectJournal(file);
      if (name !== `${journal.transaction_id}.journal.json`) {
        throw new ProjectWorkspaceError('workspace.journal-corrupt', file);
      }
      return { file, journal };
    });
}

export function advanceProjectJournal(
  stateRoot: string,
  journal: ProjectTransactionJournalV1,
  phase: ProjectJournalPhase,
  updatedAt: string,
  changes: Partial<ProjectTransactionJournalV1> = {}
): ProjectTransactionJournalV1 {
  const next = { ...journal, ...changes, phase, updated_at: updatedAt };
  writeProjectJournal(stateRoot, next);
  return next;
}
