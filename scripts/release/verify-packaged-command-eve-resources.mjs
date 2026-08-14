import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanForPrivateKeys } from './verify-no-private-keys.mjs';

export const PACKAGED_COMMAND_EVE_RESOURCES_VERIFIER_VERSION = 'verify-packaged-command-eve-resources/v3';
const COMMAND_EVE_BROWSER_UVX_MANIFEST_SCHEMA = 'command-eve-uvx-runner/v1';
const COMMAND_EVE_BROWSER_UVX_ARTIFACT_RECEIPT_SCHEMA = 'command-eve-uvx-artifact-receipt/v1';
const COMMAND_EVE_BROWSER_UVX_PROVENANCE = 'official-astral-release-attestation+fynlabs-developer-id/v1';
const COMMAND_EVE_BROWSER_UVX_SIGNING_AUTHORITY = 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)';
const COMMAND_EVE_BROWSER_UVX_SIGNING_TEAM = 'NHNQ7Q5H28';

export const COMMAND_EVE_PUBLIC_KEY_FILES = Object.freeze([
  'command-eve-license-public-key.pem',
  'command-eve-license-public-key-server.pem',
]);

/**
 * G2 (CEVE-18205) — the Hermes wheel is the ONE bundled wheel nothing verified.
 *
 * The eleven presentation wheels below are pinned by filename AND SHA-256 AND a
 * zero-native-binaries assertion. `hermes_agent-*.whl` — by far the largest and the
 * only one that carries the agent runtime itself — was pinned by nothing: a readiness
 * sweep found zero occurrences of `hermes_agent` in this file. A wrong, stale or
 * corrupted Hermes wheel shipped without a single check failing.
 *
 * The zero-native-binaries assertion is not decoration here. electron-builder.yml
 * excludes resources/bundled-hermes/web/** precisely because Apple notarytool
 * inspects INSIDE .whl files and rejects unsigned Mach-O payloads; a Hermes wheel that
 * ever grew a native binary would fail notarization AFTER a full signed build. This
 * catches it at pack time instead.
 */
export const COMMAND_EVE_HERMES_WHEEL = Object.freeze({
  name: 'hermes-agent',
  version: '0.20.0',
  filename: 'hermes_agent-0.20.0-py3-none-any.whl',
  sha256: 'a91cd1edb383dbbab20d0af7d2b6c9d56183d3248a6ee56ae583b427dbd54bfd',
  required_entries: Object.freeze(['tools/browser_use_cli.py']),
});

// V22's Nix wheel deliberately excludes bare data directories. Command EVE
// therefore ships the exact locale tree from the same reviewed Hermes payload
// alongside the wheel and binds every byte here rather than repacking the wheel.
export const COMMAND_EVE_HERMES_LOCALES = Object.freeze({
  source_commit: '0e24bdc8f82e8e5974f035c98504d1e6de11cd50',
  files: Object.freeze({
    'af.yaml': '5cbe2e72caf41879000b2546ff44a3ba6be72c13c8d1befd2972bb24d32428b4',
    'ar.yaml': '46ea3b377767338eda627f7b6ac4ca8064e8e386030d0ac21643169c5c8b8bd3',
    'de.yaml': 'abb8c95a11f3d454dff673c734ecdffd6f1ea4911833ffd36039f4e4130e33ad',
    'en.yaml': 'fe06b52df673b817691f761b6650bb7513cbc755eca7adef16303df1e4770c8c',
    'es.yaml': 'd0672b523b2631b9427f05377f803ea3f6093c92666c8488abf7e6927407d271',
    'fr.yaml': '44a0a249621099dc7186a02293437c34cd8240378c08612d82955a3424577341',
    'ga.yaml': 'cf96af63a8d1038d2d2864260f3aa300f4b697cf7afb742942f12bed83839661',
    'hu.yaml': 'e8ac5bce9017a3735fc8a29e63b7cb476dd0a322bd471d623806213f74432a08',
    'it.yaml': 'a0f5090b19a77d125d06025a6c15ebade7e2fdd65b0857d9eccfc24febc82546',
    'ja.yaml': '1cfd65dd5f49a139c49b6a28ef93dc66e60f778031313abf135514cad6aba00a',
    'ko.yaml': '8b69b834d4f727b7cd59493e18efaa2ce288c8d38b6dffc83622eda4e379ff4f',
    'pt.yaml': 'bfbb3c2c667cdf7e45fb160aecddb44f5708ee7ba771822b629a555531be651f',
    'ru.yaml': '6aadbff35792d64d2b094b69d922b62baba0c0a02fd4e8049479f190c8d0b590',
    'tr.yaml': '13f75cc46364b01da7eb4a12cc71fca2339d038f8f403e7e5ceef7c99efbeb5f',
    'uk.yaml': '62e027a7dd2b5363ec73cf781521236992b030559f39560348396aa4804fce81',
    'zh-hant.yaml': 'd6e995ca2536a809b00e0e0240f776bfc7723ec783247567a97febf7886cad5f',
    'zh.yaml': '7391e25126f60cd10421437ce8a951b9b280e45878bbc011e5d0b4559575e4e0',
  }),
});

