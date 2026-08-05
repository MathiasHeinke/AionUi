/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE my-seats wire failure taxonomy — SHARED, renderer-safe home.
 *
 * This module is deliberately PURE (zero imports) so BOTH the main process
 * (`process/commandEve/seatWireFetchCore.ts`, which does the fetch) AND the
 * renderer (`renderer/components/seats/SeatRail.tsx`, which decides whether to
 * offer re-auth) can import it. 1.820.5 taught why: when `isDeadSessionFailure`
 * lived in the main-process fetch module, the renderer's runtime import of it
 * dragged the whole main-only chain (session store, keychain, fs) into the
 * packaged renderer bundle and the app booted to a black window. Anything the
 * renderer may name lives here; the fetch stays in the main process.
 */

/** WHY a my-seats wire read failed. Surfaced, never thrown. */
export type MySeatsWireFailure =
  /** No usable account session: reason_code is the resolver's (NO_SESSION, REFRESH_HTTP_400, …). */
  | { kind: 'session'; reasonCode?: string }
  /** Offline / DNS / abort (header or body phase). Transient. */
  | { kind: 'network' }
  /** The function answered non-2xx (401 unauthenticated, 5xx, absent). */
  | { kind: 'http'; status: number }
  /** A 2xx whose body was unusable (non-JSON, non-object, ok:false). */
  | { kind: 'malformed' };

/**
 * True iff this failure is a DEAD stored session — the install HAD an account
 * session and it can no longer mint an access token (refresh rejected, or the
 * at-rest record no longer decrypts). A fresh sign-in recovers it, so the UI
 * may offer re-authentication. NO_SESSION (never had one) and REFRESH_NETWORK
 * (offline) are deliberately NOT recoverable-by-relogin signals.
 */
export function isDeadSessionFailure(failure: MySeatsWireFailure | null | undefined): boolean {
  if (!failure || failure.kind !== 'session') return false;
  const code = failure.reasonCode ?? '';
  // ALLOWLIST, not a guess: refresh rejected (dead/rotated token), an unusable
  // refresh response, a store that no longer decrypts or parse — every one is
  // fixed by a fresh sign-in, which rewrites the record. NO_SESSION (never had
  // one), REFRESH_NETWORK (offline) and UNEXPECTED_THROW (unknown cause) are
  // deliberately NOT read as "re-login will fix this".
  return (
    code.startsWith('REFRESH_HTTP_') ||
    code === 'REFRESH_BAD_SESSION' ||
    code.startsWith('KEYCHAIN_') ||
    code.startsWith('SESSION_')
  );
}
