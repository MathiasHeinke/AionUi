'use strict';

// Pure, testable logic for the post-sign Artifact Python receipt rewrite.
//
// Pro-verdict Gate 2/3 (GPT-5.6-Pro 1.819 review): `codesign` rewrites Mach-O
// bytes, so the staging receipt's per-file SHA-256 entries for .so/.dylib
// files are stale the moment afterSign deep-signs the bundled python tree.
// The runtime verifier (verifyCommandEveArtifactPythonSite) compares the
// LIVE packaged tree against the receipt byte-for-byte — without a post-sign
// receipt rewrite the notarized app would fail closed on every artifact
// import. This module re-enumerates the artifact-site tree AFTER signing and
// rewrites the receipt with tree_phase 'signed' and fresh hashes.
//
// No side effects at module scope: fs/crypto operations are injectable so the
// behavior is unit-testable without a real codesign run.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_NAME = 'command-eve-artifact-python-runtime.json';
const RECEIPT_VERSION = 'command-eve-artifact-python-runtime/v1';
const SITE_SUBDIR = path.join('python', 'artifact-site-packages');

function sha256File(filePath, fsDeps) {
  return crypto.createHash('sha256').update(fsDeps.readFileSync(filePath)).digest('hex');
}

// Mirrors artifactTreeFiles() in
// packages/desktop/src/process/commandEve/presentationPythonRuntimeCore.ts:
// enumerate every regular file in the artifact site except the receipt
// itself, reject symlinks/special files, and sort by `${root}/${path}`.
function enumerateSiteTree(siteDir, fsDeps) {
  const files = [];
  const visit = (current) => {
    for (const entry of fsDeps.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`post-sign receipt rewrite found a symlink: ${target}`);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!entry.isFile()) throw new Error(`post-sign receipt rewrite found a special file: ${target}`);
      if (target === path.join(siteDir, RECEIPT_NAME)) continue;
      const stat = fsDeps.lstatSync(target);
      files.push({
        root: 'artifact-site',
        path: path.relative(siteDir, target).split(path.sep).join('/'),
        mode: stat.mode & 0o777,
        size: stat.size,
        sha256: sha256File(target, fsDeps),
      });
    }
  };
  visit(siteDir);
  return files.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
}

// Re-hash the spread files (files the staging script spread into the python
// root outside the artifact site, e.g. .pth files). Their paths come from the
// existing receipt; a missing or tampered spread file fails the rewrite.
function refreshSpreadFiles(receipt, pythonRoot, fsDeps) {
  if (!Array.isArray(receipt.spread_files)) throw new Error('receipt spread_files contract invalid');
  return receipt.spread_files.map((entry) => {
    const relativePath = String(entry?.path || '');
    if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
      throw new Error(`receipt spread file path invalid: ${relativePath}`);
    }
    const target = path.resolve(pythonRoot, ...relativePath.split('/'));
    if (!fsDeps.existsSync(target)) throw new Error(`receipt spread file missing after sign: ${relativePath}`);
    const stat = fsDeps.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`receipt spread file invalid: ${relativePath}`);
    return {
      path: relativePath,
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: sha256File(target, fsDeps),
    };
  });
}

