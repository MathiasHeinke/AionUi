import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectCatalogRecordSchema } from '@/common/types/project-workspace/registry';
import {
  PROJECT_UNDO_QUARANTINE_VERSION,
  type ProjectUndoCatalogProofV1,
  type ProjectUndoQuarantineDirectoryV1,
  type ProjectUndoQuarantineFileV1,
  type ProjectUndoQuarantinePlanV1,
  type ProjectUndoOriginV1,
} from '@/common/types/project-workspace/transaction';
import { syncDirectoryDurable } from '../storage/atomicJson';

export type FileIdentity = { dev: number; ino: number; size: number; sha256: string };
export type DirectoryIdentity = { dev: number; ino: number };
export type RemovalIdentityPlan = {
  root: string;
  file_identities: Map<string, FileIdentity | undefined>;
  directory_identities: Map<string, DirectoryIdentity | undefined>;
  root_identity: DirectoryIdentity | undefined;
};

type OpenFileIdentity = { descriptor: number; identity: FileIdentity };

export type ProjectUndoQuarantineState = 'source' | 'partial' | 'quarantined' | 'purged' | 'conflict';

export type BuildProjectUndoQuarantinePlanInput = {
  transaction_id: string;
  origin: ProjectUndoOriginV1;
  operation: 'create' | 'adopt';
  root: string;
  created_files: Array<{ relative_path: string; sha256: string }>;
  created_directories: string[];
  receipt_relative_path?: string;
  catalog_proof: ProjectUndoCatalogProofV1 | null;
};

type BeforeMutation = (targetPath: string) => void;

const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_UNDO_DIRECTORIES = 256;

export function projectUndoQuarantineBasename(transactionId: string): string {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) throw new Error('invalid project transaction id');
  return `.command-eve-undo-${transactionId}`;
}

function validIdentityNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validDirectoryIdentity(identity: unknown): identity is DirectoryIdentity {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  const candidate = identity as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 2 &&
    Object.hasOwn(candidate, 'dev') &&
    Object.hasOwn(candidate, 'ino') &&
    validIdentityNumber(candidate.dev) &&
    validIdentityNumber(candidate.ino)
  );
}

function validFilePlanEntry(entry: unknown): entry is ProjectUndoQuarantineFileV1 {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 5 &&
    Object.hasOwn(candidate, 'relative_path') &&
    Object.hasOwn(candidate, 'sha256') &&
    Object.hasOwn(candidate, 'dev') &&
    Object.hasOwn(candidate, 'ino') &&
    Object.hasOwn(candidate, 'size') &&
    typeof candidate.relative_path === 'string' &&
    containedPath('/project-root', candidate.relative_path) !== undefined &&
    typeof candidate.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.sha256) &&
    validIdentityNumber(candidate.dev) &&
    validIdentityNumber(candidate.ino) &&
    validIdentityNumber(candidate.size)
  );
}

function validDirectoryPlanEntry(entry: unknown): entry is ProjectUndoQuarantineDirectoryV1 {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    Object.hasOwn(candidate, 'relative_path') &&
    Object.hasOwn(candidate, 'dev') &&
    Object.hasOwn(candidate, 'ino') &&
    typeof candidate.relative_path === 'string' &&
    containedPath('/project-root', candidate.relative_path) !== undefined &&
    validIdentityNumber(candidate.dev) &&
    validIdentityNumber(candidate.ino)
  );
}

function validCatalogProof(value: unknown, root?: string): value is ProjectUndoCatalogProofV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (
    Object.keys(proof).length !== 2 ||
    !Object.hasOwn(proof, 'expected_revision') ||
    !Object.hasOwn(proof, 'expected_record') ||
    !validIdentityNumber(proof.expected_revision)
  ) {
    return false;
  }
  const parsed = projectCatalogRecordSchema.safeParse(proof.expected_record);
  if (!parsed.success || typeof proof.expected_record !== 'object' || proof.expected_record === null) return false;
  const raw = proof.expected_record as Record<string, unknown>;
  const canonical = parsed.data as unknown as Record<string, unknown>;
  const rawKeys = Object.keys(raw).toSorted();
  const canonicalKeys = Object.keys(canonical).toSorted();
  return (
    rawKeys.length === canonicalKeys.length &&
    rawKeys.every((key, index) => key === canonicalKeys[index]) &&
    canonicalKeys.every((key) => canonical[key] === raw[key]) &&
    (root === undefined || parsed.data.canonical_project_path === root)
  );
}

function sortedUniqueRelativePaths(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0)
  );
}

function structurallyValidUndoPlan(plan: ProjectUndoQuarantinePlanV1): boolean {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  const candidate = plan as unknown as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 12 ||
    ![
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
    ].every((key) => Object.hasOwn(candidate, key)) ||
    plan.schema_version !== PROJECT_UNDO_QUARANTINE_VERSION ||
    !TRANSACTION_ID_PATTERN.test(plan.transaction_id) ||
    (plan.origin !== 'provisioning-rollback' && plan.origin !== 'committed-undo') ||
    !['create-tree', 'create-missing-root', 'adopt-additions', 'adopt-no-additions'].includes(plan.mode) ||
    plan.quarantine_basename !== projectUndoQuarantineBasename(plan.transaction_id) ||
    !(plan.receipt_relative_path === null || typeof plan.receipt_relative_path === 'string') ||
    !(plan.root_identity === null || validDirectoryIdentity(plan.root_identity)) ||
    !(plan.quarantine_root_identity === null || validDirectoryIdentity(plan.quarantine_root_identity)) ||
    !Array.isArray(plan.files) ||
    plan.files.length > 129 ||
    !plan.files.every(validFilePlanEntry) ||
    !sortedUniqueRelativePaths(plan.files.map((entry) => entry.relative_path)) ||
    !Array.isArray(plan.directories) ||
    plan.directories.length > MAX_UNDO_DIRECTORIES ||
    !plan.directories.every(validDirectoryPlanEntry) ||
    !sortedUniqueRelativePaths(plan.directories.map((entry) => entry.relative_path)) ||
    !Array.isArray(plan.quarantine_directories) ||
    plan.quarantine_directories.length > MAX_UNDO_DIRECTORIES ||
    !plan.quarantine_directories.every(validDirectoryPlanEntry) ||
    !sortedUniqueRelativePaths(plan.quarantine_directories.map((entry) => entry.relative_path))
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
      plan.quarantine_directories.length === 0 &&
      plan.files.length === 0 &&
      plan.directories.length === 0
    );
  }
  if (plan.root_identity === null) return false;
  if (
    (plan.origin === 'provisioning-rollback' && (plan.receipt_relative_path !== null || plan.catalog_proof !== null)) ||
    (plan.origin === 'committed-undo' &&
      (plan.receipt_relative_path !== `.command-eve/receipts/${plan.transaction_id}.json` ||
        !validCatalogProof(plan.catalog_proof)))
  ) {
    return false;
  }
  if (plan.quarantine_root_identity === null) return plan.quarantine_directories.length === 0;
  const expectedDirectories = expectedQuarantineDirectories(plan.files).toSorted();
  return (
    JSON.stringify(plan.quarantine_directories.map((entry) => entry.relative_path).toSorted()) ===
    JSON.stringify(expectedDirectories)
  );
}

