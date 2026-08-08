import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertPackagedNodePtyPatch } from './patch-packaged-node-pty.mjs';

export const COMMAND_EVE_NODE_PTY_VERSION = '1.1.0';
export const COMMAND_EVE_NODE_PTY_SMOKE_SENTINEL = 'COMMAND_EVE_NODE_PTY_OK';

const fail = (message) => {
  throw new Error(`Packaged node-pty verification failed: ${message}`);
};

const requireFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) fail(`${label} is missing: ${filePath}`);
  const entry = fs.lstatSync(filePath);
  if (entry.isSymbolicLink()) fail(`${label} must not be a symlink: ${filePath}`);
  if (!entry.isFile()) fail(`${label} is not a file: ${filePath}`);
  return filePath;
};

const requireDirectory = (directoryPath, label) => {
  if (!fs.existsSync(directoryPath)) fail(`${label} is missing: ${directoryPath}`);
  const entry = fs.lstatSync(directoryPath);
  if (entry.isSymbolicLink()) fail(`${label} must not be a symlink: ${directoryPath}`);
  if (!entry.isDirectory()) fail(`${label} is not a directory: ${directoryPath}`);
  return directoryPath;
};

const runChecked = (runCommand, command, args, options, label) => {
  const result = runCommand(command, args, options);
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message || result?.stderr || result?.stdout || `status ${String(result?.status)}`;
    fail(`${label}: ${String(detail).trim()}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
};

const expectedMachOArchitectures = (expectedArch) => {
  if (expectedArch === 'x64') return ['x86_64'];
  if (expectedArch === 'universal') return ['arm64', 'x86_64'];
  return [expectedArch];
};

const parseCodesignMetadata = (output) => {
  const values = {};
  const authorities = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'Authority') authorities.push(value);
    else if (!(key in values)) values[key] = value;
  }
  return {
    signature: values.Signature,
    teamIdentifier: values.TeamIdentifier,
    authorities,
  };
};

export const resolvePackagedNodePty = ({ resourcesPath, expectedArch = 'arm64', platform = 'darwin' }) => {
  const packageRoot = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty');
  requireDirectory(packageRoot, 'node-pty package root');
  const packageJsonPath = requireFile(path.join(packageRoot, 'package.json'), 'package.json');
  requireFile(path.join(packageRoot, 'lib', 'index.js'), 'lib/index.js');
  assertPackagedNodePtyPatch(path.join(packageRoot, 'lib', 'unixTerminal.js'));

  const searchRoots = [
    path.join(packageRoot, 'build', 'Release'),
    path.join(packageRoot, 'build', 'Debug'),
    path.join(packageRoot, 'prebuilds', `${platform}-${expectedArch}`),
  ];
  let binaryRoot = null;
  for (const candidate of searchRoots) {
    if (!fs.existsSync(path.join(candidate, 'pty.node'))) continue;
    binaryRoot = candidate;
    break;
  }
  if (!binaryRoot) fail(`no runtime pty.node found under ${packageRoot}`);

  const ptyNodePath = requireFile(path.join(binaryRoot, 'pty.node'), 'pty.node');
  const spawnHelperPath = requireFile(path.join(binaryRoot, 'spawn-helper'), 'spawn-helper');
  if ((fs.statSync(spawnHelperPath).mode & 0o111) === 0) fail(`spawn-helper is not executable: ${spawnHelperPath}`);

  return { packageRoot, packageJsonPath, binaryRoot, ptyNodePath, spawnHelperPath };
};

export const verifyPackagedNodePty = ({
  resourcesPath,
  expectedArch = 'arm64',
  expectedVersion = COMMAND_EVE_NODE_PTY_VERSION,
  platform = 'darwin',
  electronExecutable,
  smokeScriptPath,
  requireElectronSmoke = false,
  runCommand = spawnSync,
}) => {
  const resolved = resolvePackagedNodePty({ resourcesPath, expectedArch, platform });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved.packageJsonPath, 'utf8'));
  } catch (error) {
    fail(`package.json is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.name !== 'node-pty' || manifest.version !== expectedVersion || manifest.main !== './lib/index.js') {
    fail(
      `unexpected package contract ${String(manifest.name)}@${String(manifest.version)} main=${String(manifest.main)}`
    );
  }

  const architectures = {};
  if (platform === 'darwin') {
    for (const [label, binaryPath] of [
      ['pty.node', resolved.ptyNodePath],
      ['spawn-helper', resolved.spawnHelperPath],
    ]) {
      const output = runChecked(
        runCommand,
        '/usr/bin/lipo',
        ['-archs', binaryPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        `${label} architecture probe`
      );
      const values = output.split(/\s+/).filter(Boolean);
      const expectedValues = expectedMachOArchitectures(expectedArch);
      if (values.toSorted().join(' ') !== expectedValues.toSorted().join(' ')) {
        fail(`${label} has [${values.join(', ')}], expected [${expectedValues.join(', ')}]`);
      }
      architectures[label] = values;
    }
  }

  let smoke = 'not-requested';
  let electronAbiSmoke = null;
  let smokePackageMode = 'not-requested';
  if (requireElectronSmoke) {
    if (!electronExecutable) fail('Electron ABI smoke was required but no Electron executable was provided');
    requireFile(smokeScriptPath, 'Electron ABI smoke script');
    smokePackageMode = 'packaged-tree';
    const output = runChecked(
      runCommand,
      electronExecutable,
      [smokeScriptPath, resolved.packageRoot],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
      'Electron ABI spawn smoke'
    );
    const receiptLine = output
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${COMMAND_EVE_NODE_PTY_SMOKE_SENTINEL} `));
    if (!receiptLine) fail('Electron ABI smoke returned no structured sentinel');
    let smokeReceipt;
    try {
      smokeReceipt = JSON.parse(receiptLine.slice(COMMAND_EVE_NODE_PTY_SMOKE_SENTINEL.length + 1));
    } catch (error) {
      fail(`Electron ABI smoke receipt is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (smokeReceipt.arch !== expectedArch) {
      fail(`Electron ABI smoke ran as ${String(smokeReceipt.arch)}, expected ${expectedArch}`);
    }
    if (!smokeReceipt.electron || !smokeReceipt.node || !smokeReceipt.modules) {
      fail('Electron ABI smoke omitted Electron, Node or module ABI metadata');
    }
    let loadedPtyNodePath;
    try {
      loadedPtyNodePath = fs.realpathSync(smokeReceipt.ptyNodePath);
    } catch {
      fail(`Electron ABI smoke loaded an unavailable binary: ${String(smokeReceipt.ptyNodePath)}`);
    }
    if (loadedPtyNodePath !== fs.realpathSync(resolved.ptyNodePath)) {
      fail(`Electron ABI smoke loaded ${String(smokeReceipt.ptyNodePath)}, expected ${resolved.ptyNodePath}`);
    }
    smoke = 'pass';
    electronAbiSmoke = smokeReceipt;
  }

  return {
    version: manifest.version,
    packageRoot: resolved.packageRoot,
    binaryRoot: resolved.binaryRoot,
    ptyNodePath: resolved.ptyNodePath,
    spawnHelperPath: resolved.spawnHelperPath,
    architectures,
    smoke,
    smokePackageMode,
    electronAbiSmoke,
  };
};

export const verifyPackagedNodePtySignatures = ({
  resourcesPath,
  expectedArch = 'arm64',
  platform = 'darwin',
  appPath,
  requireDeveloperId = false,
  runCommand = spawnSync,
}) => {
  const resolved = resolvePackagedNodePty({ resourcesPath, expectedArch, platform });
  let appMetadata = null;
  if (appPath) {
    runChecked(
      runCommand,
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', appPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      'outer app signature'
    );
  }
  if (requireDeveloperId) {
    if (!appPath) fail('Developer ID verification requires the outer app path');
    appMetadata = parseCodesignMetadata(
      runChecked(
        runCommand,
        '/usr/bin/codesign',
        ['--display', '--verbose=4', appPath],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        'outer app signing identity'
      )
    );
    if (!appMetadata.authorities[0]?.startsWith('Developer ID Application:')) {
      fail('outer app is not signed by a Developer ID Application authority');
    }
    if (!appMetadata.teamIdentifier || appMetadata.teamIdentifier === 'not set') {
      fail('outer app has no TeamIdentifier');
    }
  }

  const nativeMetadata = {};
  for (const [label, binaryPath] of [
    ['pty.node', resolved.ptyNodePath],
    ['spawn-helper', resolved.spawnHelperPath],
  ]) {
    runChecked(
      runCommand,
      '/usr/bin/codesign',
      ['--verify', '--strict', '--verbose=2', binaryPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      `${label} signature`
    );
    if (requireDeveloperId) {
      const metadata = parseCodesignMetadata(
        runChecked(
          runCommand,
          '/usr/bin/codesign',
          ['--display', '--verbose=4', binaryPath],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          `${label} signing identity`
        )
      );
      if (metadata.signature === 'adhoc' || !metadata.authorities[0]?.startsWith('Developer ID Application:')) {
        fail(`${label} is not signed by a Developer ID Application authority`);
      }
      if (metadata.teamIdentifier !== appMetadata.teamIdentifier) {
        fail(
          `${label} TeamIdentifier ${String(metadata.teamIdentifier)} does not match outer app ${appMetadata.teamIdentifier}`
        );
      }
      if (metadata.authorities[0] !== appMetadata.authorities[0]) {
        fail(`${label} Developer ID authority does not match the outer app`);
      }
      nativeMetadata[label] = metadata;
    }
  }
  return {
    ptyNodePath: resolved.ptyNodePath,
    spawnHelperPath: resolved.spawnHelperPath,
    appMetadata,
    nativeMetadata,
  };
};
