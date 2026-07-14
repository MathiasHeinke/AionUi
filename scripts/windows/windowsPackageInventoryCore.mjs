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

const WINDOWS_X64_PYTHON_ARCHIVE_SHA256 = 'f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316';
const BUNDLED_PYTHON_MANIFEST_FILE = 'command-eve-python-manifest.json';

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

function inspectBundledPython(outDir, resourcesDir, required, errors) {
  const interpreterRelativePath = path.join(productIdentity.WINDOWS_UNPACKED_DIR, 'resources', 'python', 'python.exe');
  const manifestRelativePath = path.join(
    productIdentity.WINDOWS_UNPACKED_DIR,
    'resources',
    'python',
    BUNDLED_PYTHON_MANIFEST_FILE
  );
  const interpreter = fileReceipt(outDir, interpreterRelativePath);
  const manifestReceipt = fileReceipt(outDir, manifestRelativePath);
  let manifest = null;

  if (required && !interpreter) errors.push('missing bundled Windows Python: resources/python/python.exe');
  if (required && !manifestReceipt) {
    errors.push(`missing bundled Python provenance: resources/python/${BUNDLED_PYTHON_MANIFEST_FILE}`);
  }
  if (manifestReceipt) {
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'python', BUNDLED_PYTHON_MANIFEST_FILE), 'utf8'));
      const expected = {
        schema_version: 'command-eve-bundled-python/v1',
        platform: 'win32',
        arch: 'x64',
        triple: 'x86_64-pc-windows-msvc',
        archive_sha256: WINDOWS_X64_PYTHON_ARCHIVE_SHA256,
      };
      for (const [key, value] of Object.entries(expected)) {
        if (manifest?.[key] !== value) {
          errors.push(
            `bundled Python provenance ${key} mismatch: expected ${value}, got ${manifest?.[key] ?? 'missing'}`
          );
        }
      }
    } catch (error) {
      errors.push(
        `bundled Python provenance is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { interpreter, manifest_receipt: manifestReceipt, manifest };
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

  const bundledPython = inspectBundledPython(outDir, resourcesDir, requirePython, errors);

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
    bundled_python: bundledPython,
    errors,
    completion_sentinel: 'WIN_PACKAGE_INVENTORY_COMPLETE',
  };
}

/** @typedef {BundledResourceVerifier} BundledResourceVerifier */
