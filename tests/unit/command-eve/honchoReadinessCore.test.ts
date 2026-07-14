/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-Inc.3 / P2 — the ready contract. These pin the FAIL-SAFE / NO-FALSE-
 * READINESS posture: "installed" is never "ready"; a stale ready is not ready; and
 * every Honcho miss is a 'skip' (so it can never block first value).
 */

import { describe, expect, it } from 'vitest';
import {
  HONCHO_READINESS_MAX_AGE_MS,
  HONCHO_STATE_CRASHED,
  HONCHO_STATE_DEGRADED,
  HONCHO_STATE_OFF,
  HONCHO_STATE_READY,
  HONCHO_REASON_DECLINED,
  HONCHO_REASON_DEP_MISSING,
  HONCHO_REASON_DERIVER_UNREACHABLE,
  HONCHO_REASON_PROCESS_DOWN,
  HONCHO_REASON_PROBE_TIMEOUT,
  honchoMissStatus,
  honchoReady,
  honchoReadyFromSnapshot,
  reduceHonchoReadiness,
  type HonchoReadinessState,
} from '@/process/commandEve/honchoReadinessCore';

const READY: HonchoReadinessState = {
  state: HONCHO_STATE_READY,
  serverUp: true,
  deriverReachable: true,
  probedAt: '2026-07-04T12:00:00.000Z',
};

describe('honchoReadinessCore — honchoReady truth table (installed is never ready)', () => {
  it('is true ONLY when both facts hold AND state is ready', () => {
    expect(honchoReady(READY)).toBe(true);
  });
  it('is false when undefined / empty / partial', () => {
    expect(honchoReady(undefined)).toBe(false);
    expect(honchoReady({})).toBe(false);
    expect(honchoReady({ state: HONCHO_STATE_READY })).toBe(false); // no facts
  });
  it('is false when the server is up but the deriver is unreachable (up-but-unreachable)', () => {
    expect(honchoReady({ state: HONCHO_STATE_DEGRADED, serverUp: true, deriverReachable: false })).toBe(false);
  });
  it('is false when both facts hold but the state is not ready (up-but-cold)', () => {
    expect(honchoReady({ state: HONCHO_STATE_DEGRADED, serverUp: true, deriverReachable: true })).toBe(false);
  });
  it('is false when installed/provisioned but the server is down (installed-but-down)', () => {
    expect(honchoReady({ state: HONCHO_STATE_OFF, serverUp: false, deriverReachable: false })).toBe(false);
  });
});

describe('honchoReadinessCore — honchoReadyFromSnapshot freshness guard', () => {
  const now = Date.parse('2026-07-04T12:00:10.000Z'); // 10s after the READY probe
  it('accepts a ready snapshot within the freshness window', () => {
    expect(honchoReadyFromSnapshot(READY, { now, maxAgeMs: HONCHO_READINESS_MAX_AGE_MS })).toBe(true);
  });
  it('DENIES a ready snapshot older than maxAgeMs (crash-between-writes cannot read ready)', () => {
    const stale = Date.parse('2026-07-04T12:00:30.000Z'); // 30s later, > 15s window
    expect(honchoReadyFromSnapshot(READY, { now: stale })).toBe(false);
  });
  it('DENIES a ready snapshot with a missing or invalid probedAt', () => {
    expect(
      honchoReadyFromSnapshot({ state: HONCHO_STATE_READY, serverUp: true, deriverReachable: true }, { now })
    ).toBe(false);
    expect(honchoReadyFromSnapshot({ ...READY, probedAt: 'not-a-date' }, { now })).toBe(false);
  });
  it('DENIES a non-ready snapshot regardless of freshness', () => {
    expect(honchoReadyFromSnapshot({ ...READY, deriverReachable: false }, { now })).toBe(false);
  });
  it('DENIES a FUTURE-dated snapshot (clock skew / tampered receipt cannot read fresh)', () => {
    const future = { ...READY, probedAt: '2999-01-01T00:00:00.000Z' };
    expect(honchoReadyFromSnapshot(future, { now })).toBe(false);
  });
  it('boundary: age exactly 0 and exactly maxAgeMs are fresh; one ms past is not', () => {
    const at = Date.parse(READY.probedAt as string);
    expect(honchoReadyFromSnapshot(READY, { now: at, maxAgeMs: HONCHO_READINESS_MAX_AGE_MS })).toBe(true); // age 0
    expect(honchoReadyFromSnapshot(READY, { now: at + HONCHO_READINESS_MAX_AGE_MS })).toBe(true); // age == max
    expect(honchoReadyFromSnapshot(READY, { now: at + HONCHO_READINESS_MAX_AGE_MS + 1 })).toBe(false); // age max+1
  });
});

