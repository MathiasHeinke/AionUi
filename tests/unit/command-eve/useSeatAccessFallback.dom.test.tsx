/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 — useSeatAccess DEGRADED admin fallback (the founder's invisible-rail
 * fix). On a FAILED my-seats read the hook used to fail-closed to a hidden
 * delegate rail UNCONDITIONALLY. These tests pin the new contract:
 *
 *  - legacy_fallback / bridge error + LOCAL admin evidence (cached last-good
 *    snapshot, or a bound non-legacy seat from a previously authorized switch)
 *    ⇒ the rail stays visible in the degraded posture: own seat only,
 *    canSwitch=false, never a fabricated seat;
 *  - NO evidence ⇒ byte-identical fail-closed delegate (genuine legacy install);
 *  - a failed read surfaces a transition-gated writeRendererLog diagnostic;
 *  - a LIVE admin read persists the snapshot; a live delegate read removes it
 *    (a demotion is authoritative — no phantom admin rail).
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mySeatsInvoke = vi.fn();
const writeRendererLogInvoke = vi.fn();
const isElectronDesktopMock = vi.fn();
const configGetMock = vi.fn();
const configSetMock = vi.fn();
const configRemoveMock = vi.fn();
const getCurrentSeatIdMock = vi.fn();

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    mySeats: { invoke: () => mySeatsInvoke() },
    switchSeat: { invoke: vi.fn() },
  },
  application: {
    writeRendererLog: { invoke: (entry: unknown) => writeRendererLogInvoke(entry) },
  },
}));
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => configGetMock(key),
    set: (key: string, value: unknown) => configSetMock(key, value),
    remove: (key: string) => configRemoveMock(key),
    getCurrentSeatId: () => getCurrentSeatIdMock(),
    rebindSeat: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => isElectronDesktopMock() }));

import { useSeatAccess, type SeatAccessState } from '@renderer/hooks/useSeatAccess';

const SEAT_A = '11111111-1111-1111-1111-111111111111';
const SEAT_B = '22222222-2222-2222-2222-222222222222';
const SNAPSHOT_KEY = 'commandEve.lastMySeatsSnapshot';

/** The bridge's fail-closed envelope (main could not read the wire). */
const legacyFallback = () => ({
  data: {
    version: 'command-eve-my-seats/v0',
    ok: true,
    source: 'legacy_fallback',
    contract: { account_id: null, role: 'delegate', active_seat_id: 'seat-1', seats: [] },
  },
  success: true,
});

const liveContract = (role: 'admin' | 'delegate') => ({
  data: {
    version: 'command-eve-my-seats/v0',
    ok: true,
    source: 'my_seats',
    contract: {
      account_id: 'acc1',
      role,
      active_seat_id: SEAT_A,
      seats: [
        { seat_id: SEAT_A, name: 'Alois', role, is_active: true },
        { seat_id: SEAT_B, name: 'Berta', role, is_active: false },
      ],
    },
  },
  success: true,
});

const adminSnapshot = (activeSeatId: string, name: string) => ({
  role: 'admin',
  active_seat_id: activeSeatId,
  active_seat_name: name,
  at: Date.now(),
});

/** Tiny harness that surfaces the hook's latest state to the test. */
function Harness({ onState }: { onState: (s: SeatAccessState) => void }) {
  const state = useSeatAccess();
  onState(state);
  return null;
}

