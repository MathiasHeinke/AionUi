import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// build-with-builder.js runs all of its logic at module top-level and force-exits
// on failure, so it cannot be imported in-process for assertion. We instead spawn
// it as a real subprocess and assert the process exit code, which is the actual
// contract under test: a build failure MUST surface as a non-zero exit so CI /
// founder / automation never sees a broken build as green (the alpha.6 masking).
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/build-with-builder.js'
);

describe('build-with-builder.js exit-code propagation (fail-closed)', () => {
  it('exits non-zero when the build fails (synchronous throw path)', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--pack-only'], {
      encoding: 'utf8',
      // BUILD_WITH_BUILDER_SELFTEST_FAIL forces the very first statement of the
      // main try block to throw, deterministically exercising the failure path
      // without running a real electron build.
      env: { ...process.env, BUILD_WITH_BUILDER_SELFTEST_FAIL: '1' },
      timeout: 30000,
    });
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(1);
    const combined = `${result.stdout || ''}${result.stderr || ''}`;
    expect(combined).toMatch(/Build failed/);
  });

  it('removes stale generic mac metadata for arm64-only release artifacts', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'aionui-mac-feed-'));
    const version = '1.7.91';
    try {
      writeFileSync(path.join(tempDir, `Command-EVE-${version}-mac-arm64.dmg`), 'final-dmg');
      writeFileSync(path.join(tempDir, `Command-EVE-${version}-mac-arm64.zip`), 'final-zip');
      writeFileSync(path.join(tempDir, 'latest-mac.yml'), 'version: 1.7.91\nsha512: stale-pre-staple\n');
      writeFileSync(path.join(tempDir, 'latest-arm64-mac.yml'), 'version: 1.7.91\nsha512: current\n');

      const result = spawnSync(process.execPath, [scriptPath, '--pack-only'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          BUILD_WITH_BUILDER_SELFTEST_MAC_FEED_GUARD: '1',
          BUILD_WITH_BUILDER_SELFTEST_OUT_DIR: tempDir,
          BUILD_WITH_BUILDER_SELFTEST_VERSION: version,
          BUILD_WITH_BUILDER_SELFTEST_ARCH: 'arm64',
        },
        timeout: 30000,
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(existsSync(path.join(tempDir, 'latest-mac.yml'))).toBe(false);
      expect(existsSync(path.join(tempDir, 'latest-arm64-mac.yml'))).toBe(true);
      expect(`${result.stdout || ''}${result.stderr || ''}`).toContain('removed stale sibling metadata');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
