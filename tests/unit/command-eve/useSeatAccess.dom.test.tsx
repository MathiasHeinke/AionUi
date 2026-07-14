/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A5 useSeatAccess — the SeatGuard data source + switch controller.
 *
 * Asserts the renderer-side fail-closed behaviour that backs the SeatSwitcher:
 *  - a DELEGATE's switchTo() is SHORT-CIRCUITED (never even fires the IPC) — a
 *    delegate can never trigger a switch to a foreign seat from the renderer;
 *  - an ADMIN's switchTo() fires the IPC for the chosen seat and re-reads on resolve;
 *  - a successful switch re-reads the my-seats contract.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mySeatsInvoke = vi.fn();
const switchSeatInvoke = vi.fn();
const isElectronDesktopMock = vi.fn();

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    mySeats: { invoke: () => mySeatsInvoke() },
    switchSeat: { invoke: (req: { seatId?: string }) => switchSeatInvoke(req) },
  },
}));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => isElectronDesktopMock() }));

import { useSeatAccess, type SeatAccessState } from '@renderer/hooks/useSeatAccess';

const SEAT_A = '11111111-1111-1111-1111-111111111111';
const SEAT_B = '22222222-2222-2222-2222-222222222222';

const contract = (role: 'admin' | 'delegate') => ({
  data: {
    version: 'command-eve-my-seats/v0',
    ok: true,
    source: 'my_seats',
    contract: {
      account_id: 'acc1',
      role,
      active_seat_id: SEAT_A,
      seats: [
        { seat_id: SEAT_A, name: 'A', role, is_active: true },
        { seat_id: SEAT_B, name: 'B', role, is_active: false },
      ],
    },
  },
  success: true,
});

/** Tiny harness that surfaces the hook's latest state to the test. */
function Harness({ onState }: { onState: (s: SeatAccessState) => void }) {
  const state = useSeatAccess();
  onState(state);
  return null;
}