function undoQuarantinePath(root: string, plan: ProjectUndoQuarantinePlanV1): string | undefined {
  if (!structurallyValidUndoPlan(plan)) return undefined;
  const resolvedRoot = path.resolve(root);
  if (plan.origin === 'committed-undo' && !validCatalogProof(plan.catalog_proof, resolvedRoot)) return undefined;
  const parent = path.dirname(resolvedRoot);
  const quarantine = path.join(parent, plan.quarantine_basename);
  return path.dirname(quarantine) === parent && quarantine !== resolvedRoot ? quarantine : undefined;
}

function logicalEmptyUndoPlanHolds(root: string, quarantine: string, plan: ProjectUndoQuarantinePlanV1): boolean {
  if (pathEntryKind(quarantine) !== 'missing') return false;
  if (plan.mode === 'create-missing-root') return pathEntryKind(root) === 'missing';
  if (plan.mode !== 'adopt-no-additions' || !plan.root_identity) return false;
  const observed = captureDirectoryIdentity(root);
  return observed !== undefined && stableDirectoryIdentity(plan.root_identity, observed);
}

function stableFileIdentity(expected: ProjectUndoQuarantineFileV1, observed: FileIdentity): boolean {
  return expected.dev === observed.dev && expected.ino === observed.ino;
}

function exactFileIdentity(expected: ProjectUndoQuarantineFileV1, observed: FileIdentity): boolean {
  return (
    stableFileIdentity(expected, observed) && expected.size === observed.size && expected.sha256 === observed.sha256
  );
}

function stableDirectoryIdentity(expected: DirectoryIdentity, observed: DirectoryIdentity): boolean {
  return expected.dev === observed.dev && expected.ino === observed.ino;
}

function expectedQuarantineDirectories(files: readonly ProjectUndoQuarantineFileV1[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let current = path.posix.dirname(file.relative_path);
    while (current !== '.') {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].toSorted(
    (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right)
  );
}

function listDirectories(root: string, current = root): string[] {
  const kind = pathEntryKind(current);
  if (kind === 'missing') return [];
  if (kind !== 'directory') return ['\0invalid-directory-entry'];
  const out: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    out.push(path.relative(root, absolute).split(path.sep).join('/'));
    out.push(...listDirectories(root, absolute));
  }
  return out.toSorted();
}

function exactDirectorySet(root: string, expected: readonly string[]): boolean {
  return JSON.stringify(listDirectories(root)) === JSON.stringify([...expected].toSorted());
}

function unsafeAdoptionExtra(
  root: string,
  files: readonly ProjectUndoQuarantineFileV1[],
  directories: readonly ProjectUndoQuarantineDirectoryV1[]
): boolean {
  const owned = new Set(files.map((entry) => entry.relative_path));
  const prefixes = directories.map((entry) => `${entry.relative_path.replace(/\/$/, '')}/`);
  return listFiles(root).some(
    (relative) => !owned.has(relative) && prefixes.some((prefix) => relative.startsWith(prefix))
  );
}

function createdDirectoryTreeIsSafe(
  root: string,
  directories: readonly ProjectUndoQuarantineDirectoryV1[],
  allowedFiles: readonly ProjectUndoQuarantineFileV1[] = []
): boolean {
  const ownedDirectories = new Set(directories.map((entry) => entry.relative_path));
  const ownedFiles = new Set(allowedFiles.map((entry) => entry.relative_path));
  for (const entry of directories) {
    const directory = containedPath(root, entry.relative_path);
    if (directory && pathEntryKind(directory) === 'missing') continue;
    const observed = directory ? captureDirectoryIdentity(directory) : undefined;
    if (
      !directory ||
      !observed ||
      !stableDirectoryIdentity(entry, observed) ||
      !hasOnlyRealDirectoryParents(root, directory)
    ) {
      return false;
    }
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = path.relative(root, path.join(directory, child.name)).split(path.sep).join('/');
      if (child.isDirectory() && !child.isSymbolicLink()) {
        if (!ownedDirectories.has(childRelative)) return false;
      } else if (!child.isFile() || child.isSymbolicLink() || !ownedFiles.has(childRelative)) {
        return false;
      }
    }
  }
  return true;
}

function createdProjectTreeIsSafe(root: string, directories: readonly ProjectUndoQuarantineDirectoryV1[]): boolean {
  const expectedDirectories = new Set(directories.map((entry) => entry.relative_path));
  return (
    listFiles(root).length === 0 &&
    listDirectories(root).every((relative) => expectedDirectories.has(relative)) &&
    createdDirectoryTreeIsSafe(root, directories)
  );
}

