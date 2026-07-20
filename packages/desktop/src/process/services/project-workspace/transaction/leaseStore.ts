import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_LEASE_VERSION, type ProjectLeaseV2 } from '@/common/types/project-workspace/transaction';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import {
  currentProcessNonceSha256,
  processPidIsAlive,
  processWitnessMatches,
  publishProcessWitness,
  readJson,
  syncDirectoryDurable,
  withExclusiveFileLock,
  writeFileAtomic,
  writeFileCreateOnly,
} from '../storage/atomicJson';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function projectLeasePath(leaseDirectory: string, key: string): string {
  return path.join(leaseDirectory, `${sha256(key)}.lease.json`);
}

function validateLease(value: unknown): ProjectLeaseV2 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const lease = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'schema_version',
    'key_sha256',
    'transaction_id',
    'owner_token_sha256',
    'lineage_owner_token_sha256',
    'owner_pid',
    'owner_process_nonce_sha256',
    'acquired_at_ms',
    'heartbeat_at_ms',
    'expires_at_ms',
    'released_at_ms',
  ]);
  if (
    Object.keys(lease).length !== allowedKeys.size ||
    Object.keys(lease).some((key) => !allowedKeys.has(key)) ||
    lease.schema_version !== PROJECT_LEASE_VERSION ||
    typeof lease.key_sha256 !== 'string' ||
    !SHA256_PATTERN.test(lease.key_sha256) ||
    typeof lease.transaction_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lease.transaction_id) ||
    typeof lease.owner_token_sha256 !== 'string' ||
    !SHA256_PATTERN.test(lease.owner_token_sha256) ||
    typeof lease.lineage_owner_token_sha256 !== 'string' ||
    !SHA256_PATTERN.test(lease.lineage_owner_token_sha256) ||
    typeof lease.owner_pid !== 'number' ||
    !Number.isSafeInteger(lease.owner_pid) ||
    lease.owner_pid <= 0 ||
    typeof lease.owner_process_nonce_sha256 !== 'string' ||
    !SHA256_PATTERN.test(lease.owner_process_nonce_sha256) ||
    typeof lease.acquired_at_ms !== 'number' ||
    !Number.isFinite(lease.acquired_at_ms) ||
    lease.acquired_at_ms < 0 ||
    typeof lease.heartbeat_at_ms !== 'number' ||
    !Number.isFinite(lease.heartbeat_at_ms) ||
    lease.heartbeat_at_ms < lease.acquired_at_ms ||
    typeof lease.expires_at_ms !== 'number' ||
    !Number.isFinite(lease.expires_at_ms) ||
    lease.expires_at_ms <= lease.heartbeat_at_ms ||
    (lease.released_at_ms !== null &&
      (typeof lease.released_at_ms !== 'number' ||
        !Number.isFinite(lease.released_at_ms) ||
        lease.released_at_ms < lease.heartbeat_at_ms))
  ) {
    return undefined;
  }
  return lease as ProjectLeaseV2;
}

function sameLease(left: ProjectLeaseV2, right: ProjectLeaseV2): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.key_sha256 === right.key_sha256 &&
    left.transaction_id === right.transaction_id &&
    left.owner_token_sha256 === right.owner_token_sha256 &&
    left.lineage_owner_token_sha256 === right.lineage_owner_token_sha256 &&
    left.owner_pid === right.owner_pid &&
    left.owner_process_nonce_sha256 === right.owner_process_nonce_sha256 &&
    left.acquired_at_ms === right.acquired_at_ms &&
    left.heartbeat_at_ms === right.heartbeat_at_ms &&
    left.expires_at_ms === right.expires_at_ms &&
    left.released_at_ms === right.released_at_ms
  );
}

