import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  getNotarizeAuthMode,
  getNotarizeOptions,
  parseFirstCodesignAuthority,
  resolvePythonSignIdentity,
} = require('../../../scripts/afterSign.js');

describe('afterSign bundled-python signing identity resolution', () => {
  const appPath = '/tmp/Command EVE.app';
  const identity = 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)';

  it('parses the exact first Authority from codesign display output', () => {
    expect(
      parseFirstCodesignAuthority(`Executable=${appPath}/Contents/MacOS/Command EVE
Identifier=com.fynlabs.commandeve
Authority=${identity}
Authority=Developer ID Certification Authority
Authority=Apple Root CA`)
    ).toBe(identity);
  });

  it('prefers an explicitly configured identity without inspecting the app', () => {
    let inspected = false;

    expect(
      resolvePythonSignIdentity(
        appPath,
        { CSC_NAME: identity },
        {
          runCodesignInspection: () => {
            inspected = true;
            throw new Error('must not inspect');
          },
        }
      )
    ).toBe(identity);
    expect(inspected).toBe(false);
  });

  it('derives the identity from the already-signed app when env configuration is absent', () => {
    const calls: string[][] = [];

    expect(
      resolvePythonSignIdentity(
        appPath,
        {},
        {
          runCodesignInspection: (args: string[]) => {
            calls.push(args);
            return {
              status: 0,
              signal: null,
              stdout: '',
              stderr: `Authority=${identity}\nAuthority=Developer ID Certification Authority\n`,
            };
          },
        }
      )
    ).toBe(identity);
    expect(calls).toEqual([['--display', '--verbose=4', appPath]]);
  });

  it('fails explicitly when codesign output has no certificate Authority', () => {
    expect(() =>
      resolvePythonSignIdentity(
        appPath,
        {},
        {
          runCodesignInspection: () => ({
            status: 0,
            signal: null,
            stdout: '',
            stderr: `Executable=${appPath}/Contents/MacOS/Command EVE\nSignature=adhoc\n`,
          }),
        }
      )
    ).toThrow(/no Authority entry; ad-hoc or unsigned signatures are not accepted/);
  });

  it('fails explicitly when codesign inspection itself fails', () => {
    expect(() =>
      resolvePythonSignIdentity(
        appPath,
        {},
        {
          runCodesignInspection: () => ({
            status: 1,
            signal: null,
            stdout: '',
            stderr: 'irrelevant diagnostic',
          }),
        }
      )
    ).toThrow(/codesign exited with status 1/);
  });
});

describe('afterSign notarization credential resolution', () => {
  const appBundleId = 'com.fynlabs.commandeve';
  const appPath = '/tmp/Command EVE.app';

  it('prefers a notarytool keychain profile when configured', () => {
    const options = getNotarizeOptions({
      appBundleId,
      appPath,
      env: {
        NOTARYTOOL_KEYCHAIN_PROFILE: 'command-eve-notary',
        APPLE_ID: 'ignored@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'ignored-password',
      },
    });

    expect(options).toMatchObject({
      tool: 'notarytool',
      appBundleId,
      appPath,
      keychainProfile: 'command-eve-notary',
    });
    expect(options).not.toHaveProperty('appleId');
    expect(getNotarizeAuthMode(options)).toContain('keychain profile');
  });

  it('supports App Store Connect API key credentials', () => {
    const options = getNotarizeOptions({
      appBundleId,
      appPath,
      env: {
        APPLE_API_KEY: '/secure/AuthKey_TEST.p8',
        APPLE_API_KEY_ID: 'ABC123DEFG',
        APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
      },
    });

    expect(options).toMatchObject({
      appleApiKey: '/secure/AuthKey_TEST.p8',
      appleApiKeyId: 'ABC123DEFG',
      appleApiIssuer: '00000000-0000-0000-0000-000000000000',
    });
    expect(getNotarizeAuthMode(options)).toBe('App Store Connect API key');
  });

  it('supports Apple ID app-specific password credentials', () => {
    const options = getNotarizeOptions({
      appBundleId,
      appPath,
      env: {
        APPLE_ID: 'developer@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'xxxx-xxxx-xxxx-xxxx',
        APPLE_TEAM_ID: 'NHNQ7Q5H28',
      },
    });

    expect(options).toMatchObject({
      appleId: 'developer@example.com',
      appleIdPassword: 'xxxx-xxxx-xxxx-xxxx',
      teamId: 'NHNQ7Q5H28',
    });
    expect(getNotarizeAuthMode(options)).toBe('Apple ID app-specific password');
  });

  it('keeps legacy env aliases working', () => {
    expect(
      getNotarizeOptions({
        appBundleId,
        appPath,
        env: {
          appleId: 'legacy@example.com',
          appleIdPassword: 'legacy-password',
          teamId: 'NHNQ7Q5H28',
        },
      })
    ).toMatchObject({
      appleId: 'legacy@example.com',
      appleIdPassword: 'legacy-password',
      teamId: 'NHNQ7Q5H28',
    });
  });

  it('returns null when no notarization credentials are configured', () => {
    expect(getNotarizeOptions({ appBundleId, appPath, env: {} })).toBeNull();
  });
});