beforeEach(() => {
  mySeatsInvoke.mockReset();
  switchSeatInvoke.mockReset().mockResolvedValue({ data: { ok: true, active_seat_id: SEAT_B }, success: true });
  isElectronDesktopMock.mockReset().mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

async function mountAndSettle(): Promise<{ latest: () => SeatAccessState }> {
  let latest: SeatAccessState | null = null;
  await act(async () => {
    render(<Harness onState={(s) => (latest = s)} />);
  });
  // allow the my-seats read effect to resolve
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { latest: () => latest as SeatAccessState };
}

describe('useSeatAccess — delegate switchTo is short-circuited (fail-closed)', () => {
  it('a delegate calling switchTo(foreign seat) NEVER fires the switch IPC', async () => {
    mySeatsInvoke.mockResolvedValue(contract('delegate'));
    const { latest } = await mountAndSettle();
    expect(latest().access.role).toBe('delegate');
    expect(latest().access.canSwitch).toBe(false);

    let ok = true;
    await act(async () => {
      ok = await latest().switchTo(SEAT_B);
    });
    expect(ok).toBe(false);
    expect(switchSeatInvoke).not.toHaveBeenCalled();
    expect(latest().lastSwitchError).toBe('SWITCH_SEAT_FORBIDDEN');
  });
});

describe('useSeatAccess — admin switchTo fires the IPC', () => {
  it('an admin switchTo(seat in list) fires the switch-seat IPC for that seat', async () => {
    mySeatsInvoke.mockResolvedValue(contract('admin'));
    const { latest } = await mountAndSettle();
    expect(latest().access.canSwitch).toBe(true);

    await act(async () => {
      await latest().switchTo(SEAT_B);
    });
    expect(switchSeatInvoke).toHaveBeenCalledWith({ seatId: SEAT_B });
    // re-read fired after the switch resolves (initial read + post-switch read).
    expect(mySeatsInvoke.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('an admin switchTo(unknown seat NOT in list) is short-circuited (no IPC)', async () => {
    mySeatsInvoke.mockResolvedValue(contract('admin'));
    const { latest } = await mountAndSettle();
    await act(async () => {
      await latest().switchTo('33333333-3333-3333-3333-333333333333');
    });
    expect(switchSeatInvoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// M4 — seat-refresh on window focus (a seat bought on the web appears w/o restart)
// ---------------------------------------------------------------------------

const SEAT_C = '33333333-3333-3333-3333-333333333333';

/** A my-seats contract with a THIRD seat (the one "bought on the web"). */
const contractWithNewSeat = () => ({
  data: {
    version: 'command-eve-my-seats/v0',
    ok: true,
    source: 'my_seats',
    contract: {
      account_id: 'acc1',
      role: 'admin' as const,
      active_seat_id: SEAT_A,
      seats: [
        { seat_id: SEAT_A, name: 'A', role: 'admin', is_active: true },
        { seat_id: SEAT_B, name: 'B', role: 'admin', is_active: false },
        { seat_id: SEAT_C, name: 'C (new)', role: 'admin', is_active: false },
      ],
    },
  },
  success: true,
});

describe('useSeatAccess — M4 focus reconcile picks up a newly-bought seat', () => {
  it('re-reads my-seats on window focus so a new seat appears without a restart', async () => {
    // A flag flips to the 3-seat contract ONLY after the operator "buys on the
    // web"; until then every read (mount + any settle flush) sees two seats. The
    // focus reconcile after the flip re-reads and now sees the THIRD seat.
    // NOTE: resolveSeatAccess PREPENDS a synthetic founder chip (legacy 'seat-1')
    // for an admin, so access.seats = [founder-chip, ...contract seats]. We assert
    // on the NEW client seat's PRESENCE, not the raw count, to stay robust to that.
    let newSeatBought = false;
    mySeatsInvoke.mockImplementation(() => Promise.resolve(newSeatBought ? contractWithNewSeat() : contract('admin')));
    const { latest } = await mountAndSettle();
    expect(latest().access.seats.some((s) => s.seat_id === SEAT_C)).toBe(false);
    const seatsBefore = latest().access.seats.length;
    const readsBeforeFocus = mySeatsInvoke.mock.calls.length;

    // Operator buys a seat on the web, then tabs back to the app (window focus).
    newSeatBought = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mySeatsInvoke.mock.calls.length).toBeGreaterThan(readsBeforeFocus);
    // The reconcile added exactly the newly-bought seat (no restart needed).
    expect(latest().access.seats).toHaveLength(seatsBefore + 1);
    expect(latest().access.seats.some((s) => s.seat_id === SEAT_C)).toBe(true);
  });

  it('does NOT reconcile on focus while a switch is in flight (no race with switching)', async () => {
    mySeatsInvoke.mockResolvedValue(contract('admin'));
    // Hold the switch IPC open so `switching` stays true across the focus event.
    let releaseSwitch: (v: { data: { ok: boolean; active_seat_id: string }; success: boolean }) => void = () => {};
    switchSeatInvoke.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSwitch = resolve;
        })
    );
    const { latest } = await mountAndSettle();
    const readsBeforeSwitch = mySeatsInvoke.mock.calls.length;

    // Start a switch but do NOT resolve it yet ⇒ switching === true.
    let switchPromise: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      switchPromise = latest().switchTo(SEAT_B);
      await Promise.resolve();
    });
    expect(latest().switching).toBe(true);

    // A focus event mid-switch must be SKIPPED (no extra my-seats read).
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mySeatsInvoke.mock.calls.length).toBe(readsBeforeSwitch);

    // Release the switch so the hook settles (its own authoritative refresh runs).
    await act(async () => {
      releaseSwitch({ data: { ok: true, active_seat_id: SEAT_B }, success: true });
      await switchPromise;
      await Promise.resolve();
    });
    expect(latest().switching).toBe(false);
  });
});
