import {
  ARTIFACT_CONTENT_SECURITY_POLICY,
  parseArtifactConsoleMessage,
  resolveArtifactResourcePath,
  secureArtifactHtml,
} from '@/renderer/pages/conversation/Preview/components/renderers/htmlArtifactSecurityCore';
import { describe, expect, it } from 'vitest';

describe('htmlArtifactSecurityCore', () => {
  it('keeps relative resources inside the declared workspace', () => {
    expect(resolveArtifactResourcePath('/work/site/index.html', './assets/app.js', '/work')).toBe(
      '/work/site/assets/app.js'
    );
    expect(resolveArtifactResourcePath('/work/site/index.html', '../shared/logo.png', '/work')).toBe(
      '/work/shared/logo.png'
    );
    expect(resolveArtifactResourcePath('/work/site/index.html', '../../private.txt', '/work')).toBeNull();
    expect(resolveArtifactResourcePath('/work/site/index.html', '%2e%2e/%2e%2e/private.txt', '/work')).toBeNull();
  });

  it('rejects absolute, protocol, malformed, and cross-drive resource references', () => {
    expect(resolveArtifactResourcePath('/work/site/index.html', '/etc/passwd', '/work')).toBeNull();
    expect(resolveArtifactResourcePath('/work/site/index.html', 'file:///etc/passwd', '/work')).toBeNull();
    expect(resolveArtifactResourcePath('/work/site/index.html', 'https://example.com/a.js', '/work')).toBeNull();
    expect(resolveArtifactResourcePath('/work/site/index.html', '%E0%A4%A', '/work')).toBeNull();
    expect(resolveArtifactResourcePath('C:\\work\\site\\index.html', 'D:\\secret.txt', 'C:\\work')).toBeNull();
  });

  it('uses the artifact directory as the fallback boundary', () => {
    expect(resolveArtifactResourcePath('/work/site/index.html', 'assets/app.js')).toBe('/work/site/assets/app.js');
    expect(resolveArtifactResourcePath('/work/site/index.html', '../secret.txt')).toBeNull();
    expect(resolveArtifactResourcePath('/index.html', 'asset.js', '/')).toBe('/asset.js');
  });

  it('injects a network-denying CSP at the start of the head', () => {
    const secured = secureArtifactHtml('<html><head><title>Artifact</title></head><body></body></html>');
    expect(secured).toContain(`content="${ARTIFACT_CONTENT_SECURITY_POLICY}"`);
    expect(secured.indexOf('Content-Security-Policy')).toBeLessThan(secured.indexOf('<title>'));
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).toContain("frame-src 'none'");
    expect(ARTIFACT_CONTENT_SECURITY_POLICY).not.toContain('https:');
  });

  it('accepts only bounded and well-formed artifact console events', () => {
    expect(parseArtifactConsoleMessage('__INSPECT_ELEMENT__{"html":"<p>x</p>","tag":"p"}')).toEqual({
      kind: 'inspect',
      html: '<p>x</p>',
      tag: 'p',
    });
    expect(parseArtifactConsoleMessage('__SCROLL_SYNC__{"scrollTop":4,"scrollHeight":100,"clientHeight":20}')).toEqual({
      kind: 'scroll',
      scrollTop: 4,
      scrollHeight: 100,
      clientHeight: 20,
    });
    expect(parseArtifactConsoleMessage('__CONTENT_HEIGHT__420')).toEqual({ kind: 'height', height: 420 });
    expect(
      parseArtifactConsoleMessage('__SCROLL_SYNC__{"scrollTop":-1,"scrollHeight":100,"clientHeight":20}')
    ).toBeNull();
    expect(parseArtifactConsoleMessage(`__INSPECT_ELEMENT__${'x'.repeat(128 * 1024)}`)).toBeNull();
    expect(parseArtifactConsoleMessage('__CONTENT_HEIGHT__Infinity')).toBeNull();
  });
});