export const COMMAND_EVE_PRESENTATION_PYTHON_WHEELS = Object.freeze([
  {
    name: 'python-pptx',
    version: '1.0.2',
    filename: 'python_pptx-1.0.2-py3-none-any.whl',
    sha256: '160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba',
  },
  {
    name: 'XlsxWriter',
    version: '3.2.9',
    filename: 'xlsxwriter-3.2.9-py3-none-any.whl',
    sha256: '9a5db42bc5dff014806c58a20b9eae7322a134abb6fce3c92c181bfb275ec5b3',
  },
  {
    name: 'pypdf',
    version: '6.14.2',
    filename: 'pypdf-6.14.2-py3-none-any.whl',
    sha256: '3f07891af76dc002657e04993ab9b4de81de29f9013b9761d0b7968bff12e946',
  },
  {
    name: 'reportlab',
    version: '5.0.0',
    filename: 'reportlab-5.0.0-py3-none-any.whl',
    sha256: '9d5a3affa84919e1111ede580031266a570e93b1ce388219621347965ff1d93c',
  },
  {
    name: 'python-docx',
    version: '1.2.0',
    filename: 'python_docx-1.2.0-py3-none-any.whl',
    sha256: '3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7',
  },
  {
    name: 'openpyxl',
    version: '3.1.5',
    filename: 'openpyxl-3.1.5-py2.py3-none-any.whl',
    sha256: '5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2',
  },
  {
    name: 'et-xmlfile',
    version: '2.0.0',
    filename: 'et_xmlfile-2.0.0-py3-none-any.whl',
    sha256: '7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa',
  },
  {
    name: 'qrcode',
    version: '8.2',
    filename: 'qrcode-8.2-py3-none-any.whl',
    sha256: '16e64e0716c14960108e85d853062c9e8bba5ca8252c0b4d0231b9df4060ff4f',
  },
  {
    name: 'defusedxml',
    version: '0.7.1',
    filename: 'defusedxml-0.7.1-py2.py3-none-any.whl',
    sha256: 'a352e7e428770286cc899e2542b6cdaedb2b4953ff269a210103ec58f6198a61',
  },
  {
    name: 'typing-extensions',
    version: '4.16.0',
    filename: 'typing_extensions-4.16.0-py3-none-any.whl',
    sha256: '481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8',
  },
  {
    name: 'charset-normalizer',
    version: '3.4.9',
    filename: 'charset_normalizer-3.4.9-py3-none-any.whl',
    sha256: '68e5f26a1ad57ded6d1cfb85331d1c1a195314756471d97758c48498bb4dcdf5',
  },
]);

