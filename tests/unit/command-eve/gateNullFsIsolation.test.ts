/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GATE-NULL — FILESYSTEM ISOLATION MATRIX (Founder-Decision D2, part 1).
 * =====================================================================
 *
 * WHAT THIS IS. A single, named CI suite that proves the FILESYSTEM half of the
 * per-seat isolation product-promise (per-client-seat DSGVO): for N distinct real
 * seats, seat A can NEVER — through the REAL resolvers/writers the running desktop
 * uses — reach, write into, or read out of seat B's on-disk world. It drives the
 * ECHTE cores (no fixture twins — the storeSplitGuard discipline) against fresh OS
 * tmp directories (mkdtemp; NEVER a real home) and asserts six invariants, each in
 * its own describe block with a plain-language header ("Seat A cannot X of Seat B").
 *
 * Suite name carries 'GATE-NULL' so a Required-Check can grep it. The named
 * package.json entry is `npm run test:gate-null` (globs tests/unit/command-eve/
 * gateNull*.test.ts) so the release checklist has ONE named door.
 *
 * THE SIX INVARIANTS (each = one describe block):
 *   1. PATH-DISJUNKTHEIT   — N=3 seats' hermesHome / cacheRoot / workRoot /
 *      kanban.db / company-brain roots are PAIRWISE disjoint (no path is a prefix
 *      of another seat's path).
 *   2. TRAVERSAL-HÄRTE     — every id-accepting resolver/writer REJECTS crafted ids
 *      ('../x', 'a/../b', absolute, '..', URL-encoded, NUL, 65+ chars, case-bypass):
 *      it either throws or the produced path stays under the expected seat root.
 *   3. WRITE-CONTAINMENT   — provision + company-brain writes + seed write + USER.md
 *      stamp for seat A touch ONLY seat A's root: seat B's root is byte-identical
 *      before/after (recursive dir diff is empty).
 *   4. READ-CONTAINMENT    — company-brain list/read + seed read + §SEAT stamp on
 *      seat B see NOTHING of seat A after A is populated.
 *   5. CONFIG-NAMESPACE    — seatScopedKey over the WHOLE SEAT_SCOPED_CONFIG_KEYS
 *      allowlist: two seats' physical keys never collide, and A's keys never carry
 *      B's id (no cross-seat cache leak — the 1.3 mechanism).
 *   6. ENV-HYGIENE (H3)    — the real prepareCommandEveRuntimeProcessEnv bake NEVER
 *      writes a clear seat label into child-process env, and HERMES_KANBAN_BOARD is
 *      symmetrically deleted. Re-uses the exported bake (no duplicate logic); the
 *      full switch/rollback env matrix lives in seatContextBridgeEnvTrio.test.ts.
 *
 * SCOPE / HONESTY. This is the FILESYSTEM half only. Part 2 — the DB/RLS
 * cross-tenant DENIAL MATRIX on a prod-schema clone — is a SEPARATE, still-open
 * piece (Founder-Decision D2 part 2) and is NOT re-implemented here. It, plus the
 * end-to-end two-seat surface proof, live elsewhere:
 *   - tests/unit/command-eve/seatIsolationGateNull.test.ts (ISO-8 surface + inject-a-leak)
 *   - supabase/tests/*_isolation_bleed_test.sql + migration-lint.sh (the ACCESS half)
 * GATE-NULL = filesystem(this) + access(main-repo RLS, part 2).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── The REAL cores (same seams the running desktop uses) ────────────────────────
import {
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  assertSeatId,
  getActiveSeatId,
  resolveSeatHome,
  resolveSeatScopedStorageRoots,
  setActiveSeatId,
  setActiveSeatKind,
  setActiveSeatLabel,
} from '@/process/commandEve/seatContextCore';
import { SEAT_SCOPED_CONFIG_KEYS, seatScopedKey } from '@/common/config/seatConfigKeyCore';
import {
  COMPANY_BRAIN_DIR,
  readCompanyBrainSeedStateFromHome,
  writeCompanyBrainSeedToHome,
} from '@/process/commandEve/companyBrainSeedCore';
import {
  listEntries,
  readEntryBody,
  removeEntry,
  upsertEntry,
} from '@/process/commandEve/companyBrainStoreCore';
import {
  provisionSeatRuntimeFiles,
  resolveCommandEveRuntimeBootstrapPaths,
  prepareCommandEveRuntimeProcessEnv,
} from '@/process/commandEve/runtimeBootstrapCore';
import { stampUserMdTiers } from '@/process/commandEve/userMdTierStampCore';
import type { RuntimeBootstrapIdentityProfile } from '@/process/commandEve/runtimeBootstrapCore';

// ── Three DISTINCT real seats: the legacy/founder seat + two client UUIDs ────────
// Each client carries a recognizable tracer entity so any leak surfaces as one
// seat's private token appearing under another seat's resolved value.
const SEAT_LEGACY = 'seat-1';
const SEAT_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const SEAT_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const ALL_SEATS = [SEAT_LEGACY, SEAT_A, SEAT_B] as const;

const ENTITY_A = 'ACME-Steuerberatung-Alpha-GmbH'; // seat A's client — never under B
const ENTITY_B = 'Beta-Medspa-Bravo-AG'; // seat B's client — never under A
const A_TRACER = `secret-A-${SEAT_A}`;
const B_TRACER = `secret-B-${SEAT_B}`;

const FALLBACK_PROFILE: RuntimeBootstrapIdentityProfile = {
  version: 'command-eve-first-run-profile/v0',
  source: 'unverified',
  confidence: 'placeholder',
  needs_confirmation: true,
  updated_at: '',
};

// ── tmp-root bookkeeping (mkdtemp under OS tmp; NEVER a real home) ────────────────
const tempRoots: string[] = [];
const makeUserData = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-null-fs-iso-'));
  tempRoots.push(root);
  return root;
};

// The active-seat holder is a process-global; keep it hermetic so this file can
// never leak a non-legacy active seat into another vitest worker's test file.
beforeEach(() => {
  __resetActiveSeatForTests();
});
afterEach(() => {
  __resetActiveSeatForTests();
});
afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when `child` is at or below `parent` (identical, or a proper descendant). */
const isPrefixPath = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent + path.sep);

