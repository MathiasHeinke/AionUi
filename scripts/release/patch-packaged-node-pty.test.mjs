import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COMMAND_EVE_NODE_PTY_PACKAGING_PATCH,
  assertPackagedNodePtyPatch,
  patchPackagedNodePty,
} from './patch-packaged-node-pty.mjs';

const ORIGINAL_SOURCE = [
  "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
  "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
  '',
].join('\n');

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-node-pty-patch-'));
  const resourcesPath = path.join(root, 'Resources');
  const packageRoot = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty');
  const unixTerminalPath = path.join(packageRoot, 'lib', 'unixTerminal.js');
  const releaseHelper = path.join(packageRoot, 'build', 'Release', 'spawn-helper');
  const prebuildHelper = path.join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  fs.mkdirSync(path.dirname(unixTerminalPath), { recursive: true });
  fs.mkdirSync(path.dirname(releaseHelper), { recursive: true });
  fs.mkdirSync(path.dirname(prebuildHelper), { recursive: true });
  fs.writeFileSync(unixTerminalPath, ORIGINAL_SOURCE);
  fs.writeFileSync(releaseHelper, 'release helper', { mode: 0o644 });
  fs.writeFileSync(prebuildHelper, 'prebuild helper', { mode: 0o644 });
  return { root, resourcesPath, packageRoot, unixTerminalPath, releaseHelper, prebuildHelper };
};

test('applies the reviewed Hermes ASAR fix and preserves executable helpers', () => {
  const value = fixture();
  const receipt = patchPackagedNodePty({ resourcesPath: value.resourcesPath });
  assert.equal(receipt.version, COMMAND_EVE_NODE_PTY_PACKAGING_PATCH);
  assert.equal(receipt.changed, true);
  assert.equal(assertPackagedNodePtyPatch(value.unixTerminalPath), COMMAND_EVE_NODE_PTY_PACKAGING_PATCH);
  assert.equal(fs.statSync(value.releaseHelper).mode & 0o777, 0o755);
  assert.equal(fs.statSync(value.prebuildHelper).mode & 0o777, 0o755);
});

test('is idempotent and fails closed when upstream code no longer matches', () => {
  const value = fixture();
  patchPackagedNodePty({ resourcesPath: value.resourcesPath });
  assert.equal(patchPackagedNodePty({ resourcesPath: value.resourcesPath }).changed, false);

  fs.writeFileSync(value.unixTerminalPath, 'unexpected upstream code\n');
  assert.throws(
    () => patchPackagedNodePty({ resourcesPath: value.resourcesPath }),
    /no longer matches the reviewed 1\.1\.0 ASAR contract/
  );
});
