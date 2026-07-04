/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMAND_EVE_SUPABASE_URL } from './desktopAuthLoopback';

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
 * The fragment key for the H5/H7 REVERSE-HANDOFF single-use code (`#hc=<code>`).
 * Unlike `#h=`, this carries NO token — only a 90s single-use code the website
 * exchanges (via the account-web-handoff Edge Fn REDEEM leg) for a freshly-minted,
 * independent browser session. See
 * docs/strategy/command-eve-account-web-handoff-code-spec-2026-07-04.md.
 */
export const HANDOFF_CODE_FRAGMENT_KEY = 'hc';

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

/**
 * Build the account-web URL for the H5/H7 REVERSE-HANDOFF: the fragment carries a
 * single-use `handoffCode` (`#hc=<code>`), NEVER a token. Same origin-pin +
 * path-validation as buildAccountWebUrl. When `handoffCode` is absent/empty this
 * returns the NAKED url — the caller uses that as the signal to fall back to the
 * legacy token path (or a logged-out open) during the rollout transition.
 *
 * The code is short-lived (90s) and single-use, so — unlike the raw refresh token —
 * even if the fragment were observed it cannot re-establish a session after the
 * first redeem. Still: the caller must never LOG the returned URL.
 */
export function buildAccountWebHandoffUrl(baseOrigin: string, path: string, handoffCode?: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error('accountWebHandoff: path must be an absolute app path beginning with "/"');
  }
  const origin = baseOrigin === COMMAND_EVE_WEB_ORIGIN ? baseOrigin : COMMAND_EVE_WEB_ORIGIN;
  const naked = `${origin}${path}`;
  const code = typeof handoffCode === 'string' ? handoffCode.trim() : '';
  if (!code) return naked;
  return `${naked}#${HANDOFF_CODE_FRAGMENT_KEY}=${encodeURIComponent(code)}`;
}

/** The account-web-handoff Edge Function URL (reverse-handoff ISSUE/REDEEM). */
export const ACCOUNT_WEB_HANDOFF_FUNCTION_URL = `${COMMAND_EVE_SUPABASE_URL}/functions/v1/account-web-handoff`;

/** Injected deps for the ISSUE call — keep the helper unit-testable off Electron. */
export interface MintAccountWebHandoffDeps {
  /** Returns the current Supabase ACCESS token, or null when there is no session. */
  getAccessToken: () => Promise<string | null>;
  /** The Supabase anon key (sent as `apikey`). */
  anonKey: string;
  fetch?: typeof fetch;
  functionUrl?: string;
}

/**
 * H5/H7 ISSUE leg (desktop side): exchange the desktop's OWN session for a
 * single-use handoff CODE via the account-web-handoff Edge Fn. Returns the code, or
 * `null` on ANY failure (no session, endpoint not deployed / 404, offline, bad body)
 * — the caller then falls back to the legacy token URL during the rollout
 * transition. The code is opaque and short-lived; NEVER log it or the response.
 */
export async function mintAccountWebHandoffCode(deps: MintAccountWebHandoffDeps): Promise<string | null> {
  const access = await deps.getAccessToken().catch((): null => null);
  if (!access) return null;
  const fetchImpl = deps.fetch ?? (globalThis.fetch as typeof fetch);
  const url = deps.functionUrl ?? ACCOUNT_WEB_HANDOFF_FUNCTION_URL;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: deps.anonKey, Authorization: `Bearer ${access}` },
      body: JSON.stringify({ action: 'issue' }),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch((): null => null)) as { ok?: boolean; handoff_code?: string } | null;
    const code = json && json.ok === true && typeof json.handoff_code === 'string' ? json.handoff_code.trim() : '';
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}
