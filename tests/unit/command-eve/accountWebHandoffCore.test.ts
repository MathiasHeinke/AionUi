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

import { describe, expect, it, vi } from 'vitest';
import {
  buildAccountWebUrl,
  buildAccountWebHandoffUrl,
  mintAccountWebHandoffCode,
  ACCOUNT_WEB_HANDOFF_FUNCTION_URL,
  COMMAND_EVE_WEB_ORIGIN,
  HANDOFF_FRAGMENT_KEY,
  HANDOFF_CODE_FRAGMENT_KEY,
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

describe('buildAccountWebHandoffUrl (H5/H7 reverse-handoff — CODE, never a token)', () => {
  it('appends the single-use code as a `#hc=` FRAGMENT (never a token, never a query)', () => {
    const url = buildAccountWebHandoffUrl(COMMAND_EVE_WEB_ORIGIN, '/account?pack_eur=100', 'code-xyz');
    expect(url).toBe(`${COMMAND_EVE_WEB_ORIGIN}/account?pack_eur=100#${HANDOFF_CODE_FRAGMENT_KEY}=code-xyz`);
    expect(url).not.toContain('?hc=');
    expect(url).not.toContain(`#${HANDOFF_FRAGMENT_KEY}=`); // NOT the legacy token key
  });

  it('returns the NAKED url when no code is present (the fallback signal)', () => {
    expect(buildAccountWebHandoffUrl(COMMAND_EVE_WEB_ORIGIN, '/account')).toBe(`${COMMAND_EVE_WEB_ORIGIN}/account`);
    expect(buildAccountWebHandoffUrl(COMMAND_EVE_WEB_ORIGIN, '/account', '   ')).toBe(`${COMMAND_EVE_WEB_ORIGIN}/account`);
  });

  it('PINS the origin to command-eve.com and rejects a non-absolute path', () => {
    expect(buildAccountWebHandoffUrl('https://evil.example.com', '/account', 'c').startsWith(COMMAND_EVE_WEB_ORIGIN)).toBe(true);
    expect(() => buildAccountWebHandoffUrl(COMMAND_EVE_WEB_ORIGIN, 'account', 'c')).toThrow();
  });
});

describe('mintAccountWebHandoffCode (H5/H7 ISSUE leg — desktop side)', () => {
  const anonKey = 'anon-key';

  it('POSTs {action:issue} with the access token as Bearer + apikey, returns the code', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, handoff_code: 'hc-123' }), { status: 200 }));
    const code = await mintAccountWebHandoffCode({
      getAccessToken: async () => 'access-abc',
      anonKey,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(code).toBe('hc-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ACCOUNT_WEB_HANDOFF_FUNCTION_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(anonKey);
    expect(headers.Authorization).toBe('Bearer access-abc');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'issue' });
  });

  it('returns null when there is NO session (no access token) — never calls the endpoint', async () => {
    const fetchMock = vi.fn();
    const code = await mintAccountWebHandoffCode({ getAccessToken: async () => null, anonKey, fetch: fetchMock as unknown as typeof fetch });
    expect(code).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a non-OK response (endpoint not deployed / 404) so the caller falls back', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const code = await mintAccountWebHandoffCode({ getAccessToken: async () => 'a', anonKey, fetch: fetchMock as unknown as typeof fetch });
    expect(code).toBeNull();
  });

  it('returns null on a network throw and on a malformed body (fail-quiet)', async () => {
    const throwFetch = vi.fn(async () => { throw new Error('offline'); });
    expect(await mintAccountWebHandoffCode({ getAccessToken: async () => 'a', anonKey, fetch: throwFetch as unknown as typeof fetch })).toBeNull();
    const badBody = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })); // no handoff_code
    expect(await mintAccountWebHandoffCode({ getAccessToken: async () => 'a', anonKey, fetch: badBody as unknown as typeof fetch })).toBeNull();
  });
});
