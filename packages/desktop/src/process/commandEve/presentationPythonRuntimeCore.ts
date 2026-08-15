/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COMMAND_EVE_PRESENTATION_PYTHON_BUNDLE_VERSION = 'command-eve-artifact-python-wheels/v2';
export const COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION = 'command-eve-artifact-python-runtime/v1';
export const COMMAND_EVE_PRESENTATION_WHEELS_DIR_ENV = 'COMMAND_EVE_PRESENTATION_WHEELS_DIR';
export const COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR_ENV = 'COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR';
export const COMMAND_EVE_PRESENTATION_WHEELS_SUBDIR = 'presentation';
export const COMMAND_EVE_ARTIFACT_PYTHON_SITE_SUBDIR = 'artifact-site-packages';
export const COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT = 'command-eve-artifact-python-runtime.json';
export const COMMAND_EVE_HERMES_RUNTIME_PACKAGED_LOCK_FILE = 'command-eve-hermes-runtime.lock.tsv';
export const COMMAND_EVE_HERMES_RUNTIME_LOCK_SHA256 =
  'ddca1ada6600b05a11268f4129fb8206fe9637b793bcf58824f8d1e984d073de';
export const COMMAND_EVE_HERMES_RUNTIME_PACKAGE_COUNT = 78;
export const COMMAND_EVE_HERMES_RUNTIME_STAGED_PACKAGE_COUNT = 75;
export const COMMAND_EVE_PYTHON_SIGNING_AUTHORITY = 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)';
export const COMMAND_EVE_PYTHON_SIGNING_TEAM = 'NHNQ7Q5H28';
export const COMMAND_EVE_PYTHON_SIGNING_IDENTIFIER = 'python3';

export const COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES = Object.freeze([
  {
    name: 'python-pptx',
    version: '1.0.2',
    importName: 'pptx',
    filename: 'python_pptx-1.0.2-py3-none-any.whl',
    sha256: '160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba',
  },
  {
    name: 'XlsxWriter',
    version: '3.2.9',
    importName: 'xlsxwriter',
    filename: 'xlsxwriter-3.2.9-py3-none-any.whl',
    sha256: '9a5db42bc5dff014806c58a20b9eae7322a134abb6fce3c92c181bfb275ec5b3',
  },
  {
    name: 'pypdf',
    version: '6.14.2',
    importName: 'pypdf',
    filename: 'pypdf-6.14.2-py3-none-any.whl',
    sha256: '3f07891af76dc002657e04993ab9b4de81de29f9013b9761d0b7968bff12e946',
  },
  {
    name: 'reportlab',
    version: '5.0.0',
    importName: 'reportlab',
    filename: 'reportlab-5.0.0-py3-none-any.whl',
    sha256: '9d5a3affa84919e1111ede580031266a570e93b1ce388219621347965ff1d93c',
  },
  {
    name: 'python-docx',
    version: '1.2.0',
    importName: 'docx',
    filename: 'python_docx-1.2.0-py3-none-any.whl',
    sha256: '3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7',
  },
  {
    name: 'openpyxl',
    version: '3.1.5',
    importName: 'openpyxl',
    filename: 'openpyxl-3.1.5-py2.py3-none-any.whl',
    sha256: '5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2',
  },
  {
    name: 'et-xmlfile',
    version: '2.0.0',
    importName: 'et_xmlfile',
    filename: 'et_xmlfile-2.0.0-py3-none-any.whl',
    sha256: '7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa',
  },
  {
    name: 'qrcode',
    version: '8.2',
    importName: 'qrcode',
    filename: 'qrcode-8.2-py3-none-any.whl',
    sha256: '16e64e0716c14960108e85d853062c9e8bba5ca8252c0b4d0231b9df4060ff4f',
  },
  {
    name: 'defusedxml',
    version: '0.7.1',
    importName: 'defusedxml',
    filename: 'defusedxml-0.7.1-py2.py3-none-any.whl',
    sha256: 'a352e7e428770286cc899e2542b6cdaedb2b4953ff269a210103ec58f6198a61',
  },
  {
    name: 'typing-extensions',
    version: '4.16.0',
    importName: 'typing_extensions',
    filename: 'typing_extensions-4.16.0-py3-none-any.whl',
    sha256: '481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8',
  },
  {
    name: 'charset-normalizer',
    version: '3.4.9',
    importName: 'charset_normalizer',
    filename: 'charset_normalizer-3.4.9-py3-none-any.whl',
    sha256: '68e5f26a1ad57ded6d1cfb85331d1c1a195314756471d97758c48498bb4dcdf5',
  },
]);