/**
 * Capture the seat-scoped FILESYSTEM roots a seat resolves to, using the REAL
 * resolvers. cacheRoot/workRoot are the workspace roots (chat history / produced
 * deliverables); kanban.db is <hermesHome>/kanban.db (the default-board file the
 * bundled wheel authors — hermesHome is per-seat, so the DB file is too).
 */
type SeatFsRoots = {
  seatId: string;
  hermesHome: string;
  cacheRoot: string;
  workRoot: string;
  kanbanDb: string;
  companyBrainDir: string;
};

const captureSeatFsRoots = (userData: string, seatId: string, configRoot: string, dataRoot: string): SeatFsRoots => {
  const hermesHome = resolveSeatHome(userData, seatId).hermesHome;
  const storage = resolveSeatScopedStorageRoots(configRoot, dataRoot, seatId);
  return {
    seatId,
    hermesHome,
    cacheRoot: storage.cacheRoot,
    workRoot: storage.workRoot,
    // kanbanDbPath(hermesHome, 'default') === <hermesHome>/kanban.db (the private
    // resolver in kanbanPreflightCore); we assert the documented shape rather than
    // import a non-exported symbol — hermesHome disjointness carries kanban.db.
    kanbanDb: path.join(hermesHome, 'kanban.db'),
    companyBrainDir: path.join(hermesHome, COMPANY_BRAIN_DIR),
  };
};

/** Recursively snapshot a directory tree as a sorted [relpath, bytes] listing. */
const snapshotTree = (root: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // absent dir → empty snapshot (used for "did seat B change?" diffs)
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = rel ? path.posix.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        out.push([`${relPath}/`, '']);
        walk(full, relPath);
      } else {
        let bytes = '';
        try {
          bytes = fs.readFileSync(full, 'utf8');
        } catch {
          bytes = '<unreadable>';
        }
        out.push([relPath, bytes]);
      }
    }
  };
  walk(root, '');
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
};

// The crafted ids every id-accepting resolver/writer must reject. Each MUST NOT be
// turnable into a path segment that escapes the seat subtree.
const HOSTILE_SEAT_IDS: ReadonlyArray<{ label: string; id: string }> = [
  { label: 'parent-traversal ../x', id: '../x' },
  { label: 'embedded traversal a/../b', id: 'a/../b' },
  { label: 'absolute posix path', id: '/etc/passwd' },
  { label: 'absolute-ish windows path', id: 'C:\\\\Windows\\\\system32' },
  { label: 'bare dot-dot', id: '..' },
  { label: 'single dot', id: '.' },
  { label: 'url-encoded traversal', id: '%2e%2e%2fescape' },
  { label: 'raw url-encoded dotdot', id: '..%2f..%2fescape' },
  { label: 'NUL byte', id: 'a\0b' },
  { label: 'forward slash', id: 'a/b' },
  { label: 'back slash', id: 'a\\b' },
  { label: 'leading-dot dotfile', id: '.hidden' },
  { label: 'leading whitespace', id: ' spaced' },
  { label: 'over-length 65 chars', id: 'a'.repeat(65) },
  { label: 'unicode homoglyph slash', id: 'a⁄b' },
];

