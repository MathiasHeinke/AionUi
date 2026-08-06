/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205 — THE MAX HANG: main booted on the wrong seat and read the right key
 * in the wrong namespace.
 *
 * THE BUG, end to end. `seatContextCore` is the ONLY holder of the active seat and
 * it resets to `LEGACY_SEAT_ID` on every process start. `setActiveSeatId` was
 * called from exactly one place — the seat SWITCH — and nothing restored the seat
 * at boot. The tree said so in three separate comments, including the one at the
 * env bake in `index.ts` which spelled out the fix ("If a boot-time seat-restore is
 * ever added, it MUST call setActiveSeatId + setActiveSeatLabel BEFORE this bake").
 *
 * The consequence is the whole reason this file exists. `physicalSettingsKey`
 * namespaces with `seatScopedKey(key, getActiveSeatId())`, and on the LEGACY seat
 * `seatScopedKey` returns the key UNCHANGED. So after every restart main asked for
 *
 *     commandEve.maxEntitled                        (un-namespaced)
 *
 * while the renderer had written
 *
 *     seat:<uuid>:commandEve.maxEntitled            (seat-scoped)
 *
 * The value was PRESENT and simply not looked at. `rawMaxEntitled` came back
 * undefined, `maxEntitled` stayed undefined, and the turn parked on
 * "Berechtigung wird geprüft" instead of routing MAX or Standard. The renderer
 * could not compensate: it asks MAIN for the id over `command-eve.active-seat`.
 *
 * `it('reads maxEntitled from the SEAT-SCOPED key once the boot restore ran')` is
 * the regression proper — it is RED against the pre-fix code, where the same
 * backend bag yields `maxEntitled: undefined`. Its sibling asserts that exact
 * pre-fix behaviour on the legacy seat, so the pair shows the namespace is doing
 * the work rather than the fixture.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import {
  ACTIVE_SEAT_POINTER_VERSION,
  activeSeatPointerFilePath,
  readActiveSeatPointer,
  restoreActiveSeatFromPointer,
  writeActiveSeatPointer,
} from '@/process/commandEve/activeSeatPointerStore';
import {
  __resetActiveSeatForTests,
  getActiveSeatId,
  getActiveSeatLabel,
  LEGACY_SEAT_ID,
} from '@/process/commandEve/seatContextCore';
import { readInferenceLaneStateFromBackendStrict } from '@/process/commandEve/inferenceSelectionBackendRead';

const SEAT = 'f320cebf-f392-41d9-b6b6-f079677eab4f';
const MAX_KEY = 'commandEve.maxEntitled';
const SELECTION_KEY = 'commandEve.inferenceSelection';

let tmpRoot: string;

/** The backend bag EXACTLY as the renderer's configService.set wrote it. */
const seatScopedBag = {
  [`seat:${SEAT}:${SELECTION_KEY}`]: 'command-eve-inference:eve-max',
  [`seat:${SEAT}:${MAX_KEY}`]: true,
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-seat-pointer-'));
  __resetActiveSeatForTests();
  httpRequestMock.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  __resetActiveSeatForTests();
});

describe('the local active-seat pointer', () => {
  it('round-trips a real seat id, 0600, under command-eve-runtime/', () => {
    expect(writeActiveSeatPointer(tmpRoot, { seatId: SEAT, label: 'Mathias', kind: 'own_company' })).toBe('written');
    const file = activeSeatPointerFilePath(tmpRoot);
    expect(file.endsWith(path.join('command-eve-runtime', 'active-seat-pointer.json'))).toBe(true);
    // A pointer is not a secret, but it lives beside files that are; same posture.
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(readActiveSeatPointer(tmpRoot)).toEqual({ seatId: SEAT, label: 'Mathias', kind: 'own_company' });
  });

  it('CLEARS the pointer when the switch target is the legacy seat', () => {
    writeActiveSeatPointer(tmpRoot, { seatId: SEAT });
    expect(readActiveSeatPointer(tmpRoot)).not.toBeNull();
    // Switching back to the founder seat must not leave a stale client pointer that
    // the next boot would restore. 'cleared' is a SUCCESS: absence is the state we
    // wanted (S4 — it used to share `false` with a genuine write failure).
    expect(writeActiveSeatPointer(tmpRoot, { seatId: LEGACY_SEAT_ID })).toBe('cleared');
    expect(readActiveSeatPointer(tmpRoot)).toBeNull();
  });

  it('never writes an unsafe id', () => {
    for (const bad of ['../../etc/passwd', 'seat/../../x', 'a\0b', ' lead', '.hidden']) {
      // 'failed', not 'cleared': the caller asked for a pointer and is not getting
      // one. Only a LEGACY target is an intentional clear.
      expect(writeActiveSeatPointer(tmpRoot, { seatId: bad }), `${JSON.stringify(bad)} must not persist`).toBe(
        'failed'
      );
      expect(readActiveSeatPointer(tmpRoot)).toBeNull();
    }
  });

  it('reads as ABSENT for every unreadable shape (fail-closed)', () => {
    const file = activeSeatPointerFilePath(tmpRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    expect(readActiveSeatPointer(tmpRoot)).toBeNull(); // no file at all
    for (const body of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ version: 'something-else/v9', seat_id: SEAT }),
      JSON.stringify({ version: ACTIVE_SEAT_POINTER_VERSION }),
      JSON.stringify({ version: ACTIVE_SEAT_POINTER_VERSION, seat_id: 42 }),
      JSON.stringify({ version: ACTIVE_SEAT_POINTER_VERSION, seat_id: '../escape' }),
      JSON.stringify({ version: ACTIVE_SEAT_POINTER_VERSION, seat_id: LEGACY_SEAT_ID }),
    ]) {
      fs.writeFileSync(file, body);
      expect(readActiveSeatPointer(tmpRoot), `"${body.slice(0, 40)}" must read as absent`).toBeNull();
    }
  });
});