/** Captures only journal-owned additions plus the transaction receipt. It never infers files from the tree. */
export function buildProjectUndoQuarantinePlan(
  input: BuildProjectUndoQuarantinePlanInput
): ProjectUndoQuarantinePlanV1 | undefined {
  if (!TRANSACTION_ID_PATTERN.test(input.transaction_id)) return undefined;
  const root = path.resolve(input.root);
  const expectedReceipt = `.command-eve/receipts/${input.transaction_id}.json`;
  if (
    (input.receipt_relative_path !== undefined && input.receipt_relative_path !== expectedReceipt) ||
    (input.origin === 'provisioning-rollback' &&
      (input.receipt_relative_path !== undefined || input.catalog_proof !== null)) ||
    (input.origin === 'committed-undo' &&
      (input.receipt_relative_path !== expectedReceipt || !validCatalogProof(input.catalog_proof, root)))
  ) {
    return undefined;
  }
  const quarantineBasename = projectUndoQuarantineBasename(input.transaction_id);
  if (pathEntryKind(path.join(path.dirname(root), quarantineBasename)) !== 'missing') return undefined;
  const rootKind = pathEntryKind(root);
  if (input.operation === 'create' && rootKind === 'missing') {
    if (
      input.origin !== 'provisioning-rollback' ||
      input.created_files.length !== 0 ||
      input.created_directories.length !== 0
    ) {
      return undefined;
    }
    return {
      schema_version: PROJECT_UNDO_QUARANTINE_VERSION,
      transaction_id: input.transaction_id,
      origin: input.origin,
      mode: 'create-missing-root',
      quarantine_basename: quarantineBasename,
      receipt_relative_path: null,
      catalog_proof: null,
      root_identity: null,
      quarantine_root_identity: null,
      quarantine_directories: [],
      files: [],
      directories: [],
    };
  }
  if (rootKind !== 'directory') return undefined;
  const rootIdentity = captureDirectoryIdentity(root);
  if (!rootIdentity) return undefined;
  if (
    input.operation === 'adopt' &&
    input.origin === 'provisioning-rollback' &&
    input.created_files.length === 0 &&
    input.created_directories.length === 0
  ) {
    return {
      schema_version: PROJECT_UNDO_QUARANTINE_VERSION,
      transaction_id: input.transaction_id,
      origin: input.origin,
      mode: 'adopt-no-additions',
      quarantine_basename: quarantineBasename,
      receipt_relative_path: null,
      catalog_proof: null,
      root_identity: rootIdentity,
      quarantine_root_identity: null,
      quarantine_directories: [],
      files: [],
      directories: [],
    };
  }
  if (input.created_files.length > 128) return undefined;
  const byPath = new Map<string, { relative_path: string; sha256?: string }>();
  for (const entry of input.created_files) {
    if (
      containedPath(root, entry.relative_path) === undefined ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      byPath.has(entry.relative_path)
    ) {
      return undefined;
    }
    byPath.set(entry.relative_path, entry);
  }
  if (input.receipt_relative_path !== undefined) {
    if (byPath.has(input.receipt_relative_path)) return undefined;
    byPath.set(input.receipt_relative_path, { relative_path: input.receipt_relative_path });
  }
  const files: ProjectUndoQuarantineFileV1[] = [];
  for (const entry of [...byPath.values()].toSorted((left, right) =>
    left.relative_path.localeCompare(right.relative_path)
  )) {
    const file = containedPath(root, entry.relative_path);
    if (!file) return undefined;
    const identity = captureFileIdentity(file);
    if (!identity || (entry.sha256 !== undefined && identity.sha256 !== entry.sha256)) return undefined;
    files.push({ relative_path: entry.relative_path, ...identity });
  }
  if (
    input.created_directories.length > MAX_UNDO_DIRECTORIES ||
    new Set(input.created_directories).size !== input.created_directories.length ||
    input.created_directories.some((relative) => containedPath(root, relative) === undefined)
  ) {
    return undefined;
  }
  const directories: ProjectUndoQuarantineDirectoryV1[] = [];
  for (const relative of [...input.created_directories].toSorted()) {
    const directory = containedPath(root, relative);
    const identity = directory ? captureDirectoryIdentity(directory) : undefined;
    if (!identity) return undefined;
    directories.push({ relative_path: relative, ...identity });
  }
  if (input.operation === 'create') {
    if (!hasOnlyExpectedFiles(root, files) || !exactDirectorySet(root, input.created_directories)) return undefined;
  } else if (unsafeAdoptionExtra(root, files, directories) || !createdDirectoryTreeIsSafe(root, directories, files)) {
    return undefined;
  }
  if (expectedQuarantineDirectories(files).length > MAX_UNDO_DIRECTORIES) return undefined;
  return {
    schema_version: PROJECT_UNDO_QUARANTINE_VERSION,
    transaction_id: input.transaction_id,
    origin: input.origin,
    mode: input.operation === 'create' ? 'create-tree' : 'adopt-additions',
    quarantine_basename: quarantineBasename,
    receipt_relative_path: input.receipt_relative_path ?? null,
    catalog_proof: input.catalog_proof,
    root_identity: rootIdentity,
    quarantine_root_identity: null,
    quarantine_directories: [],
    files,
    directories,
  };
}