// A crafted company-brain ENTRY id set (assertEntryId is [a-z0-9-] only).
const HOSTILE_ENTRY_IDS: ReadonlyArray<{ label: string; id: string }> = [
  { label: 'traversal ../x', id: '../x' },
  { label: 'embedded traversal a/../b', id: 'a/../b' },
  { label: 'absolute', id: '/abs' },
  { label: 'bare dot-dot', id: '..' },
  { label: 'NUL byte', id: 'a\0b' },
  { label: 'slash', id: 'a/b' },
  { label: 'backslash', id: 'a\\b' },
  { label: 'leading dot', id: '.hidden' },
  { label: 'uppercase (allowlist is lower-only)', id: 'ABC' },
  { label: 'over-length 65', id: 'a'.repeat(65) },
];

// ============================================================================
// INVARIANT 1 — PATH-DISJUNKTHEIT
// ============================================================================
describe('GATE-NULL FS Invariant 1 — Seat A cannot share any storage root with Seat B (client seats are pairwise prefix-free; a client can never sit above the founder root)', () => {
  it('for N=3 seats client hermesHome / cacheRoot / workRoot / kanban.db / company-brain roots are pairwise prefix-free, and no client is an ancestor of the founder root', () => {
    const userData = makeUserData();
    const configRoot = path.join(path.resolve(userData), 'cfg');
    const dataRoot = path.join(path.resolve(userData), 'data');

    const roots = ALL_SEATS.map((seat) => captureSeatFsRoots(userData, seat, configRoot, dataRoot));

    // Every non-legacy seat's roots sit under a `seats/<id>/` segment; the legacy
    // seat sits at the un-scoped base (byte-identical to 1.1.3).
    for (const r of roots) {
      const isLegacy = r.seatId === SEAT_LEGACY;
      const underSeats = r.hermesHome.includes(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
      expect(underSeats).toBe(!isLegacy);
      if (!isLegacy) {
        expect(r.hermesHome).toContain(r.seatId);
        expect(r.cacheRoot).toContain(r.seatId);
        expect(r.workRoot).toContain(r.seatId);
      }
    }

    const dims: Array<keyof SeatFsRoots> = ['hermesHome', 'cacheRoot', 'workRoot', 'kanbanDb', 'companyBrainDir'];
    const clientRoots = roots.filter((r) => r.seatId !== SEAT_LEGACY);
    const legacyRoots = roots.find((r) => r.seatId === SEAT_LEGACY)!;

    // (a) STRICT PREFIX-FREE BETWEEN THE TWO CLIENT SEATS — the load-bearing DSGVO
    // guarantee: no client seat's root is identical to, or an ancestor of, another
    // client seat's same-dimension root (in either direction). This is the check
    // that a leak would actually break.
    for (let i = 0; i < clientRoots.length; i++) {
      for (let j = 0; j < clientRoots.length; j++) {
        if (i === j) continue;
        const a = clientRoots[i];
        const b = clientRoots[j];
        for (const dim of dims) {
          expect(a[dim]).not.toBe(b[dim]);
          expect(isPrefixPath(a[dim] as string, b[dim] as string), `${String(dim)}: client ${a.seatId} is a prefix of client ${b.seatId}`).toBe(false);
          // Neither client's id ever appears in the other client's roots.
          expect(b[dim]).not.toContain(a.seatId);
        }
      }
    }

    // (b) LEGACY vs CLIENT — the CORRECT (and deliberately asymmetric) topology.
    // hermesHome / kanban.db / company-brain roots hang off the SHARED hermesRoot, so
    // the legacy HOME (<hermesRoot>/home) and a client HOME (<hermesRoot>/seats/<id>/
    // home) are siblings — strictly prefix-free both ways. The WORKSPACE roots
    // (cacheRoot/workRoot) are different by DESIGN: the legacy base IS the container
    // that `seats/` roots under, so it is an INTENTIONAL ancestor of a client subtree.
    // The isolation guarantee is the INVERSE: a CLIENT seat is NEVER an ancestor of the
    // legacy/founder root — a client can never reach up into the founder's world.
    const homeLikeDims: Array<keyof SeatFsRoots> = ['hermesHome', 'kanbanDb', 'companyBrainDir'];
    const workspaceDims: Array<keyof SeatFsRoots> = ['cacheRoot', 'workRoot'];
    for (const client of clientRoots) {
      for (const dim of homeLikeDims) {
        // Siblings under the shared hermesRoot: neither contains the other.
        expect(client[dim]).not.toBe(legacyRoots[dim]);
        expect(isPrefixPath(legacyRoots[dim] as string, client[dim] as string), `${String(dim)}: legacy is a prefix of client ${client.seatId}`).toBe(false);
        expect(isPrefixPath(client[dim] as string, legacyRoots[dim] as string), `${String(dim)}: client ${client.seatId} is a prefix of legacy`).toBe(false);
      }
      for (const dim of workspaceDims) {
        // Legacy base is an INTENTIONAL ancestor of the client subtree …
        expect(isPrefixPath(legacyRoots[dim] as string, client[dim] as string)).toBe(true);
        // … but a client is NEVER an ancestor of the legacy/founder root (the real leak
        // direction: a client reaching UP into the founder's workspace).
        expect(isPrefixPath(client[dim] as string, legacyRoots[dim] as string), `${String(dim)}: client ${client.seatId} contains the founder root`).toBe(false);
        // The legacy workspace root never carries a client's id.
        expect(legacyRoots[dim]).not.toContain(client.seatId);
      }
    }
  });

  it('the runtime bootstrap paths resolver agrees: two client seats never collide on any produced path', () => {
    const userData = makeUserData();
    const pa = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A);
    const pb = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_B);
    // hermesHome + the per-seat skills roots (managedSkillsRoot lives under the home)
    // are disjoint and carry only their own seat id.
    for (const key of ['hermesHome', 'managedSkillsRoot', 'founderOpsSkillsRoot'] as const) {
      expect(pa[key]).not.toBe(pb[key]);
      expect(pa[key]).toContain(SEAT_A);
      expect(pa[key]).not.toContain(SEAT_B);
      expect(pb[key]).toContain(SEAT_B);
      expect(pb[key]).not.toContain(SEAT_A);
    }
    // The shared install-global roots (venv lives here) ARE the same across seats —
    // that is by design (the venv is shared; only the home is per-seat).
    expect(pa.hermesRoot).toBe(pb.hermesRoot);
    expect(pa.hermesVenv).toBe(pb.hermesVenv);
  });
});

