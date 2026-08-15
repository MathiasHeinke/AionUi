/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-way-door insurance for the Hermes `state.db` (Hermes-0.20 preparation).
 *
 * Hermes 0.20 migrates the per-seat `state.db` from schema 16 to 25. The
 * migration chain is clean — but `hermes_state_schema.py` has NO
 * `current_version > SCHEMA_VERSION` branch, so a rollback to an older Hermes
 * runs unwarned against the newer schema: the migration is effectively
 * one-way. This module is the app-side door guard: BEFORE a bundled Hermes
 * version that differs from the installed one is allowed to touch the venv,
 * every seat's `state.db` is copied aside once.
 *
 * Contract (each clause is load-bearing and unit-tested):
 *   - PER SEAT: the legacy home (`<hermesRoot>/home`) and every
 *     `<hermesRoot>/seats/<id>/home` are swept — `state.db` lives in
 *     HERMES_HOME (`DEFAULT_DB_PATH = get_hermes_home() / "state.db"`).
 *   - RECOGNIZABLE ORIGIN: the backup name carries BOTH versions
 *     (`state.db.pre-<to>.from-<from>.backup`), so a later rescue knows which
 *     Hermes wrote the bytes without opening the file.
 *   - IDEMPOTENT: an existing backup for the same transition is NEVER
 *     overwritten — the first pre-migration copy is the valuable one; a second
 *     boot after a partial migration must not clobber it.
 *   - FIRST RUN IS NOT AN ERROR: a seat without a `state.db` reports `no_db`.
 *   - BACKUP API NEVER THROWS: a failed copy or seat enumeration is reported
 *     as `failed`, so the caller can block the one-way version crossing.
 *     Copies go through a temp file + rename so a torn write can never
 *     masquerade as a complete backup.
 *   - WAL/SHM SIDECARS ride along: at bootstrap time no agent is running, but
 *     an unclean previous shutdown can leave `state.db-wal` frames that are
 *     part of the logical DB. They are copied under the same backup prefix.
 */

import fs from 'node:fs';
import path from 'node:path';

export type HermesStateDbBackupStatus = 'backed_up' | 'already_backed_up' | 'no_db' | 'failed';

export interface HermesStateDbBackupResult {
  seatHome: string;
  dbPath: string;
  backupPath: string;
  status: HermesStateDbBackupStatus;
  detail?: string;
}

/** Filename-safe version segment; an absent/blank version reads as 'unknown'. */
function sanitizeVersionForFilename(version: string | undefined): string {
  const cleaned = (version || '').trim().replace(/[^0-9A-Za-z._-]+/g, '-');
  return cleaned || 'unknown';
}

/** `state.db.pre-<to>.from-<from>.backup` — both versions readable at a glance. */
export function hermesStateDbBackupFileName(fromVersion: string | undefined, toVersion: string | undefined): string {
  return `state.db.pre-${sanitizeVersionForFilename(toVersion)}.from-${sanitizeVersionForFilename(fromVersion)}.backup`;
}

/**
 * Every HERMES_HOME under this root: the legacy/no-seat home plus each real
 * seat's home. Only existing directories are returned; a missing root yields [].
 */
export function listHermesSeatHomes(hermesRoot: string): string[] {
  const rootStat = lstatIfPresent(hermesRoot);
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Hermes root is not a real directory');
  }
  const realRoot = fs.realpathSync(hermesRoot);
  const homes: string[] = [];
  const legacyHome = path.join(hermesRoot, 'home');
  const legacyStat = lstatIfPresent(legacyHome);
  if (legacyStat) {
    if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) {
      throw new Error('Hermes legacy home is not a real directory');
    }
    assertContainedRealDirectory(realRoot, legacyHome, 'Hermes legacy home');
    homes.push(legacyHome);
  }
  const seatsDir = path.join(hermesRoot, 'seats');
  const seatsStat = lstatIfPresent(seatsDir);
  if (seatsStat) {
    if (!seatsStat.isDirectory() || seatsStat.isSymbolicLink()) {
      throw new Error('Hermes seats directory is not a real directory');
    }
    assertContainedRealDirectory(realRoot, seatsDir, 'Hermes seats directory');
    const entries = fs.readdirSync(seatsDir);
    for (const entry of entries.toSorted()) {
      const seatRoot = path.join(seatsDir, entry);
      const seatStat = lstatIfPresent(seatRoot);
      if (!seatStat) throw new Error(`Hermes seat disappeared during enumeration: ${entry}`);
      if (seatStat.isSymbolicLink()) throw new Error(`Hermes seat is a symlink: ${entry}`);
      if (!seatStat.isDirectory()) continue;
      assertContainedRealDirectory(realRoot, seatRoot, `Hermes seat ${entry}`);
      const seatHome = path.join(seatRoot, 'home');
      const homeStat = lstatIfPresent(seatHome);
      if (!homeStat) continue;
      if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
        throw new Error(`Hermes seat home is not a real directory: ${entry}`);
      }
      assertContainedRealDirectory(realRoot, seatHome, `Hermes seat home ${entry}`);
      homes.push(seatHome);
    }
  }
  return homes;
}

