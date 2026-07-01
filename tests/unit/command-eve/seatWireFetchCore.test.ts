/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S2 (spec B4.1) — the my-seats PRODUCER read. Proves readMySeatsWire:
 *  (1) HAPPY PATH: a valid stored session + a 2xx edge response returns the raw
 *      wire (feedable verbatim to parseMySeats), with active_seat_id overridden by
 *      the desktop's runtime-truth active seat;
 *  (2) FAIL-CLOSED to null on: no/expired-unrefreshable session, offline/abort,
 *      401, any non-2xx, malformed body, and a defensive ok:false 2xx — and NEVER
 *      throws (the bridge treats null as "no seat source" ⇒ rail hidden);
 *  (3) AUTH DISCIPLINE: the JWT access_token rides ONLY in the Authorization
 *      header (Bearer), alongside the anon apikey — the same header set as
 *      my-license. NO account/seat id is ever sent (the IDOR guard is server-side).
 *
 * PURE: fetch, the session resolver, the anon key and the active-seat resolver are
 * all injected, so this runs in plain vitest with no Electron / keychain / network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMySeatsWire, MY_SEATS_FUNCTION_URL, type ReadMySeatsWireDeps } from '@process/commandEve/seatWireFetchCore';
import type { CommandEveAccountSession } from '@process/commandEve/desktopAuthLoopback';

const USER_DATA = '/tmp/command-eve-test-userdata';
const SEAT_A = '11111111-1111-1111-1111-111111111111';
const SEAT_B = '22222222-2222-2222-2222-222222222222';
const ANON = 'anon-test-key';

/** A minimal usable session (only access_token is load-bearing for the read). */
function session(accessToken = 'jwt-access-token'): CommandEveAccountSession {
  return {
    access_token: accessToken,
    refresh_token: 'refresh',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { email: 'op@example.com' },
  } as CommandEveAccountSession;
}

/** A jsonResponse mirror of the edge fn's success body (account+seats+active_seat_id). */
function edgeBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    account: { id: 'acc1', role: 'admin' },
    seats: [
      { tenant_id: SEAT_A, name: 'Client A', role: 'admin', is_active: true },
      { tenant_id: SEAT_B, name: 'Client B', role: 'admin', is_active: false },
    ],
    active_seat_id: SEAT_A,
    ...overrides,
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function statusResponse(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function baseDeps(over: Partial<ReadMySeatsWireDeps> = {}): ReadMySeatsWireDeps {
  return {
    getFreshSession: vi.fn(async () => ({ ok: true, session: session() })),
    anonKey: ANON,
    getActiveSeatId: () => SEAT_A,
    timeoutMs: 50,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('readMySeatsWire — happy path', () => {
  it('returns the raw wire (feedable to parseMySeats) on a valid session + 2xx', async () => {
    const fetchMock = vi.fn(async () => okResponse(edgeBody()));
    const wire = (await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }))) as Record<string, unknown>;

    expect(wire).not.toBeNull();
    expect((wire.account as Record<string, unknown>).id).toBe('acc1');
    expect(Array.isArray(wire.seats)).toBe(true);
    expect((wire.seats as unknown[]).length).toBe(2);
  });

  it('sends the JWT as a Bearer header + the anon apikey, GET, to the my-seats URL — and NO body id', async () => {
    const fetchMock = vi.fn(async () => okResponse(edgeBody()));
    await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MY_SEATS_FUNCTION_URL);
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-access-token');
    expect(headers.apikey).toBe(ANON);
    // No account/seat id may leave the desktop — a GET carries no body at all.
    expect(init.body).toBeUndefined();
  });

  it('OVERRIDES the wire active_seat_id with the desktop runtime-truth active seat', async () => {
    // Server says the active seat is SEAT_A, but the desktop actually spawned SEAT_B.
    const fetchMock = vi.fn(async () => okResponse(edgeBody({ active_seat_id: SEAT_A })));
    const wire = (await readMySeatsWire(
      USER_DATA,
      baseDeps({ fetch: fetchMock as unknown as typeof fetch, getActiveSeatId: () => SEAT_B })
    )) as Record<string, unknown>;
    expect(wire.active_seat_id).toBe(SEAT_B);
  });
});