// ============================================================================
// INVARIANT 2 — TRAVERSAL-HÄRTE
// ============================================================================
describe('GATE-NULL FS Invariant 2 — Seat A cannot craft a seat/entry id that escapes into Seat B (or anywhere outside its own segment)', () => {
  it('assertSeatId + setActiveSeatId REJECT every crafted seat id (throw, never produce an escaping path)', () => {
    for (const { label, id } of HOSTILE_SEAT_IDS) {
      expect(() => assertSeatId(id), `assertSeatId accepted ${label}`).toThrow();
      // setActiveSeatId is fail-closed: a bad id throws and leaves the active seat
      // unchanged (still legacy from the beforeEach reset).
      expect(() => setActiveSeatId(id), `setActiveSeatId accepted ${label}`).toThrow();
      expect(getActiveSeatId()).toBe(SEAT_LEGACY);
    }
  });

  it('resolveSeatHome + resolveSeatScopedStorageRoots REJECT crafted ids (never emit a path outside seats/)', () => {
    const userData = makeUserData();
    const expectedSeatsRoot = path.join(resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_A).hermesRoot, SEATS_SUBDIR);
    for (const { label, id } of HOSTILE_SEAT_IDS) {
      // Either it throws, OR (defensive belt) the produced home stays strictly under
      // the seats/ subtree. Both are acceptable; escaping is not.
      let threw = false;
      let home = '';
      try {
        home = resolveSeatHome(userData, id).hermesHome;
      } catch {
        threw = true;
      }
      if (!threw) {
        expect(isPrefixPath(expectedSeatsRoot, home), `resolveSeatHome(${label}) escaped seats/`).toBe(true);
      } else {
        expect(threw).toBe(true);
      }
      // The workspace-root resolver must throw for a non-sanitizable id (assertSeatId).
      expect(() => resolveSeatScopedStorageRoots('/cfg', '/data', id), `storageRoots accepted ${label}`).toThrow();
    }
  });

  it('provisionSeatRuntimeFiles fails BEST-EFFORT (ok:false) on a crafted target and writes NO file outside seats/', () => {
    const userData = makeUserData();
    for (const { id } of HOSTILE_SEAT_IDS) {
      const result = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: id });
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
    // Nothing was provisioned outside the seats/ subtree: no config.yaml exists
    // anywhere under the runtime root (a crafted home would sit outside seats/).
    const runtimeRoot = path.join(path.resolve(userData), 'command-eve-runtime');
    const stray: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'config.yaml') stray.push(full);
      }
    };
    walk(runtimeRoot);
    expect(stray).toEqual([]);
  });

  it('company-brain upsert/read/remove REJECT crafted ENTRY ids (assertEntryId — never touch the filesystem)', () => {
    const userData = makeUserData();
    const home = resolveSeatHome(userData, SEAT_A).hermesHome;
    fs.mkdirSync(home, { recursive: true });
    for (const { label, id } of HOSTILE_ENTRY_IDS) {
      expect(() => upsertEntry(home, { id, kind: 'note', title: 't', body: 'b' }), `upsert accepted ${label}`).toThrow();
      expect(() => readEntryBody(home, id), `readEntryBody accepted ${label}`).toThrow();
      expect(() => removeEntry(home, id), `removeEntry accepted ${label}`).toThrow();
    }
    // No entries/ file was created for any hostile id — the guard is BEFORE any fs op.
    const entriesDir = path.join(home, COMPANY_BRAIN_DIR, 'entries');
    let entriesFiles: string[] = [];
    try {
      entriesFiles = fs.readdirSync(entriesDir);
    } catch {
      entriesFiles = [];
    }
    expect(entriesFiles).toEqual([]);
  });

  it('seatScopedKey REJECTS crafted seat ids for config-key prefixing (a crafted id can never become a key prefix)', () => {
    for (const { label, id } of HOSTILE_SEAT_IDS) {
      // Note: seatConfigKeyCore intentionally omits path.isAbsolute() (renderer-safe),
      // but the separator/dotdot/dotfile/whitespace guards + the allowlist still reject
      // every one of these. An absolute posix path contains '/', so it is rejected too.
      expect(() => seatScopedKey('commandEve.clientSeeded', id), `seatScopedKey accepted ${label}`).toThrow();
    }
  });
});

