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
  // Sample the ACTIVE seat so the last-known-good snapshot is keyed PER SEAT. The
  // shim is a singleton that survives seat switches; a single cross-seat snapshot
  // would let seat A's roster be served for seat B on a hiccup (full-history
  // re-audit): after seat B fired a worker ('off'), switching to seat A refreshes
  // the snapshot to seat A's 'active', then a seat-B read hiccup returned seat A's
  // 'active' → seat B's fired/paused worker resumes SPENDING. Keying by seat means a
  // hiccup only ever returns THIS seat's own last-known-good (or undefined). Defaults
  // to a single '' key (legacy/single-seat behaviour) when not provided.
  getSeatId: () => string = () => '',
  onError?: (error: unknown) => void
): () => Promise<EveTeamWorkerStatusMap | undefined> {
  const lastKnownGoodBySeat = new Map<string, EveTeamWorkerStatusMap>();

  return async () => {
    let seatId = '';
    try {
      seatId = getSeatId() || '';
    } catch {
      seatId = '';
    }
    try {
      const bag = await readSettings([TEAM_WORKER_STATUS_KEY]);
      const statuses = bag[TEAM_WORKER_STATUS_KEY];
      if (statuses && typeof statuses === 'object') {
        // Successful read → refresh THIS seat's last-known-good and return it.
        lastKnownGoodBySeat.set(seatId, statuses as EveTeamWorkerStatusMap);
        return statuses as EveTeamWorkerStatusMap;
      }
      // Read succeeded but the key is absent (never configured) ⇒ a genuine "no
      // status map" (every worker active). Seed THIS seat's snapshot to the empty map
      // so a later transient error cannot resurrect a stale roster; return undefined
      // to preserve the exact no-gating default the shim expects.
      lastKnownGoodBySeat.set(seatId, {});
      return undefined;
    } catch (error) {
      // Backend hiccup: hold the line on THIS SEAT's last-known-good roster ONLY (a
      // worker fired before the hiccup stays fired), never another seat's. An unread
      // seat ⇒ undefined (no gating — today's fail-open default).
      onError?.(error);
      return lastKnownGoodBySeat.get(seatId);
    }
  };
}
