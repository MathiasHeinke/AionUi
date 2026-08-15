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
  const homes: string[] = [];
  const legacyHome = path.join(hermesRoot, 'home');
  if (isDirectory(legacyHome)) homes.push(legacyHome);
  const seatsDir = path.join(hermesRoot, 'seats');
  if (isDirectory(seatsDir)) {
    const entries = fs.readdirSync(seatsDir);
    for (const entry of entries.toSorted()) {
      const seatHome = path.join(seatsDir, entry, 'home');
      if (isDirectory(seatHome)) homes.push(seatHome);
    }
  }
  return homes;
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Temp-then-rename so a torn copy can never pose as a finished backup. */
function copyFileAtomic(source: string, target: string): void {
  const temp = `${target}.tmp`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, target);
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
    if (!fs.existsSync(dbPath)) {
      results.push({ seatHome, dbPath, backupPath, status: 'no_db' });
      continue;
    }
    if (fs.existsSync(backupPath)) {
      results.push({ seatHome, dbPath, backupPath, status: 'already_backed_up' });
      continue;
    }
    try {
      // Sidecars FIRST, main DB LAST: the main backup's existence is the
      // idempotency marker, so it must only appear once everything is copied.
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (fs.existsSync(sidecar)) copyFileAtomic(sidecar, `${backupPath}${suffix}`);
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
