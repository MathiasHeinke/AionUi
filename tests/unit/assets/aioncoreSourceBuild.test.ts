import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { bindCommandEveAioncoreBinary, REQUIRED_PLATFORMS, resolveCommandEveAioncoreSource } =
  require('../../../scripts/aioncoreSourceBuild.cjs') as {
    REQUIRED_PLATFORMS: readonly string[];
    resolveCommandEveAioncoreSource: (
      packageJson: Record<string, unknown>,
      platform: string
    ) => {
      repository: string;
      commit: string;
      rustToolchain: string;
      target: string;
      binary: string;
      rustflags: string;
    };
    bindCommandEveAioncoreBinary: (
      options: {
        sourceRoot: string;
        environmentFile: string;
        config: ReturnType<typeof resolveCommandEveAioncoreSource>;
      },
      deps?: { readSourceCommit?: (sourceRoot: string) => string }
    ) => { binaryPath: string; binarySha256: string; sourceCommit: string };
  };

describe('Command EVE AionCore source build binding', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'command-eve-aioncore-source-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('pins every release platform to one source repository and commit', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const resolved = REQUIRED_PLATFORMS.map((platform) => resolveCommandEveAioncoreSource(packageJson, platform));

    expect(new Set(resolved.map((item) => item.repository))).toEqual(new Set(['MathiasHeinke/AionCore']));
    expect(new Set(resolved.map((item) => item.commit))).toEqual(new Set(['a6d947265cd7188a76fe6f7b9343dc3834f7a90c']));
    expect(resolveCommandEveAioncoreSource(packageJson, 'windows-x64')).toMatchObject({
      target: 'x86_64-pc-windows-msvc',
      binary: 'aioncore.exe',
      rustflags: '-C target-feature=+crt-static',
    });
    expect(resolveCommandEveAioncoreSource(packageJson, 'macos-arm64')).toMatchObject({
      target: 'aarch64-apple-darwin',
      binary: 'aioncore',
      rustflags: '',
    });
  });

  it('rejects incomplete platform maps and non-full source commits', () => {
    const base = {
      commandEveAioncoreSource: {
        repository: 'MathiasHeinke/AionCore',
        commit: 'f067967',
        rustToolchain: '1.95.0',
        targets: Object.fromEntries(REQUIRED_PLATFORMS.map((platform) => [platform, 'target'])),
      },
    };
    expect(() => resolveCommandEveAioncoreSource(base, 'windows-x64')).toThrow(/full lowercase 40-character SHA/);
    expect(() =>
      resolveCommandEveAioncoreSource(
        {
          commandEveAioncoreSource: {
            ...base.commandEveAioncoreSource,
            commit: 'a'.repeat(40),
            targets: { 'windows-x64': 'x86_64-pc-windows-msvc' },
          },
        },
        'windows-x64'
      )
    ).toThrow(/must define exactly/);
  });

  it('binds only a binary produced by the exact pinned source commit', () => {
    const root = makeRoot();
    const environmentFile = join(root, 'github-env');
    const commit = 'a'.repeat(40);
    const config = {
      repository: 'MathiasHeinke/AionCore',
      commit,
      rustToolchain: '1.95.0',
      target: 'x86_64-pc-windows-msvc',
      binary: 'aioncore.exe',
      rustflags: '-C target-feature=+crt-static',
    };
    const binaryDirectory = join(root, 'target', config.target, 'release');
    mkdirSync(binaryDirectory, { recursive: true });
    writeFileSync(join(binaryDirectory, config.binary), 'verified windows binary');

    const result = bindCommandEveAioncoreBinary(
      { sourceRoot: root, environmentFile, config },
      { readSourceCommit: () => commit }
    );
    const expectedHash = createHash('sha256').update('verified windows binary').digest('hex');
    expect(result.binarySha256).toBe(expectedHash);
    expect(readFileSync(environmentFile, 'utf8')).toContain(`AIONUI_BACKEND_SHA256=${expectedHash}`);
    expect(readFileSync(environmentFile, 'utf8')).toContain(`AIONUI_BACKEND_SOURCE_COMMIT=${commit}`);
    expect(() =>
      bindCommandEveAioncoreBinary(
        { sourceRoot: root, environmentFile, config },
        { readSourceCommit: () => 'b'.repeat(40) }
      )
    ).toThrow(/source checkout mismatch/);
  });
});
