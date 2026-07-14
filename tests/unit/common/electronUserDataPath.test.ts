import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  readExplicitUserDataDir,
  resolveElectronUserDataPath,
  shouldUseGlobalCliSafeSymlink,
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
});
