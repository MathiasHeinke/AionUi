import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireProjectLease,
  heartbeatProjectLease,
  isProjectLeaseReleased,
  releaseProjectLease,
} from '@process/services/project-workspace/transaction/leaseStore';

function runContender(lockDirectory: string, ownerToken: string): Promise<Record<string, unknown>> {
  const modulePath = path.resolve('packages/desktop/src/process/services/project-workspace/transaction/leaseStore.ts');
  const program = `
    import { acquireProjectLease, releaseProjectLease } from ${JSON.stringify(modulePath)};
    const result = acquireProjectLease({
      lease_directory: ${JSON.stringify(lockDirectory)},
      key: 'seat-alpha|realm-alpha|/tmp/target',
      owner_token: ${JSON.stringify(ownerToken)},
      ttl_ms: 10000,
      now_ms: Date.now(),
      can_take_over_stale: () => false,
    });
    if (result.ok) {
      await Bun.sleep(750);
      releaseProjectLease(result.lease_path, ${JSON.stringify(ownerToken)});
    }
    console.log(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
    });
  });
}

describe('interprocess project lease', () => {
  it('allows exactly one committer in a separate-process race', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-lease-race-'));
    try {
      const [first, second] = await Promise.all([
        runContender(directory, 'owner-a'),
        runContender(directory, 'owner-b'),
      ]);
      expect([first, second].filter((result) => result.ok)).toHaveLength(1);
      expect([first, second].filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ reason_code: 'workspace.concurrent-operation' }),
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires the owner token, refreshes heartbeat TTL, and gates stale takeover', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-lease-ttl-'));
    try {
      const first = acquireProjectLease({
        lease_directory: directory,
        key: 'seat-alpha|realm-alpha|/tmp/target',
        owner_token: 'owner-a',
        ttl_ms: 1_000,
        now_ms: 1_000,
        can_take_over_stale: () => false,
      });
      expect(first.ok).toBe(true);
      if (first.ok === false) throw new Error(first.reason_code);
      expect(heartbeatProjectLease(first.lease_path, 'owner-a', 999, 1_000)).toBe(false);
      expect(heartbeatProjectLease(first.lease_path, 'wrong-owner', 1_500, 1_000)).toBe(false);
      expect(heartbeatProjectLease(first.lease_path, 'owner-a', 1_500, 1_000)).toBe(true);
      expect(
        acquireProjectLease({
          lease_directory: directory,
          key: 'seat-alpha|realm-alpha|/tmp/target',
          owner_token: 'owner-b',
          ttl_ms: 1_000,
          now_ms: 2_001,
          can_take_over_stale: () => true,
        })
      ).toMatchObject({ ok: false, reason_code: 'workspace.concurrent-operation' });
      expect(
        acquireProjectLease({
          lease_directory: directory,
          key: 'seat-alpha|realm-alpha|/tmp/target',
          owner_token: 'owner-b',
          ttl_ms: 1_000,
          now_ms: 2_600,
          can_take_over_stale: () => false,
        })
      ).toMatchObject({ ok: false, reason_code: 'workspace.lease-stale-unrecoverable' });
      const takeover = acquireProjectLease({
        lease_directory: directory,
        key: 'seat-alpha|realm-alpha|/tmp/target',
        owner_token: 'owner-b',
        ttl_ms: 1_000,
        now_ms: 2_600,
        can_take_over_stale: () => true,
      });
      expect(takeover).toMatchObject({ ok: true, took_over_stale: true });
      if (takeover.ok === false) throw new Error(takeover.reason_code);
      expect(releaseProjectLease(takeover.lease_path, 'owner-a')).toBe(false);
      expect(releaseProjectLease(takeover.lease_path, 'owner-b')).toBe(true);
      expect(
        acquireProjectLease({
          lease_directory: directory,
          key: 'seat-alpha|realm-alpha|/tmp/invalid',
          owner_token: 'owner-c',
          ttl_ms: Number.NaN,
          now_ms: 3_000,
          can_take_over_stale: () => false,
        })
      ).toMatchObject({ ok: false, reason_code: 'workspace.lease-invalid' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('publishes an owner-bound release tombstone so a late release cannot delete a successor lease', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-lease-release-aba-'));
    try {
      const first = acquireProjectLease({
        lease_directory: directory,
        key: 'seat-alpha|realm-alpha|/tmp/target',
        owner_token: 'owner-a',
        ttl_ms: 1_000,
        now_ms: 1_000,
        can_take_over_stale: () => false,
      });
      expect(first.ok).toBe(true);
      if (first.ok === false) throw new Error(first.reason_code);
      expect(releaseProjectLease(first.lease_path, 'owner-a')).toBe(true);
      expect(isProjectLeaseReleased(first.lease_path)).toBe(true);

      const successor = acquireProjectLease({
        lease_directory: directory,
        key: 'seat-alpha|realm-alpha|/tmp/target',
        owner_token: 'owner-b',
        ttl_ms: 1_000,
        now_ms: 1_001,
        can_take_over_stale: () => false,
      });
      expect(successor).toMatchObject({ ok: true, took_over_stale: false });
      if (successor.ok === false) throw new Error(successor.reason_code);
      expect(releaseProjectLease(successor.lease_path, 'owner-a')).toBe(false);
      expect(heartbeatProjectLease(successor.lease_path, 'owner-b', 1_002, 1_000)).toBe(true);
      expect(releaseProjectLease(successor.lease_path, 'owner-b')).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
