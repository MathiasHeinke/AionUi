import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSafeStorageForTesting } from '@/common/config/keychain';
import { externalActionBrowserPartition } from '@/process/services/external-action/browserProfileScope';
import {
  NativeSecretMaterialResolver,
  registerHermesSecretSourceReadPort,
  resetHermesSecretSourceReadPortForTests,
  type HermesSecretSourceReadPort,
} from '@/process/services/external-action/nativeSecretMaterialResolver';
import type { SecretMaterialResolveContext } from '@/process/services/external-action/secretUseBroker';

const binding = { installationId: 'install-a', accountId: 'account-a', seedId: 'seed-a' };

function resolveContext(overrides: Partial<SecretMaterialResolveContext>): SecretMaterialResolveContext {
  return {
    source: 'eve_keychain',
    sourceRef: `keychain:v1:${Buffer.from('ciphertext').toString('base64')}`,
    handleType: 'account_credential',
    ownerBinding: binding,
    useBinding: binding,
    actionKind: 'browser_submit',
    targetOrigin: 'https://accounts.example',
    slot: 'account_password',
    reservationId: 'reservation-a',
    claimId: 'claim-a',
    executionContractDigest: `sha256:${'a'.repeat(64)}`,
    adapterId: 'adapter-a',
    authMode: 'password',
    domain: 'generic',
    domainAction: 'browser_submit',
    origins: ['https://accounts.example'],
    ...overrides,
  };
}

afterEach(() => {
  setSafeStorageForTesting(undefined);
  resetHermesSecretSourceReadPortForTests();
  vi.restoreAllMocks();
});

describe('native credential and browser profile seams', () => {
  it('decrypts an OS-keychain ref only inside Main', async () => {
    setSafeStorageForTesting({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: () => 'synthetic-keychain-secret',
    });
    const resolver = new NativeSecretMaterialResolver('/tmp/eve-test', () => null);
    const material = await resolver.resolve(resolveContext({}));
    expect(new TextDecoder().decode(material)).toBe('synthetic-keychain-secret');
  });

  it('delegates only opaque service aliases to the existing Hermes profile port', async () => {
    const read = vi.fn(async () => new TextEncoder().encode('synthetic-source-secret'));
    const port: HermesSecretSourceReadPort = { read };
    const resolver = new NativeSecretMaterialResolver('/tmp/eve-test', () => port);
    const material = await resolver.resolve(resolveContext({
      source: 'hermes_onepassword',
      sourceRef: 'secret-source:v1:onepassword:GOOGLE_API_TOKEN',
      handleType: 'oauth_token',
      slot: 'oauth_token',
      authMode: 'oauth',
    }));
    expect(new TextDecoder().decode(material)).toBe('synthetic-source-secret');
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'onepassword',
        alias: 'GOOGLE_API_TOKEN',
        ownerBinding: binding,
        useBinding: binding,
        reservationId: 'reservation-a',
        claimId: 'claim-a',
        targetOrigin: 'https://accounts.example',
        slot: 'oauth_token',
        executionContractDigest: `sha256:${'a'.repeat(64)}`,
      })
    );
    await expect(
      resolver.resolve(resolveContext({
        source: 'hermes_bitwarden',
        sourceRef: 'secret-source:v1:bitwarden:ACCOUNT_PASSWORD',
        handleType: 'account_credential',
      }))
    ).rejects.toThrow('EXTERNAL_HERMES_SOURCE_TYPE_BLOCKED');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('freezes the process-wide Hermes read port after one Main registration', async () => {
    const read = vi.fn(async () => new TextEncoder().encode('synthetic-source-secret'));
    const port: HermesSecretSourceReadPort = { read };
    registerHermesSecretSourceReadPort(port);
    expect(() => registerHermesSecretSourceReadPort(port)).toThrow('EXTERNAL_HERMES_SOURCE_PORT_ALREADY_REGISTERED');
    const resolver = new NativeSecretMaterialResolver('/tmp/eve-test');
    await expect(
      resolver.resolve(
        resolveContext({
          source: 'hermes_bitwarden',
          sourceRef: 'secret-source:v1:bitwarden:GOOGLE_API_TOKEN',
          handleType: 'oauth_token',
          slot: 'oauth_token',
          authMode: 'oauth',
        })
      )
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it('derives separate persistent browser profiles for account, seed and origin without embedding identifiers', () => {
    const base = externalActionBrowserPartition(binding, 'https://accounts.example');
    const account = externalActionBrowserPartition({ ...binding, accountId: 'account-b' }, 'https://accounts.example');
    const seed = externalActionBrowserPartition({ ...binding, seedId: 'seed-b' }, 'https://accounts.example');
    const origin = externalActionBrowserPartition(binding, 'https://mail.example');
    expect(new Set([base, account, seed, origin]).size).toBe(4);
    expect(base).toMatch(/^persist:command-eve-external-[a-f0-9]{32}$/);
    expect(base).not.toContain('account-a');
    expect(base).not.toContain('seed-a');
    expect(externalActionBrowserPartition(binding, 'http://accounts.example')).toBeNull();
  });
});