// ============================================================================
// INVARIANT 3 — WRITE-CONTAINMENT
// ============================================================================
describe('GATE-NULL FS Invariant 3 — Seat A can never write into Seat B (a full write pass on A leaves B byte-identical)', () => {
  it('provision + company-brain writes + seed write + USER.md stamp on seat A leave seat B\'s tree byte-identical', () => {
    const userData = makeUserData();
    const homeA = resolveSeatHome(userData, SEAT_A).hermesHome;
    const homeB = resolveSeatHome(userData, SEAT_B).hermesHome;

    // Establish seat B as a real, already-provisioned+seeded seat, then SNAPSHOT it.
    setActiveSeatId(SEAT_B);
    provisionSeatRuntimeFiles({ userDataPath: userData });
    writeCompanyBrainSeedToHome({
      hermesHome: homeB,
      seed: { kind: 'paste_brief', value: `${ENTITY_B}\n${B_TRACER}` },
    });
    upsertEntry(homeB, { kind: 'note', title: 'B note', body: `${ENTITY_B} private note ${B_TRACER}` });
    stampUserMdTiers({ userDataPath: userData, seatId: SEAT_B, profile: FALLBACK_PROFILE });
    const beforeB = snapshotTree(homeB);
    expect(beforeB.length).toBeGreaterThan(0); // B really has content to protect

    // Now do a FULL write pass on seat A (the "attacker" seat doing legitimate work).
    setActiveSeatId(SEAT_A);
    provisionSeatRuntimeFiles({ userDataPath: userData });
    writeCompanyBrainSeedToHome({
      hermesHome: homeA,
      seed: { kind: 'paste_brief', value: `${ENTITY_A}\n${A_TRACER}` },
    });
    upsertEntry(homeA, { kind: 'brief', title: 'A brief', body: `${ENTITY_A} private brief ${A_TRACER}` });
    upsertEntry(homeA, { kind: 'note', title: 'A note', body: `${ENTITY_A} another ${A_TRACER}` });
    stampUserMdTiers({ userDataPath: userData, seatId: SEAT_A, profile: FALLBACK_PROFILE });

    // Seat B's tree is byte-identical: A's full pass touched nothing under B.
    const afterB = snapshotTree(homeB);
    expect(afterB).toEqual(beforeB);

    // And A genuinely wrote a populated tree (so the containment is non-vacuous).
    const afterA = snapshotTree(homeA);
    expect(afterA.length).toBeGreaterThan(0);
    const aBlob = JSON.stringify(afterA);
    expect(aBlob).toContain(A_TRACER);
    expect(aBlob).not.toContain(B_TRACER);
    expect(aBlob).not.toContain(ENTITY_B);
  });

  it('a company-brain remove on seat A never removes or mutates seat B\'s entries', () => {
    const userData = makeUserData();
    const homeA = resolveSeatHome(userData, SEAT_A).hermesHome;
    const homeB = resolveSeatHome(userData, SEAT_B).hermesHome;
    fs.mkdirSync(homeA, { recursive: true });
    fs.mkdirSync(homeB, { recursive: true });

    const aEntry = upsertEntry(homeA, { kind: 'note', title: 'shared-title', body: 'A body' });
    const bEntry = upsertEntry(homeB, { kind: 'note', title: 'shared-title', body: `B body ${B_TRACER}` });
    const beforeB = snapshotTree(homeB);

    // Remove A's entry (even by B's id, to prove no cross-home reach).
    removeEntry(homeA, aEntry.entry.id);
    removeEntry(homeA, bEntry.entry.id); // B's id under A's home is a no-op on B

    const afterB = snapshotTree(homeB);
    expect(afterB).toEqual(beforeB);
    // B's entry is still fully present and readable.
    expect(listEntries(homeB).some((e) => e.id === bEntry.entry.id)).toBe(true);
    expect(readEntryBody(homeB, bEntry.entry.id) ?? '').toContain(B_TRACER);
  });
});