describe('readMySeatsWire — fail-closed to null (never throws)', () => {
  it('no stored session ⇒ null (never fetches)', async () => {
    const fetchMock = vi.fn();
    const wire = await readMySeatsWire(
      USER_DATA,
      baseDeps({ fetch: fetchMock as unknown as typeof fetch, getFreshSession: vi.fn(async () => ({ ok: false })) })
    );
    expect(wire).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a session with no access_token ⇒ null (never fetches)', async () => {
    const fetchMock = vi.fn();
    const wire = await readMySeatsWire(
      USER_DATA,
      baseDeps({
        fetch: fetchMock as unknown as typeof fetch,
        getFreshSession: vi.fn(async () => ({ ok: true, session: session('') })),
      })
    );
    expect(wire).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offline / abort (fetch throws) ⇒ null', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const wire = await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }));
    expect(wire).toBeNull();
  });

  it('401 unauthenticated ⇒ null', async () => {
    const fetchMock = vi.fn(async () => statusResponse(401, { ok: false, error: 'not_authenticated' }));
    const wire = await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }));
    expect(wire).toBeNull();
  });

  it('a 5xx / non-2xx ⇒ null', async () => {
    const fetchMock = vi.fn(async () => statusResponse(500, { ok: false }));
    const wire = await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }));
    expect(wire).toBeNull();
  });

  it('a malformed / non-object body ⇒ null', async () => {
    const fetchMock = vi.fn(async () => okResponse('not-json'));
    const wire = await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }));
    expect(wire).toBeNull();
  });

  it('a JSON parse failure ⇒ null', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('bad json');
          },
        }) as unknown as Response
    );
    const wire = await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }));
    expect(wire).toBeNull();
  });

  it('a defensive 2xx ok:false ⇒ null', async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: false, seats: [] }));
    const wire = await readMySeatsWire(USER_DATA, baseDeps({ fetch: fetchMock as unknown as typeof fetch }));
    expect(wire).toBeNull();
  });

  it('a throwing getFreshSession ⇒ null (never propagates into the bridge)', async () => {
    const fetchMock = vi.fn();
    const wire = await readMySeatsWire(
      USER_DATA,
      baseDeps({
        fetch: fetchMock as unknown as typeof fetch,
        getFreshSession: vi.fn(async () => {
          throw new Error('keychain exploded');
        }),
      })
    );
    expect(wire).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── H7 — the abort timer covers the BODY READ, not just the header round-trip ──
// Previously the timer cleared when headers arrived; a server that sent headers but
// STALLED the body hung readMySeatsWire until the 300s switch watchdog. Now the SAME
// AbortController is armed across response.json(); a stalled body is aborted and
// fail-closes to null well before any watchdog.

describe('H7 — stalled BODY read is aborted (never parks the switch lock)', () => {
  it('headers arrive but json() hangs → the abort timer fires → resolves null quickly', async () => {
    // A Response whose headers are "here" (fetch resolves) but whose body never
    // arrives — json() only settles when the injected abort signal fires. This is
    // exactly the header-here / body-stalled shape H7 closes. The fetch mock wires
    // the Response's json() to the controller's signal that readMySeatsWire passes.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const response = {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            // Never resolves on its own — only an abort (the H7 timer) unblocks it,
            // rejecting exactly as a real fetch body read does on abort.
            if (signal.aborted) return reject(new Error('AbortError'));
            signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
          }),
      } as unknown as Response;
      return response;
    });

    const start = Date.now();
    const wire = await readMySeatsWire(
      USER_DATA,
      // A small real timeout so the body-abort fires fast; NOT the 300s watchdog.
      baseDeps({ fetch: fetchMock as unknown as typeof fetch, timeoutMs: 40 })
    );
    const elapsed = Date.now() - start;

    expect(wire).toBeNull(); // fail-closed on the aborted body read
    // Resolved via the body-covering timer (~40ms), FAR below the 300s watchdog.
    expect(elapsed).toBeLessThan(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a body that resolves BEFORE the timeout still returns the wire (no false abort)', async () => {
    // Regression guard: the timer must not abort a body that arrives in time.
    const fetchMock = vi.fn(async () => okResponse(edgeBody()));
    const wire = (await readMySeatsWire(
      USER_DATA,
      baseDeps({ fetch: fetchMock as unknown as typeof fetch, timeoutMs: 1000 })
    )) as Record<string, unknown>;
    expect(wire).not.toBeNull();
    expect((wire.account as Record<string, unknown>).id).toBe('acc1');
  });
});
