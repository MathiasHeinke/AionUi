/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vault RECORD store tests (S5 phase 1, arch §2/§11/§12 rows 1-4).
 *
 * Proves the fail-closed structural contract:
 *  - write/read roundtrip;
 *  - keychain-unavailable path never yields a ref → a record built from a
 *    non-ref env value is REFUSED on write AND NO plaintext file is written
 *    (assert file absent);
 *  - atomic 0600 (mode check);
 *  - a non-ref env value is REJECTED on write AND on read (fail-closed both ends);
 *  - vetted:true without a receipt is REJECTED on write;
 *  - wrong version / malformed → read returns null;
 *  - list skips invalid files; delete is idempotent.
 *
 * Uses the real keychain seam with a reversible MOCK adapter (SYNTHETIC secrets
 * only) so the env-ref values are genuine `keychain:v1:` refs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encryptSecret, setSafeStorageForTesting, type SafeStorageAdapter } from '@/common/config/keychain';
import {
  VAULT_CONNECTOR_RECORD_VERSION,
  __setVaultRecordFsBarrierForTests,
  __setVaultRecordNativeHelperForTests,
  deleteVaultRecord,
  listVaultRecords,
  readVaultRecordFileSnapshot,
  readVaultRecord,
  restoreVaultRecordFileSnapshot,
  validateVaultRecord,
  vaultRecordPath,
  writeVaultRecord,
  type VaultConnectorRecord,
} from '@/process/commandEve/vaultRecordCore';

/** Reversible non-cryptographic mock — mirrors keychain.test.ts. */
function makeAvailableAdapter(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc::${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString('utf8');
      if (!raw.startsWith('enc::')) throw new Error('bad ciphertext');
      return raw.slice('enc::'.length);
    },
  };
}

const tmpDirs: string[] = [];
function makeVaultDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-vault-record-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** A valid keychain ref for a synthetic secret (requires the available adapter set). */
function ref(secret: string): string {
  const enc = encryptSecret(secret);
  if (!enc.ok || !enc.ref) throw new Error('test setup: encryptSecret failed');
  return enc.ref;
}

function makeValidRecord(overrides: Partial<VaultConnectorRecord> = {}): VaultConnectorRecord {
  return {
    version: VAULT_CONNECTOR_RECORD_VERSION,
    connector_id: 'linear-project-management',
    scope: 'founder',
    env_refs: { LINEAR_API_KEY: ref('lin_api_FAKE_TESTONLY_0000') },
    vetted: true,
    human_gate_receipt: 'receipt://hg-3/approve/abc123',
    approved_at: '2026-07-02T10:00:00.000Z',
    stored_at: '2026-07-02T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  __setVaultRecordFsBarrierForTests(undefined);
  __setVaultRecordNativeHelperForTests(undefined);
  setSafeStorageForTesting(undefined);
  vi.restoreAllMocks();
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('vaultRecordCore — write/read roundtrip', () => {
  it('writes a valid record and reads it back identically', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const record = makeValidRecord();

    const w = writeVaultRecord(dir, record);
    expect(w.ok).toBe(true);
    expect(w.path).toBe(vaultRecordPath(dir, record.connector_id));
    expect(fs.existsSync(w.path!)).toBe(true);

    const read = readVaultRecord(dir, record.connector_id);
    expect(read).toEqual(record);
  });

  it('the on-disk wrapper contains ONLY keychain refs, never a plaintext secret', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const record = makeValidRecord({ env_refs: { LINEAR_API_KEY: ref('super-secret-plaintext-XYZ') } });
    writeVaultRecord(dir, record);

    const onDisk = fs.readFileSync(vaultRecordPath(dir, record.connector_id), 'utf8');
    expect(onDisk).not.toContain('super-secret-plaintext-XYZ');
    expect(onDisk).toContain('keychain:v1:');
  });

  it('a seat-scoped record round-trips with seat_id present', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const record = makeValidRecord({ scope: 'seat', seat_id: 'client-acme' });
    expect(writeVaultRecord(dir, record).ok).toBe(true);
    expect(readVaultRecord(dir, record.connector_id)).toEqual(record);
  });
});

