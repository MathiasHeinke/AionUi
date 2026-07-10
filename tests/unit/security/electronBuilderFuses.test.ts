import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FuseV1Options } from '@electron/fuses';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const { PACKAGED_ELECTRON_FUSE_POLICY, buildPackagedElectronFusePolicy, resolvePackagedElectronPath } =
  require('../../../scripts/electronFusePolicy') as typeof import('../../../scripts/electronFusePolicy');

describe('packaged Electron fuse policy', () => {
  it('fails closed on runtime injection and enforces ASAR integrity', () => {
    const configPath = path.resolve(process.cwd(), 'packages/desktop/electron-builder.yml');
    const config = YAML.parse(readFileSync(configPath, 'utf8')) as {
      asar?: unknown;
      afterPack?: string;
      electronFuses?: Record<string, boolean>;
    };

    expect(config.asar).toBeTruthy();
    expect(config.afterPack).toBe('scripts/afterPack.js');
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: true,
    });
  });

  it('sets every fuse known to the installed Electron fuse library explicitly', () => {
    const fuseIndexes = Object.values(FuseV1Options).filter((value): value is number => typeof value === 'number');

    expect(fuseIndexes).toHaveLength(9);
    expect(PACKAGED_ELECTRON_FUSE_POLICY.strictlyRequireAllFuses).toBe(true);
    for (const fuseIndex of fuseIndexes) {
      expect(PACKAGED_ELECTRON_FUSE_POLICY).toHaveProperty(String(fuseIndex));
      expect(typeof PACKAGED_ELECTRON_FUSE_POLICY[fuseIndex]).toBe('boolean');
    }
    expect(PACKAGED_ELECTRON_FUSE_POLICY[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(true);
    expect(PACKAGED_ELECTRON_FUSE_POLICY[FuseV1Options.WasmTrapHandlers]).toBe(true);
  });

  it('resolves the packaged app before signing on macOS', () => {
    expect(
      resolvePackagedElectronPath({
        electronPlatformName: 'darwin',
        appOutDir: '/tmp/command-eve-build',
        packager: { appInfo: { productFilename: 'Command EVE' } },
      })
    ).toBe(path.join('/tmp/command-eve-build', 'Command EVE.app'));
  });

  it('resets the ad-hoc signature only for Apple Silicon packages', () => {
    expect(buildPackagedElectronFusePolicy({ electronPlatformName: 'darwin' }, 'arm64')).toMatchObject({
      resetAdHocDarwinSignature: true,
    });
    expect(buildPackagedElectronFusePolicy({ electronPlatformName: 'darwin' }, 'x64')).toMatchObject({
      resetAdHocDarwinSignature: false,
    });
    expect(buildPackagedElectronFusePolicy({ electronPlatformName: 'win32' }, 'arm64')).toMatchObject({
      resetAdHocDarwinSignature: false,
    });
  });
});