export const COMMAND_EVE_ARTIFACT_PYTHON_NATIVE_PACKAGES = Object.freeze([
  {
    name: 'lxml',
    version: '6.1.1',
    importName: 'lxml',
    filename: 'lxml-6.1.1-cp312-cp312-macosx_10_13_universal2.whl',
    sha256: '104c09bda8d2a562824c0e319d0768ce26a779b7601e0931d33b09b53c392ef7',
  },
  {
    name: 'Pillow',
    version: '12.3.0',
    importName: 'PIL',
    filename: 'pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl',
    sha256: 'ffd0c5368496f41b0944be820fcb7a838aa6e623d250b01acf2643939c3f99d7',
  },
]);

export const COMMAND_EVE_ARTIFACT_PYTHON_WINDOWS_PACKAGES = Object.freeze([
  {
    name: 'colorama',
    version: '0.4.6',
    importName: 'colorama',
    filename: 'colorama-0.4.6-py2.py3-none-any.whl',
    sha256: '4f1d9991f5acc0ca119f9d443620b77f9d6b33703e51011c16baf57afb285fc6',
  },
]);

export function commandEveArtifactPythonPackages(platform: NodeJS.Platform = process.platform) {
  return Object.freeze([
    ...COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES,
    ...COMMAND_EVE_ARTIFACT_PYTHON_NATIVE_PACKAGES,
    ...(platform === 'win32' ? COMMAND_EVE_ARTIFACT_PYTHON_WINDOWS_PACKAGES : []),
  ]);
}

export const COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES = commandEveArtifactPythonPackages();

type PresentationBundleManifest = {
  version?: unknown;
  native_binaries?: unknown;
  network_install_allowed?: unknown;
  packages?: Array<{ name?: unknown; version?: unknown; filename?: unknown; sha256?: unknown }>;
};

type ArtifactPythonRuntimeReceipt = {
  version?: unknown;
  runtime_key?: unknown;
  network_install_allowed?: unknown;
  tree_phase?: unknown;
  tree_root_sha256?: unknown;
  tree_files?: Array<{
    root?: unknown;
    path?: unknown;
    mode?: unknown;
    size?: unknown;
    sha256?: unknown;
  }>;
  spread_files?: Array<{ path?: unknown; mode?: unknown; size?: unknown; sha256?: unknown }>;
  runtime_files?: Array<{
    path?: unknown;
    mode?: unknown;
    size?: unknown;
    sha256?: unknown;
    code_signature?: unknown;
  }>;
  packages?: Array<{
    name?: unknown;
    version?: unknown;
    import_name?: unknown;
    wheel?: unknown;
    wheel_sha256?: unknown;
    metadata_sha256?: unknown;
    wheel_tags?: unknown;
    scope?: unknown;
  }>;
  hermes_runtime?: {
    version?: unknown;
    lock_file?: unknown;
    lock_sha256?: unknown;
    package_count?: unknown;
    staged_package_count?: unknown;
    extras?: unknown;
    network_install_allowed?: unknown;
  };
};

export type CommandEvePresentationPythonBundleVerification =
  | { ok: true; directory: string; manifestPath: string }
  | { ok: false; reason: string };

export type CommandEveArtifactPythonPackageIdentity = {
  name: string;
  version: string;
  importName: string;
  wheel: string;
  wheelSha256: string;
  scope: string;
};

export type CommandEvePythonCodeSignature = Readonly<{
  authority: typeof COMMAND_EVE_PYTHON_SIGNING_AUTHORITY;
  teamId: typeof COMMAND_EVE_PYTHON_SIGNING_TEAM;
  identifier: typeof COMMAND_EVE_PYTHON_SIGNING_IDENTIFIER;
  cdhash: string;
  hardenedRuntime: true;
}>;

