#!/usr/bin/env node
/**
 * Build-time, network-free staging for Command EVE's common document runtime.
 *
 * Exact reviewed wheels are extracted into the already verified bundled CPython
 * tree. electron-builder copies that tree into Resources/python and the existing
 * afterSign hook deep-signs every native .so/.dylib before notarization. Runtime
 * bootstrap then exposes only this signed directory to the private Hermes venv.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import yauzl from 'yauzl';

export const COMMAND_EVE_ARTIFACT_PYTHON_BUILD_VERSION = 'command-eve-artifact-python-build/v1';
export const COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION = 'command-eve-artifact-python-runtime/v1';
export const COMMAND_EVE_ARTIFACT_SITE_PACKAGES_DIR = 'artifact-site-packages';
export const COMMAND_EVE_ARTIFACT_RUNTIME_RECEIPT = 'command-eve-artifact-python-runtime.json';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'resources', 'bundled-python-artifacts', 'manifest.json');
const DEFAULT_PYTHON_ROOT = path.join(REPO_ROOT, 'build', 'bundled-python', 'python');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NATIVE_ENTRY_PATTERN = /\.(?:so|dylib|dll|pyd)$/i;
const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeDistributionName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

function comparePythonVersions(left, right) {
  const leftParts = String(left)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function markerIsActive(marker, runtimeKey, pythonVersion) {
  const normalized = String(marker || '').trim();
  if (!normalized) return true;
  // Optional extras are deliberately not enabled in the baseline artifact pack.
  if (/\bextra\b/.test(normalized)) return false;

  const sysPlatform = normalized.match(/^sys_platform\s*==\s*["']([^"']+)["']$/);
  if (sysPlatform) {
    const targetPlatform = runtimeKey.startsWith('win32-') ? 'win32' : runtimeKey.startsWith('darwin-') ? 'darwin' : '';
    return targetPlatform === sysPlatform[1];
  }

  const pythonMarker = normalized.match(/^python_version\s*(<=|>=|==|!=|<|>)\s*["']([^"']+)["']$/);
  if (pythonMarker) {
    const comparison = comparePythonVersions(pythonVersion, pythonMarker[2]);
    return {
      '<': comparison < 0,
      '<=': comparison <= 0,
      '==': comparison === 0,
      '!=': comparison !== 0,
      '>=': comparison >= 0,
      '>': comparison > 0,
    }[pythonMarker[1]];
  }

  throw new Error(`Unsupported Artifact Python dependency marker: ${normalized}`);
}

function activeRuntimeRequirements(metadata, runtimeKey, pythonVersion) {
  const required = [];
  for (const match of String(metadata || '').matchAll(/^Requires-Dist:\s*(.+)$/gm)) {
    const [requirement, marker = ''] = match[1].trim().split(/\s*;\s*/, 2);
    if (!markerIsActive(marker, runtimeKey, pythonVersion)) continue;
    const dependencyName = requirement.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
    if (!dependencyName) throw new Error(`Invalid Artifact Python dependency declaration: ${match[1]}`);
    required.push(dependencyName);
  }
  return required;
}

export function assertRuntimeDependencyClosure(installed, runtimeKey, pythonVersion) {
  for (const distribution of installed.values()) {
    for (const dependencyName of activeRuntimeRequirements(distribution.metadata, runtimeKey, pythonVersion)) {
      if (!installed.has(normalizeDistributionName(dependencyName))) {
        throw new Error(
          `Artifact Python dependency closure is incomplete for ${distribution.name}: missing ${dependencyName} on ${runtimeKey}.`
        );
      }
    }
  }
}

function parseArgs(argv) {
  let platform = process.env.BUNDLED_PYTHON_PLATFORM || 'darwin';
  let arch = process.env.BUNDLED_PYTHON_ARCH || 'arm64';
  let manifestPath = DEFAULT_MANIFEST;
  let pythonRoot = DEFAULT_PYTHON_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--platform') platform = argv[++index] || platform;
    else if (arg === '--arch') arch = argv[++index] || arch;
    else if (arg === '--manifest') manifestPath = path.resolve(argv[++index] || manifestPath);
    else if (arg === '--python-root') pythonRoot = path.resolve(argv[++index] || pythonRoot);
  }
  return { platform, arch, manifestPath, pythonRoot };
}

function assertRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
}