describe('vaultRecordCore — atomic 0600', () => {
  it('writes the record file with mode 0600', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const record = makeValidRecord();
    writeVaultRecord(dir, record);

    const mode = fs.statSync(vaultRecordPath(dir, record.connector_id)).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
    // No leftover temp files (atomic rename).
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('vaultRecordCore — fail-closed: non-keychain-ref env value', () => {
  it('REJECTS a record with a plaintext env value on WRITE and writes NO file', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    // A plaintext (non-ref) env value — this is the leak the invariant forbids.
    const bad = makeValidRecord({ env_refs: { LINEAR_API_KEY: 'plaintext-not-a-ref' } });

    const w = writeVaultRecord(dir, bad);
    expect(w.ok).toBe(false);
    expect(w.reason_code).toBe('VAULT_RECORD_ENV_REF_NOT_KEYCHAIN');
    // ASSERT FILE ABSENT — no plaintext leak on disk, not even a temp file.
    expect(fs.existsSync(vaultRecordPath(dir, bad.connector_id))).toBe(false);
    expect(fs.readdirSync(dir).length).toBe(0);
  });

  it('REJECTS on READ a file hand-edited to smuggle a plaintext env value (returns null)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const record = makeValidRecord();
    writeVaultRecord(dir, record);

    // Tamper: replace the ref with a plaintext value directly on disk.
    const file = vaultRecordPath(dir, record.connector_id);
    const tampered = { ...record, env_refs: { LINEAR_API_KEY: 'plaintext-smuggled' } };
    fs.writeFileSync(file, JSON.stringify(tampered, null, 2), { mode: 0o600 });

    expect(readVaultRecord(dir, record.connector_id)).toBeNull();
  });
});

describe('vaultRecordCore — fail-closed: vetted without receipt', () => {
  it('REJECTS vetted:true with an empty human_gate_receipt on WRITE', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const bad = makeValidRecord({ vetted: true, human_gate_receipt: '' });

    const w = writeVaultRecord(dir, bad);
    expect(w.ok).toBe(false);
    expect(w.reason_code).toBe('VAULT_RECORD_VETTED_WITHOUT_RECEIPT');
    expect(fs.existsSync(vaultRecordPath(dir, bad.connector_id))).toBe(false);
  });

  it('ALLOWS vetted:false with an empty receipt (receipt only required when vetted)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const ok = makeValidRecord({ vetted: false, human_gate_receipt: '' });
    expect(writeVaultRecord(dir, ok).ok).toBe(true);
  });

  it('REJECTS vetted:true with a whitespace-only receipt', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const bad = makeValidRecord({ vetted: true, human_gate_receipt: '   ' });
    expect(writeVaultRecord(dir, bad).reason_code).toBe('VAULT_RECORD_VETTED_WITHOUT_RECEIPT');
  });
});

describe('vaultRecordCore — read validation (version / shape)', () => {
  it('returns null for a wrong-version file', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const record = makeValidRecord();
    const file = vaultRecordPath(dir, record.connector_id);
    fs.writeFileSync(file, JSON.stringify({ ...record, version: 'command-eve-vault-connector/v0' }), { mode: 0o600 });
    expect(readVaultRecord(dir, record.connector_id)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const dir = makeVaultDir();
    const file = vaultRecordPath(dir, 'x');
    fs.writeFileSync(file, '{ not json', { mode: 0o600 });
    expect(readVaultRecord(dir, 'x')).toBeNull();
  });

  it('returns null for an absent record', () => {
    const dir = makeVaultDir();
    expect(readVaultRecord(dir, 'nope')).toBeNull();
  });

  it('validateVaultRecord rejects a seat scope with no seat_id', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const bad = { ...makeValidRecord({ scope: 'seat' }) } as Record<string, unknown>;
    delete bad.seat_id;
    const v = validateVaultRecord(bad);
    expect(v.ok).toBe(false);
    expect(v.reason_code).toBe('VAULT_RECORD_SEAT_ID_REQUIRED');
  });
});