function createLeaseExclusive(file: string, lease: ProjectLeaseV2): boolean {
  try {
    writeFileCreateOnly(file, `${JSON.stringify(lease, null, 2)}\n`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function leaseMutationLockPath(file: string): string {
  return `${file}.mutation.lock`;
}

function replaceLeaseAtomically(
  leasePath: string,
  transform: (current: ProjectLeaseV2) => ProjectLeaseV2 | undefined
): boolean {
  let descriptor: number;
  try {
    descriptor = fs.openSync(leasePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return false;
  }
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile()) return false;
    let current: ProjectLeaseV2 | undefined;
    try {
      current = validateLease(JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown);
    } catch {
      return false;
    }
    if (!current) return false;
    const next = transform(current);
    if (!next || !validateLease(next)) return false;
    const pathStat = fs.lstatSync(leasePath);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== descriptorStat.dev ||
      pathStat.ino !== descriptorStat.ino
    ) {
      return false;
    }
    writeFileAtomic(leasePath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readLeaseAfterExclusiveCreate(file: string): ProjectLeaseV2 | undefined {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const lease = validateLease(readJson(file));
      if (lease) return lease;
    } catch {
      // The creator may be between O_EXCL and its fsynced JSON write.
    }
    Atomics.wait(waitBuffer, 0, 0, 5);
  }
  return undefined;
}

export type AcquireLeaseInput = {
  lease_directory: string;
  key: string;
  transaction_id: string;
  lineage_owner_token_sha256: string;
  owner_token: string;
  ttl_ms: number;
  now_ms: number;
  can_take_over_stale: (lease: ProjectLeaseV2) => boolean;
};

export type AcquireLeaseResult =
  | { ok: true; lease_path: string; lease: ProjectLeaseV2; took_over_stale: boolean }
  | {
      ok: false;
      reason_code: 'workspace.concurrent-operation' | 'workspace.lease-invalid' | 'workspace.lease-stale-unrecoverable';
      lease_path: string;
    };

export function acquireProjectLease(input: AcquireLeaseInput): AcquireLeaseResult {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.transaction_id) ||
    !SHA256_PATTERN.test(input.lineage_owner_token_sha256) ||
    !Number.isFinite(input.now_ms) ||
    !Number.isFinite(input.ttl_ms) ||
    input.now_ms < 0 ||
    input.ttl_ms <= 0
  ) {
    return {
      ok: false,
      reason_code: 'workspace.lease-invalid',
      lease_path: projectLeasePath(input.lease_directory, input.key),
    };
  }
  const ttl = Math.max(1_000, Math.min(input.ttl_ms, 24 * 60 * 60 * 1_000));
  const file = projectLeasePath(input.lease_directory, input.key);
  publishProcessWitness(input.lease_directory);
  const next: ProjectLeaseV2 = {
    schema_version: PROJECT_LEASE_VERSION,
    key_sha256: sha256(input.key),
    transaction_id: input.transaction_id,
    owner_token_sha256: sha256(input.owner_token),
    lineage_owner_token_sha256: input.lineage_owner_token_sha256,
    owner_pid: process.pid,
    owner_process_nonce_sha256: currentProcessNonceSha256(),
    acquired_at_ms: input.now_ms,
    heartbeat_at_ms: input.now_ms,
    expires_at_ms: input.now_ms + ttl,
    released_at_ms: null,
  };
  try {
    return withExclusiveFileLock(leaseMutationLockPath(file), () => {
      if (createLeaseExclusive(file, next)) {
        return { ok: true, lease_path: file, lease: next, took_over_stale: false };
      }

      const current = readLeaseAfterExclusiveCreate(file);
      if (!current || current.key_sha256 !== next.key_sha256) {
        return { ok: false, reason_code: 'workspace.lease-invalid', lease_path: file };
      }
      if (current.released_at_ms === null) {
        const witnessMatches = processWitnessMatches(
          input.lease_directory,
          current.owner_pid,
          current.owner_process_nonce_sha256
        );
        const ownerIsLive =
          processPidIsAlive(current.owner_pid) && (witnessMatches === undefined || witnessMatches === true);
        if (ownerIsLive) {
          return { ok: false, reason_code: 'workspace.concurrent-operation', lease_path: file };
        }
        if (
          current.transaction_id !== input.transaction_id ||
          current.lineage_owner_token_sha256 !== input.lineage_owner_token_sha256 ||
          !input.can_take_over_stale(current)
        ) {
          return { ok: false, reason_code: 'workspace.lease-stale-unrecoverable', lease_path: file };
        }
      }

      const quarantine = `${file}.stale.${input.owner_token.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || process.pid}`;
      try {
        fs.renameSync(file, quarantine);
        syncDirectoryDurable(path.dirname(file));
      } catch {
        return { ok: false, reason_code: 'workspace.concurrent-operation', lease_path: file };
      }
      try {
        let quarantined: ProjectLeaseV2 | undefined;
        try {
          quarantined = validateLease(readJson(quarantine));
        } catch {
          quarantined = undefined;
        }
        if (!quarantined || quarantined.key_sha256 !== next.key_sha256) {
          if (!fs.existsSync(file)) fs.renameSync(quarantine, file);
          return { ok: false, reason_code: 'workspace.lease-invalid', lease_path: file };
        }
        if (!sameLease(current, quarantined)) {
          if (!fs.existsSync(file)) fs.renameSync(quarantine, file);
          return { ok: false, reason_code: 'workspace.concurrent-operation', lease_path: file };
        }
        if (quarantined.released_at_ms === null) {
          const witnessMatches = processWitnessMatches(
            input.lease_directory,
            quarantined.owner_pid,
            quarantined.owner_process_nonce_sha256
          );
          const ownerIsLive =
            processPidIsAlive(quarantined.owner_pid) && (witnessMatches === undefined || witnessMatches === true);
          if (
            ownerIsLive ||
            quarantined.transaction_id !== input.transaction_id ||
            quarantined.lineage_owner_token_sha256 !== input.lineage_owner_token_sha256 ||
            !input.can_take_over_stale(quarantined)
          ) {
            if (!fs.existsSync(file)) fs.renameSync(quarantine, file);
            return {
              ok: false,
              reason_code: ownerIsLive ? 'workspace.concurrent-operation' : 'workspace.lease-stale-unrecoverable',
              lease_path: file,
            };
          }
        }
        if (!createLeaseExclusive(file, next)) {
          return { ok: false, reason_code: 'workspace.concurrent-operation', lease_path: file };
        }
        return {
          ok: true,
          lease_path: file,
          lease: next,
          took_over_stale: quarantined.released_at_ms === null,
        };
      } finally {
        try {
          fs.unlinkSync(quarantine);
        } catch {
          // The stale evidence may already have been cleaned by a recovery process.
        }
      }
    });
  } catch (error) {
    if (
      error instanceof ProjectWorkspaceError &&
      (error.reason_code === 'workspace.concurrent-operation' || error.reason_code === 'workspace.recovery-required')
    ) {
      return { ok: false, reason_code: 'workspace.concurrent-operation', lease_path: file };
    }
    throw error;
  }
}