// ============================================================================
// INVARIANT 4 — READ-CONTAINMENT
// ============================================================================
describe('GATE-NULL FS Invariant 4 — Seat B can never read Seat A\'s knowledge (after A is populated, B sees nothing of A)', () => {
  it('company-brain list/read + seed read on seat B return NOTHING of seat A', () => {
    const userData = makeUserData();
    const homeA = resolveSeatHome(userData, SEAT_A).hermesHome;
    const homeB = resolveSeatHome(userData, SEAT_B).hermesHome;

    // Populate ONLY seat A with client knowledge.
    writeCompanyBrainSeedToHome({ hermesHome: homeA, seed: { kind: 'paste_brief', value: `${ENTITY_A}\n${A_TRACER}` } });
    upsertEntry(homeA, { kind: 'brief', title: 'A brief', body: `${ENTITY_A} ${A_TRACER}` });
    upsertEntry(homeA, { kind: 'note', title: 'A note', body: `more ${A_TRACER}` });

    // Seat B: brand-new home, never seeded.
    const bSeed = readCompanyBrainSeedStateFromHome(homeB);
    expect(bSeed.seeded).toBe(false);
    expect(bSeed.record).toBeNull();

    // B's company-brain listing is empty — it cannot see A's entries.
    const bEntries = listEntries(homeB);
    expect(bEntries).toEqual([]);

    // And a read of A's entry ids UNDER B's home returns null (no cross-home body).
    for (const e of listEntries(homeA)) {
      expect(readEntryBody(homeB, e.id)).toBeNull();
    }

    // A really is populated (non-vacuous): A sees its own seed + entries.
    expect(readCompanyBrainSeedStateFromHome(homeA).record?.value ?? '').toContain(A_TRACER);
    expect(listEntries(homeA).length).toBeGreaterThan(0);
  });

  it('the §SEAT USER.md stamp for seat B never contains seat A\'s client entity', () => {
    const userData = makeUserData();
    const homeA = resolveSeatHome(userData, SEAT_A).hermesHome;
    const homeB = resolveSeatHome(userData, SEAT_B).hermesHome;

    // Seed BOTH seats with their own client, then stamp each seat's USER.md from its
    // OWN home seed (the real stampUserMdTiers reads the per-seat seed).
    writeCompanyBrainSeedToHome({ hermesHome: homeA, seed: { kind: 'paste_brief', value: `${ENTITY_A}\n${A_TRACER}` } });
    writeCompanyBrainSeedToHome({ hermesHome: homeB, seed: { kind: 'paste_brief', value: `${ENTITY_B}\n${B_TRACER}` } });

    const resA = stampUserMdTiers({ userDataPath: userData, seatId: SEAT_A, profile: FALLBACK_PROFILE });
    const resB = stampUserMdTiers({ userDataPath: userData, seatId: SEAT_B, profile: FALLBACK_PROFILE });
    expect(resA.seatStamped).toBe(true);
    expect(resB.seatStamped).toBe(true);

    const userMdA = fs.readFileSync(resA.userMdPath, 'utf8');
    const userMdB = fs.readFileSync(resB.userMdPath, 'utf8');
    // Each seat's USER.md carries ONLY its own client entity/tracer.
    expect(userMdB).toContain(ENTITY_B);
    expect(userMdB).not.toContain(ENTITY_A);
    expect(userMdB).not.toContain(A_TRACER);
    expect(userMdA).toContain(ENTITY_A);
    expect(userMdA).not.toContain(ENTITY_B);
    expect(userMdA).not.toContain(B_TRACER);
  });
});

