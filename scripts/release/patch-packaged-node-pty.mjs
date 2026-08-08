import fs from 'node:fs';
import path from 'node:path';

// Adapted from the upstream Hermes Desktop fix merged as NousResearch/hermes-agent#65611.
// node-pty 1.1.0 otherwise rewrites an already-unpacked path to
// `app.asar.unpacked.unpacked` and the macOS spawn helper cannot launch.
export const COMMAND_EVE_NODE_PTY_PACKAGING_PATCH = 'command-eve-node-pty-packaging/v1';

const REWRITES = Object.freeze([
  {
    original: "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
    patched: "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked');",
  },
  {
    original: "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
    patched: "helperPath = helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked');",
  },
]);

const fail = (message) => {
  throw new Error(`Packaged node-pty patch failed: ${message}`);
};

const requireRegularFile = (filePath, label) => {
  if (!fs.existsSync(filePath)) fail(`${label} is missing: ${filePath}`);
  const entry = fs.lstatSync(filePath);
  if (entry.isSymbolicLink() || !entry.isFile()) fail(`${label} must be a regular file: ${filePath}`);
  return filePath;
};

export const patchPackagedNodePty = ({ resourcesPath, expectedArch = 'arm64', platform = 'darwin' }) => {
  const packageRoot = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty');
  const unixTerminalPath = requireRegularFile(
    path.join(packageRoot, 'lib', 'unixTerminal.js'),
    'node-pty unixTerminal.js'
  );
  const originalSource = fs.readFileSync(unixTerminalPath, 'utf8');
  let patchedSource = originalSource;
  for (const rewrite of REWRITES) {
    if (patchedSource.includes(rewrite.original)) {
      patchedSource = patchedSource.replace(rewrite.original, rewrite.patched);
    } else if (!patchedSource.includes(rewrite.patched)) {
      fail(`node-pty ${path.basename(unixTerminalPath)} no longer matches the reviewed 1.1.0 ASAR contract`);
    }
  }
  if (patchedSource !== originalSource) fs.writeFileSync(unixTerminalPath, patchedSource, 'utf8');

  const helperCandidates = [
    path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
    path.join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    path.join(packageRoot, 'prebuilds', `${platform}-${expectedArch}`, 'spawn-helper'),
  ];
  const helpers = [];
  for (const candidate of helperCandidates) {
    if (!fs.existsSync(candidate)) continue;
    requireRegularFile(candidate, 'node-pty spawn-helper');
    fs.chmodSync(candidate, 0o755);
    helpers.push(candidate);
  }
  if (helpers.length === 0) fail(`no spawn-helper found under ${packageRoot}`);

  return {
    version: COMMAND_EVE_NODE_PTY_PACKAGING_PATCH,
    packageRoot,
    unixTerminalPath,
    changed: patchedSource !== originalSource,
    helpers,
  };
};

export const assertPackagedNodePtyPatch = (unixTerminalPath) => {
  const source = fs.readFileSync(requireRegularFile(unixTerminalPath, 'node-pty unixTerminal.js'), 'utf8');
  for (const rewrite of REWRITES) {
    if (!source.includes(rewrite.patched) || source.includes(rewrite.original)) {
      fail('reviewed ASAR path patch is missing from packaged node-pty');
    }
  }
  return COMMAND_EVE_NODE_PTY_PACKAGING_PATCH;
};
