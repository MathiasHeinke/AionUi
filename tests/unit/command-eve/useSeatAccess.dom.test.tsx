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
