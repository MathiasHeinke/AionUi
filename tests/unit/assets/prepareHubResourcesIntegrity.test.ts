import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  DEFAULT_TAG,
  DEFAULT_SHA256_BY_FILE,
  loadPinnedSha256ByFile,
  normalizeSha256,
  resolveHubDownloadUrl,
  verifyFileSha256,
} = require('../../../scripts/prepareHubResources.js') as {
  DEFAULT_TAG: string;
  DEFAULT_SHA256_BY_FILE: Record<string, string>;
  loadPinnedSha256ByFile: (tag: string) => Record<string, string>;
  normalizeSha256: (value: unknown) => string | null;
  resolveHubDownloadUrl: (baseUrl: string, relativePath: string) => string;
  verifyFileSha256: (filePath: string, expected: string) => string;
};

describe('AionHub build integrity gate', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'aionhub-integrity-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('uses an immutable commit instead of the moving dist-latest tag', () => {
    expect(DEFAULT_TAG).toMatch(/^[0-9a-f]{40}$/);
    expect(DEFAULT_TAG).not.toBe('dist-latest');
    expect(loadPinnedSha256ByFile(DEFAULT_TAG)).toBe(DEFAULT_SHA256_BY_FILE);
    expect(Object.keys(DEFAULT_SHA256_BY_FILE)).toHaveLength(8);
  });

  it('allows only relative assets on the pinned HTTPS mirrors', () => {
    expect(
      resolveHubDownloadUrl(`https://raw.githubusercontent.com/iOfficeAI/AionHub/${DEFAULT_TAG}/`, 'index.json')
    ).toBe(`https://raw.githubusercontent.com/iOfficeAI/AionHub/${DEFAULT_TAG}/index.json`);
    expect(() =>
      resolveHubDownloadUrl('https://raw.githubusercontent.com/iOfficeAI/AionHub/x/', 'https://evil.example/x.zip')
    ).toThrow(/Invalid AionHub relative asset path/);
    expect(() => resolveHubDownloadUrl('https://evil.example/', 'x.zip')).toThrow(/Untrusted AionHub download URL/);
    expect(() => resolveHubDownloadUrl('https://raw.githubusercontent.com/iOfficeAI/AionHub/x/', '../x.zip')).toThrow(
      /Invalid AionHub relative asset path/
    );
  });

  it('requires the declared SHA256 and rejects modified extension bytes', () => {
    const root = makeRoot();
    const zip = join(root, 'extension.zip');
    writeFileSync(zip, 'trusted extension bytes');
    const sha256 = createHash('sha256').update('trusted extension bytes').digest('hex');

    expect(normalizeSha256(sha256)).toBe(sha256);
    expect(verifyFileSha256(zip, sha256)).toBe(sha256);
    expect(() => verifyFileSha256(zip, 'f'.repeat(64))).toThrow(/SHA256 mismatch/);
    expect(() => verifyFileSha256(zip, 'sha256-missing')).toThrow(/Missing or malformed/);
  });
});