describe('vaultRecordCore — byte-exact authority rollback', () => {
  it('restores malformed prior bytes exactly instead of interpreting null as absence', () => {
    const dir = makeVaultDir();
    const file = vaultRecordPath(dir, 'tampered-connector');
    const priorBytes = Buffer.from('{ invalid prior vault bytes\n\u0000opaque-tail', 'utf8');
    fs.writeFileSync(file, priorBytes, { mode: 0o600 });

    const snapshot = readVaultRecordFileSnapshot(dir, 'tampered-connector');
    expect(snapshot).toEqual({ ok: true, snapshot: { exists: true, bytes: priorBytes } });
    expect(readVaultRecord(dir, 'tampered-connector')).toBeNull();

    fs.writeFileSync(file, '{"replacement":true}\n', { mode: 0o600 });
    expect(restoreVaultRecordFileSnapshot(dir, 'tampered-connector', snapshot.snapshot!)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(priorBytes);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('restores prior absence by removing a newly-created record', () => {
    const dir = makeVaultDir();
    const snapshot = readVaultRecordFileSnapshot(dir, 'new-connector');
    expect(snapshot).toEqual({ ok: true, snapshot: { exists: false } });
    fs.writeFileSync(vaultRecordPath(dir, 'new-connector'), '{"new":true}\n', { mode: 0o600 });

    expect(restoreVaultRecordFileSnapshot(dir, 'new-connector', snapshot.snapshot!)).toBe(true);
    expect(fs.existsSync(vaultRecordPath(dir, 'new-connector'))).toBe(false);
  });

  it('refuses a symlink snapshot before any connector mutation', () => {
    if (process.platform === 'win32') return;
    const dir = makeVaultDir();
    const foreign = path.join(dir, 'foreign');
    fs.writeFileSync(foreign, 'foreign');
    fs.symlinkSync(foreign, vaultRecordPath(dir, 'linked'));

    expect(readVaultRecordFileSnapshot(dir, 'linked')).toEqual({
      ok: false,
      reason_code: 'VAULT_RECORD_SNAPSHOT_NOT_REGULAR',
    });
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign');
  });

  it('rejects every non-canonical connector filename component before mutation', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const sentinel = path.join(dir, 'sentinel');
    fs.writeFileSync(sentinel, 'unchanged', { mode: 0o600 });
    const unsafeIds = [
      '../../escape',
      'folder/name',
      'folder\\name',
      '.',
      '..',
      '%2e%2e%2fescape',
      'NOTION_TOKEN',
      'notion workspace',
      'notion\u0000workspace',
      'notio\u0301n',
      'noti\u00f3n',
    ];

    for (const connectorId of unsafeIds) {
      expect(validateVaultRecord(makeValidRecord({ connector_id: connectorId }))).toMatchObject({
        ok: false,
        reason_code: 'VAULT_RECORD_CONNECTOR_ID_INVALID',
      });
      expect(writeVaultRecord(dir, makeValidRecord({ connector_id: connectorId }))).toMatchObject({
        ok: false,
        reason_code: 'VAULT_RECORD_CONNECTOR_ID_INVALID',
      });
      expect(readVaultRecordFileSnapshot(dir, connectorId)).toMatchObject({
        ok: false,
        reason_code: 'VAULT_RECORD_CONNECTOR_ID_INVALID',
      });
      expect(deleteVaultRecord(dir, connectorId)).toBe(false);
      expect(() => vaultRecordPath(dir, connectorId)).toThrow('VAULT_RECORD_CONNECTOR_ID_INVALID');
    }

    expect(fs.readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(fs.readdirSync(dir)).toEqual(['sentinel']);
  });

  it('canonicalizes a legitimate external alias above the app-owned vault', () => {
    if (process.platform === 'win32') return;
    setSafeStorageForTesting(makeAvailableAdapter());
    const root = makeVaultDir();
    const owned = path.join(root, 'owned');
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(owned, { mode: 0o700 });
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.symlinkSync(foreign, path.join(owned, 'linked'));
    const aliasedVault = path.join(owned, 'linked', 'vault');
    const record = makeValidRecord({ connector_id: 'notion-workspace' });

    expect(writeVaultRecord(aliasedVault, record)).toMatchObject({ ok: true });
    expect(readVaultRecord(aliasedVault, record.connector_id)).toEqual(record);
    expect(vaultRecordPath(aliasedVault, record.connector_id)).toBe(
      path.join(fs.realpathSync.native(foreign), 'vault', `${record.connector_id}.enc`)
    );
  });

  it('rejects a symlink at the app-owned vault boundary', () => {
    if (process.platform === 'win32') return;
    setSafeStorageForTesting(makeAvailableAdapter());
    const root = makeVaultDir();
    const parent = path.join(root, 'parent');
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(parent, { mode: 0o700 });
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.symlinkSync(foreign, path.join(parent, 'vault'));
    const record = makeValidRecord({ connector_id: 'notion-workspace' });

    expect(writeVaultRecord(path.join(parent, 'vault'), record)).toMatchObject({
      ok: false,
      reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE',
    });
    expect(fs.readdirSync(foreign)).toEqual([]);
  });

  it('refuses symlink endpoints for read, write, restore and delete without touching their target', () => {
    if (process.platform === 'win32') return;
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const foreign = path.join(dir, 'foreign');
    const endpoint = vaultRecordPath(dir, 'linked');
    fs.writeFileSync(foreign, 'foreign-bytes', { mode: 0o600 });
    fs.symlinkSync(foreign, endpoint);

    expect(readVaultRecord(dir, 'linked')).toBeNull();
    expect(writeVaultRecord(dir, makeValidRecord({ connector_id: 'linked' }))).toMatchObject({
      ok: false,
      reason_code: 'VAULT_RECORD_WRITE_FAILED',
    });
    expect(restoreVaultRecordFileSnapshot(dir, 'linked', { exists: true, bytes: Buffer.from('prior') })).toBe(false);
    expect(deleteVaultRecord(dir, 'linked')).toBe(false);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign-bytes');
    expect(fs.lstatSync(endpoint).isSymbolicLink()).toBe(true);
  });

  describe('anchored directory identity', () => {
    function swapVaultAtBarrier(vaultDir: string, operation: Parameters<typeof __setVaultRecordFsBarrierForTests>[0]) {
      let swapped = false;
      __setVaultRecordFsBarrierForTests((actualOperation, canonicalVaultDir) => {
        if (swapped || !operation) return;
        operation(actualOperation, canonicalVaultDir);
        swapped = true;
        const parked = `${vaultDir}-parked`;
        fs.renameSync(vaultDir, parked);
        fs.mkdirSync(vaultDir, { mode: 0o700 });
        fs.writeFileSync(path.join(vaultDir, 'foreign-sentinel'), 'foreign-unchanged', { mode: 0o600 });
      });
    }

    function makeAnchoredVault(): { root: string; vault: string } {
      const root = makeVaultDir();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(vault, { mode: 0o700 });
      return { root, vault };
    }

    it('rejects a read when the vault directory is swapped after its fd is opened', () => {
      setSafeStorageForTesting(makeAvailableAdapter());
      const { vault } = makeAnchoredVault();
      const record = makeValidRecord({ connector_id: 'read-race' });
      expect(writeVaultRecord(vault, record).ok).toBe(true);
      swapVaultAtBarrier(vault, (operation) => expect(operation).toBe('read'));

      expect(readVaultRecord(vault, record.connector_id)).toBeNull();
      expect(fs.readFileSync(path.join(vault, 'foreign-sentinel'), 'utf8')).toBe('foreign-unchanged');
    });

    it('rejects a snapshot when the vault directory is swapped after its fd is opened', () => {
      setSafeStorageForTesting(makeAvailableAdapter());
      const { vault } = makeAnchoredVault();
      const record = makeValidRecord({ connector_id: 'snapshot-race' });
      expect(writeVaultRecord(vault, record).ok).toBe(true);
      swapVaultAtBarrier(vault, (operation) => expect(operation).toBe('snapshot'));

      expect(readVaultRecordFileSnapshot(vault, record.connector_id)).toMatchObject({
        ok: false,
        reason_code: 'VAULT_RECORD_SNAPSHOT_READ_FAILED',
      });
      expect(fs.readFileSync(path.join(vault, 'foreign-sentinel'), 'utf8')).toBe('foreign-unchanged');
    });

    it('rejects a write before any byte reaches a swapped vault directory', () => {
      setSafeStorageForTesting(makeAvailableAdapter());
      const { vault } = makeAnchoredVault();
      const record = makeValidRecord({ connector_id: 'write-race' });
      swapVaultAtBarrier(vault, (operation) => expect(operation).toBe('write'));

      expect(writeVaultRecord(vault, record)).toMatchObject({ ok: false, reason_code: 'VAULT_RECORD_WRITE_FAILED' });
      expect(fs.readdirSync(vault)).toEqual(['foreign-sentinel']);
    });

    it('rejects a restore before any byte reaches a swapped vault directory', () => {
      const { vault } = makeAnchoredVault();
      swapVaultAtBarrier(vault, (operation) => expect(operation).toBe('restore'));

      expect(
        restoreVaultRecordFileSnapshot(vault, 'restore-race', {
          exists: true,
          bytes: Buffer.from('prior-authority'),
        })
      ).toBe(false);
      expect(fs.readdirSync(vault)).toEqual(['foreign-sentinel']);
    });

    it('rejects a delete and preserves both the original and swapped vault bytes', () => {
      setSafeStorageForTesting(makeAvailableAdapter());
      const { vault } = makeAnchoredVault();
      const record = makeValidRecord({ connector_id: 'delete-race' });
      expect(writeVaultRecord(vault, record).ok).toBe(true);
      swapVaultAtBarrier(vault, (operation) => expect(operation).toBe('delete'));

      expect(deleteVaultRecord(vault, record.connector_id)).toBe(false);
      expect(fs.existsSync(path.join(`${vault}-parked`, `${record.connector_id}.enc`))).toBe(true);
      expect(fs.readFileSync(path.join(vault, 'foreign-sentinel'), 'utf8')).toBe('foreign-unchanged');
    });

    it('rejects an unsafe vault mode before mutation', () => {
      setSafeStorageForTesting(makeAvailableAdapter());
      const { vault } = makeAnchoredVault();
      fs.chmodSync(vault, 0o755);

      expect(writeVaultRecord(vault, makeValidRecord({ connector_id: 'mode-unsafe' }))).toMatchObject({
        ok: false,
        reason_code: 'VAULT_DIR_IDENTITY_UNSAFE',
      });
      expect(fs.readdirSync(vault)).toEqual([]);
    });

    it('rejects a vault whose owner does not match the effective user', () => {
      if (process.platform === 'win32' || !process.getuid) return;
      setSafeStorageForTesting(makeAvailableAdapter());
      const { vault } = makeAnchoredVault();
      vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);

      expect(writeVaultRecord(vault, makeValidRecord({ connector_id: 'owner-unsafe' }))).toMatchObject({
        ok: false,
        reason_code: 'VAULT_DIR_IDENTITY_UNSAFE',
      });
      expect(fs.readdirSync(vault)).toEqual([]);
    });
  });

  describe('native dir-fd helper', () => {
    const installedCommandEvePython = '/Applications/Command EVE.app/Contents/Resources/python/bin/python3.12';
    const python = fs.existsSync(installedCommandEvePython) ? installedCommandEvePython : '/usr/bin/python3';

    function useNativeHelper(swapAwayThenBack?: 'snapshot' | 'read' | 'write' | 'restore' | 'delete'): void {
      if (!fs.existsSync(python)) return;
      __setVaultRecordNativeHelperForTests({ pythonExecutable: python, swapAwayThenBack });
    }

    function foreignVault(root: string): string {
      const entry = fs.readdirSync(root).find((candidate) => candidate.startsWith('vault.foreign-'));
      if (!entry) throw new Error('test setup: native helper did not retain the swapped foreign directory');
      return path.join(root, entry);
    }

    it('round-trips through real openat/renameat operations', () => {
      if (!fs.existsSync(python)) return;
      setSafeStorageForTesting(makeAvailableAdapter());
      const { vault } = (() => {
        const root = makeVaultDir();
        const candidate = path.join(root, 'vault');
        fs.mkdirSync(candidate, { mode: 0o700 });
        return { vault: candidate };
      })();
      useNativeHelper();
      const record = makeValidRecord({ connector_id: 'native-roundtrip' });

      expect(writeVaultRecord(vault, record)).toMatchObject({ ok: true });
      expect(readVaultRecord(vault, record.connector_id)).toEqual(record);
      expect(listVaultRecords(vault)).toEqual([record]);
      expect(deleteVaultRecord(vault, record.connector_id)).toBe(true);
      expect(readVaultRecord(vault, record.connector_id)).toBeNull();
    });

    it('binds a read to the opened directory across swap-away and swap-back', () => {
      if (!fs.existsSync(python)) return;
      setSafeStorageForTesting(makeAvailableAdapter());
      const root = makeVaultDir();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(vault, { mode: 0o700 });
      useNativeHelper();
      const record = makeValidRecord({ connector_id: 'native-read-race' });
      expect(writeVaultRecord(vault, record).ok).toBe(true);
      useNativeHelper('read');

      expect(readVaultRecord(vault, record.connector_id)).toEqual(record);
      expect(fs.readFileSync(path.join(foreignVault(root), `${record.connector_id}.enc`), 'utf8')).toBe(
        'foreign-unchanged'
      );
    });

    it('binds a snapshot to the opened directory across swap-away and swap-back', () => {
      if (!fs.existsSync(python)) return;
      setSafeStorageForTesting(makeAvailableAdapter());
      const root = makeVaultDir();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(vault, { mode: 0o700 });
      useNativeHelper();
      const record = makeValidRecord({ connector_id: 'native-snapshot-race' });
      expect(writeVaultRecord(vault, record).ok).toBe(true);
      const expected = fs.readFileSync(vaultRecordPath(vault, record.connector_id));
      useNativeHelper('snapshot');

      expect(readVaultRecordFileSnapshot(vault, record.connector_id)).toEqual({
        ok: true,
        snapshot: { exists: true, bytes: expected },
      });
      expect(fs.readFileSync(path.join(foreignVault(root), `${record.connector_id}.enc`), 'utf8')).toBe(
        'foreign-unchanged'
      );
    });

    it('publishes writes only inside the opened directory across swap-away and swap-back', () => {
      if (!fs.existsSync(python)) return;
      setSafeStorageForTesting(makeAvailableAdapter());
      const root = makeVaultDir();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(vault, { mode: 0o700 });
      const record = makeValidRecord({ connector_id: 'native-write-race' });
      useNativeHelper('write');

      expect(writeVaultRecord(vault, record)).toMatchObject({ ok: true });
      useNativeHelper();
      expect(readVaultRecord(vault, record.connector_id)).toEqual(record);
      expect(fs.readFileSync(path.join(foreignVault(root), `${record.connector_id}.enc`), 'utf8')).toBe(
        'foreign-unchanged'
      );
    });

    it('restores only inside the opened directory across swap-away and swap-back', () => {
      if (!fs.existsSync(python)) return;
      const root = makeVaultDir();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(vault, { mode: 0o700 });
      useNativeHelper('restore');
      const bytes = Buffer.from('prior-authority-bytes');

      expect(restoreVaultRecordFileSnapshot(vault, 'native-restore-race', { exists: true, bytes })).toBe(true);
      expect(fs.readFileSync(vaultRecordPath(vault, 'native-restore-race'))).toEqual(bytes);
      expect(fs.readFileSync(path.join(foreignVault(root), 'native-restore-race.enc'), 'utf8')).toBe(
        'foreign-unchanged'
      );
    });

    it('deletes only inside the opened directory across swap-away and swap-back', () => {
      if (!fs.existsSync(python)) return;
      setSafeStorageForTesting(makeAvailableAdapter());
      const root = makeVaultDir();
      const vault = path.join(root, 'vault');
      fs.mkdirSync(vault, { mode: 0o700 });
      useNativeHelper();
      const record = makeValidRecord({ connector_id: 'native-delete-race' });
      expect(writeVaultRecord(vault, record).ok).toBe(true);
      useNativeHelper('delete');

      expect(deleteVaultRecord(vault, record.connector_id)).toBe(true);
      expect(fs.existsSync(vaultRecordPath(vault, record.connector_id))).toBe(false);
      expect(fs.readFileSync(path.join(foreignVault(root), `${record.connector_id}.enc`), 'utf8')).toBe(
        'foreign-unchanged'
      );
    });
  });
});

describe('vaultRecordCore — list / delete', () => {
  it('lists only valid records and skips invalid / non-.enc files', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    writeVaultRecord(dir, makeValidRecord({ connector_id: 'linear-project-management' }));
    writeVaultRecord(dir, makeValidRecord({ connector_id: 'notion-workspace' }));
    // A stray non-record file and a tampered .enc file are both ignored.
    fs.writeFileSync(path.join(dir, 'README.txt'), 'not a record');
    fs.writeFileSync(path.join(dir, 'broken.enc'), '{ not json', { mode: 0o600 });

    const ids = listVaultRecords(dir)
      .map((r) => r.connector_id)
      .sort();
    expect(ids).toEqual(['linear-project-management', 'notion-workspace']);
  });

  it('returns [] for a non-existent dir', () => {
    expect(listVaultRecords(path.join(os.tmpdir(), 'command-eve-vault-does-not-exist-xyz'))).toEqual([]);
  });

  it('delete removes the record and is idempotent', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const dir = makeVaultDir();
    const record = makeValidRecord();
    writeVaultRecord(dir, record);
    expect(readVaultRecord(dir, record.connector_id)).not.toBeNull();

    deleteVaultRecord(dir, record.connector_id);
    expect(readVaultRecord(dir, record.connector_id)).toBeNull();
    // Idempotent — deleting again never throws.
    expect(() => deleteVaultRecord(dir, record.connector_id)).not.toThrow();
  });
});
