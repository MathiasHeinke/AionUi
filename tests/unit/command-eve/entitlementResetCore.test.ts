/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE CLEAN-RESET core (§2b — "Abmelden & Gerät zurücksetzen"). Proves:
 *  (a) the three local trust artifacts (entitlement.json + registration.json +
 *      license-wire.json) are deleted AND the session is revoked/cleared, and
 *      getEntitlementStatus then reports `unregistered` (back to the gate);
 *  (b) the operation is idempotent — a re-reset on an already-clean device is a
 *      no-op that still returns ok:true;
 *  (c) a thrown injected dependency is caught (never re-thrown) and reported
 *      ok:false with a reason_code, but the file deletions still ran first.
 *
 * Uses the SAME keychain seam + on-disk shape as the real entitlement core so the
 * post-reset `getEntitlementStatus` assertion exercises the genuine read path.
 * Synthetic tokens / wires only — never a real license.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetEntitlement } from '@process/commandEve/entitlementResetCore';
import { clearLicenseWire, storeLicenseWire } from '@/common/config/licenseWireAtRest';
import {
  getEntitlementStatus,
  registerTenant,
  type CommandEveEntitlementOptions,
} from '@process/commandEve/entitlementCore';
import { setSafeStorageForTesting, type SafeStorageAdapter } from '@/common/config/keychain';

/** Synthetic CEVE wire string — NOT a real license. */
const FAKE_WIRE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';

const tempRoots: string[] = [];
const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-reset-test-'));
  tempRoots.push(root);
  return root;
};

const ENT_DIR = (root: string): string => path.join(root, 'command-eve-runtime', 'entitlement');
const fileExists = (root: string, name: string): boolean => fs.existsSync(path.join(ENT_DIR(root), name));

afterEach(() => {
  setSafeStorageForTesting(undefined);
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeAvailableAdapter(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc::${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString('utf8');
      if (!raw.startsWith('enc::')) throw new Error('bad ciphertext');
      return raw.slice('enc::'.length);
    },
  };
}

/** Options for getEntitlementStatus with the flag forced ON + a REAL ed25519
 * public key on disk. A configured key is required so the gate clears the
 * `unconfigured` check and reaches the registration tier — which is what we
 * assert transitions to `unregistered` after the reset removes registration.json. */
function statusOptions(root: string): CommandEveEntitlementOptions {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const keyPath = path.join(root, 'command-eve-license-public-key.pem');
  fs.writeFileSync(keyPath, pubPem);
  return {
    userDataPath: root,
    env: { COMMAND_EVE_REGISTRATION_REQUIRED: '1' } as NodeJS.ProcessEnv,
    bundledPublicKeyPath: keyPath,
  };
}

/** Seed all three trust artifacts (registration + a license wire) on disk. */
function seedTrustArtifacts(root: string): void {
  setSafeStorageForTesting(makeAvailableAdapter());
  // registration.json via the real core (writes the proper shape + tenant_id).
  const reg = registerTenant(
    { name: 'Test User', company: 'ACME', email: 'test@acme.example', consent: true },
    { userDataPath: root }
  );
  expect(reg.ok).toBe(true);
  // license-wire.json via the real store path.
  expect(storeLicenseWire(root, FAKE_WIRE).ok).toBe(true);
  // entitlement.json: write a minimal valid-shape cache record directly (we are
  // not exercising activation here, only that reset removes the file).
  fs.writeFileSync(
    path.join(ENT_DIR(root), 'entitlement.json'),
    JSON.stringify({
      version: 'command-eve-entitlement-record/v0',
      tenant_id: reg.record?.tenant_id,
      code_serial: 'TESTONLY-SERIAL',
      edition: 'standard',
      expires_at: null,
      activated_at: new Date().toISOString(),
    })
  );
}

describe('entitlementResetCore — (a) hard reset wipes all three artifacts + session', () => {
  it('deletes entitlement/registration/license-wire, clears session, and gate → unregistered', async () => {
    const root = makeRoot();
    seedTrustArtifacts(root);

    // Precondition: all three artifacts present.
    expect(fileExists(root, 'entitlement.json')).toBe(true);
    expect(fileExists(root, 'registration.json')).toBe(true);
    expect(fileExists(root, 'license-wire.json')).toBe(true);

    const revoke = vi.fn(async () => {});
    const result = await resetEntitlement(root, {
      clearLicenseWire, // the REAL wire-clear
      revokeAndClearSession: revoke,
    });

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual({
      entitlement: true,
      registration: true,
      license_wire: true,
      session: true,
    });
    // Session revoke was invoked with the right userDataPath.
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(root);

    // All three files are gone.
    expect(fileExists(root, 'entitlement.json')).toBe(false);
    expect(fileExists(root, 'registration.json')).toBe(false);
    expect(fileExists(root, 'license-wire.json')).toBe(false);

    // The genuine gate now falls back to 'unregistered' (the RegistrationGate).
    const status = getEntitlementStatus(statusOptions(root));
    expect(status.state).toBe('unregistered');
  });
});

describe('entitlementResetCore — (b) idempotent on an already-clean device', () => {
  it('returns ok:true with no artifacts removed when nothing is present', async () => {
    const root = makeRoot();
    const revoke = vi.fn(async () => {});
    const result = await resetEntitlement(root, { clearLicenseWire, revokeAndClearSession: revoke });

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual({
      entitlement: false,
      registration: false,
      license_wire: true, // clearLicenseWire ran (itself a no-op here)
      session: true, // revoke ran (itself a no-op here)
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe('entitlementResetCore — (c) a thrown dependency is caught, never re-thrown', () => {
  it('reports REVOKE_SESSION_FAILED but still deleted the files first', async () => {
    const root = makeRoot();
    seedTrustArtifacts(root);

    const result = await resetEntitlement(root, {
      clearLicenseWire, // succeeds
      revokeAndClearSession: async () => {
        throw new Error('network down');
      },
    });

    // The reset never throws the chrome — it returns a typed failure...
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('REVOKE_SESSION_FAILED');
    // ...but the local file deletions ran BEFORE the session step, so the device
    // is still wiped (the security guarantee holds even on a flaky network).
    expect(fileExists(root, 'entitlement.json')).toBe(false);
    expect(fileExists(root, 'registration.json')).toBe(false);
    expect(fileExists(root, 'license-wire.json')).toBe(false);
    expect(result.removed.entitlement).toBe(true);
    expect(result.removed.registration).toBe(true);
    expect(result.removed.license_wire).toBe(true);
    expect(result.removed.session).toBe(false);
  });

  it('reports CLEAR_LICENSE_WIRE_FAILED when the wire-clear throws (files already gone)', async () => {
    const root = makeRoot();
    seedTrustArtifacts(root);

    const result = await resetEntitlement(root, {
      clearLicenseWire: () => {
        throw new Error('keychain boom');
      },
      revokeAndClearSession: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('CLEAR_LICENSE_WIRE_FAILED');
    // entitlement + registration are deleted before the wire step.
    expect(fileExists(root, 'entitlement.json')).toBe(false);
    expect(fileExists(root, 'registration.json')).toBe(false);
    expect(result.removed.session).toBe(false);
  });
});
