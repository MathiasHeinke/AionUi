/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const itWithPosixExecutable = it.skipIf(process.platform === 'win32');

function writeManagedResourceLocalBinary(localBinary: string): void {
  mkdirSync(resolve(localBinary, '..'), { recursive: true });
  writeFileSync(
    localBinary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: aioncore --local --local-capability-file <FILE> --local-origin <ORIGIN>\\n');
  process.exit(0);
}
const bundleOut = args[args.indexOf('--bundle-out') + 1];
if (!args.includes('prepare-managed-resources') || !bundleOut) process.exit(2);
fs.mkdirSync(path.join(bundleOut, 'node', 'node-v-test-darwin-arm64', 'bin'), { recursive: true });
fs.writeFileSync(path.join(bundleOut, 'node', 'node-v-test-darwin-arm64', 'bin', 'node'), '');
for (const [toolId, version, entrypoint] of [
  ['codex-acp', '0.0.0', 'codex-acp'],
  ['claude-agent-acp', '0.39.0', 'claude-agent-acp'],
]) {
  const root = path.join(bundleOut, 'acp', toolId, version, 'darwin-arm64');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ entrypoint }));
  fs.writeFileSync(path.join(root, entrypoint), '');
}
`,
    'utf8'
  );
  chmodSync(localBinary, 0o755);
}

function writeSourceBuildProvenance(projectRoot: string, sourceCommit: string, sha256: string): void {
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      aioncoreArtifactProvenance: {
        'darwin-arm64': {
          kind: 'command-eve-source-build',
          repository: 'MathiasHeinke/AionCore',
          commit: sourceCommit,
          sha256,
        },
      },
    })
  );
}

describe('prepareAioncore reuse guard', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aionui-prepare-aioncore-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  itWithPosixExecutable('repairs an existing verified local bundle when managed resources are missing', () => {
    const projectRoot = join(tmp, 'project');
    const runtimeDir = join(projectRoot, 'resources', 'bundled-aioncore', 'darwin-arm64');
    const localBinary = join(tmp, 'private-build', 'aioncore');
    const sourceCommit = 'a'.repeat(40);
    const hookPath = join(tmp, 'hook.cjs');
    const scriptPath = join(tmp, 'run.cjs');

    mkdirSync(runtimeDir, { recursive: true });
    writeManagedResourceLocalBinary(localBinary);
    const expectedSha256 = createHash('sha256').update(readFileSync(localBinary)).digest('hex');
    writeSourceBuildProvenance(projectRoot, sourceCommit, expectedSha256);
    writeFileSync(join(runtimeDir, 'aioncore'), readFileSync(localBinary), { flush: true });
    chmodSync(join(runtimeDir, 'aioncore'), 0o755);
    writeFileSync(
      join(runtimeDir, 'manifest.json'),
      JSON.stringify({
        platform: 'darwin',
        arch: 'arm64',
        version: 'v-test',
        sourceType: 'command-eve-local-build',
        source: { commit: sourceCommit },
        sourceSha256: expectedSha256,
        binarySha256: expectedSha256,
        preSignBinarySha256: expectedSha256,
        binarySha256Scope: 'pre-sign-input',
      }),
      { flush: true }
    );

    writeFileSync(
      hookPath,
      `
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function patchedExecFileSync(file, args, options) {
  if (Array.isArray(args) && args.includes('prepare-managed-resources')) {
    const bundleOut = args[args.indexOf('--bundle-out') + 1];
    fs.mkdirSync(path.join(bundleOut, 'node', 'node-v-test-darwin-arm64', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundleOut, 'node', 'node-v-test-darwin-arm64', 'bin', 'node'), '');

    for (const [toolId, version, entrypoint] of [
      ['codex-acp', '0.0.0', 'codex-acp'],
      ['claude-agent-acp', '0.39.0', 'claude-agent-acp'],
    ]) {
      const root = path.join(bundleOut, 'acp', toolId, version, 'darwin-arm64');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ entrypoint }));
      fs.writeFileSync(path.join(root, entrypoint), '');
    }
    return Buffer.from('');
  }

  return originalExecFileSync.call(this, file, args, options);
};
`,
      'utf8'
    );

    writeFileSync(
      scriptPath,
      `
const path = require('node:path');
const { prepareAioncore } = require(path.join(${JSON.stringify(repoRoot)}, 'packages/shared-scripts/src/prepare-aioncore.js'));
const { verifyBundledAioncoreResources } = require(path.join(${JSON.stringify(
        repoRoot
      )}, 'packages/shared-scripts/src/verify-bundled-aioncore-resources.js'));

