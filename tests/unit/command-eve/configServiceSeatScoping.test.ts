/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ADVERSARIAL cross-seat config-bag leak CI (Phase 4 / ISO-2) at the
 * configService layer. The renderer config layer talks to ONE flat backend bag
 * (GET/PUT /api/settings/client). These tests prove the per-seat NAMESPACE the
 * service now applies fences seat B from seat A's config STATE:
 *  (1) Legacy byte-identity: a legacy seat PUTs the UN-prefixed key.
 *  (2) Cross-seat fence: after a switch, seat B does NOT read seat A's
 *      clientSeeded, and the bag holds TWO distinct keys.
 *  (3) Repeat for teamWorkerStatus + executionMode.
 *  (4) Path-traversal: rebindSeat('../../etc') throws (never a prefix).
 *  (5) Install-global keys stay un-namespaced across a switch.
 *
 * The backend bag is an in-memory map behind a mocked global fetch; the active
 * seat is supplied via a mocked commandEve.activeSeat bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

// In-memory backend bag (physical keys) behind the mocked fetch.
let bag: Record<string, unknown> = {};
// What the (mocked) main process reports as the active seat for the NEXT
// initialize() that has to resolve it from the bridge.
let activeSeatFromMain = 'seat-1';

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    activeSeat: {
      invoke: vi.fn(async () => ({
        data: { version: 'command-eve-active-seat/v0', ok: true, seat_id: activeSeatFromMain },
      })),
    },
  },
}));

function installFetchMock(): void {
  global.fetch = vi.fn(async (_url: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method || 'GET';
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ ...bag }),
        text: async () => JSON.stringify({ ...bag }),
      } as unknown as Response;
    }
    // PUT — merge; a null value deletes the key (mirrors the backend contract).
    const patch = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete bag[k];
      else bag[k] = v;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

// Fresh module instance each test so the configService singleton's internal
// state (cache, currentSeatId) does not bleed across cases.
async function freshConfigService() {
  vi.resetModules();
  installFetchMock();
  const mod = await import('@/common/config/configService');
  return mod.configService;
}

beforeEach(() => {
  bag = {};
  activeSeatFromMain = 'seat-1';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('(1) legacy byte-identity — un-prefixed PUT', () => {
  it('a legacy active seat writes the UN-prefixed key (zero migration)', async () => {
    activeSeatFromMain = 'seat-1';
    const configService = await freshConfigService();
    await configService.initialize();
    await configService.set('commandEve.clientSeeded', true);
    expect(bag['commandEve.clientSeeded']).toBe(true);
    // No seat-prefixed key was written.
    expect(Object.keys(bag).some((k) => k.startsWith('seat:'))).toBe(false);
  });

  it('an existing un-prefixed 1.1.3 row is read by the legacy seat', async () => {
    bag['commandEve.clientSeeded'] = true;
    activeSeatFromMain = 'seat-1';
    const configService = await freshConfigService();
    await configService.initialize();
    expect(configService.get('commandEve.clientSeeded')).toBe(true);
  });
});

describe('(2) cross-seat fence — seat B does not read seat A clientSeeded', () => {
  it('keeps boot at epoch zero and publishes a real rebind epoch before awaiting settings', async () => {
    activeSeatFromMain = SEAT_A;
    const configService = await freshConfigService();
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: 'seat-1',
      rebindEpoch: 0,
      initialized: false,
    });
    await configService.initialize();
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: SEAT_A,
      rebindEpoch: 0,
      initialized: true,
    });

    let releaseSettings!: () => void;
    const settingsBlocked = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const stableFetch = global.fetch;
    global.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
      if ((init?.method || 'GET') === 'GET') await settingsBlocked;
      return stableFetch(url as RequestInfo | URL, init as RequestInit);
    }) as typeof fetch;

    activeSeatFromMain = SEAT_B;
    const rebind = configService.rebindSeat(SEAT_B);
    expect(configService.getSeatBindingSnapshot()).toEqual({
      // The target is not published inside the renderer until the independent
      // Main active-seat read confirms it.
      seatId: SEAT_A,
      rebindEpoch: 1,
      initialized: false,
    });
    releaseSettings();
    await rebind;
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: SEAT_B,
      rebindEpoch: 1,
      initialized: true,
    });

    activeSeatFromMain = SEAT_B;
    await configService.rebindSeat(SEAT_B);
    expect(configService.getSeatBindingSnapshot().rebindEpoch).toBe(1);
    const rollback = configService.beginSeatTransition();
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: SEAT_B,
      rebindEpoch: 2,
      initialized: false,
    });
    activeSeatFromMain = SEAT_B;
    await configService.completeSeatTransition(rollback, SEAT_B);
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: SEAT_B,
      rebindEpoch: 2,
      initialized: true,
    });
    const malformed = configService.beginSeatTransition();
    await expect(configService.completeSeatTransition(malformed, '../../unsafe')).rejects.toThrow();
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: SEAT_B,
      rebindEpoch: 3,
      initialized: false,
    });
    await expect(configService.whenReady()).rejects.toThrow('untrusted');
    await expect(configService.initialize()).rejects.toThrow('untrusted');
    await expect(configService.set('commandEve.clientSeeded', true)).rejects.toThrow('untrusted');
    expect(() => configService.setLocal('commandEve.clientSeeded', true)).toThrow('untrusted');
    await expect(configService.rebindSeat(SEAT_B)).rejects.toThrow('untrusted');
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: SEAT_B,
      rebindEpoch: 3,
      initialized: false,
    });
    // The invalid terminal cannot strand the token: a later valid transition
    // can restore the trusted binding and runtime transport.
    const recovered = configService.beginSeatTransition();
    // A syntactically valid caller claim is not recovery authority.
    activeSeatFromMain = SEAT_A;
    await expect(configService.completeSeatTransition(recovered, SEAT_B)).rejects.toThrow('Main active-seat');
    expect(configService.getSeatBindingSnapshot().initialized).toBe(false);

    const authoritativeRecovery = configService.beginSeatTransition();
    activeSeatFromMain = SEAT_B;
    await configService.completeSeatTransition(authoritativeRecovery, SEAT_B);
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: SEAT_B,
      rebindEpoch: 5,
      initialized: true,
    });
    activeSeatFromMain = SEAT_A;
    await configService.rebindSeat(SEAT_A);
    expect(configService.getSeatBindingSnapshot().rebindEpoch).toBe(6);

    configService.reset();
    expect(configService.getSeatBindingSnapshot()).toEqual({
      seatId: 'seat-1',
      rebindEpoch: 7,
      initialized: false,
    });
  });

  it('seat A seeds; seat B reads undefined; bag holds two distinct keys', async () => {
    // Seat A seeds.
    activeSeatFromMain = SEAT_A;
    const configService = await freshConfigService();
    await configService.initialize();
    await configService.set('commandEve.clientSeeded', true);
    expect(bag[`seat:${SEAT_A}:commandEve.clientSeeded`]).toBe(true);
    expect(configService.get('commandEve.clientSeeded')).toBe(true);

    // Switch to seat B (same service instance, same bag).
    activeSeatFromMain = SEAT_B;
    await configService.rebindSeat(SEAT_B);
    // Seat B has never seeded → must read undefined (THE leak guard).
    expect(configService.get('commandEve.clientSeeded')).toBeUndefined();

    // Seat B seeds → a SECOND distinct key, seat A's key intact.
    await configService.set('commandEve.clientSeeded', true);
    expect(bag[`seat:${SEAT_B}:commandEve.clientSeeded`]).toBe(true);
    expect(bag[`seat:${SEAT_A}:commandEve.clientSeeded`]).toBe(true);
    expect(Object.keys(bag).filter((k) => k.endsWith(':commandEve.clientSeeded')).length).toBe(2);

    // Switch back to A → A's seed still readable, B's invisible.
    activeSeatFromMain = SEAT_A;
    await configService.rebindSeat(SEAT_A);
    expect(configService.get('commandEve.clientSeeded')).toBe(true);
  });
});