function assertDirectory(directoryPath, label) {
  const stat = fs.lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real non-symlink directory: ${directoryPath}`);
  }
}

export function readBuildManifest(manifestPath) {
  assertRegularFile(manifestPath, 'Artifact Python manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    manifest?.version !== COMMAND_EVE_ARTIFACT_PYTHON_BUILD_VERSION ||
    manifest?.runtime_version !== COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION ||
    manifest?.network_install_allowed !== false ||
    typeof manifest?.python_version !== 'string' ||
    typeof manifest?.common_root !== 'string' ||
    !Array.isArray(manifest?.common_packages) ||
    !manifest?.platforms ||
    typeof manifest.platforms !== 'object'
  ) {
    throw new Error('Artifact Python manifest violates the fail-closed build contract.');
  }
  return manifest;
}

function assertPackageEntry(entry, label) {
  if (
    !entry ||
    typeof entry.name !== 'string' ||
    typeof entry.version !== 'string' ||
    typeof entry.import_name !== 'string' ||
    typeof entry.filename !== 'string' ||
    !entry.filename.endsWith('.whl') ||
    typeof entry.sha256 !== 'string' ||
    !SHA256_PATTERN.test(entry.sha256) ||
    typeof entry.license !== 'string'
  ) {
    throw new Error(`Invalid ${label} package entry.`);
  }
}

export function resolvePackageSources({ manifestPath, manifest, platform, arch }) {
  const runtimeKey = `${platform}-${arch}`;
  const platformPackages = manifest.platforms[runtimeKey];
  if (!Array.isArray(platformPackages)) throw new Error(`No pinned Artifact Python package set for ${runtimeKey}.`);
  const manifestDirectory = path.dirname(manifestPath);
  const commonRoot = path.resolve(manifestDirectory, manifest.common_root);
  const platformRoot = path.join(manifestDirectory, runtimeKey);
  assertDirectory(commonRoot, 'Artifact Python common wheel directory');
  assertDirectory(platformRoot, `Artifact Python ${runtimeKey} wheel directory`);

  const packages = [
    ...manifest.common_packages.map((entry) => ({ ...entry, root: commonRoot, scope: 'common' })),
    ...platformPackages.map((entry) => ({ ...entry, root: platformRoot, scope: runtimeKey })),
  ];
  const names = new Set();
  for (const entry of packages) {
    assertPackageEntry(entry, entry.scope);
    const normalizedName = normalizeDistributionName(entry.name);
    if (names.has(normalizedName)) throw new Error(`Duplicate Artifact Python distribution: ${entry.name}`);
    names.add(normalizedName);
    const wheelPath = path.join(entry.root, entry.filename);
    assertRegularFile(wheelPath, `Artifact Python wheel ${entry.filename}`);
    const actualSha256 = sha256File(wheelPath);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`Artifact Python wheel hash mismatch for ${entry.filename}: ${actualSha256}`);
    }
    entry.wheelPath = wheelPath;
  }
  return { runtimeKey, packages };
}

export function safeWheelEntryPath(rawName) {
  if (
    !rawName ||
    rawName.includes('\0') ||
    rawName.includes('\\') ||
    rawName.startsWith('/') ||
    rawName.startsWith('//') ||
    /^[A-Za-z]:/.test(rawName) ||
    rawName.includes(':')
  ) {
    throw new Error(`Unsafe wheel entry path: ${JSON.stringify(rawName)}`);
  }
  const parts = rawName.split('/').filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((part) => {
      const baseName = part.split('.')[0].toLowerCase();
      return (
        part === '.' ||
        part === '..' ||
        part.endsWith(' ') ||
        part.endsWith('.') ||
        WINDOWS_RESERVED_BASENAMES.has(baseName)
      );
    })
  ) {
    throw new Error(`Unsafe wheel entry path: ${JSON.stringify(rawName)}`);
  }
  return parts.join(path.sep);
}

function portableWheelPathKey(rawName) {
  return safeWheelEntryPath(rawName).split(path.sep).join('/').normalize('NFC').toLocaleLowerCase('en-US');
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else if (character === '"') quoted = true;
    else field += character;
  }
  if (quoted) throw new Error(`Invalid unterminated CSV field in wheel RECORD: ${line}`);
  fields.push(field);
  return fields;
}

function readWheelArchive(wheelPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(wheelPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error(`Unable to open wheel: ${wheelPath}`));
        return;
      }
      const entries = [];
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          zip.close();
        } catch {
          // best effort
        }
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(entries);
      });
      zip.on('entry', (entry) => {
        try {
          safeWheelEntryPath(entry.fileName);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const fileType = unixMode & 0o170000;
          const isDirectory = entry.fileName.endsWith('/');
          if (fileType && fileType !== 0o100000 && fileType !== 0o040000) {
            throw new Error(`Wheel contains a non-regular archive entry: ${entry.fileName}`);
          }
          if (isDirectory) {
            entries.push({ name: entry.fileName, bytes: null, unixMode, isDirectory: true });
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError || new Error(`Unable to read wheel entry: ${entry.fileName}`));
              return;
            }
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            stream.on('error', fail);
            stream.on('end', () => {
              const bytes = Buffer.concat(chunks);
              if (bytes.length !== entry.uncompressedSize) {
                fail(new Error(`Wheel entry size mismatch: ${entry.fileName}`));
                return;
              }
              entries.push({ name: entry.fileName, bytes, unixMode, isDirectory: false });
              zip.readEntry();
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  });
}

function assertPortableArchiveLayout(entries, wheelName) {
  const files = new Map();
  const directories = new Set();
  for (const entry of entries) {
    const key = portableWheelPathKey(entry.name);
    const parts = key.split('/');
    const parentKeys = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    if (entry.isDirectory) {
      if (files.has(key)) throw new Error(`Wheel path collides as file and directory in ${wheelName}: ${entry.name}`);
      directories.add(key);
      continue;
    }
    if (files.has(key)) {
      throw new Error(`Wheel contains a casefold/NFC path collision in ${wheelName}: ${entry.name}`);
    }
    if (directories.has(key) || parentKeys.some((parent) => files.has(parent))) {
      throw new Error(`Wheel path collides as file and directory in ${wheelName}: ${entry.name}`);
    }
    files.set(key, entry.name);
    for (const parent of parentKeys) directories.add(parent);
  }
  return { files, directories };
}

function parseWheelRecord(recordText) {
  const records = new Map();
  for (const line of String(recordText || '').split(/\r?\n/)) {
    if (!line) continue;
    const [recordPath, hash = '', size = ''] = parseCsvLine(line);
    const key = portableWheelPathKey(recordPath);
    if (records.has(key)) throw new Error(`Wheel RECORD contains duplicate path: ${recordPath}`);
    records.set(key, { path: recordPath, hash, size });
  }
  return records;
}

function verifyRecordEntry(entry, record, wheelName) {
  if (!record) throw new Error(`Wheel RECORD is missing archive file ${entry.name} in ${wheelName}`);
  const isRecordSignature = /\/RECORD\.(?:jws|p7s)$/.test(entry.name);
  const isRecord = /\/RECORD$/.test(entry.name);
  if (isRecord || isRecordSignature) return;
  if (!record.hash.startsWith('sha256=')) {
    throw new Error(`Wheel RECORD must use sha256 for ${entry.name} in ${wheelName}`);
  }
  const expectedDigest = Buffer.from(record.hash.slice('sha256='.length), 'base64url');
  const actualDigest = crypto.createHash('sha256').update(entry.bytes).digest();
  if (expectedDigest.length !== actualDigest.length || !crypto.timingSafeEqual(expectedDigest, actualDigest)) {
    throw new Error(`Wheel RECORD hash mismatch for ${entry.name} in ${wheelName}`);
  }
  if (!/^\d+$/.test(record.size) || Number(record.size) !== entry.bytes.length) {
    throw new Error(`Wheel RECORD size mismatch for ${entry.name} in ${wheelName}`);
  }
}

export async function inspectWheel(entry) {
  const entries = await readWheelArchive(entry.wheelPath);
  const layout = assertPortableArchiveLayout(entries, entry.filename);
  const files = entries.filter((candidate) => !candidate.isDirectory);
  for (const candidate of files) {
    const parts = candidate.name.split('/');
    if (!parts[0].endsWith('.data')) continue;
    if (!['purelib', 'platlib', 'scripts'].includes(parts[1]) || parts.length < 3) {
      throw new Error(`Wheel .data scheme is unsupported for the signed Artifact Python pack: ${candidate.name}`);
    }
  }
  const metadataEntries = files.filter((candidate) => /\.dist-info\/METADATA$/.test(candidate.name));
  const wheelEntries = files.filter((candidate) => /\.dist-info\/WHEEL$/.test(candidate.name));
  const recordEntries = files.filter((candidate) => /\.dist-info\/RECORD$/.test(candidate.name));
  if (metadataEntries.length !== 1 || wheelEntries.length !== 1 || recordEntries.length !== 1) {
    throw new Error(`Wheel metadata set must contain exactly one METADATA, WHEEL and RECORD: ${entry.filename}`);
  }
  const distInfoPrefix = metadataEntries[0].name.slice(0, -'METADATA'.length);
  if (!wheelEntries[0].name.startsWith(distInfoPrefix) || !recordEntries[0].name.startsWith(distInfoPrefix)) {
    throw new Error(`Wheel metadata files disagree on dist-info root: ${entry.filename}`);
  }
  const metadata = metadataEntries[0].bytes.toString('utf8');
  const metadataName = metadata.match(/^Name:\s*(.+)$/m)?.[1]?.trim();
  const metadataVersion = metadata.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
  if (
    normalizeDistributionName(metadataName) !== normalizeDistributionName(entry.name) ||
    metadataVersion !== entry.version
  ) {
    throw new Error(`Wheel core metadata mismatch for ${entry.filename}`);
  }
  const wheelMetadata = wheelEntries[0].bytes.toString('utf8');
  const [pythonTag, abiTag, platformTag] = entry.filename
    .replace(/\.whl$/, '')
    .split('-')
    .slice(-3);
  const filenameTags = new Set(
    pythonTag
      .split('.')
      .flatMap((python) =>
        abiTag.split('.').flatMap((abi) => platformTag.split('.').map((platform) => `${python}-${abi}-${platform}`))
      )
  );
  const declaredTags = [...wheelMetadata.matchAll(/^Tag:\s*(.+)$/gm)].map((match) => match[1].trim());
  if (
    declaredTags.length === 0 ||
    declaredTags.some((tag) => !filenameTags.has(tag)) ||
    [...filenameTags].some((tag) => !declaredTags.includes(tag))
  ) {
    throw new Error(`Wheel tag mismatch for ${entry.filename}: expected ${[...filenameTags].join(', ')}`);
  }
  const records = parseWheelRecord(recordEntries[0].bytes.toString('utf8'));
  for (const file of files) verifyRecordEntry(file, records.get(portableWheelPathKey(file.name)), entry.filename);
  for (const record of records.values()) {
    if (!layout.files.has(portableWheelPathKey(record.path))) {
      throw new Error(`Wheel RECORD names a missing archive file ${record.path} in ${entry.filename}`);
    }
  }
  return {
    entries,
    filePaths: files.map((file) => file.name),
    metadataSha256: crypto.createHash('sha256').update(metadataEntries[0].bytes).digest('hex'),
    tags: declaredTags,
  };
}

function logicalWheelOutputKey(rawName, platform) {
  const parts = rawName.split('/').filter(Boolean);
  if (!parts[0]?.endsWith('.data')) return `site/${portableWheelPathKey(rawName)}`;
  const scheme = parts[1];
  const remainder = portableWheelPathKey(parts.slice(2).join('/'));
  if (scheme === 'purelib' || scheme === 'platlib') return `site/${remainder}`;
  if (scheme === 'scripts') return `python/${platform === 'win32' ? 'scripts' : 'bin'}/${remainder}`;
  throw new Error(`Unsupported wheel .data scheme: ${scheme}`);
}

export function assertCombinedWheelLayout(packages, platform) {
  const files = new Map();
  const directories = new Set();
  for (const entry of packages) {
    for (const rawName of entry.wheelInspection.filePaths) {
      const key = logicalWheelOutputKey(rawName, platform);
      const parts = key.split('/');
      const parentKeys = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
      if (files.has(key)) {
        throw new Error(`Artifact Python wheels collide at ${rawName}: ${files.get(key)} and ${entry.filename}`);
      }
      if (directories.has(key) || parentKeys.some((parent) => files.has(parent))) {
        throw new Error(`Artifact Python wheel file/directory collision at ${rawName}`);
      }
      files.set(key, entry.filename);
      for (const parent of parentKeys) directories.add(parent);
    }
  }
}

function resolveWheelOutput(rawName, targetDirectory, pythonRoot, platform) {
  const parts = rawName.split('/').filter(Boolean);
  if (!parts[0]?.endsWith('.data')) {
    return { outputPath: path.join(targetDirectory, safeWheelEntryPath(rawName)), spread: false };
  }
  const scheme = parts[1];
  const remainder = safeWheelEntryPath(parts.slice(2).join('/'));
  if (scheme === 'purelib' || scheme === 'platlib') {
    return { outputPath: path.join(targetDirectory, remainder), spread: false };
  }
  if (scheme === 'scripts') {
    const scriptsDirectory = platform === 'win32' ? path.join(pythonRoot, 'Scripts') : path.join(pythonRoot, 'bin');
    return { outputPath: path.join(scriptsDirectory, remainder), spread: true };
  }
  throw new Error(`Unsupported wheel .data scheme: ${scheme}`);
}

export function extractWheel(wheelPath, targetDirectory, pythonRoot, platform, spreadFiles) {
  return new Promise((resolve, reject) => {
    yauzl.open(wheelPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error(`Unable to open wheel: ${wheelPath}`));
        return;
      }
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          zip.close();
        } catch {
          // best effort
        }
        reject(error);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on('entry', (entry) => {
        try {
          const relative = safeWheelEntryPath(entry.fileName);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((unixMode & 0o170000) === 0o120000) throw new Error(`Wheel contains a symbolic link: ${entry.fileName}`);
          const resolvedTarget = resolveWheelOutput(entry.fileName, targetDirectory, pythonRoot, platform);
          const outputPath = resolvedTarget.outputPath;
          const resolvedOutput = path.resolve(outputPath);
          const relativeToPython = path.relative(path.resolve(pythonRoot), resolvedOutput);
          if (relativeToPython.startsWith('..') || path.isAbsolute(relativeToPython)) {
            throw new Error(`Wheel entry escapes the artifact runtime: ${entry.fileName}`);
          }
          if (entry.fileName.endsWith('/')) {
            fs.mkdirSync(resolvedOutput, { recursive: true, mode: 0o755 });
            zip.readEntry();
            return;
          }
          fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true, mode: 0o755 });
          if (fs.existsSync(resolvedOutput)) throw new Error(`Duplicate Artifact Python path: ${relative}`);
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError || new Error(`Unable to read wheel entry: ${entry.fileName}`));
              return;
            }
            const output = fs.createWriteStream(resolvedOutput, { flags: 'wx', mode: 0o644 });
            stream.on('error', fail);
            output.on('error', fail);
            output.on('finish', () => {
              fs.chmodSync(resolvedOutput, 0o644);
              if (resolvedTarget.spread) spreadFiles.add(relativeToPython);
              zip.readEntry();
            });
            stream.pipe(output);
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  });
}

function readInstalledDistributions(targetDirectory) {
  const found = new Map();
  for (const entry of fs.readdirSync(targetDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue;
    const metadataPath = path.join(targetDirectory, entry.name, 'METADATA');
    assertRegularFile(metadataPath, `Installed metadata ${entry.name}`);
    const metadata = fs.readFileSync(metadataPath, 'utf8');
    const name = metadata.match(/^Name:\s*(.+)$/m)?.[1]?.trim();
    const version = metadata.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
    if (!name || !version) throw new Error(`Incomplete installed metadata: ${metadataPath}`);
    const normalizedName = normalizeDistributionName(name);
    if (found.has(normalizedName)) throw new Error(`Duplicate installed distribution metadata: ${name}`);
    found.set(normalizedName, { name, version, metadataPath, metadata });
  }
  return found;
}

function resolveInterpreter(pythonRoot, platform) {
  return platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', 'python3.12');
}

function canExecuteTarget(platform, arch) {
  const hostArch = process.arch === 'x64' ? 'x64' : process.arch;
  return process.platform === platform && hostArch === arch;
}

function sanitizePythonEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key, value]) => value !== undefined && !key.toUpperCase().startsWith('PYTHON'))
  );
}

function artifactPythonProbeSource(packages, targetDirectory) {
  const packageSpecs = packages.map((entry) => ({
    distribution: entry.name,
    version: entry.version,
    module: entry.import_name,
  }));
  return `
import importlib
from importlib.metadata import version
from pathlib import Path
import sys

ARTIFACT_ROOT = Path(${JSON.stringify(targetDirectory)}).resolve(strict=True)
PACKAGE_SPECS = ${JSON.stringify(packageSpecs)}

assert sys.flags.isolated == 1
assert sys.flags.safe_path == 1
assert sys.flags.no_user_site == 1
assert sys.flags.ignore_environment == 1

# -S keeps every .pth/sitecustomize hook out of the trust boundary. The signed
# artifact root is inserted explicitly; stdlib paths remain available behind it.
sys.path.insert(0, str(ARTIFACT_ROOT))

def assert_artifact_origin(module_name):
    module = importlib.import_module(module_name)
    origin = getattr(getattr(module, "__spec__", None), "origin", None) or getattr(module, "__file__", None)
    assert origin not in (None, "built-in", "frozen"), f"missing origin for {module_name}: {origin}"
    resolved = Path(origin).resolve(strict=True)
    assert resolved == ARTIFACT_ROOT or ARTIFACT_ROOT in resolved.parents, f"untrusted origin for {module_name}: {resolved}"
    return module

for spec in PACKAGE_SPECS:
    assert version(spec["distribution"]) == spec["version"]
    assert_artifact_origin(spec["module"])

for native_module in ("lxml.etree", "lxml.objectify", "PIL._imaging"):
    assert_artifact_origin(native_module)

from PIL import __version__ as pillow_version
from openpyxl import DEFUSEDXML
assert pillow_version == "12.3.0"
assert DEFUSEDXML is True
print("ARTIFACT_PYTHON_READY")
`;
}

function removePreviouslySpreadFiles(targetDirectory, pythonRoot) {
  const receiptPath = path.join(targetDirectory, COMMAND_EVE_ARTIFACT_RUNTIME_RECEIPT);
  if (!fs.existsSync(receiptPath)) return;
  assertRegularFile(receiptPath, 'Previous Artifact Python receipt');
  const previousReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (previousReceipt.spread_files === undefined) return;
  if (!Array.isArray(previousReceipt.spread_files)) {
    throw new Error('Previous Artifact Python spread-file receipt is invalid.');
  }
  for (const entry of previousReceipt.spread_files) {
    const relativePath = safeWheelEntryPath(
      String(entry?.path || '')
        .split(path.sep)
        .join('/')
    );
    const target = path.resolve(pythonRoot, relativePath);
    const relativeToPython = path.relative(pythonRoot, target);
    if (relativeToPython.startsWith('..') || path.isAbsolute(relativeToPython)) {
      throw new Error(`Previous Artifact Python spread file escaped the runtime: ${relativePath}`);
    }
    if (!fs.existsSync(target)) continue;
    assertRegularFile(target, 'Previous Artifact Python spread file');
    fs.rmSync(target);
  }
}

// ---------------------------------------------------------------------------
// Pro-verdict Gate 1 / P2-2: SBOM + THIRD_PARTY_NOTICES from the final tree
// ---------------------------------------------------------------------------

const COMMAND_EVE_ARTIFACT_SBOM_FILE = 'sbom.cyclonedx.json';
const COMMAND_EVE_ARTIFACT_NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
const LICENSE_FILE_PATTERN = /(?:^|\/)(?:licenses?\/)?(?:licen[cs]e|copying|notice)(?:\.[^/]*)?$/i;

// Collect every license/notice payload shipped inside the staged dist-info
// directories. Wheels express these either as top-level dist-info/LICENSE or
// as PEP-639 dist-info/licenses/** trees; both are first-party license truth.
function collectDistInfoLicenseFiles(targetDirectory) {
  const results = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Compliance scan found a symlink: ${target}`);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(targetDirectory, target).split(path.sep).join('/');
      if (!relativePath.includes('.dist-info/')) continue;
      if (!LICENSE_FILE_PATTERN.test(relativePath)) continue;
      results.push({
        path: relativePath,
        distInfo: relativePath.split('/').find((part) => part.endsWith('.dist-info')) || '',
        text: fs.readFileSync(target, 'utf8'),
      });
    }
  };
  visit(targetDirectory);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