describe('the boot restore', () => {
  it('puts the holder on the SAVED seat, with its label and kind', () => {
    writeActiveSeatPointer(tmpRoot, { seatId: SEAT, label: 'Mathias', kind: 'own_company' });
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID); // the process starts legacy…

    const result = restoreActiveSeatFromPointer(tmpRoot);

    expect(result).toEqual({ seatId: SEAT, source: 'pointer' });
    expect(getActiveSeatId()).toBe(SEAT);
    expect(getActiveSeatLabel()).toBe('Mathias');
  });

  it('leaves a pointer-less install on the legacy seat (byte-identical to before)', () => {
    const result = restoreActiveSeatFromPointer(tmpRoot);
    expect(result).toEqual({ seatId: LEGACY_SEAT_ID, source: 'legacy' });
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);
  });

  it('never dies on a bad pointer — a boot must not be brickable by one file', () => {
    const result = restoreActiveSeatFromPointer(tmpRoot, {
      readPointer: () => {
        throw new Error('disk on fire');
      },
    });
    expect(result.source).toBe('legacy');
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);
  });
});

describe('CEVE-18205 REGRESSION — maxEntitled is read in the right namespace', () => {
  it('reads maxEntitled from the SEAT-SCOPED key once the boot restore ran', async () => {
    httpRequestMock.mockResolvedValue(seatScopedBag);
    writeActiveSeatPointer(tmpRoot, { seatId: SEAT, label: 'Mathias' });
    restoreActiveSeatFromPointer(tmpRoot);

    const state = await readInferenceLaneStateFromBackendStrict();

    // THE FIX: the persisted entitlement is now visible, so the lane resolves
    // instead of parking on "Berechtigung wird geprüft".
    expect(state.maxEntitled).toBe(true);
    expect(state.selection).toBe('command-eve-inference:eve-max');
  });

  it('is BLIND to the same value on the legacy seat — the pre-fix behaviour', async () => {
    httpRequestMock.mockResolvedValue(seatScopedBag);
    // No restore: exactly what every launch did before this change.
    const state = await readInferenceLaneStateFromBackendStrict();

    // `undefined`, NOT false — unknown entitlement is what produces the HOLD.
    expect(state.maxEntitled).toBeUndefined();
    expect(state.selection).toBeUndefined();
  });

  it('still reads the founder seat un-namespaced (legacy installs unaffected)', async () => {
    httpRequestMock.mockResolvedValue({ [MAX_KEY]: true, [SELECTION_KEY]: 'command-eve-inference:eve-max' });
    const state = await readInferenceLaneStateFromBackendStrict();
    expect(state.maxEntitled).toBe(true);
  });
});

/**
 * S4 — A POINTER THAT DID NOT LAND MUST SAY SO.
 *
 * The store returned a bare boolean and its only caller discarded it, so a write
 * that never happened (full disk, permissions, read-only volume) reported a clean
 * switch — and the next boot came up on the legacy seat reading every seat-scoped
 * key un-namespaced, which is the bug this whole module exists to close. Worse,
 * `false` also meant "cleared on purpose", so the two could not be told apart.
 */