function treeRootSha256(files) {
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/**
 * Normalize the signed artifact-site tree to updater-compatible permissions.
 *
 * Squirrel/ShipIt removes com.apple.quarantine recursively from the extracted
 * update before replacing the installed app. Owner-read-only files/directories
 * (0o444/0o555) make that step fail with NSPOSIXErrorDomain/EACCES, so a valid
 * update is discarded and the old app is relaunched. Keep directories 0o755
 * and files 0o644 instead.
 *
 * Runtime integrity does not depend on filesystem immutability: the outer app
 * is code-signed, every artifact-site byte and mode is covered by the signed
 * receipt, the runtime verifier fails closed on drift, and packaged Python
 * entry points disable bytecode writes (PYTHONDONTWRITEBYTECODE=1, plus an
 * explicit -B for isolated probes because -I ignores PYTHON* env variables).
 * This function must run BEFORE rewriteArtifactPythonReceiptPostSign so the
 * receipt records the final installer-compatible modes.
 */
function prepareArtifactPythonSiteForUpdater(appPath, deps = {}) {
  const fsDeps = {
    existsSync: deps.existsSync || fs.existsSync,
    readdirSync: deps.readdirSync || fs.readdirSync,
    lstatSync: deps.lstatSync || fs.lstatSync,
    chmodSync: deps.chmodSync || fs.chmodSync,
  };
  const siteDir = path.join(appPath, 'Contents', 'Resources', SITE_SUBDIR);
  if (!fsDeps.existsSync(siteDir)) {
    return { prepared: false, reason: 'no-artifact-site' };
  }
  let files = 0;
  let directories = 1;
  const visit = (current) => {
    for (const entry of fsDeps.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`updater permission preparation found a symlink: ${target}`);
      if (entry.isDirectory()) {
        visit(target);
        fsDeps.chmodSync(target, 0o755);
        directories += 1;
      } else if (entry.isFile()) {
        fsDeps.chmodSync(target, 0o644);
        files += 1;
      } else {
        throw new Error(`updater permission preparation found a special file: ${target}`);
      }
    }
  };
  visit(siteDir);
  fsDeps.chmodSync(siteDir, 0o755);
  return { prepared: true, siteDir, files, directories };
}

/**
 * Rewrite the artifact-site runtime receipt after codesign has run.
 *
 * @param {string} appPath path to the packaged .app bundle
 * @param {object} [deps] injected fs surface for tests
 * @returns {{rewritten: boolean, reason?: string, receiptPath?: string, treeFiles?: number}}
 */
function rewriteArtifactPythonReceiptPostSign(appPath, deps = {}) {
  const fsDeps = {
    existsSync: deps.existsSync || fs.existsSync,
    readdirSync: deps.readdirSync || fs.readdirSync,
    lstatSync: deps.lstatSync || fs.lstatSync,
    readFileSync: deps.readFileSync || fs.readFileSync,
    writeFileSync: deps.writeFileSync || fs.writeFileSync,
  };

  const siteDir = path.join(appPath, 'Contents', 'Resources', SITE_SUBDIR);
  if (!fsDeps.existsSync(siteDir)) {
    return { rewritten: false, reason: 'no-artifact-site' };
  }
  const receiptPath = path.join(siteDir, RECEIPT_NAME);
  if (!fsDeps.existsSync(receiptPath)) {
    throw new Error(`Artifact Python site exists but its staging receipt is missing: ${receiptPath}`);
  }

  const receipt = JSON.parse(fsDeps.readFileSync(receiptPath, 'utf8'));
  if (receipt?.version !== RECEIPT_VERSION || receipt?.network_install_allowed !== false) {
    throw new Error('Artifact Python staging receipt violates its contract; refusing post-sign rewrite');
  }

  const pythonRoot = path.join(appPath, 'Contents', 'Resources', 'python');
  const treeFiles = enumerateSiteTree(siteDir, fsDeps);
  const spreadFiles = refreshSpreadFiles(receipt, pythonRoot, fsDeps);
  const allFiles = [...treeFiles, ...spreadFiles.map((entry) => ({ root: 'python-root', ...entry }))].sort(
    (left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`)
  );

  const rewritten = {
    ...receipt,
    tree_phase: 'signed',
    tree_root_sha256: treeRootSha256(allFiles),
    tree_files: allFiles,
    spread_files: spreadFiles,
  };
  fsDeps.writeFileSync(receiptPath, `${JSON.stringify(rewritten, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  return { rewritten: true, receiptPath, treeFiles: allFiles.length };
}

module.exports = {
  RECEIPT_NAME,
  RECEIPT_VERSION,
  enumerateSiteTree,
  prepareArtifactPythonSiteForUpdater,
  rewriteArtifactPythonReceiptPostSign,
  treeRootSha256,
};
