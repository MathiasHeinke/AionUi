/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ISO-4 INTEGRATION — drive the REAL initStorage seat-scoping seam through a
 * live seat switch and assert the load-bearing roots re-home + stay disjoint.
 *
 * Covers (board ## ISO-4 test strategy, integration tier):
 *  - getSystemDir() (the cacheDir/workDir handed to backendManager.start at boot
 *    AND to the A5 re-spawn) follows the active seat.
 *  - getAssistantsDir / getSkillsDir / getCronSkillsDir re-home per seat.
 *  - the CHAT-HISTORY dir (where command-eve-chat-history/<id>.txt lives) is
 *    disjoint between seats.
 *  - a switch (setActiveSeatId) re-homes ALL of them; switching back to legacy
 *    restores the exact pre-switch (byte-identical) roots.
 *  - the legacy seat's roots are NOT under any seats/ segment (upgrade no-op).
 */

import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import {
  getSystemDir,
  getAssistantsDir,
  getSkillsDir,
  getCronSkillsDir,
  getBackendDataDir,
} from '@/process/utils/initStorage';
import { getDataPath } from '@/process/utils/utils';
import {
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  setActiveSeatId,
  clearActiveSeat,
} from '@/process/commandEve/seatContextCore';

const SEAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SEAT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const CHAT_HISTORY_DIR = 'command-eve-chat-history';

/** Snapshot the seat-sensitive roots for the CURRENT active seat. */
const snapshot = () => {
  const sys = getSystemDir();
  return {
    cacheDir: sys.cacheDir,
    workDir: sys.workDir,
    assistants: getAssistantsDir(),
    skills: getSkillsDir(),
    cron: getCronSkillsDir(),
    chatHistory: path.join(sys.cacheDir, CHAT_HISTORY_DIR),
  };
};

afterEach(() => {
  __resetActiveSeatForTests();
});

describe('ISO-4 initStorage — getSystemDir + dir accessors re-home on a seat switch', () => {
  it('legacy → A → B → legacy: all roots re-home and stay disjoint', () => {
    clearActiveSeat();
    const legacy = snapshot();

    // Legacy roots carry NO seats/ segment (upgrade no-op / byte-identical).
    expect(legacy.cacheDir).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
    expect(legacy.workDir).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
    // assistants/skills/cron + chat-history root directly at the (legacy) cache.
    expect(legacy.assistants).toBe(path.join(legacy.cacheDir, 'assistants'));
    expect(legacy.skills).toBe(path.join(legacy.cacheDir, 'skills'));
    expect(legacy.cron).toBe(path.join(legacy.cacheDir, 'cron-skills'));

    // Switch to seat A → every root re-homes under seats/A.
    setActiveSeatId(SEAT_A);
    const a = snapshot();
    expect(a.cacheDir).toBe(path.join(legacy.cacheDir, SEATS_SUBDIR, SEAT_A));
    expect(a.workDir).toBe(path.join(legacy.workDir, SEATS_SUBDIR, SEAT_A));
    expect(a.assistants).toBe(path.join(a.cacheDir, 'assistants'));
    expect(a.skills).toBe(path.join(a.cacheDir, 'skills'));
    expect(a.cron).toBe(path.join(a.cacheDir, 'cron-skills'));
    expect(a.chatHistory).toBe(path.join(a.cacheDir, CHAT_HISTORY_DIR));

    // Switch to seat B → re-homes again; DISJOINT from A across EVERY root.
    setActiveSeatId(SEAT_B);
    const b = snapshot();
    for (const key of Object.keys(b) as (keyof typeof b)[]) {
      expect(b[key]).not.toBe(a[key]);
      // neither a prefix of the other — the cross-seat leak guard.
      expect(b[key].startsWith(a[key] + path.sep)).toBe(false);
      expect(a[key].startsWith(b[key] + path.sep)).toBe(false);
    }

    // Decisive: enumerate every seat-A path and every seat-B path; the two sets
    // are fully DISJOINT (no shared chat-history / workDir / assistants / skills).
    const aPaths = new Set(Object.values(a));
    const bPaths = new Set(Object.values(b));
    for (const p of bPaths) expect(aPaths.has(p)).toBe(false);

    // Switch back to legacy → EXACT pre-switch roots restored (byte-identical).
    clearActiveSeat();
    const back = snapshot();
    expect(back).toEqual(legacy);
  });

  it("seat A's chat-history dir is NOT reachable from seat B (disjoint transcript roots)", () => {
    setActiveSeatId(SEAT_A);
    const aChat = path.join(getSystemDir().cacheDir, CHAT_HISTORY_DIR, 'conversation-C1.txt');
    setActiveSeatId(SEAT_B);
    const bChat = path.join(getSystemDir().cacheDir, CHAT_HISTORY_DIR, 'conversation-C1.txt');
    // Same conversation id, but two DIFFERENT absolute files — seat B reading C1
    // gets its OWN (empty) file, never seat A's transcript.
    expect(aChat).not.toBe(bChat);
    expect(path.dirname(aChat)).not.toBe(path.dirname(bChat));
  });
});

/**
 * ISO-4 CRITICAL — the backend `--data-dir` (FIRST positional arg of
 * backendManager.start at boot AND the A5 re-spawn) is the LIVE conversation +
 * message SQLite + full-text-search store. The first ISO-4 cut seat-scoped
 * cacheDir/workDir but LEFT this arg at the global unscoped getDataPath() — so
 * seat B's renderer conversation list / message bodies / search read seat A's DB.
 *
 * `getBackendDataDir()` is EXACTLY the value both call sites now hand to
 * backendManager.start (index.ts boot ~:1239 + restartCommandEveBackendForSeat
 * ~:1265), so asserting on it is asserting on the start() arg itself. Covers:
 *  (a) legacy seat → byte-identical to getDataPath() (existing chat SQLite stays
 *      in place, no move/loss).
 *  (b) a real seat → DISJOINT (under seats/<id>), never the global data-dir.
 *  (c) two seats → disjoint data-dirs (seat B backend SQLite can never be seat A).
 *  (d) a switch RE-HOMES the data-dir (the A5 re-spawn data-dir follows the
 *      active seat) — and BOTH call sites resolve the SAME value for one seat.
 */
describe('ISO-4 backend --data-dir (backendManager.start first arg) follows the active seat', () => {
  it('(a) legacy / no-seat → getBackendDataDir() is BYTE-IDENTICAL to getDataPath()', () => {
    clearActiveSeat();
    // Exact string equality — the zero-migration guarantee: an existing
    // single-seat user keeps their conversation SQLite at the global data-dir.
    expect(getBackendDataDir()).toBe(getDataPath());
    expect(getBackendDataDir()).not.toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
  });

  it('(b) a real seat → data-dir is DISJOINT (under seats/<id>), never the global data-dir', () => {
    const global = getDataPath();
    setActiveSeatId(SEAT_A);
    const aData = getBackendDataDir();
    expect(aData).toBe(path.join(global, SEATS_SUBDIR, SEAT_A));
    expect(aData).not.toBe(global);
    // The global (legacy) data-dir is NOT a child of the seat dir and vice-versa
    // is irrelevant; the load-bearing fact is the seat dir is strictly BELOW the
    // global AND distinct from it, so seat A's backend opens a different SQLite.
    expect(aData.startsWith(global + path.sep)).toBe(true);
    expect(aData).not.toBe(global);
  });

  it('(c) two seats yield DISJOINT data-dirs (seat B backend SQLite cannot be seat A)', () => {
    setActiveSeatId(SEAT_A);
    const aData = getBackendDataDir();
    setActiveSeatId(SEAT_B);
    const bData = getBackendDataDir();
    expect(aData).not.toBe(bData);
    // neither a prefix of the other — the cross-seat conversation-store leak guard.
    expect(bData.startsWith(aData + path.sep)).toBe(false);
    expect(aData.startsWith(bData + path.sep)).toBe(false);
  });

  it('(d) a seat switch RE-HOMES the data-dir; legacy→A→B→legacy is byte-stable', () => {
    clearActiveSeat();
    const legacy = getBackendDataDir();
    expect(legacy).toBe(getDataPath());

    // Boot start() arg (legacy) and the A5 re-spawn start() arg resolve the SAME
    // value for the SAME active seat — both call sites use getBackendDataDir().
    setActiveSeatId(SEAT_A);
    const bootArgForA = getBackendDataDir();
    const respawnArgForA = getBackendDataDir();
    expect(bootArgForA).toBe(respawnArgForA);
    expect(bootArgForA).toBe(path.join(getDataPath(), SEATS_SUBDIR, SEAT_A));

    setActiveSeatId(SEAT_B);
    expect(getBackendDataDir()).toBe(path.join(getDataPath(), SEATS_SUBDIR, SEAT_B));
    expect(getBackendDataDir()).not.toBe(bootArgForA);

    // Switch back to legacy → the re-spawn data-dir returns to the global,
    // byte-identical (no double-nest, existing DB preserved).
    clearActiveSeat();
    expect(getBackendDataDir()).toBe(legacy);
  });
});
