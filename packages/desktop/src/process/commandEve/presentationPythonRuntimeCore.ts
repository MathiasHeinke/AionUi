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
  packages?: Array<{
    name?: unknown;
    version?: unknown;
    import_name?: unknown;
    wheel?: unknown;
    wheel_sha256?: unknown;
    metadata_sha256?: unknown;
    wheel_tags?: unknown;
  }>;
};

export type CommandEvePresentationPythonBundleVerification =
  | { ok: true; directory: string; manifestPath: string }
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
  return files.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
}

function treeRootSha256(files: ArtifactTreeFile[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
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

export function verifyCommandEveArtifactPythonSite(directory: string): CommandEvePresentationPythonBundleVerification {
  const resolvedDirectory = path.resolve(String(directory || ''));
  if (!directory || !fs.existsSync(resolvedDirectory)) return { ok: false, reason: 'artifact_site_missing' };
  const directoryStat = fs.lstatSync(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return { ok: false, reason: 'artifact_site_invalid' };
  }
  const receiptPath = path.join(resolvedDirectory, COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT);
  try {
    if (!fs.existsSync(receiptPath)) {
      return { ok: false, reason: 'artifact_receipt_invalid' };
    }
    const receiptStat = fs.lstatSync(receiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
      return { ok: false, reason: 'artifact_receipt_invalid' };
    }
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ArtifactPythonRuntimeReceipt;
    if (
      receipt.version !== COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION ||
      receipt.network_install_allowed !== false ||
      !['staged', 'signed'].includes(String(receipt.tree_phase || '')) ||
      typeof receipt.tree_root_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.tree_root_sha256) ||
      !Array.isArray(receipt.tree_files) ||
      !Array.isArray(receipt.spread_files) ||
      !Array.isArray(receipt.packages) ||
      receipt.packages.length !== COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES.length
    ) {
      return { ok: false, reason: 'artifact_receipt_contract_mismatch' };
    }
    for (const expected of COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES) {
      const declared = receipt.packages.find((entry) => entry?.name === expected.name);
      if (
        !declared ||
        declared.version !== expected.version ||
        declared.import_name !== expected.importName ||
        declared.wheel !== expected.filename ||
        declared.wheel_sha256 !== expected.sha256 ||
        typeof declared.metadata_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(declared.metadata_sha256) ||
        !Array.isArray(declared.wheel_tags) ||
        declared.wheel_tags.length === 0
      ) {
        return { ok: false, reason: `artifact_package_mismatch:${expected.name}` };
      }
    }
    const actualTree = artifactTreeFiles(resolvedDirectory, receipt);
    if (JSON.stringify(actualTree) !== JSON.stringify(receipt.tree_files)) {
      return { ok: false, reason: 'artifact_tree_mismatch' };
    }
    if (treeRootSha256(actualTree) !== receipt.tree_root_sha256) {
      return { ok: false, reason: 'artifact_tree_root_mismatch' };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'artifact_site_verification_failed' };
  }
  return { ok: true, directory: resolvedDirectory, manifestPath: receiptPath };
}

export function resolveCommandEveArtifactPythonSiteDir(env: NodeJS.ProcessEnv, resourcesPath?: string): string {
  const candidates = [
    String(env[COMMAND_EVE_ARTIFACT_PYTHON_SITE_DIR_ENV] || '').trim(),
    resourcesPath ? path.join(resourcesPath, 'python', COMMAND_EVE_ARTIFACT_PYTHON_SITE_SUBDIR) : '',
  ].filter(Boolean);
  return candidates.find((candidate) => verifyCommandEveArtifactPythonSite(candidate).ok) || '';
}

export function commandEvePresentationPythonProbeArgs(artifactSiteDirectory = ''): string[] {
  const statements = COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES.flatMap((entry) => [
    `assert version(${JSON.stringify(entry.name)}) == ${JSON.stringify(entry.version)}`,
    `assert_artifact_origin(${JSON.stringify(entry.importName)})`,
  ]);
  if (!artifactSiteDirectory) {
    return [
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
  return ['-I', '-P', '-S', '-c', source];
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