// Merge PEP-770 wheel SBOMs (e.g. Pillow 12.3 ships pillow-<v>.cdx.json
// covering its bundled native codecs) as nested components of the owning
// distribution so the aggregate SBOM names every embedded native library.
function collectWheelSbomComponents(targetDirectory, packages) {
  const byDistInfo = new Map();
  for (const entry of packages) {
    const distInfoDir = `${String(entry.name).replaceAll('-', '_')}-${entry.version}.dist-info`;
    byDistInfo.set(distInfoDir.toLowerCase(), entry);
  }
  const embedded = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`SBOM scan found a symlink: ${target}`);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.cdx.json')) continue;
      const relativePath = path.relative(targetDirectory, target).split(path.sep).join('/');
      const distInfo = relativePath.split('/').find((part) => part.endsWith('.dist-info')) || '';
      const owner = byDistInfo.get(distInfo.toLowerCase());
      if (!owner) throw new Error(`Wheel SBOM without owning distribution: ${relativePath}`);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      } catch (error) {
        throw new Error(`Wheel SBOM is not valid JSON (${relativePath}): ${error.message}`);
      }
      const components = Array.isArray(parsed?.components) ? parsed.components : [];
      for (const component of components) {
        embedded.push({
          owner: owner.name,
          sbom_path: relativePath,
          type: String(component?.type || 'library'),
          name: String(component?.name || ''),
          version: component?.version == null ? '' : String(component.version),
          licenses: (Array.isArray(component?.licenses) ? component.licenses : [])
            .map((license) => license?.license?.id || license?.license?.name || license?.expression || '')
            .filter(Boolean),
        });
      }
    }
  };
  visit(targetDirectory);
  return embedded.sort(
    (left, right) =>
      left.owner.localeCompare(right.owner) ||
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version)
  );
}