const COMMAND_EVE_PRESENTATION_PYTHON_BUNDLE_VERSION = 'command-eve-artifact-python-wheels/v2';
const COMMAND_EVE_ARTIFACT_PYTHON_BUILD_VERSION = 'command-eve-artifact-python-build/v1';
const COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION = 'command-eve-artifact-python-runtime/v1';
const COMMAND_EVE_ARTIFACT_RUNTIME_RECEIPT = 'command-eve-artifact-python-runtime.json';
const NATIVE_ARCHIVE_ENTRY_PATTERN = /\.(?:so|dylib|dll|pyd|node)$/i;

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

function defaultReadCodeSignature(filePath) {
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (verified.error || verified.status !== 0) {
    throw new Error(`PACKAGED-RESOURCES: Browser Use uvx Developer ID signature is invalid: ${filePath}`);
  }
  const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (inspected.error || inspected.status !== 0) {
    throw new Error(`PACKAGED-RESOURCES: Browser Use uvx Developer ID signature is unreadable: ${filePath}`);
  }
  const details = `${inspected.stderr || ''}\n${inspected.stdout || ''}`;
  const value = (name) => {
    const line = details.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : '';
  };
  return {
    authority: value('Authority'),
    team_id: value('TeamIdentifier'),
    identifier: value('Identifier'),
    hardened_runtime: /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/i.test(details),
  };
}

function verifyPackagedHermesLocales(resourcesPath, deps) {
  const directory = path.join(resourcesPath, 'bundled-hermes', 'locales');
  assertDirectory(directory, 'packaged Hermes locale directory', deps);
  const expectedNames = Object.keys(COMMAND_EVE_HERMES_LOCALES.files).toSorted();
  const entries = deps.readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).toSorted();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `PACKAGED-RESOURCES: packaged Hermes locale set mismatch; expected ${expectedNames.join(', ')}, found ${actualNames.join(', ')}`
    );
  }
  const files = expectedNames.map((name) => {
    const bytes = readRequiredRegularFile(path.join(directory, name), `packaged Hermes locale ${name}`, deps);
    const expectedSha256 = COMMAND_EVE_HERMES_LOCALES.files[name];
    if (sha256(bytes) !== expectedSha256) {
      throw new Error(`PACKAGED-RESOURCES: packaged Hermes locale ${name} failed its SHA-256 pin`);
    }
    return { file: name, bytes: bytes.length, sha256: expectedSha256 };
  });
  return {
    source_commit: COMMAND_EVE_HERMES_LOCALES.source_commit,
    count: files.length,
    files,
  };
}