function createDirectory(directory: string, beforeMutation: BeforeMutation): void {
  beforeMutation(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  syncDirectoryDurable(path.dirname(directory));
}

function verifyPreparedQuarantine(
  plan: ProjectUndoQuarantinePlanV1,
  quarantine: string,
  allowMissingDirectories = false
): boolean {
  if (!plan.quarantine_root_identity) return false;
  const rootIdentity = captureDirectoryIdentity(quarantine);
  if (!rootIdentity || !stableDirectoryIdentity(plan.quarantine_root_identity, rootIdentity)) return false;
  const observedDirectories = listDirectories(quarantine);
  const expectedDirectories = new Set(plan.quarantine_directories.map((entry) => entry.relative_path));
  if (observedDirectories.some((relative) => !expectedDirectories.has(relative))) return false;
  for (const entry of plan.quarantine_directories) {
    const directory = containedPath(quarantine, entry.relative_path);
    if (directory && pathEntryKind(directory) === 'missing' && allowMissingDirectories) continue;
    const observed = directory ? captureDirectoryIdentity(directory) : undefined;
    if (!observed || !stableDirectoryIdentity(entry, observed)) return false;
  }
  return allowMissingDirectories || observedDirectories.length === plan.quarantine_directories.length;
}

/** Creates and identity-binds the empty adoption quarantine before any owned file can move. */
export function prepareProjectUndoQuarantine(
  root: string,
  plan: ProjectUndoQuarantinePlanV1,
  beforeMutation: BeforeMutation = () => undefined
): ProjectUndoQuarantinePlanV1 | undefined {
  const quarantine = undoQuarantinePath(root, plan);
  if (!quarantine) return undefined;
  if (plan.mode === 'create-missing-root' || plan.mode === 'adopt-no-additions') {
    return logicalEmptyUndoPlanHolds(path.resolve(root), quarantine, plan) ? plan : undefined;
  }
  if (plan.quarantine_root_identity) return verifyPreparedQuarantine(plan, quarantine) ? plan : undefined;
  // A crash after mkdir but before the returned inode is journaled is intentionally non-adoptable.
  // Recovery must hold for manual inspection rather than bind an arbitrary pre-existing empty directory.
  if (pathEntryKind(quarantine) !== 'missing') return undefined;
  createDirectory(quarantine, beforeMutation);
  const rootIdentity = captureDirectoryIdentity(quarantine);
  if (!rootIdentity || listFiles(quarantine).length !== 0) return undefined;
  const expectedDirectories = expectedQuarantineDirectories(plan.files);
  if (listDirectories(quarantine).some((relative) => !expectedDirectories.includes(relative))) return undefined;
  for (const relative of expectedDirectories) {
    const directory = containedPath(quarantine, relative);
    if (!directory) return undefined;
    const kind = pathEntryKind(directory);
    if (kind === 'missing') createDirectory(directory, beforeMutation);
    else if (kind !== 'directory') return undefined;
    if (!captureDirectoryIdentity(directory)) return undefined;
  }
  if (!exactDirectorySet(quarantine, expectedDirectories)) return undefined;
  const quarantineDirectories = expectedDirectories
    .map((relativePath) => {
      const identity = captureDirectoryIdentity(containedPath(quarantine, relativePath)!);
      return identity ? { relative_path: relativePath, ...identity } : undefined;
    })
    .filter((entry): entry is ProjectUndoQuarantineDirectoryV1 => entry !== undefined)
    .toSorted((left, right) => left.relative_path.localeCompare(right.relative_path));
  if (quarantineDirectories.length !== expectedDirectories.length) return undefined;
  return {
    ...plan,
    quarantine_root_identity: rootIdentity,
    quarantine_directories: quarantineDirectories,
  };
}

function filePlacement(
  source: string,
  destination: string,
  expected: ProjectUndoQuarantineFileV1
): 'source' | 'destination' | 'linked' | 'missing' | 'conflict' {
  const sourceKind = pathEntryKind(source);
  const destinationKind = pathEntryKind(destination);
  if (
    (sourceKind !== 'missing' && sourceKind !== 'file') ||
    (destinationKind !== 'missing' && destinationKind !== 'file')
  ) {
    return 'conflict';
  }
  const sourceIdentity = captureFileIdentity(source);
  const destinationIdentity = captureFileIdentity(destination);
  if (sourceIdentity && destinationIdentity) {
    return stableFileIdentity(expected, sourceIdentity) &&
      stableFileIdentity(expected, destinationIdentity) &&
      sourceIdentity.dev === destinationIdentity.dev &&
      sourceIdentity.ino === destinationIdentity.ino
      ? 'linked'
      : 'conflict';
  }
  if (sourceIdentity) return stableFileIdentity(expected, sourceIdentity) ? 'source' : 'conflict';
  if (destinationIdentity) return stableFileIdentity(expected, destinationIdentity) ? 'destination' : 'conflict';
  return 'missing';
}

export function reconcileProjectUndoQuarantine(
  root: string,
  plan: ProjectUndoQuarantinePlanV1
): ProjectUndoQuarantineState {
  const resolvedRoot = path.resolve(root);
  const quarantine = undoQuarantinePath(resolvedRoot, plan);
  if (!quarantine) return 'conflict';
  if (plan.mode === 'create-missing-root' || plan.mode === 'adopt-no-additions') {
    return logicalEmptyUndoPlanHolds(resolvedRoot, quarantine, plan) ? 'quarantined' : 'conflict';
  }
  const rootIdentity = captureDirectoryIdentity(resolvedRoot);
  if (!plan.root_identity || !rootIdentity || !stableDirectoryIdentity(plan.root_identity, rootIdentity)) {
    return 'conflict';
  }
  const quarantineKind = pathEntryKind(quarantine);
  if (!plan.quarantine_root_identity) {
    if (quarantineKind !== 'missing') return 'conflict';
  } else if (quarantineKind !== 'missing' && !verifyPreparedQuarantine(plan, quarantine)) {
    return 'conflict';
  }
  if (
    quarantineKind === 'directory' &&
    listFiles(quarantine).some((relative) => !plan.files.some((file) => file.relative_path === relative))
  ) {
    return 'conflict';
  }
  if (
    plan.mode === 'create-tree' &&
    (listFiles(resolvedRoot).some((relative) => !plan.files.some((file) => file.relative_path === relative)) ||
      listDirectories(resolvedRoot).some(
        (relative) => !plan.directories.some((directory) => directory.relative_path === relative)
      ))
  ) {
    return 'conflict';
  }
  const placements = plan.files.map((entry) => {
    const source = containedPath(resolvedRoot, entry.relative_path);
    const destination = containedPath(quarantine, entry.relative_path);
    return source && destination ? filePlacement(source, destination, entry) : 'conflict';
  });
  if (placements.includes('conflict')) return 'conflict';
  if (placements.length === 0) return quarantineKind === 'directory' ? 'quarantined' : 'source';
  if (placements.every((placement) => placement === 'source')) return 'source';
  if (placements.every((placement) => placement === 'destination')) return 'quarantined';
  if (placements.every((placement) => placement === 'missing')) return 'purged';
  return 'partial';
}

function exactSourceDirectories(root: string, plan: ProjectUndoQuarantinePlanV1): boolean {
  return plan.directories.every((entry) => {
    const directory = containedPath(root, entry.relative_path);
    const observed = directory ? captureDirectoryIdentity(directory) : undefined;
    return observed !== undefined && stableDirectoryIdentity(entry, observed);
  });
}

/** Reconciles crash-partial moves and establishes a complete quarantine without deleting anything. */
export function establishProjectUndoQuarantine(
  root: string,
  plan: ProjectUndoQuarantinePlanV1,
  beforeMutation: BeforeMutation = () => undefined
): boolean {
  const resolvedRoot = path.resolve(root);
  const quarantine = undoQuarantinePath(resolvedRoot, plan);
  if (!quarantine) return false;
  if (plan.mode === 'create-missing-root' || plan.mode === 'adopt-no-additions') {
    return logicalEmptyUndoPlanHolds(resolvedRoot, quarantine, plan);
  }
  if (!plan.quarantine_root_identity || !verifyPreparedQuarantine(plan, quarantine)) return false;
  const rootIdentity = captureDirectoryIdentity(resolvedRoot);
  if (
    !plan.root_identity ||
    !rootIdentity ||
    !stableDirectoryIdentity(plan.root_identity, rootIdentity) ||
    !exactSourceDirectories(resolvedRoot, plan) ||
    (plan.mode === 'create-tree'
      ? listFiles(resolvedRoot).some((relative) => !plan.files.some((file) => file.relative_path === relative)) ||
        listDirectories(resolvedRoot).some(
          (relative) => !plan.directories.some((directory) => directory.relative_path === relative)
        )
      : unsafeAdoptionExtra(resolvedRoot, plan.files, plan.directories) ||
        !createdDirectoryTreeIsSafe(resolvedRoot, plan.directories, plan.files))
  ) {
    return false;
  }
  for (const entry of plan.files) {
    const source = containedPath(resolvedRoot, entry.relative_path);
    const destination = containedPath(quarantine, entry.relative_path);
    if (!source || !destination) return false;
    let placement = filePlacement(source, destination, entry);
    if (placement === 'destination') {
      const observed = captureFileIdentity(destination);
      if (!observed || !exactFileIdentity(entry, observed)) return false;
      continue;
    }
    if (placement === 'source') {
      const observed = captureFileIdentity(source);
      if (!observed || !exactFileIdentity(entry, observed) || !verifyPreparedQuarantine(plan, quarantine)) {
        return false;
      }
      beforeMutation(source);
      beforeMutation(destination);
      if (
        !hasOnlyRealDirectoryParents(resolvedRoot, source) ||
        !hasOnlyRealDirectoryParents(quarantine, destination) ||
        !verifyPreparedQuarantine(plan, quarantine) ||
        filePlacement(source, destination, entry) !== 'source'
      ) {
        return false;
      }
      const finalSource = captureFileIdentity(source);
      if (!finalSource || !exactFileIdentity(entry, finalSource)) return false;
      // Hard-link creation is same-filesystem and create-only: unlike rename, it never overwrites a raced target.
      fs.linkSync(source, destination);
      if (!syncOwnedFileDurable(destination, entry, true)) return false;
      syncDirectoryDurable(path.dirname(destination));
      placement = filePlacement(source, destination, entry);
    }
    if (placement !== 'linked') return false;
    beforeMutation(destination);
    beforeMutation(source);
    if (
      !hasOnlyRealDirectoryParents(resolvedRoot, source) ||
      !hasOnlyRealDirectoryParents(quarantine, destination) ||
      !verifyPreparedQuarantine(plan, quarantine) ||
      filePlacement(source, destination, entry) !== 'linked'
    ) {
      return false;
    }
    const finalSource = captureFileIdentity(source);
    const finalDestination = captureFileIdentity(destination);
    if (
      !finalSource ||
      !finalDestination ||
      !exactFileIdentity(entry, finalSource) ||
      !exactFileIdentity(entry, finalDestination)
    ) {
      return false;
    }
    if (!syncOwnedFileDurable(destination, entry, true)) return false;
    fs.unlinkSync(source);
    syncDirectoryDurable(path.dirname(source));
  }
  return reconcileProjectUndoQuarantine(resolvedRoot, plan) === 'quarantined';
}

function removeVerifiedEmptyDirectory(
  directory: string,
  expected: DirectoryIdentity,
  beforeMutation: BeforeMutation,
  trustedRoot: string
): boolean {
  const kind = pathEntryKind(directory);
  if (kind === 'missing') return true;
  if (kind !== 'directory') return false;
  const observed = captureDirectoryIdentity(directory);
  if (!observed) return false;
  if (
    !stableDirectoryIdentity(expected, observed) ||
    !hasOnlyRealDirectoryParents(trustedRoot, directory) ||
    fs.readdirSync(directory).length !== 0
  ) {
    return false;
  }
  beforeMutation(directory);
  const finalIdentity = captureDirectoryIdentity(directory);
  if (
    pathEntryKind(directory) !== 'directory' ||
    !finalIdentity ||
    !stableDirectoryIdentity(expected, finalIdentity) ||
    !hasOnlyRealDirectoryParents(trustedRoot, directory) ||
    fs.readdirSync(directory).length !== 0
  ) {
    return false;
  }
  fs.rmdirSync(directory);
  syncDirectoryDurable(path.dirname(directory));
  return true;
}

function cleanupPreparedQuarantine(
  quarantine: string,
  plan: ProjectUndoQuarantinePlanV1,
  beforeMutation: BeforeMutation
): boolean {
  if (
    !plan.quarantine_root_identity ||
    !verifyPreparedQuarantine(plan, quarantine, true) ||
    listFiles(quarantine).length !== 0
  ) {
    return false;
  }
  for (const entry of [...plan.quarantine_directories].toSorted(
    (left, right) =>
      right.relative_path.split('/').length - left.relative_path.split('/').length ||
      right.relative_path.localeCompare(left.relative_path)
  )) {
    const directory = containedPath(quarantine, entry.relative_path);
    if (!directory || !removeVerifiedEmptyDirectory(directory, entry, beforeMutation, quarantine)) return false;
  }
  return removeVerifiedEmptyDirectory(
    quarantine,
    plan.quarantine_root_identity,
    beforeMutation,
    path.dirname(quarantine)
  );
}

/** Restores quarantined inodes without requiring the original hash and never overwrites a replacement path. */
export function restoreProjectUndoQuarantine(
  root: string,
  plan: ProjectUndoQuarantinePlanV1,
  beforeMutation: BeforeMutation = () => undefined
): boolean {
  const resolvedRoot = path.resolve(root);
  const quarantine = undoQuarantinePath(resolvedRoot, plan);
  if (!quarantine) return false;
  if (plan.mode === 'create-missing-root' || plan.mode === 'adopt-no-additions') {
    return logicalEmptyUndoPlanHolds(resolvedRoot, quarantine, plan);
  }
  if (!plan.quarantine_root_identity || !plan.root_identity) return false;
  const rootIdentity = captureDirectoryIdentity(resolvedRoot);
  if (!rootIdentity || !stableDirectoryIdentity(plan.root_identity, rootIdentity)) return false;
  const quarantineKind = pathEntryKind(quarantine);
  if (quarantineKind === 'missing') {
    return (
      exactSourceDirectories(resolvedRoot, plan) &&
      plan.files.every((entry) => {
        const source = containedPath(resolvedRoot, entry.relative_path);
        const observed = source ? captureFileIdentity(source) : undefined;
        return (
          source !== undefined &&
          hasOnlyRealDirectoryParents(resolvedRoot, source) &&
          observed !== undefined &&
          stableFileIdentity(entry, observed)
        );
      })
    );
  }
  if (quarantineKind !== 'directory' || !verifyPreparedQuarantine(plan, quarantine, true)) return false;
  for (const entry of plan.files) {
    const source = containedPath(resolvedRoot, entry.relative_path);
    const destination = containedPath(quarantine, entry.relative_path);
    if (!source || !destination) return false;
    let placement = filePlacement(source, destination, entry);
    if (placement === 'source') continue;
    if (placement === 'destination') {
      beforeMutation(destination);
      beforeMutation(source);
      if (
        !hasOnlyRealDirectoryParents(resolvedRoot, source) ||
        !hasOnlyRealDirectoryParents(quarantine, destination) ||
        !verifyPreparedQuarantine(plan, quarantine, true) ||
        filePlacement(source, destination, entry) !== 'destination'
      ) {
        return false;
      }
      fs.linkSync(destination, source);
      if (!syncOwnedFileDurable(source, entry, false)) return false;
      syncDirectoryDurable(path.dirname(source));
      placement = filePlacement(source, destination, entry);
    }
    if (placement !== 'linked') return false;
    beforeMutation(source);
    beforeMutation(destination);
    if (
      !hasOnlyRealDirectoryParents(resolvedRoot, source) ||
      !hasOnlyRealDirectoryParents(quarantine, destination) ||
      !verifyPreparedQuarantine(plan, quarantine, true) ||
      filePlacement(source, destination, entry) !== 'linked'
    ) {
      return false;
    }
    if (!syncOwnedFileDurable(source, entry, false)) return false;
    fs.unlinkSync(destination);
    syncDirectoryDurable(path.dirname(destination));
    const restored = captureFileIdentity(source);
    if (!restored || !stableFileIdentity(entry, restored)) return false;
  }
  return cleanupPreparedQuarantine(quarantine, plan, beforeMutation);
}

function unlinkExactFile(
  file: string,
  expected: ProjectUndoQuarantineFileV1,
  beforeMutation: BeforeMutation,
  stillAllowed: () => boolean
): boolean {
  const open = openFileIdentity(file);
  if (!open) return pathEntryKind(file) === 'missing';
  try {
    if (!exactFileIdentity(expected, open.identity)) return false;
    beforeMutation(file);
    if (!stillAllowed()) return false;
    const rechecked = openFileIdentity(file);
    if (!rechecked) return false;
    try {
      if (
        rechecked.identity.dev !== open.identity.dev ||
        rechecked.identity.ino !== open.identity.ino ||
        !exactFileIdentity(expected, rechecked.identity)
      ) {
        return false;
      }
      const pathStat = fs.lstatSync(file);
      if (
        pathStat.isSymbolicLink() ||
        pathStat.dev !== rechecked.identity.dev ||
        pathStat.ino !== rechecked.identity.ino
      ) {
        return false;
      }
      fs.unlinkSync(file);
      syncDirectoryDurable(path.dirname(file));
      return true;
    } finally {
      fs.closeSync(rechecked.descriptor);
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    fs.closeSync(open.descriptor);
  }
}

/** Permanently removes only the still-exact quarantine after the caller has journaled removal commitment. */
export function purgeProjectUndoQuarantine(
  root: string,
  plan: ProjectUndoQuarantinePlanV1,
  beforeMutation: BeforeMutation = () => undefined
): boolean {
  const resolvedRoot = path.resolve(root);
  const quarantine = undoQuarantinePath(resolvedRoot, plan);
  if (!quarantine) return false;
  if (plan.mode === 'create-missing-root' || plan.mode === 'adopt-no-additions') {
    return logicalEmptyUndoPlanHolds(resolvedRoot, quarantine, plan);
  }
  if (!plan.quarantine_root_identity) return false;
  if (!plan.root_identity) return false;
  const rootKind = pathEntryKind(resolvedRoot);
  if (plan.mode === 'create-tree' && rootKind === 'missing') {
    return pathEntryKind(quarantine) === 'missing';
  }
  if (rootKind !== 'directory') return false;
  const rootIdentity = captureDirectoryIdentity(resolvedRoot);
  if (!rootIdentity || !stableDirectoryIdentity(plan.root_identity, rootIdentity)) return false;
  const sourceTreeIsSafe = () =>
    plan.mode === 'create-tree'
      ? createdProjectTreeIsSafe(resolvedRoot, plan.directories)
      : createdDirectoryTreeIsSafe(resolvedRoot, plan.directories);
  for (const entry of plan.files) {
    const source = containedPath(resolvedRoot, entry.relative_path);
    if (!source || !hasNoNonDirectoryExistingParents(resolvedRoot, source) || pathEntryKind(source) !== 'missing') {
      return false;
    }
  }
  if (!sourceTreeIsSafe()) return false;

  const quarantineKind = pathEntryKind(quarantine);
  if (quarantineKind !== 'missing') {
    if (quarantineKind !== 'directory' || !verifyPreparedQuarantine(plan, quarantine, true)) return false;
    const plannedFiles = new Set(plan.files.map((entry) => entry.relative_path));
    if (listFiles(quarantine).some((relative) => !plannedFiles.has(relative))) return false;
    for (const entry of plan.files) {
      const destination = containedPath(quarantine, entry.relative_path);
      if (!destination) return false;
      const destinationKind = pathEntryKind(destination);
      if (destinationKind !== 'missing' && destinationKind !== 'file') return false;
      const observed = destinationKind === 'file' ? captureFileIdentity(destination) : undefined;
      if (observed && !exactFileIdentity(entry, observed)) return false;
    }
    for (const entry of plan.files) {
      const source = containedPath(resolvedRoot, entry.relative_path);
      const destination = containedPath(quarantine, entry.relative_path);
      if (!source || !destination) return false;
      if (
        pathEntryKind(destination) !== 'missing' &&
        !unlinkExactFile(destination, entry, beforeMutation, () => {
          return (
            pathEntryKind(source) === 'missing' &&
            hasNoNonDirectoryExistingParents(resolvedRoot, source) &&
            hasOnlyRealDirectoryParents(quarantine, destination) &&
            verifyPreparedQuarantine(plan, quarantine, true) &&
            listFiles(quarantine).every((relative) => plannedFiles.has(relative))
          );
        })
      ) {
        return false;
      }
    }
    if (!cleanupPreparedQuarantine(quarantine, plan, beforeMutation)) return false;
  }

  if (!sourceTreeIsSafe()) return false;
  for (const entry of [...plan.directories].toSorted(
    (left, right) =>
      right.relative_path.split('/').length - left.relative_path.split('/').length ||
      right.relative_path.localeCompare(left.relative_path)
  )) {
    const directory = containedPath(resolvedRoot, entry.relative_path);
    if (!directory || !removeVerifiedEmptyDirectory(directory, entry, beforeMutation, resolvedRoot)) return false;
  }
  return plan.mode === 'adopt-additions'
    ? true
    : removeVerifiedEmptyDirectory(resolvedRoot, plan.root_identity, beforeMutation, path.dirname(resolvedRoot));
}

type PathEntryKind = 'missing' | 'file' | 'directory' | 'other';

function pathEntryKind(target: string): PathEntryKind {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return 'other';
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

function containedPath(root: string, relativePath: string): string | undefined {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? candidate : undefined;
}

function hasOnlyRealDirectoryParents(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const parent = path.dirname(path.resolve(candidate));
  const relative = path.relative(resolvedRoot, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (pathEntryKind(resolvedRoot) !== 'directory') return false;
  let current = resolvedRoot;
  if (relative === '') return true;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (pathEntryKind(current) !== 'directory') return false;
  }
  return true;
}

function hasNoNonDirectoryExistingParents(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const parent = path.dirname(path.resolve(candidate));
  const relative = path.relative(resolvedRoot, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative) || pathEntryKind(resolvedRoot) !== 'directory') {
    return false;
  }
  let current = resolvedRoot;
  if (relative === '') return true;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const kind = pathEntryKind(current);
    if (kind === 'missing') return true;
    if (kind !== 'directory') return false;
  }
  return true;
}

function openFileIdentity(file: string): OpenFileIdentity | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile()) return undefined;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(descriptor)).digest('hex');
    const pathStat = fs.lstatSync(file);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== descriptorStat.dev ||
      pathStat.ino !== descriptorStat.ino
    ) {
      return undefined;
    }
    const open = {
      descriptor,
      identity: { dev: descriptorStat.dev, ino: descriptorStat.ino, size: descriptorStat.size, sha256 },
    };
    descriptor = undefined;
    return open;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function captureFileIdentity(file: string): FileIdentity | undefined {
  const open = openFileIdentity(file);
  if (!open) return undefined;
  try {
    return open.identity;
  } finally {
    fs.closeSync(open.descriptor);
  }
}