function writeArtifactComplianceFiles({ targetDirectory, packages, manifest }) {
  const licenseFiles = collectDistInfoLicenseFiles(targetDirectory);
  const embeddedComponents = collectWheelSbomComponents(targetDirectory, packages);

  // Every staged distribution must carry at least one license payload;
  // otherwise the notices file would silently under-declare a shipped package.
  for (const entry of packages) {
    const distInfoPrefix = `${String(entry.name).replaceAll('-', '_')}-${entry.version}.dist-info/`;
    const hasLicense = licenseFiles.some(
      (file) => file.path.startsWith(distInfoPrefix) || file.path.toLowerCase().startsWith(distInfoPrefix.toLowerCase())
    );
    if (!hasLicense) {
      throw new Error(`Distribution ${entry.name}@${entry.version} ships no license file in its dist-info tree.`);
    }
  }

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: 'command-eve-artifact-python',
        version: manifest.python_version,
        description: 'Command EVE signed document-runtime Python artifact tree',
      },
    },
    components: packages.map((entry) => ({
      type: 'library',
      'bom-ref': `pkg:pypi/${entry.name}@${entry.version}`,
      purl: `pkg:pypi/${entry.name}@${entry.version}`,
      name: entry.name,
      version: entry.version,
      licenses: [{ license: { name: entry.license } }],
      hashes: [{ alg: 'SHA-256', content: entry.sha256 }],
      properties: [{ name: 'command-eve:wheel', value: entry.filename }],
    })),
    dependencies: [],
    'x-command-eve-embedded-components': embeddedComponents,
  };

  const noticesSections = [];
  noticesSections.push(
    [
      'THIRD-PARTY NOTICES — Command EVE document runtime',
      '',
      'This artifact tree ships the Python distributions listed below. Each',
      'section names the distribution, its pinned version, its declared license',
      'and the full license/notice text exactly as shipped inside the signed',
      'tree. Embedded native components (bundled shared libraries inside wheels)',
      'are listed in sbom.cyclonedx.json under x-command-eve-embedded-components.',
      '',
    ].join('\n')
  );
  for (const entry of packages) {
    const matching = licenseFiles.filter((file) =>
      file.path.toLowerCase().startsWith(`${String(entry.name).replaceAll('-', '_')}-${entry.version}.dist-info/`.toLowerCase())
    );
    noticesSections.push(
      [
        '='.repeat(72),
        `${entry.name} ${entry.version}`,
        `License: ${entry.license}`,
        `Wheel: ${entry.filename}`,
        `SHA-256: ${entry.sha256}`,
        '='.repeat(72),
        '',
        ...matching.flatMap((file) => [`--- ${file.path} ---`, '', file.text.trim(), '']),
      ].join('\n')
    );
  }

  const sbomPath = path.join(targetDirectory, COMMAND_EVE_ARTIFACT_SBOM_FILE);
  const noticesPath = path.join(targetDirectory, COMMAND_EVE_ARTIFACT_NOTICES_FILE);
  fs.writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  fs.writeFileSync(noticesPath, `${noticesSections.join('\n')}\n`, { encoding: 'utf8', mode: 0o644 });

  return {
    sbom: { path: COMMAND_EVE_ARTIFACT_SBOM_FILE, sha256: sha256File(sbomPath) },
    notices: { path: COMMAND_EVE_ARTIFACT_NOTICES_FILE, sha256: sha256File(noticesPath) },
    embedded_components: embeddedComponents.length,
    license_files: licenseFiles.length,
  };
}

