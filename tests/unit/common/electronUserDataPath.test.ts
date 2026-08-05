import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  readExplicitUserDataDir,
  resolveElectronUserDataPath,
  resolveGuardedElectronUserDataPath,
  shouldUseGlobalCliSafeSymlink,
  type GuardedUserDataPathInput,
} from '@/common/platform/userDataPath';

describe('electron user-data path resolution', () => {
  it('keeps the product directory for normal launches', () => {
    expect(resolveElectronUserDataPath('/tmp/AionUi', 'Command EVE', ['electron'])).toBe(
      path.join('/tmp', 'Command EVE')
    );
  });

  it('preserves an equals-form explicit profile directory', () => {
    expect(
      resolveElectronUserDataPath('/tmp/AionUi', 'Command EVE', ['electron', '--user-data-dir=/tmp/eve-isolated'])
    ).toBe(path.resolve('/tmp/eve-isolated'));
  });

  it('preserves a split-form explicit profile directory', () => {
    expect(
      resolveElectronUserDataPath('/tmp/AionUi', 'Command EVE', ['electron', '--user-data-dir', '/tmp/eve-recovery'])
    ).toBe(path.resolve('/tmp/eve-recovery'));
  });

  it('ignores missing or empty explicit profile values', () => {
    expect(readExplicitUserDataDir(['electron', '--user-data-dir='])).toBeUndefined();
    expect(readExplicitUserDataDir(['electron', '--user-data-dir', '--safe-mode'])).toBeUndefined();
  });

  it('uses the global CLI symlink only for normal launches', () => {
    expect(shouldUseGlobalCliSafeSymlink(['electron'])).toBe(true);
    expect(shouldUseGlobalCliSafeSymlink(['electron', '--user-data-dir=/tmp/eve-isolated'])).toBe(false);
    expect(shouldUseGlobalCliSafeSymlink(['electron', '--user-data-dir', '/tmp/eve-recovery'])).toBe(false);
    expect(shouldUseGlobalCliSafeSymlink(['electron', '--user-data-dir='])).toBe(true);
  });

  it('skips the global CLI symlink when COMMAND_EVE_USER_DATA_DIR pins a profile', () => {
    vi.stubEnv('COMMAND_EVE_USER_DATA_DIR', '/tmp/eve-pinned-profile');
    try {
      expect(shouldUseGlobalCliSafeSymlink(['electron'])).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('guarded user-data path resolution (MAT-1773 sandbox guard)', () => {
  const PRODUCTION_USER_DATA = path.join('/Users/founder', 'Library', 'Application Support', 'Command EVE');
  const HOME = '/Users/founder';
  const INSTALLED_APP_PATH = '/Applications/Command EVE.app/Contents/Resources/app.asar';
  const SANDBOX_APP_PATH =
    '/Users/founder/Developer/.agent-sandboxes/aionui/eve-18205/out/mac-arm64/Command EVE.app/Contents/Resources/app.asar';

  function makeInput(overrides: Partial<GuardedUserDataPathInput> = {}): GuardedUserDataPathInput {
    return {
      currentUserDataPath: PRODUCTION_USER_DATA,
      appName: 'Command EVE',
      appPath: INSTALLED_APP_PATH,
      isPackaged: true,
      platform: 'darwin',
      env: {},
      argv: ['Command EVE'],
      homeDir: HOME,
      ...overrides,
    };
  }

  it('keeps the production profile for an installed /Applications build', () => {
    const result = resolveGuardedElectronUserDataPath(makeInput());
    expect(result.userDataPath).toBe(PRODUCTION_USER_DATA);
    expect(result.source).toBe('production');
  });

  it('keeps the production profile for a ~/Applications install', () => {
    const result = resolveGuardedElectronUserDataPath(
      makeInput({ appPath: `${HOME}/Applications/Command EVE.app/Contents/Resources/app.asar` })
    );
    expect(result.userDataPath).toBe(PRODUCTION_USER_DATA);
    expect(result.source).toBe('production');
  });

  it('isolates the profile for a sandbox build outside /Applications', () => {
    const result = resolveGuardedElectronUserDataPath(makeInput({ appPath: SANDBOX_APP_PATH }));
    expect(result.source).toBe('sandbox-isolation');
    expect(result.userDataPath).not.toBe(PRODUCTION_USER_DATA);
    expect(result.userDataPath.startsWith(path.join(path.dirname(PRODUCTION_USER_DATA), 'Command EVE Sandbox-'))).toBe(
      true
    );
  });

  it('isolates the profile for electron-builder out/ output under /tmp', () => {
    const result = resolveGuardedElectronUserDataPath(
      makeInput({ appPath: '/tmp/e2e-build/out/mac-arm64/Command EVE.app/Contents/Resources/app.asar' })
    );
    expect(result.source).toBe('sandbox-isolation');
    expect(result.userDataPath).not.toBe(PRODUCTION_USER_DATA);
  });

  it('derives a deterministic, per-location sandbox profile directory', () => {
    const first = resolveGuardedElectronUserDataPath(makeInput({ appPath: SANDBOX_APP_PATH }));
    const repeat = resolveGuardedElectronUserDataPath(makeInput({ appPath: SANDBOX_APP_PATH }));
    const other = resolveGuardedElectronUserDataPath(
      makeInput({ appPath: '/tmp/other-sandbox/Command EVE.app/Contents/Resources/app.asar' })
    );
    expect(first.userDataPath).toBe(repeat.userDataPath);
    expect(first.userDataPath).not.toBe(other.userDataPath);
  });

  it('lets COMMAND_EVE_USER_DATA_DIR override the sandbox guard', () => {
    const result = resolveGuardedElectronUserDataPath(
      makeInput({ appPath: SANDBOX_APP_PATH, env: { COMMAND_EVE_USER_DATA_DIR: '/tmp/eve-pinned-profile' } })
    );
    expect(result.userDataPath).toBe(path.resolve('/tmp/eve-pinned-profile'));
    expect(result.source).toBe('env-override');
  });

  it('lets --user-data-dir win over env override and the sandbox guard', () => {
    const result = resolveGuardedElectronUserDataPath(
      makeInput({
        appPath: SANDBOX_APP_PATH,
        env: { COMMAND_EVE_USER_DATA_DIR: '/tmp/eve-pinned-profile' },
        argv: ['Command EVE', '--user-data-dir=/tmp/eve-e2e-profile'],
      })
    );
    expect(result.userDataPath).toBe(path.resolve('/tmp/eve-e2e-profile'));
    expect(result.source).toBe('argv-override');
  });

  it('isolates even an /Applications-located build when AIONUI_E2E_TEST=1', () => {
    const result = resolveGuardedElectronUserDataPath(makeInput({ env: { AIONUI_E2E_TEST: '1' } }));
    expect(result.source).toBe('sandbox-isolation');
    expect(result.userDataPath).not.toBe(PRODUCTION_USER_DATA);
  });

  it('isolates even an /Applications-located build when the packaged e2e marker file is present', () => {
    const result = resolveGuardedElectronUserDataPath(makeInput({ packagedE2eMarkerPresent: true }));
    expect(result.source).toBe('sandbox-isolation');
    expect(result.userDataPath).not.toBe(PRODUCTION_USER_DATA);
  });

  it('isolates even an /Applications-located build when COMMAND_EVE_E2E_PACKAGED_ATTACHMENT=1', () => {
    const result = resolveGuardedElectronUserDataPath(makeInput({ env: { COMMAND_EVE_E2E_PACKAGED_ATTACHMENT: '1' } }));
    expect(result.source).toBe('sandbox-isolation');
    expect(result.userDataPath).not.toBe(PRODUCTION_USER_DATA);
  });

  it('keeps the dev-suffixed profile for unpackaged dev runs outside /Applications', () => {
    const result = resolveGuardedElectronUserDataPath(
      makeInput({
        isPackaged: false,
        appName: 'Command EVE-dev',
        appPath: '/Users/founder/Developer/aionui',
        currentUserDataPath: path.join(HOME, 'Library', 'Application Support', 'Electron'),
      })
    );
    expect(result.userDataPath).toBe(path.join(HOME, 'Library', 'Application Support', 'Command EVE-dev'));
    expect(result.source).toBe('dev');
  });

  it('keeps the production profile for packaged builds on non-macOS platforms without e2e markers', () => {
    const result = resolveGuardedElectronUserDataPath(
      makeInput({
        platform: 'win32',
        appPath: 'C:\\Users\\founder\\AppData\\Local\\Programs\\Command EVE\\resources\\app.asar',
      })
    );
    expect(result.source).toBe('production');
    expect(result.userDataPath).toBe(PRODUCTION_USER_DATA);
  });
});
