/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE ONLINE entitlement re-verify (§2a). The headline guarantee under
 * test is THE NO-LOCKOUT / SHIP-INERT contract — a valid offline user, or any
 * non-conclusive server response, must NEVER drop the local entitlement:
 *
 *  (1) function URL unconfigured            -> action 'none' (fully inert);
 *  (2) network error / timeout (offline)    -> action 'none' (THE no-lockout case);
 *  (3) non-2xx HTTP                          -> action 'none';
 *  (4) 2xx decision 'unknown' / bad body     -> action 'none';
 *  (5) mode 'off'                            -> action 'none', never even fetches;
 *  (6) conclusive 2xx 'revoked'             -> action 'invalidate';
 *  (7) conclusive 2xx 'expired'             -> action 'invalidate';
 *  (8) conclusive 2xx 'valid'               -> action 'none' + grace heartbeat written;
 *  (9) within-grace annotation after a prior valid + later network error;
 * (10) reconcileEntitlementOnline: conclusive revoked DROPS the local entitlement +
 *      wire; every non-conclusive path LEAVES THEM UNTOUCHED.
 *
 * Injectable fetch + clock; no real network. Synthetic wire only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkEntitlementOnline,
  dropLocalEntitlement,
  isWithinGrace,
  readOnlineCheckHeartbeat,
  reconcileEntitlementOnline,
  GRACE_DAYS,
} from '@process/commandEve/entitlementOnlineCheckCore';

const FAKE_WIRE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';
const TEST_URL = 'https://test.local/functions/v1/entitlement-status';
const FIXED_NOW = new Date('2026-06-22T12:00:00.000Z');
const now = () => FIXED_NOW;

const tempRoots: string[] = [];
const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-online-check-test-'));
  tempRoots.push(root);
  return root;
};
const ENT_DIR = (root: string): string => path.join(root, 'command-eve-runtime', 'entitlement');
const entFile = (root: string): string => path.join(ENT_DIR(root), 'entitlement.json');

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A fetch that returns a JSON 2xx body. */
function fetchJson(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** A fetch that throws (offline). */
const fetchThrows: typeof fetch = (async () => {
  throw new Error('ENOTFOUND test.local');
}) as unknown as typeof fetch;

describe('checkEntitlementOnline — NO-LOCKOUT / inert by default', () => {
  it('(1) is fully inert when the function URL is empty (pre-deploy)', async () => {
    const r = await checkEntitlementOnline({ wire: FAKE_WIRE, baseUrl: '', mode: 'on', now });
    expect(r.action).toBe('none');
    expect(r.conclusive).toBe(false);
    expect(r.reason_code).toBe('url-unconfigured');
  });

  it('(2) THE no-lockout case: a network error / timeout leaves the entitlement untouched', async () => {
    const r = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchThrows,
      now,
    });
    expect(r.action).toBe('none');
    expect(r.conclusive).toBe(false);
    expect(r.reason_code).toBe('network-error');
  });

  it('(3) a non-2xx HTTP response is inert', async () => {
    const r = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ error: 'not_found' }, 404),
      now,
    });
    expect(r.action).toBe('none');
    expect(r.reason_code).toBe('http-404');
  });

  it('(4) a 2xx decision:"unknown" / bad body is inert', async () => {
    const unknownR = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ decision: 'unknown', checked_at: FIXED_NOW.toISOString() }),
      now,
    });
    expect(unknownR.action).toBe('none');
    expect(unknownR.reason_code).toBe('unknown');

    const badBody = (async () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    const badR = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: badBody,
      now,
    });
    expect(badR.action).toBe('none');
    expect(badR.reason_code).toBe('bad-body');
  });

  it('(5) mode "off" never even fetches', async () => {
    const spy = vi.fn(fetchThrows);
    const r = await checkEntitlementOnline({ wire: FAKE_WIRE, baseUrl: TEST_URL, mode: 'off', fetchImpl: spy, now });
    expect(r.action).toBe('none');
    expect(r.reason_code).toBe('mode-off');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('checkEntitlementOnline — conclusive verdicts', () => {
  it('(6) a conclusive 2xx "revoked" invalidates', async () => {
    const r = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ decision: 'revoked', checked_at: FIXED_NOW.toISOString() }),
      now,
    });
    expect(r.action).toBe('invalidate');
    expect(r.conclusive).toBe(true);
    expect(r.decision).toBe('revoked');
  });

  it('(6b) a conclusive 2xx "account_deleted" maps to revoked + invalidates', async () => {
    const r = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ decision: 'account_deleted', checked_at: FIXED_NOW.toISOString() }),
      now,
    });
    expect(r.action).toBe('invalidate');
    expect(r.decision).toBe('revoked');
  });

  it('(7) a conclusive 2xx "expired" invalidates', async () => {
    const r = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ decision: 'expired', checked_at: FIXED_NOW.toISOString() }),
      now,
    });
    expect(r.action).toBe('invalidate');
    expect(r.decision).toBe('expired');
  });

  it('(8) a conclusive 2xx "valid" is non-destructive AND writes the grace heartbeat', async () => {
    const root = makeRoot();
    const r = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({
        decision: 'valid',
        edition: 'standard',
        expires_at: null,
        checked_at: FIXED_NOW.toISOString(),
      }),
      now,
      userDataPath: root,
    });
    expect(r.action).toBe('none');
    expect(r.conclusive).toBe(true);
    expect(r.decision).toBe('valid');
    expect(r.edition).toBe('standard');

    const hb = readOnlineCheckHeartbeat(root);
    expect(hb?.decision).toBe('valid');
    expect(hb?.checked_at).toBe(FIXED_NOW.toISOString());
  });
});