function verifyPackagedBrowserUseRunner(resourcesPath, expectedArch, deps) {
  const target =
    expectedArch === 'arm64' ? 'aarch64-apple-darwin' : expectedArch === 'x64' ? 'x86_64-apple-darwin' : '';
  if (!target) throw new Error(`PACKAGED-RESOURCES: unsupported Browser Use runner architecture: ${expectedArch}`);
  const root = path.join(resourcesPath, 'bundled-hermes', 'uvx');
  const manifestPath = path.join(root, 'uvx-manifest.json');
  const archiveEntry = `uv-${target}/uvx`;
  const manifestBytes = readRequiredRegularFile(manifestPath, 'packaged Browser Use uvx manifest', deps);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('PACKAGED-RESOURCES: Browser Use uvx manifest is not valid JSON');
  }
  const artifact = manifest?.artifacts?.find((candidate) => candidate?.target === target);
  if (
    manifest?.schema_version !== COMMAND_EVE_BROWSER_UVX_MANIFEST_SCHEMA ||
    manifest?.upstream !== 'astral-sh/uv' ||
    manifest?.status === 'BLOCKED_ARTIFACT' ||
    typeof manifest?.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version) ||
    !artifact ||
    artifact.runner_filename !== 'uvx' ||
    artifact.archive_entry !== archiveEntry ||
    !/^[a-f0-9]{64}$/.test(String(artifact.archive_sha256 || '')) ||
    !/^[a-f0-9]{64}$/.test(String(artifact.source_runner_sha256 || '')) ||
    !/^[a-f0-9]{64}$/.test(String(artifact.runner_sha256 || '')) ||
    !/^[a-f0-9]{64}$/.test(String(artifact.artifact_receipt_sha256 || '')) ||
    artifact.provenance !== COMMAND_EVE_BROWSER_UVX_PROVENANCE ||
    artifact.attestation?.repo !== 'astral-sh/uv' ||
    artifact.attestation?.release_tag !== manifest.version ||
    artifact.signing?.authority !== COMMAND_EVE_BROWSER_UVX_SIGNING_AUTHORITY ||
    artifact.signing?.team_id !== COMMAND_EVE_BROWSER_UVX_SIGNING_TEAM ||
    artifact.signing?.identifier !== artifact.runner_filename ||
    artifact.signing?.hardened_runtime !== true
  ) {
    throw new Error('PACKAGED-RESOURCES: Browser Use uvx manifest violates the signed-resource contract');
  }
  const targetRoot = path.join(root, target);
  assertDirectory(targetRoot, 'packaged Browser Use uvx target directory', deps);
  const artifactReceiptPath = path.join(targetRoot, 'uvx-artifact-receipt.json');
  const artifactReceiptBytes = readRequiredRegularFile(
    artifactReceiptPath,
    'packaged Browser Use uvx artifact receipt',
    deps
  );
  let artifactReceipt;
  try {
    artifactReceipt = JSON.parse(artifactReceiptBytes.toString('utf8'));
  } catch {
    throw new Error('PACKAGED-RESOURCES: Browser Use uvx artifact receipt is not valid JSON');
  }
  if (
    artifactReceipt?.schema_version !== COMMAND_EVE_BROWSER_UVX_ARTIFACT_RECEIPT_SCHEMA ||
    artifactReceipt?.provenance !== COMMAND_EVE_BROWSER_UVX_PROVENANCE ||
    artifactReceipt?.upstream !== 'astral-sh/uv' ||
    artifactReceipt?.version !== manifest.version ||
    artifactReceipt?.target !== target ||
    artifactReceipt?.archive_name !== artifact.archive_name ||
    artifactReceipt?.archive_sha256 !== artifact.archive_sha256 ||
    artifactReceipt?.archive_entry !== artifact.archive_entry ||
    artifactReceipt?.runner_filename !== artifact.runner_filename ||
    artifactReceipt?.source_runner_sha256 !== artifact.source_runner_sha256 ||
    artifactReceipt?.runner_sha256 !== artifact.runner_sha256 ||
    artifactReceipt?.attestation?.repo !== 'astral-sh/uv' ||
    artifactReceipt?.attestation?.release_tag !== manifest.version ||
    artifactReceipt?.signing?.authority !== artifact.signing.authority ||
    artifactReceipt?.signing?.team_id !== artifact.signing.team_id ||
    artifactReceipt?.signing?.identifier !== artifact.signing.identifier ||
    artifactReceipt?.signing?.hardened_runtime !== true ||
    sha256(artifactReceiptBytes) !== artifact.artifact_receipt_sha256
  ) {
    throw new Error('PACKAGED-RESOURCES: Browser Use uvx artifact receipt violates the reviewed Astral contract');
  }
  const runnerPath = path.join(targetRoot, artifact.runner_filename);
  const runnerBytes = readRequiredRegularFile(runnerPath, 'packaged Browser Use uvx runner', deps);
  if (sha256(runnerBytes) !== artifact.runner_sha256) {
    throw new Error('PACKAGED-RESOURCES: packaged Browser Use uvx runner failed its SHA-256 pin');
  }
  const expectedMachOArch = MACH_O_ARCH_BY_BUILDER_ARCH[expectedArch];
  const runnerArchitectures = normalizeArchitectures(deps.readArchitectures(runnerPath));
  if (runnerArchitectures.length !== 1 || runnerArchitectures[0] !== expectedMachOArch) {
    throw new Error(
      `PACKAGED-RESOURCES: Browser Use uvx runner must be thin ${expectedMachOArch}; found ${runnerArchitectures.join(', ') || 'none'}`
    );
  }
  const signature = deps.readCodeSignature(runnerPath);
  if (
    signature?.authority !== COMMAND_EVE_BROWSER_UVX_SIGNING_AUTHORITY ||
    signature?.team_id !== COMMAND_EVE_BROWSER_UVX_SIGNING_TEAM ||
    signature?.identifier !== artifact.runner_filename ||
    signature?.hardened_runtime !== true
  ) {
    throw new Error('PACKAGED-RESOURCES: Browser Use uvx Developer ID signature violates the release contract');
  }
  return {
    version: manifest.version,
    target,
    file: artifact.runner_filename,
    sha256: artifact.runner_sha256,
    archive_sha256: artifact.archive_sha256,
    source_runner_sha256: artifact.source_runner_sha256,
    artifact_receipt_sha256: sha256(artifactReceiptBytes),
    attestation: artifact.attestation,
    architectures: runnerArchitectures,
    signing: signature,
  };
}

