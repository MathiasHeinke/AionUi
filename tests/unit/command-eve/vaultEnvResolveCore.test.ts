/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vault ENV RESOLVER + vetted-store reader tests (S5 phase 1, arch §5/§1/§11 +
 * §12 rows 3-4 + the isolation negative).
 *
 * Proves:
 *  - all refs present → full env map;
 *  - ONE bad ref → the WHOLE connector fails (never a partial env map);
 *  - keychain-unavailable decrypt → fail, no plaintext in output;
 *  - founder ∪ seat union is correct;
 *  - a seat-A record NEVER appears in a seat-B listing (2-seat fixture);
 *  - an unsanitizable seatId is rejected (throws) before any read.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { encryptSecret, setSafeStorageForTesting, type SafeStorageAdapter } from '@/common/config/keychain';
import { founderVaultDir, seatVaultDir } from '@/process/commandEve/vaultDirCore';
import {
  VAULT_CONNECTOR_RECORD_VERSION,
  writeVaultRecord,
  type VaultConnectorRecord,
} from '@/process/commandEve/vaultRecordCore';
import { readVettedConnectorsForSeat, resolveEnvFromVault } from '@/process/commandEve/vaultEnvResolveCore';

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
function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-vault-env-test-'));
  tmpDirs.push(dir);
  return dir;
}

function ref(secret: string): string {
  const enc = encryptSecret(secret);
  if (!enc.ok || !enc.ref) throw new Error('test setup: encryptSecret failed');
  return enc.ref;
}

