/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ADVERSARIAL per-seat CONFIG-KEY namespacing tests (Phase 4 / ISO-2).
 *
 * THE LEAK THIS GUARDS: after a seat switch, seat B must NOT read seat A's
 * `commandEve.clientSeeded` (or any allowlisted per-seat config flag). The pure
 * key-namespacing core is the seam; these tests pin:
 *  - LEGACY byte-identity (un-prefixed key — zero migration for 1.1.3 installs);
 *  - two real seats → two DISTINCT prefixed keys;
 *  - the install-global / seat-private split is the EXPLICIT allowlist;
 *  - a crafted seat id can NEVER become a key prefix (throws).
 */

import { describe, expect, it } from 'vitest';
import {
  LEGACY_SEAT_ID,
  SEAT_KEY_PREFIX,
  SEAT_SCOPED_CONFIG_KEYS,
  assertSeatId,
  isLegacySeatId,
  isSeatScopedConfigKey,
  sanitizeSeatId,
  seatScopedKey,
} from '@/common/config/seatConfigKeyCore';

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

describe('(a) legacy byte-identity — un-namespaced key, zero migration', () => {
  it.each([undefined, null, '', 'default', 'seat-1', LEGACY_SEAT_ID])(
    'legacy seat %s returns the key UNCHANGED',
    (seat) => {
      expect(seatScopedKey('commandEve.clientSeeded', seat as string | null | undefined)).toBe(
        'commandEve.clientSeeded'
      );
      expect(seatScopedKey('commandEve.teamWorkerStatus', seat as string | null | undefined)).toBe(
        'commandEve.teamWorkerStatus'
      );
    }
  );
});

describe('(b) cross-seat fence — two seats → two distinct keys', () => {
  it('seat A and seat B produce DISTINCT prefixed keys for the same logical key', () => {
    const a = seatScopedKey('commandEve.clientSeeded', SEAT_A);
    const b = seatScopedKey('commandEve.clientSeeded', SEAT_B);
    expect(a).toBe(`${SEAT_KEY_PREFIX}${SEAT_A}:commandEve.clientSeeded`);
    expect(b).toBe(`${SEAT_KEY_PREFIX}${SEAT_B}:commandEve.clientSeeded`);
    expect(a).not.toBe(b);
    // Neither equals the legacy (un-prefixed) key — so a real seat can never read
    // the legacy/seat-1 row and vice-versa.
    expect(a).not.toBe('commandEve.clientSeeded');
    expect(b).not.toBe('commandEve.clientSeeded');
  });

  it('repeats for teamWorkerStatus, executionMode, and cloud visual policy', () => {
    for (const key of [
      'commandEve.teamWorkerStatus',
      'commandEve.executionMode',
      'commandEve.cloudVisualAnalysisEnabled',
    ]) {
      const a = seatScopedKey(key, SEAT_A);
      const b = seatScopedKey(key, SEAT_B);
      expect(a).not.toBe(b);
      expect(a.startsWith(`${SEAT_KEY_PREFIX}${SEAT_A}:`)).toBe(true);
      expect(b.startsWith(`${SEAT_KEY_PREFIX}${SEAT_B}:`)).toBe(true);
    }
  });

  it('keeps the legacy owner visual policy key unprefixed', () => {
    expect(seatScopedKey('commandEve.cloudVisualAnalysisEnabled', LEGACY_SEAT_ID)).toBe(
      'commandEve.cloudVisualAnalysisEnabled'
    );
  });
});

