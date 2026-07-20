import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertIdentityTuple } from '@/common/types/project-workspace/identity';
import { projectCatalogRecordSchema } from '@/common/types/project-workspace/registry';
import {
  PROJECT_JOURNAL_VERSION,
  PROJECT_UNDO_QUARANTINE_VERSION,
  type ProjectJournalPhase,
  type ProjectTransactionJournalV1,
  type ProjectUndoQuarantinePlanV1,
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
  'undo_quarantine_prepared',
  'undo_quarantining',
  'undo_quarantined',
  'undo_semantic_rolled_back',
  'undo_removal_committed',
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
  'semantic_effect_plan_sha256',
  'semantic_initial_project_id',
  'semantic_initial_workspace_root_ref',
  'semantic_initial_project_binding_revision',
  'semantic_initial_project_binding_receipt_id',
  'semantic_preflight_receipt_id',
  'semantic_context_ref',
  'semantic_context_sha256',
  'proposed_domains_sha256',
  'undo_quarantine_plan',
  'created_files',
  'created_directories',
  'created_at',
  'updated_at',
  'reason_code',
]);
const IDENTITY_KEYS = new Set(['seat_id', 'realm_id', 'root_id', 'project_id', 'workspace_root_ref']);
const FILE_KEYS = new Set(['relative_path', 'sha256']);
const UNDO_PLAN_KEYS = new Set([
  'schema_version',
  'transaction_id',
  'origin',
  'mode',
  'quarantine_basename',
  'receipt_relative_path',
  'catalog_proof',
  'root_identity',
  'quarantine_root_identity',
  'quarantine_directories',
  'files',
  'directories',
]);
const UNDO_FILE_KEYS = new Set(['relative_path', 'sha256', 'dev', 'ino', 'size']);
const UNDO_DIRECTORY_KEYS = new Set(['relative_path', 'dev', 'ino']);
const UNDO_CATALOG_PROOF_KEYS = new Set(['expected_revision', 'expected_record']);
const DIRECTORY_IDENTITY_KEYS = new Set(['dev', 'ino']);
const REASON_CODES = new Set<string>(PROJECT_WORKSPACE_REASON_CODES);
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNDO_PHASES = new Set<ProjectJournalPhase>([
  'undo_quarantine_prepared',
  'undo_quarantining',
  'undo_quarantined',
  'undo_semantic_rolled_back',
  'undo_removal_committed',
]);
const UNDO_PLAN_PHASES = UNDO_PHASES;
const MAX_UNDO_DIRECTORIES = 256;
const PRECOMMIT_UNDO_SOURCES = new Set<ProjectJournalPhase>([
  'planned',
  'leased',
  'preflighted',
  'semantic_staged',
  'staging',
  'staged',
  'promoted',
  'semantic_committed',
]);
const JOURNAL_FORWARD_TRANSITIONS: Readonly<Record<ProjectJournalPhase, ReadonlySet<ProjectJournalPhase>>> = {
  planned: new Set(['leased']),
  leased: new Set(['preflighted']),
  preflighted: new Set(['semantic_staged']),
  semantic_staged: new Set(['staging']),
  staging: new Set(['staged']),
  staged: new Set(['promoted']),
  promoted: new Set(['semantic_committed']),
  semantic_committed: new Set(['cataloged', 'committed']),
  cataloged: new Set(['committed']),
  committed: new Set(['undo_quarantine_prepared']),
  rollback_pending: new Set(),
  undo_quarantine_prepared: new Set(['undo_quarantining']),
  undo_quarantining: new Set(['undo_quarantined']),
  undo_quarantined: new Set(['undo_semantic_rolled_back']),
  undo_semantic_rolled_back: new Set(['undo_removal_committed']),
  undo_removal_committed: new Set(['undone']),
  recovery_required: new Set(),
  undone: new Set(),
};

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

function isIdentityNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDirectoryIdentity(value: unknown): value is { dev: number; ino: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    Object.keys(identity).length === DIRECTORY_IDENTITY_KEYS.size &&
    Object.keys(identity).every((key) => DIRECTORY_IDENTITY_KEYS.has(key)) &&
    isIdentityNumber(identity.dev) &&
    isIdentityNumber(identity.ino)
  );
}

function expectedQuarantineDirectories(files: readonly { relative_path: string }[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let current = path.posix.dirname(file.relative_path);
    while (current !== '.') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].toSorted();
}

function exactSortedPaths(actual: readonly string[], expected: readonly string[]): boolean {
  return new Set(actual).size === actual.length && JSON.stringify(actual) === JSON.stringify([...expected].toSorted());
}