export function verifyPackagedCommandEveBrowserUseRunner(options, injected = {}) {
  const resourcesPath = path.resolve(String(options?.resourcesPath || ''));
  const expectedArch = String(options?.expectedArch || 'arm64');
  const deps = {
    lstat: injected.lstat || fs.lstatSync,
    readFile: injected.readFile || fs.readFileSync,
    readArchitectures: injected.readArchitectures || defaultReadArchitectures,
    readCodeSignature: injected.readCodeSignature || defaultReadCodeSignature,
  };
  assertDirectory(resourcesPath, 'packaged resources directory', deps);
  return verifyPackagedBrowserUseRunner(resourcesPath, expectedArch, deps);
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

function defaultListArchiveEntries(archivePath) {
  const output = execFileSync('/usr/bin/unzip', ['-Z1', archivePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split(/\r?\n/).filter(Boolean);
}

function normalizeArchitectures(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return [...new Set(entries.map((entry) => String(entry).trim()).filter(Boolean))].sort();
}

function normalizeDistributionName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

function parseJsonFile(filePath, label, deps) {
  const bytes = readRequiredRegularFile(filePath, label, deps);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new Error(`PACKAGED-RESOURCES: ${label} is not valid JSON`);
  }
}

function collectArtifactNativeFiles(directory, deps, root = directory, collected = []) {
  for (const entry of deps.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`PACKAGED-RESOURCES: signed Artifact Python runtime contains a symlink: ${target}`);
    }
    if (entry.isDirectory()) collectArtifactNativeFiles(target, deps, root, collected);
    else if (entry.isFile() && /\.(?:so|dylib|dll|pyd)$/i.test(entry.name)) {
      collected.push(path.relative(root, target));
    }
  }
  return collected;
}

function collectPythonBytecodeCaches(directory, deps, root = directory, collected = []) {
  for (const entry of deps.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const relativePath = path.relative(root, target).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      if (entry.name === '__pycache__' || /\.py[co]$/i.test(entry.name)) collected.push(relativePath);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        collected.push(relativePath);
        continue;
      }
      collectPythonBytecodeCaches(target, deps, root, collected);
    } else if (entry.isFile() && /\.py[co]$/i.test(entry.name)) {
      collected.push(relativePath);
    }
  }
  return collected;
}

