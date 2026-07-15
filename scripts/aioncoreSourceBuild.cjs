/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_PLATFORMS = Object.freeze([
  'macos-arm64',
  'macos-x64',
  'windows-x64',
  'windows-arm64',
  'linux-x64',
  'linux-arm64',
]);

function assertSingleLine(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string`);
  }
  return value;
}

function resolveCommandEveAioncoreSource(packageJson, platform) {
  const source = packageJson?.commandEveAioncoreSource;
  if (!source || typeof source !== 'object') {
    throw new Error('package.json commandEveAioncoreSource is required');
  }

  const repository = assertSingleLine(source.repository, 'AionCore source repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('AionCore source repository must use owner/repository form');
  }

  const commit = assertSingleLine(source.commit, 'AionCore source commit').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('AionCore source commit must be a full lowercase 40-character SHA');
  }

  const rustToolchain = assertSingleLine(source.rustToolchain, 'AionCore Rust toolchain');
  if (!/^\d+\.\d+\.\d+$/.test(rustToolchain)) {
    throw new Error('AionCore Rust toolchain must be an exact semantic version');
  }

  const targetKeys = Object.keys(source.targets || {}).sort();
  const requiredKeys = [...REQUIRED_PLATFORMS].sort();
  if (JSON.stringify(targetKeys) !== JSON.stringify(requiredKeys)) {
    throw new Error(`AionCore source targets must define exactly: ${requiredKeys.join(', ')}`);
  }

  const target = assertSingleLine(source.targets[platform], `AionCore target for ${platform}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(target)) {
    throw new Error(`AionCore target for ${platform} is malformed`);
  }

  return {
    repository,
    commit,
    rustToolchain,
    target,
    binary: platform.startsWith('windows-') ? 'aioncore.exe' : 'aioncore',
    rustflags: platform.startsWith('windows-') ? '-C target-feature=+crt-static' : '',
  };
}

function readPackageJson(projectRoot = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
}

function appendKeyValue(filePath, key, value) {
  assertSingleLine(key, 'output key');
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    throw new Error(`${key} must be a single-line string`);
  }
  fs.appendFileSync(filePath, `${key}=${value}\n`, 'utf8');
}

function writeWorkflowConfig(config, outputPath) {
  appendKeyValue(outputPath, 'repository', config.repository);
  appendKeyValue(outputPath, 'commit', config.commit);
  appendKeyValue(outputPath, 'rust_toolchain', config.rustToolchain);
  appendKeyValue(outputPath, 'target', config.target);
  appendKeyValue(outputPath, 'binary', config.binary);
  appendKeyValue(outputPath, 'rustflags', config.rustflags);
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readSourceCommit(sourceRoot) {
  return String(execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
}

function bindCommandEveAioncoreBinary(options, deps = {}) {
  const { sourceRoot, environmentFile, config } = options;
  const resolveCommit = deps.readSourceCommit || readSourceCommit;
  const actualCommit = String(resolveCommit(sourceRoot)).trim().toLowerCase();
  if (actualCommit !== config.commit) {
    throw new Error(`AionCore source checkout mismatch: expected ${config.commit}, got ${actualCommit}`);
  }

  const binaryPath = path.resolve(sourceRoot, 'target', config.target, 'release', config.binary);
  if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
    throw new Error(`AionCore source build did not produce ${binaryPath}`);
  }

  const binarySha256 = sha256File(binaryPath);
  appendKeyValue(environmentFile, 'AIONUI_BACKEND_LOCAL_BINARY', binaryPath);
  appendKeyValue(environmentFile, 'AIONUI_BACKEND_SHA256', binarySha256);
  appendKeyValue(environmentFile, 'AIONUI_BACKEND_SOURCE_COMMIT', config.commit);
  return { binaryPath, binarySha256, sourceCommit: config.commit };
}

function runCli(argv = process.argv.slice(2)) {
  const [command, platform, filePath, sourceRoot] = argv;
  const config = resolveCommandEveAioncoreSource(readPackageJson(), platform);
  if (command === 'config') {
    if (!filePath) throw new Error('config requires a GitHub output file path');
    writeWorkflowConfig(config, filePath);
    return;
  }
  if (command === 'bind') {
    if (!filePath || !sourceRoot) throw new Error('bind requires an environment file and source root');
    bindCommandEveAioncoreBinary({ sourceRoot, environmentFile: filePath, config });
    return;
  }
  throw new Error('Usage: aioncoreSourceBuild.cjs <config|bind> <platform> <output-file> [source-root]');
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  REQUIRED_PLATFORMS,
  bindCommandEveAioncoreBinary,
  resolveCommandEveAioncoreSource,
  runCli,
  sha256File,
  writeWorkflowConfig,
};