function syncOwnedFileDurable(file: string, expected: ProjectUndoQuarantineFileV1, requireExact: boolean): boolean {
  const open = openFileIdentity(file);
  if (!open) return false;
  try {
    if (requireExact ? !exactFileIdentity(expected, open.identity) : !stableFileIdentity(expected, open.identity)) {
      return false;
    }
    fs.fsyncSync(open.descriptor);
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(open.descriptor);
  }
}

export function sha256File(file: string): string | undefined {
  return captureFileIdentity(file)?.sha256;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.sha256 === right.sha256;
}

function captureDirectoryIdentity(directory: string): DirectoryIdentity | undefined {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function removeFileIfUnchanged(
  file: string,
  identity: FileIdentity | undefined,
  beforeMutation: (targetPath: string) => void,
  allowMissing: boolean
): boolean {
  beforeMutation(file);
  const open = openFileIdentity(file);
  if (!identity || !open) {
    if (open) fs.closeSync(open.descriptor);
    return allowMissing && identity === undefined && open === undefined;
  }
  if (!sameFileIdentity(identity, open.identity)) {
    fs.closeSync(open.descriptor);
    return false;
  }
  const quarantine = path.join(
    path.dirname(file),
    `.${path.basename(file)}.command-eve-removing-${crypto.randomUUID()}`
  );
  try {
    fs.renameSync(file, quarantine);
    const moved = fs.lstatSync(quarantine);
    if (
      moved.isSymbolicLink() ||
      !moved.isFile() ||
      moved.dev !== open.identity.dev ||
      moved.ino !== open.identity.ino
    ) {
      try {
        fs.linkSync(quarantine, file);
        fs.unlinkSync(quarantine);
      } catch {
        // The unexpected inode remains quarantined rather than being deleted or overwriting a new target.
      }
      return false;
    }
    fs.unlinkSync(quarantine);
    return true;
  } catch (error) {
    return allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(quarantine);
  } finally {
    fs.closeSync(open.descriptor);
  }
}

function removeDirectoryIfUnchanged(
  directory: string,
  identity: DirectoryIdentity | undefined,
  beforeMutation: (targetPath: string) => void,
  allowMissing: boolean
): boolean {
  beforeMutation(directory);
  const current = captureDirectoryIdentity(directory);
  if (!identity || !current) return allowMissing && identity === undefined && current === undefined;
  if (identity.dev !== current.dev || identity.ino !== current.ino) return false;
  let handle: fs.Dir;
  try {
    handle = fs.opendirSync(directory);
  } catch {
    return false;
  }
  const quarantine = path.join(
    path.dirname(directory),
    `.${path.basename(directory)}.command-eve-removing-${crypto.randomUUID()}`
  );
  try {
    if (handle.readSync() !== null) return false;
    fs.renameSync(directory, quarantine);
    const moved = captureDirectoryIdentity(quarantine);
    if (!moved || moved.dev !== identity.dev || moved.ino !== identity.ino) {
      try {
        if (!fs.existsSync(directory)) fs.renameSync(quarantine, directory);
      } catch {
        // The unexpected directory remains quarantined rather than being deleted or overwriting a new target.
      }
      return false;
    }
    handle.closeSync();
    if (fs.readdirSync(quarantine).length !== 0) {
      try {
        if (!fs.existsSync(directory)) fs.renameSync(quarantine, directory);
      } catch {
        // Preserve a non-empty directory rather than deleting content not covered by the removal plan.
      }
      return false;
    }
    fs.rmdirSync(quarantine);
    return true;
  } catch (error) {
    return allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT' && !fs.existsSync(quarantine);
  } finally {
    try {
      handle.closeSync();
    } catch {
      // The handle was already closed before removing the verified quarantine directory.
    }
  }
}

export function verifyCreatedFiles(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>
): boolean {
  return createdFiles.every((entry) => {
    const file = containedPath(root, entry.relative_path);
    return file !== undefined && sha256File(file) === entry.sha256;
  });
}

function listFiles(root: string, current = root): string[] {
  const kind = pathEntryKind(current);
  if (kind === 'missing') return [];
  if (kind !== 'directory') return ['\0invalid-file-entry'];
  const out: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      out.push(path.relative(root, absolute).split(path.sep).join('/'));
    } else if (entry.isDirectory()) {
      out.push(...listFiles(root, absolute));
    } else {
      out.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return out.toSorted();
}

function ownedFilesAreSafe(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  allowMissing: boolean
): boolean {
  return createdFiles.every((entry) => {
    const file = containedPath(root, entry.relative_path);
    if (!file) return false;
    if (!fs.existsSync(file)) return allowMissing;
    return sha256File(file) === entry.sha256;
  });
}

export function captureRemovalIdentityPlan(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  createdDirectories: string[],
  allowedExtraFiles: string[] = [],
  allowMissingOwnedFiles = false
): RemovalIdentityPlan | undefined {
  const fileIdentities = new Map<string, FileIdentity | undefined>();
  for (const entry of createdFiles) {
    const file = containedPath(root, entry.relative_path);
    if (!file) return undefined;
    const identity = captureFileIdentity(file);
    if ((!identity && !allowMissingOwnedFiles) || (identity && identity.sha256 !== entry.sha256)) return undefined;
    fileIdentities.set(entry.relative_path, identity);
  }
  for (const relative of allowedExtraFiles) {
    const file = containedPath(root, relative);
    if (!file) return undefined;
    const identity = captureFileIdentity(file);
    if (!identity && !allowMissingOwnedFiles) return undefined;
    fileIdentities.set(relative, identity);
  }
  const directoryIdentities = new Map<string, DirectoryIdentity | undefined>();
  for (const relative of createdDirectories) {
    const directory = containedPath(root, relative);
    if (!directory) return undefined;
    const identity = captureDirectoryIdentity(directory);
    if (!identity && !allowMissingOwnedFiles) return undefined;
    directoryIdentities.set(relative, identity);
  }
  const rootIdentity = captureDirectoryIdentity(root);
  if (!rootIdentity && !allowMissingOwnedFiles) return undefined;
  return {
    root: path.resolve(root),
    file_identities: fileIdentities,
    directory_identities: directoryIdentities,
    root_identity: rootIdentity,
  };
}

export function hasOnlyExpectedFiles(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  allowedExtraFiles: string[] = []
): boolean {
  const allowed = new Set([...createdFiles.map((entry) => entry.relative_path), ...allowedExtraFiles]);
  return listFiles(root).every((relative) => allowed.has(relative));
}

/** Removes exact receipt-owned files and then only empty directories. Never recurses with rm. */
export function removeCreatedTree(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  createdDirectories: string[],
  allowedExtraFiles: string[] = [],
  beforeMutation: (targetPath: string) => void = () => undefined,
  allowMissingOwnedFiles = false,
  identityPlan?: RemovalIdentityPlan
): boolean {
  if (
    !ownedFilesAreSafe(root, createdFiles, allowMissingOwnedFiles) ||
    !hasOnlyExpectedFiles(root, createdFiles, allowedExtraFiles)
  ) {
    return false;
  }
  const plan =
    identityPlan ??
    captureRemovalIdentityPlan(root, createdFiles, createdDirectories, allowedExtraFiles, allowMissingOwnedFiles);
  if (!plan || plan.root !== path.resolve(root)) return false;
  for (const entry of createdFiles) {
    const file = containedPath(root, entry.relative_path);
    if (!file) return false;
    if (
      !removeFileIfUnchanged(
        file,
        plan.file_identities.get(entry.relative_path),
        beforeMutation,
        allowMissingOwnedFiles
      )
    )
      return false;
  }
  for (const relative of allowedExtraFiles) {
    const file = containedPath(root, relative);
    if (!file) return false;
    if (!removeFileIfUnchanged(file, plan.file_identities.get(relative), beforeMutation, allowMissingOwnedFiles))
      return false;
  }
  const directories = [...createdDirectories].toSorted(
    (left, right) => right.split('/').length - left.split('/').length || right.localeCompare(left)
  );
  for (const relative of directories) {
    const directory = containedPath(root, relative);
    if (!directory) return false;
    if (
      !removeDirectoryIfUnchanged(
        directory,
        plan.directory_identities.get(relative),
        beforeMutation,
        allowMissingOwnedFiles
      )
    )
      return false;
  }
  return removeDirectoryIfUnchanged(root, plan.root_identity, beforeMutation, allowMissingOwnedFiles);
}

/** Adoption undo: remove only unchanged additions and empty dirs, preserving the adopted root and prior files. */
export function removeAdoptionAdditions(
  root: string,
  createdFiles: Array<{ relative_path: string; sha256: string }>,
  createdDirectories: string[],
  allowedExtraFiles: string[] = [],
  beforeMutation: (targetPath: string) => void = () => undefined,
  allowMissingOwnedFiles = false,
  identityPlan?: RemovalIdentityPlan
): boolean {
  if (!ownedFilesAreSafe(root, createdFiles, allowMissingOwnedFiles)) return false;
  const createdDirectoryPrefixes = createdDirectories.map((directory) => `${directory.replace(/\/$/, '')}/`);
  const owned = new Set([...createdFiles.map((entry) => entry.relative_path), ...allowedExtraFiles]);
  const unsafeExtra = listFiles(root).some(
    (relative) => !owned.has(relative) && createdDirectoryPrefixes.some((prefix) => relative.startsWith(prefix))
  );
  if (unsafeExtra) return false;
  const plan =
    identityPlan ??
    captureRemovalIdentityPlan(root, createdFiles, createdDirectories, allowedExtraFiles, allowMissingOwnedFiles);
  if (!plan || plan.root !== path.resolve(root)) return false;
  for (const entry of createdFiles) {
    const file = containedPath(root, entry.relative_path);
    if (!file) return false;
    if (
      !removeFileIfUnchanged(
        file,
        plan.file_identities.get(entry.relative_path),
        beforeMutation,
        allowMissingOwnedFiles
      )
    )
      return false;
  }
  for (const relative of allowedExtraFiles) {
    const file = containedPath(root, relative);
    if (!file) return false;
    if (!removeFileIfUnchanged(file, plan.file_identities.get(relative), beforeMutation, allowMissingOwnedFiles))
      return false;
  }
  const directories = [...createdDirectories].toSorted(
    (left, right) => right.split('/').length - left.split('/').length || right.localeCompare(left)
  );
  for (const relative of directories) {
    const directory = containedPath(root, relative);
    if (!directory) return false;
    if (
      !removeDirectoryIfUnchanged(
        directory,
        plan.directory_identities.get(relative),
        beforeMutation,
        allowMissingOwnedFiles
      )
    )
      return false;
  }
  return true;
}
