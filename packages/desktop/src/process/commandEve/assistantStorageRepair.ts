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
 * BUG 3 (no-live-definition brick — the one Alois actually hit): an ACTIVE EVE
 * assistant with NO live `assistant_definitions` row AT ALL — not merely soft-
 * deleted (BUG 1), genuinely ABSENT. aioncore keeps the legacy `assistants` table
 * as a downgrade/mirror projection of the new `assistant_definitions` SSOT; the
 * `router.assistant.bootstrap` stage rebuilds that legacy mirror from the live
 * definitions and CRASHES (`failed to bootstrap assistant storage` →
 * `BOOTSTRAP_SERVER_FAILED`, the "Installation unvollständig" dialog) when the EVE
 * legacy mirror row points at a definition that no longer exists live. BUG 1's
 * un-soft-delete UPDATE matches nothing (there is no row to un-delete), so the
 * brick survives every restart. Worse, `ensureCommandEveAssistant` reads the
 * legacy mirror to decide POST-vs-PUT and — seeing the orphaned `assistants` row —
 * takes the PUT path, which NEVER re-creates a definition. So the backend cannot
 * self-heal it either; Alois needed a hand INSERT. THE SAFE HEAL: delete ONLY the
 * orphaned EVE legacy mirror row (the derived, downgrade-only projection — the
 * real definition is already absent, so no user data is lost). With the EVE
 * `assistants` row gone and still no live definition, the next
 * `ensureCommandEveAssistant` takes the POST path and lets aioncore's OWN
 * authoritative creation rebuild a complete, CHECK-valid definition row (every
 * NOT-NULL/CHECK column correct) — instead of this layer hand-rolling a brittle
 * INSERT against aioncore's rich `assistant_definitions` schema. It is the exact
 * `DELETE FROM assistants WHERE id = ?` aioncore itself runs on a real delete.
 *
 * THE REPAIR: run on the AT-REST conversation DB BEFORE aioncore is spawned —
 *   (1) re-activate (un-soft-delete) any user-source definition whose assistant
 *       is still live (heals BUG 1);
 *   (2) re-bind the EVE assistant's definition from an aionrs agent back to the
 *       hermes agent when one exists (heals BUG 2);
 *   (3) clear the orphaned EVE legacy mirror row when the EVE assistant is active
 *       but has ZERO live definition rows AFTER (1) ran, so the backend re-seeds a
 *       clean definition via its own POST path (heals BUG 3).
 * All three are idempotent and cheap (no-ops once healed; the statements match 0
 * rows). BUG 3 only fires after BUG 1, so a row that was merely soft-deleted is
 * already live and BUG 3 leaves it alone — it acts strictly on a genuine ABSENCE.
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
  /**
   * Number of orphaned EVE legacy mirror rows cleared (BUG 3) — the EVE
   * `assistants` row was active with ZERO live definition rows, so it is removed
   * to let the backend re-seed a clean definition via its own POST path.
   */
  reseeded?: number;
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

      // BUG 3 — clear an orphaned EVE legacy mirror row that has NO live
      // definition AT ALL (the brick Alois hit). Runs AFTER BUG 1's un-soft-
      // delete, so a row that was merely soft-deleted is now live and this is a
      // no-op for it — BUG 3 only fires on a genuine ABSENCE. SCOPED to the EVE
      // assistant id only (never another AionUi preset). Deleting the legacy
      // mirror row (a downgrade/projection table; the real SSOT is
      // assistant_definitions, which is already absent here) lets the next
      // ensureCommandEveAssistant see no EVE row → take the POST path → have
      // aioncore re-create a complete, CHECK-valid definition. Idempotent: once a
      // live definition exists OR the orphan row is gone, the guard matches 0 rows.
      let reseeded = 0;
      try {
        const eveActive = db
          .prepare('SELECT 1 AS n FROM assistants WHERE id = ? LIMIT 1')
          .get(COMMAND_EVE_ASSISTANT_ID) as { n: number } | undefined;
        if (eveActive && eveActive.n) {
          const liveDef = db
            .prepare(
              'SELECT 1 AS n FROM assistant_definitions ' +
                'WHERE assistant_id = ? AND deleted_at IS NULL LIMIT 1'
            )
            .get(COMMAND_EVE_ASSISTANT_ID) as { n: number } | undefined;
          if (!liveDef) {
            const cleared = db
              .prepare('DELETE FROM assistants WHERE id = ?')
              .run(COMMAND_EVE_ASSISTANT_ID);
            reseeded = cleared.changes;
          }
        }
      } catch {
        // best-effort; an orphan-clear failure must not block the orphan/re-bind
        // heals or boot. A fresh install (no EVE row) or a healthy install (live
        // definition present) never reaches the DELETE.
      }

      // Fold any change into the main DB so aioncore opens a clean file.
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // best-effort; SQLite recovers the WAL on open anyway
      }
      return { repaired: info.changes, rebound, reseeded };
    } finally {
      db.close();
    }
  } catch (error) {
    return { repaired: 0, skipped: error instanceof Error ? error.message : 'error' };
  }
}
