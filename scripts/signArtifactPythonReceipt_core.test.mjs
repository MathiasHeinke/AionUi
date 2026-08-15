import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  prepareArtifactPythonSiteForUpdater,
  rewriteArtifactPythonReceiptPostSign,
  treeRootSha256,
} = require('./signArtifactPythonReceipt_core.js');

const RECEIPT_NAME = 'command-eve-artifact-python-runtime.json';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// Restore write permission so afterEach cleanup can remove read-only-locked trees.
function makeWritable(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      fs.chmodSync(target, 0o755);
      makeWritable(target);
    } else if (entry.isFile()) {
      fs.chmodSync(target, 0o644);
    }
  }
}

function makeApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-post-sign-receipt-'));
  t.after(() => {
    try {
      makeWritable(root);
    } catch {
      // best-effort restore before removal
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appPath = path.join(root, 'Command EVE.app');
  const siteDir = path.join(appPath, 'Contents', 'Resources', 'python', 'artifact-site-packages');
  const pythonRoot = path.dirname(siteDir);
  fs.mkdirSync(path.join(siteDir, 'pptx'), { recursive: true });
  fs.mkdirSync(path.join(pythonRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'pptx', 'api.py'), 'class Presentation: ...\n', { mode: 0o644 });
  fs.writeFileSync(path.join(siteDir, 'native.so'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2]), { mode: 0o644 });
  fs.writeFileSync(path.join(pythonRoot, 'bin', 'python3.12'), 'signed-interpreter-before-codesign', { mode: 0o755 });
  fs.writeFileSync(path.join(pythonRoot, 'command-eve-python-manifest.json'), '{"version":1}\n', { mode: 0o644 });
  return { appPath, siteDir };
}

function enumerate(siteDir) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile() || target === path.join(siteDir, RECEIPT_NAME)) continue;
      const stat = fs.lstatSync(target);
      files.push({
        root: 'artifact-site',
        path: path.relative(siteDir, target).split(path.sep).join('/'),
        mode: stat.mode & 0o777,
        size: stat.size,
        sha256: sha256File(target),
      });
    }
  };
  visit(siteDir);
  const pythonRoot = path.dirname(siteDir);
  for (const relativePath of ['bin/python3.12', 'command-eve-python-manifest.json']) {
    const target = path.join(pythonRoot, ...relativePath.split('/'));
    const stat = fs.lstatSync(target);
    files.push({
      root: 'python-root',
      path: relativePath,
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: sha256File(target),
    });
  }
  return files.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
}

function writeStagingReceipt(siteDir) {
  const tree = enumerate(siteDir);
  const runtimeFiles = tree
    .filter((entry) => entry.root === 'python-root')
    .map(({ path: relativePath, mode, size, sha256 }) => ({ path: relativePath, mode, size, sha256 }));
  const receipt = {
    version: 'command-eve-artifact-python-runtime/v1',
    runtime_key: 'darwin-arm64',
    network_install_allowed: false,
    tree_phase: 'staged',
    tree_root_sha256: treeRootSha256(tree),
    tree_files: tree,
    spread_files: [],
    runtime_files: runtimeFiles,
    packages: [],
  };
  fs.writeFileSync(path.join(siteDir, RECEIPT_NAME), JSON.stringify(receipt));
  return receipt;
}

