/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-624 Inc.3 — O3 shim deriver-route WIRING (H-INT-1/2/3). Proves the exact
 * chain index.ts wires end-to-end against the REAL readiness-file writer:
 *   resolveHonchoHomeForSeat  →  writeHonchoReadyState  →  readHonchoReadyState
 *   →  buildCommandEveShimHonchoDeriverRouteResolver  →  { active }
 *
 * The critical invariant is H-INT-2 PATH IDENTITY: the shim reader must read the
 * SAME `<hermesHome>/honcho/honcho-readiness.json` the writer wrote, or the deriver
 * lane is permanently inert (a silent dead feature). Both sides go through the ONE
 * `resolveHonchoHomeForSeat`, so this test writes via that path and reads back
 * through the resolver built the same way index.ts builds it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveHonchoHomeForSeat } from '@/process/commandEve/honchoRuntimeConfigCore';
import { HONCHO_DERIVER_BRANCH_CLOUD, HONCHO_DERIVER_BRANCH_LOCAL } from '@/process/commandEve/honchoRuntimeConfigCore';
import { writeHonchoReadyState, readHonchoReadyState } from '@/process/commandEve/honchoReadyStateFile';
import { reduceHonchoReadiness } from '@/process/commandEve/honchoReadinessCore';
import { buildCommandEveShimHonchoDeriverRouteResolver } from '@/process/commandEve/honchoDeriverRouteCore';

const REAL_UUID_A = '11111111-1111-4111-8111-111111111111';
const REAL_UUID_B = '22222222-2222-4222-8222-222222222222';

let USER_DATA = '';
const roots: string[] = [];

/** Build the shim resolver EXACTLY as index.ts's factory does (minus electron). */
function buildResolver(activeSeatId: string, license: string, now: number) {
  return buildCommandEveShimHonchoDeriverRouteResolver({
    functionUrl: 'https://unvbeothoimlzlolxucl.functions.supabase.co/eve-inference',
    readLicenseWire: () => license,
    getActiveSeatId: () => activeSeatId,
    readHonchoSeatReady: (seatId: string) => {
      const home = resolveHonchoHomeForSeat(USER_DATA, seatId);
      return home ? readHonchoReadyState(home) : undefined;
    },
    now: () => now,
  });
}

/** A fresh, READY, cloud-branch snapshot for a seat (probedAt = now). */
function writeReadyCloud(seatId: string, now: number): void {
  const home = resolveHonchoHomeForSeat(USER_DATA, seatId)!;
  writeHonchoReadyState(home, reduceHonchoReadiness({ provisioned: true, serverProbe: { ok: true }, deriverProbe: { ok: true }, seatId, branch: HONCHO_DERIVER_BRANCH_CLOUD, now }));
}

beforeEach(() => {
  USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'honcho-inc3-wiring-'));
  roots.push(USER_DATA);
});
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('COMPA-624 Inc.3 — H-INT-2 honcho-home path identity', () => {
  it('resolveHonchoHomeForSeat is deterministic + under the seat hermes home', () => {
    const a1 = resolveHonchoHomeForSeat(USER_DATA, REAL_UUID_A);
    const a2 = resolveHonchoHomeForSeat(USER_DATA, REAL_UUID_A);
    expect(a1).toBeTruthy();
    expect(a1).toBe(a2);
    expect(a1).toContain(`${path.sep}honcho`);
    expect(a1).toContain(`${path.sep}seats${path.sep}${REAL_UUID_A}${path.sep}`);
  });

  it('two seats get DISJOINT honcho homes (isolation)', () => {
    expect(resolveHonchoHomeForSeat(USER_DATA, REAL_UUID_A)).not.toBe(resolveHonchoHomeForSeat(USER_DATA, REAL_UUID_B));
  });

  it('an unsafe seat id resolves to undefined (fail-soft, not a throw)', () => {
    expect(resolveHonchoHomeForSeat(USER_DATA, '../../etc/passwd')).toBeUndefined();
  });

  it('write→read round-trips through the SAME resolved home (the reader sees the writer)', () => {
    const now = 1_700_000_000_000;
    writeReadyCloud(REAL_UUID_A, now);
    const home = resolveHonchoHomeForSeat(USER_DATA, REAL_UUID_A)!;
    const back = readHonchoReadyState(home);
    expect(back?.seatId).toBe(REAL_UUID_A);
    expect(back?.state).toBe('ready');
    expect(back?.branch).toBe(HONCHO_DERIVER_BRANCH_CLOUD);
  });
});

describe('COMPA-624 Inc.3 — H-INT-3 the shim route is inert until a fresh ready snapshot', () => {
  it('NO readiness file ⇒ inert (active:false) — byte-identical to before the lane', () => {
    const route = buildResolver(REAL_UUID_A, 'CEVE.v1.somewire', 1_700_000_000_000)();
    expect(route.active).toBe(false);
    expect(route.functionUrl).toBeUndefined();
    expect(route.license).toBeUndefined();
  });

  it('a fresh READY cloud snapshot + a license ⇒ ACTIVE (url + license, NO tier)', () => {
    const now = 1_700_000_000_000;
    writeReadyCloud(REAL_UUID_A, now);
    const route = buildResolver(REAL_UUID_A, 'CEVE.v1.somewire', now)();
    expect(route.active).toBe(true);
    expect(route.functionUrl).toContain('eve-inference');
    expect(route.license).toBe('CEVE.v1.somewire');
    // The money invariant: the route carries NO tier (the shim forces free 'standard').
    expect((route as Record<string, unknown>).tier).toBeUndefined();
  });

  it('ready but NO license ⇒ inert (deriver can not authenticate)', () => {
    const now = 1_700_000_000_000;
    writeReadyCloud(REAL_UUID_A, now);
    expect(buildResolver(REAL_UUID_A, '', now)().active).toBe(false);
  });

  it('a stale ready snapshot (older than the freshness window) ⇒ inert', () => {
    const probed = 1_700_000_000_000;
    writeReadyCloud(REAL_UUID_A, probed);
    // read 60s later — well beyond the 15s freshness guard
    expect(buildResolver(REAL_UUID_A, 'CEVE.v1.wire', probed + 60_000)().active).toBe(false);
  });

  it("seat A can NOT activate off seat B's snapshot (isolation)", () => {
    const now = 1_700_000_000_000;
    writeReadyCloud(REAL_UUID_B, now); // only B is ready
    expect(buildResolver(REAL_UUID_A, 'CEVE.v1.wire', now)().active).toBe(false);
  });

  it('a LOCAL-branch snapshot never rides the cloud deriver route', () => {
    const now = 1_700_000_000_000;
    const home = resolveHonchoHomeForSeat(USER_DATA, REAL_UUID_A)!;
    writeHonchoReadyState(home, reduceHonchoReadiness({ provisioned: true, serverProbe: { ok: true }, deriverProbe: { ok: true }, seatId: REAL_UUID_A, branch: HONCHO_DERIVER_BRANCH_LOCAL, now }));
    expect(buildResolver(REAL_UUID_A, 'CEVE.v1.wire', now)().active).toBe(false);
  });
});
