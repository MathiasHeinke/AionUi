/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pre-flight repair for the aioncore assistant-storage bootstrap crash AND the
 * EVE-bound-to-aionrs "kein Modell ausgewählt" freeze.
 *
 * BUG 1 (orphan brick): the de-founder-ize re-seed (`ensureCommandEveAssistant`)
 * recreates a non-reconciling EVE assistant via DELETE + POST. The backend's
 * DELETE soft-deletes the assistant's `assistant_definitions` row (`deleted_at`
 * set) and the subsequent POST does NOT restore a LIVE definition — so the
 * `assistants` row stays ACTIVE while its only user-source definition is
 * soft-deleted. The aioncore v0.1.37 `router.assistant.bootstrap` stage CRASHES
 * on that active-assistant ↔ soft-deleted-definition inconsistency
 * (`BOOTSTRAP_SERVER_FAILED`), surfaced as the misleading "Die Command-EVE-
 * Installation ist unvollständig … kann AionCore nicht starten" dialog. The app
 * bricks on EVERY restart for affected (upgraded) machines.
 *
 * BUG 2 (aionrs freeze): the same re-seed selected the EVE preset agent from the
 * agents online AT seed time. When hermes/Ollama had not finished booting, the
 * selector fell through to the native `aionrs` ("Aion CLI") agent and bound the
 * EVE `assistant_definitions.agent_id` there; 1.2.7's no-destructive-re-seed then
 * FROZE that binding. EVE has no model wiring on aionrs, so new EVE conversations
 * open on the aionrs platform with "Für die aktuelle Sitzung ist kein Modell
 * ausgewählt …" and cannot send (and the acp-lane chat UI never applies). The
 * seed-time selector is fixed in assistantBootstrapCore (never picks aionrs), but
 * already-frozen installs still carry the bad agent_id — this repair re-binds it.
 *
 * THE REPAIR: run on the AT-REST conversation DB BEFORE aioncore is spawned —
 *   (1) re-activate (un-soft-delete) any user-source definition whose assistant
 *       is still live (heals BUG 1);
 *   (2) re-bind the EVE assistant's definition from an aionrs agent back to the
 *       hermes agent when one exists (heals BUG 2).
 * Both are idempotent and cheap (no-ops once healed; UPDATE matches 0 rows).
 *
 * FAIL-OPEN: every failure path is swallowed and reported, NEVER thrown — a
 * repair error must not block the backend from starting (the backend may still
 * boot fine, e.g. on a fresh install with no orphan).
 */

import fs from 'fs';
import path from 'path';
import { COMMAND_EVE_ASSISTANT_ID } from '../../common/config/commandEveShell';

export interface AssistantStorageRepairResult {
  /** Number of orphaned user-definitions re-activated (BUG 1). */
  repaired: number;
  /** Number of EVE definitions re-bound from aionrs → hermes (BUG 2). */
  rebound?: number;
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
        prepare: (sql: string) => {
          get: (...params: unknown[]) => unknown;
          run: (...params: unknown[]) => { changes: number };
        };
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

      // BUG 1 — re-activate orphaned (soft-deleted) user definitions.
      const info = db
        .prepare(
          "UPDATE assistant_definitions SET deleted_at = NULL " +
            "WHERE deleted_at IS NOT NULL AND source = 'user' " +
            "AND assistant_id IN (SELECT id FROM assistants)"
        )
        .run();

      // BUG 2 — re-bind the EVE assistant from the native aionrs agent back to
      // hermes. Guarded on agent_metadata + a hermes agent both existing, and
      // SCOPED to the EVE assistant whose CURRENT agent is aionrs — so it never
      // disturbs the other AionUi presets that legitimately run on aionrs. Also
      // clears deleted_at so the re-bound row is live in one shot. Idempotent:
      // once on hermes the aionrs subquery matches nothing → 0 changes.
      let rebound = 0;
      try {
        const hasAgentMeta = db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='agent_metadata'")
          .get() as { n: number } | undefined;
        if (hasAgentMeta && hasAgentMeta.n > 0) {
          const hermes = db
            .prepare(
              "SELECT id FROM agent_metadata " +
                "WHERE lower(coalesce(backend,'')) = 'hermes' OR lower(coalesce(agent_type,'')) = 'hermes' " +
                "LIMIT 1"
            )
            .get() as { id: string } | undefined;
          if (hermes && hermes.id) {
            const rebind = db
              .prepare(
                "UPDATE assistant_definitions SET agent_id = ?, deleted_at = NULL " +
                  "WHERE assistant_id = ? " +
                  "AND agent_id IN (SELECT id FROM agent_metadata WHERE lower(coalesce(agent_type,'')) = 'aionrs')"
              )
              .run(hermes.id, COMMAND_EVE_ASSISTANT_ID);
            rebound = rebind.changes;
          }
        }
      } catch {
        // best-effort; a re-bind failure must not block the orphan heal or boot
      }

      // Fold any change into the main DB so aioncore opens a clean file.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // best-effort; SQLite recovers the WAL on open anyway
      }
      return { repaired: info.changes, rebound };
    } finally {
      db.close();
    }
  } catch (error) {
    return { repaired: 0, skipped: error instanceof Error ? error.message : 'error' };
  }
}
