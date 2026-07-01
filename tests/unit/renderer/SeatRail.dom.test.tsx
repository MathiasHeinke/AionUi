/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SeatRail render + behavior tests — the far-left client/seat bar.
 * Asserts: an admin sees one circle per seat with the active one marked; a click on
 * a NON-active seat switches (never the active one, never while switching); a
 * delegate / loading state renders NOTHING (fail-closed); the "+" routes to the web
 * account (no dead button); and the pure color/initials helpers.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { switchToMock, openExternalMock, useSeatAccessMock, messageErrorMock } = vi.hoisted(() => ({
  switchToMock: vi.fn(),
  openExternalMock: vi.fn(),
  useSeatAccessMock: vi.fn(),
  messageErrorMock: vi.fn(),
}));

vi.mock('@renderer/hooks/useSeatAccess', () => ({ useSeatAccess: useSeatAccessMock }));
vi.mock('@renderer/utils/platform', () => ({ openExternalUrl: openExternalMock }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown, vars?: { name?: string }) =>
      typeof d === 'string' ? (vars?.name ? d.replace('{{name}}', vars.name) : d) : _k,
  }),
}));
// Arco Tooltip just wraps its child; Message.error is spied so we can assert a failed
// switch is surfaced (not swallowed).
vi.mock('@arco-design/web-react', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Message: { error: messageErrorMock },
}));

import SeatRail, { seatColor, seatInitials, contrastText } from '@renderer/components/seats/SeatRail';

