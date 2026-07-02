/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * APP→WEB AUTH HANDOFF — pure URL builder (money-critical).
 *
 * PROBLEM this fixes: the desktop session lives at-rest in the MAIN process
 * (accountSessionAtRest); the renderer never holds the token. When the app opened
 * `command-eve.com/account?...` in the system browser, the browser had its OWN
 * (empty) localStorage session, so the user landed LOGGED OUT and the checkout
 * never started (Alois could not buy credits).
 *
 * FIX: when we have the desktop session, we append the GoTrue *refresh* token to
 * the web URL so the website can exchange it for a browser session BEFORE it reads
 * getSession(). This module is the pure, testable half: given an origin, a path and
 * (optionally) the refresh token, it produces the exact URL to open.
 *
 * SECURITY (why a FRAGMENT, not a query):
 *  - The token is placed in the URL *fragment* (`#h=<token>`), NOT the query. The
 *    fragment is never sent to the server, so it can never appear in Vercel/CDN
 *    access logs or in the HTTP `Referer` header on the next navigation. A query
 *    param would leak into both.
 *  - It is a REFRESH token, single-use by design: the website exchanges it
 *    immediately (grant_type=refresh_token) which ROTATES it server-side, so the
 *    value in the URL is worthless the instant the exchange succeeds.
 *  - The website strips the fragment via history.replaceState right after reading
 *    it, so it does not linger in the address bar / history / any later Referer.
 *  - The token is URI-encoded so a `+`/`/`/`=` in a JWT-ish value survives the
 *    fragment round-trip intact.
 *
 * This module does NO network and NO Electron access — it is a plain string
 * function, unit-testable in a Node (vitest) environment.
 */

/**
 * The ONLY origin we will ever hand a session token to. Hard-pinned so a caller
 * (or a tampered path) can never redirect the refresh token to another host.
 */
export const COMMAND_EVE_WEB_ORIGIN = 'https://command-eve.com';

/** The fragment key the website's consumeAuthHandoff() looks for. */
export const HANDOFF_FRAGMENT_KEY = 'h';

/**
 * Build the account-web URL the MAIN process opens in the system browser.
 *
 *  - `baseOrigin` MUST be the pinned command-eve.com origin (any other value is
 *    rejected → we fall back to the pinned origin; the token must never leave to a
 *    foreign host).
 *  - `path` MUST start with '/'. A malformed path throws (the caller catches and
 *    opens the naked default) — we never build a token URL onto an unvalidated path.
 *  - When `refreshToken` is a non-empty string we append `#h=<encoded>` (fragment,
 *    never a query param). When it is absent/empty we return the NAKED url — this is
 *    exactly today's behaviour, so a missing session degrades gracefully (the user
 *    lands on /login instead of a broken checkout).
 *
 * The token is NEVER logged here (this is a pure builder; the caller must also
 * never log the returned URL when it carries a fragment).
 */
export function buildAccountWebUrl(baseOrigin: string, path: string, refreshToken?: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('accountWebHandoff: path must be an absolute app path beginning with "/"');
  }
  // Pin the origin: only ever command-eve.com. A caller passing anything else
  // (or an empty/whitespace string) is coerced to the safe origin so a refresh
  // token can never be handed to a foreign host.
  const origin = baseOrigin === COMMAND_EVE_WEB_ORIGIN ? baseOrigin : COMMAND_EVE_WEB_ORIGIN;

  // Preserve the caller's query (?intent=add_seat / ?pack_eur=<n>) untouched — the
  // web deep-links read location.search, which the fragment does not disturb.
  const naked = `${origin}${path}`;

  const token = typeof refreshToken === 'string' ? refreshToken.trim() : '';
  if (!token) {
    // No session → naked URL (fallback = today's logged-out redirect; the site
    // routes the user to /login). The buy-path never hard-fails.
    return naked;
  }

  // Fragment, NOT query: keeps the token out of server logs + the Referer header.
  return `${naked}#${HANDOFF_FRAGMENT_KEY}=${encodeURIComponent(token)}`;
}
