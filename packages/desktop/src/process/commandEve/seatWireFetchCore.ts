/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE SEAT-WIRE fetch core (S2 / spec B4.1 — feed the my-seats producer).
 *
 * THE PRODUCER the SeatRail was starved of. The rail UI + the whole switch
 * lifecycle already exist; they were invisible only because `readMySeatsWire()`
 * returned `null` ("authored, not deployed — founder gate"). The founder has now
 * greenlit the feature, so this core performs the SINGLE JWT-bound read of the
 * deployed `my-seats` edge function (v5, verify_jwt=true) and hands the raw JSON
 * to the existing fail-closed `parseMySeats`.
 *
 * AUTH: reuses the EXACT desktop auth chain the entitlement path uses — the
 * stored account session (accountSessionAtRest.getFreshSession, which
 * transparently refreshes a near-expiry access token) + the anon apikey. The
 * bearer is the GoTrue **access_token** (my-seats verifies the JWT and derives
 * the caller's account/seats SERVER-SIDE from it — the desktop never supplies an
 * account or seat id; the IDOR guard lives in the function). This mirrors
 * `postMyLicenseOnce` (Bearer access_token + apikey + a hard fetch timeout).
 *
 * FAIL-CLOSED / NEVER-THROW: every failure mode (no stored session, refresh
 * failure, offline, non-2xx, 401, malformed body, timeout) resolves to `null`.
 * `null` is the exact value the bridge already treats as "no seat source" ⇒ the
 * contract fail-closes to a single legacy seat ⇒ the rail stays hidden. This
 * function is therefore SAFE to call unconditionally: on a legacy/no-account
 * install it simply returns `null` and nothing changes.
 *
 * active_seat_id: the wire's `active_seat_id` is OVERRIDDEN with the desktop's
 * CURRENT active seat (the runtime truth for the rail's ring). After a local
 * seat switch the backend was re-spawned under that seat's HERMES_HOME BEFORE
 * the server pointer is (best-effort) persisted — so the desktop pointer, not a
 * possibly-stale/absent server pointer, is what the ring must follow.
 *
 * PURE / INJECTABLE: fetch, the session resolver, the anon key, the timeout and
 * the active-seat resolver are all injectable, so this unit-tests in a plain
 * Node (vitest) environment with no Electron, no keychain and no real network.
 */

import { COMMAND_EVE_SUPABASE_URL, resolveSupabaseAnonKey, type CommandEveAccountSession } from './desktopAuthLoopback';
import { getFreshSession } from './accountSessionAtRest';
import { getActiveSeatId } from './seatContextCore';

/** The deployed my-seats edge function (mirrors the my-license URL shape). */
export const MY_SEATS_FUNCTION_URL = `${COMMAND_EVE_SUPABASE_URL}/functions/v1/my-seats`;

/** Per-request hard cap. A hung function must never wedge the switcher read. */
const MY_SEATS_FETCH_TIMEOUT_MS = 15_000;

export interface ReadMySeatsWireDeps {
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Resolve a non-expired account session (refreshes as needed). Injected in tests. */
  getFreshSession?: (userDataPath: string) => Promise<{ ok: boolean; session?: CommandEveAccountSession }>;
  /** The anon apikey (mirrors the my-license header set). Injected in tests. */
  anonKey?: string;
  /** The desktop's runtime-truth active seat (overrides the wire pointer). Injected in tests. */
  getActiveSeatId?: () => string;
  /** Timeout override (tests use a tiny value). */
  timeoutMs?: number;
}

/**
 * Read the raw my-seats wire payload from the deployed edge function, JWT-bound
 * to the stored account session. Returns the raw JSON object (fed verbatim to
 * `parseMySeats`, whose shape matches the function's `{ account, seats[],
 * active_seat_id }` output), or `null` on ANY failure (fail-closed, never throws).
 *
 * The returned object's `active_seat_id` is set to the desktop's current active
 * seat — the runtime truth for the rail's ring (see the module note).
 */
export async function readMySeatsWire(userDataPath: string, deps: ReadMySeatsWireDeps = {}): Promise<unknown | null> {
  const fetchImpl = deps.fetch ?? (globalThis.fetch as typeof fetch);
  const freshSession = deps.getFreshSession ?? ((udp: string) => getFreshSession(udp));
  const anonKey = deps.anonKey ?? resolveSupabaseAnonKey();
  const activeSeat = deps.getActiveSeatId ?? getActiveSeatId;
  const timeoutMs = deps.timeoutMs ?? MY_SEATS_FETCH_TIMEOUT_MS;

  try {
    // No usable account session ⇒ no JWT ⇒ nothing to read. Legacy/no-account
    // install: stay quiet (null ⇒ rail hidden), exactly today's behavior.
    const sessionResult = await freshSession(userDataPath);
    if (!sessionResult?.ok || !sessionResult.session?.access_token) {
      return null;
    }
    const accessToken = sessionResult.session.access_token;

    // JWT-bound GET (identity is the token; the function derives the account +
    // seats server-side — the desktop supplies NO account/seat id, so there is
    // nothing here for an IDOR to widen).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(MY_SEATS_FUNCTION_URL, {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch {
      // Offline / DNS / abort (timeout) ⇒ fail-closed. Rail stays hidden.
      return null;
    } finally {
      clearTimeout(timer);
    }

    // Non-2xx (401 unauthenticated, 5xx, function absent) ⇒ fail-closed.
    if (!response.ok) return null;

    const raw = (await response.json().catch((): null => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return null;

    // The function reports { ok:true, account, seats, active_seat_id }. A defensive
    // ok:false (shouldn't happen on a 2xx) ⇒ fail-closed.
    if ((raw as { ok?: unknown }).ok === false) return null;

    // Override the wire pointer with the desktop's runtime-truth active seat. The
    // rail rings by this id; the desktop is authoritative for what actually spawned.
    // parseMySeats sanitizes it (a non-sanitizable id folds to the legacy seat).
    return { ...raw, active_seat_id: activeSeat() };
  } catch {
    // ANY unexpected failure ⇒ fail-closed. NEVER throw into the bridge handler.
    return null;
  }
}
