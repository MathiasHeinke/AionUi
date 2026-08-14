/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SeatRail render + behavior tests — the far-left client/seat bar.
 * Asserts: an admin sees one circle per seat with the active one marked; a click on
 * a NON-active seat switches (never the active one, never while switching); a
 * delegate / loading state renders NOTHING (fail-closed); the "+" provisions a
 * Seed inside the app; and the pure color/initials helpers.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  switchToMock,
  useSeatAccessMock,
  useSeedLifecycleMock,
  createSeedMock,
  resetCreateAttemptMock,
  messageErrorMock,
  messageSuccessMock,
  modalConfirmMock,
  isAnyGeneratingMock,
  clearGenerationForBackendRespawnMock,
} = vi.hoisted(() => ({
  switchToMock: vi.fn(),
  useSeatAccessMock: vi.fn(),
  useSeedLifecycleMock: vi.fn(),
  createSeedMock: vi.fn(),
  resetCreateAttemptMock: vi.fn(),
  messageErrorMock: vi.fn(),
  messageSuccessMock: vi.fn(),
  modalConfirmMock: vi.fn(),
  isAnyGeneratingMock: vi.fn(() => false),
  clearGenerationForBackendRespawnMock: vi.fn(),
}));

vi.mock('@renderer/hooks/useSeatAccess', () => ({ useSeatAccess: useSeatAccessMock }));
vi.mock('@renderer/hooks/useSeedLifecycle', () => ({ useSeedLifecycle: useSeedLifecycleMock }));
vi.mock('@renderer/services/commandEveGenerationActivity', () => ({
  isAnyGenerating: isAnyGeneratingMock,
  ensureAcpGenerationTracking: vi.fn(),
  clearGenerationForBackendRespawn: clearGenerationForBackendRespawnMock,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown, vars?: { name?: string }) =>
      typeof d === 'string' ? (vars?.name ? d.replace('{{name}}', vars.name) : d) : _k,
  }),
}));
// Arco Tooltip just wraps; Modal renders its content when visible.
vi.mock('@arco-design/web-react', () => {
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    Button: ({
      children,
      loading,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
      <button {...props} disabled={loading || props.disabled}>
        {children}
      </button>
    ),
    Input: ({
      onChange,
      ...props
    }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & { onChange?: (value: string) => void }) => (
      <input {...props} onChange={(event) => onChange?.(event.target.value)} />
    ),
    Message: { error: messageErrorMock, success: messageSuccessMock },
    Modal: Object.assign(
      ({ visible, children, footer }: React.PropsWithChildren<{ visible?: boolean; footer?: React.ReactNode }>) =>
        visible ? (
          <div role='dialog'>
            {children}
            {footer}
          </div>
        ) : null,
      { confirm: modalConfirmMock }
    ),
  };
});

import SeatRail, { seatColor, seatInitials, contrastText } from '@renderer/components/seats/SeatRail';

type Over = Record<string, unknown>;
function mockAccess(over: Over = {}) {
  useSeedLifecycleMock.mockReturnValue({
    provisioning: false,
    retryPending: false,
    createSeed: createSeedMock,
    resetCreateAttempt: resetCreateAttemptMock,
  });
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
  isAnyGeneratingMock.mockReturnValue(false);
});

