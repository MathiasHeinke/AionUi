/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Final-audit regression (2026-07-05): the legacy-alias check must be CASE-FOLDED.
 * A crafted `SEAT-1` / `DEFAULT` used to read as NON-legacy (raw, case-sensitive)
 * yet sanitize to the legacy alias `seat-1` / `default` — a split-brain where the
 * SAME seat routed to `seats/seat-1/` via one check and the founder's legacy `home/`
 * via another (a per-seat-isolation violation onto the founder surface). These pin
 * that a reserved-alias case-variant is CONSISTENTLY the legacy seat everywhere,
 * while a real uuid seat stays fully isolated.
 */

import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import {
  LEGACY_SEAT_ID,
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  getActiveSeatId,
  isActiveSeatLegacy,
  isLegacySeatId,
  resolveSeatHome,
  sanitizeSeatId,
  setActiveSeatId,
} from '@/process/commandEve/seatContextCore';

const REAL_UUID = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const USER_DATA = '/tmp/seat-casefold-test';

afterEach(() => __resetActiveSeatForTests());

describe('legacy-alias case-folding (final-audit isolation fix)', () => {
  it('isLegacySeatId folds case: SEAT-1 / DEFAULT / Default / Seat-1 are all legacy', () => {
    for (const id of ['SEAT-1', 'Seat-1', 'DEFAULT', 'Default', 'default', 'seat-1', '  SEAT-1  ']) {
      expect(isLegacySeatId(id)).toBe(true);
    }
    expect(isLegacySeatId(REAL_UUID)).toBe(false);
    expect(isLegacySeatId('myclient')).toBe(false);
  });

  it('sanitizeSeatId folds a reserved-alias variant to the legacy id (not a real seat)', () => {
    expect(sanitizeSeatId('SEAT-1')).toBe(LEGACY_SEAT_ID);
    expect(sanitizeSeatId('DEFAULT')).toBe(LEGACY_SEAT_ID);
    // a genuine slug still sanitizes to itself (lower-cased)
    expect(sanitizeSeatId('MyClient')).toBe('myclient');
  });

  it('resolveSeatHome routes a crafted SEAT-1 to the LEGACY home (no seats/ segment) — no split-brain', () => {
    const crafted = resolveSeatHome(USER_DATA, 'SEAT-1');
    const legacy = resolveSeatHome(USER_DATA, 'seat-1');
    expect(crafted.legacy).toBe(true);
    expect(crafted.hermesHome).toBe(legacy.hermesHome);
    expect(crafted.hermesHome).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
    // a real seat is still fully seat-scoped + isolated
    const real = resolveSeatHome(USER_DATA, REAL_UUID);
    expect(real.legacy).toBe(false);
    expect(real.hermesHome).toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}${REAL_UUID}${path.sep}`);
  });

  it('setActiveSeatId(SEAT-1) is CONSISTENTLY the legacy seat (no active-home split-brain)', () => {
    setActiveSeatId('SEAT-1');
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);
    expect(isActiveSeatLegacy()).toBe(true);
  });
});