const projectRoot = ${JSON.stringify(projectRoot)};
prepareAioncore({
  projectRoot,
  platform: 'darwin',
  arch: 'arm64',
  version: 'v-test',
  localBinaryPath: ${JSON.stringify(localBinary)},
  expectedSha256: ${JSON.stringify(expectedSha256)},
  sourceCommit: ${JSON.stringify(sourceCommit)},
});
const result = verifyBundledAioncoreResources({
  resourcesDir: path.join(projectRoot, 'resources'),
  electronPlatformName: 'darwin',
  targetArch: 'arm64',
});
if (result.missing.length > 0) {
  throw new Error('missing after repair: ' + result.missing.join(', '));
}
`,
      'utf8'
    );

    const result = spawnSync(process.execPath, ['--require', hookPath, scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Repaired bundled managed resources');
  });

  it('does not reuse a downloaded bundle whose binary and manifest were changed after preparation', () => {
    const projectRoot = join(tmp, 'project');
    const runtimeDir = join(projectRoot, 'resources', 'bundled-aioncore', 'darwin-arm64');
    const archiveSha256 = createHash('sha256').update('pinned archive').digest('hex');
    const tamperedBinary = '#!/usr/bin/env node\nprocess.exit(99);\n';
    const tamperedSha256 = createHash('sha256').update(tamperedBinary).digest('hex');
    const scriptPath = join(tmp, 'prepare-download-tampered-reuse.cjs');

    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'aioncore'), tamperedBinary, { flush: true });
    chmodSync(join(runtimeDir, 'aioncore'), 0o755);
    writeFileSync(
      join(runtimeDir, 'manifest.json'),
      JSON.stringify({
        platform: 'darwin',
        arch: 'arm64',
        version: 'v-test',
        sourceType: 'download',
        source: { url: 'https://example.invalid/aioncore.tar.gz' },
        archiveSha256,
        binarySha256: tamperedSha256,
        preSignBinarySha256: tamperedSha256,
        binarySha256Scope: 'pre-sign-input',
        files: ['aioncore', 'managed-resources/'],
      }),
      { flush: true }
    );

    writeFileSync(
      scriptPath,
      `
const path = require('node:path');
const { prepareAioncore } = require(path.join(${JSON.stringify(repoRoot)}, 'packages/shared-scripts/src/prepare-aioncore.js'));
try {
  prepareAioncore({
    projectRoot: ${JSON.stringify(projectRoot)},
    platform: 'darwin',
    arch: 'arm64',
    version: 'v-test',
    expectedSha256: ${JSON.stringify(archiveSha256)},
  });
} catch {}
`,
      'utf8'
    );

    const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });

    expect(result.stdout).not.toContain('Reusing bundled aioncore');
  });

  itWithPosixExecutable('packages a verified local build without leaking its source path', () => {
    const projectRoot = join(tmp, 'project');
    const localBinary = join(tmp, 'private-build', 'aioncore');
    const sourceCommit = 'a'.repeat(40);
    writeManagedResourceLocalBinary(localBinary);
    const expectedSha256 = createHash('sha256').update(readFileSync(localBinary)).digest('hex');
    writeSourceBuildProvenance(projectRoot, sourceCommit, expectedSha256);
    const scriptPath = join(tmp, 'prepare-local.cjs');
    writeFileSync(
      scriptPath,
      `
