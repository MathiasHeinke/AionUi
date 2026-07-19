import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  resolveAioncoreArtifactProvenance,
  resolveExpectedAioncoreSha256,
  resolveLocalAioncoreSource,
  verifyAioncoreCliContract,
  verifyFileSha256,
} = require('../../../packages/shared-scripts/src/prepare-aioncore.js') as {
    resolveAioncoreArtifactProvenance: (
      projectRoot: string,
      runtimeKey: string
    ) => { kind: string; repository: string; commit: string; tag?: string; sha256: string };
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

  it('resolves an upstream release archive pin from package.json', () => {
    const root = makeRoot();
    const expected = 'a'.repeat(64);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        aioncoreArtifactProvenance: {
          'darwin-arm64': {
            kind: 'upstream-release-archive',
            repository: 'iOfficeAI/AionCore',
            commit: 'b'.repeat(40),
            tag: 'v0.1.37',
            sha256: expected,
          },
        },
      })
    );
    expect(resolveExpectedAioncoreSha256(root, 'darwin-arm64')).toBe(expected);
  });

  it('refuses to treat a source-built binary hash as a release archive hash', () => {
    const root = makeRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        aioncoreArtifactProvenance: {
          'darwin-arm64': {
            kind: 'command-eve-source-build',
            repository: 'MathiasHeinke/AionCore',
            commit: 'b'.repeat(40),
            sha256: 'a'.repeat(64),
          },
        },
      })
    );
    expect(() => resolveExpectedAioncoreSha256(root, 'darwin-arm64')).toThrow(/pinned to a Command EVE source build/);
  });

  it('fails closed when no valid platform pin exists', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ aioncoreArtifactProvenance: {} }));
    expect(() => resolveExpectedAioncoreSha256(root, 'darwin-arm64')).toThrow(
      /Missing or malformed AionCore artifact provenance/
    );
  });

  it('binds every checked-in artifact hash to its actual source kind', () => {
    const projectRoot = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    expect(resolveAioncoreArtifactProvenance(projectRoot, 'darwin-arm64')).toMatchObject({
      kind: 'command-eve-source-build',
      repository: 'MathiasHeinke/AionCore',
      commit: packageJson.commandEveAioncoreSource.commit,
    });
    for (const runtimeKey of ['darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
      expect(resolveAioncoreArtifactProvenance(projectRoot, runtimeKey)).toMatchObject({
        kind: 'upstream-release-archive',
        repository: 'iOfficeAI/AionCore',
        commit: 'abbcd7823d4165781c2d9f6bacadc6bdbe17aef2',
        tag: 'v0.1.37',
      });
    }
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