export function heartbeatProjectLease(leasePath: string, ownerToken: string, nowMs: number, ttlMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || nowMs < 0 || ttlMs <= 0) return false;
  try {
    return withExclusiveFileLock(leaseMutationLockPath(leasePath), () =>
      replaceLeaseAtomically(leasePath, (current) => {
        if (
          current.owner_token_sha256 !== sha256(ownerToken) ||
          current.owner_pid !== process.pid ||
          current.owner_process_nonce_sha256 !== currentProcessNonceSha256() ||
          current.released_at_ms !== null ||
          nowMs < current.heartbeat_at_ms
        ) {
          return undefined;
        }
        publishProcessWitness(path.dirname(leasePath));
        const ttl = Math.max(1_000, Math.min(ttlMs, 24 * 60 * 60 * 1_000));
        return { ...current, heartbeat_at_ms: nowMs, expires_at_ms: nowMs + ttl };
      })
    );
  } catch {
    return false;
  }
}

export function releaseProjectLease(leasePath: string, ownerToken: string): boolean {
  try {
    return withExclusiveFileLock(leaseMutationLockPath(leasePath), () =>
      replaceLeaseAtomically(leasePath, (current) => {
        if (
          current.owner_token_sha256 !== sha256(ownerToken) ||
          current.owner_pid !== process.pid ||
          current.owner_process_nonce_sha256 !== currentProcessNonceSha256()
        ) {
          return undefined;
        }
        return current.released_at_ms === null
          ? { ...current, released_at_ms: Math.max(Date.now(), current.heartbeat_at_ms) }
          : current;
      })
    );
  } catch {
    return false;
  }
}

export function isProjectLeaseReleased(leasePath: string): boolean {
  try {
    const lease = validateLease(readJson(leasePath));
    return lease !== undefined && lease.released_at_ms !== null;
  } catch {
    return false;
  }
}

export function leaseOwnerTokenSha256(ownerToken: string): string {
  return sha256(ownerToken);
}