function lstatIfPresent(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertContainedPath(realRoot: string, candidate: string, label: string): void {
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the managed Hermes root`);
  }
}

function assertContainedRealDirectory(realRoot: string, candidate: string, label: string): void {
  assertContainedPath(realRoot, fs.realpathSync(candidate), label);
}

/** Temp-then-rename so a torn copy can never pose as a finished backup. */
function copyFileAtomic(source: string, target: string): void {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  let failure: unknown;
  let published = false;
  try {
    fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
    // linkSync publishes the complete temp inode without ever replacing an
    // already-existing backup. The first pre-migration bytes always win.
    fs.linkSync(temp, target);
    published = true;
  } catch (error) {
    failure = error;
  }
  try {
    fs.unlinkSync(temp);
  } catch (error) {
    // A published hardlink is the complete backup. Temp cleanup failure is a
    // hygiene issue, not evidence that the protected bytes are missing.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' && failure === undefined && !published) failure = error;
  }
  if (failure !== undefined) throw failure;
}

/**
 * Back up every seat's `state.db` once for the `fromVersion` → `toVersion`
 * transition. See the module contract above; this function never throws.
 */
export function backupHermesStateDbsBeforeUpgrade(options: {
  hermesRoot: string;
  fromVersion: string | undefined;
  toVersion: string | undefined;
}): HermesStateDbBackupResult[] {
  const results: HermesStateDbBackupResult[] = [];
  const backupName = hermesStateDbBackupFileName(options.fromVersion, options.toVersion);
  let seatHomes: string[];
  try {
    seatHomes = listHermesSeatHomes(options.hermesRoot);
  } catch (error) {
    const seatHome = path.join(options.hermesRoot, 'seats');
    return [
      {
        seatHome,
        dbPath: path.join(seatHome, '<unreadable>', 'home', 'state.db'),
        backupPath: path.join(seatHome, '<unreadable>', 'home', backupName),
        status: 'failed',
        detail: `Could not enumerate Hermes seat homes: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  for (const seatHome of seatHomes) {
    const dbPath = path.join(seatHome, 'state.db');
    const backupPath = path.join(seatHome, backupName);
    try {
      const realRoot = fs.realpathSync(options.hermesRoot);
      const realSeatHome = fs.realpathSync(seatHome);
      assertContainedPath(realRoot, realSeatHome, 'Hermes seat home');
      assertContainedPath(realRoot, path.join(realSeatHome, backupName), 'Hermes backup target');
      const dbStat = lstatIfPresent(dbPath);
      if (!dbStat) {
        results.push({ seatHome, dbPath, backupPath, status: 'no_db' });
        continue;
      }
      if (!dbStat.isFile() || dbStat.isSymbolicLink()) {
        throw new Error('Hermes state database is not a real regular file');
      }
      const backupStat = lstatIfPresent(backupPath);
      if (backupStat) {
        if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
          throw new Error('Hermes state database backup target is unsafe');
        }
        results.push({ seatHome, dbPath, backupPath, status: 'already_backed_up' });
        continue;
      }
      // Sidecars FIRST, main DB LAST: the main backup's existence is the
      // idempotency marker, so it must only appear once everything is copied.
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        const sidecarStat = lstatIfPresent(sidecar);
        if (!sidecarStat) continue;
        if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink()) {
          throw new Error(`Hermes state database sidecar is unsafe: ${path.basename(sidecar)}`);
        }
        const sidecarBackup = `${backupPath}${suffix}`;
        assertContainedPath(
          realRoot,
          path.join(realSeatHome, `${backupName}${suffix}`),
          'Hermes sidecar backup target'
        );
        const sidecarBackupStat = lstatIfPresent(sidecarBackup);
        if (!sidecarBackupStat) copyFileAtomic(sidecar, sidecarBackup);
        else if (!sidecarBackupStat.isFile() || sidecarBackupStat.isSymbolicLink()) {
          throw new Error(`Hermes state database sidecar backup is unsafe: ${path.basename(sidecarBackup)}`);
        }
      }
      copyFileAtomic(dbPath, backupPath);
      results.push({ seatHome, dbPath, backupPath, status: 'backed_up' });
    } catch (error) {
      results.push({
        seatHome,
        dbPath,
        backupPath,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
