import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  hardenAttachedWebviewPreferences,
  isAllowedWebviewSource,
  isSafeExternalNavigationUrl,
  isTrustedMainRendererUrl,
} from '@/process/security/mainWindowSecurityCore';

describe('main window security boundary', () => {
  const fallbackFile = path.resolve(
    '/Applications/Command EVE.app/Contents/Resources/app.asar/out/renderer/index.html'
  );

  it('allows only the packaged renderer file, including its query and hash', () => {
    const expected = pathToFileURL(fallbackFile).href;
    const policy = { isPackaged: true, fallbackFile };

    expect(isTrustedMainRendererUrl(`${expected}?mode=desktop#chat`, policy)).toBe(true);
    expect(
      isTrustedMainRendererUrl(pathToFileURL(path.join(path.dirname(fallbackFile), 'other.html')).href, policy)
    ).toBe(false);
    expect(isTrustedMainRendererUrl('https://attacker.example/', policy)).toBe(false);
  });

  it('limits development navigation to the configured renderer origin', () => {
    const policy = { isPackaged: false, rendererUrl: 'http://127.0.0.1:5173/app', fallbackFile };
    expect(isTrustedMainRendererUrl('http://127.0.0.1:5173/settings', policy)).toBe(true);
    expect(isTrustedMainRendererUrl('http://localhost:5173/settings', policy)).toBe(false);
    expect(isTrustedMainRendererUrl('https://attacker.example/', policy)).toBe(false);
  });

  it('opens only normal external browser schemes and allowlists isolated webview schemes', () => {
    expect(isSafeExternalNavigationUrl('https://command-eve.com/help')).toBe(true);
    expect(isSafeExternalNavigationUrl('mailto:support@command-eve.com')).toBe(true);
    expect(isSafeExternalNavigationUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalNavigationUrl('javascript:alert(1)')).toBe(false);

    expect(isAllowedWebviewSource('data:text/html,hello')).toBe(true);
    expect(isAllowedWebviewSource('file:///tmp/artifact.html')).toBe(true);
    expect(isAllowedWebviewSource('about:blank')).toBe(true);
    expect(isAllowedWebviewSource('about:srcdoc')).toBe(false);
    expect(isAllowedWebviewSource('javascript:alert(1)')).toBe(false);
  });

  it('removes guest preloads and forces isolated web preferences', () => {
    const preferences: Record<string, unknown> = {
      preload: '/tmp/evil.js',
      preloadURL: 'file:///tmp/evil.js',
      nodeIntegration: true,
      allowRunningInsecureContent: true,
    };

    hardenAttachedWebviewPreferences(preferences);

    expect(preferences).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });
});
