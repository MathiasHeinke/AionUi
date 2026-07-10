import path from 'path';
import { describe, expect, it } from 'vitest';
import { readExplicitUserDataDir, resolveElectronUserDataPath } from '@/common/platform/userDataPath';

describe('electron user-data path resolution', () => {
  it('keeps the product directory for normal launches', () => {
    expect(resolveElectronUserDataPath('/tmp/AionUi', 'Command EVE', ['electron'])).toBe(
      path.join('/tmp', 'Command EVE')
    );
  });

  it('preserves an equals-form explicit profile directory', () => {
    expect(
      resolveElectronUserDataPath('/tmp/AionUi', 'Command EVE', ['electron', '--user-data-dir=/tmp/eve-isolated'])
    ).toBe('/tmp/eve-isolated');
  });

  it('preserves a split-form explicit profile directory', () => {
    expect(
      resolveElectronUserDataPath('/tmp/AionUi', 'Command EVE', ['electron', '--user-data-dir', '/tmp/eve-recovery'])
    ).toBe('/tmp/eve-recovery');
  });

  it('ignores missing or empty explicit profile values', () => {
    expect(readExplicitUserDataDir(['electron', '--user-data-dir='])).toBeUndefined();
    expect(readExplicitUserDataDir(['electron', '--user-data-dir', '--safe-mode'])).toBeUndefined();
  });
});