test('post-sign rewrite refreshes stale native hashes and flips tree_phase to signed', (t) => {
  const { appPath, siteDir } = makeApp(t);
  const staging = writeStagingReceipt(siteDir);

  // Simulate codesign rewriting the Mach-O bytes after staging.
  fs.appendFileSync(path.join(siteDir, 'native.so'), Buffer.from([0xaa]));
  fs.appendFileSync(path.join(path.dirname(siteDir), 'bin', 'python3.12'), Buffer.from([0xbb]));

  const result = rewriteArtifactPythonReceiptPostSign(appPath);
  assert.equal(result.rewritten, true);

  const rewritten = JSON.parse(fs.readFileSync(path.join(siteDir, RECEIPT_NAME), 'utf8'));
  assert.equal(rewritten.tree_phase, 'signed');
  assert.notEqual(rewritten.tree_root_sha256, staging.tree_root_sha256);

  const expected = enumerate(siteDir);
  assert.deepEqual(rewritten.tree_files, expected);
  assert.equal(rewritten.tree_root_sha256, treeRootSha256(expected));
  assert.deepEqual(rewritten.runtime_files.map((entry) => entry.path).sort(), [
    'bin/python3.12',
    'command-eve-python-manifest.json',
  ]);
  assert.equal(
    rewritten.runtime_files.find((entry) => entry.path === 'bin/python3.12').sha256,
    sha256File(path.join(path.dirname(siteDir), 'bin', 'python3.12'))
  );
});

test('post-sign rewrite skips gracefully without an artifact site (non-bundle build)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-post-sign-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = rewriteArtifactPythonReceiptPostSign(path.join(root, 'Command EVE.app'));
  assert.deepEqual(result, { rewritten: false, reason: 'no-artifact-site' });
});

test('post-sign rewrite fails closed when the receipt is missing inside an existing site', (t) => {
  const { appPath } = makeApp(t);
  assert.throws(() => rewriteArtifactPythonReceiptPostSign(appPath), /staging receipt is missing/);
});

test('post-sign rewrite fails closed on a symlink inside the tree', (t) => {
  const { appPath, siteDir } = makeApp(t);
  writeStagingReceipt(siteDir);
  fs.symlinkSync(path.join(siteDir, 'pptx', 'api.py'), path.join(siteDir, 'linked.py'));
  assert.throws(() => rewriteArtifactPythonReceiptPostSign(appPath), /symlink/);
});

test('updater preparation makes files 0644 and dirs 0755, and the receipt records those modes', (t) => {
  const { appPath, siteDir } = makeApp(t);
  writeStagingReceipt(siteDir);

  const preparation = prepareArtifactPythonSiteForUpdater(appPath);
  assert.equal(preparation.prepared, true);
  assert.ok(preparation.files >= 3);

  const fileMode = fs.statSync(path.join(siteDir, 'pptx', 'api.py')).mode & 0o777;
  const dirMode = fs.statSync(path.join(siteDir, 'pptx')).mode & 0o777;
  assert.equal(fileMode, 0o644);
  assert.equal(dirMode, 0o755);

  const result = rewriteArtifactPythonReceiptPostSign(appPath);
  assert.equal(result.rewritten, true);
  const rewritten = JSON.parse(fs.readFileSync(path.join(siteDir, RECEIPT_NAME), 'utf8'));
  const apiEntry = rewritten.tree_files.find((entry) => entry.path === 'pptx/api.py');
  assert.equal(apiEntry.mode, 0o644);
  assert.equal(fs.statSync(path.join(siteDir, RECEIPT_NAME)).mode & 0o777, 0o644);
});

test(
  'updater-prepared tree permits ShipIt quarantine removal on macOS',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const { appPath, siteDir } = makeApp(t);
    writeStagingReceipt(siteDir);
    prepareArtifactPythonSiteForUpdater(appPath);

    const quarantineValue = '0083;00000000;Command EVE updater regression test;';
    execFileSync('xattr', ['-w', 'com.apple.quarantine', quarantineValue, siteDir]);
    execFileSync('xattr', ['-w', 'com.apple.quarantine', quarantineValue, path.join(siteDir, 'pptx', 'api.py')]);

    assert.doesNotThrow(() => execFileSync('xattr', ['-dr', 'com.apple.quarantine', siteDir]));
  }
);

test('updater preparation skips gracefully without an artifact site', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-lock-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = prepareArtifactPythonSiteForUpdater(path.join(root, 'Command EVE.app'));
  assert.deepEqual(result, { prepared: false, reason: 'no-artifact-site' });
});