function validUndoCatalogProof(value: unknown, journal: Record<string, unknown>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (
    Object.keys(proof).length !== UNDO_CATALOG_PROOF_KEYS.size ||
    Object.keys(proof).some((key) => !UNDO_CATALOG_PROOF_KEYS.has(key)) ||
    !isIdentityNumber(proof.expected_revision)
  ) {
    return false;
  }
  const parsed = projectCatalogRecordSchema.safeParse(proof.expected_record);
  if (!parsed.success || typeof proof.expected_record !== 'object' || proof.expected_record === null) return false;
  const record = proof.expected_record as Record<string, unknown>;
  const canonical = parsed.data as unknown as Record<string, unknown>;
  const recordKeys = Object.keys(record).toSorted();
  const canonicalKeys = Object.keys(canonical).toSorted();
  if (
    recordKeys.length !== canonicalKeys.length ||
    !recordKeys.every((key, index) => key === canonicalKeys[index]) ||
    canonicalKeys.some((key) => canonical[key] !== record[key]) ||
    record.project_id !== (journal.identity as Record<string, unknown>)?.project_id ||
    record.seat_id !== (journal.identity as Record<string, unknown>)?.seat_id ||
    record.realm_id !== (journal.identity as Record<string, unknown>)?.realm_id ||
    record.root_id !== (journal.identity as Record<string, unknown>)?.root_id ||
    record.workspace_root_ref !== (journal.identity as Record<string, unknown>)?.workspace_root_ref ||
    record.slug !== journal.slug ||
    record.manifest_relative_path !== `${journal.slug as string}/.command-eve/project.json` ||
    record.canonical_project_path !== journal.final_path
  ) {
    return false;
  }
  return true;
}

