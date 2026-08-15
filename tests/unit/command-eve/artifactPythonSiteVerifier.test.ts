/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pro-verdict Gate 2 (GPT-5.6-Pro 1.819 review): the signed artifact-site
 * verifier must fail closed on EVERY tree mutation — a flipped byte, an extra
 * file, a missing file, a tampered native module, a symlink, a tampered
 * receipt. These tests build a small synthetic artifact site with a
 * contract-valid receipt and then mutate exactly one thing per case.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES,
  COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT,
  COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION,
  COMMAND_EVE_HERMES_RUNTIME_PACKAGED_LOCK_FILE,
  COMMAND_EVE_HERMES_RUNTIME_LOCK_SHA256,
  COMMAND_EVE_HERMES_RUNTIME_PACKAGE_COUNT,
  COMMAND_EVE_HERMES_RUNTIME_STAGED_PACKAGE_COUNT,
  commandEveArtifactPythonPackages,
  verifyCommandEveArtifactPythonSite,
} from '@process/commandEve/presentationPythonRuntimeCore';

type TreeEntry = { root: string; path: string; mode: number; size: number; sha256: string };

const PYTHON_SIGNATURE = Object.freeze({
  authority: 'Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)',
  team_id: 'NHNQ7Q5H28',
  identifier: 'python3',
  cdhash: 'a'.repeat(40),
  hardened_runtime: true,
});

const RECEIPT_NAME = COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT;

