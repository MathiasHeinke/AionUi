/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S9 #1 — THE MONEY BUG. The "Dein Team" worker-status resolver the Ollama shim
 * calls PER dispatch evaluation to decide whether a delegated worker may spend.
 *
 * THE BUG THIS FIXES: the old resolver read `commandEve.teamWorkerStatus` from
 * the main-process `ProcessConfig` JSON store — a store the renderer's panel
 * (`configService.set`, which PUTs to the aioncore BACKEND `/api/settings/client`)
 * NEVER writes to. So the read ALWAYS returned `undefined` ⇒ the shim treated
 * every worker as active ⇒ a worker the operator PAUSED / FIRED kept being
 * dispatched and kept SPENDING. The pause/throttle/fire controls were a closed
 * loop with zero effect on the store the execution path read.
 *
 * THE FIX: read the live status map FRESH from the BACKEND store (the store the
 * panel actually writes to) on EVERY dispatch, so a fire is effective on the very
 * next dispatch. No TTL cache — this is a money control.
 *
 * FAIL-DIRECTION (decided, spec #1):
 *   - backend HTTP error → return the LAST-KNOWN-GOOD snapshot (the map from the
 *     last successful read). A transient hiccup must NOT brick ALL workers
 *     (availability), but a worker fired BEFORE the hiccup stays fired (money —
 *     the last good read already saw its 'off'/'paused' status).
 *   - never read successfully yet → `undefined` ⇒ no gating (every worker active,
 *     today's fail-open default).
 *
 * PURE-ish + injectable: the backend read is injected so this whole
 * fresh-read-plus-last-known-good decision is unit-testable end-to-end against a
 * mocked backend, WITHOUT importing the electron-heavy main entry. index.ts wires
 * the real `readCommandEveSettingsFromBackend` in.
 */

import type { EveTeamWorkerStatusMap } from '@/common/config/eveTeamControlsCore';

const TEAM_WORKER_STATUS_KEY = 'commandEve.teamWorkerStatus';

/** Injected backend batch read (real one: readCommandEveSettingsFromBackend). */
export type CommandEveSettingsBatchReader = (
  logicalKeys: readonly string[]
) => Promise<Record<string, unknown>>;

/**
 * Build the per-dispatch team-worker-status resolver. Holds a private
 * last-known-good snapshot in closure scope (survives across dispatches for the
 * life of the process). Returns an async resolver the shim awaits.
 *
 * @param readSettings the backend batch reader (injected for testability).
 * @param onError optional side-channel for logging (index.ts passes console.warn).
 */
export function createTeamWorkerStatusResolver(
  readSettings: CommandEveSettingsBatchReader,
  onError?: (error: unknown) => void
): () => Promise<EveTeamWorkerStatusMap | undefined> {
  let lastKnownGood: EveTeamWorkerStatusMap | undefined;

  return async () => {
    try {
      const bag = await readSettings([TEAM_WORKER_STATUS_KEY]);
      const statuses = bag[TEAM_WORKER_STATUS_KEY];
      if (statuses && typeof statuses === 'object') {
        // Successful read → refresh last-known-good and return it.
        lastKnownGood = statuses as EveTeamWorkerStatusMap;
        return lastKnownGood;
      }
      // Read succeeded but the key is absent (never configured) ⇒ a genuine "no
      // status map" (every worker active). Seed the snapshot to the empty map so
      // a later transient error cannot resurrect a stale roster; return undefined
      // to preserve the exact no-gating default the shim expects.
      lastKnownGood = {};
      return undefined;
    } catch (error) {
      // Backend hiccup: hold the line on the last-known-good roster (a worker
      // fired before the hiccup stays fired), while a transient error never
      // bricks every worker.
      onError?.(error);
      return lastKnownGood;
    }
  };
}
