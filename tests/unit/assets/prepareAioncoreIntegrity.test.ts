import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { resolveExpectedAioncoreSha256, resolveLocalAioncoreSource, verifyAioncoreCliContract, verifyFileSha256 } =
  require('../../../packages/shared-scripts/src/prepare-aioncore.js') as {
    resolveExpectedAioncoreSha256: (projectRoot: string, runtimeKey: string, explicit?: string) => string;
    resolveLocalAioncoreSource: (
      localBinaryPath?: string,
      explicitSha256?: string,
      explicitSourceCommit?: string
    ) => { binaryPath: string; binarySha256: string; sourceCommit: string } | null;
    verifyAioncoreCliContract: (
      binaryPath: string,
      deps?: { execFileSync?: () => string }
    ) => { requiredArguments: string[] };
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

  it('requires an explicit hash and source commit for a local build', () => {
    const root = makeRoot();
    const binary = join(root, 'aioncore');
    writeFileSync(binary, 'local build');
    const expected = createHash('sha256').update('local build').digest('hex');

    expect(() => resolveLocalAioncoreSource(binary)).toThrow(/AIONUI_BACKEND_SHA256/);
    expect(() => resolveLocalAioncoreSource(binary, expected)).toThrow(/AIONUI_BACKEND_SOURCE_COMMIT/);
    expect(resolveLocalAioncoreSource(binary, expected, 'abcdef1234567')).toMatchObject({
      binarySha256: expected,
      sourceCommit: 'abcdef1234567',
    });
  });

  it('accepts only an AionCore binary that exposes the local capability contract', () => {
    expect(
      verifyAioncoreCliContract('/tmp/aioncore', {
        execFileSync: () => 'Usage: aioncore --local-capability-file <FILE> --local-origin <ORIGIN>',
      })
    ).toEqual({ requiredArguments: ['--local-capability-file', '--local-origin'] });

    expect(() =>
      verifyAioncoreCliContract('/tmp/aioncore', {
        execFileSync: () => 'Usage: aioncore --local',
      })
    ).toThrow(/CLI contract mismatch.*--local-capability-file, --local-origin/);
  });
});
