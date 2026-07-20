import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_LEASE_VERSION, type ProjectLeaseV1 } from '@/common/types/project-workspace/transaction';
import { ensurePrivateDirectory, readJson, syncDirectoryDurable } from '../storage/atomicJson';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function projectLeasePath(leaseDirectory: string, key: string): string {
  return path.join(leaseDirectory, `${sha256(key)}.lease.json`);
}

function validateLease(value: unknown): ProjectLeaseV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const lease = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'schema_version',
    'key_sha256',
    'owner_token_sha256',
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
    typeof lease.owner_token_sha256 !== 'string' ||
    !SHA256_PATTERN.test(lease.owner_token_sha256) ||
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
  return lease as ProjectLeaseV1;
}

function sameLease(left: ProjectLeaseV1, right: ProjectLeaseV1): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.key_sha256 === right.key_sha256 &&
    left.owner_token_sha256 === right.owner_token_sha256 &&
    left.acquired_at_ms === right.acquired_at_ms &&
    left.heartbeat_at_ms === right.heartbeat_at_ms &&
    left.expires_at_ms === right.expires_at_ms &&
    left.released_at_ms === right.released_at_ms
  );
}

function createLeaseExclusive(file: string, lease: ProjectLeaseV1): boolean {
  ensurePrivateDirectory(path.dirname(file));
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  syncDirectoryDurable(path.dirname(file));
  return true;
}

function readLeaseAfterExclusiveCreate(file: string): ProjectLeaseV1 | undefined {
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
  owner_token: string;
  ttl_ms: number;
  now_ms: number;
  can_take_over_stale: (lease: ProjectLeaseV1) => boolean;
};

export type AcquireLeaseResult =
  | { ok: true; lease_path: string; lease: ProjectLeaseV1; took_over_stale: boolean }
  | {
      ok: false;
      reason_code: 'workspace.concurrent-operation' | 'workspace.lease-invalid' | 'workspace.lease-stale-unrecoverable';
      lease_path: string;
    };

export function acquireProjectLease(input: AcquireLeaseInput): AcquireLeaseResult {
  if (!Number.isFinite(input.now_ms) || !Number.isFinite(input.ttl_ms) || input.now_ms < 0 || input.ttl_ms <= 0) {
    return {
      ok: false,
      reason_code: 'workspace.lease-invalid',
      lease_path: projectLeasePath(input.lease_directory, input.key),
    };
  }
  const ttl = Math.max(1_000, Math.min(input.ttl_ms, 24 * 60 * 60 * 1_000));
  const file = projectLeasePath(input.lease_directory, input.key);
  const next: ProjectLeaseV1 = {
    schema_version: PROJECT_LEASE_VERSION,
    key_sha256: sha256(input.key),
    owner_token_sha256: sha256(input.owner_token),
    acquired_at_ms: input.now_ms,
    heartbeat_at_ms: input.now_ms,
    expires_at_ms: input.now_ms + ttl,
    released_at_ms: null,
  };
  if (createLeaseExclusive(file, next)) {
    return { ok: true, lease_path: file, lease: next, took_over_stale: false };
  }

  const current = readLeaseAfterExclusiveCreate(file);
  if (!current || current.key_sha256 !== next.key_sha256) {
    return { ok: false, reason_code: 'workspace.lease-invalid', lease_path: file };
  }
  if (current.released_at_ms === null && current.expires_at_ms > input.now_ms) {
    return { ok: false, reason_code: 'workspace.concurrent-operation', lease_path: file };
  }
  if (current.released_at_ms === null && !input.can_take_over_stale(current)) {
    return { ok: false, reason_code: 'workspace.lease-stale-unrecoverable', lease_path: file };
  }

  const quarantine = `${file}.stale.${input.owner_token.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || process.pid}`;
  try {
    fs.renameSync(file, quarantine);
    syncDirectoryDurable(path.dirname(file));
  } catch {
    return { ok: false, reason_code: 'workspace.concurrent-operation', lease_path: file };
  }
  try {
    let quarantined: ProjectLeaseV1 | undefined;
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
    if (
      quarantined.released_at_ms === null &&
      (quarantined.expires_at_ms > input.now_ms || !input.can_take_over_stale(quarantined))
    ) {
      if (!fs.existsSync(file)) fs.renameSync(quarantine, file);
      return {
        ok: false,
        reason_code:
          quarantined.expires_at_ms > input.now_ms
            ? 'workspace.concurrent-operation'
            : 'workspace.lease-stale-unrecoverable',
        lease_path: file,
      };
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
}

export function heartbeatProjectLease(leasePath: string, ownerToken: string, nowMs: number, ttlMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || nowMs < 0 || ttlMs <= 0) return false;
  let descriptor: number;
  try {
    descriptor = fs.openSync(leasePath, fs.constants.O_RDWR);
  } catch {
    return false;
  }
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    let current: ProjectLeaseV1 | undefined;
    try {
      current = validateLease(JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown);
    } catch {
      return false;
    }
    if (
      !current ||
      current.owner_token_sha256 !== sha256(ownerToken) ||
      current.released_at_ms !== null ||
      nowMs < current.heartbeat_at_ms ||
      nowMs >= current.expires_at_ms
    )
      return false;
    const ttl = Math.max(1_000, Math.min(ttlMs, 24 * 60 * 60 * 1_000));
    const contents = `${JSON.stringify({ ...current, heartbeat_at_ms: nowMs, expires_at_ms: nowMs + ttl }, null, 2)}\n`;
    fs.ftruncateSync(descriptor, 0);
    fs.writeSync(descriptor, contents, 0, 'utf8');
    fs.fsyncSync(descriptor);
    try {
      const currentPathStat = fs.lstatSync(leasePath);
      return currentPathStat.dev === descriptorStat.dev && currentPathStat.ino === descriptorStat.ino;
    } catch {
      return false;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function releaseProjectLease(leasePath: string, ownerToken: string): boolean {
  let descriptor: number;
  try {
    descriptor = fs.openSync(leasePath, fs.constants.O_RDWR);
  } catch {
    return false;
  }
  try {
    const descriptorStat = fs.fstatSync(descriptor);
    let current: ProjectLeaseV1 | undefined;
    try {
      current = validateLease(JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown);
    } catch {
      return false;
    }
    if (!current || current.owner_token_sha256 !== sha256(ownerToken)) return false;
    if (current.released_at_ms === null) {
      const released: ProjectLeaseV1 = {
        ...current,
        released_at_ms: Math.max(Date.now(), current.heartbeat_at_ms),
      };
      const contents = `${JSON.stringify(released, null, 2)}\n`;
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, contents, 0, 'utf8');
      fs.fsyncSync(descriptor);
    }
    try {
      const currentPathStat = fs.lstatSync(leasePath);
      return currentPathStat.dev === descriptorStat.dev && currentPathStat.ino === descriptorStat.ino;
    } catch {
      return false;
    }
  } catch {
    return false;
  } finally {
    fs.closeSync(descriptor);
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
