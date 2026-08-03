#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findMissingAsarUnpackEntries,
  listAsarUnpackEntries,
  listBuiltinMcpOutfiles,
  verifyBuiltinMcpPackaging,
} from './verify-builtin-mcp-packaging.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BUILD_SCRIPT_SNIPPET = `
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/eveArtifactContextServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-eve-artifacts.js'),
    }),
`;

const YML_SNIPPET = `asarUnpack:
  - '**/node_modules/better-sqlite3/**/*'
  # Builtin MCP server scripts must be unpacked so external node processes can execute them
  - 'out/main/builtin-mcp-image-gen.js'
  - 'out/main/builtin-mcp-eve-artifacts.js'
  - 'out/main/team-mcp-stdio.js'

compression: normal
`;

test('outfile extraction finds every builtin-mcp bundle and nothing else', () => {
  assert.deepEqual(listBuiltinMcpOutfiles(BUILD_SCRIPT_SNIPPET), [
    'out/main/builtin-mcp-eve-artifacts.js',
    'out/main/builtin-mcp-image-gen.js',
  ]);
  assert.deepEqual(listBuiltinMcpOutfiles("outfile: path.join(ROOT, 'out/main/team-mcp-stdio.js')"), []);
});

test('asarUnpack extraction reads the block and stops at the next top-level key', () => {
  assert.deepEqual(listAsarUnpackEntries(YML_SNIPPET), [
    '**/node_modules/better-sqlite3/**/*',
    'out/main/builtin-mcp-image-gen.js',
    'out/main/builtin-mcp-eve-artifacts.js',
    'out/main/team-mcp-stdio.js',
  ]);
});

test('the shipped defect shape is detected: image-gen unpacked, artifacts missing', () => {
  // This is exactly the 2026-08-03 shipping defect the MAT-1747 packaged
  // proof caught. If this assertion ever passes against the real files, the
  // verifier is blind.
  const missing = findMissingAsarUnpackEntries(
    ['out/main/builtin-mcp-eve-artifacts.js', 'out/main/builtin-mcp-image-gen.js'],
    ['out/main/builtin-mcp-image-gen.js']
  );
  assert.deepEqual(missing, ['out/main/builtin-mcp-eve-artifacts.js']);
});

test('the real shipping config covers every builtin MCP script the build emits', () => {
  const result = verifyBuiltinMcpPackaging({ projectRoot: PROJECT_ROOT });
  assert.equal(result.status, 'PASS', JSON.stringify(result, null, 2));
  assert.equal(result.ok, true);
});

test('a tampered yml (artifact script removed) fails closed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-packaging-gate-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'packages/desktop'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts/build-mcp-servers.js'), BUILD_SCRIPT_SNIPPET);
    fs.writeFileSync(
      path.join(tmp, 'packages/desktop/electron-builder.yml'),
      YML_SNIPPET.replace("  - 'out/main/builtin-mcp-eve-artifacts.js'\n", '')
    );
    const result = verifyBuiltinMcpPackaging({ projectRoot: tmp });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'FAIL_UNPACKED_MISSING');
    assert.match(result.detail, /builtin-mcp-eve-artifacts\.js/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--check-built fails closed when a built outfile is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-packaging-gate-built-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'packages/desktop'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'out/main'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts/build-mcp-servers.js'), BUILD_SCRIPT_SNIPPET);
    fs.writeFileSync(path.join(tmp, 'packages/desktop/electron-builder.yml'), YML_SNIPPET);
    fs.writeFileSync(path.join(tmp, 'out/main/builtin-mcp-image-gen.js'), '// built\n');
    const missing = verifyBuiltinMcpPackaging({ projectRoot: tmp, checkBuilt: true });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 'FAIL_NOT_BUILT');
    fs.writeFileSync(path.join(tmp, 'out/main/builtin-mcp-eve-artifacts.js'), '// built\n');
    const present = verifyBuiltinMcpPackaging({ projectRoot: tmp, checkBuilt: true });
    assert.equal(present.ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