export type CommandEveArtifactPythonSiteVerification =
  | {
      ok: true;
      directory: string;
      manifestPath: string;
      runtimeKey: string;
      receiptSha256: string;
      treeRootSha256: string;
      treePhase: 'staged' | 'signed';
      lockSha256?: string;
      packages: CommandEveArtifactPythonPackageIdentity[];
      packagedInterpreter?: Readonly<{
        path: string;
        relativePath: string;
        mode: number;
        size: number;
        sha256: string;
        codeSignature: CommandEvePythonCodeSignature;
      }>;
      resourcesRoot?: string;
    }
  | { ok: false; reason: string };

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

type ArtifactTreeFile = {
  root: 'artifact-site' | 'python-root';
  path: string;
  mode: number;
  size: number;
  sha256: string;
};

function safeReceiptRelativePath(value: unknown): string {
  const candidate = String(value || '');
  if (
    !candidate ||
    candidate.includes('\\') ||
    candidate.includes('\0') ||
    path.posix.isAbsolute(candidate) ||
    candidate.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`artifact_tree_path_invalid:${candidate}`);
  }
  return candidate;
}

function artifactTreeFiles(directory: string, receipt: ArtifactPythonRuntimeReceipt): ArtifactTreeFile[] {
  const receiptPath = path.join(directory, COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT);
  const files: ArtifactTreeFile[] = [];
  const addFile = (root: ArtifactTreeFile['root'], relativePath: string, filePath: string) => {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact_tree_file_invalid:${relativePath}`);
    files.push({
      root,
      path: relativePath.split(path.sep).join('/'),
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: sha256File(filePath),
    });
  };
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`artifact_tree_symlink:${target}`);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && target !== receiptPath)
        addFile('artifact-site', path.relative(directory, target), target);
      else if (!entry.isFile()) throw new Error(`artifact_tree_special_file:${target}`);
    }
  };
  visit(directory);

  const pythonRoot = path.dirname(directory);
  if (!Array.isArray(receipt.spread_files)) throw new Error('artifact_spread_receipt_invalid');
  for (const entry of receipt.spread_files) {
    const relativePath = safeReceiptRelativePath(entry?.path);
    const target = path.resolve(pythonRoot, ...relativePath.split('/'));
    const relativeToRoot = path.relative(pythonRoot, target);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`artifact_spread_path_escaped:${relativePath}`);
    }
    addFile('python-root', relativePath, target);
  }
  if (receipt.runtime_files !== undefined) {
    if (!Array.isArray(receipt.runtime_files)) throw new Error('artifact_runtime_files_receipt_invalid');
    const spreadPaths = new Set(receipt.spread_files.map((entry) => safeReceiptRelativePath(entry?.path)));
    for (const entry of receipt.runtime_files) {
      const relativePath = safeReceiptRelativePath(entry?.path);
      if (spreadPaths.has(relativePath)) throw new Error(`artifact_runtime_file_duplicate:${relativePath}`);
      const target = path.resolve(pythonRoot, ...relativePath.split('/'));
      const relativeToRoot = path.relative(pythonRoot, target);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        throw new Error(`artifact_runtime_path_escaped:${relativePath}`);
      }
      addFile('python-root', relativePath, target);
    }
  }
  return files.toSorted((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
}

function treeRootSha256(files: ArtifactTreeFile[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

type HermesRuntimeLockEntry = {
  name: string;
  version: string;
  wheel: string;
  wheelSha256: string;
};

function normalizeDistributionName(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

function parseCommandEvePythonCodeSignature(value: unknown): CommandEvePythonCodeSignature | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const signature = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(signature).toSorted()) !==
      JSON.stringify(['authority', 'cdhash', 'hardened_runtime', 'identifier', 'team_id']) ||
    signature.authority !== COMMAND_EVE_PYTHON_SIGNING_AUTHORITY ||
    signature.team_id !== COMMAND_EVE_PYTHON_SIGNING_TEAM ||
    signature.identifier !== COMMAND_EVE_PYTHON_SIGNING_IDENTIFIER ||
    typeof signature.cdhash !== 'string' ||
    !/^[a-f0-9]{40}$/.test(signature.cdhash) ||
    signature.hardened_runtime !== true
  ) {
    return undefined;
  }
  return {
    authority: COMMAND_EVE_PYTHON_SIGNING_AUTHORITY,
    teamId: COMMAND_EVE_PYTHON_SIGNING_TEAM,
    identifier: COMMAND_EVE_PYTHON_SIGNING_IDENTIFIER,
    cdhash: signature.cdhash,
    hardenedRuntime: true,
  };
}

function parsePackagedHermesRuntimeLock(directory: string): HermesRuntimeLockEntry[] {
  const lockPath = path.join(directory, COMMAND_EVE_HERMES_RUNTIME_PACKAGED_LOCK_FILE);
  const lockStat = fs.lstatSync(lockPath);
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) throw new Error('artifact_runtime_lock_invalid');
  const bytes = fs.readFileSync(lockPath);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== COMMAND_EVE_HERMES_RUNTIME_LOCK_SHA256) {
    throw new Error('artifact_runtime_lock_hash_mismatch');
  }
  const names = new Set<string>();
  const entries: HermesRuntimeLockEntry[] = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const [name, version, wheelSha256, source, ...extra] = line.split('\t');
    const normalized = normalizeDistributionName(name);
    if (
      extra.length > 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name || '') ||
      !version ||
      !/^[a-f0-9]{64}$/.test(wheelSha256 || '') ||
      !source ||
      names.has(normalized)
    ) {
      throw new Error('artifact_runtime_lock_entry_invalid');
    }
    names.add(normalized);
    const wheel = source.startsWith('repo://')
      ? path.posix.basename(source.slice('repo://'.length))
      : path.posix.basename(new URL(source).pathname);
    if (!wheel.endsWith('.whl')) throw new Error(`artifact_runtime_lock_wheel_invalid:${name}`);
    entries.push({ name, version, wheel, wheelSha256 });
  }
  if (entries.length !== COMMAND_EVE_HERMES_RUNTIME_PACKAGE_COUNT || !names.has('hermes-agent') || !names.has('ddgs')) {
    throw new Error('artifact_runtime_lock_package_set_invalid');
  }
  return entries;
}

/**
 * Verify that the two pure-Python wheels shipped for editable PPTX generation
 * are exact, regular, non-symlinked files matching the committed manifest.
 */
export function verifyCommandEvePresentationPythonBundle(
  directory: string
): CommandEvePresentationPythonBundleVerification {
  const resolvedDirectory = path.resolve(String(directory || ''));
  if (!directory || !fs.existsSync(resolvedDirectory)) return { ok: false, reason: 'bundle_directory_missing' };
  const directoryStat = fs.lstatSync(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return { ok: false, reason: 'bundle_directory_invalid' };
  }

  const manifestPath = path.join(resolvedDirectory, 'manifest.json');
  try {
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return { ok: false, reason: 'manifest_invalid' };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PresentationBundleManifest;
    if (
      manifest.version !== COMMAND_EVE_PRESENTATION_PYTHON_BUNDLE_VERSION ||
      manifest.native_binaries !== false ||
      manifest.network_install_allowed !== false ||
      !Array.isArray(manifest.packages)
    ) {
      return { ok: false, reason: 'manifest_contract_mismatch' };
    }

    if (manifest.packages.length !== COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES.length) {
      return { ok: false, reason: 'manifest_package_count_mismatch' };
    }
    for (const expected of COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES) {
      const declared = manifest.packages.find((entry) => entry?.name === expected.name);
      if (
        !declared ||
        declared.version !== expected.version ||
        declared.filename !== expected.filename ||
        declared.sha256 !== expected.sha256
      ) {
        return { ok: false, reason: `manifest_package_mismatch:${expected.name}` };
      }
      const wheelPath = path.join(resolvedDirectory, expected.filename);
      const wheelStat = fs.lstatSync(wheelPath);
      if (!wheelStat.isFile() || wheelStat.isSymbolicLink()) {
        return { ok: false, reason: `wheel_invalid:${expected.name}` };
      }
      if (sha256File(wheelPath) !== expected.sha256) {
        return { ok: false, reason: `wheel_hash_mismatch:${expected.name}` };
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'bundle_verification_failed' };
  }

  return { ok: true, directory: resolvedDirectory, manifestPath };
}

export function resolveCommandEvePresentationPythonBundleDir(
  env: NodeJS.ProcessEnv,
  resourcesPath?: string,
  cwd = process.cwd()
): string {
  const candidates = [
    String(env[COMMAND_EVE_PRESENTATION_WHEELS_DIR_ENV] || '').trim(),
    resourcesPath ? path.join(resourcesPath, 'bundled-hermes', COMMAND_EVE_PRESENTATION_WHEELS_SUBDIR) : '',
    path.join(cwd, 'resources', 'bundled-hermes', COMMAND_EVE_PRESENTATION_WHEELS_SUBDIR),
  ].filter(Boolean);

  return candidates.find((candidate) => verifyCommandEvePresentationPythonBundle(candidate).ok) || '';
}

export function verifyCommandEveArtifactPythonSite(directory: string): CommandEveArtifactPythonSiteVerification {
  const resolvedDirectory = path.resolve(String(directory || ''));
  if (!directory || !fs.existsSync(resolvedDirectory)) return { ok: false, reason: 'artifact_site_missing' };
  const directoryStat = fs.lstatSync(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return { ok: false, reason: 'artifact_site_invalid' };
  }
  const receiptPath = path.join(resolvedDirectory, COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT);
  let verified:
    | {
        runtimeKey: string;
        receiptSha256: string;
        treeRootSha256: string;
        treePhase: 'staged' | 'signed';
        lockSha256?: string;
        packages: CommandEveArtifactPythonPackageIdentity[];
        packagedInterpreter?: Readonly<{
          path: string;
          relativePath: string;
          mode: number;
          size: number;
          sha256: string;
          codeSignature: CommandEvePythonCodeSignature;
        }>;
      }
    | undefined;
  try {
    if (!fs.existsSync(receiptPath)) {
      return { ok: false, reason: 'artifact_receipt_invalid' };
    }
    const receiptStat = fs.lstatSync(receiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
      return { ok: false, reason: 'artifact_receipt_invalid' };
    }
    const receiptBytes = fs.readFileSync(receiptPath);
    const receipt = JSON.parse(receiptBytes.toString('utf8')) as ArtifactPythonRuntimeReceipt;
    const runtimeKey = String(receipt.runtime_key || '');
    const hermesRuntimeRequired = runtimeKey === 'darwin-arm64';
    const treePhase = String(receipt.tree_phase || '');
    const platform: NodeJS.Platform = runtimeKey === 'win32-x64' ? 'win32' : 'darwin';
    const basePackages = commandEveArtifactPythonPackages(platform);
    if (
      receipt.version !== COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION ||
      !['darwin-arm64', 'win32-x64'].includes(runtimeKey) ||
      receipt.network_install_allowed !== false ||
      !['staged', 'signed'].includes(treePhase) ||
      typeof receipt.tree_root_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.tree_root_sha256) ||
      !Array.isArray(receipt.tree_files) ||
      !Array.isArray(receipt.spread_files) ||
      !Array.isArray(receipt.packages) ||
      (hermesRuntimeRequired
        ? receipt.packages.length !== basePackages.length + COMMAND_EVE_HERMES_RUNTIME_STAGED_PACKAGE_COUNT ||
          receipt.hermes_runtime?.version !== 'command-eve-hermes-runtime-site/v1' ||
          receipt.hermes_runtime.lock_file !== COMMAND_EVE_HERMES_RUNTIME_PACKAGED_LOCK_FILE ||
          receipt.hermes_runtime.lock_sha256 !== COMMAND_EVE_HERMES_RUNTIME_LOCK_SHA256 ||
          receipt.hermes_runtime.package_count !== COMMAND_EVE_HERMES_RUNTIME_PACKAGE_COUNT ||
          receipt.hermes_runtime.staged_package_count !== COMMAND_EVE_HERMES_RUNTIME_STAGED_PACKAGE_COUNT ||
          JSON.stringify(receipt.hermes_runtime.extras) !== JSON.stringify(['acp', 'mcp']) ||
          receipt.hermes_runtime.network_install_allowed !== false
        : receipt.packages.length !== basePackages.length || receipt.hermes_runtime !== undefined)
    ) {
      return { ok: false, reason: 'artifact_receipt_contract_mismatch' };
    }

    const packageNames = new Set<string>();
    const packages: CommandEveArtifactPythonPackageIdentity[] = [];
    for (const entry of receipt.packages) {
      const normalized = normalizeDistributionName(entry?.name);
      if (
        !normalized ||
        packageNames.has(normalized) ||
        typeof entry?.name !== 'string' ||
        typeof entry.version !== 'string' ||
        typeof entry.import_name !== 'string' ||
        typeof entry.wheel !== 'string' ||
        !entry.wheel.endsWith('.whl') ||
        typeof entry.wheel_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.wheel_sha256) ||
        typeof entry.metadata_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.metadata_sha256) ||
        !Array.isArray(entry.wheel_tags) ||
        entry.wheel_tags.length === 0 ||
        typeof entry.scope !== 'string'
      ) {
        return { ok: false, reason: 'artifact_package_identity_invalid' };
      }
      packageNames.add(normalized);
      packages.push({
        name: entry.name,
        version: entry.version,
        importName: entry.import_name,
        wheel: entry.wheel,
        wheelSha256: entry.wheel_sha256,
        scope: entry.scope,
      });
    }

    for (const expected of basePackages) {
      const declared = packages.find(
        (entry) => normalizeDistributionName(entry.name) === normalizeDistributionName(expected.name)
      );
      if (
        !declared ||
        declared.version !== expected.version ||
        declared.importName !== expected.importName ||
        declared.wheel !== expected.filename ||
        declared.wheelSha256 !== expected.sha256
      ) {
        return { ok: false, reason: `artifact_package_mismatch:${expected.name}` };
      }
    }

    let lockSha256: string | undefined;
    let packagedInterpreter:
      | Readonly<{
          path: string;
          relativePath: string;
          mode: number;
          size: number;
          sha256: string;
          codeSignature: CommandEvePythonCodeSignature;
        }>
      | undefined;
    if (hermesRuntimeRequired) {
      const expectedRuntimePaths = ['bin/python3.12', 'command-eve-python-manifest.json'];
      if (
        !Array.isArray(receipt.runtime_files) ||
        receipt.runtime_files.length !== expectedRuntimePaths.length ||
        JSON.stringify(receipt.runtime_files.map((entry) => entry?.path).toSorted()) !==
          JSON.stringify(expectedRuntimePaths)
      ) {
        return { ok: false, reason: 'artifact_runtime_files_receipt_invalid' };
      }
      for (const entry of receipt.runtime_files) {
        const relativePath = String(entry?.path || '');
        const codeSignature = parseCommandEvePythonCodeSignature(entry?.code_signature);
        if (
          typeof entry?.path !== 'string' ||
          typeof entry.mode !== 'number' ||
          typeof entry.size !== 'number' ||
          !Number.isSafeInteger(entry.size) ||
          entry.size <= 0 ||
          typeof entry.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) ||
          (relativePath === 'bin/python3.12'
            ? treePhase === 'signed'
              ? !codeSignature
              : entry?.code_signature !== undefined
            : entry?.code_signature !== undefined)
        ) {
          return { ok: false, reason: 'artifact_runtime_file_identity_invalid' };
        }
      }
      const interpreter = receipt.runtime_files.find((entry) => entry?.path === 'bin/python3.12');
      const interpreterSignature = parseCommandEvePythonCodeSignature(interpreter?.code_signature);
      if (!interpreter || (Number(interpreter.mode) & 0o111) === 0) {
        return { ok: false, reason: 'artifact_runtime_interpreter_invalid' };
      }
      if (interpreterSignature) {
        packagedInterpreter = {
          path: path.join(path.dirname(resolvedDirectory), 'bin', 'python3.12'),
          relativePath: 'bin/python3.12',
          mode: Number(interpreter.mode),
          size: Number(interpreter.size),
          sha256: String(interpreter.sha256),
          codeSignature: interpreterSignature,
        };
      }
      const locked = parsePackagedHermesRuntimeLock(resolvedDirectory);
      lockSha256 = COMMAND_EVE_HERMES_RUNTIME_LOCK_SHA256;
      const baseNames = new Set(basePackages.map((entry) => normalizeDistributionName(entry.name)));
      for (const expected of locked) {
        const declared = packages.find(
          (entry) => normalizeDistributionName(entry.name) === normalizeDistributionName(expected.name)
        );
        if (
          !declared ||
          declared.version !== expected.version ||
          declared.wheel !== expected.wheel ||
          declared.wheelSha256 !== expected.wheelSha256 ||
          (!baseNames.has(normalizeDistributionName(expected.name)) && declared.scope !== 'hermes-runtime')
        ) {
          return { ok: false, reason: `artifact_runtime_lock_mismatch:${expected.name}` };
        }
      }
      if (
        packages.filter((entry) => entry.scope === 'hermes-runtime').length !==
        COMMAND_EVE_HERMES_RUNTIME_STAGED_PACKAGE_COUNT
      ) {
        return { ok: false, reason: 'artifact_hermes_runtime_package_set_invalid' };
      }
    } else if (fs.existsSync(path.join(resolvedDirectory, COMMAND_EVE_HERMES_RUNTIME_PACKAGED_LOCK_FILE))) {
      return { ok: false, reason: 'artifact_runtime_lock_unexpected' };
    }
    const actualTree = artifactTreeFiles(resolvedDirectory, receipt);
    if (JSON.stringify(actualTree) !== JSON.stringify(receipt.tree_files)) {
      return { ok: false, reason: 'artifact_tree_mismatch' };
    }
    if (treeRootSha256(actualTree) !== receipt.tree_root_sha256) {
      return { ok: false, reason: 'artifact_tree_root_mismatch' };
    }
    verified = {
      runtimeKey,
      receiptSha256: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
      treeRootSha256: receipt.tree_root_sha256,
      treePhase: treePhase as 'staged' | 'signed',
      ...(lockSha256 ? { lockSha256 } : {}),
      ...(packagedInterpreter ? { packagedInterpreter } : {}),
      packages,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'artifact_site_verification_failed' };
  }
  if (!verified) return { ok: false, reason: 'artifact_site_verification_incomplete' };
  return { ok: true, directory: resolvedDirectory, manifestPath: receiptPath, ...verified };
}

export function resolveCommandEveArtifactPythonSiteDir(env: NodeJS.ProcessEnv, resourcesPath?: string): string {
  const verification = resolveCommandEveArtifactPythonSite(env, resourcesPath);
  return verification.ok ? verification.directory : '';
}

/** Resolve and verify the first development/Windows artifact-site candidate exactly once. */
export function resolveCommandEveArtifactPythonSite(
  env: NodeJS.ProcessEnv,
  resourcesPath?: string
): CommandEveArtifactPythonSiteVerification {
  const candidates = [
    String(env[COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR_ENV] || '').trim(),
    resourcesPath ? path.join(resourcesPath, 'python', COMMAND_EVE_ARTIFACT_PYTHON_SITE_SUBDIR) : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const verification = verifyCommandEveArtifactPythonSite(candidate);
    if (verification.ok) return verification;
  }
  return { ok: false, reason: 'artifact_site_missing' };
}

/** Strict packaged resolver: the environment can never redirect the signed runtime outside Resources. */
export function resolveCommandEvePackagedArtifactPythonSite(
  resourcesPath?: string
): CommandEveArtifactPythonSiteVerification {
  if (!resourcesPath) return { ok: false, reason: 'artifact_site_missing' };
  const resourcesRoot = path.resolve(resourcesPath);
  const pythonRoot = path.join(resourcesRoot, 'python');
  const artifactSite = path.join(pythonRoot, COMMAND_EVE_ARTIFACT_PYTHON_SITE_SUBDIR);
  try {
    for (const directory of [resourcesRoot, pythonRoot, artifactSite]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: 'artifact_site_invalid' };
    }
    const resourcesReal = fs.realpathSync(resourcesRoot);
    const pythonReal = fs.realpathSync(pythonRoot);
    const artifactReal = fs.realpathSync(artifactSite);
    if (
      pythonReal !== path.join(resourcesReal, 'python') ||
      artifactReal !== path.join(pythonReal, COMMAND_EVE_ARTIFACT_PYTHON_SITE_SUBDIR)
    ) {
      return { ok: false, reason: 'artifact_site_invalid' };
    }
    const verification = verifyCommandEveArtifactPythonSite(artifactSite);
    return verification.ok &&
      verification.runtimeKey === 'darwin-arm64' &&
      verification.treePhase === 'signed' &&
      verification.packagedInterpreter
      ? { ...verification, resourcesRoot: resourcesReal }
      : {
          ok: false,
          reason: verification.ok
            ? verification.runtimeKey !== 'darwin-arm64'
              ? 'artifact_runtime_key_mismatch'
              : verification.treePhase !== 'signed'
                ? 'artifact_tree_not_signed'
                : 'artifact_runtime_interpreter_invalid'
            : 'reason' in verification
              ? verification.reason
              : 'artifact_site_invalid',
        };
  } catch {
    return { ok: false, reason: 'artifact_site_invalid' };
  }
}

export function resolveCommandEvePackagedArtifactPythonSiteDir(resourcesPath?: string): string {
  const verification = resolveCommandEvePackagedArtifactPythonSite(resourcesPath);
  return verification.ok ? verification.directory : '';
}

export function commandEvePresentationPythonProbeArgs(artifactSiteDirectory = ''): string[] {
  const statements = COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES.flatMap((entry) => [
    `assert version(${JSON.stringify(entry.name)}) == ${JSON.stringify(entry.version)}`,
    `assert_artifact_origin(${JSON.stringify(entry.importName)})`,
  ]);
  if (!artifactSiteDirectory) {
    return [
      // -I implies -E, so Python ignores PYTHONDONTWRITEBYTECODE from the
      // parent environment. Keep -B explicit or the first packaged probe can
      // create __pycache__ inside the signed app and invalidate its code seal.
      '-B',
      '-I',
      '-P',
      '-c',
      `from importlib import import_module; from importlib.metadata import version; assert_artifact_origin = import_module; ${statements.join('; ')}; print('PRESENTATION_PYTHON_READY')`,
    ];
  }
  const source = `
from importlib import import_module
from importlib.metadata import version
from pathlib import Path
import sys
root = Path(${JSON.stringify(artifactSiteDirectory)}).resolve(strict=True)
assert sys.flags.isolated == 1 and sys.flags.safe_path == 1 and sys.flags.no_user_site == 1 and sys.flags.ignore_environment == 1
sys.path.insert(0, str(root))
def assert_artifact_origin(name):
    module = import_module(name)
    origin = getattr(getattr(module, "__spec__", None), "origin", None) or getattr(module, "__file__", None)
    resolved = Path(origin).resolve(strict=True)
    assert resolved == root or root in resolved.parents, f"untrusted origin for {name}: {resolved}"
${statements.join('\n')}
assert_artifact_origin("lxml.etree")
assert_artifact_origin("lxml.objectify")
assert_artifact_origin("PIL._imaging")
from PIL import __version__ as pillow_version
from openpyxl import DEFUSEDXML
assert pillow_version == "12.3.0" and DEFUSEDXML is True
print("PRESENTATION_PYTHON_READY")
`;
  return ['-B', '-I', '-P', '-S', '-c', source];
}

export function commandEvePresentationPythonInstallArgs(bundleDir: string): string[] {
  return [
    '-m',
    'pip',
    'install',
    '--no-deps',
    '--no-index',
    '--find-links',
    bundleDir,
    ...COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES.map((entry) => `${entry.name}==${entry.version}`),
  ];
}
