import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'packages/desktop/src/renderer/index.html'), 'utf8');

function readCsp(): string {
  const match = source.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!match) throw new Error('main renderer CSP is missing');
  return match[1];
}

describe('main renderer CSP', () => {
  it('blocks executable remote content and unsafe script modes', () => {
    const csp = readCsp();
    const scriptDirective = csp.match(/(?:^|;\s*)script-src\s+([^;]+)/)?.[1] ?? '';
    expect(scriptDirective).toContain("'self'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('authorizes every inline script by its exact SHA-256 hash', () => {
    const csp = readCsp();
    const inlineScripts = Array.from(source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g));
    expect(inlineScripts).toHaveLength(2);
    for (const script of inlineScripts) {
      const hash = createHash('sha256').update(script[1]).digest('base64');
      expect(csp).toContain(`'sha256-${hash}'`);
    }
  });
});