function record(overrides: Partial<VaultConnectorRecord>): VaultConnectorRecord {
  // Default env_refs is a STATIC well-formed ref so `record()` never eagerly
  // calls `ref()` (which needs an available adapter). Tests that persist a
  // record via writeVaultRecord pass their own real refs; tests that only build
  // an in-memory record for resolveEnvFromVault override env_refs themselves.
  return {
    version: VAULT_CONNECTOR_RECORD_VERSION,
    connector_id: 'linear-project-management',
    scope: 'founder',
    env_refs: { LINEAR_API_KEY: 'keychain:v1:c3RhdGljLXBsYWNlaG9sZGVy' },
    vetted: true,
    human_gate_receipt: 'receipt://hg-3/abc',
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

describe('resolveEnvFromVault', () => {
  it('all refs present → full decrypted env map (in-memory only)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const rec = record({
      env_refs: { SLACK_BOT_TOKEN: ref('xoxb-FAKE'), SLACK_TEAM_ID: ref('T-FAKE') },
    });
    const res = resolveEnvFromVault(rec);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.env).toEqual({ SLACK_BOT_TOKEN: 'xoxb-FAKE', SLACK_TEAM_ID: 'T-FAKE' });
    }
  });

  it('ONE bad ref → the WHOLE resolve fails (no partial env map)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const rec = record({
      // Second ref is intentionally not a valid ciphertext for the mock adapter.
      env_refs: { GOOD: ref('good-value'), BAD: 'keychain:v1:bm90LXJlYWwtY2lwaGVydGV4dA==' },
    });
    const res = resolveEnvFromVault(rec);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.env_name).toBe('BAD');
      // No env map is exposed on failure.
      expect((res as unknown as { env?: unknown }).env).toBeUndefined();
    }
  });

  it('injectable decryptSecret is used (dep override)', () => {
    const rec = record({ env_refs: { A: 'keychain:v1:whatever', B: 'keychain:v1:whatever2' } });
    const res = resolveEnvFromVault(rec, {
      decryptSecret: (r: string) => ({ ok: true, value: `decrypted(${r.slice(-3)})` }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(Object.keys(res.env).sort()).toEqual(['A', 'B']);
  });

  it('keychain-unavailable decrypt → fail, no plaintext in output', () => {
    // No adapter set → the real decryptSecret fails closed.
    setSafeStorageForTesting(null);
    const rec = record({ env_refs: { LINEAR_API_KEY: 'keychain:v1:AAAA' } });
    const res = resolveEnvFromVault(rec);
    expect(res.ok).toBe(false);
    if (!res.ok) expect((res as unknown as { env?: unknown }).env).toBeUndefined();
  });

  it('empty env_refs → ok with an empty env map', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const res = resolveEnvFromVault(record({ env_refs: {} }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.env).toEqual({});
  });
});

describe('readVettedConnectorsForSeat — union + isolation', () => {
  it('founder ∪ seat union is correct; founder appears in the seat', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userData = makeTmpRoot();
    const configRoot = makeTmpRoot();

    // Founder-vault: a founder connector.
    writeVaultRecord(
      founderVaultDir(userData),
      record({ connector_id: 'linear-project-management', scope: 'founder' })
    );
    // Seat-vault(seat-a): a seat connector.
    writeVaultRecord(
      seatVaultDir(configRoot, 'seat-a'),
      record({ connector_id: 'client-google-drive', scope: 'seat', seat_id: 'seat-a' })
    );

    const ids = readVettedConnectorsForSeat(userData, configRoot, 'seat-a')
      .map((r) => r.connector_id)
      .sort();
    expect(ids).toEqual(['client-google-drive', 'linear-project-management']);
  });

  it('only vetted===true records are returned', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userData = makeTmpRoot();
    const configRoot = makeTmpRoot();

    writeVaultRecord(founderVaultDir(userData), record({ connector_id: 'vetted-one', vetted: true }));
    writeVaultRecord(
      founderVaultDir(userData),
      record({ connector_id: 'unvetted-one', vetted: false, human_gate_receipt: '' })
    );

    const ids = readVettedConnectorsForSeat(userData, configRoot, 'seat-a').map((r) => r.connector_id);
    expect(ids).toEqual(['vetted-one']);
  });

  it('ISOLATION NEGATIVE: a seat-A record NEVER appears in a seat-B union (2-seat fixture)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userData = makeTmpRoot();
    const configRoot = makeTmpRoot();

    // Seat A gets a client credential; Seat B gets a different one.
    writeVaultRecord(
      seatVaultDir(configRoot, 'seat-a'),
      record({ connector_id: 'client-a-drive', scope: 'seat', seat_id: 'seat-a' })
    );
    writeVaultRecord(
      seatVaultDir(configRoot, 'seat-b'),
      record({ connector_id: 'client-b-drive', scope: 'seat', seat_id: 'seat-b' })
    );

    const seatB = readVettedConnectorsForSeat(userData, configRoot, 'seat-b').map((r) => r.connector_id);
    // Seat A's connector must NOT leak into Seat B.
    expect(seatB).toContain('client-b-drive');
    expect(seatB).not.toContain('client-a-drive');

    const seatA = readVettedConnectorsForSeat(userData, configRoot, 'seat-a').map((r) => r.connector_id);
    expect(seatA).toContain('client-a-drive');
    expect(seatA).not.toContain('client-b-drive');
  });

  it('seat record overrides a founder record with the SAME connector_id (nearer scope wins)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userData = makeTmpRoot();
    const configRoot = makeTmpRoot();

    writeVaultRecord(
      founderVaultDir(userData),
      record({ connector_id: 'linear-project-management', scope: 'founder', human_gate_receipt: 'founder-receipt' })
    );
    writeVaultRecord(
      seatVaultDir(configRoot, 'seat-a'),
      record({
        connector_id: 'linear-project-management',
        scope: 'seat',
        seat_id: 'seat-a',
        human_gate_receipt: 'seat-receipt',
      })
    );

    const merged = readVettedConnectorsForSeat(userData, configRoot, 'seat-a');
    const linear = merged.filter((r) => r.connector_id === 'linear-project-management');
    expect(linear).toHaveLength(1);
    expect(linear[0].scope).toBe('seat');
    expect(linear[0].human_gate_receipt).toBe('seat-receipt');
  });

  it('an unsanitizable seatId is REJECTED (throws) before any read', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userData = makeTmpRoot();
    const configRoot = makeTmpRoot();
    expect(() => readVettedConnectorsForSeat(userData, configRoot, '../escape')).toThrow();
    expect(() => readVettedConnectorsForSeat(userData, configRoot, 'a/b')).toThrow();
  });

  it('a legacy/founder-only seat returns just the founder connectors', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userData = makeTmpRoot();
    const configRoot = makeTmpRoot();
    writeVaultRecord(founderVaultDir(userData), record({ connector_id: 'linear-project-management' }));

    const idsLegacy = readVettedConnectorsForSeat(userData, configRoot, 'seat-1').map((r) => r.connector_id);
    expect(idsLegacy).toEqual(['linear-project-management']);
  });
});
