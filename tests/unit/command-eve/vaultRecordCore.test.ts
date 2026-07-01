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
import { afterEach, describe, expect, it } from 'vitest';

import { encryptSecret, setSafeStorageForTesting, type SafeStorageAdapter } from '@/common/config/keychain';
import {
  VAULT_CONNECTOR_RECORD_VERSION,
  deleteVaultRecord,
  listVaultRecords,
  readVaultRecord,
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
  setSafeStorageForTesting(undefined);
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