// Mirrors artifactTreeFiles() in presentationPythonRuntimeCore.ts: enumerate
// every regular file except the receipt itself, hash it, and sort by
// `${root}/${path}`. Kept deliberately independent so a verifier regression
// cannot silently match a shared-helper change.
function enumerateTree(siteDir: string): TreeEntry[] {
  const files: TreeEntry[] = [];
  const visit = (current: string) => {
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
        sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
      });
    }
  };
  visit(siteDir);
  return files.toSorted((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
}

function treeRootSha256(files: TreeEntry[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function writeFile(siteDir: string, relativePath: string, content: string | Buffer): void {
  const target = path.join(siteDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o644 });
}

function buildReceipt(siteDir: string, overrides: Record<string, unknown> = {}): void {
  const treeFiles = enumerateTree(siteDir);
  const receipt = {
    version: COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION,
    build_manifest_version: 'command-eve-artifact-python-build/v1',
    python_version: '3.12.13',
    runtime_key: 'win32-x64',
    network_install_allowed: false,
    probe_status: 'pass',
    tree_phase: 'signed',
    tree_root_sha256: treeRootSha256(treeFiles),
    tree_files: treeFiles,
    spread_files: [],
    packages: commandEveArtifactPythonPackages('win32').map((entry) => ({
      name: entry.name,
      version: entry.version,
      import_name: entry.importName,
      wheel: entry.filename,
      wheel_sha256: entry.sha256,
      metadata_sha256: 'a'.repeat(64),
      wheel_tags: ['py3-none-any'],
      scope: 'common',
    })),
    ...overrides,
  };
  fs.writeFileSync(path.join(siteDir, RECEIPT_NAME), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
}

describe('signed artifact-site verifier — Pro Gate 2 mutation battery', () => {
  let siteDir = '';
  const tempRoots: string[] = [];

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-artifact-site-'));
    tempRoots.push(root);
    siteDir = path.join(root, 'python', 'artifact-site-packages');
    fs.mkdirSync(siteDir, { recursive: true });
    writeFile(siteDir, 'pptx/__init__.py', 'from pptx.api import Presentation\n');
    writeFile(siteDir, 'pptx/api.py', 'class Presentation: ...\n');
    writeFile(siteDir, 'PIL/__init__.py', '__version__ = "12.3.0"\n');
    writeFile(siteDir, 'PIL/_imaging.so', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
    writeFile(siteDir, 'lxml/etree.so', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 5, 6, 7, 8]));
    writeFile(siteDir, 'sbom.cyclonedx.json', '{"bomFormat":"CycloneDX"}\n');
    writeFile(siteDir, 'THIRD_PARTY_NOTICES.txt', 'notices\n');
    buildReceipt(siteDir);
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts the untouched signed tree (happy path)', () => {
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: true });
  });

  it('accepts the exact darwin-arm64 Hermes closure and rejects a missing locked package', () => {
    const sourceLock = fs.readFileSync(
      path.resolve('resources/bundled-python-artifacts/hermes-runtime-darwin-arm64.tsv')
    );
    writeFile(siteDir, COMMAND_EVE_HERMES_RUNTIME_PACKAGED_LOCK_FILE, sourceLock);
    const normalized = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
    const baseNames = new Set(COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES.map((entry) => normalized(entry.name)));
    const runtimePackages = fs
      .readFileSync(path.resolve('resources/bundled-python-artifacts/hermes-runtime-darwin-arm64.tsv'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [name, version, wheelSha256, source] = line.split('\t');
        return {
          name,
          version,
          import_name: '',
          wheel: path.posix.basename(
            source.startsWith('repo://') ? source.slice('repo://'.length) : new URL(source).pathname
          ),
          wheel_sha256: wheelSha256,
          metadata_sha256: 'b'.repeat(64),
          wheel_tags: ['py3-none-any'],
          scope: 'hermes-runtime',
        };
      })
      .filter((entry) => !baseNames.has(normalized(entry.name)));
    const packages = [
      ...COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES.map((entry) => ({
        name: entry.name,
        version: entry.version,
        import_name: entry.importName,
        wheel: entry.filename,
        wheel_sha256: entry.sha256,
        metadata_sha256: 'a'.repeat(64),
        wheel_tags: ['py3-none-any'],
        scope: 'common',
      })),
      ...runtimePackages,
    ];
    const hermesRuntime = {
      version: 'command-eve-hermes-runtime-site/v1',
      lock_file: COMMAND_EVE_HERMES_RUNTIME_PACKAGED_LOCK_FILE,
      lock_sha256: COMMAND_EVE_HERMES_RUNTIME_LOCK_SHA256,
      package_count: COMMAND_EVE_HERMES_RUNTIME_PACKAGE_COUNT,
      staged_package_count: COMMAND_EVE_HERMES_RUNTIME_STAGED_PACKAGE_COUNT,
      extras: ['acp', 'mcp'],
      network_install_allowed: false,
    };
    const pythonRoot = path.dirname(siteDir);
    writeFile(pythonRoot, 'bin/python3.12', '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(pythonRoot, 'bin', 'python3.12'), 0o755);
    writeFile(pythonRoot, 'command-eve-python-manifest.json', '{"version":"test"}\n');
    const runtimeFiles = ['bin/python3.12', 'command-eve-python-manifest.json'].map((relativePath) => {
      const file = path.join(pythonRoot, ...relativePath.split('/'));
      const stat = fs.lstatSync(file);
      return {
        path: relativePath,
        mode: stat.mode & 0o777,
        size: stat.size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        ...(relativePath === 'bin/python3.12' ? { code_signature: PYTHON_SIGNATURE } : {}),
      };
    });
    const treeFiles = [
      ...enumerateTree(siteDir),
      ...runtimeFiles.map(({ code_signature: _codeSignature, ...entry }) => ({ root: 'python-root', ...entry })),
    ].toSorted((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
    const darwinReceipt = {
      runtime_key: 'darwin-arm64',
      packages,
      hermes_runtime: hermesRuntime,
      runtime_files: runtimeFiles,
      tree_files: treeFiles,
      tree_root_sha256: treeRootSha256(treeFiles),
    };
    buildReceipt(siteDir, darwinReceipt);
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: true });

    buildReceipt(siteDir, {
      ...darwinReceipt,
      runtime_files: runtimeFiles.map((entry) =>
        entry.path === 'bin/python3.12'
          ? { ...entry, code_signature: { ...PYTHON_SIGNATURE, team_id: 'BADTEAM123' } }
          : entry
      ),
    });
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({
      ok: false,
      reason: 'artifact_runtime_file_identity_invalid',
    });
    buildReceipt(siteDir, darwinReceipt);

    fs.chmodSync(path.join(pythonRoot, 'bin', 'python3.12'), 0o644);
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: false });
    fs.chmodSync(path.join(pythonRoot, 'bin', 'python3.12'), 0o755);

    buildReceipt(siteDir, {
      ...darwinReceipt,
      packages: packages.map((entry) =>
        entry.name === 'websockets' ? { ...entry, name: 'websockets-unlocked' } : entry
      ),
      hermes_runtime: hermesRuntime,
    });
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({
      ok: false,
      reason: 'artifact_runtime_lock_mismatch:websockets',
    });
  });

  it('fails closed when one byte in a .py file changes', () => {
    fs.appendFileSync(path.join(siteDir, 'pptx', 'api.py'), '# tampered\n');
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: false, reason: 'artifact_tree_mismatch' });
  });

  it('fails closed when an extra pptx.py is added', () => {
    writeFile(siteDir, 'pptx.py', 'import os  # shadow attempt\n');
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: false, reason: 'artifact_tree_mismatch' });
  });

  it('fails closed when PIL/ gains an extra file', () => {
    writeFile(siteDir, 'PIL/ExtraModule.py', '# injected\n');
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: false, reason: 'artifact_tree_mismatch' });
  });

  it('fails closed when a RECORD-tracked file is removed from the tree', () => {
    fs.rmSync(path.join(siteDir, 'pptx', 'api.py'));
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: false, reason: 'artifact_tree_mismatch' });
  });

  it('fails closed when a native module is modified after signing', () => {
    const nativePath = path.join(siteDir, 'PIL', '_imaging.so');
    const bytes = fs.readFileSync(nativePath);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(nativePath, bytes);
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: false, reason: 'artifact_tree_mismatch' });
  });

  it('fails closed on a symlink inside the tree', () => {
    fs.symlinkSync(path.join(siteDir, 'pptx', 'api.py'), path.join(siteDir, 'pptx', 'linked.py'));
    const result = verifyCommandEveArtifactPythonSite(siteDir);
    expect(result.ok).toBe(false);
    expect(String(result.reason)).toContain('artifact_tree_symlink');
  });

  it('fails closed when the receipt tree root hash is tampered', () => {
    const receiptPath = path.join(siteDir, RECEIPT_NAME);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.tree_root_sha256 = 'b'.repeat(64);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({
      ok: false,
      reason: 'artifact_tree_root_mismatch',
    });
  });

  it('fails closed when a receipt wheel hash is tampered', () => {
    const receiptPath = path.join(siteDir, RECEIPT_NAME);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const pillow = receipt.packages.find((entry: { name?: string }) => entry.name === 'Pillow');
    pillow.wheel_sha256 = 'c'.repeat(64);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({
      ok: false,
      reason: 'artifact_package_mismatch:Pillow',
    });
  });

  it('fails closed when the tree root is recomputed over a mutated tree (stale receipt)', () => {
    // Attacker mutates a file AND rehashes the tree but cannot touch the
    // receipt: verifier compares actual tree against the SIGNED receipt.
    fs.appendFileSync(path.join(siteDir, 'lxml', 'etree.so'), Buffer.from([0x00]));
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({ ok: false, reason: 'artifact_tree_mismatch' });
  });

  it('fails closed when the receipt itself is missing', () => {
    fs.rmSync(path.join(siteDir, RECEIPT_NAME));
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({
      ok: false,
      reason: 'artifact_receipt_invalid',
    });
  });

  it('fails closed when tree_phase is outside the signed contract', () => {
    const receiptPath = path.join(siteDir, RECEIPT_NAME);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.tree_phase = 'unverified';
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({
      ok: false,
      reason: 'artifact_receipt_contract_mismatch',
    });
  });

  it('fails closed when network_install_allowed flips to true', () => {
    const receiptPath = path.join(siteDir, RECEIPT_NAME);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.network_install_allowed = true;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(verifyCommandEveArtifactPythonSite(siteDir)).toMatchObject({
      ok: false,
      reason: 'artifact_receipt_contract_mismatch',
    });
  });
});
