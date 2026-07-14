import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const productIdentity = require('./productIdentity.cjs');
const {
  verifyBundledAioncoreResources,
} = require('../../packages/shared-scripts/src/verify-bundled-aioncore-resources.js');

/**
 * @typedef {(input: { resourcesDir: string, electronPlatformName: string, targetArch: string }) => {
 *   runtimeKey: string,
 *   checked: string[],
 *   missing: string[],
 * }} BundledResourceVerifier
 */

function sha256File(filePath) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function fileReceipt(outDir, relativePath) {
  const absolutePath = path.join(outDir, relativePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;
  return {
    path: relativePath.split(path.sep).join('/'),
    bytes: fs.statSync(absolutePath).size,
    sha256: sha256File(absolutePath),
  };
}

function readDirectories(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function staleAionUiArtifacts(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /aionui/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Inspect one unpacked/NSIS/ZIP Windows x64 candidate without launching it.
 *
 * @param {{
 *   outDir: string,
 *   version: string,
 *   requirePython?: boolean,
 *   verifyBundledResources?: BundledResourceVerifier,
 * }} options
 */
export function inspectWindowsPackage(options) {
  const { outDir, version, requirePython = false, verifyBundledResources = verifyBundledAioncoreResources } = options;
  const errors = [];
  const expected = productIdentity.windowsArtifactNames(version, 'x64');
  const expectedArtifactPaths = [expected.installer, expected.zip, expected.metadata];
  const artifacts = expectedArtifactPaths.flatMap((relativePath) => {
    const receipt = fileReceipt(outDir, relativePath);
    if (!receipt) {
      errors.push(`missing artifact: ${relativePath}`);
      return [];
    }
    return [receipt];
  });

  for (const staleName of staleAionUiArtifacts(outDir)) {
    errors.push(`stale AionUi artifact present: ${staleName}`);
  }

  const unpackedDir = path.join(outDir, productIdentity.WINDOWS_UNPACKED_DIR);
  const resourcesDir = path.join(unpackedDir, 'resources');
  const executablePath = path.join(unpackedDir, productIdentity.WINDOWS_EXECUTABLE_NAME);
  if (!fs.existsSync(executablePath)) {
    errors.push(
      `missing unpacked executable: ${productIdentity.WINDOWS_UNPACKED_DIR}/${productIdentity.WINDOWS_EXECUTABLE_NAME}`
    );
  }
  if (!fs.existsSync(path.join(resourcesDir, 'app.asar'))) {
    errors.push('missing packaged app.asar');
  }

  const nativeModuleRelativePath = path.join(
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node'
  );
  if (!fs.existsSync(path.join(resourcesDir, nativeModuleRelativePath))) {
    errors.push(`missing Electron native module: resources/${nativeModuleRelativePath.split(path.sep).join('/')}`);
  }

  const runtimeRoot = path.join(resourcesDir, 'bundled-aioncore');
  const runtimeKeys = readDirectories(runtimeRoot);
  if (runtimeKeys.length !== 1 || runtimeKeys[0] !== productIdentity.WINDOWS_RUNTIME_KEY) {
    errors.push(
      `expected exactly ${productIdentity.WINDOWS_RUNTIME_KEY} bundled runtime, found ${runtimeKeys.join(', ') || 'none'}`
    );
  }

  let bundledResult = { checked: [], missing: [] };
  try {
    bundledResult = verifyBundledResources({
      resourcesDir,
      electronPlatformName: 'win32',
      targetArch: 'x64',
    });
  } catch (error) {
    errors.push(`bundled resource verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const missingPath of bundledResult.missing) {
    errors.push(`missing bundled resource: ${missingPath}`);
  }

  if (requirePython && !fs.existsSync(path.join(resourcesDir, 'python', 'python.exe'))) {
    errors.push('missing bundled Windows Python: resources/python/python.exe');
  }

  const metadataPath = path.join(outDir, expected.metadata);
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = YAML.parse(fs.readFileSync(metadataPath, 'utf8'));
      const metadataVersion =
        metadata && typeof metadata === 'object' && typeof metadata.version === 'string' ? metadata.version : null;
      if (metadataVersion !== version) {
        errors.push(`latest.yml version mismatch: expected ${version}, got ${metadataVersion || 'missing'}`);
      }
    } catch (error) {
      errors.push(`latest.yml is invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    schema_version: 'command-eve-windows-package-inventory/v1',
    status: errors.length === 0 ? 'PASS' : 'REJECT',
    product_name: productIdentity.PRODUCT_NAME,
    version,
    arch: 'x64',
    artifacts,
    runtime_keys: runtimeKeys,
    bundled_resource_checks: bundledResult.checked,
    errors,
    completion_sentinel: 'WIN_PACKAGE_INVENTORY_COMPLETE',
  };
}

/** @typedef {BundledResourceVerifier} BundledResourceVerifier */
