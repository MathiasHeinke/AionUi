import { describe, expect, it, vi } from 'vitest';
import {
  COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED_ENV,
  hardenPackagedCdpCommandLine,
  shouldAllowNonDistributableE2EAttachment,
  shouldEnableCdpAtStartup,
  synchronizeNonDistributableE2EAttachmentProof,
} from '@/process/security/cdpSecurityCore';

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

  it('strips packaged CDP switches from Chromium and argv without retaining values', () => {
    const argv = [
      '/Applications/Command EVE',
      '--remote-debugging-port=9222',
      '--remote-debugging-address=0.0.0.0',
      '--remote-debugging-pipe',
      '--inspect=9230',
      '--safe-flag',
    ];
    const removed: string[] = [];

    expect(
      hardenPackagedCdpCommandLine({
        isPackaged: true,
        argv,
        removeSwitch: (name) => removed.push(name),
      })
    ).toEqual(['inspect', 'remote-debugging-address', 'remote-debugging-pipe', 'remote-debugging-port']);
    expect(argv).toEqual(['/Applications/Command EVE', '--safe-flag']);
    expect(removed).toEqual([
      'remote-debugging-port',
      'remote-debugging-address',
      'remote-debugging-pipe',
      'inspect',
      'inspect-brk',
    ]);
  });

  it('leaves development command lines untouched', () => {
    const argv = ['electron', '--remote-debugging-port=9230'];
    const removeSwitch = vi.fn();

    expect(hardenPackagedCdpCommandLine({ isPackaged: false, argv, removeSwitch })).toEqual([]);
    expect(argv).toEqual(['electron', '--remote-debugging-port=9230']);
    expect(removeSwitch).not.toHaveBeenCalled();
  });

  it('requires packaged mode, both runtime gates, and the E2E package marker for attachment', () => {
    expect(
      shouldAllowNonDistributableE2EAttachment({
        isPackaged: true,
        e2eTest: true,
        attachmentRequested: true,
        packageMarkerPresent: true,
      })
    ).toBe(true);

    for (const missingGate of ['isPackaged', 'e2eTest', 'attachmentRequested', 'packageMarkerPresent'] as const) {
      expect(
        shouldAllowNonDistributableE2EAttachment({
          isPackaged: true,
          e2eTest: true,
          attachmentRequested: true,
          packageMarkerPresent: true,
          [missingGate]: false,
        })
      ).toBe(false);
    }
  });

  it('removes inherited attachment proof and only republishes a freshly verified decision', () => {
    const env: NodeJS.ProcessEnv = {
      [COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED_ENV]: '1',
    };

    synchronizeNonDistributableE2EAttachmentProof(env, false);
    expect(env[COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED_ENV]).toBeUndefined();

    synchronizeNonDistributableE2EAttachmentProof(env, true);
    expect(env[COMMAND_EVE_E2E_PACKAGED_ATTACHMENT_VERIFIED_ENV]).toBe('1');
  });

  it('keeps Playwright attachment switches only after the packaged attachment policy passes', () => {
    const argv = ['/Applications/Command EVE', '--inspect=0', '--remote-debugging-port=0'];
    const removeSwitch = vi.fn();

    expect(
      hardenPackagedCdpCommandLine({
        isPackaged: true,
        allowNonDistributableE2EAttachment: true,
        argv,
        removeSwitch,
      })
    ).toEqual([]);
    expect(argv).toEqual(['/Applications/Command EVE', '--inspect=0', '--remote-debugging-port=0']);
    expect(removeSwitch).not.toHaveBeenCalled();
  });
});
