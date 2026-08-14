/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CONFIRMED-HIGH (switch-rehomes-all) regression CI.
 *
 * The renderer-side configService caches seat-scoped values keyed to its OWN
 * currentSeatId, which moves ONLY via rebindSeat(). Before the fix, a switch
 * A→B re-homed every MAIN-process seam but NEVER called configService.rebindSeat
 * — so the renderer kept serving SEAT A's cached config (clientSeeded, …) after
 * the admin switched to B.
 *
 * These tests prove useSeatAccess.switchTo now re-homes the renderer cache:
 *  (1) a SUCCESSFUL switch A→B rebinds the renderer cache to B (it no longer
 *      serves seat A's cached value — it reads B's namespace / undefined);
 *  (2) it rebinds to the AUTHORITATIVE active_seat_id the MAIN process reports,
 *      not a stale local value;
 *  (3) a FAILED / rolled-back switch rebinds back to the PRIOR seat (no drift
 *      onto the un-confirmed target);
 *  (4) an IPC that THROWS rebinds back to the last-known active seat.
 *
 * The configService is faked as a tiny seat-keyed cache so we can assert the
 * renderer no longer serves seat A's value after a switch — i.e. rebindSeat was
 * called with the right seat.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mySeatsInvoke = vi.fn();
const switchSeatInvoke = vi.fn();
const isElectronDesktopMock = vi.fn();

const SEAT_A = '11111111-1111-1111-1111-111111111111';
const SEAT_B = '22222222-2222-2222-2222-222222222222';
const rotateRealtimeTransportForSeatRebind = vi.fn();

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    mySeats: { invoke: () => mySeatsInvoke() },
    switchSeat: { invoke: (req: { seatId?: string }) => switchSeatInvoke(req) },
  },
}));
vi.mock('@/common/adapter/httpBridge', () => ({ rotateRealtimeTransportForSeatRebind }));
// A faithful tiny fake of the renderer configService cache, declared INSIDE the
// hoisted factory (no top-level capture): it is bound to ONE seat at a time and
// only serves a seat-scoped value while bound to that seat. rebindSeat re-homes
// the binding (clearing the prior seat's served view).
vi.mock('@/common/config/configService', () => {
  // Literals inlined (the factory is hoisted above the SEAT_A/SEAT_B consts).
  const A = '11111111-1111-1111-1111-111111111111';
  const fake = {
    boundSeatId: A,
    store: { [A]: true } as Record<string, unknown>,
    rebindSeat: vi.fn(async (seatId: string) => {
      fake.boundSeatId = seatId;
    }),
    get(_key: string) {
      // Serve ONLY the currently-bound seat's value (mirrors the namespaced cache).
      return fake.store[fake.boundSeatId];
    },
  };
  return { configService: fake };
});
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => isElectronDesktopMock() }));

import { useSeatAccess, type SeatAccessState } from '@renderer/hooks/useSeatAccess';
import { configService as fakeConfigImport } from '@/common/config/configService';

// Typed handle to the fake exposed by the hoisted factory above.
const fakeConfig = fakeConfigImport as unknown as {
  boundSeatId: string;
  store: Record<string, unknown>;
  rebindSeat: ReturnType<typeof vi.fn>;
  get(key: string): unknown;
};

const contract = () => ({
  data: {
    version: 'command-eve-my-seats/v0',
    ok: true,
    source: 'my_seats',
    contract: {
      account_id: 'acc1',
      role: 'admin' as const,
      active_seat_id: SEAT_A,
      seats: [
        { seat_id: SEAT_A, name: 'A', role: 'admin' as const, is_active: true },
        { seat_id: SEAT_B, name: 'B', role: 'admin' as const, is_active: false },
      ],
    },
  },
  success: true,
});

function Harness({ onState }: { onState: (s: SeatAccessState) => void }) {
  const state = useSeatAccess();
  onState(state);
  return null;
}

beforeEach(() => {
  mySeatsInvoke.mockReset().mockResolvedValue(contract());
  switchSeatInvoke.mockReset();
  isElectronDesktopMock.mockReset().mockReturnValue(true);
  fakeConfig.boundSeatId = SEAT_A;
  fakeConfig.store = { [SEAT_A]: true };
  fakeConfig.rebindSeat.mockClear();
  rotateRealtimeTransportForSeatRebind.mockClear();
});
afterEach(() => vi.clearAllMocks());