function verifyPackagedArtifactPython({ resourcesPath, sourceArtifactManifestPath, expectedArch, deps }) {
  const { bytes: sourceManifestBytes, value: sourceManifest } = parseJsonFile(
    sourceArtifactManifestPath,
    'source Artifact Python manifest',
    deps
  );
  const runtimeKey = `darwin-${expectedArch}`;
  const platformPackages = sourceManifest?.platforms?.[runtimeKey];
  if (
    sourceManifest?.version !== COMMAND_EVE_ARTIFACT_PYTHON_BUILD_VERSION ||
    sourceManifest?.runtime_version !== COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION ||
    sourceManifest?.network_install_allowed !== false ||
    !Array.isArray(sourceManifest?.common_packages) ||
    !Array.isArray(platformPackages)
  ) {
    throw new Error(`PACKAGED-RESOURCES: source Artifact Python manifest does not support ${runtimeKey}`);
  }
  const expectedPackages = [
    ...sourceManifest.common_packages.map((entry) => ({ ...entry, scope: 'common' })),
    ...platformPackages.map((entry) => ({ ...entry, scope: runtimeKey })),
  ];
  const pythonDirectory = path.join(resourcesPath, 'python');
  assertDirectory(pythonDirectory, 'packaged bundled Python runtime', deps);
  const bytecodeCaches = collectPythonBytecodeCaches(pythonDirectory, deps).sort();
  if (bytecodeCaches.length > 0) {
    throw new Error(
      `PACKAGED-RESOURCES: bundled Python runtime contains bytecode caches: ${bytecodeCaches.slice(0, 5).join(', ')}`
    );
  }
  const artifactDirectory = path.join(pythonDirectory, 'artifact-site-packages');
  assertDirectory(artifactDirectory, 'packaged signed Artifact Python runtime', deps);
  const receiptPath = path.join(artifactDirectory, COMMAND_EVE_ARTIFACT_RUNTIME_RECEIPT);
  const { value: receipt } = parseJsonFile(receiptPath, 'packaged Artifact Python receipt', deps);
  if (
    receipt?.version !== COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION ||
    receipt?.build_manifest_version !== COMMAND_EVE_ARTIFACT_PYTHON_BUILD_VERSION ||
    receipt?.build_manifest_sha256 !== sha256(sourceManifestBytes) ||
    receipt?.runtime_key !== runtimeKey ||
    receipt?.network_install_allowed !== false ||
    receipt?.probe_status !== 'pass' ||
    !Array.isArray(receipt?.packages) ||
    receipt.packages.length !== expectedPackages.length ||
    !Array.isArray(receipt?.native_files)
  ) {
    throw new Error('PACKAGED-RESOURCES: packaged Artifact Python receipt violates its signed-runtime contract');
  }

  const distInfo = new Map();
  for (const entry of deps.readdir(artifactDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue;
    const metadataPath = path.join(artifactDirectory, entry.name, 'METADATA');
    const metadata = readRequiredRegularFile(metadataPath, `packaged ${entry.name}/METADATA`, deps).toString('utf8');
    const name = metadata.match(/^Name:\s*(.+)$/m)?.[1]?.trim();
    const version = metadata.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
    if (!name || !version) throw new Error(`PACKAGED-RESOURCES: incomplete package metadata in ${metadataPath}`);
    distInfo.set(normalizeDistributionName(name), { name, version, metadataPath });
  }

  const packages = expectedPackages.map((expected) => {
    const declared = receipt.packages.find((entry) => entry?.name === expected.name);
    const installed = distInfo.get(normalizeDistributionName(expected.name));
    if (
      !declared ||
      declared.version !== expected.version ||
      declared.import_name !== expected.import_name ||
      declared.wheel !== expected.filename ||
      declared.wheel_sha256 !== expected.sha256 ||
      declared.license !== expected.license ||
      declared.scope !== expected.scope ||
      !installed ||
      installed.version !== expected.version
    ) {
      throw new Error(`PACKAGED-RESOURCES: packaged Artifact Python mismatch for ${expected.name}`);
    }
    return {
      package: expected.name,
      version: expected.version,
      wheel: expected.filename,
      wheel_sha256: expected.sha256,
      license: expected.license,
      scope: expected.scope,
    };
  });

  const nativeFiles = collectArtifactNativeFiles(artifactDirectory, deps).sort();
  const declaredNativeFiles = [...receipt.native_files].map(String).sort();
  if (nativeFiles.length === 0 || JSON.stringify(nativeFiles) !== JSON.stringify(declaredNativeFiles)) {
    throw new Error('PACKAGED-RESOURCES: signed Artifact Python native-file receipt is incomplete or stale');
  }
  const expectedMachOArch = MACH_O_ARCH_BY_BUILDER_ARCH[expectedArch];
  const nativeArchitectures = nativeFiles.map((relativePath) => {
    const filePath = path.join(artifactDirectory, relativePath);
    readRequiredRegularFile(filePath, `packaged Artifact Python native file ${relativePath}`, deps);
    const architectures = normalizeArchitectures(deps.readArchitectures(filePath));
    if (!architectures.includes(expectedMachOArch)) {
      throw new Error(
        `PACKAGED-RESOURCES: Artifact Python native file ${relativePath} lacks ${expectedMachOArch}: ${architectures.join(', ') || 'none'}`
      );
    }
    return { file: relativePath, architectures };
  });

  return {
    runtime_version: COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION,
    runtime_key: runtimeKey,
    network_install_allowed: false,
    packages,
    native_files: nativeArchitectures,
    receipt_path: receiptPath,
  };
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
  const sourceArtifactManifestPath = path.resolve(String(options?.sourceArtifactManifestPath || ''));
  const expectedArch = String(options?.expectedArch || 'arm64');
  const productFilename = String(options?.productFilename || path.basename(appPath, '.app'));
  const expectedMachOArch = MACH_O_ARCH_BY_BUILDER_ARCH[expectedArch];
  if (!expectedMachOArch) {
    throw new Error(`PACKAGED-RESOURCES: unsupported macOS builder architecture: ${expectedArch}`);
  }

  const deps = {
    lstat: injected.lstat || fs.lstatSync,
    readFile: injected.readFile || fs.readFileSync,
    readdir: injected.readdir || fs.readdirSync,
    readArchitectures: injected.readArchitectures || defaultReadArchitectures,
    readCodeSignature: injected.readCodeSignature || defaultReadCodeSignature,
    listArchiveEntries: injected.listArchiveEntries || defaultListArchiveEntries,
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

  const presentationDirectory = path.join(resourcesPath, 'bundled-hermes', 'presentation');
  assertDirectory(presentationDirectory, 'packaged presentation Python bundle', deps);
  const presentationManifestPath = path.join(presentationDirectory, 'manifest.json');
  const presentationManifestBytes = readRequiredRegularFile(
    presentationManifestPath,
    'packaged presentation Python manifest',
    deps
  );
  let presentationManifest;
  try {
    presentationManifest = JSON.parse(presentationManifestBytes.toString('utf8'));
  } catch {
    throw new Error('PACKAGED-RESOURCES: packaged presentation Python manifest is not valid JSON');
  }
  if (
    presentationManifest?.version !== COMMAND_EVE_PRESENTATION_PYTHON_BUNDLE_VERSION ||
    presentationManifest?.native_binaries !== false ||
    presentationManifest?.network_install_allowed !== false ||
    !Array.isArray(presentationManifest?.packages)
  ) {
    throw new Error('PACKAGED-RESOURCES: packaged presentation Python manifest violates its offline-only contract');
  }

  const presentationPython = COMMAND_EVE_PRESENTATION_PYTHON_WHEELS.map((expected) => {
    const declared = presentationManifest.packages.find((entry) => entry?.name === expected.name);
    if (
      !declared ||
      declared.version !== expected.version ||
      declared.filename !== expected.filename ||
      declared.sha256 !== expected.sha256
    ) {
      throw new Error(`PACKAGED-RESOURCES: packaged presentation manifest mismatch for ${expected.name}`);
    }
    const packagedPath = path.join(presentationDirectory, expected.filename);
    const bytes = readRequiredRegularFile(packagedPath, `packaged ${expected.filename}`, deps);
    if (sha256(bytes) !== expected.sha256) {
      throw new Error(`PACKAGED-RESOURCES: packaged ${expected.filename} failed its SHA-256 pin`);
    }
    const nativeEntries = deps
      .listArchiveEntries(packagedPath)
      .filter((entry) => NATIVE_ARCHIVE_ENTRY_PATTERN.test(entry));
    if (nativeEntries.length > 0) {
      throw new Error(
        `PACKAGED-RESOURCES: packaged ${expected.filename} unexpectedly contains native binaries: ${nativeEntries.join(', ')}`
      );
    }
    return {
      package: expected.name,
      version: expected.version,
      file: expected.filename,
      bytes: bytes.length,
      sha256: expected.sha256,
      native_entries: 0,
    };
  });

  // The Hermes wheel itself — same three checks the presentation wheels get.
  const hermesWheelPath = path.join(resourcesPath, 'bundled-hermes', COMMAND_EVE_HERMES_WHEEL.filename);
  const hermesWheelBytes = readRequiredRegularFile(
    hermesWheelPath,
    `packaged ${COMMAND_EVE_HERMES_WHEEL.filename}`,
    deps
  );
  if (sha256(hermesWheelBytes) !== COMMAND_EVE_HERMES_WHEEL.sha256) {
    throw new Error(`PACKAGED-RESOURCES: packaged ${COMMAND_EVE_HERMES_WHEEL.filename} failed its SHA-256 pin`);
  }
  const hermesNativeEntries = deps
    .listArchiveEntries(hermesWheelPath)
    .filter((entry) => NATIVE_ARCHIVE_ENTRY_PATTERN.test(entry));
  if (hermesNativeEntries.length > 0) {
    throw new Error(
      `PACKAGED-RESOURCES: packaged ${COMMAND_EVE_HERMES_WHEEL.filename} unexpectedly contains native binaries: ${hermesNativeEntries.join(', ')}`
    );
  }
  const hermesWheelEntries = deps.listArchiveEntries(hermesWheelPath);
  const missingHermesEntries = COMMAND_EVE_HERMES_WHEEL.required_entries.filter(
    (entry) => !hermesWheelEntries.includes(entry)
  );
  if (missingHermesEntries.length > 0) {
    throw new Error(
      `PACKAGED-RESOURCES: reviewed Hermes wheel is missing required Browser Use adapter entries: ${missingHermesEntries.join(', ')}`
    );
  }
  const hermesWheel = {
    package: COMMAND_EVE_HERMES_WHEEL.name,
    version: COMMAND_EVE_HERMES_WHEEL.version,
    file: COMMAND_EVE_HERMES_WHEEL.filename,
    bytes: hermesWheelBytes.length,
    sha256: COMMAND_EVE_HERMES_WHEEL.sha256,
    native_entries: 0,
    required_entries: [...COMMAND_EVE_HERMES_WHEEL.required_entries],
  };
  const hermesLocales = verifyPackagedHermesLocales(resourcesPath, deps);

  const browserUseRunner = verifyPackagedBrowserUseRunner(resourcesPath, expectedArch, deps);

  const artifactPython = verifyPackagedArtifactPython({
    resourcesPath,
    sourceArtifactManifestPath,
    expectedArch,
    deps,
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
    presentation_python: {
      bundle_version: COMMAND_EVE_PRESENTATION_PYTHON_BUNDLE_VERSION,
      offline_only: true,
      wheels: presentationPython,
    },
    hermes_wheel: hermesWheel,
    hermes_locales: hermesLocales,
    browser_use_runner: browserUseRunner,
    artifact_python: artifactPython,
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
      sourceArtifactManifestPath:
        args['source-artifact-manifest'] || path.resolve('resources/bundled-python-artifacts/manifest.json'),
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
