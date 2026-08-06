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
    expect(writeActiveSeatPointer(tmpRoot, { seatId: SEAT, label: 'Mathias', kind: 'own_company' })).toBe(true);
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
    // the next boot would restore.
    expect(writeActiveSeatPointer(tmpRoot, { seatId: LEGACY_SEAT_ID })).toBe(false);
    expect(readActiveSeatPointer(tmpRoot)).toBeNull();
  });

  it('never writes an unsafe id', () => {
    for (const bad of ['../../etc/passwd', 'seat/../../x', 'a\0b', ' lead', '.hidden']) {
      expect(writeActiveSeatPointer(tmpRoot, { seatId: bad }), `${JSON.stringify(bad)} must not persist`).toBe(false);
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
