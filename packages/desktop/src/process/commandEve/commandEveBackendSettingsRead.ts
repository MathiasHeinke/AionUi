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
 * SECURITY (C1, full-history audit): seat-scoped keys that must NEVER legacy-inherit
 * on a real seat. For a normal store-split key (teamWorkerStatus / workerAssignments /
 * localModelTierId / modelWarmupEnabled) a real seat with no scoped value may fall
 * back to the un-prefixed legacy value (a benign migration/convenience carry-over,
 * and the renderer tolerates it for those). But for a PII/security SWITCH that
 * fallback is fail-OPEN: a client seat that never toggled `egressRedactionMode` would
 * inherit the FOUNDER seat's `'off'` and ship the client's emails/phones/addresses
 * RAW to the EVE cloud, while the UI (which refuses the un-prefixed read for a real
 * seat) still shows the seat as protected. For these keys a real seat reads ONLY its
 * own scoped value; absent ⇒ omitted ⇒ the caller's SAFE default (the egress resolver
 * fail-safes to 'on' = always redact). The legacy/founder seat is unaffected
 * (physicalKeyFor returns the un-prefixed key verbatim there).
 */
const NO_LEGACY_INHERIT_KEYS: ReadonlySet<string> = new Set<string>([
  'commandEve.egressRedactionMode',
  // CEVE-18205: the agent video-GENERATE release is a SPEND switch, so the
  // fail-open argument above applies to it with money attached. A client seat that
  // never ticked the box would otherwise inherit the FOUNDER seat's `true` and let
  // the model start paid renders on that client's credits, while its own settings
  // card (which refuses the un-prefixed read for a real seat) still shows the
  // feature as off. A real seat reads ONLY its own scoped value; absent ⇒ omitted
  // ⇒ the resolver's fail-closed default (off).
  'commandEve.agentVideoGenerateEnabled',
]);

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
    // Prefer the seat-physical key. Fall back to the un-prefixed legacy key ONLY for
    // non-security keys (migration/convenience carry-over) — NEVER for a
    // NO_LEGACY_INHERIT_KEYS security switch, where inheriting the founder seat's
    // value is fail-OPEN (see C1 above: a client seat inheriting egressRedactionMode
    // 'off' → raw PII to the cloud). For those the fallback is dropped, so a real
    // seat with no scoped value resolves to its caller's SAFE default. On the legacy
    // seat physicalKey === logicalKey, so the fallback is a no-op there regardless.
    const raw = NO_LEGACY_INHERIT_KEYS.has(logicalKey)
      ? settings[physicalKey]
      : (settings[physicalKey] ?? settings[logicalKey]);
    if (raw !== undefined && raw !== null) {
      out[logicalKey] = raw;
    }
  }
  return out;
}
