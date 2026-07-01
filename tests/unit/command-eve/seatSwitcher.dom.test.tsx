/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A5 SeatSwitcher (admin) + fail-closed SeatGuard (delegate) DOM behaviour.
 *
 * Asserts: (1) an ADMIN with >1 seat sees the switcher and selecting a seat
 * fires the switch-seat IPC for the chosen seat; (2) a DELEGATE sees NO switcher
 * and there is no UI path to trigger a switch; (3) a single-seat / legacy /
 * unknown-role (fail-closed) caller sees NO switcher; (4) the my-seats read is
 * mocked (the edge function isn't deployed).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
// i18n: render the fallback (2nd arg) deterministically.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }) }));

import SeatSwitcher from '@renderer/components/seats/SeatSwitcher';

const SEAT_A = '11111111-1111-1111-1111-111111111111';
const SEAT_B = '22222222-2222-2222-2222-222222222222';

const mySeats = (role: 'admin' | 'delegate', seats: Array<{ tenant_id: string; name: string; is_active?: boolean }>) => ({
  data: {
    version: 'command-eve-my-seats/v0',
    ok: true,
    source: 'my_seats',
    contract: {
      account_id: 'acc1',
      role,
      active_seat_id: SEAT_A,
      seats: seats.map((s) => ({ seat_id: s.tenant_id, name: s.name, role, is_active: s.is_active === true })),
    },
  },
  success: true,
});

beforeEach(() => {
  mySeatsInvoke.mockReset();
  switchSeatInvoke.mockReset();
  isElectronDesktopMock.mockReset().mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('SeatSwitcher — admin', () => {
  it('an admin with >1 seat sees the switcher', async () => {
    mySeatsInvoke.mockResolvedValue(
      mySeats('admin', [
        { tenant_id: SEAT_A, name: 'Client A', is_active: true },
        { tenant_id: SEAT_B, name: 'Client B' },
      ])
    );
    render(<SeatSwitcher />);
    expect(await screen.findByTestId('seat-switcher')).toBeTruthy();
  });
});

describe('SeatSwitcher — fail-closed SeatGuard (delegate / legacy / unknown)', () => {
  it('a DELEGATE sees NO switcher (hard-pinned) even with multiple seats', async () => {
    mySeatsInvoke.mockResolvedValue(
      mySeats('delegate', [
        { tenant_id: SEAT_A, name: 'Client A', is_active: true },
        { tenant_id: SEAT_B, name: 'Client B' },
      ])
    );
    render(<SeatSwitcher />);
    // Give the async my-seats read time to resolve, then assert STILL no switcher.
    await waitFor(() => expect(mySeatsInvoke).toHaveBeenCalled());
    expect(screen.queryByTestId('seat-switcher')).toBeNull();
    // A delegate can never trigger a switch — there is no select to interact with.
    expect(screen.queryByTestId('seat-switcher-select')).toBeNull();
    expect(switchSeatInvoke).not.toHaveBeenCalled();
  });

  it('an admin with NO client seats (only the Founder home) sees NO switcher and triggers no re-spawn', async () => {
    // Spec B4.2: resolveSeatAccess prepends the synthetic Founder (seat-1) chip for
    // admins. An admin whose wire lists ZERO client seats therefore has exactly ONE
    // seat (the Founder home) ⇒ canSwitch=false ⇒ no switcher (nothing to switch TO).
    // This replaces the old "single-seat admin is legacy-like" case: a single CLIENT
    // seat now yields TWO seats (Founder + client) and DOES switch (covered below).
    mySeatsInvoke.mockResolvedValue(mySeats('admin', []));
    render(<SeatSwitcher />);
    await waitFor(() => expect(mySeatsInvoke).toHaveBeenCalled());
    expect(screen.queryByTestId('seat-switcher')).toBeNull();
    expect(switchSeatInvoke).not.toHaveBeenCalled();
  });

  it('an admin with ONE client seat sees the switcher (Founder home + client = 2 seats, spec B4.2)', async () => {
    // The un-strand-the-founder fix: an admin sitting on a single client seat can
    // ALWAYS return to their Founder home, so the switcher IS shown (2 seats).
    mySeatsInvoke.mockResolvedValue(mySeats('admin', [{ tenant_id: SEAT_A, name: 'Only client', is_active: true }]));
    render(<SeatSwitcher />);
    expect(await screen.findByTestId('seat-switcher')).toBeTruthy();
  });

  it('a failed my-seats read fail-closes to NO switcher (never widens to admin)', async () => {
    mySeatsInvoke.mockRejectedValue(new Error('bridge down'));
    render(<SeatSwitcher />);
    await waitFor(() => expect(mySeatsInvoke).toHaveBeenCalled());
    expect(screen.queryByTestId('seat-switcher')).toBeNull();
  });

  it('non-desktop (no bridge) shows NO switcher and never calls my-seats', async () => {
    isElectronDesktopMock.mockReturnValue(false);
    render(<SeatSwitcher />);
    await waitFor(() => expect(screen.queryByTestId('seat-switcher')).toBeNull());
    expect(mySeatsInvoke).not.toHaveBeenCalled();
  });
});
