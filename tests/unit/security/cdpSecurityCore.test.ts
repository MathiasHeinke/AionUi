import { describe, expect, it } from 'vitest';
import { shouldEnableCdpAtStartup } from '@/process/security/cdpSecurityCore';

describe('cdpSecurityCore', () => {
  it('keeps CDP disabled in packaged builds even when the environment asks for it', () => {
    expect(shouldEnableCdpAtStartup({ isPackaged: true, envPort: '9230', configEnabled: true })).toBe(false);
  });

  it('supports explicit development enable and disable controls', () => {
    expect(shouldEnableCdpAtStartup({ isPackaged: false, envPort: '9230' })).toBe(true);
    expect(shouldEnableCdpAtStartup({ isPackaged: false, envPort: '0', configEnabled: true })).toBe(false);
    expect(shouldEnableCdpAtStartup({ isPackaged: false, envPort: 'false', configEnabled: true })).toBe(false);
  });

  it('uses development config and defaults to enabled when unset', () => {
    expect(shouldEnableCdpAtStartup({ isPackaged: false, configEnabled: false })).toBe(false);
    expect(shouldEnableCdpAtStartup({ isPackaged: false, configEnabled: true })).toBe(true);
    expect(shouldEnableCdpAtStartup({ isPackaged: false })).toBe(true);
  });
});
