import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rewriteArtifactPythonReceiptPostSign, treeRootSha256 } = require('./signArtifactPythonReceipt_core.js');

const RECEIPT_NAME = 'command-eve-artifact-python-runtime.json';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-post-sign-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, 'Command EVE.app');
  const siteDir = path.join(appPath, 'Contents', 'Resources', 'python', 'artifact-site-packages');
  fs.mkdirSync(path.join(siteDir, 'pptx'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'pptx', 'api.py'), 'class Presentation: ...\n', { mode: 0o644 });
  fs.writeFileSync(path.join(siteDir, 'native.so'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2]), { mode: 0o644 });
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
  return files.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
}

function writeStagingReceipt(siteDir) {
  const tree = enumerate(siteDir);
  const receipt = {
    version: 'command-eve-artifact-python-runtime/v1',
    network_install_allowed: false,
    tree_phase: 'staged',
    tree_root_sha256: treeRootSha256(tree),
    tree_files: tree,
    spread_files: [],
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

  const result = rewriteArtifactPythonReceiptPostSign(appPath);
  assert.equal(result.rewritten, true);

  const rewritten = JSON.parse(fs.readFileSync(path.join(siteDir, RECEIPT_NAME), 'utf8'));
  assert.equal(rewritten.tree_phase, 'signed');
  assert.notEqual(rewritten.tree_root_sha256, staging.tree_root_sha256);

  const expected = enumerate(siteDir);
  assert.deepEqual(rewritten.tree_files, expected);
  assert.equal(rewritten.tree_root_sha256, treeRootSha256(expected));
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