describe('honchoReadinessCore — reduceHonchoReadiness (default-deny rows)', () => {
  const NOW = Date.parse('2026-07-04T12:00:00.000Z');
  const P = { ok: true };
  const F = { ok: false };

  it('declined ⇒ off / HONCHO_DECLINED, not ready', () => {
    const s = reduceHonchoReadiness({ declined: true, provisioned: true, serverProbe: P, deriverProbe: P, now: NOW });
    expect(s.state).toBe(HONCHO_STATE_OFF);
    expect(s.reasonCode).toBe(HONCHO_REASON_DECLINED);
    expect(honchoReady(s)).toBe(false);
  });
  it('!provisioned ⇒ off / HONCHO_DEP_MISSING', () => {
    const s = reduceHonchoReadiness({ provisioned: false, now: NOW });
    expect(s.state).toBe(HONCHO_STATE_OFF);
    expect(s.reasonCode).toBe(HONCHO_REASON_DEP_MISSING);
    expect(honchoReady(s)).toBe(false);
  });
  it('crashedSinceReady ⇒ crashed / HONCHO_PROCESS_DOWN', () => {
    const s = reduceHonchoReadiness({
      provisioned: true,
      crashedSinceReady: true,
      serverProbe: P,
      deriverProbe: P,
      now: NOW,
    });
    expect(s.state).toBe(HONCHO_STATE_CRASHED);
    expect(s.reasonCode).toBe(HONCHO_REASON_PROCESS_DOWN);
    expect(honchoReady(s)).toBe(false);
  });
  it('server probe timed out ⇒ degraded / HONCHO_PROBE_TIMEOUT (serverUp false)', () => {
    const s = reduceHonchoReadiness({
      provisioned: true,
      serverProbe: { ok: false, timedOut: true },
      deriverProbe: P,
      now: NOW,
    });
    expect(s.state).toBe(HONCHO_STATE_DEGRADED);
    expect(s.reasonCode).toBe(HONCHO_REASON_PROBE_TIMEOUT);
    expect(s.serverUp).toBe(false);
    expect(honchoReady(s)).toBe(false);
  });
  it('server down (not timeout) ⇒ degraded / HONCHO_PROCESS_DOWN', () => {
    const s = reduceHonchoReadiness({ provisioned: true, serverProbe: F, deriverProbe: P, now: NOW });
    expect(s.state).toBe(HONCHO_STATE_DEGRADED);
    expect(s.reasonCode).toBe(HONCHO_REASON_PROCESS_DOWN);
    expect(honchoReady(s)).toBe(false);
  });
  it('server up but deriver unreachable ⇒ degraded / HONCHO_DERIVER_UNREACHABLE (serverUp true, deriverReachable false)', () => {
    const s = reduceHonchoReadiness({
      provisioned: true,
      serverProbe: P,
      deriverProbe: F,
      seatId: 'seat-1',
      branch: 'cloud-flash-via-shim',
      now: NOW,
    });
    expect(s.state).toBe(HONCHO_STATE_DEGRADED);
    expect(s.reasonCode).toBe(HONCHO_REASON_DERIVER_UNREACHABLE);
    expect(s.serverUp).toBe(true);
    expect(s.deriverReachable).toBe(false);
    expect(honchoReady(s)).toBe(false);
  });
  it('both probes ok ⇒ ready (serverUp + deriverReachable true), carries seat + branch + probedAt', () => {
    const s = reduceHonchoReadiness({
      provisioned: true,
      serverProbe: P,
      deriverProbe: P,
      seatId: 'a1b2',
      branch: 'local-ollama',
      now: NOW,
    });
    expect(s.state).toBe(HONCHO_STATE_READY);
    expect(s.serverUp).toBe(true);
    expect(s.deriverReachable).toBe(true);
    expect(s.seatId).toBe('a1b2');
    expect(s.branch).toBe('local-ollama');
    expect(s.probedAt).toBe('2026-07-04T12:00:00.000Z');
    expect(honchoReady(s)).toBe(true);
    // and it survives the freshness guard when read immediately
    expect(honchoReadyFromSnapshot(s, { now: NOW + 1000 })).toBe(true);
  });

  it('is deterministic when now is injected', () => {
    const a = reduceHonchoReadiness({ provisioned: true, serverProbe: P, deriverProbe: P, now: NOW });
    const b = reduceHonchoReadiness({ provisioned: true, serverProbe: P, deriverProbe: P, now: NOW });
    expect(a).toEqual(b);
  });

  it('guards a non-finite clock: NaN/Infinity now does not throw and yields a valid ISO probedAt', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const s = reduceHonchoReadiness({ provisioned: true, serverProbe: P, deriverProbe: P, now: bad });
      expect(Number.isFinite(Date.parse(s.probedAt as string))).toBe(true); // fell back to a real clock
      expect(s.state).toBe(HONCHO_STATE_READY);
    }
  });
});

describe('honchoReadinessCore — honchoMissStatus source pin', () => {
  it('maps EVERY reason code (and any string) to skip — a miss never blocks first value', () => {
    const codes = [
      HONCHO_REASON_DECLINED,
      HONCHO_REASON_DEP_MISSING,
      HONCHO_REASON_PROCESS_DOWN,
      HONCHO_REASON_PROBE_TIMEOUT,
      HONCHO_REASON_DERIVER_UNREACHABLE,
      'BLOCKED_DISK',
      'BLOCKED_RAM',
      'SOMETHING_FATAL_SOUNDING',
      '',
      undefined,
    ];
    for (const c of codes) {
      expect(honchoMissStatus(c as string)).toBe('skip');
    }
  });
});
