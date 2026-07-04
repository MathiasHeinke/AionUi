/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO DERIVER ROUTE core (1.7.0 / COMPA-624 Inc.3 / P3 — the PURE
 * "is the deriver cloud lane live?" gate + the shim resolver builder).
 *
 * The shim's `/honcho/deriver` lane is INERT (503) until the main process injects
 * a `honchoDeriverRoute` resolver returning `{ active, functionUrl, license }`.
 * This module is the ONE place that decides — DEFAULT-DENY — when that route is
 * active, and builds the resolver from injected I/O deps (so it stays unit-
 * testable with fakes; the builder itself is pure).
 *
 * MONEY/EGRESS CONTINUITY (from Inc.1/2, kept intact): the resolver returns NO
 * `tier` (the shim forces the FREE 'standard' tier server-side) and the CEVE
 * license is read FRESH per call, put ONLY into the returned route (which the shim
 * sends as an Authorization header, never body, never logged) — never stored on a
 * descriptor. Every failure path (not ready, stale, seat mismatch, no license, a
 * throwing dep) returns `{ active: false }`, so the deriver never egresses half-
 * configured.
 */

import { HONCHO_DERIVER_BRANCH_CLOUD } from './honchoRuntimeConfigCore';
import { honchoReadyFromSnapshot, type HonchoReadinessState } from './honchoReadinessCore';

/** The route shape the shim's honchoDeriverRoute resolver returns (NO tier by design). */
export interface HonchoDeriverRouteResult {
  active?: boolean;
  functionUrl?: string;
  license?: string;
}

/**
 * Is the cloud-flash deriver route ACTIVE for the active seat? DEFAULT-DENY — true
 * ONLY when ALL hold:
 *   - the readiness snapshot passes the two-fact + freshness guard (honchoReadyFromSnapshot),
 *   - the branch is the cloud-flash-via-shim lane (the local branch talks to Ollama
 *     directly and never rides this route),
 *   - the snapshot is FOR the current active seat (a snapshot from another seat, or
 *     an empty active seat, can never activate the deriver here — isolation).
 * Any missing/partial/stale/mismatched input ⇒ false.
 */
export function resolveHonchoDeriverRouteActive(
  state: HonchoReadinessState | undefined,
  activeSeatId: string | undefined,
  opts?: { now?: number; maxAgeMs?: number }
): boolean {
  if (!activeSeatId) return false;
  if (!honchoReadyFromSnapshot(state, opts)) return false;
  if (!state || state.branch !== HONCHO_DERIVER_BRANCH_CLOUD) return false;
  return state.seatId === activeSeatId;
}

/**
 * Build the shim `honchoDeriverRoute` resolver from injected I/O deps. The builder
 * is pure; the returned closure performs the reads. Fail-closed on EVERY error.
 *
 * deps:
 *  - functionUrl: the eve-inference edge URL (same lane as chat egress).
 *  - readLicenseWire(): the CEVE license wire string (read fresh per call).
 *  - getActiveSeatId(): the current opaque active seat id.
 *  - readHonchoSeatReady(seatId): the per-seat readiness snapshot (or undefined).
 *  - onError(e): optional sink for a read error (the route still fails closed).
 *  - now(): injectable clock for the freshness guard (tests).
 */
export function buildCommandEveShimHonchoDeriverRouteResolver(deps: {
  functionUrl?: string;
  readLicenseWire?: () => string;
  getActiveSeatId?: () => string;
  readHonchoSeatReady?: (seatId: string) => HonchoReadinessState | undefined;
  onError?: (error: unknown) => void;
  now?: () => number;
  maxAgeMs?: number;
}): () => HonchoDeriverRouteResult {
  return (): HonchoDeriverRouteResult => {
    try {
      const seatId = typeof deps.getActiveSeatId === 'function' ? deps.getActiveSeatId() : '';
      const state = typeof deps.readHonchoSeatReady === 'function' ? deps.readHonchoSeatReady(seatId) : undefined;
      const now = typeof deps.now === 'function' ? deps.now() : Date.now();
      if (!resolveHonchoDeriverRouteActive(state, seatId, { now, maxAgeMs: deps.maxAgeMs })) {
        return { active: false };
      }
      const functionUrl = typeof deps.functionUrl === 'string' ? deps.functionUrl.trim() : '';
      const license = typeof deps.readLicenseWire === 'function' ? (deps.readLicenseWire() || '').trim() : '';
      // Fail-closed: without both a URL and a license the deriver can not authenticate.
      if (functionUrl.length === 0 || license.length === 0) return { active: false };
      return { active: true, functionUrl, license };
    } catch (error) {
      // Fail-closed EVEN if the error sink itself throws (Codex #4) — the deriver
      // must never egress because of a logging failure.
      if (typeof deps.onError === 'function') {
        try {
          deps.onError(error);
        } catch {
          /* swallow — the route still fails closed below */
        }
      }
      return { active: false };
    }
  };
}