describe('SeatRail', () => {
  it('renders the public EVE brand and one neutral identity tile per admin seat', () => {
    mockAccess();
    const { container } = render(<SeatRail />);
    expect(screen.getByTestId('seat-rail')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-brand').querySelector('[data-testid="command-eve-glyph"]')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
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

  it('protects a running turn until the operator confirms the seat switch', () => {
    isAnyGeneratingMock.mockReturnValue(true);
    mockAccess();
    render(<SeatRail />);

    fireEvent.click(screen.getByTestId('seat-rail-seat-s2'));

    expect(modalConfirmMock).toHaveBeenCalledTimes(1);
    expect(modalConfirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Antwort läuft noch',
        okText: 'Trotzdem wechseln',
        cancelText: 'Abbrechen',
        onOk: expect.any(Function),
      })
    );
    expect(clearGenerationForBackendRespawnMock).not.toHaveBeenCalled();
    expect(switchToMock).not.toHaveBeenCalled();

    const onOk = modalConfirmMock.mock.calls[0]?.[0]?.onOk as (() => void) | undefined;
    expect(onOk).toBeTypeOf('function');
    onOk?.();

    expect(clearGenerationForBackendRespawnMock).toHaveBeenCalledTimes(1);
    expect(switchToMock).toHaveBeenCalledTimes(1);
    expect(switchToMock).toHaveBeenCalledWith('s2');
  });

  it('keeps the current seat when a running-turn switch prompt is cancelled', () => {
    isAnyGeneratingMock.mockReturnValue(true);
    mockAccess();
    render(<SeatRail />);

    fireEvent.click(screen.getByTestId('seat-rail-seat-s2'));

    expect(modalConfirmMock).toHaveBeenCalledTimes(1);
    expect(clearGenerationForBackendRespawnMock).not.toHaveBeenCalled();
    expect(switchToMock).not.toHaveBeenCalled();
  });

  it('renders NOTHING for a delegate (fail-closed)', () => {
    useSeatAccessMock.mockReturnValue({
      loading: false,
      switching: false,
      lastSwitchError: null,
      refresh: vi.fn(),
      switchTo: switchToMock,
      access: {
        role: 'delegate',
        canSwitch: false,
        pinnedSeatId: 's1',
        activeSeatId: 's1',
        seats: [{ seat_id: 's1', name: 'X', role: 'delegate', is_active: true }],
      },
    });
    const { container } = render(<SeatRail />);
    expect(container.querySelector('[data-testid="seat-rail"]')).toBeNull();
  });

  it('renders NOTHING while loading', () => {
    useSeatAccessMock.mockReturnValue({
      loading: true,
      switching: false,
      lastSwitchError: null,
      refresh: vi.fn(),
      switchTo: switchToMock,
      access: { role: 'admin', canSwitch: false, pinnedSeatId: 's1', activeSeatId: 's1', seats: [] },
    });
    const { container } = render(<SeatRail />);
    expect(container.querySelector('[data-testid="seat-rail"]')).toBeNull();
  });

  it('the "+" provisions a free Seed inside the app without a website redirect', async () => {
    createSeedMock.mockResolvedValue({
      ok: true,
      seedId: '44444444-4444-4444-8444-444444444444',
      created: true,
      seedCount: 4,
      seedLimit: 1000,
    });
    mockAccess();
    render(<SeatRail />);
    fireEvent.click(screen.getByTestId('seat-rail-add'));
    fireEvent.change(screen.getByTestId('seed-create-name'), { target: { value: 'Neuer Seed' } });
    fireEvent.click(screen.getByTestId('seed-create-submit'));
    await waitFor(() => expect(createSeedMock).toHaveBeenCalledWith('Neuer Seed'));
    expect(messageSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('keeps free in-app creation enabled beyond the obsolete ten-Seat limit', () => {
    mockAccess({
      access: {
        role: 'admin',
        canSwitch: true,
        pinnedSeatId: 's1',
        activeSeatId: 's1',
        seats: Array.from({ length: 20 }, (_, index) => ({
          seat_id: `s${index + 1}`,
          name: `Seed ${index + 1}`,
          role: 'admin',
          is_active: index === 0,
        })),
      },
    });
    render(<SeatRail />);
    expect(screen.getByTestId('seat-rail-add').hasAttribute('disabled')).toBe(false);
  });

  it('keeps a timed-out attempt in reconciliation mode', () => {
    createSeedMock.mockResolvedValue({ ok: false, seedLimit: 1000, reasonCode: 'SEED_PROVISION_TIMEOUT' });
    mockAccess();
    useSeedLifecycleMock.mockReturnValue({
      provisioning: false,
      retryPending: true,
      createSeed: createSeedMock,
      resetCreateAttempt: resetCreateAttemptMock,
    });

    render(<SeatRail />);
    fireEvent.click(screen.getByTestId('seat-rail-add'));
    expect(screen.getByTestId('seed-create-name').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('seed-create-submit').textContent).toBe('Erneut abgleichen');
    expect(resetCreateAttemptMock).not.toHaveBeenCalled();
  });

  it('toggle collapses/expands the rail', () => {
    mockAccess();
    render(<SeatRail />);
    const rail = screen.getByTestId('seat-rail');
    expect(rail.className).toContain('command-eve-seat-rail--expanded');
    fireEvent.click(screen.getByTestId('seat-rail-toggle'));
    expect(screen.getByTestId('seat-rail').className).toContain('command-eve-seat-rail--collapsed');
  });

  it('keeps the same seat navigation reachable in compact narrow-layout mode', () => {
    mockAccess();
    render(<SeatRail compact />);

    const rail = screen.getByTestId('seat-rail');
    expect(rail.className).toContain('command-eve-seat-rail--compact');
    expect(rail.className).toContain('command-eve-seat-rail--collapsed');
    expect(screen.queryByTestId('seat-rail-toggle')).toBeNull();
    expect(screen.getByTestId('seat-rail-seat-s1').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('seat-rail-seat-s2')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-add')).toBeTruthy();
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

  it('tells the operator to relaunch after an uncertain committed switch', () => {
    mockAccess({ lastSwitchError: 'SWITCH_SEAT_RECOVERY_REQUIRED' });
    render(<SeatRail />);
    const content = String(messageErrorMock.mock.calls[0][0].content);
    expect(content).toContain('Starte Command EVE neu');
    expect(content).toContain('keinem Kunden-Seat');
    expect(content).not.toContain('bisherigen Kunden');
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

  // MAT-1773 — the founder's invisible-rail fix: a FAILED my-seats read with local
  // admin evidence resolves the DEGRADED posture (own seat + add entry, no switch
  // targets). The rail MUST render — hidden was the bug.
  it('renders for an admin on the DEGRADED posture (failed my-seats read): own seat + add entry, no switch targets', () => {
    mockAccess({
      mySeatsSource: 'legacy_fallback',
      access: {
        role: 'admin',
        canSwitch: false,
        pinnedSeatId: 'seat-1',
        activeSeatId: 'seat-1',
        seats: [{ seat_id: 'seat-1', name: 'Founder', kind: 'own_company', role: 'admin', is_active: true }],
      },
    });
    render(<SeatRail />);
    expect(screen.getByTestId('seat-rail')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-seat-seat-1')).toBeTruthy();
    expect(screen.getByTestId('seat-rail-seat-seat-1').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('seat-rail-add')).toBeTruthy();
    // The only seat is the ACTIVE one — clicking it never fires a switch.
    fireEvent.click(screen.getByTestId('seat-rail-seat-seat-1'));
    expect(switchToMock).not.toHaveBeenCalled();
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
