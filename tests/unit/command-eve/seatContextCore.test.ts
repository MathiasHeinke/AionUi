/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ADVERSARIAL cross-seat leak / path-isolation tests for seatContextCore
 * (Phase 4 / ISO-1 / SEAT-TOOL-1, STEP 1).
 *
 * THE WORST FAILURE this guards against: seat A's agent reading seat B's
 * MEMORY.md / USER.md / state.db / connectors out of a shared or
 * traversal-escaped HERMES_HOME (DSGVO + the reseller trust thesis).
 *
 * Coverage:
 *  (a) BYTE-IDENTICAL legacy compat — default/undefined/null/''/'default'/
 *      'seat-1' resolve to EXACTLY the value the LIVE
 *      resolveCommandEveRuntimeBootstrapPaths(...).hermesHome produces. We assert
 *      against the REAL resolver's output, not a hand-copied string.
 *  (b) two DISTINCT seatIds → two NON-overlapping, non-prefixing homes, and
 *      neither equals the legacy home.
 *  (c) traversal / injection seatIds ('../x','a/b','/etc','..%2f', NUL-byte, '',
 *      'C:\\…', dotfiles, over-long) → rejected; never escape the seats/ subtree.
 *  (d) the same seatId is STABLE across calls; the active-seat holder defaults to
 *      legacy and round-trips safely.
 */

import { afterEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { resolveCommandEveRuntimeBootstrapPaths } from '@/process/commandEve/runtimeBootstrapCore';
import {
  LEGACY_SEAT_ID,
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  assertSeatId,
  clearActiveSeat,
  getActiveSeatId,
  hasCommandEvePaidArtifactOperationInFlight,
  isActiveSeatLegacy,
  isLegacySeatId,
  resolveActiveSeatHome,
  resolveSeatHermesHome,
  resolveSeatHome,
  sanitizeSeatId,
  setCommandEvePaidArtifactSeatRecoveryRequired,
  setActiveSeatId,
  tryBeginCommandEvePaidArtifactOperation,
  tryBeginCommandEvePaidArtifactSeatTransition,
} from '@/process/commandEve/seatContextCore';

const USER_DATA = '/tmp/command-eve-seat-test-userdata';
const REAL_UUID_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const REAL_UUID_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

afterEach(() => {
  __resetActiveSeatForTests();
});

describe('paid artifact / Seed transition fence', () => {
  it('mutually excludes a paid artifact and a Seed transition, with idempotent release', () => {
    const releaseArtifact = tryBeginCommandEvePaidArtifactOperation();
    expect(releaseArtifact).toBeTypeOf('function');
    expect(hasCommandEvePaidArtifactOperationInFlight()).toBe(true);
    expect(tryBeginCommandEvePaidArtifactSeatTransition()).toBeNull();

    releaseArtifact?.();
    releaseArtifact?.();
    expect(hasCommandEvePaidArtifactOperationInFlight()).toBe(false);

    const releaseTransition = tryBeginCommandEvePaidArtifactSeatTransition();
    expect(releaseTransition).toBeTypeOf('function');
    expect(tryBeginCommandEvePaidArtifactOperation()).toBeNull();
    releaseTransition?.();
    expect(tryBeginCommandEvePaidArtifactOperation()).toBeTypeOf('function');
  });

  it('the reservation primitive itself stays fail-closed during recovery', () => {
    setCommandEvePaidArtifactSeatRecoveryRequired(true);
    expect(tryBeginCommandEvePaidArtifactOperation()).toBeNull();
    setCommandEvePaidArtifactSeatRecoveryRequired(false);
    expect(tryBeginCommandEvePaidArtifactOperation()).toBeTypeOf('function');
  });
});

describe('(a) byte-identical legacy compatibility', () => {
  // The single source of truth: the LIVE resolver's hermesHome for this userData.
  const legacyHome = resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome;

  it.each([undefined, null, '', 'default', 'seat-1', LEGACY_SEAT_ID])(
    'seatId=%j resolves byte-identical to the live resolver hermesHome',
    (legacyId) => {
      const got = resolveSeatHome(USER_DATA, legacyId as string | null | undefined).hermesHome;
      expect(got).toBe(legacyHome);
      // And there is NO `seats/` segment injected for the legacy path.
      expect(got).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
    }
  );

  it('legacy home has the exact shipped <hermesRoot>/home shape', () => {
    const { hermesRoot, hermesHome, legacy } = resolveSeatHome(USER_DATA, undefined);
    expect(legacy).toBe(true);
    expect(hermesRoot).toBe(path.join(path.resolve(USER_DATA), 'command-eve-runtime', 'hermes'));
    expect(hermesHome).toBe(path.join(hermesRoot, 'home'));
    // Cross-check the live resolver agrees on hermesRoot too.
    expect(hermesRoot).toBe(resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesRoot);
  });

  it('the empty-userDataPath fallback matches the live resolver (same default precedence)', () => {
    const homeDir = os.homedir();
    const got = resolveSeatHome('', undefined, homeDir).hermesHome;
    const live = resolveCommandEveRuntimeBootstrapPaths('').hermesHome;
    expect(got).toBe(live);
  });

  it('the empty-userDataPath fallback matches live WITHOUT injecting homeDir (real prod default = os.homedir())', () => {
    // L1 regression guard: the resolver must default homeDir to os.homedir()
    // internally, so the un-injected branch equals the live resolver. (Before
    // the fix this returned a literal "~" segment and diverged.)
    const got = resolveSeatHome('', undefined).hermesHome;
    const live = resolveCommandEveRuntimeBootstrapPaths('').hermesHome;
    expect(got).toBe(live);
    expect(got).not.toContain('~');
  });

  it('resolveSeatHermesHome convenience matches resolveSeatHome().hermesHome', () => {
    expect(resolveSeatHermesHome(USER_DATA, undefined)).toBe(legacyHome);
    expect(resolveSeatHermesHome(USER_DATA, REAL_UUID_A)).toBe(resolveSeatHome(USER_DATA, REAL_UUID_A).hermesHome);
  });
});

describe('(b) two distinct seats → non-overlapping, non-prefixing homes', () => {
  const legacyHome = resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome;

  it('distinct seat ids give distinct homes under seats/', () => {
    const a = resolveSeatHome(USER_DATA, REAL_UUID_A).hermesHome;
    const b = resolveSeatHome(USER_DATA, REAL_UUID_B).hermesHome;

    expect(a).not.toBe(b);
    expect(a).toContain(path.join(SEATS_SUBDIR, REAL_UUID_A));
    expect(b).toContain(path.join(SEATS_SUBDIR, REAL_UUID_B));
  });

  it('neither real-seat home equals or is a prefix of the other (no containment leak)', () => {
    const a = resolveSeatHome(USER_DATA, REAL_UUID_A).hermesHome;
    const b = resolveSeatHome(USER_DATA, REAL_UUID_B).hermesHome;

    // A must not be a path-prefix of B, nor vice-versa — neither seat's tree can
    // contain the other's home.
    const aSeg = a + path.sep;
    const bSeg = b + path.sep;
    expect(b.startsWith(aSeg)).toBe(false);
    expect(a.startsWith(bSeg)).toBe(false);
  });

  it('a real-seat home is NEVER the legacy home and is strictly under hermesRoot/seats/', () => {
    const a = resolveSeatHome(USER_DATA, REAL_UUID_A);
    expect(a.hermesHome).not.toBe(legacyHome);
    expect(a.legacy).toBe(false);
    const seatsRoot = path.join(a.hermesRoot, SEATS_SUBDIR) + path.sep;
    expect(a.hermesHome.startsWith(seatsRoot)).toBe(true);
  });

  it('legacy home is NOT under seats/ so it cannot collide with any real seat', () => {
    const { hermesRoot } = resolveSeatHome(USER_DATA, undefined);
    const seatsRoot = path.join(hermesRoot, SEATS_SUBDIR) + path.sep;
    expect(legacyHome.startsWith(seatsRoot)).toBe(false);
  });
});

describe('(c) traversal / injection seatIds are rejected and can never escape seats/', () => {
  const seatsRoot = path.join(resolveSeatHome(USER_DATA, undefined).hermesRoot, SEATS_SUBDIR);

  const MALICIOUS: Array<[string, string]> = [
    ['parent traversal', '../x'],
    ['nested traversal', '../../etc/passwd'],
    ['subpath', 'a/b'],
    ['absolute posix', '/etc'],
    ['absolute file', '/etc/shadow'],
    ['backslash separator', 'a\\b'],
    ['windows drive', 'C:\\Windows'],
    ['url-encoded traversal', '..%2f'],
    ['url-encoded slash', '%2e%2e/'],
    ['dot-dot only', '..'],
    ['single dot', '.'],
    ['dotfile', '.hidden'],
    ['leading space', ' seat'],
    ['trailing space', 'seat '],
    ['tab', 'seat\tid'],
    ['newline', 'seat\nid'],
    ['too long (65 chars)', 'a'.repeat(65)],
    ['unicode separator-ish', 'seat⁄id'],
  ];

  it.each(MALICIOUS)('sanitizeSeatId rejects %s (%j) → null', (_label, bad) => {
    expect(sanitizeSeatId(bad)).toBeNull();
  });

  it('a REAL embedded NUL byte and interior whitespace are rejected', () => {
    expect(sanitizeSeatId('seat id')).toBeNull(); // interior whitespace
    expect(sanitizeSeatId('a\tb')).toBeNull();
    // A lone space TRIMS to empty -> treated as the LEGACY seat (not a real id,
    // not a reject): isLegacySeatId('') is true. Asserting that explicitly so the
    // legacy/reject boundary is unambiguous.
    expect(sanitizeSeatId(' ')).toBe(LEGACY_SEAT_ID);
    expect(sanitizeSeatId('se\u0000at')).toBeNull(); // real NUL
    expect(sanitizeSeatId('seat\u0000')).toBeNull();
    expect(sanitizeSeatId('\u0000' + REAL_UUID_A)).toBeNull();
    expect(() => assertSeatId('se\u0000at')).toThrow();
  });

  it('control characters are rejected (defense-in-depth, not just NUL)', () => {
    expect(sanitizeSeatId('seat\x01id')).toBeNull();
    expect(sanitizeSeatId('seat\x7fid')).toBeNull();
  });

  it.each(MALICIOUS)('resolveSeatHome throws on %s (%j) — never builds a path', (_label, bad) => {
    expect(() => resolveSeatHome(USER_DATA, bad)).toThrow();
  });

  it('assertSeatId throws on every malicious id', () => {
    for (const [, bad] of MALICIOUS) {
      expect(() => assertSeatId(bad)).toThrow();
    }
    expect(() => assertSeatId('seat id')).toThrow();
  });

  it('PROOF: even if a malicious id were forced through, no resolved home escapes seats/', () => {
    // Belt-and-suspenders: confirm the resolver throws (does not silently
    // produce an escaping path). If any malicious input ever DID return a path,
    // this asserts it would still be confined under seatsRoot.
    for (const [, bad] of MALICIOUS) {
      let home: string | null = null;
      try {
        home = resolveSeatHome(USER_DATA, bad).hermesHome;
      } catch {
        home = null; // rejected — the desired outcome
      }
      if (home !== null) {
        const normalized = path.resolve(home);
        // Would only reach here on a regression; if so, it must STILL be under seatsRoot.
        expect(normalized.startsWith(path.resolve(seatsRoot) + path.sep)).toBe(true);
      }
    }
  });

  it('empty string is treated as legacy (not a real seat) — no seats/ segment', () => {
    expect(isLegacySeatId('')).toBe(true);
    expect(sanitizeSeatId('')).toBe(LEGACY_SEAT_ID);
    expect(resolveSeatHome(USER_DATA, '').legacy).toBe(true);
  });
});

describe('(e) case-fold collision: a case-insensitive FS must not let two case-variant seats share a home', () => {
  // macOS (APFS) and Windows (NTFS) are case-insensitive-preserving: 'abc' and
  // 'ABC' would be two distinct seatId STRINGS but ONE on-disk directory. If the
  // resolver produced two distinct paths for them, seat A could read seat B's
  // MEMORY.md/USER.md/state.db — the exact cross-seat leak this step exists to
  // prevent. The sanitizer canonicalizes to lower-case so seat identity matches
  // the filesystem's notion of identity.
  it('mixed-case slug is canonicalized to lower-case (single seat identity)', () => {
    expect(sanitizeSeatId('ABC')).toBe('abc');
    expect(sanitizeSeatId('aBc')).toBe('abc');
    expect(sanitizeSeatId('Client_ACME-01')).toBe('client_acme-01');
  });

  it('case-variant slugs resolve to the SAME home (never two paths for one on-disk dir)', () => {
    const lower = resolveSeatHome(USER_DATA, 'abc').hermesHome;
    const upper = resolveSeatHome(USER_DATA, 'ABC').hermesHome;
    const mixed = resolveSeatHome(USER_DATA, 'aBc').hermesHome;
    expect(upper).toBe(lower);
    expect(mixed).toBe(lower);
  });

  it('a mixed-case UUID resolves to the SAME home as its lower-case form', () => {
    const upperUuid = REAL_UUID_A.toUpperCase();
    expect(sanitizeSeatId(upperUuid)).toBe(REAL_UUID_A);
    expect(resolveSeatHome(USER_DATA, upperUuid).hermesHome).toBe(resolveSeatHome(USER_DATA, REAL_UUID_A).hermesHome);
  });

  it('the active-seat holder canonicalizes case too (no case-variant bleed)', () => {
    setActiveSeatId('ABC');
    expect(getActiveSeatId()).toBe('abc');
    const viaActive = resolveActiveSeatHome(USER_DATA).hermesHome;
    expect(viaActive).toBe(resolveSeatHome(USER_DATA, 'abc').hermesHome);
  });
});

describe('(d) stability + active-seat holder', () => {
  it('the same seatId is stable across calls (deterministic)', () => {
    const first = resolveSeatHome(USER_DATA, REAL_UUID_A).hermesHome;
    const second = resolveSeatHome(USER_DATA, REAL_UUID_A).hermesHome;
    const third = resolveSeatHermesHome(USER_DATA, REAL_UUID_A);
    expect(first).toBe(second);
    expect(first).toBe(third);
  });

  it('accepts a canonical UUID and a conservative safe slug', () => {
    expect(sanitizeSeatId(REAL_UUID_A)).toBe(REAL_UUID_A);
    expect(sanitizeSeatId('client_acme-01')).toBe('client_acme-01');
    expect(sanitizeSeatId('a'.repeat(64))).toBe('a'.repeat(64)); // exactly 64 ok
    // case-fold: an UPPER-case slug is canonicalized to lower-case (see (e)).
    expect(sanitizeSeatId('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('active-seat holder defaults to the legacy seat (nothing changes until selected)', () => {
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);
    expect(isActiveSeatLegacy()).toBe(true);
    expect(resolveActiveSeatHome(USER_DATA).hermesHome).toBe(
      resolveCommandEveRuntimeBootstrapPaths(USER_DATA).hermesHome
    );
  });

  it('setActiveSeatId switches the active seat; resolveActiveSeatHome follows', () => {
    setActiveSeatId(REAL_UUID_A);
    expect(getActiveSeatId()).toBe(REAL_UUID_A);
    expect(isActiveSeatLegacy()).toBe(false);
    expect(resolveActiveSeatHome(USER_DATA).hermesHome).toBe(resolveSeatHome(USER_DATA, REAL_UUID_A).hermesHome);
  });

  it('setActiveSeatId throws on an unsafe id and leaves the active seat unchanged (fail-closed)', () => {
    setActiveSeatId(REAL_UUID_A);
    expect(() => setActiveSeatId('../escape')).toThrow();
    expect(getActiveSeatId()).toBe(REAL_UUID_A); // unchanged
  });

  it('setActiveSeatId(legacy alias) and clearActiveSeat reset to the legacy seat', () => {
    setActiveSeatId(REAL_UUID_A);
    expect(setActiveSeatId('default')).toBe(LEGACY_SEAT_ID);
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);

    setActiveSeatId(REAL_UUID_B);
    clearActiveSeat();
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);
  });

  it('two active-seat switches do not bleed: each resolves only its own home', () => {
    setActiveSeatId(REAL_UUID_A);
    const homeA = resolveActiveSeatHome(USER_DATA).hermesHome;
    setActiveSeatId(REAL_UUID_B);
    const homeB = resolveActiveSeatHome(USER_DATA).hermesHome;
    expect(homeA).not.toBe(homeB);
    expect(homeA).toContain(REAL_UUID_A);
    expect(homeB).toContain(REAL_UUID_B);
    expect(homeA).not.toContain(REAL_UUID_B);
    expect(homeB).not.toContain(REAL_UUID_A);
  });
});