function collectArtifactTreeFiles(targetDirectory, pythonRoot, spreadFiles) {
  const receiptPath = path.join(targetDirectory, COMMAND_EVE_ARTIFACT_RUNTIME_RECEIPT);
  const collected = [];
  const addFile = (root, relativePath, filePath) => {
    assertRegularFile(filePath, `Artifact Python tree file ${relativePath}`);
    const stat = fs.statSync(filePath);
    collected.push({
      root,
      path: relativePath.split(path.sep).join('/'),
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: sha256File(filePath),
    });
  };
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact Python extraction produced a symlink: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && target !== receiptPath) {
        addFile('artifact-site', path.relative(targetDirectory, target), target);
      } else if (!entry.isFile()) {
        throw new Error(`Artifact Python extraction produced a special file: ${target}`);
      }
    }
  };
  visit(targetDirectory);
  for (const relativePath of [...spreadFiles].sort()) {
    const target = path.resolve(pythonRoot, relativePath);
    const relativeToPython = path.relative(pythonRoot, target);
    if (relativeToPython.startsWith('..') || path.isAbsolute(relativeToPython)) {
      throw new Error(`Artifact Python spread file escaped the runtime: ${relativePath}`);
    }
    addFile('python-root', relativeToPython, target);
  }
  collected.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
  const rootSha256 = crypto.createHash('sha256').update(JSON.stringify(collected)).digest('hex');
  return { files: collected, rootSha256 };
}

