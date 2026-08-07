/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * state.db one-way-door backup (Hermes-0.20 preparation).
 *
 * Hermes 0.20 migrates state.db 16→25 with no downgrade branch — a rollback to
 * 0.17 runs unwarned against the newer schema. Before a version-crossing
 * install, every seat's DB is copied aside once. These tests pin the whole
 * contract: per-seat sweep, recognizable origin version in the name,
 * idempotency (a second boot never overwrites the first backup), first run
 * without a DB is a no-op, sidecar WAL frames ride along, and the boot path
 * actually takes the backup BEFORE pip touches the venv (source contract).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  backupHermesStateDbsBeforeUpgrade,
  hermesStateDbBackupFileName,
  listHermesSeatHomes,
} from '@process/commandEve/hermesStateDbBackup';

const tempDirs: string[] = [];

function makeHermesRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-statedb-backup-'));
  tempDirs.push(dir);
  return dir;
}

function seedSeat(hermesRoot: string, relativeHome: string, dbBytes?: string): string {
  const home = path.join(hermesRoot, relativeHome);
  fs.mkdirSync(home, { recursive: true });
  if (dbBytes !== undefined) fs.writeFileSync(path.join(home, 'state.db'), dbBytes);
  return home;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('hermesStateDbBackupFileName', () => {
  it('carries BOTH versions readably and sanitizes hostile input', () => {
    expect(hermesStateDbBackupFileName('0.17.0', '0.20.0')).toBe('state.db.pre-0.20.0.from-0.17.0.backup');
    // The exact sanitized spelling matters less than the invariants: no path
    // separators can survive into the basename, and blank means 'unknown'.
    const hostile = hermesStateDbBackupFileName('../../evil', '0.2/0');
    expect(hostile).not.toContain('/');
    expect(hostile).not.toContain('\\');
    expect(hermesStateDbBackupFileName(undefined, '0.20.0')).toBe('state.db.pre-0.20.0.from-unknown.backup');
    expect(hermesStateDbBackupFileName('   ', '0.20.0')).toBe('state.db.pre-0.20.0.from-unknown.backup');
  });
});

describe('backupHermesStateDbsBeforeUpgrade', () => {
  it('backs up the legacy home AND every seat home, origin version in the name', () => {
    const root = makeHermesRoot();
    seedSeat(root, 'home', 'legacy-bytes');
    seedSeat(root, path.join('seats', 'seat-a', 'home'), 'seat-a-bytes');
    seedSeat(root, path.join('seats', 'seat-b', 'home'), 'seat-b-bytes');

    const results = backupHermesStateDbsBeforeUpgrade({ hermesRoot: root, fromVersion: '0.17.0', toVersion: '0.20.0' });

    expect(results.map((r) => r.status)).toEqual(['backed_up', 'backed_up', 'backed_up']);
    for (const result of results) {
      expect(path.basename(result.backupPath)).toBe('state.db.pre-0.20.0.from-0.17.0.backup');
      expect(fs.existsSync(result.backupPath)).toBe(true);
    }
    expect(fs.readFileSync(path.join(root, 'seats', 'seat-a', 'home', 'state.db.pre-0.20.0.from-0.17.0.backup'), 'utf8')).toBe('seat-a-bytes');
  });

  it('is idempotent: a second run reports already_backed_up and never overwrites the first copy', () => {
    const root = makeHermesRoot();
    const home = seedSeat(root, 'home', 'original-pre-migration-bytes');

    const first = backupHermesStateDbsBeforeUpgrade({ hermesRoot: root, fromVersion: '0.17.0', toVersion: '0.20.0' });
    expect(first[0].status).toBe('backed_up');

    // Simulate the migrated DB of a partially completed upgrade boot.
    fs.writeFileSync(path.join(home, 'state.db'), 'migrated-v25-bytes');
    const second = backupHermesStateDbsBeforeUpgrade({ hermesRoot: root, fromVersion: '0.17.0', toVersion: '0.20.0' });

    expect(second[0].status).toBe('already_backed_up');
    expect(fs.readFileSync(first[0].backupPath, 'utf8')).toBe('original-pre-migration-bytes');
  });

  it('treats a missing DB as first run (no_db), and a missing root as nothing to do', () => {
    const root = makeHermesRoot();
    seedSeat(root, 'home'); // home exists, no state.db
    const results = backupHermesStateDbsBeforeUpgrade({ hermesRoot: root, fromVersion: '0.17.0', toVersion: '0.20.0' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('no_db');
    expect(fs.readdirSync(path.join(root, 'home'))).toEqual([]);

    expect(
      backupHermesStateDbsBeforeUpgrade({
        hermesRoot: path.join(root, 'does-not-exist'),
        fromVersion: '0.17.0',
        toVersion: '0.20.0',
      })
    ).toEqual([]);
  });

  it('carries WAL/SHM sidecars under the same backup prefix', () => {
    const root = makeHermesRoot();
    const home = seedSeat(root, 'home', 'db');
    fs.writeFileSync(path.join(home, 'state.db-wal'), 'wal-frames');
    const [result] = backupHermesStateDbsBeforeUpgrade({ hermesRoot: root, fromVersion: '0.17.0', toVersion: '0.20.0' });
    expect(result.status).toBe('backed_up');
    expect(fs.readFileSync(`${result.backupPath}-wal`, 'utf8')).toBe('wal-frames');
    expect(fs.existsSync(`${result.backupPath}-shm`)).toBe(false);
  });

  it('never throws: an unreadable DB reports failed instead of breaking the boot', () => {
    const root = makeHermesRoot();
    const home = seedSeat(root, 'home');
    // A DIRECTORY named state.db makes copyFileSync fail deterministically.
    fs.mkdirSync(path.join(home, 'state.db'));
    const [result] = backupHermesStateDbsBeforeUpgrade({ hermesRoot: root, fromVersion: '0.17.0', toVersion: '0.20.0' });
    expect(result.status).toBe('failed');
    expect(result.detail).toBeTruthy();
  });
});

describe('listHermesSeatHomes', () => {
  it('finds legacy + seat homes and ignores files posing as seats', () => {
    const root = makeHermesRoot();
    seedSeat(root, 'home');
    seedSeat(root, path.join('seats', 'seat-a', 'home'));
    fs.writeFileSync(path.join(root, 'seats', 'not-a-seat'), '');
    const homes = listHermesSeatHomes(root);
    expect(homes).toEqual([path.join(root, 'home'), path.join(root, 'seats', 'seat-a', 'home')]);
  });
});

describe('boot-path wiring (source contract)', () => {
  it('takes the backup INSIDE the install branch, BEFORE pip touches the venv', () => {
    const source = fs
      .readFileSync(
        path.resolve(process.cwd(), 'packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts'),
        'utf8'
      )
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const backupCall = source.indexOf('backupHermesStateDbsBeforeUpgrade({');
    expect(backupCall, 'the boot path no longer takes the pre-migration backup').toBeGreaterThan(-1);
    const pipInstall = source.indexOf("'-m', 'pip', 'install', '--upgrade', 'pip'");
    expect(pipInstall, 'the pip install seam moved — re-anchor this contract').toBeGreaterThan(-1);
    expect(backupCall, 'the backup must run BEFORE the first pip invocation').toBeLessThan(pipInstall);
    // And it must be gated on a real version CHANGE, not a same-version repair.
    const guard = source.indexOf('hermesInstalled && Boolean(installedHermesVersion) && !hermesVersionMatches');
    expect(guard, 'the cross-version guard around the backup is gone').toBeGreaterThan(-1);
  });
});
