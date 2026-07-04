/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO READINESS core (1.7.0 / COMPA-624 Inc.3 / P2 — the PURE
 * ready contract).
 *
 * WHY THIS EXISTS FIRST. Honcho is a BEST-EFFORT, FAIL-SAFE enhancement: if it is
 * not genuinely running the app must fall back to Company Brain + MEMORY.md and
 * NEVER claim memory is active when it is not (founder: NO FALSE READINESS). Every
 * consumer that decides "is the deriver live / show the memory badge / emit the
 * SOUL directive" must gate on ONE truth — and that truth must be TWO FACTS, not
 * "installed":
 *   FACT #1 serverUp        — the local Honcho FastAPI answered /health 200 on loopback.
 *   FACT #2 deriverReachable — the deriver lane probe passed (local: the Ollama model
 *                              is warm; cloud: the loopback shim is reachable + a
 *                              license exists).
 * `honchoReady` is true ONLY when both facts hold AND the reduced state is 'ready'.
 * `honchoReadyFromSnapshot` additionally distrusts a STALE snapshot (a crash
 * between the last probe and now must not read as ready). This module is PURE (no
 * fs/net/spawn) so the fail-safe posture is unit-testable; the orchestration
 * shells own the real HTTP probes and feed their raw outcomes to
 * {@link reduceHonchoReadiness}.
 */

/** The five readiness states (plain strings — strictNullChecks is OFF). */
export const HONCHO_STATE_OFF = 'off';
export const HONCHO_STATE_PROVISIONING = 'provisioning';
export const HONCHO_STATE_DEGRADED = 'degraded';
export const HONCHO_STATE_CRASHED = 'crashed';
export const HONCHO_STATE_READY = 'ready';

/** Non-secret reason codes (drive the TRUTHFUL UI; never block first value). */
export const HONCHO_REASON_DECLINED = 'HONCHO_DECLINED';
export const HONCHO_REASON_DEP_MISSING = 'HONCHO_DEP_MISSING';
export const HONCHO_REASON_PROCESS_DOWN = 'HONCHO_PROCESS_DOWN';
export const HONCHO_REASON_PROBE_TIMEOUT = 'HONCHO_PROBE_TIMEOUT';
export const HONCHO_REASON_DERIVER_UNREACHABLE = 'HONCHO_DERIVER_UNREACHABLE';

/**
 * A persisted ready snapshot older than this is NOT trusted as ready — the
 * process could have crashed between the last successful probe and now, so a stale
 * `ready` must fail-closed to "not ready" (defense against reading a dead server's
 * last-good receipt).
 */
export const HONCHO_READINESS_MAX_AGE_MS = 15000;

/**
 * The readiness snapshot (persisted per-seat as honcho-readiness.json by the P6
 * bridge). FLAT + optional (strictNullChecks OFF); absence of a field is treated
 * as "not proven" everywhere, so an empty/partial snapshot can only ever read as
 * NOT ready.
 */
export interface HonchoReadinessState {
  /** The seat this snapshot is FOR — isolation defense-in-depth for the reader. */
  seatId?: string;
  /** One of HONCHO_STATE_*. */
  state?: string;
  /** FACT #1: the local Honcho FastAPI answered /health 200 on loopback. */
  serverUp?: boolean;
  /** FACT #2: the deriver-lane probe passed (local warm / cloud reachable+licensed). */
  deriverReachable?: boolean;
  /** 'local-ollama' | 'cloud-flash-via-shim' — evidence for the truthful UI. */
  branch?: string;
  /** A HONCHO_REASON_* code when not ready. */
  reasonCode?: string;
  /** ISO-8601 freshness anchor (when the probe ran). */
  probedAt?: string;
}

/**
 * THE single ready truth every consumer reads. `installed` is NEVER sufficient —
 * both facts plus the reduced 'ready' state are required. A missing/partial state
 * reads false.
 */
export function honchoReady(state: HonchoReadinessState | undefined): boolean {
  return !!state && state.serverUp === true && state.deriverReachable === true && state.state === HONCHO_STATE_READY;
}

/**
 * Ready truth for a PERSISTED snapshot, with a freshness guard: a snapshot that is
 * ready but older than `maxAgeMs` (or has no/invalid `probedAt`) is treated as NOT
 * ready. So a crash between the last probe and the read cannot surface as ready.
 */