beforeEach(() => {
  mySeatsInvoke.mockReset();
  writeRendererLogInvoke.mockReset().mockReturnValue(Promise.resolve());
  isElectronDesktopMock.mockReset().mockReturnValue(true);
  configGetMock.mockReset().mockReturnValue(undefined);
  configSetMock.mockReset().mockReturnValue(Promise.resolve());
  configRemoveMock.mockReset().mockReturnValue(Promise.resolve());
  getCurrentSeatIdMock.mockReset().mockReturnValue('seat-1');
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

describe('useSeatAccess — MAT-1773 degraded admin fallback on a failed my-seats read', () => {
  it('legacy_fallback + cached admin snapshot ⇒ degraded admin posture (own founder seat, canSwitch=false)', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === SNAPSHOT_KEY ? adminSnapshot(SEAT_A, 'Alois') : undefined
    );
    mySeatsInvoke.mockResolvedValue(legacyFallback());
    const { latest } = await mountAndSettle();

    expect(latest().access.role).toBe('admin');
    // Own seat ONLY (the bound legacy home = the Founder chip) — the stale wire
    // seats from the snapshot are NEVER offered as switch targets.
    expect(latest().access.seats).toHaveLength(1);
    expect(latest().access.seats[0].seat_id).toBe('seat-1');
    expect(latest().access.seats[0].name).toBe('Founder');
    expect(latest().access.canSwitch).toBe(false);
    expect(latest().mySeatsSource).toBe('legacy_fallback');

    // The failed read surfaced a renderer-log diagnostic with the evidence class.
    expect(writeRendererLogInvoke).toHaveBeenCalledTimes(1);
    const entry = writeRendererLogInvoke.mock.calls[0][0] as {
      level: string;
      tag: string;
      message: string;
      data: { source: string; evidence: string };
    };
    expect(entry.level).toBe('warn');
    expect(entry.tag).toBe('seatAccess');
    expect(entry.message).toBe('my_seats_read_failed');
    expect(entry.data).toEqual({ source: 'legacy_fallback', evidence: 'admin-snapshot' });
  });

  it('legacy_fallback + NO evidence ⇒ byte-identical fail-closed delegate (genuine legacy install)', async () => {
    mySeatsInvoke.mockResolvedValue(legacyFallback());
    const { latest } = await mountAndSettle();

    expect(latest().access.role).toBe('delegate');
    expect(latest().access.seats).toHaveLength(0);
    expect(latest().access.canSwitch).toBe(false);
    expect(latest().mySeatsSource).toBe('legacy_fallback');
    // Still logged (evidence: none) so support can see the read failed.
    expect(writeRendererLogInvoke).toHaveBeenCalledTimes(1);
    const entry = writeRendererLogInvoke.mock.calls[0][0] as { data: { evidence: string } };
    expect(entry.data.evidence).toBe('none');
  });

  it('legacy_fallback + bound NON-legacy seat (a previously main-authorized switch) ⇒ degraded admin on that seat', async () => {
    getCurrentSeatIdMock.mockReturnValue(SEAT_B);
    mySeatsInvoke.mockResolvedValue(legacyFallback());
    const { latest } = await mountAndSettle();

    expect(latest().access.role).toBe('admin');
    expect(latest().access.seats).toHaveLength(1);
    expect(latest().access.seats[0].seat_id).toBe(SEAT_B);
    // No cached name ⇒ the raw id is shown (honest, never fabricated).
    expect(latest().access.seats[0].name).toBe(SEAT_B);
    expect(latest().access.canSwitch).toBe(false);
    const entry = writeRendererLogInvoke.mock.calls[0][0] as { data: { evidence: string } };
    expect(entry.data.evidence).toBe('active-seat');
  });

  it('the degraded posture uses the snapshot name when it matches the bound seat', async () => {
    getCurrentSeatIdMock.mockReturnValue(SEAT_A);
    configGetMock.mockImplementation((key: string) =>
      key === SNAPSHOT_KEY ? adminSnapshot(SEAT_A, 'Alois') : undefined
    );
    mySeatsInvoke.mockResolvedValue(legacyFallback());
    const { latest } = await mountAndSettle();

    expect(latest().access.seats[0].seat_id).toBe(SEAT_A);
    expect(latest().access.seats[0].name).toBe('Alois');
  });

  it('a THROWING bridge + admin snapshot ⇒ degraded admin + error-level diagnostic', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === SNAPSHOT_KEY ? adminSnapshot(SEAT_A, 'Alois') : undefined
    );
    mySeatsInvoke.mockRejectedValue(new Error('ipc blown up'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { latest } = await mountAndSettle();

    expect(latest().access.role).toBe('admin');
    expect(latest().access.seats[0].seat_id).toBe('seat-1');
    expect(latest().mySeatsSource).toBe('bridge_error');
    const entry = writeRendererLogInvoke.mock.calls[0][0] as {
      level: string;
      data: { source: string; evidence: string; error?: string };
    };
    expect(entry.level).toBe('error');
    expect(entry.data.source).toBe('bridge_error');
    expect(entry.data.evidence).toBe('admin-snapshot');
    expect(entry.data.error).toBe('ipc blown up');
    consoleError.mockRestore();
  });

  it('the diagnostic is TRANSITION-GATED — a repeated failed read does NOT re-log (60s-poll spam guard)', async () => {
    mySeatsInvoke.mockResolvedValue(legacyFallback());
    const { latest } = await mountAndSettle();
    expect(writeRendererLogInvoke).toHaveBeenCalledTimes(1);

    // The backstop poll / focus reconcile re-runs the SAME failing read.
    await act(async () => {
      await latest().refresh();
      await Promise.resolve();
    });
    expect(writeRendererLogInvoke).toHaveBeenCalledTimes(1);
  });
});

