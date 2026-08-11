import { afterEach, describe, expect, it, vi } from 'vitest';

import { setSafeStorageForTesting } from '@/common/config/keychain';
import { externalActionBrowserPartition } from '@/process/services/external-action/browserProfileScope';
import {
  NativeSecretMaterialResolver,
  type HermesSecretSourceReadPort,
} from '@/process/services/external-action/nativeSecretMaterialResolver';

const binding = { installationId: 'install-a', accountId: 'account-a', seedId: 'seed-a' };

afterEach(() => {
  setSafeStorageForTesting(undefined);
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
    const material = await resolver.resolve({
      source: 'eve_keychain',
      sourceRef: `keychain:v1:${Buffer.from('ciphertext').toString('base64')}`,
      handleType: 'account_credential',
      ownerBinding: binding,
      useBinding: binding,
      actionKind: 'browser_submit',
      targetOrigin: 'https://accounts.example',
    });
    expect(new TextDecoder().decode(material)).toBe('synthetic-keychain-secret');
  });

  it('delegates only opaque service aliases to the existing Hermes profile port', async () => {
    const read = vi.fn(async () => new TextEncoder().encode('synthetic-source-secret'));
    const port: HermesSecretSourceReadPort = { read };
    const resolver = new NativeSecretMaterialResolver('/tmp/eve-test', () => port);
    const material = await resolver.resolve({
      source: 'hermes_onepassword',
      sourceRef: 'secret-source:v1:onepassword:GOOGLE_API_TOKEN',
      handleType: 'oauth_token',
      ownerBinding: binding,
      useBinding: binding,
      actionKind: 'browser_submit',
      targetOrigin: 'https://accounts.example',
    });
    expect(new TextDecoder().decode(material)).toBe('synthetic-source-secret');
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'onepassword',
        alias: 'GOOGLE_API_TOKEN',
        accountId: 'account-a',
        seedId: 'seed-a',
      })
    );
    await expect(
      resolver.resolve({
        source: 'hermes_bitwarden',
        sourceRef: 'secret-source:v1:bitwarden:ACCOUNT_PASSWORD',
        handleType: 'account_credential',
        ownerBinding: binding,
        useBinding: binding,
        actionKind: 'browser_submit',
        targetOrigin: 'https://accounts.example',
      })
    ).rejects.toThrow('EXTERNAL_HERMES_SOURCE_TYPE_BLOCKED');
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
