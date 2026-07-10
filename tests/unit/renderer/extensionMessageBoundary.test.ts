import { describe, expect, it } from 'vitest';

import {
  isExternalExtensionSettingsUrl,
  isTrustedFrameMessage,
  resolveTrustedFrameOrigin,
} from '@/renderer/utils/extensionMessageBoundary';

describe('extension settings frame message boundary', () => {
  it('keeps backend-relative tabs internal and classifies explicit network URLs as external', () => {
    expect(isExternalExtensionSettingsUrl('/api/extensions/example/settings')).toBe(false);
    expect(isExternalExtensionSettingsUrl('settings/index.html')).toBe(false);
    expect(isExternalExtensionSettingsUrl('https://example.com/settings')).toBe(true);
    expect(isExternalExtensionSettingsUrl('//example.com/settings')).toBe(true);
  });

  it('pins absolute and relative backend URLs to their HTTP(S) origin', () => {
    expect(resolveTrustedFrameOrigin('http://127.0.0.1:59178/extensions/settings')).toBe('http://127.0.0.1:59178');
    expect(resolveTrustedFrameOrigin('/extensions/settings', 'https://eve.example/app')).toBe('https://eve.example');
  });

  it('rejects opaque and executable origins', () => {
    expect(resolveTrustedFrameOrigin('file:///tmp/settings.html')).toBeNull();
    expect(resolveTrustedFrameOrigin('data:text/html,hello')).toBeNull();
    expect(resolveTrustedFrameOrigin('javascript:alert(1)')).toBeNull();
    expect(resolveTrustedFrameOrigin('not a URL')).toBeNull();
  });

  it('accepts only the original frame and its pinned origin', () => {
    const frameWindow = {};
    const expectedOrigin = 'http://127.0.0.1:59178';

    expect(isTrustedFrameMessage({ source: frameWindow, origin: expectedOrigin }, frameWindow, expectedOrigin)).toBe(
      true
    );
    expect(isTrustedFrameMessage({ source: {}, origin: expectedOrigin }, frameWindow, expectedOrigin)).toBe(false);
    expect(
      isTrustedFrameMessage({ source: frameWindow, origin: 'https://attacker.example' }, frameWindow, expectedOrigin)
    ).toBe(false);
    expect(isTrustedFrameMessage({ source: frameWindow, origin: expectedOrigin }, frameWindow, null)).toBe(false);
  });
});
