/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * APP→WEB AUTH HANDOFF — pins the pure URL builder that carries the desktop
 * session (refresh token) to command-eve.com so the browser lands LOGGED IN and
 * checkout can start. Money-critical: a regression here re-breaks the buy path.
 */

import { describe, expect, it } from 'vitest';
import {
  buildAccountWebUrl,
  COMMAND_EVE_WEB_ORIGIN,
  HANDOFF_FRAGMENT_KEY,
} from '@process/commandEve/accountWebHandoffCore';

describe('buildAccountWebUrl (app→web auth handoff)', () => {
  it('appends the refresh token as a URL FRAGMENT (never a query param)', () => {
    const url = buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, '/account?intent=add_seat', 'refresh-abc');
    expect(url).toBe(`${COMMAND_EVE_WEB_ORIGIN}/account?intent=add_seat#${HANDOFF_FRAGMENT_KEY}=refresh-abc`);
    // The token must be after the '#', so a '?h=' query form must NOT appear.
    expect(url).not.toContain('?h=');
    expect(url).not.toContain('&h=');
    expect(url).toContain(`#${HANDOFF_FRAGMENT_KEY}=`);
  });

  it('returns the NAKED url (today\'s fallback) when no token is present', () => {
    expect(buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, '/account?pack_eur=50')).toBe(
      `${COMMAND_EVE_WEB_ORIGIN}/account?pack_eur=50`
    );
    // Empty / whitespace token is treated as "no token".
    expect(buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, '/account', '')).toBe(`${COMMAND_EVE_WEB_ORIGIN}/account`);
    expect(buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, '/account', '   ')).toBe(`${COMMAND_EVE_WEB_ORIGIN}/account`);
  });

  it('URI-encodes the token so JWT-ish +/=/ survive the fragment round-trip', () => {
    const token = 'a+b/c=d.e-f';
    const url = buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, '/account', token);
    const fragment = url.split('#')[1];
    expect(fragment).toBe(`${HANDOFF_FRAGMENT_KEY}=${encodeURIComponent(token)}`);
    // Round-trips back to the exact original token.
    expect(decodeURIComponent(fragment.slice(HANDOFF_FRAGMENT_KEY.length + 1))).toBe(token);
  });

  it('preserves the caller query (?intent / ?pack_eur) untouched with a token', () => {
    const url = buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, '/account?pack_eur=250', 'tok');
    expect(url).toContain('/account?pack_eur=250#');
    // Query separator stays a single '?', fragment stays a single '#'.
    expect(url.match(/\?/g)?.length).toBe(1);
    expect(url.match(/#/g)?.length).toBe(1);
  });

  it('PINS the origin to command-eve.com — a foreign origin can never receive the token', () => {
    const url = buildAccountWebUrl('https://evil.example.com', '/account', 'secret-refresh');
    expect(url.startsWith(COMMAND_EVE_WEB_ORIGIN)).toBe(true);
    expect(url).not.toContain('evil.example.com');
    // The token is still carried, just to the SAFE origin.
    expect(url).toContain('#h=secret-refresh');
  });

  it('rejects a path that does not begin with "/" (never builds a token URL onto an unvalidated path)', () => {
    expect(() => buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, 'account', 'tok')).toThrow();
    expect(() => buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, 'https://command-eve.com/account', 'tok')).toThrow();
    // @ts-expect-error — a non-string path is a programmer error and must throw.
    expect(() => buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, undefined, 'tok')).toThrow();
  });
});