describe('S4 — writeActiveSeatPointer reports written / cleared / failed', () => {
  it("returns 'written' for a real seat", () => {
    expect(writeActiveSeatPointer(tmpRoot, { seatId: SEAT, label: 'Mathias' })).toBe('written');
    expect(readActiveSeatPointer(tmpRoot)).not.toBeNull();
  });

  it("returns 'cleared' for the legacy seat — absence is the CORRECT end state, not a failure", () => {
    writeActiveSeatPointer(tmpRoot, { seatId: SEAT });
    expect(writeActiveSeatPointer(tmpRoot, { seatId: LEGACY_SEAT_ID })).toBe('cleared');
    expect(readActiveSeatPointer(tmpRoot)).toBeNull();
  });

  it("returns 'failed' when the write genuinely cannot happen", () => {
    // Put a FILE where `command-eve-runtime/` must be a directory, so mkdirSync
    // and the write below it both fail for a real filesystem reason.
    const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-seat-blocked-'));
    fs.writeFileSync(path.join(blocked, 'command-eve-runtime'), 'not a directory');
    try {
      expect(writeActiveSeatPointer(blocked, { seatId: SEAT })).toBe('failed');
    } finally {
      fs.rmSync(blocked, { recursive: true, force: true });
    }
  });
});

/**
 * S3 — THE POINTER IS WRITTEN WHEN THE SEAT LANDS, NOT ONLY WHEN THE SWITCH ENDS.
 *
 * Step (f) is the LAST thing a switch does. A switch that put the holder on the
 * target and then died before (f) — a crashed re-spawn, a force-quit, a power cut
 * mid-restart — left no pointer at all, so the next launch came up on the legacy
 * seat and the operator had to notice and switch again BY HAND to repair it.
 *
 * The pointer is now written the instant the holder moves, so that install heals
 * on its next boot with no manual switch. The rollback case is the other half of
 * the contract: a switch that does NOT survive must not leave the target's
 * pointer behind.
 */
describe('S3 — the active-seat pointer survives a switch that never finished', () => {
  /** applySeatSwitch wired to the REAL pointer store under the temp root. */
  const persistToDisk = async (seatId: string, label?: string, kind?: string) => {
    const result = writeActiveSeatPointer(tmpRoot, {
      seatId,
      ...(label === undefined ? {} : { label }),
      ...(kind === undefined ? {} : { kind }),
    });
    if (result === 'failed') throw new Error('pointer write failed');
  };

  it('persists the seat BEFORE the env re-home, so a crash mid-restart still heals', async () => {
    const { applySeatSwitch } = await import('@/process/commandEve/seatSwitchCore');
    let pointerAtPrepareEnv: string | null = null;

    await applySeatSwitch(
      SEAT,
      {
        prepareEnv: () => {
          // The process could die HERE. What is on disk at this instant is what
          // the next boot gets — under the old ordering, nothing.
          pointerAtPrepareEnv = readActiveSeatPointer(tmpRoot)?.seatId ?? null;
        },
        restartBackend: () => {},
        rebindConfig: () => {},
        persistActiveSeat: persistToDisk,
      },
      'Mathias',
      'own_company'
    );

    expect(pointerAtPrepareEnv).toBe(SEAT);

    // Next boot: a brand-new process, holder back on legacy, no manual switch.
    __resetActiveSeatForTests();
    expect(getActiveSeatId()).toBe(LEGACY_SEAT_ID);
    const restored = restoreActiveSeatFromPointer(tmpRoot);
    expect(restored).toEqual({ seatId: SEAT, source: 'pointer' });
    expect(getActiveSeatId()).toBe(SEAT);
    expect(getActiveSeatLabel()).toBe('Mathias');
  });

  it('a ROLLED-BACK switch does not leave the target on disk', async () => {
    const { applySeatSwitch } = await import('@/process/commandEve/seatSwitchCore');

    const result = await applySeatSwitch(
      SEAT,
      {
        // Structural failure AFTER the seat landed ⇒ rollback to the prior
        // (legacy) seat. The early write must be undone, not outlive the switch.
        prepareEnv: () => {
          throw new Error('env bake failed');
        },
        restartBackend: () => {},
        rebindConfig: () => {},
        persistActiveSeat: persistToDisk,
      },
      'Mathias',
      'own_company'
    );

    expect(result.ok).toBe(false);
    expect(result.rolled_back).toBe(true);
    // Prior seat was legacy ⇒ the pointer is CLEARED, so the next boot resolves
    // to legacy by absence rather than restoring a seat never reached.
    expect(readActiveSeatPointer(tmpRoot)).toBeNull();
  });

  it('surfaces persist_failed when the confirmation write cannot land (S4 end-to-end)', async () => {
    const { applySeatSwitch } = await import('@/process/commandEve/seatSwitchCore');

    const result = await applySeatSwitch(
      SEAT,
      {
        prepareEnv: () => {},
        restartBackend: () => {},
        rebindConfig: () => {},
        persistActiveSeat: () => {
          // What persistActiveSeatPointer now does on a 'failed' store result.
          throw new Error('pointer write failed');
        },
      },
      'Mathias'
    );

    // The LOCAL switch still stands — bookkeeping never rolls back a live switch…
    expect(result.ok).toBe(true);
    expect(result.active_seat_id).toBe(SEAT);
    // …but the operator is told the pointer did not stick.
    expect(result.persist_failed).toBe(true);
  });
});