describe('useSeatAccess — MAT-1773 last-good snapshot lifecycle (live reads)', () => {
  it('a LIVE admin read persists the snapshot (role + active seat id/name) and reports my_seats', async () => {
    mySeatsInvoke.mockResolvedValue(liveContract('admin'));
    const { latest } = await mountAndSettle();

    expect(latest().mySeatsSource).toBe('my_seats');
    expect(latest().access.role).toBe('admin');
    expect(latest().access.canSwitch).toBe(true);
    expect(configSetMock).toHaveBeenCalledWith(
      SNAPSHOT_KEY,
      expect.objectContaining({ role: 'admin', active_seat_id: SEAT_A, active_seat_name: 'Alois' })
    );
    expect(writeRendererLogInvoke).not.toHaveBeenCalled();
  });

  it('a LIVE delegate read REMOVES the snapshot (a demotion is authoritative)', async () => {
    mySeatsInvoke.mockResolvedValue(liveContract('delegate'));
    const { latest } = await mountAndSettle();

    expect(latest().access.role).toBe('delegate');
    expect(configRemoveMock).toHaveBeenCalledWith(SNAPSHOT_KEY);
    expect(configSetMock).not.toHaveBeenCalled();
  });
});

describe('useSeatAccess — wire_error surfacing (dead-session recovery signal)', () => {
  it('a legacy_fallback envelope carrying a session failure surfaces it as mySeatsWireError', async () => {
    // THE founder's envelope: the read died on a rejected refresh, main names
    // it, and the rail's re-auth affordance keys on exactly this value.
    const envelope = legacyFallback() as { data: Record<string, unknown> };
    envelope.data.wire_error = { kind: 'session', reasonCode: 'REFRESH_HTTP_400' };
    mySeatsInvoke.mockResolvedValue(envelope);
    const { latest } = await mountAndSettle();

    expect(latest().mySeatsSource).toBe('legacy_fallback');
    expect(latest().mySeatsWireError).toEqual({ kind: 'session', reasonCode: 'REFRESH_HTTP_400' });
    // The posture itself is unchanged: no local evidence ⇒ fail-closed delegate.
    expect(latest().access.role).toBe('delegate');
  });

  it('an envelope WITHOUT wire_error (older main) surfaces null, and a live read clears it', async () => {
    mySeatsInvoke.mockResolvedValue(legacyFallback());
    const { latest } = await mountAndSettle();
    expect(latest().mySeatsWireError).toBeNull();

    mySeatsInvoke.mockResolvedValue(liveContract('admin'));
    await act(async () => {
      await latest().refresh();
    });
    expect(latest().mySeatsSource).toBe('my_seats');
    expect(latest().mySeatsWireError).toBeNull();
    expect(latest().access.role).toBe('admin');
  });

  it('an IPC bridge error clears a stale dead-session wire classification', async () => {
    const envelope = legacyFallback() as { data: Record<string, unknown> };
    envelope.data.wire_error = { kind: 'session', reasonCode: 'REFRESH_HTTP_400' };
    mySeatsInvoke.mockResolvedValueOnce(envelope);
    const { latest } = await mountAndSettle();
    expect(latest().mySeatsWireError).toEqual({ kind: 'session', reasonCode: 'REFRESH_HTTP_400' });

    mySeatsInvoke.mockRejectedValueOnce(new Error('ipc unavailable'));
    await act(async () => {
      await latest().refresh();
    });
    expect(latest().mySeatsSource).toBe('bridge_error');
    expect(latest().mySeatsWireError).toBeNull();
  });
});
