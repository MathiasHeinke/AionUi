/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 — resolveDegradedAdminAccess: the honest DEGRADED admin posture the
 * renderer falls back to when the my-seats read fails but local main-derived
 * evidence says the account is an admin (the founder's invisible-rail fix).
 *
 * Invariants asserted here:
 *  - exactly ONE seat — the install's OWN active seat — never a fabricated or
 *    stale wire seat;
 *  - canSwitch=false ALWAYS (no live seat list ⇒ no switch targets);
 *  - the legacy home renders as the Founder chip ('Founder', own_company);
 *  - a client seat shows its cached name when threaded, else its raw id (honest,
 *    never invented);
 *  - an unsafe/unsanitizable id folds to the legacy founder home (fail-safe).
 */

import { describe, expect, it } from 'vitest';
import { LEGACY_SEAT_ID, resolveDegradedAdminAccess } from '@process/commandEve/seatSwitchCore';

const SEAT_ALOIS = '11111111-1111-1111-1111-111111111111';

describe('resolveDegradedAdminAccess — MAT-1773 degraded admin posture', () => {
  it('the legacy home renders as the Founder chip (own_company, admin, active)', () => {
    const access = resolveDegradedAdminAccess(LEGACY_SEAT_ID);
    expect(access.role).toBe('admin');
    expect(access.canSwitch).toBe(false);
    expect(access.pinnedSeatId).toBe(LEGACY_SEAT_ID);
    expect(access.activeSeatId).toBe(LEGACY_SEAT_ID);
    expect(access.seats).toHaveLength(1);
    expect(access.seats[0]).toEqual({
      seat_id: LEGACY_SEAT_ID,
      name: 'Founder',
      kind: 'own_company',
      role: 'admin',
      is_active: true,
    });
  });

  it('a client seat shows its cached snapshot name when threaded', () => {
    const access = resolveDegradedAdminAccess(SEAT_ALOIS, 'Alois');
    expect(access.seats).toHaveLength(1);
    expect(access.seats[0].seat_id).toBe(SEAT_ALOIS);
    expect(access.seats[0].name).toBe('Alois');
    expect(access.seats[0].kind).toBe('client');
    expect(access.canSwitch).toBe(false);
  });

  it('a client seat WITHOUT a cached name shows its raw id (honest, never fabricated)', () => {
    const access = resolveDegradedAdminAccess(SEAT_ALOIS, null);
    expect(access.seats[0].name).toBe(SEAT_ALOIS);
  });

  it('a legacy home keeps the Founder name even when a stale name is threaded', () => {
    const access = resolveDegradedAdminAccess('seat-1', 'Alois');
    expect(access.seats[0].name).toBe('Founder');
  });

  it('an unsafe id folds to the legacy founder home (never becomes a path segment)', () => {
    const access = resolveDegradedAdminAccess('../etc/passwd');
    expect(access.activeSeatId).toBe(LEGACY_SEAT_ID);
    expect(access.seats[0].seat_id).toBe(LEGACY_SEAT_ID);
    expect(access.seats[0].name).toBe('Founder');
  });
});