type Over = Record<string, unknown>;
function mockAccess(over: Over = {}) {
  useSeatAccessMock.mockReturnValue({
    loading: false,
    switching: false,
    lastSwitchError: null,
    switchErrorNonce: 0,
    refresh: vi.fn(),
    switchTo: switchToMock,
    access: {
      role: 'admin',
      canSwitch: true,
      pinnedSeatId: 's1',
      activeSeatId: 's1',
      seats: [
        { seat_id: 's1', name: 'Bäckerei Hofmann', role: 'admin', is_active: true },
        { seat_id: 's2', name: 'Käserei Schmidt', role: 'admin', is_active: false },
        { seat_id: 's3', name: 'Metzgerei Lang', role: 'admin', is_active: false },
      ],
    },
    ...over,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SeatRail', () => {
  it('renders a circle per seat for an admin, active one marked + a "+"', () => {
    mockAccess();
    render(<SeatRail />);
    expect(screen.getByTestId('seat-rail')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-seat-s1')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-seat-s2')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-seat-s3')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-seat-s1').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('seat-rail-seat-s2').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('seat-rail-add')).toBeTruthy();
  });

  it('switches on a NON-active seat click, never on the active one', () => {
    mockAccess();
    render(<SeatRail />);
    fireEvent.click(screen.getByTestId('seat-rail-seat-s2'));
    expect(switchToMock).toHaveBeenCalledWith('s2');
    fireEvent.click(screen.getByTestId('seat-rail-seat-s1')); // active → no-op
    expect(switchToMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT switch while a switch is already in flight', () => {
    mockAccess({ switching: true });
    render(<SeatRail />);
    fireEvent.click(screen.getByTestId('seat-rail-seat-s2'));
    expect(switchToMock).not.toHaveBeenCalled();
  });

  it('renders NOTHING for a delegate (fail-closed)', () => {
    useSeatAccessMock.mockReturnValue({
      loading: false,
      switching: false,
      lastSwitchError: null,
      refresh: vi.fn(),
      switchTo: switchToMock,
      access: { role: 'delegate', canSwitch: false, pinnedSeatId: 's1', activeSeatId: 's1', seats: [{ seat_id: 's1', name: 'X', role: 'delegate', is_active: true }] },
    });
    const { container } = render(<SeatRail />);
    expect(container.querySelector('[data-testid="seat-rail"]')).toBeNull();
  });

  it('renders NOTHING while loading', () => {
    useSeatAccessMock.mockReturnValue({ loading: true, switching: false, lastSwitchError: null, refresh: vi.fn(), switchTo: switchToMock, access: { role: 'admin', canSwitch: false, pinnedSeatId: 's1', activeSeatId: 's1', seats: [] } });
    const { container } = render(<SeatRail />);
    expect(container.querySelector('[data-testid="seat-rail"]')).toBeNull();
  });

  it('the "+" routes to the web account (no dead button)', () => {
    mockAccess();
    render(<SeatRail />);
    fireEvent.click(screen.getByTestId('seat-rail-add'));
    expect(openExternalMock).toHaveBeenCalledWith('https://command-eve.com/account');
  });

  it('toggle collapses/expands the rail', () => {
    mockAccess();
    render(<SeatRail />);
    const rail = screen.getByTestId('seat-rail');
    expect(rail.className).toContain('command-eve-seat-rail--expanded');
    fireEvent.click(screen.getByTestId('seat-rail-toggle'));
    expect(screen.getByTestId('seat-rail').className).toContain('command-eve-seat-rail--collapsed');
  });

  it('surfaces a failed switch (lastSwitchError) instead of failing silently', () => {
    mockAccess({ lastSwitchError: 'SWITCH_SEAT_BRIDGE_FAILED' });
    render(<SeatRail />);
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
    expect(String(messageErrorMock.mock.calls[0][0].content)).toContain('fehlgeschlagen');
  });

  it('does NOT show an error toast on a clean render (no lastSwitchError)', () => {
    mockAccess();
    render(<SeatRail />);
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it('Hotfix-B: the dead-backend fail-closed code shows a DISTINCT relaunch message, NOT the misleading "läuft weiter"', () => {
    mockAccess({ lastSwitchError: 'SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN' });
    render(<SeatRail />);
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
    const content = String(messageErrorMock.mock.calls[0][0].content);
    // Honest: it tells the operator to relaunch and does NOT claim EVE keeps running.
    expect(content).toContain('neu');
    expect(content).not.toContain('läuft weiter');
  });

  it('re-fires the toast when the SAME reject code repeats (nonce bump)', () => {
    mockAccess({ lastSwitchError: 'SWITCH_SEAT_FORBIDDEN', switchErrorNonce: 1 });
    const { rerender } = render(<SeatRail />);
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
    // Same code, bumped nonce ⇒ effect must re-fire (the sync-batch case).
    mockAccess({ lastSwitchError: 'SWITCH_SEAT_FORBIDDEN', switchErrorNonce: 2 });
    rerender(<SeatRail />);
    expect(messageErrorMock).toHaveBeenCalledTimes(2);
  });

  it('disables seats during a switch via aria-disabled (keeps focus), not the disabled attr', () => {
    mockAccess({ switching: true });
    render(<SeatRail />);
    const seat = screen.getByTestId('seat-rail-seat-s2');
    expect(seat.getAttribute('aria-disabled')).toBe('true');
    expect(seat.hasAttribute('disabled')).toBe(false);
  });

  it('mirrors a failed switch into an aria-live region for screen readers', () => {
    mockAccess({ lastSwitchError: 'SWITCH_SEAT_BRIDGE_FAILED', switchErrorNonce: 1 });
    render(<SeatRail />);
    const live = screen.getByTestId('seat-rail-live');
    expect(live.getAttribute('role')).toBe('alert');
    expect(live.textContent).toContain('fehlgeschlagen');
  });

  it('the live region is empty (silent) when there is no switch error', () => {
    mockAccess();
    render(<SeatRail />);
    expect(screen.getByTestId('seat-rail-live').textContent).toBe('');
  });
});

describe('seat helpers', () => {
  it('seatInitials maps names to 2 letters', () => {
    expect(seatInitials('Bäckerei Hofmann')).toBe('BH');
    expect(seatInitials('Käserei Schmidt')).toBe('KS');
    expect(seatInitials('Solo')).toBe('SO');
    expect(seatInitials('')).toBe('?');
    expect(seatInitials('  a   b   c ')).toBe('AC');
  });
  it('seatColor is deterministic + a hex from the palette', () => {
    expect(seatColor('s1')).toBe(seatColor('s1'));
    expect(seatColor('s1')).toMatch(/^#[0-9a-f]{6}$/i);
    // different keys generally differ (sanity, not a hard guarantee)
    expect(new Set(['a', 'b', 'c', 'd', 'e'].map(seatColor)).size).toBeGreaterThan(1);
  });
  it('contrastText picks dark ink on light swatches, white on dark — clears AA', () => {
    // amber #ca8a04: white was 2.94:1 (AA fail) → must pick dark ink #1d2129 (5.49:1).
    expect(contrastText('#ca8a04')).toBe('#1d2129');
    expect(contrastText('#ea580c')).toBe('#1d2129'); // orange-600, white only 3.56:1
    // deep blue/purple: white is the high-contrast choice.
    expect(contrastText('#2563eb')).toBe('#ffffff');
    expect(contrastText('#7c3aed')).toBe('#ffffff');
    // never returns anything but the two inks
    expect(['#1d2129', '#ffffff']).toContain(contrastText('#15803d'));
  });
});
