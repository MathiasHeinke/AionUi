/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-Inc.3 / P3 — the deriver-route-active gate + shim resolver. Pins the
 * default-deny gating (ready+fresh+cloud-branch+seat-match) and the fail-closed
 * resolver (no license / seat mismatch / throwing dep ⇒ { active:false }, no
 * license leak), keeping the Inc.1/2 money+egress invariants intact.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildCommandEveShimHonchoDeriverRouteResolver,
  resolveHonchoDeriverRouteActive,
} from '@/process/commandEve/honchoDeriverRouteCore';
import { HONCHO_STATE_READY, type HonchoReadinessState } from '@/process/commandEve/honchoReadinessCore';
import { HONCHO_DERIVER_BRANCH_CLOUD, HONCHO_DERIVER_BRANCH_LOCAL } from '@/process/commandEve/honchoRuntimeConfigCore';

const NOW = Date.parse('2026-07-04T12:00:00.000Z');
const SEAT = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const FAKE_LICENSE = 'CEVE.v2.FAKE-payload.FAKE-sig';
const FN_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-inference';

function readyCloud(seatId = SEAT): HonchoReadinessState {
  return {
    seatId,
    state: HONCHO_STATE_READY,
    serverUp: true,
    deriverReachable: true,
    branch: HONCHO_DERIVER_BRANCH_CLOUD,
    probedAt: new Date(NOW).toISOString(),
  };
}

describe('resolveHonchoDeriverRouteActive — default-deny gate', () => {
  it('true only for a ready+fresh cloud snapshot matching the active seat', () => {
    expect(resolveHonchoDeriverRouteActive(readyCloud(), SEAT, { now: NOW + 1000 })).toBe(true);
  });
  it('false for a LOCAL branch (local talks to Ollama directly, not this route)', () => {
    expect(
      resolveHonchoDeriverRouteActive({ ...readyCloud(), branch: HONCHO_DERIVER_BRANCH_LOCAL }, SEAT, { now: NOW })
    ).toBe(false);
  });
  it('false on a seat mismatch (snapshot for another seat can not activate here)', () => {
    expect(resolveHonchoDeriverRouteActive(readyCloud('other-seat'), SEAT, { now: NOW })).toBe(false);
  });
  it('false for an empty active seat', () => {
    expect(resolveHonchoDeriverRouteActive(readyCloud(), '', { now: NOW })).toBe(false);
    expect(resolveHonchoDeriverRouteActive(readyCloud(), undefined, { now: NOW })).toBe(false);
  });
  it('false when not ready (server down / deriver unreachable / cold)', () => {
    expect(resolveHonchoDeriverRouteActive({ ...readyCloud(), serverUp: false }, SEAT, { now: NOW })).toBe(false);
    expect(resolveHonchoDeriverRouteActive({ ...readyCloud(), deriverReachable: false }, SEAT, { now: NOW })).toBe(
      false
    );
    expect(resolveHonchoDeriverRouteActive({ ...readyCloud(), state: 'degraded' }, SEAT, { now: NOW })).toBe(false);
  });
  it('false when the snapshot is stale (crash between probe and read)', () => {
    expect(resolveHonchoDeriverRouteActive(readyCloud(), SEAT, { now: NOW + 60_000 })).toBe(false);
  });
  it('false for an undefined snapshot', () => {
    expect(resolveHonchoDeriverRouteActive(undefined, SEAT, { now: NOW })).toBe(false);
  });
});

describe('buildCommandEveShimHonchoDeriverRouteResolver — fail-closed resolver', () => {
  const baseDeps = () => ({
    functionUrl: FN_URL,
    readLicenseWire: () => FAKE_LICENSE,
    getActiveSeatId: () => SEAT,
    readHonchoSeatReady: (_s: string) => readyCloud(),
    now: () => NOW + 1000,
  });

  it('active path ⇒ { active, functionUrl, license } and NO tier', () => {
    const route = buildCommandEveShimHonchoDeriverRouteResolver(baseDeps())();
    expect(route.active).toBe(true);
    expect(route.functionUrl).toBe(FN_URL);
    expect(route.license).toBe(FAKE_LICENSE);
    expect(route).not.toHaveProperty('tier');
  });

  it('fail-closed { active:false } when the license is missing (no leak)', () => {
    const route = buildCommandEveShimHonchoDeriverRouteResolver({ ...baseDeps(), readLicenseWire: () => '' })();
    expect(route.active).toBe(false);
    expect(route.license).toBeUndefined();
  });

  it('fail-closed when the snapshot is not ready / seat mismatch', () => {
    const notReady = buildCommandEveShimHonchoDeriverRouteResolver({
      ...baseDeps(),
      readHonchoSeatReady: () => ({ ...readyCloud(), deriverReachable: false }),
    })();
    expect(notReady.active).toBe(false);
    const mismatch = buildCommandEveShimHonchoDeriverRouteResolver({
      ...baseDeps(),
      readHonchoSeatReady: () => readyCloud('other'),
    })();
    expect(mismatch.active).toBe(false);
  });

  it('fail-closed + onError when a dep throws (never egress on a read error)', () => {
    const onError = vi.fn();
    const route = buildCommandEveShimHonchoDeriverRouteResolver({
      ...baseDeps(),
      readHonchoSeatReady: () => {
        throw new Error('backend read failed');
      },
      onError,
    })();
    expect(route.active).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fail-closed even when onError ITSELF throws (Codex #4 — a logging failure must not egress)', () => {
    const route = buildCommandEveShimHonchoDeriverRouteResolver({
      ...baseDeps(),
      readHonchoSeatReady: () => {
        throw new Error('backend read failed');
      },
      onError: () => {
        throw new Error('sink blew up too');
      },
    });
    expect(() => route()).not.toThrow();
    expect(route().active).toBe(false);
  });

  it('when inactive, no license or url is present in the returned route', () => {
    const route = buildCommandEveShimHonchoDeriverRouteResolver({
      ...baseDeps(),
      readHonchoSeatReady: () => undefined,
    })();
    expect(JSON.stringify(route)).not.toContain('CEVE');
    expect(JSON.stringify(route)).not.toContain('unvbeothoimlzlolxucl');
  });
});
