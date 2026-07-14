/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vault DIRECTORY resolver tests (S5 phase 1, arch §1/§2 + §11.4).
 *
 * Proves: founder dir stable + mirrors the entitlement-dir precedence; seat dir
 * follows the PROVEN seatContext sanitizer; a legacy seat maps to the founder
 * home (no `seats/` segment); an UNSANITIZABLE seatId is REJECTED (throws) so it
 * can never become a path segment; ensureVaultDir creates 0700.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureVaultDir, founderVaultDir, seatVaultDir } from '@/process/commandEve/vaultDirCore';
import { LEGACY_SEAT_ID, SEATS_SUBDIR } from '@/process/commandEve/seatContextCore';

const tmpRoots: string[] = [];
function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-vault-dir-test-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length) {
    const dir = tmpRoots.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('vaultDirCore — founderVaultDir', () => {
  it('resolves <userData>/command-eve-runtime/vault/founder (stable, absolute)', () => {
    const userData = '/tmp/some-user-data';
    const dir = founderVaultDir(userData);
    expect(dir).toBe(path.resolve(userData, 'command-eve-runtime', 'vault', 'founder'));
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it('falls back to <homeDir>/.command-eve when userDataPath is empty (injectable home)', () => {
    const dir = founderVaultDir('', '/fake/home');
    expect(dir).toBe(path.resolve('/fake/home', '.command-eve', 'command-eve-runtime', 'vault', 'founder'));
  });

  it('is deterministic (same inputs → same dir)', () => {
    expect(founderVaultDir('/a/b')).toBe(founderVaultDir('/a/b'));
  });
});

describe('vaultDirCore — seatVaultDir', () => {
  it('a real seat → <configRoot>/seats/<sanitized-id>/vault', () => {
    const configRoot = '/tmp/cfg';
    const dir = seatVaultDir(configRoot, 'client-acme');
    expect(dir).toBe(path.join(configRoot, SEATS_SUBDIR, 'client-acme', 'vault'));
  });

  it('lower-cases the seat id (fs case-fold safety, inherited from the sanitizer)', () => {
    const dir = seatVaultDir('/tmp/cfg', 'ClientACME');
    expect(dir).toBe(path.join('/tmp/cfg', SEATS_SUBDIR, 'clientacme', 'vault'));
  });

  it('a legacy/no-seat id → <configRoot>/vault (no seats/ segment)', () => {
    expect(seatVaultDir('/tmp/cfg', LEGACY_SEAT_ID)).toBe(path.join('/tmp/cfg', 'vault'));
    expect(seatVaultDir('/tmp/cfg', 'default')).toBe(path.join('/tmp/cfg', 'vault'));
    expect(seatVaultDir('/tmp/cfg', undefined)).toBe(path.join('/tmp/cfg', 'vault'));
    expect(seatVaultDir('/tmp/cfg', '')).toBe(path.join('/tmp/cfg', 'vault'));
  });

  it('REJECTS an unsanitizable seatId (path-traversal guard throws)', () => {
    expect(() => seatVaultDir('/tmp/cfg', '../escape')).toThrow();
    expect(() => seatVaultDir('/tmp/cfg', 'a/b')).toThrow();
    expect(() => seatVaultDir('/tmp/cfg', 'x\0y')).toThrow();
    expect(() => seatVaultDir('/tmp/cfg', '/abs')).toThrow();
  });

  it('seat-A dir and seat-B dir are DISJOINT (isolation is a position)', () => {
    const a = seatVaultDir('/tmp/cfg', 'seat-a');
    const b = seatVaultDir('/tmp/cfg', 'seat-b');
    expect(a).not.toBe(b);
    expect(a.startsWith(path.join('/tmp/cfg', SEATS_SUBDIR, 'seat-b'))).toBe(false);
    expect(b.startsWith(path.join('/tmp/cfg', SEATS_SUBDIR, 'seat-a'))).toBe(false);
  });
});

describe('vaultDirCore — ensureVaultDir', () => {
  it('creates the dir 0700 and is idempotent', () => {
    const root = makeTmpRoot();
    const dir = path.join(root, 'command-eve-runtime', 'vault', 'founder');
    ensureVaultDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    const mode = fs.statSync(dir).mode & 0o777;
    // On POSIX the dir is created owner-only.
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o700);
    }
    // Idempotent — a second call does not throw.
    expect(() => ensureVaultDir(dir)).not.toThrow();
  });
});
