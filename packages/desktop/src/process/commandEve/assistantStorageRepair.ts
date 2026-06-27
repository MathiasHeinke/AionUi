/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pre-flight repair for the aioncore assistant-storage bootstrap crash.
 *
 * THE BUG IT REPAIRS: the de-founder-ize re-seed (`ensureCommandEveAssistant`)
 * recreates a non-reconciling EVE assistant via DELETE + POST. The backend's
 * DELETE soft-deletes the assistant's `assistant_definitions` row (`deleted_at`
 * set) and the subsequent POST does NOT restore a LIVE definition — so the
 * `assistants` row stays ACTIVE while its only user-source definition is
 * soft-deleted. The aioncore v0.1.37 `router.assistant.bootstrap` stage CRASHES
 * on that active-assistant ↔ soft-deleted-definition inconsistency
 * (`BOOTSTRAP_SERVER_FAILED`), which the desktop surfaces as the misleading
 * "Die Command-EVE-Installation ist unvollständig … kann AionCore nicht starten"
 * dialog. The result: the app bricks on EVERY restart for affected (upgraded)
 * machines.
 *
 * THE REPAIR: run on the AT-REST conversation DB BEFORE aioncore is spawned —
 * re-activate (un-soft-delete) any user-source definition whose assistant is
 * still live, restoring the consistency the bootstrap requires. Idempotent and
 * cheap (a no-op once healed; UPDATE matches 0 rows).
 *
 * FAIL-OPEN: every failure path is swallowed and reported, NEVER thrown — a
 * repair error must not block the backend from starting (the backend may still
 * boot fine, e.g. on a fresh install with no orphan).
 */

import fs from 'fs';
import path from 'path';

export interface AssistantStorageRepairResult {
  /** Number of orphaned user-definitions re-activated. */
  repaired: number;
  /** Set when the repair was skipped or failed (DB absent, wrong schema, error). */
  skipped?: string;
}

/**
 * Heal the active-assistant ↔ soft-deleted-definition inconsistency in the
 * aioncore conversation DB at `<backendDataDir>/aionui-backend.db`. Safe to call
 * unconditionally before every backend spawn (boot + seat-switch respawn).
 */
export async function repairCommandEveAssistantStorage(
  backendDataDir: string
): Promise<AssistantStorageRepairResult> {
  try {
    if (!backendDataDir || typeof backendDataDir !== 'string') return { repaired: 0, skipped: 'no-dir' };
    const dbPath = path.join(backendDataDir, 'aionui-backend.db');
    if (!fs.existsSync(dbPath)) return { repaired: 0, skipped: 'no-db' };

    // Lazy-load the native driver inside the guard so a module-load failure is
    // caught here rather than breaking the importing module.
    const mod = (await import('better-sqlite3')) as unknown as {
      default: new (file: string, opts?: { timeout?: number }) => {
        prepare: (sql: string) => { get: () => unknown; run: () => { changes: number } };
        pragma: (p: string) => unknown;
        close: () => void;
      };
    };
    const Database = mod.default;
    const db = new Database(dbPath, { timeout: 4000 });
    try {
      // Skip on an unrelated/old schema (the two tables must both exist).
      const tables = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('assistants','assistant_definitions')"
        )
        .get() as { n: number } | undefined;
      if (!tables || tables.n < 2) return { repaired: 0, skipped: 'no-tables' };

      const info = db
        .prepare(
          "UPDATE assistant_definitions SET deleted_at = NULL " +
            "WHERE deleted_at IS NOT NULL AND source = 'user' " +
            "AND assistant_id IN (SELECT id FROM assistants)"
        )
        .run();

      // Fold any change into the main DB so aioncore opens a clean file.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // best-effort; SQLite recovers the WAL on open anyway
      }
      return { repaired: info.changes };
    } finally {
      db.close();
    }
  } catch (error) {
    return { repaired: 0, skipped: error instanceof Error ? error.message : 'error' };
  }
}
