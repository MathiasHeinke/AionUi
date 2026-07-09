import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { resolveExpectedAioncoreSha256, verifyFileSha256 } =
  require('../../../packages/shared-scripts/src/prepare-aioncore.js') as {
    resolveExpectedAioncoreSha256: (projectRoot: string, runtimeKey: string, explicit?: string) => string;
    verifyFileSha256: (filePath: string, expected: string) => string;
  };

describe('AionCore build integrity gate', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'aioncore-integrity-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('resolves a platform pin from package.json', () => {
    const root = makeRoot();
    const expected = 'a'.repeat(64);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ aioncoreSha256: { 'darwin-arm64': expected } }));
    expect(resolveExpectedAioncoreSha256(root, 'darwin-arm64')).toBe(expected);
  });

  it('fails closed when no valid platform pin exists', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ aioncoreSha256: {} }));
    expect(() => resolveExpectedAioncoreSha256(root, 'darwin-arm64')).toThrow(/Missing pinned AionCore SHA256/);
  });

  it('verifies archive bytes before extraction and rejects a mismatch', () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    const archive = join(root, 'aioncore.tar.gz');
    writeFileSync(archive, 'verified archive bytes');
    const expected = createHash('sha256').update('verified archive bytes').digest('hex');

    expect(verifyFileSha256(archive, expected)).toBe(expected);
    expect(() => verifyFileSha256(archive, 'b'.repeat(64))).toThrow(/SHA256 mismatch/);
  });
});