describe('(c) the allowlist is explicit + auditable', () => {
  it('exposes exactly the 11 per-seat keys', () => {
    // Pinned on purpose: adding or removing a key here has to be a decision
    // somebody made, not a diff nobody noticed. 1.820 adds the approval grant —
    // a command one client approved must never be pre-approved inside another
    // client's seat.
    //
    // MAT-1749 adds `commandEve.maxEntitled`: the renderer publishes the seat's
    // proven MAX entitlement so the MAIN process can apply the non-brick clamp
    // without a network read on the per-turn hot path. It is seat-scoped for the
    // same reason the selection is — a founder seat with a paid plan must never
    // leak MAX entitlement into a client seat that has none.
    //
    // 1.820.1 REMOVES `commandEve.churnSignal` (11 → 10). It existed to reveal a
    // hidden 49 € "Solo" save-offer plan; that plan is deleted by Founder ruling
    // and nothing ever read the flag.
    //
    // MAT-1769 adds `commandEve.imageModelPreference` (10 → 11): the managed
    // image model choice is per seat — one client's MAX must never become
    // another client's bill.
    //
    // MAT-1769 (native Vision enablement) adds `commandEve.visionEnablementDeclined`
    // (11 → 12): the one-time in-chat decline marker is per seat, so one client
    // seat's "Nicht jetzt" never silences the prompt in a sibling seat.
    expect([...SEAT_SCOPED_CONFIG_KEYS].toSorted()).toEqual(
      [
        'commandEve.authority',
        'commandEve.clientSeedDismissed',
        'commandEve.cloudVisualAnalysisEnabled',
        'commandEve.clientSeeded',
        'commandEve.egressRedactionMode',
        'commandEve.executionMode',
        'commandEve.imageModelPreference',
        'commandEve.inferenceSelection',
        'commandEve.maxEntitled',
        'commandEve.teamWorkerStatus',
        'commandEve.valueReceiptHourlyEur',
        'commandEve.visionEnablementDeclined',
      ].toSorted()
    );
  });

  it('the retired 49 € save-offer flag cannot come back by allowlist (1.820.1)', () => {
    // A structural assertion, not a behaviour one: `commandEve.churnSignal` gated a
    // hidden Solo-49 plan into the pricing list. Re-adding the key here is how the
    // dead plan would quietly get seat-scoped storage again before anyone noticed
    // the price copy came with it.
    expect(SEAT_SCOPED_CONFIG_KEYS.has('commandEve.churnSignal')).toBe(false);
    expect(isSeatScopedConfigKey('commandEve.churnSignal')).toBe(false);
  });

  it('install-global keys are NOT seat-scoped', () => {
    for (const key of [
      'theme.activeId',
      'language',
      'webui.desktop.enabled',
      'css.activeThemeId',
      'commandEve.spendCapEurCents',
    ]) {
      expect(isSeatScopedConfigKey(key)).toBe(false);
    }
  });

  it('every allowlisted key is seat-scoped', () => {
    for (const key of SEAT_SCOPED_CONFIG_KEYS) {
      expect(isSeatScopedConfigKey(key)).toBe(true);
    }
  });
});

describe('(d) path-traversal / injection — a crafted id can NEVER become a key prefix', () => {
  it.each([
    '../../etc',
    '..',
    'a/b',
    'a\\b',
    '/abs',
    'C:\\x',
    'foo\0bar',
    '.hidden',
    ' lead',
    'trail ',
    'x'.repeat(65),
  ])('rejects %s (sanitize→null, seatScopedKey→throws, assertSeatId→throws)', (bad) => {
    expect(sanitizeSeatId(bad)).toBeNull();
    expect(() => seatScopedKey('commandEve.clientSeeded', bad)).toThrow();
    expect(() => assertSeatId(bad)).toThrow();
  });

  it('a valid slug / uuid is accepted and lower-cased', () => {
    expect(sanitizeSeatId('Client-Acme_01')).toBe('client-acme_01');
    expect(sanitizeSeatId(SEAT_A.toUpperCase())).toBe(SEAT_A);
  });
});

describe('(e) legacy detection', () => {
  it.each([undefined, null, '', '  ', 'default', 'seat-1'])('treats %s as legacy', (seat) => {
    expect(isLegacySeatId(seat as string | null | undefined)).toBe(true);
  });
  it('a real id is not legacy', () => {
    expect(isLegacySeatId(SEAT_A)).toBe(false);
  });
});

describe('legacy-alias case-folding (final-audit config-key isolation fix)', () => {
  it('a reserved-alias case-variant is legacy → an UN-prefixed key (no seat:seat-1: split-brain)', () => {
    for (const id of ['SEAT-1', 'Seat-1', 'DEFAULT', 'Default']) {
      expect(isLegacySeatId(id)).toBe(true);
      expect(sanitizeSeatId(id)).toBe(LEGACY_SEAT_ID);
      // the config key for a crafted SEAT-1 is the SAME un-prefixed key the real
      // legacy seat uses — never a distinct `seat:seat-1:` namespace.
      expect(seatScopedKey('commandEve.teamWorkerStatus', id)).toBe(
        seatScopedKey('commandEve.teamWorkerStatus', 'seat-1')
      );
      expect(seatScopedKey('commandEve.teamWorkerStatus', id)).not.toContain(SEAT_KEY_PREFIX);
    }
    // a real uuid seat still gets its own namespaced key
    expect(seatScopedKey('commandEve.teamWorkerStatus', SEAT_A)).toContain(`${SEAT_KEY_PREFIX}${SEAT_A}`);
  });
});