describe('(3) repeat for teamWorkerStatus + executionMode', () => {
  it('teamWorkerStatus does not leak across seats', async () => {
    activeSeatFromMain = SEAT_A;
    const configService = await freshConfigService();
    await configService.initialize();
    await configService.set('commandEve.teamWorkerStatus', { 'worker-1': 'paused' });
    activeSeatFromMain = SEAT_B;
    await configService.rebindSeat(SEAT_B);
    expect(configService.get('commandEve.teamWorkerStatus')).toBeUndefined();
    expect(bag[`seat:${SEAT_A}:commandEve.teamWorkerStatus`]).toEqual({ 'worker-1': 'paused' });
  });

  it('executionMode does not leak across seats', async () => {
    activeSeatFromMain = SEAT_A;
    const configService = await freshConfigService();
    await configService.initialize();
    await configService.set('commandEve.executionMode', 'autonomous');
    activeSeatFromMain = SEAT_B;
    await configService.rebindSeat(SEAT_B);
    expect(configService.get('commandEve.executionMode')).toBeUndefined();
    expect(bag[`seat:${SEAT_A}:commandEve.executionMode`]).toBe('autonomous');
  });
});

describe('(4) path-traversal — rebind with a crafted seat id throws', () => {
  it('rebindSeat with a traversal id throws and never writes a prefix', async () => {
    activeSeatFromMain = 'seat-1';
    const configService = await freshConfigService();
    await configService.initialize();
    await expect(configService.rebindSeat('../../etc')).rejects.toThrow();
    await expect(configService.rebindSeat('a/b')).rejects.toThrow();
  });
});

describe('(5) install-global keys stay un-namespaced across a switch', () => {
  it('language + theme.activeId are shared chrome (never seat-prefixed)', async () => {
    activeSeatFromMain = SEAT_A;
    const configService = await freshConfigService();
    await configService.initialize();
    await configService.set('language', 'de-DE');
    await configService.set('theme.activeId', 'midnight');
    // Stored UN-prefixed.
    expect(bag['language']).toBe('de-DE');
    expect(bag['theme.activeId']).toBe('midnight');
    // Visible under another seat (intentionally shared).
    activeSeatFromMain = SEAT_B;
    await configService.rebindSeat(SEAT_B);
    expect(configService.get('language')).toBe('de-DE');
    expect(configService.get('theme.activeId')).toBe('midnight');
    // No seat-prefixed copies of global keys exist.
    expect(Object.keys(bag).some((k) => k.includes(':language') || k.includes(':theme.activeId'))).toBe(false);
  });
});