export function honchoReadyFromSnapshot(
  snapshot: HonchoReadinessState | undefined,
  opts?: { now?: number; maxAgeMs?: number }
): boolean {
  if (!honchoReady(snapshot)) return false;
  const now = opts && typeof opts.now === 'number' ? opts.now : Date.now();
  const maxAgeMs = opts && typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : HONCHO_READINESS_MAX_AGE_MS;
  const at = snapshot && snapshot.probedAt ? Date.parse(snapshot.probedAt) : NaN;
  if (!Number.isFinite(at)) return false; // no/invalid timestamp ⇒ deny
  const age = now - at;
  // A FUTURE-dated probe (age < 0 — clock skew or a malformed/tampered snapshot)
  // is not trustworthy and must NOT read fresh (Codex #3): require 0 <= age <= max.
  return age >= 0 && age <= maxAgeMs;
}

/**
 * DEFAULT-DENY reducer over the raw probe outcomes the orchestration shell
 * gathers. Pure: the shell owns the actual HTTP; this maps outcomes → a truthful
 * {@link HonchoReadinessState}. Precedence (first match wins):
 *   declined            ⇒ off      / HONCHO_DECLINED
 *   !provisioned        ⇒ off      / HONCHO_DEP_MISSING
 *   crashedSinceReady   ⇒ crashed  / HONCHO_PROCESS_DOWN
 *   serverProbe !ok     ⇒ degraded / HONCHO_PROBE_TIMEOUT      (serverUp:false)
 *   deriverProbe !ok    ⇒ degraded / HONCHO_DERIVER_UNREACHABLE (serverUp:true, deriverReachable:false)
 *   both ok             ⇒ ready    (serverUp:true, deriverReachable:true)
 * ANY non-proven combination yields a state for which {@link honchoReady} is false.
 */
export function reduceHonchoReadiness(input: {
  provisioned?: boolean;
  declined?: boolean;
  crashedSinceReady?: boolean;
  serverProbe?: { ok?: boolean; timedOut?: boolean };
  deriverProbe?: { ok?: boolean; timedOut?: boolean };
  seatId?: string;
  branch?: string;
  now?: number;
}): HonchoReadinessState {
  // Guard a non-finite injected clock (NaN/Infinity) — `new Date(NaN).toISOString()`
  // throws, which would escape into the bootstrap. Fall back to the real clock.
  const rawNow = typeof input.now === 'number' ? input.now : Date.now();
  const nowMs = Number.isFinite(rawNow) ? rawNow : Date.now();
  const base: HonchoReadinessState = {
    seatId: input.seatId,
    branch: input.branch,
    probedAt: new Date(nowMs).toISOString(),
    serverUp: false,
    deriverReachable: false,
  };

  if (input.declined === true) {
    return { ...base, state: HONCHO_STATE_OFF, reasonCode: HONCHO_REASON_DECLINED };
  }
  if (input.provisioned !== true) {
    return { ...base, state: HONCHO_STATE_OFF, reasonCode: HONCHO_REASON_DEP_MISSING };
  }
  if (input.crashedSinceReady === true) {
    return { ...base, state: HONCHO_STATE_CRASHED, reasonCode: HONCHO_REASON_PROCESS_DOWN };
  }
  const serverOk = !!input.serverProbe && input.serverProbe.ok === true;
  if (!serverOk) {
    // A fresh cycle where the server did not answer — timed-out vs otherwise-down
    // is surfaced truthfully, but either way it is degraded and NOT ready.
    const timedOut = !!input.serverProbe && input.serverProbe.timedOut === true;
    return {
      ...base,
      state: HONCHO_STATE_DEGRADED,
      reasonCode: timedOut ? HONCHO_REASON_PROBE_TIMEOUT : HONCHO_REASON_PROCESS_DOWN,
    };
  }
  const deriverOk = !!input.deriverProbe && input.deriverProbe.ok === true;
  if (!deriverOk) {
    return {
      ...base,
      state: HONCHO_STATE_DEGRADED,
      serverUp: true,
      reasonCode: HONCHO_REASON_DERIVER_UNREACHABLE,
    };
  }
  return {
    ...base,
    state: HONCHO_STATE_READY,
    serverUp: true,
    deriverReachable: true,
  };
}

/**
 * SOURCE-PINNED: Honcho is OPTIONAL, so every provisioning miss maps to the
 * bootstrap stage status 'skip' — the un-bypassable device that keeps the overall
 * runtime-bootstrap receipt 'ready' (a 'blocked'/'failed' stage would flip the
 * whole receipt to non-ready and wrongly block first value). This function exists
 * as the ONE place that rule lives, so a regression test can pin it: no reason
 * code, however fatal-sounding, may ever escalate a Honcho miss past 'skip'.
 */
export function honchoMissStatus(_reasonCode?: string): string {
  return 'skip';
}