const path = require('node:path');
const { prepareAioncore } = require(path.join(${JSON.stringify(repoRoot)}, 'packages/shared-scripts/src/prepare-aioncore.js'));
prepareAioncore({
  projectRoot: ${JSON.stringify(projectRoot)},
  platform: 'darwin',
  arch: 'arm64',
  version: '0.1.37',
  localBinaryPath: ${JSON.stringify(localBinary)},
  expectedSha256: ${JSON.stringify(expectedSha256)},
  sourceCommit: ${JSON.stringify(sourceCommit)},
});
`,
      'utf8'
    );

    const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const manifestPath = join(projectRoot, 'resources', 'bundled-aioncore', 'darwin-arm64', 'manifest.json');
    const manifestText = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      sourceType: 'command-eve-local-build',
      source: { commit: sourceCommit },
      sourceSha256: expectedSha256,
      binarySha256: expectedSha256,
      preSignBinarySha256: expectedSha256,
      binarySha256Scope: 'pre-sign-input',
    });
    expect(manifest).not.toHaveProperty('archiveSha256');
    expect(manifestText).not.toContain(localBinary);
  });

  itWithPosixExecutable(
    'does not reuse a local bundle whose binary and manifest were changed after preparation',
    () => {
      const projectRoot = join(tmp, 'project');
      const localBinary = join(tmp, 'private-build', 'aioncore');
      const sourceCommit = 'a'.repeat(40);
      writeManagedResourceLocalBinary(localBinary);
      const expectedSha256 = createHash('sha256').update(readFileSync(localBinary)).digest('hex');
      writeSourceBuildProvenance(projectRoot, sourceCommit, expectedSha256);
      const scriptPath = join(tmp, 'prepare-local-reuse.cjs');
      writeFileSync(
        scriptPath,
        `
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepareAioncore } = require(path.join(${JSON.stringify(repoRoot)}, 'packages/shared-scripts/src/prepare-aioncore.js'));
const options = {
  projectRoot: ${JSON.stringify(projectRoot)},
  platform: 'darwin',
  arch: 'arm64',
  version: '0.1.37',
  localBinaryPath: ${JSON.stringify(localBinary)},
  expectedSha256: ${JSON.stringify(expectedSha256)},
  sourceCommit: ${JSON.stringify(sourceCommit)},
};
prepareAioncore(options);
const runtimeDir = path.join(options.projectRoot, 'resources', 'bundled-aioncore', 'darwin-arm64');
const targetBinary = path.join(runtimeDir, 'aioncore');
const manifestPath = path.join(runtimeDir, 'manifest.json');
fs.writeFileSync(targetBinary, '#!/usr/bin/env node\\nprocess.exit(99);\\n');
fs.chmodSync(targetBinary, 0o755);
const tamperedSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetBinary)).digest('hex');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.binarySha256 = tamperedSha256;
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
prepareAioncore(options);
const finalSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetBinary)).digest('hex');
if (finalSha256 !== options.expectedSha256) {
  throw new Error('tampered bundle was reused: ' + finalSha256);
}
`,
        'utf8'
      );

      const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).not.toContain('Reusing bundled aioncore');
      const targetBinary = join(projectRoot, 'resources', 'bundled-aioncore', 'darwin-arm64', 'aioncore');
      expect(createHash('sha256').update(readFileSync(targetBinary)).digest('hex')).toBe(expectedSha256);
    }
  );

  it('fails closed when the copied local binary changes before post-copy verification', () => {
    const projectRoot = join(tmp, 'project');
    const localBinary = join(tmp, 'private-build', 'aioncore');
    const sourceCommit = 'a'.repeat(40);
    const hookPath = join(tmp, 'tamper-copy-hook.cjs');
    const scriptPath = join(tmp, 'prepare-local-tampered-copy.cjs');
    writeManagedResourceLocalBinary(localBinary);
    const expectedSha256 = createHash('sha256').update(readFileSync(localBinary)).digest('hex');
    writeSourceBuildProvenance(projectRoot, sourceCommit, expectedSha256);

    writeFileSync(
      hookPath,
      `
const fs = require('node:fs');
const originalCopyFileSync = fs.copyFileSync;
fs.copyFileSync = function patchedCopyFileSync(source, target, ...args) {
  const result = originalCopyFileSync.call(this, source, target, ...args);
  if (fs.realpathSync(source) === fs.realpathSync(${JSON.stringify(localBinary)})) {
    fs.appendFileSync(target, '\\n// tampered after copy\\n');
  }
  return result;
};
`,
      'utf8'
    );
    writeFileSync(
      scriptPath,
      `
const path = require('node:path');
const { prepareAioncore } = require(path.join(${JSON.stringify(repoRoot)}, 'packages/shared-scripts/src/prepare-aioncore.js'));
prepareAioncore({
  projectRoot: ${JSON.stringify(projectRoot)},
  platform: 'darwin',
  arch: 'arm64',
  version: '0.1.37',
  localBinaryPath: ${JSON.stringify(localBinary)},
  expectedSha256: ${JSON.stringify(expectedSha256)},
  sourceCommit: ${JSON.stringify(sourceCommit)},
});
`,
      'utf8'
    );

    const result = spawnSync(process.execPath, ['--require', hookPath, scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('AionCore SHA256 mismatch');
    expect(existsSync(join(projectRoot, 'resources', 'bundled-aioncore', 'darwin-arm64', 'manifest.json'))).toBe(false);
  });
});
