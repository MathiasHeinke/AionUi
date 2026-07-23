import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanForPrivateKeys } from './verify-no-private-keys.mjs';

export const PACKAGED_COMMAND_EVE_RESOURCES_VERIFIER_VERSION = 'verify-packaged-command-eve-resources/v1';

export const COMMAND_EVE_PUBLIC_KEY_FILES = Object.freeze([
  'command-eve-license-public-key.pem',
  'command-eve-license-public-key-server.pem',
]);

const MACH_O_ARCH_BY_BUILDER_ARCH = Object.freeze({
  arm64: 'arm64',
  x64: 'x86_64',
});

function assertDirectory(directoryPath, label, deps) {
  let stat;
  try {
    stat = deps.lstat(directoryPath);
  } catch {
    throw new Error(`PACKAGED-RESOURCES: ${label} is missing: ${directoryPath}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`PACKAGED-RESOURCES: ${label} must be a real directory: ${directoryPath}`);
  }
}

function readRequiredRegularFile(filePath, label, deps) {
  let stat;
  try {
    stat = deps.lstat(filePath);
  } catch {
    throw new Error(`PACKAGED-RESOURCES: ${label} is missing: ${filePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`PACKAGED-RESOURCES: ${label} must be a real regular file: ${filePath}`);
  }
  return deps.readFile(filePath);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertPublicKeyPem(bytes, fileName) {
  const text = bytes.toString('utf8');
  if (!text.includes('-----BEGIN PUBLIC KEY-----') || !text.includes('-----END PUBLIC KEY-----')) {
    throw new Error(`PACKAGED-RESOURCES: ${fileName} is not a PUBLIC KEY PEM`);
  }
  if (/-----BEGIN (?:OPENSSH |EC |RSA |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) {
    throw new Error(`PACKAGED-RESOURCES: ${fileName} contains PRIVATE KEY material`);
  }
  try {
    createPublicKey(text);
  } catch {
    throw new Error(`PACKAGED-RESOURCES: ${fileName} is not a parseable public key`);
  }
}

function defaultReadArchitectures(executablePath) {
  const output = execFileSync('/usr/bin/lipo', ['-archs', executablePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.trim().split(/\s+/).filter(Boolean);
}

function normalizeArchitectures(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return [...new Set(entries.map((entry) => String(entry).trim()).filter(Boolean))].sort();
}

/**
 * Verify the release-critical Command EVE resources in a real macOS app bundle.
 *
 * The `resourcesPath` argument deliberately models Electron's packaged
 * `process.resourcesPath`. It must resolve to `<app>/Contents/Resources`; a
 * caller cannot point the verifier at a convenient source directory instead.
 */
export function verifyPackagedCommandEveResources(options, injected = {}) {
  const appPath = path.resolve(String(options?.appPath || ''));
  const sourcePublicDir = path.resolve(String(options?.sourcePublicDir || ''));
  const expectedArch = String(options?.expectedArch || 'arm64');
  const productFilename = String(options?.productFilename || path.basename(appPath, '.app'));
  const expectedMachOArch = MACH_O_ARCH_BY_BUILDER_ARCH[expectedArch];
  if (!expectedMachOArch) {
    throw new Error(`PACKAGED-RESOURCES: unsupported macOS builder architecture: ${expectedArch}`);
  }

  const deps = {
    lstat: injected.lstat || fs.lstatSync,
    readFile: injected.readFile || fs.readFileSync,
    readArchitectures: injected.readArchitectures || defaultReadArchitectures,
    scanPrivateKeys: injected.scanPrivateKeys || scanForPrivateKeys,
  };

  if (!appPath.endsWith('.app')) {
    throw new Error(`PACKAGED-RESOURCES: expected a macOS .app path, received: ${appPath}`);
  }
  assertDirectory(appPath, 'app bundle', deps);
  assertDirectory(sourcePublicDir, 'source public directory', deps);

  const expectedResourcesPath = path.join(appPath, 'Contents', 'Resources');
  const resourcesPath = path.resolve(String(options?.resourcesPath || expectedResourcesPath));
  if (resourcesPath !== expectedResourcesPath) {
    throw new Error(
      `PACKAGED-RESOURCES: resourcesPath must be the packaged Electron path ${expectedResourcesPath}; received ${resourcesPath}`
    );
  }
  assertDirectory(resourcesPath, 'packaged process.resourcesPath', deps);

  const executablePath = path.join(appPath, 'Contents', 'MacOS', productFilename);
  readRequiredRegularFile(executablePath, 'packaged executable', deps);
  const architectures = normalizeArchitectures(deps.readArchitectures(executablePath));
  if (architectures.length !== 1 || architectures[0] !== expectedMachOArch) {
    throw new Error(
      `PACKAGED-RESOURCES: expected a thin ${expectedMachOArch} app executable; found ${architectures.join(', ') || 'none'}`
    );
  }

  const keys = COMMAND_EVE_PUBLIC_KEY_FILES.map((fileName) => {
    const sourcePath = path.join(sourcePublicDir, fileName);
    const packagedPath = path.join(resourcesPath, fileName);
    const sourceBytes = readRequiredRegularFile(sourcePath, `source ${fileName}`, deps);
    const packagedBytes = readRequiredRegularFile(packagedPath, `packaged ${fileName}`, deps);
    assertPublicKeyPem(sourceBytes, fileName);
    assertPublicKeyPem(packagedBytes, fileName);
    if (!sourceBytes.equals(packagedBytes)) {
      throw new Error(`PACKAGED-RESOURCES: packaged ${fileName} is not byte-identical to its source`);
    }
    return {
      file: fileName,
      bytes: packagedBytes.length,
      sha256: sha256(packagedBytes),
      packaged_path: packagedPath,
    };
  });

  const privateKeyFindings = deps.scanPrivateKeys([appPath]);
  if (!Array.isArray(privateKeyFindings)) {
    throw new Error('PACKAGED-RESOURCES: private-key scanner returned an invalid result');
  }
  if (privateKeyFindings.length > 0) {
    const relativeFindings = privateKeyFindings.map((finding) =>
      path.relative(appPath, String(finding?.file || 'unknown'))
    );
    throw new Error(
      `PACKAGED-RESOURCES: PRIVATE KEY material exists in the app bundle: ${relativeFindings.join(', ')}`
    );
  }

  return {
    verifier: PACKAGED_COMMAND_EVE_RESOURCES_VERIFIER_VERSION,
    status: 'PASS',
    app_path: appPath,
    resources_path: resourcesPath,
    resources_path_contract: '<app>/Contents/Resources (Electron process.resourcesPath)',
    builder_arch: expectedArch,
    executable_architectures: architectures,
    keys,
    private_key_findings: 0,
  };
}

function parseCliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unknown positional argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const result = verifyPackagedCommandEveResources({
      appPath: args.app,
      sourcePublicDir: args['source-public-dir'] || path.resolve('public'),
      resourcesPath: args['resources-path'],
      expectedArch: args.arch || 'arm64',
      productFilename: args['product-filename'],
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