describe('offline grace', () => {
  it('(9) within GRACE_DAYS of a prior valid check, a later network error is annotated within-grace (still inert)', async () => {
    const root = makeRoot();
    // First: a valid check writes the heartbeat at FIXED_NOW.
    await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ decision: 'valid', checked_at: FIXED_NOW.toISOString() }),
      now,
      userDataPath: root,
    });
    expect(isWithinGrace(root, now)).toBe(true);

    // Then: 2 days later the function is unreachable.
    const twoDaysLater = () => new Date(FIXED_NOW.getTime() + 2 * 24 * 60 * 60 * 1000);
    const r = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchThrows,
      now: twoDaysLater,
      userDataPath: root,
    });
    expect(r.action).toBe('none'); // NEVER lock out within grace
    expect(r.reason_code).toBe('within-grace');

    // Past the grace window the heartbeat no longer counts as within-grace (but
    // the result is STILL inert — grace expiry never escalates to a lockout).
    const wayLater = () => new Date(FIXED_NOW.getTime() + (GRACE_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(isWithinGrace(root, wayLater)).toBe(false);
    const r2 = await checkEntitlementOnline({
      wire: FAKE_WIRE,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchThrows,
      now: wayLater,
      userDataPath: root,
    });
    expect(r2.action).toBe('none');
    expect(r2.reason_code).toBe('network-error');
  });
});

describe('reconcileEntitlementOnline — boot reconcile', () => {
  function seedEntitlement(root: string): { clearCalls: string[]; clearLicenseWire: (p: string) => void } {
    fs.mkdirSync(ENT_DIR(root), { recursive: true });
    fs.writeFileSync(
      entFile(root),
      JSON.stringify({ version: 'command-eve-entitlement-record/v0', tenant_id: 't', code_serial: 's' })
    );
    const clearCalls: string[] = [];
    return { clearCalls, clearLicenseWire: (p: string) => clearCalls.push(p) };
  }

  it('(10) a conclusive revoked DROPS the local entitlement + wire', async () => {
    const root = makeRoot();
    const { clearCalls, clearLicenseWire } = seedEntitlement(root);
    expect(fs.existsSync(entFile(root))).toBe(true);

    const res = await reconcileEntitlementOnline(root, {
      readWire: () => FAKE_WIRE,
      clearLicenseWire,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ decision: 'revoked', checked_at: FIXED_NOW.toISOString() }),
      now,
    });

    expect(res.invalidated).toBe(true);
    expect(fs.existsSync(entFile(root))).toBe(false); // entitlement dropped
    expect(clearCalls).toEqual([root]); // wire cleared
  });

  it('(10b) every NON-CONCLUSIVE path leaves the entitlement + wire UNTOUCHED', async () => {
    const root = makeRoot();
    const { clearCalls, clearLicenseWire } = seedEntitlement(root);

    // network error (offline)
    const offline = await reconcileEntitlementOnline(root, {
      readWire: () => FAKE_WIRE,
      clearLicenseWire,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchThrows,
      now,
    });
    expect(offline.invalidated).toBe(false);
    expect(fs.existsSync(entFile(root))).toBe(true); // NEVER dropped
    expect(clearCalls).toEqual([]); // wire NEVER cleared

    // unconfigured URL (pre-deploy)
    const inert = await reconcileEntitlementOnline(root, {
      readWire: () => FAKE_WIRE,
      clearLicenseWire,
      baseUrl: '',
      mode: 'auto',
      now,
    });
    expect(inert.invalidated).toBe(false);
    expect(fs.existsSync(entFile(root))).toBe(true);
    expect(clearCalls).toEqual([]);
  });

  it('(10c) no stored wire ⇒ nothing to check ⇒ inert', async () => {
    const root = makeRoot();
    const { clearCalls, clearLicenseWire } = seedEntitlement(root);
    const res = await reconcileEntitlementOnline(root, {
      readWire: () => null,
      clearLicenseWire,
      baseUrl: TEST_URL,
      mode: 'on',
      fetchImpl: fetchJson({ decision: 'revoked' }),
      now,
    });
    expect(res.invalidated).toBe(false);
    expect(res.check.reason_code).toBe('no-wire');
    expect(fs.existsSync(entFile(root))).toBe(true);
    expect(clearCalls).toEqual([]);
  });
});

describe('dropLocalEntitlement — surgical (keeps registration)', () => {
  it('removes only entitlement.json + calls clearLicenseWire, idempotently', () => {
    const root = makeRoot();
    fs.mkdirSync(ENT_DIR(root), { recursive: true });
    fs.writeFileSync(entFile(root), '{}');
    fs.writeFileSync(path.join(ENT_DIR(root), 'registration.json'), '{}');
    const calls: string[] = [];
    dropLocalEntitlement(root, (p) => calls.push(p));
    expect(fs.existsSync(entFile(root))).toBe(false);
    // registration is intentionally KEPT (post-revoke ⇒ registered_unlicensed).
    expect(fs.existsSync(path.join(ENT_DIR(root), 'registration.json'))).toBe(true);
    expect(calls).toEqual([root]);
    // idempotent second call never throws.
    expect(() => dropLocalEntitlement(root, () => {})).not.toThrow();
  });
});
