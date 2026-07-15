/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectWindowsPackage,
  type BundledResourceVerifier,
} from '../../../../scripts/windows/windowsPackageInventoryCore.mjs';
import productIdentity from '../../../../scripts/windows/productIdentity.cjs';

const roots: string[] = [];
const VERSION = '1.8.11';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-win-package-'));
  roots.push(root);
  return root;
}

function writeFile(filePath: string, content = 'fixture'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function completeFixture(outDir: string): void {
  const resourcesDir = path.join(outDir, 'win-unpacked', 'resources');
  writeFile(path.join(outDir, `Command EVE-${VERSION}-win-x64.exe`));
  writeFile(path.join(outDir, `Command EVE-${VERSION}-win-x64.zip`));
  writeFile(path.join(outDir, 'latest.yml'), `version: ${VERSION}\n`);
  writeFile(path.join(outDir, 'win-unpacked', 'Command EVE.exe'));
  writeFile(path.join(resourcesDir, 'app.asar'));
  writeFile(path.join(resourcesDir, 'app-update.yml'), 'provider: generic\nurl: https://phase-a.invalid\n');
  writeFile(
    path.join(
      resourcesDir,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    )
  );
  writeFile(path.join(resourcesDir, 'bundled-aioncore', 'win32-x64', 'aioncore.exe'));
  writeFile(path.join(resourcesDir, 'python', 'python.exe'));
  writeFile(
    path.join(resourcesDir, 'python', 'command-eve-python-manifest.json'),
    JSON.stringify({
      schema_version: 'command-eve-bundled-python/v1',
      platform: 'win32',
      arch: 'x64',
      triple: 'x86_64-pc-windows-msvc',
      python_version: '3.12.13',
      release_tag: '20260610',
      archive_name: 'cpython-3.12.13+20260610-x86_64-pc-windows-msvc-install_only.tar.gz',
      archive_sha256: 'f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316',
      source_url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/fixture',
    })
  );
}

const passingVerifier: BundledResourceVerifier = () => ({
  runtimeKey: 'win32-x64',
  checked: ['bundled-aioncore/win32-x64/aioncore.exe'],
  missing: [],
});

const missingNodeVerifier: BundledResourceVerifier = () => ({
  runtimeKey: 'win32-x64',
  checked: [],
  missing: ['bundled-aioncore/win32-x64/managed-resources/node/*/node.exe'],
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Command EVE Windows package identity', () => {
  it('derives exact x64 artifact and executable names', () => {
    expect(productIdentity.windowsArtifactNames(VERSION, 'x64')).toEqual({
      installer: `Command EVE-${VERSION}-win-x64.exe`,
      zip: `Command EVE-${VERSION}-win-x64.zip`,
      metadata: 'latest.yml',
    });
    expect(productIdentity.WINDOWS_EXECUTABLE_NAME).toBe('Command EVE.exe');
  });

  it('rejects an unsafe version before it can become a filesystem path', () => {
    expect(() => productIdentity.windowsArtifactNames('../private', 'x64')).toThrow(
      'Windows artifact version is invalid'
    );
  });
});

describe('Windows package inventory', () => {
  it('accepts one complete Command EVE x64 package', () => {
    const outDir = makeRoot();
    completeFixture(outDir);

    const result = inspectWindowsPackage({
      outDir,
      version: VERSION,
      requirePython: true,
      requirePhaseAFeedIsolation: true,
      verifyBundledResources: passingVerifier,
    });

    expect(result.status).toBe('PASS');
    expect(result.errors).toEqual([]);
    expect(result.bundled_python.manifest).toMatchObject({ platform: 'win32', arch: 'x64' });
    expect(result.artifacts).toHaveLength(3);
    expect(result.runtime_keys).toEqual(['win32-x64']);
    expect(result.update_feed).toMatchObject({
      provider: 'generic',
      url: 'https://phase-a.invalid',
      isolated: true,
    });
  });

  it('rejects a production or missing update feed for the unsigned Phase A proof', () => {
    const outDir = makeRoot();
    completeFixture(outDir);
    const updateMetadataPath = path.join(outDir, 'win-unpacked', 'resources', 'app-update.yml');
    fs.writeFileSync(updateMetadataPath, 'provider: generic\nurl: https://eve-update-proxy.commandeve.workers.dev\n');

    const productionFeed = inspectWindowsPackage({
      outDir,
      version: VERSION,
      requirePhaseAFeedIsolation: true,
      verifyBundledResources: passingVerifier,
    });
    expect(productionFeed.status).toBe('REJECT');
    expect(productionFeed.errors).toContain('Phase A update feed is not isolated: expected https://phase-a.invalid');

    fs.rmSync(updateMetadataPath);
    const missingFeed = inspectWindowsPackage({
      outDir,
      version: VERSION,
      requirePhaseAFeedIsolation: true,
      verifyBundledResources: passingVerifier,
    });
    expect(missingFeed.status).toBe('REJECT');
    expect(missingFeed.errors).toContain('missing Phase A update metadata: resources/app-update.yml');
  });

  it('rejects a missing ZIP instead of accepting installer-only evidence', () => {
    const outDir = makeRoot();
    completeFixture(outDir);
    fs.rmSync(path.join(outDir, `Command EVE-${VERSION}-win-x64.zip`));

    const result = inspectWindowsPackage({ outDir, version: VERSION, verifyBundledResources: passingVerifier });

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain(`missing artifact: Command EVE-${VERSION}-win-x64.zip`);
  });

  it('rejects stale AionUi artifacts and multiple target runtimes', () => {
    const outDir = makeRoot();
    completeFixture(outDir);
    writeFile(path.join(outDir, 'AionUi-legacy-win-x64.exe'));
    fs.mkdirSync(path.join(outDir, 'win-unpacked', 'resources', 'bundled-aioncore', 'darwin-arm64'), {
      recursive: true,
    });

    const result = inspectWindowsPackage({ outDir, version: VERSION, verifyBundledResources: passingVerifier });

    expect(result.errors).toContain('stale AionUi artifact present: AionUi-legacy-win-x64.exe');
    expect(result.errors).toContain('expected exactly win32-x64 bundled runtime, found darwin-arm64, win32-x64');
  });

  it('propagates the existing bundled-resource verifier failure', () => {
    const outDir = makeRoot();
    completeFixture(outDir);

    const result = inspectWindowsPackage({
      outDir,
      version: VERSION,
      verifyBundledResources: missingNodeVerifier,
    });

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain(
      'missing bundled resource: bundled-aioncore/win32-x64/managed-resources/node/*/node.exe'
    );
  });

  it('turns a verifier exception into a structured rejection', () => {
    const outDir = makeRoot();
    completeFixture(outDir);

    const result = inspectWindowsPackage({
      outDir,
      version: VERSION,
      verifyBundledResources: () => {
        throw new Error('runtime manifest unreadable');
      },
    });

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain('bundled resource verification failed: runtime manifest unreadable');
    expect(result.completion_sentinel).toBe('WIN_PACKAGE_INVENTORY_COMPLETE');
  });

  it('rejects malformed update metadata through the YAML parser', () => {
    const outDir = makeRoot();
    completeFixture(outDir);
    writeFile(path.join(outDir, 'latest.yml'), 'version: [unterminated\n');

    const result = inspectWindowsPackage({ outDir, version: VERSION, verifyBundledResources: passingVerifier });

    expect(result.status).toBe('REJECT');
    expect(result.errors.some((error) => error.startsWith('latest.yml is invalid YAML:'))).toBe(true);
  });

  it('requires the staged Windows interpreter when the Phase A runtime gate is enabled', () => {
    const outDir = makeRoot();
    completeFixture(outDir);
    fs.rmSync(path.join(outDir, 'win-unpacked', 'resources', 'python', 'python.exe'));

    const result = inspectWindowsPackage({
      outDir,
      version: VERSION,
      requirePython: true,
      verifyBundledResources: passingVerifier,
    });

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain('missing bundled Windows Python: resources/python/python.exe');
  });

  it('rejects a missing or forged bundled-Python provenance manifest', () => {
    const outDir = makeRoot();
    completeFixture(outDir);
    const manifestPath = path.join(outDir, 'win-unpacked', 'resources', 'python', 'command-eve-python-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema_version: 'command-eve-bundled-python/v1',
        platform: 'win32',
        arch: 'x64',
        triple: 'x86_64-pc-windows-msvc',
        archive_sha256: '0'.repeat(64),
      })
    );

    const forged = inspectWindowsPackage({
      outDir,
      version: VERSION,
      requirePython: true,
      verifyBundledResources: passingVerifier,
    });
    expect(forged.status).toBe('REJECT');
    expect(forged.errors).toContain(
      'bundled Python provenance archive_sha256 mismatch: expected f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316, got ' +
        '0'.repeat(64)
    );

    fs.rmSync(manifestPath);
    const missing = inspectWindowsPackage({
      outDir,
      version: VERSION,
      requirePython: true,
      verifyBundledResources: passingVerifier,
    });
    expect(missing.status).toBe('REJECT');
    expect(missing.errors).toContain(
      'missing bundled Python provenance: resources/python/command-eve-python-manifest.json'
    );
  });
});