function validUndoPlan(
  value: unknown,
  journal: Record<string, unknown>,
  phase: ProjectJournalPhase
): value is ProjectUndoQuarantinePlanV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (
    Object.keys(plan).length !== UNDO_PLAN_KEYS.size ||
    Object.keys(plan).some((key) => !UNDO_PLAN_KEYS.has(key)) ||
    plan.schema_version !== PROJECT_UNDO_QUARANTINE_VERSION ||
    plan.transaction_id !== journal.transaction_id ||
    typeof plan.transaction_id !== 'string' ||
    !TRANSACTION_ID_PATTERN.test(plan.transaction_id) ||
    (plan.origin !== 'provisioning-rollback' && plan.origin !== 'committed-undo') ||
    !(journal.operation === 'create'
      ? plan.mode === 'create-tree' || plan.mode === 'create-missing-root'
      : plan.mode === 'adopt-additions' || plan.mode === 'adopt-no-additions') ||
    plan.quarantine_basename !== `.command-eve-undo-${plan.transaction_id}` ||
    (plan.origin === 'provisioning-rollback' && (plan.receipt_relative_path !== null || plan.catalog_proof !== null)) ||
    (plan.origin === 'committed-undo' &&
      (plan.receipt_relative_path !== `.command-eve/receipts/${plan.transaction_id}.json` ||
        !validUndoCatalogProof(plan.catalog_proof, journal))) ||
    !(plan.root_identity === null || isDirectoryIdentity(plan.root_identity)) ||
    !(plan.quarantine_root_identity === null || isDirectoryIdentity(plan.quarantine_root_identity)) ||
    !Array.isArray(plan.files) ||
    plan.files.length > 129 ||
    !Array.isArray(plan.directories) ||
    plan.directories.length > MAX_UNDO_DIRECTORIES ||
    !Array.isArray(plan.quarantine_directories) ||
    plan.quarantine_directories.length > MAX_UNDO_DIRECTORIES
  ) {
    return false;
  }
  for (const file of plan.files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      Array.isArray(file) ||
      Object.keys(file).length !== UNDO_FILE_KEYS.size ||
      Object.keys(file).some((key) => !UNDO_FILE_KEYS.has(key)) ||
      !isSafeRelativePath((file as Record<string, unknown>).relative_path) ||
      !/^[0-9a-f]{64}$/.test(String((file as Record<string, unknown>).sha256)) ||
      !isIdentityNumber((file as Record<string, unknown>).dev) ||
      !isIdentityNumber((file as Record<string, unknown>).ino) ||
      !isIdentityNumber((file as Record<string, unknown>).size)
    ) {
      return false;
    }
  }
  for (const entries of [plan.directories, plan.quarantine_directories]) {
    for (const directory of entries) {
      if (
        typeof directory !== 'object' ||
        directory === null ||
        Array.isArray(directory) ||
        Object.keys(directory).length !== UNDO_DIRECTORY_KEYS.size ||
        Object.keys(directory).some((key) => !UNDO_DIRECTORY_KEYS.has(key)) ||
        !isSafeRelativePath((directory as Record<string, unknown>).relative_path) ||
        !isIdentityNumber((directory as Record<string, unknown>).dev) ||
        !isIdentityNumber((directory as Record<string, unknown>).ino)
      ) {
        return false;
      }
    }
  }
  const files = plan.files as Array<{ relative_path: string; sha256: string }>;
  const directories = plan.directories as Array<{ relative_path: string }>;
  const quarantineDirectories = plan.quarantine_directories as Array<{ relative_path: string }>;
  const createdFiles = journal.created_files as Array<{ relative_path: string; sha256: string }>;
  const createdDirectories = journal.created_directories as string[];
  const expectedFiles = [
    ...createdFiles.map((entry) => entry.relative_path),
    ...(plan.receipt_relative_path === null ? [] : [plan.receipt_relative_path as string]),
  ];
  if (
    !exactSortedPaths(
      files.map((entry) => entry.relative_path),
      expectedFiles
    ) ||
    !exactSortedPaths(
      directories.map((entry) => entry.relative_path),
      createdDirectories
    ) ||
    createdFiles.some(
      (created) => files.find((entry) => entry.relative_path === created.relative_path)?.sha256 !== created.sha256
    )
  ) {
    return false;
  }
  if (plan.mode === 'create-missing-root' || plan.mode === 'adopt-no-additions') {
    return (
      plan.origin === 'provisioning-rollback' &&
      plan.receipt_relative_path === null &&
      plan.catalog_proof === null &&
      (plan.mode === 'create-missing-root' ? plan.root_identity === null : plan.root_identity !== null) &&
      plan.quarantine_root_identity === null &&
      quarantineDirectories.length === 0 &&
      files.length === 0 &&
      directories.length === 0 &&
      createdFiles.length === 0 &&
      createdDirectories.length === 0
    );
  }
  if (plan.root_identity === null) return false;
  if (plan.quarantine_root_identity === null) {
    return phase === 'undo_quarantine_prepared' && quarantineDirectories.length === 0;
  }
  return exactSortedPaths(
    quarantineDirectories.map((entry) => entry.relative_path),
    expectedQuarantineDirectories(files)
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
  const undoPlanOrigin =
    typeof journal.undo_quarantine_plan === 'object' &&
    journal.undo_quarantine_plan !== null &&
    !Array.isArray(journal.undo_quarantine_plan)
      ? (journal.undo_quarantine_plan as Record<string, unknown>).origin
      : undefined;
  const requiresSemanticBinding =
    (typeof journal.phase === 'string' &&
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
      ].includes(journal.phase)) ||
    undoPlanOrigin === 'committed-undo';
  const hasAnySemanticBinding =
    journal.semantic_base_bundle_sha256 !== undefined ||
    journal.semantic_bundle_sha256 !== undefined ||
    journal.semantic_effect_plan_sha256 !== undefined ||
    Object.hasOwn(journal, 'semantic_initial_project_id') ||
    Object.hasOwn(journal, 'semantic_initial_workspace_root_ref') ||
    journal.semantic_initial_project_binding_revision !== undefined ||
    Object.hasOwn(journal, 'semantic_initial_project_binding_receipt_id') ||
    journal.semantic_preflight_receipt_id !== undefined ||
    journal.semantic_context_ref !== undefined ||
    journal.semantic_context_sha256 !== undefined ||
    journal.proposed_domains_sha256 !== undefined;
  if (
    Object.keys(journal).some((key) => !JOURNAL_KEYS.has(key)) ||
    journal.schema_version !== PROJECT_JOURNAL_VERSION ||
    typeof journal.transaction_id !== 'string' ||
    !TRANSACTION_ID_PATTERN.test(journal.transaction_id) ||
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
        typeof journal.semantic_effect_plan_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(journal.semantic_effect_plan_sha256) ||
        !Object.hasOwn(journal, 'semantic_initial_project_id') ||
        !Object.hasOwn(journal, 'semantic_initial_workspace_root_ref') ||
        typeof journal.semantic_initial_project_binding_revision !== 'number' ||
        !Number.isSafeInteger(journal.semantic_initial_project_binding_revision) ||
        journal.semantic_initial_project_binding_revision < 0 ||
        !Object.hasOwn(journal, 'semantic_initial_project_binding_receipt_id') ||
        !(
          journal.semantic_initial_project_binding_receipt_id === null ||
          (typeof journal.semantic_initial_project_binding_receipt_id === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              journal.semantic_initial_project_binding_receipt_id
            ))
        ) ||
        !(
          (journal.semantic_initial_project_id === null && journal.semantic_initial_workspace_root_ref === null) ||
          (typeof journal.semantic_initial_project_id === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              journal.semantic_initial_project_id
            ) &&
            typeof journal.semantic_initial_workspace_root_ref === 'string' &&
            /^root:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              journal.semantic_initial_workspace_root_ref
            ))
        ) ||
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
  const phase = journal.phase as ProjectJournalPhase;
  if (
    (UNDO_PHASES.has(phase) && !validUndoPlan(journal.undo_quarantine_plan, journal, phase)) ||
    (journal.undo_quarantine_plan !== undefined &&
      (!UNDO_PLAN_PHASES.has(phase) || !validUndoPlan(journal.undo_quarantine_plan, journal, phase)))
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

export function isProjectJournalTransitionAllowed(from: ProjectJournalPhase, to: ProjectJournalPhase): boolean {
  if (from === to) return true;
  if (to === 'recovery_required') return from !== 'undone' && !UNDO_PHASES.has(from);
  if (to === 'undo_quarantine_prepared' && PRECOMMIT_UNDO_SOURCES.has(from)) return true;
  return JOURNAL_FORWARD_TRANSITIONS[from].has(to);
}

function immutableUndoPlan(
  plan: ProjectUndoQuarantinePlanV1
): Omit<ProjectUndoQuarantinePlanV1, 'quarantine_root_identity' | 'quarantine_directories'> {
  const { quarantine_root_identity: _rootIdentity, quarantine_directories: _directories, ...immutable } = plan;
  return immutable;
}

function undoPlanUpdateAllowed(
  journal: ProjectTransactionJournalV1,
  nextPlan: ProjectUndoQuarantinePlanV1 | undefined,
  nextPhase: ProjectJournalPhase
): boolean {
  const currentPlan = journal.undo_quarantine_plan;
  if (!currentPlan) return nextPlan === undefined || nextPhase === 'undo_quarantine_prepared';
  if (nextPhase === 'undone') return nextPlan === undefined;
  if (!nextPlan || !isDeepStrictEqual(immutableUndoPlan(currentPlan), immutableUndoPlan(nextPlan))) return false;
  if (currentPlan.quarantine_root_identity) {
    return (
      isDeepStrictEqual(currentPlan.quarantine_root_identity, nextPlan.quarantine_root_identity) &&
      isDeepStrictEqual(currentPlan.quarantine_directories, nextPlan.quarantine_directories)
    );
  }
  if (!nextPlan.quarantine_root_identity) {
    return currentPlan.quarantine_directories.length === 0 && nextPlan.quarantine_directories.length === 0;
  }
  return (
    journal.phase === 'undo_quarantine_prepared' &&
    (nextPhase === 'undo_quarantine_prepared' || nextPhase === 'undo_quarantining')
  );
}

export function advanceProjectJournal(
  stateRoot: string,
  journal: ProjectTransactionJournalV1,
  phase: ProjectJournalPhase,
  updatedAt: string,
  changes: Partial<ProjectTransactionJournalV1> = {}
): ProjectTransactionJournalV1 {
  if (!isProjectJournalTransitionAllowed(journal.phase, phase)) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt', `${journal.phase} -> ${phase}`);
  }
  const merged = { ...journal, ...changes, phase, updated_at: updatedAt };
  if (!undoPlanUpdateAllowed(journal, merged.undo_quarantine_plan, phase)) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt', 'undo plan mutation');
  }
  if (phase === 'undone' && merged.undo_quarantine_plan !== undefined) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt', 'terminal undo plan retained');
  }
  const next = (() => {
    if (phase !== 'undone') return merged;
    const { undo_quarantine_plan: _removed, ...terminal } = merged;
    return terminal;
  })() as ProjectTransactionJournalV1;
  const plan = next.undo_quarantine_plan;
  if (
    phase === 'undo_quarantine_prepared' &&
    journal.phase !== 'undo_quarantine_prepared' &&
    ((journal.phase === 'committed' && plan?.origin !== 'committed-undo') ||
      (journal.phase !== 'committed' && plan?.origin !== 'provisioning-rollback'))
  ) {
    throw new ProjectWorkspaceError('workspace.journal-corrupt', 'undo origin mismatch');
  }
  writeProjectJournal(stateRoot, next);
  return next;
}