async function mountAndSettle(): Promise<{ latest: () => SeatAccessState }> {
  let latest: SeatAccessState | null = null;
  await act(async () => {
    render(<Harness onState={(s) => (latest = s)} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { latest: () => latest as SeatAccessState };
}

describe('useSeatAccess.switchTo — renderer config cache re-homes (CONFIRMED-HIGH)', () => {
  it('a SUCCESSFUL switch A→B rebinds the renderer cache to B (no longer serves seat A config)', async () => {
    switchSeatInvoke.mockResolvedValue({ data: { ok: true, active_seat_id: SEAT_B }, success: true });
    const { latest } = await mountAndSettle();

    // Pre-switch: renderer is bound to seat A and serves seat A's clientSeeded.
    expect(fakeConfig.get('commandEve.clientSeeded')).toBe(true);
    expect(fakeConfig.boundSeatId).toBe(SEAT_A);

    let ok = false;
    await act(async () => {
      ok = await latest().switchTo(SEAT_B);
    });
    expect(ok).toBe(true);

    // THE FIX: rebindSeat was driven with the switched-to seat B.
    expect(fakeConfig.rebindSeat).toHaveBeenCalledWith(SEAT_B);
    // The renderer cache is now bound to B and NO LONGER serves seat A's value.
    expect(fakeConfig.boundSeatId).toBe(SEAT_B);
    expect(fakeConfig.get('commandEve.clientSeeded')).toBeUndefined();
  });

  it('rebinds to the AUTHORITATIVE active_seat_id from MAIN, not a stale local value', async () => {
    // Main reports it ended up on B even though, hypothetically, the local guess
    // could differ — the renderer must trust MAIN's authoritative seat.
    switchSeatInvoke.mockResolvedValue({ data: { ok: true, active_seat_id: SEAT_B }, success: true });
    const { latest } = await mountAndSettle();
    await act(async () => {
      await latest().switchTo(SEAT_B);
    });
    expect(fakeConfig.rebindSeat).toHaveBeenCalledWith(SEAT_B);
  });

  it('a FAILED / rolled-back switch rebinds back to the PRIOR seat (no drift)', async () => {
    // Main rejected/rolled back: ok=false and active_seat_id is the PRIOR seat A.
    switchSeatInvoke.mockResolvedValue({
      data: { ok: false, reason_code: 'SEAT_SWITCH_RESPAWN_FAILED', active_seat_id: SEAT_A },
      success: false,
    });
    const { latest } = await mountAndSettle();

    let ok = true;
    await act(async () => {
      ok = await latest().switchTo(SEAT_B);
    });
    expect(ok).toBe(false);

    // The renderer must re-home to the PRIOR seat A — never the un-confirmed B.
    expect(fakeConfig.rebindSeat).toHaveBeenCalledWith(SEAT_A);
    expect(fakeConfig.rebindSeat).not.toHaveBeenCalledWith(SEAT_B);
    expect(fakeConfig.boundSeatId).toBe(SEAT_A);
    // Seat A's config is still served (no leak the other way, no drift).
    expect(fakeConfig.get('commandEve.clientSeeded')).toBe(true);
  });

  it('an IPC that THROWS rebinds back to the last-known active seat (A)', async () => {
    switchSeatInvoke.mockRejectedValue(new Error('bridge exploded'));
    const { latest } = await mountAndSettle();

    let ok = true;
    await act(async () => {
      ok = await latest().switchTo(SEAT_B);
    });
    expect(ok).toBe(false);
    expect(fakeConfig.rebindSeat).toHaveBeenCalledWith(SEAT_A);
    expect(fakeConfig.rebindSeat).not.toHaveBeenCalledWith(SEAT_B);
    expect(fakeConfig.boundSeatId).toBe(SEAT_A);
  });

  it('on the 45s UI timeout, the rebind follows the LATE real settle — a rollback re-homes to PRIOR, never the target guess', async () => {
    // The completeness-critic HIGH: the old code rebound to main's MID-FLIGHT pointer
    // (= target) at the 45s mark; if main then rolled back, the renderer was stranded on
    // the target. Now the rebind is driven by the REAL settle, so a late rollback wins.
    vi.useFakeTimers();
    try {
      let resolveInvoke!: (v: unknown) => void;
      switchSeatInvoke.mockReturnValue(
        new Promise((res) => {
          resolveInvoke = res;
        })
      );
      const { latest } = await mountAndSettle();

      let result: boolean | undefined;
      const switchPromise = latest()
        .switchTo(SEAT_B)
        .then((r) => {
          result = r;
        });

      // Advance past the 45s UI timeout → switchTo returns false, the rail un-freezes,
      // and main has NOT settled, so there is NO authoritative rebind to the target yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(result).toBe(false);
      expect(fakeConfig.rebindSeat).not.toHaveBeenCalledWith(SEAT_B);

      // Main settles LATE with a ROLLBACK to the prior seat A.
      await act(async () => {
        resolveInvoke({
          data: { ok: false, reason_code: 'SEAT_SWITCH_RESPAWN_FAILED', active_seat_id: SEAT_A },
          success: false,
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      // The renderer ends bound to main's TRUE terminal seat (A) — never the un-confirmed B.
      expect(fakeConfig.rebindSeat).toHaveBeenCalledWith(SEAT_A);
      expect(fakeConfig.rebindSeat).not.toHaveBeenCalledWith(SEAT_B);
      expect(fakeConfig.boundSeatId).toBe(SEAT_A);
      await switchPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});
