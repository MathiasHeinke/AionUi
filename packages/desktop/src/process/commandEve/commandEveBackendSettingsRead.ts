/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SHARED main-process reader for `commandEve.*` settings that the RENDERER
 * persists to the aioncore BACKEND settings store (`/api/settings/client`
 * → SQLite `client_preferences`), NOT to the main-process `ProcessConfig` JSON
 * file (`command-eve-config.txt`).
 *
 * WHY THIS EXISTS (the store-split bruchlinie, generalized):
 *
 *   The renderer's `configService.set('commandEve.<key>', value)` PUTs to
 *   `/api/settings/client`. It does NOT write the main-process `ProcessConfig`
 *   store. Several main-process consumers read those same keys back via
 *   `ProcessConfig.get*('commandEve.<key>')` — a store the picker/panel value
 *   NEVER lands in — so the read ALWAYS returns `undefined` and the control is
 *   silently dead. `inferenceSelectionBackendRead.ts` fixed exactly this for the
 *   `inferenceSelection` picker (the 1.2.19 "EVE Max routes as Flash" bug). This
 *   module GENERALIZES that proven single-key pattern to a batch of keys so the
 *   remaining dead controls (teamWorkerStatus / workerAssignments /
 *   localModelTierId / modelWarmupEnabled) read the store the renderer actually
 *   writes to — with ONE GET for the whole set.
 *
 * SEAT SCOPING: a key in `SEAT_SCOPED_CONFIG_KEYS` is persisted by the renderer
 * under its seat-physical key (`seatScopedKey(logicalKey, activeSeatId)`); a
 * legacy/no-seat holder uses the un-prefixed key verbatim. We resolve the SAME
 * physical key per logical key here so we read the value the renderer actually
 * wrote for the active seat, with a legacy-key fallback so a value written before
 * seat scoping (or by a legacy holder) is still found. This is EXACTLY the
 * `inferenceSelectionBackendRead` resolution, including the try/catch fallback
 * when the seat context is not yet resolvable.
 *
 * ERROR SIGNALLING (deliberate): an HTTP/read error THROWS — it does NOT return
 * `{}`. A silent `{}`-on-failure would be a LIE to a caller that needs to tell
 * "backend unreachable" apart from "key genuinely absent": the money-bug resolver
 * (#1) uses exactly that distinction to hold its last-known-good roster on a
 * hiccup instead of resurrecting a fired worker. So this reader surfaces failure;
 * each caller applies its OWN documented fail-direction (a `.catch(() => ({}))`
 * for the simple key-default consumers; last-known-good for the money control).
 * An empty-but-successful read still returns `{}` — that is a genuine "all keys
 * absent", never confused with a failure.
 *
 * ONE GET, MANY KEYS: `/api/settings/client` returns the COMPLETE settings
 * object, so a single GET serves every requested key — no extra HTTP per key.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import { isSeatScopedConfigKey, seatScopedKey } from '@/common/config/seatConfigKeyCore';
import { getActiveSeatId } from './seatContextCore';

/**
 * Resolve the seat-physical key for a logical `commandEve.*` key (seat-scoped
 * keys get the active-seat prefix; install-global keys pass through unchanged).
 * Fail-soft: if the seat context is not resolvable yet, fall back to the
 * un-prefixed (legacy) key — never throw here.
 */
function physicalKeyFor(logicalKey: string): string {
  if (!isSeatScopedConfigKey(logicalKey)) return logicalKey;
  try {
    return seatScopedKey(logicalKey, getActiveSeatId());
  } catch {
    return logicalKey;
  }
}

/**
 * Fetch the backend settings object ONCE and extract the requested logical keys,
 * seat-scoped-aware.
 *
 * For each logical key the result carries the RAW persisted value (whatever type
 * the renderer stored — object / string / boolean / etc.) under the LOGICAL key,
 * resolved from the seat-physical key with a legacy-key fallback. A key that is
 * absent from the backend bag is simply omitted from the result (the caller
 * applies its own default), so `key in result` is a clean "was it set?" probe.
 *
 * THROWS on an HTTP/read error (so a caller can distinguish "backend unreachable"
 * from "key genuinely absent" — see the module docstring; the money-bug resolver
 * depends on that distinction for its last-known-good hold). A SUCCESSFUL read
 * with none of the requested keys present returns `{}` (a real "all absent").
 * Each caller applies its own fail-direction on the throw.
 */
export async function readCommandEveSettingsFromBackend(
  logicalKeys: readonly string[]
): Promise<Record<string, unknown>> {
  // httpRequest throws on a non-2xx / network error — let it PROPAGATE so the
  // caller's fail-direction (per-key default vs. last-known-good) can decide.
  const settings = await httpRequest<Record<string, unknown>>('GET', '/api/settings/client');
  if (!settings || typeof settings !== 'object') return {};

  const out: Record<string, unknown> = {};
  for (const logicalKey of logicalKeys) {
    const physicalKey = physicalKeyFor(logicalKey);
    // Prefer the seat-physical key; fall back to the un-prefixed logical key so a
    // legacy holder (or a value written before seat scoping) is still found —
    // identical precedence to inferenceSelectionBackendRead.
    const raw = settings[physicalKey] ?? settings[logicalKey];
    if (raw !== undefined && raw !== null) {
      out[logicalKey] = raw;
    }
  }
  return out;
}
