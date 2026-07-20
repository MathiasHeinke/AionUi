import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';

const FILE_LOCK_VERSION = 'command-eve-exclusive-file-lock/v2' as const;
const LEGACY_FILE_LOCK_VERSION = 'command-eve-exclusive-file-lock/v1' as const;
const PROCESS_WITNESS_VERSION = 'command-eve-process-witness/v1' as const;
const FILE_LOCK_STALE_AFTER_MS = 30_000;
const PROCESS_BOOT_NONCE_SHA256 = crypto
  .createHash('sha256')
  .update(`${crypto.randomUUID()}:${process.pid}:${Date.now()}`, 'utf8')
  .digest('hex');

type FileLockRecord = {
  schema_version: typeof FILE_LOCK_VERSION;
  owner_token: string;
  pid: number;
  process_nonce_sha256: string;
  acquired_at_ms: number;
  expires_at_ms: number;
};

type LegacyFileLockRecord = Omit<FileLockRecord, 'schema_version' | 'process_nonce_sha256'> & {
  schema_version: typeof LEGACY_FILE_LOCK_VERSION;
};

type FileLockSnapshot = {
  raw: string;
  dev: number;
  ino: number;
  mtime_ms: number;
  record?: FileLockRecord | LegacyFileLockRecord;
};

export function ensurePrivateDirectory(directory: string): void {
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created === undefined) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProjectWorkspaceError('workspace.io-failed');
    return;
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Some filesystems do not expose POSIX modes. Creation still remains local.
  }
}

export function syncDirectoryDurable(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeFileAtomic(file: string, contents: string, mode = 0o600): void {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    syncDirectoryDurable(path.dirname(file));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // No partially written temp remains when cleanup is possible.
    }
    throw error;
  }
}

/** Durable create-only write. The final hard-link step is atomic and never overwrites. */
export function writeFileCreateOnly(file: string, contents: string, mode = 0o600): void {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, file);
    syncDirectoryDurable(path.dirname(file));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temp path may already be absent; the final file is never removed here.
    }
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function parseFileLockRecord(value: unknown): FileLockRecord | LegacyFileLockRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const isLegacy = record.schema_version === LEGACY_FILE_LOCK_VERSION;
  const expectedKeys = isLegacy
    ? ['schema_version', 'owner_token', 'pid', 'acquired_at_ms', 'expires_at_ms']
    : ['schema_version', 'owner_token', 'pid', 'process_nonce_sha256', 'acquired_at_ms', 'expires_at_ms'];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(record, key)) ||
    (record.schema_version !== FILE_LOCK_VERSION && !isLegacy) ||
    typeof record.owner_token !== 'string' ||
    record.owner_token.length < 16 ||
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    (!isLegacy &&
      (typeof record.process_nonce_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.process_nonce_sha256))) ||
    typeof record.acquired_at_ms !== 'number' ||
    !Number.isFinite(record.acquired_at_ms) ||
    record.acquired_at_ms < 0 ||
    typeof record.expires_at_ms !== 'number' ||
    !Number.isFinite(record.expires_at_ms) ||
    record.expires_at_ms <= record.acquired_at_ms
  ) {
    return undefined;
  }
  return record as FileLockRecord | LegacyFileLockRecord;
}

