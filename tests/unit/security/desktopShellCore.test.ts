import { describe, expect, it } from 'vitest';

import { parseDesktopAbsolutePath, parseDesktopExternalUrl } from '@/process/security/desktopShellCore';

describe('desktop shell input boundary', () => {
  it('allows normal browser URLs and rejects executable or local schemes', () => {
    expect(parseDesktopExternalUrl('https://command-eve.com/account')).toBe('https://command-eve.com/account');
    expect(parseDesktopExternalUrl('http://127.0.0.1:9222/json')).toBe('http://127.0.0.1:9222/json');
    expect(parseDesktopExternalUrl('mailto:support@command-eve.com')).toBe('mailto:support@command-eve.com');

    expect(() => parseDesktopExternalUrl('javascript:alert(1)')).toThrow('not allowed');
    expect(() => parseDesktopExternalUrl('file:///etc/passwd')).toThrow('not allowed');
    expect(() => parseDesktopExternalUrl('command-eve://auth/callback')).toThrow('not allowed');
    expect(() => parseDesktopExternalUrl('not a url')).toThrow('Invalid');
  });

  it('requires bounded absolute paths without NUL bytes', () => {
    expect(parseDesktopAbsolutePath('/tmp/report.pdf')).toBe('/tmp/report.pdf');
    expect(parseDesktopAbsolutePath('C:\\Users\\Eve\\report.pdf')).toBe('C:\\Users\\Eve\\report.pdf');

    expect(() => parseDesktopAbsolutePath('../report.pdf')).toThrow('absolute');
    expect(() => parseDesktopAbsolutePath('')).toThrow('absolute');
    expect(() => parseDesktopAbsolutePath('/tmp/report\0.pdf')).toThrow('absolute');
    expect(() => parseDesktopAbsolutePath(`/tmp/${'x'.repeat(33 * 1024)}`)).toThrow('absolute');
  });
});