export async function stageBundledArtifactPython(options) {
  const manifestPath = path.resolve(options.manifestPath);
  const pythonRoot = path.resolve(options.pythonRoot);
  assertDirectory(pythonRoot, 'Bundled Python root');
  const pythonManifestPath = path.join(pythonRoot, 'command-eve-python-manifest.json');
  assertRegularFile(pythonManifestPath, 'Bundled Python provenance manifest');
  const pythonManifest = JSON.parse(fs.readFileSync(pythonManifestPath, 'utf8'));
  const manifest = readBuildManifest(manifestPath);
  if (pythonManifest?.python_version !== manifest.python_version) {
    throw new Error(
      `Artifact Python requires CPython ${manifest.python_version}; bundled runtime is ${pythonManifest?.python_version || 'unknown'}.`
    );
  }

  const { runtimeKey, packages } = resolvePackageSources({
    manifestPath,
    manifest,
    platform: options.platform,
    arch: options.arch,
  });
  for (const entry of packages) {
    // Sequential verification keeps the exact failing wheel visible and bounds peak memory.
    // eslint-disable-next-line no-await-in-loop
    entry.wheelInspection = await inspectWheel(entry);
  }
  assertCombinedWheelLayout(packages, options.platform);
  const targetDirectory = path.join(pythonRoot, COMMAND_EVE_ARTIFACT_SITE_PACKAGES_DIR);
  if (path.dirname(targetDirectory) !== pythonRoot)
    throw new Error('Artifact Python target escaped the bundled runtime.');
  removePreviouslySpreadFiles(targetDirectory, pythonRoot);
  fs.rmSync(targetDirectory, { recursive: true, force: true });
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o755 });

  const spreadFiles = new Set();
  for (const entry of packages) {
    // Sequential extraction keeps duplicate-path and failure reporting deterministic.
    // eslint-disable-next-line no-await-in-loop
    await extractWheel(entry.wheelPath, targetDirectory, pythonRoot, options.platform, spreadFiles);
  }

  const installed = readInstalledDistributions(targetDirectory);
  for (const entry of packages) {
    const actual = installed.get(normalizeDistributionName(entry.name));
    if (!actual || actual.version !== entry.version) {
      throw new Error(`Installed Artifact Python metadata mismatch for ${entry.name}@${entry.version}.`);
    }
  }
  assertRuntimeDependencyClosure(installed, runtimeKey, manifest.python_version);

  let probeStatus = 'deferred_to_target';
  if (canExecuteTarget(options.platform, options.arch)) {
    const interpreter = resolveInterpreter(pythonRoot, options.platform);
    assertRegularFile(interpreter, 'Bundled Python interpreter');
    const probeCwd = path.join(pythonRoot, '.command-eve-artifact-probe-cwd');
    fs.rmSync(probeCwd, { recursive: true, force: true });
    fs.mkdirSync(probeCwd, { recursive: false, mode: 0o700 });
    const probe = spawnSync(
      interpreter,
      ['-I', '-P', '-S', '-c', artifactPythonProbeSource(packages, targetDirectory)],
      {
        cwd: probeCwd,
        encoding: 'utf8',
        env: { ...sanitizePythonEnvironment(), PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    fs.rmSync(probeCwd, { recursive: true, force: true });
    if (probe.status !== 0 || !String(probe.stdout || '').includes('ARTIFACT_PYTHON_READY')) {
      throw new Error(`Artifact Python import probe failed: ${String(probe.stderr || probe.stdout || '').trim()}`);
    }
    probeStatus = 'pass';
  }

  const nativeFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact Python extraction produced a symlink: ${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && NATIVE_ENTRY_PATTERN.test(entry.name))
        nativeFiles.push(path.relative(targetDirectory, target));
    }
  };
  visit(targetDirectory);

  // Pro-verdict Gate 1 / P2-2: emit the machine-readable SBOM and the
  // human-readable THIRD_PARTY_NOTICES from the EXACT final staged tree, before
  // the tree is hashed — both files become part of the signed artifact and are
  // covered by tree_root_sha256. Wheel-level licenses come from the pinned
  // manifest; embedded native components (e.g. Pillow's bundled codecs via its
  // PEP-770 sbom, lxml's libxml2 notices) are merged from the dist-info
  // payloads so no native .dylib/.so ships without an owning component.
  const compliance = writeArtifactComplianceFiles({ targetDirectory, packages, manifest });

  const tree = collectArtifactTreeFiles(targetDirectory, pythonRoot, spreadFiles);

  const receipt = {
    version: COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION,
    build_manifest_version: manifest.version,
    build_manifest_sha256: sha256File(manifestPath),
    python_version: manifest.python_version,
    runtime_key: runtimeKey,
    network_install_allowed: false,
    probe_status: probeStatus,
    tree_phase: 'staged',
    tree_root_sha256: tree.rootSha256,
    tree_files: tree.files,
    compliance,
    spread_files: tree.files
      .filter((entry) => entry.root === 'python-root')
      .map(({ path: relativePath, mode, size, sha256 }) => ({ path: relativePath, mode, size, sha256 })),
    packages: packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      import_name: entry.import_name,
      wheel: entry.filename,
      wheel_sha256: entry.sha256,
      metadata_sha256: entry.wheelInspection.metadataSha256,
      wheel_tags: entry.wheelInspection.tags,
      license: entry.license,
      scope: entry.scope,
    })),
    native_files: nativeFiles.sort(),
  };
  const receiptPath = path.join(targetDirectory, COMMAND_EVE_ARTIFACT_RUNTIME_RECEIPT);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  return { targetDirectory, receiptPath, receipt };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await stageBundledArtifactPython(options);
  console.log(
    `[stage-bundled-artifact-python] ${result.receipt.runtime_key}: ${result.receipt.packages.length} packages, ` +
      `${result.receipt.native_files.length} native files, probe=${result.receipt.probe_status}`
  );
  console.log(`[stage-bundled-artifact-python] target=${path.relative(REPO_ROOT, result.targetDirectory)}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[stage-bundled-artifact-python] ERROR:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