function readFileLockSnapshot(file: string): FileLockSnapshot | undefined {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(stat.size);
    if (stat.size > 0) fs.readSync(descriptor, buffer, 0, stat.size, 0);
    const raw = buffer.toString('utf8');
    let record: FileLockRecord | LegacyFileLockRecord | undefined;
    try {
      record = parseFileLockRecord(JSON.parse(raw) as unknown);
    } catch {
      record = undefined;
    }
    return { raw, dev: stat.dev, ino: stat.ino, mtime_ms: stat.mtimeMs, ...(record ? { record } : {}) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

type ProcessWitness = {
  schema_version: typeof PROCESS_WITNESS_VERSION;
  pid: number;
  process_nonce_sha256: string;
};

function processWitnessPath(directory: string, pid: number): string {
  return path.join(directory, '.process-witnesses', `${pid}.json`);
}

export function publishProcessWitness(directory: string): void {
  writeJsonAtomic(processWitnessPath(directory, process.pid), {
    schema_version: PROCESS_WITNESS_VERSION,
    pid: process.pid,
    process_nonce_sha256: PROCESS_BOOT_NONCE_SHA256,
  } satisfies ProcessWitness);
}

function readProcessWitness(directory: string, pid: number): ProcessWitness | undefined {
  try {
    const value = readJson(processWitnessPath(directory, pid));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const witness = value as Record<string, unknown>;
    if (
      Object.keys(witness).length !== 3 ||
      witness.schema_version !== PROCESS_WITNESS_VERSION ||
      witness.pid !== pid ||
      typeof witness.process_nonce_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(witness.process_nonce_sha256)
    ) {
      return undefined;
    }
    return witness as ProcessWitness;
  } catch {
    return undefined;
  }
}

export function currentProcessNonceSha256(): string {
  return PROCESS_BOOT_NONCE_SHA256;
}

export function processWitnessMatches(directory: string, pid: number, processNonceSha256: string): boolean | undefined {
  const witness = readProcessWitness(directory, pid);
  return witness ? witness.process_nonce_sha256 === processNonceSha256 : undefined;
}

function lockOwnerIsLive(snapshot: FileLockSnapshot, lockDirectory: string): boolean {
  if (!snapshot.record || !processIsAlive(snapshot.record.pid)) return false;
  if (snapshot.record.schema_version === LEGACY_FILE_LOCK_VERSION) return true;
  const witnessMatches = processWitnessMatches(
    lockDirectory,
    snapshot.record.pid,
    snapshot.record.process_nonce_sha256
  );
  // Missing witness evidence fails safe: a live PID is never stolen on TTL alone.
  return witnessMatches === undefined || witnessMatches;
}

export function processPidIsAlive(pid: number): boolean {
  return processIsAlive(pid);
}

type FileLockDisposition = 'active' | 'live-stuck' | 'stale';

function fileLockDisposition(snapshot: FileLockSnapshot, nowMs: number, lockDirectory: string): FileLockDisposition {
  if (snapshot.record) {
    if (!lockOwnerIsLive(snapshot, lockDirectory)) return 'stale';
    return nowMs >= snapshot.record.expires_at_ms ? 'live-stuck' : 'active';
  }
  return nowMs - snapshot.mtime_ms >= FILE_LOCK_STALE_AFTER_MS ? 'stale' : 'active';
}

function restoreQuarantinedLock(quarantine: string, lockPath: string): void {
  if (fs.existsSync(lockPath)) return;
  try {
    fs.renameSync(quarantine, lockPath);
    syncDirectoryDurable(path.dirname(lockPath));
  } catch {
    // A contender may already have restored or replaced the canonical lock.
  }
}

export function withExclusiveFileLock<T>(lockPath: string, callback: () => T): T {
  ensurePrivateDirectory(path.dirname(lockPath));
  publishProcessWitness(path.dirname(lockPath));
  const ownerToken = crypto.randomUUID();
  const acquiredAtMs = Date.now();
  const record: FileLockRecord = {
    schema_version: FILE_LOCK_VERSION,
    owner_token: ownerToken,
    pid: process.pid,
    process_nonce_sha256: PROCESS_BOOT_NONCE_SHA256,
    acquired_at_ms: acquiredAtMs,
    expires_at_ms: acquiredAtMs + FILE_LOCK_STALE_AFTER_MS,
  };
  let descriptor: number;
  const createOwnLock = (): number => {
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      fs.writeFileSync(fileDescriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fileDescriptor);
      syncDirectoryDurable(path.dirname(lockPath));
      return fileDescriptor;
    } catch (error) {
      if (fileDescriptor !== undefined) {
        try {
          const descriptorStat = fs.fstatSync(fileDescriptor);
          const currentPathStat = fs.lstatSync(lockPath);
          if (currentPathStat.dev === descriptorStat.dev && currentPathStat.ino === descriptorStat.ino) {
            fs.unlinkSync(lockPath);
            syncDirectoryDurable(path.dirname(lockPath));
          }
        } catch {
          // A failed or replaced partial lock is never deleted without matching its inode.
        }
        fs.closeSync(fileDescriptor);
      }
      throw error;
    }
  };
  try {
    descriptor = createOwnLock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const observed = readFileLockSnapshot(lockPath);
    const disposition = observed ? fileLockDisposition(observed, acquiredAtMs, path.dirname(lockPath)) : 'active';
    if (disposition === 'live-stuck') {
      throw new ProjectWorkspaceError('workspace.recovery-required');
    }
    if (!observed || disposition !== 'stale') {
      throw new ProjectWorkspaceError('workspace.concurrent-operation');
    }
    const quarantine = `${lockPath}.stale.${ownerToken}`;
    try {
      fs.renameSync(lockPath, quarantine);
      syncDirectoryDurable(path.dirname(lockPath));
    } catch {
      throw new ProjectWorkspaceError('workspace.concurrent-operation');
    }
    const quarantined = readFileLockSnapshot(quarantine);
    if (
      !quarantined ||
      quarantined.dev !== observed.dev ||
      quarantined.ino !== observed.ino ||
      quarantined.raw !== observed.raw ||
      fileLockDisposition(quarantined, acquiredAtMs, path.dirname(lockPath)) !== 'stale'
    ) {
      restoreQuarantinedLock(quarantine, lockPath);
      throw new ProjectWorkspaceError('workspace.concurrent-operation');
    }
    try {
      descriptor = createOwnLock();
    } catch (createError) {
      restoreQuarantinedLock(quarantine, lockPath);
      if ((createError as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ProjectWorkspaceError('workspace.concurrent-operation');
      }
      throw createError;
    }
    try {
      fs.unlinkSync(quarantine);
      syncDirectoryDurable(path.dirname(lockPath));
    } catch {
      // The canonical lock is already ours; orphaned stale evidence is harmless.
    }
  }
  try {
    return callback();
  } finally {
    try {
      const descriptorStat = fs.fstatSync(descriptor);
      const current = readFileLockSnapshot(lockPath);
      if (
        current?.record?.owner_token === ownerToken &&
        current.record.schema_version === FILE_LOCK_VERSION &&
        current.record.process_nonce_sha256 === PROCESS_BOOT_NONCE_SHA256 &&
        current.dev === descriptorStat.dev &&
        current.ino === descriptorStat.ino
      ) {
        fs.unlinkSync(lockPath);
        syncDirectoryDurable(path.dirname(lockPath));
      }
    } catch {
      // A missing or replaced lock must never be removed by the previous owner.
    } finally {
      fs.closeSync(descriptor);
    }
  }
}