// ============================================================================
// INVARIANT 5 — CONFIG-NAMESPACE
// ============================================================================
describe('GATE-NULL FS Invariant 5 — Seat A cannot collide with or read Seat B\'s config keys (per-seat physical keys are disjoint)', () => {
  it('seatScopedKey over the WHOLE SEAT_SCOPED_CONFIG_KEYS allowlist never collides between two seats', () => {
    expect(SEAT_SCOPED_CONFIG_KEYS.size).toBeGreaterThan(0); // non-vacuous
    const aKeys = new Set<string>();
    const bKeys = new Set<string>();
    for (const key of SEAT_SCOPED_CONFIG_KEYS) {
      const ka = seatScopedKey(key, SEAT_A);
      const kb = seatScopedKey(key, SEAT_B);
      // A's physical key carries A's id, never B's; and vice-versa.
      expect(ka).toContain(SEAT_A);
      expect(ka).not.toContain(SEAT_B);
      expect(kb).toContain(SEAT_B);
      expect(kb).not.toContain(SEAT_A);
      // The two seats' physical keys for the SAME logical key never collide.
      expect(ka).not.toBe(kb);
      aKeys.add(ka);
      bKeys.add(kb);
    }
    // Whole-allowlist disjointness: no physical key of A is a physical key of B.
    for (const ka of aKeys) expect(bKeys.has(ka)).toBe(false);
    for (const kb of bKeys) expect(aKeys.has(kb)).toBe(false);
  });

  it('the legacy seat keeps un-prefixed keys (byte-identical to 1.1.3) while client seats are namespaced away from it', () => {
    for (const key of SEAT_SCOPED_CONFIG_KEYS) {
      // Legacy/no-seat → the key is returned UNCHANGED (no `seat:` prefix, zero migration).
      expect(seatScopedKey(key, SEAT_LEGACY)).toBe(key);
      expect(seatScopedKey(key, undefined)).toBe(key);
      // A real seat's physical key is distinct from the legacy (un-prefixed) key, so a
      // client seat's read can never resolve to the founder's global value.
      expect(seatScopedKey(key, SEAT_A)).not.toBe(key);
    }
  });
});

// ============================================================================
// INVARIANT 6 — ENV-HYGIENE (H3)
// ============================================================================
describe('GATE-NULL FS Invariant 6 — Seat A\'s client name can never reach a child process env (H3) — clear label out, board pin symmetrically cleared', () => {
  // Re-uses the exported prepareCommandEveRuntimeProcessEnv bake (no duplicate
  // logic). The exhaustive switch/rollback env matrix lives in
  // tests/unit/command-eve/seatContextBridgeEnvTrio.test.ts; here it is one bundled
  // GATE-NULL matrix assertion.
  const CLIENT_NAME = 'Bäckerei Müller GmbH';

  it('the real bake writes the OPAQUE seat id but NEVER the clear label (H3), and pins HERMES_HOME per-seat', () => {
    const userData = makeUserData();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel(CLIENT_NAME);
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prepareCommandEveRuntimeProcessEnv(userData, env);
    expect(env.COMMAND_EVE_ACTIVE_SEAT).toBe(SEAT_A); // opaque id is safe to inherit
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined(); // clear name never in env
    expect(Object.values(env)).not.toContain(CLIENT_NAME); // not under any key
    expect(env.HERMES_HOME).toContain(path.join(SEATS_SUBDIR, SEAT_A, 'home')); // per-seat pin
  });

  it('a stale COMMAND_EVE_SEAT_LABEL + a prior seat\'s HERMES_KANBAN_BOARD are both scrubbed on the bake (no cross-seat carryover)', () => {
    const userData = makeUserData();
    setActiveSeatId(SEAT_A);
    setActiveSeatLabel(CLIENT_NAME);
    // A hostile/stale env carrying a prior seat's leaked label AND board pin.
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      COMMAND_EVE_SEAT_LABEL: 'previously-leaked-name',
      HERMES_KANBAN_BOARD: 'prior-seat-board',
    };
    prepareCommandEveRuntimeProcessEnv(userData, env);
    // H3: the clear name is scrubbed, not merely not-added.
    expect(env.COMMAND_EVE_SEAT_LABEL).toBeUndefined();
    expect(Object.values(env)).not.toContain('previously-leaked-name');
    // H5: the board pin is symmetrically DELETED (no per-seat slug today), so seat A
    // can never inherit a prior seat's board — seat isolation outranks any ambient pin.
    expect(env.HERMES_KANBAN_BOARD).toBeUndefined();
  });
});

