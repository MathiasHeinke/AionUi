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

const TRANSACTION_A = '11111111-1111-4111-8111-111111111111';
const TRANSACTION_B = '22222222-2222-4222-8222-222222222222';
const LINEAGE_A = 'a'.repeat(64);
const LINEAGE_B = 'b'.repeat(64);

function runContender(lockDirectory: string, ownerToken: string): Promise<Record<string, unknown>> {
  const modulePath = path.resolve('packages/desktop/src/process/services/project-workspace/transaction/leaseStore.ts');
  const program = `
    import { acquireProjectLease, releaseProjectLease } from ${JSON.stringify(modulePath)};
    const result = acquireProjectLease({
      lease_directory: ${JSON.stringify(lockDirectory)},
      key: 'seat-alpha|realm-alpha|/tmp/target',
      transaction_id: ${JSON.stringify(TRANSACTION_A)},
      lineage_owner_token_sha256: ${JSON.stringify(LINEAGE_A)},
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
        transaction_id: TRANSACTION_A,
        lineage_owner_token_sha256: LINEAGE_A,
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
          transaction_id: TRANSACTION_A,
          lineage_owner_token_sha256: LINEAGE_A,
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
          transaction_id: TRANSACTION_A,
          lineage_owner_token_sha256: LINEAGE_A,
          owner_token: 'owner-b',
          ttl_ms: 1_000,
          now_ms: 2_600,
          can_take_over_stale: () => false,
        })
      ).toMatchObject({ ok: false, reason_code: 'workspace.concurrent-operation' });
      expect(
        acquireProjectLease({
          lease_directory: directory,
          key: 'seat-alpha|realm-alpha|/tmp/target',
          transaction_id: TRANSACTION_A,
          lineage_owner_token_sha256: LINEAGE_A,
          owner_token: 'owner-b',
          ttl_ms: 1_000,
          now_ms: 2_600,
          can_take_over_stale: () => true,
        })
      ).toMatchObject({ ok: false, reason_code: 'workspace.concurrent-operation' });

      const staleLease = JSON.parse(fs.readFileSync(first.lease_path, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(
        first.lease_path,
        `${JSON.stringify({ ...staleLease, owner_process_nonce_sha256: 'f'.repeat(64) }, null, 2)}\n`
      );
      const takeover = acquireProjectLease({
        lease_directory: directory,
        key: 'seat-alpha|realm-alpha|/tmp/target',
        transaction_id: TRANSACTION_A,
        lineage_owner_token_sha256: LINEAGE_A,
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
          transaction_id: TRANSACTION_A,
          lineage_owner_token_sha256: LINEAGE_A,
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
        transaction_id: TRANSACTION_A,
        lineage_owner_token_sha256: LINEAGE_A,
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
        transaction_id: TRANSACTION_B,
        lineage_owner_token_sha256: LINEAGE_B,
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

  it('never exposes a partial lease when create-only publication fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-lease-create-crash-'));
    const originalLink = fs.linkSync;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((existingPath, newPath) => {
      if (String(newPath).endsWith('.lease.json')) {
        const error = new Error('simulated crash before create publication') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return originalLink(existingPath, newPath);
    });
    try {
      expect(() =>
        acquireProjectLease({
          lease_directory: directory,
          key: 'seat-alpha|realm-alpha|/tmp/create-crash',
          transaction_id: TRANSACTION_A,
          lineage_owner_token_sha256: LINEAGE_A,
          owner_token: 'owner-a',
          ttl_ms: 1_000,
          now_ms: 1_000,
          can_take_over_stale: () => false,
        })
      ).toThrow('simulated crash before create publication');
      expect(fs.readdirSync(directory).filter((name) => name.endsWith('.lease.json'))).toEqual([]);
    } finally {
      linkSpy.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['heartbeat', 'release'] as const)(
    'keeps the complete old lease visible when atomic %s publication fails',
    (operation) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `eve-project-lease-${operation}-crash-`));
      try {
        const acquired = acquireProjectLease({
          lease_directory: directory,
          key: `seat-alpha|realm-alpha|/tmp/${operation}-crash`,
          transaction_id: TRANSACTION_A,
          lineage_owner_token_sha256: LINEAGE_A,
          owner_token: 'owner-a',
          ttl_ms: 1_000,
          now_ms: 1_000,
          can_take_over_stale: () => false,
        });
        if (acquired.ok === false) throw new Error(acquired.reason_code);
        const before = fs.readFileSync(acquired.lease_path, 'utf8');
        const originalRename = fs.renameSync;
        const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
          if (String(newPath) === acquired.lease_path) {
            const error = new Error(`simulated crash before ${operation} publication`) as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
          return originalRename(oldPath, newPath);
        });
        try {
          const result =
            operation === 'heartbeat'
              ? heartbeatProjectLease(acquired.lease_path, 'owner-a', 1_500, 1_000)
              : releaseProjectLease(acquired.lease_path, 'owner-a');
          expect(result).toBe(false);
        } finally {
          renameSpy.mockRestore();
        }
        expect(fs.readFileSync(acquired.lease_path, 'utf8')).toBe(before);
        expect(() => JSON.parse(before)).not.toThrow();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
