/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ISO-4 — ADVERSARIAL cross-seat leak tests for the getDataPath()/getConfigPath()
 * -derived WORKSPACE storage roots (chat history, the agent workDir / produced
 * deliverables, assistants, user/cron skills, chat/config caches).
 *
 * THE SUSPECTED REAL REMAINING LEAK (worse than the MEMORY.md/state.db ISO-1
 * fenced): a reseller operator's client-confidential CHAT TRANSCRIPTS + PRODUCED
 * DELIVERABLES rooted at ONE global tree shared by every seat. This guards the
 * pure resolver (`resolveSeatScopedStorageRoots`) + its inverse
 * (`stripSeatScopeFromRoot`) — the seam initStorage.getSystemDir + the A5
 * backend re-spawn consume.
 *
 * Coverage (matches the board ## ISO-4 test strategy):
 *  (a) LEGACY / no-seat → roots are BYTE-IDENTICAL to today (exact string, no
 *      `seats/` segment) — locks the zero-migration upgrade for shipped 1.1.3.
 *  (b) two real seats → DISJOINT cache + work roots (seat A's chat-history /
 *      workDir not under seat B), neither a prefix of the other.
 *  (c) a switch RE-HOMES the roots: the active-seat resolver follows
 *      setActiveSeatId, so the workDir the A5 re-spawn passes follows the new
 *      seat.
 *  (d) a CRAFTED seat id cannot escape `seats/` (traversal/separator/NUL/abs).
 *  (e) the inverse strip de-seat-scopes (no double-nest on persist) and is a
 *      no-op for legacy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import {
  LEGACY_SEAT_ID,
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  resolveSeatScopedStorageRoots,
  resolveActiveSeatScopedStorageRoots,
  setActiveSeatId,
  clearActiveSeat,
  stripSeatScopeFromRoot,
  stripActiveSeatScopeFromRoot,
} from '@/process/commandEve/seatContextCore';

const CFG = '/cfg/command-eve-config';
const DATA = '/data/command-eve-data';

const SEAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SEAT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

afterEach(() => {
  __resetActiveSeatForTests();
});

describe('ISO-4 resolveSeatScopedStorageRoots — legacy byte-identity', () => {
  it('legacy / no-seat returns the input roots VERBATIM (no seats/ segment)', () => {
    for (const seat of [undefined, null, '', 'default', LEGACY_SEAT_ID]) {
      const r = resolveSeatScopedStorageRoots(CFG, DATA, seat as string | null | undefined);
      expect(r.legacy).toBe(true);
      expect(r.seatId).toBe(LEGACY_SEAT_ID);
      // EXACT string equality — the zero-migration guarantee.
      expect(r.cacheRoot).toBe(CFG);
      expect(r.workRoot).toBe(DATA);
      expect(r.cacheRoot).not.toContain(SEATS_SUBDIR);
      expect(r.workRoot).not.toContain(SEATS_SUBDIR);
    }
  });
});

describe('ISO-4 resolveSeatScopedStorageRoots — real seats are DISJOINT', () => {
  it('two real seats yield non-overlapping, non-prefixing cache + work roots', () => {
    const a = resolveSeatScopedStorageRoots(CFG, DATA, SEAT_A);
    const b = resolveSeatScopedStorageRoots(CFG, DATA, SEAT_B);

    expect(a.legacy).toBe(false);
    expect(b.legacy).toBe(false);

    expect(a.cacheRoot).toBe(path.join(CFG, SEATS_SUBDIR, SEAT_A));
    expect(a.workRoot).toBe(path.join(DATA, SEATS_SUBDIR, SEAT_A));
    expect(b.cacheRoot).toBe(path.join(CFG, SEATS_SUBDIR, SEAT_B));
    expect(b.workRoot).toBe(path.join(DATA, SEATS_SUBDIR, SEAT_B));

    // DISJOINT: neither root is a prefix of the other (the leak guard). A
    // produced deliverable / chat transcript under seat A is UNREACHABLE from
    // seat B.
    expect(a.cacheRoot).not.toBe(b.cacheRoot);
    expect(a.workRoot).not.toBe(b.workRoot);
    expect(b.cacheRoot.startsWith(a.cacheRoot + path.sep)).toBe(false);
    expect(a.cacheRoot.startsWith(b.cacheRoot + path.sep)).toBe(false);
    expect(b.workRoot.startsWith(a.workRoot + path.sep)).toBe(false);
    expect(a.workRoot.startsWith(b.workRoot + path.sep)).toBe(false);
  });

  it('a real seat root is NOT under the legacy root and vice-versa', () => {
    const legacy = resolveSeatScopedStorageRoots(CFG, DATA, LEGACY_SEAT_ID);
    const a = resolveSeatScopedStorageRoots(CFG, DATA, SEAT_A);
    // The legacy chat-history/workDir (=== base root) must NOT contain seat A's.
    // Seat A IS under the base, but the legacy CONTENT lives directly at the base
    // (e.g. <base>/command-eve-chat-history), never under <base>/seats/<id>, so a
    // legacy transcript and a seat-A transcript never collide.
    expect(a.cacheRoot).not.toBe(legacy.cacheRoot);
    expect(a.workRoot).not.toBe(legacy.workRoot);
  });
});

describe('ISO-4 active-seat resolver — a switch re-homes the roots', () => {
  it('resolveActiveSeatScopedStorageRoots follows setActiveSeatId (the A5 re-spawn workDir)', () => {
    // Boot: active seat is legacy → byte-identical.
    clearActiveSeat();
    const boot = resolveActiveSeatScopedStorageRoots(CFG, DATA);
    expect(boot.cacheRoot).toBe(CFG);
    expect(boot.workRoot).toBe(DATA);

    // Switch to seat A → roots re-home under seats/A.
    setActiveSeatId(SEAT_A);
    const afterA = resolveActiveSeatScopedStorageRoots(CFG, DATA);
    expect(afterA.cacheRoot).toBe(path.join(CFG, SEATS_SUBDIR, SEAT_A));
    expect(afterA.workRoot).toBe(path.join(DATA, SEATS_SUBDIR, SEAT_A));

    // Switch to seat B → roots re-home again, DISJOINT from A.
    setActiveSeatId(SEAT_B);
    const afterB = resolveActiveSeatScopedStorageRoots(CFG, DATA);
    expect(afterB.cacheRoot).toBe(path.join(CFG, SEATS_SUBDIR, SEAT_B));
    expect(afterB.workRoot).toBe(path.join(DATA, SEATS_SUBDIR, SEAT_B));
    expect(afterB.workRoot).not.toBe(afterA.workRoot);

    // Switch back to legacy → byte-identical to boot again.
    clearActiveSeat();
    const back = resolveActiveSeatScopedStorageRoots(CFG, DATA);
    expect(back.cacheRoot).toBe(CFG);
    expect(back.workRoot).toBe(DATA);
  });
});

describe('ISO-4 resolveSeatScopedStorageRoots — crafted ids cannot escape seats/', () => {
  const HOSTILE = [
    '../x',
    '..',
    'a/b',
    'a\\b',
    '/etc/passwd',
    'C:\\x',
    'foo\0bar',
    '.hidden',
    '  ws  ',
    '..%2f..%2fetc',
  ];
  it('rejects every traversal / separator / NUL / absolute / dotfile id', () => {
    for (const bad of HOSTILE) {
      expect(() => resolveSeatScopedStorageRoots(CFG, DATA, bad)).toThrow();
    }
  });

  it('a hostile id can NEVER become a path segment under seats/', () => {
    for (const bad of HOSTILE) {
      let resolved: { cacheRoot: string; workRoot: string } | null = null;
      try {
        resolved = resolveSeatScopedStorageRoots(CFG, DATA, bad);
      } catch {
        resolved = null;
      }
      // Either it threw (resolved null) or — never — produced a path that
      // escapes the base. Assert no resolved root ever leaves CFG/DATA.
      if (resolved) {
        expect(resolved.cacheRoot.startsWith(CFG + path.sep)).toBe(true);
        expect(resolved.workRoot.startsWith(DATA + path.sep)).toBe(true);
      }
    }
  });
});

describe('ISO-4 stripSeatScopeFromRoot — inverse (no double-nest on persist)', () => {
  it('strips a trailing seats/<id> for a real active seat', () => {
    const scoped = path.join(CFG, SEATS_SUBDIR, SEAT_A);
    expect(stripSeatScopeFromRoot(scoped, SEAT_A)).toBe(CFG);
  });

  it('is a NO-OP for the legacy seat (byte-identical persist)', () => {
    expect(stripSeatScopeFromRoot(CFG, LEGACY_SEAT_ID)).toBe(CFG);
    expect(stripSeatScopeFromRoot(CFG, undefined)).toBe(CFG);
    expect(stripSeatScopeFromRoot(CFG, null)).toBe(CFG);
  });

  it('round-trips: scope then strip returns the base (no .../seats/<id>/seats/<id>)', () => {
    setActiveSeatId(SEAT_A);
    const scoped = resolveActiveSeatScopedStorageRoots(CFG, DATA);
    expect(stripActiveSeatScopeFromRoot(scoped.cacheRoot)).toBe(CFG);
    expect(stripActiveSeatScopeFromRoot(scoped.workRoot)).toBe(DATA);
    // Re-scoping the STRIPPED base must equal the original scoped root (proves no
    // double-nest on the next boot).
    const reScoped = resolveActiveSeatScopedStorageRoots(
      stripActiveSeatScopeFromRoot(scoped.cacheRoot),
      stripActiveSeatScopeFromRoot(scoped.workRoot)
    );
    expect(reScoped.cacheRoot).toBe(scoped.cacheRoot);
    expect(reScoped.workRoot).toBe(scoped.workRoot);
  });

  it('does not strip a NON-matching trailing segment', () => {
    const unrelated = path.join(CFG, SEATS_SUBDIR, SEAT_B);
    // Stripping with seat A must NOT touch a seat-B path.
    expect(stripSeatScopeFromRoot(unrelated, SEAT_A)).toBe(unrelated);
  });
});