// ============================================================================
// INVARIANT 7 — kind IS PROMPT-ONLY (v1.5 K3, §5)
// ============================================================================
describe('GATE-NULL FS Invariant 7 — profile.kind is PROMPT-ONLY: it never reaches a path resolver, and an own_company seat is byte-identically isolated from client seats', () => {
  // (a) API-ASSERTION — no seat path resolver / storage-root resolver / key
  // prefixer accepts kind. Their signatures take (userData, seatId[, …]) only, so
  // there is structurally no way for kind to influence a produced path. We assert
  // this by construction: setting the kind holder to any value NEVER changes what a
  // resolver produces for the SAME seat id.
  it('the kind holder never influences a resolver output (same seatId → same path for every kind)', () => {
    const userData = makeUserData();
    const configRoot = path.join(path.resolve(userData), 'cfg');
    const dataRoot = path.join(path.resolve(userData), 'data');

    const capture = () => ({
      home: resolveSeatHome(userData, SEAT_A).hermesHome,
      storage: resolveSeatScopedStorageRoots(configRoot, dataRoot, SEAT_A),
    });

    setActiveSeatId(SEAT_A);
    setActiveSeatKind('client');
    const asClient = capture();
    setActiveSeatKind('own_company');
    const asOwn = capture();
    setActiveSeatKind('department');
    const asDept = capture();

    // Byte-identical resolver output across all kinds — kind is structurally absent
    // from the path derivation (the resolvers do not even take a kind parameter).
    expect(asOwn.home).toBe(asClient.home);
    expect(asDept.home).toBe(asClient.home);
    expect(asOwn.storage).toEqual(asClient.storage);
    expect(asDept.storage).toEqual(asClient.storage);
    // seatScopedKey likewise ignores kind (no kind arg exists on it).
    for (const key of SEAT_SCOPED_CONFIG_KEYS) {
      const before = seatScopedKey(key, SEAT_A);
      setActiveSeatKind('own_company');
      expect(seatScopedKey(key, SEAT_A)).toBe(before);
    }
  });

  // (b) WRITE/READ-CONTAINMENT — an own_company seat next to two client seats has
  // byte-identically disjoint homes. A full write pass on the own_company seat
  // leaves both client seats byte-identical; the own_company §SEAT block carries
  // its own entity and never another seat's.
  it('a full write pass on an own_company seat leaves the client seats byte-identical (same isolation as a client seat)', () => {
    const userData = makeUserData();
    const homeOwn = resolveSeatHome(userData, SEAT_A).hermesHome; // treated as own_company
    const homeClient = resolveSeatHome(userData, SEAT_B).hermesHome; // a real client

    // Establish the client seat as populated, then snapshot it.
    setActiveSeatId(SEAT_B);
    setActiveSeatKind('client');
    writeCompanyBrainSeedToHome({ hermesHome: homeClient, seed: { kind: 'paste_brief', value: `${ENTITY_B}\n${B_TRACER}` } });
    upsertEntry(homeClient, { kind: 'note', title: 'B note', body: `${ENTITY_B} ${B_TRACER}` });
    stampUserMdTiers({ userDataPath: userData, seatId: SEAT_B, profile: FALLBACK_PROFILE, kind: 'client' });
    const beforeClient = snapshotTree(homeClient);
    expect(beforeClient.length).toBeGreaterThan(0);

    // Full write pass on the own_company seat.
    setActiveSeatId(SEAT_A);
    setActiveSeatKind('own_company');
    writeCompanyBrainSeedToHome({ hermesHome: homeOwn, seed: { kind: 'paste_brief', value: `${ENTITY_A}\n${A_TRACER}` } });
    upsertEntry(homeOwn, { kind: 'brief', title: 'own brief', body: `${ENTITY_A} ${A_TRACER}` });
    const resOwn = stampUserMdTiers({ userDataPath: userData, seatId: SEAT_A, profile: FALLBACK_PROFILE, kind: 'own_company' });
    expect(resOwn.seatStamped).toBe(true);

    // The client seat is byte-identical — the own_company pass touched nothing under it.
    expect(snapshotTree(homeClient)).toEqual(beforeClient);

    // The own_company §SEAT block carries its OWN entity + drops the client doctrine,
    // but NEVER contains the client seat's entity/tracer (isolation is kind-blind).
    const userMdOwn = fs.readFileSync(resOwn.userMdPath, 'utf8');
    expect(userMdOwn).toContain(ENTITY_A);
    expect(userMdOwn).not.toContain(ENTITY_B);
    expect(userMdOwn).not.toContain(B_TRACER);
    // Doctrine proof: own_company drops the "nie in Deliverables" clause.
    expect(userMdOwn).not.toContain('erscheint nie in Deliverables');
  });
});
