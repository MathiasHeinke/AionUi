import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  hardenAttachedWebviewPreferences,
  isAllowedWebviewNavigation,
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

  it('keeps guest navigation inside its preview boundary', () => {
    expect(isAllowedWebviewNavigation('', 'https://command-eve.com/workbench')).toBe(true);
    expect(isAllowedWebviewNavigation('', 'file:///tmp/report.html')).toBe(false);
    expect(isAllowedWebviewNavigation('about:blank', 'https://command-eve.com/workbench')).toBe(true);
    expect(isAllowedWebviewNavigation('about:blank', 'http://127.0.0.1:4567/watch/index.html')).toBe(true);
    expect(isAllowedWebviewNavigation('about:blank', 'file:///tmp/report.html')).toBe(false);
    expect(isAllowedWebviewNavigation('about:blank', 'data:text/html,hello')).toBe(false);
    expect(isAllowedWebviewNavigation('about:blank', 'blob:https://command-eve.com/1234')).toBe(false);
    expect(
      isAllowedWebviewNavigation('http://127.0.0.1:4567/watch/index.html', 'http://127.0.0.1:4567/watch/page-2')
    ).toBe(true);
    expect(isAllowedWebviewNavigation('http://127.0.0.1:4567/watch/index.html', 'http://127.0.0.1:9999/admin')).toBe(
      false
    );
    expect(
      isAllowedWebviewNavigation('http://127.0.0.1:4567/watch/index.html', 'blob:http://127.0.0.1:4567/browser-proof')
    ).toBe(false);
    expect(isAllowedWebviewNavigation('file:///tmp/report.html', 'file:///tmp/other.html')).toBe(false);
    expect(isAllowedWebviewNavigation('data:text/html,hello', 'https://attacker.example/')).toBe(false);
    expect(isAllowedWebviewNavigation('file:///tmp/report.html', 'javascript:alert(1)')).toBe(false);
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
      safeDialogs: true,
      navigateOnDragDrop: false,
      enableWebSQL: false,
    });
  });
});
