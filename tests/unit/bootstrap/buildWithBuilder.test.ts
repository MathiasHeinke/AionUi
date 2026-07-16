/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');

describe('build-with-builder', () => {
  it.each([
    {
      args: ['arm64', '--win', '--arm64'],
      expectedError: 'Command EVE Phase A supports bundled Python on Windows x64 only.',
    },
    {
      args: ['auto', '--mac', '--x64'],
      expectedArch: 'x64',
    },
  ])('enforces the target contract for args $args', ({ args, expectedArch, expectedError }) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'aionui-build-test-'));
    const hookPath = join(tempDir, 'hook.cjs');
    const callsPath = join(tempDir, 'prepare-calls.json');
    const skillsSourcePath = join(tempDir, 'bundled-skills');
    const volatileBuildFiles = [
      resolve(repoRoot, 'out/.build-hash'),
      resolve(repoRoot, 'out/main/index.js'),
      resolve(repoRoot, 'out/renderer/index.html'),
    ];
    const buildFileSnapshots = new Map(
      volatileBuildFiles.map((filePath) => [filePath, existsSync(filePath) ? readFileSync(filePath) : null])
    );

    cpSync(resolve(repoRoot, 'resources/bundled-skills'), skillsSourcePath, { recursive: true });

    writeFileSync(
      hookPath,
      `
const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;

function recordPrepareCall(options) {
  const callsPath = process.env.AIONUI_PREPARE_CALLS_FILE;
  const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];
  calls.push(options ?? null);
  fs.writeFileSync(callsPath, JSON.stringify(calls));
  return { prepared: true, dir: 'mock-bundled-aioncore', sourceType: 'mock' };
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './prepareAioncore' || request.endsWith('/prepareAioncore')) {
    return recordPrepareCall;
  }

  if (request.endsWith('packages/shared-scripts/src/prepare-aioncore.js')) {
    return { prepareAioncore: recordPrepareCall };
  }

  if (request === './resolveAioncoreVersion.js' || request.endsWith('/resolveAioncoreVersion.js')) {
    return { resolveAioncoreVersion: () => 'v-test' };
  }

  return originalLoad.call(this, request, parent, isMain);
};

childProcess.execSync = function mockedExecSync(command) {
  const commandText = String(command);
  if (commandText.includes('electron-vite build')) {
    fs.mkdirSync(path.join(process.cwd(), 'out/main'), { recursive: true });
    fs.mkdirSync(path.join(process.cwd(), 'out/renderer'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'out/main/index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(process.cwd(), 'out/renderer/index.html'), '<!doctype html><html></html>');
  }
  return Buffer.from('');
};
`,
      'utf8'
    );

    try {
      const result = spawnSync(process.execPath, ['scripts/build-with-builder.js', ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AIONUI_PREPARE_CALLS_FILE: callsPath,
          COMMAND_EVE_SKILLS_SRC: skillsSourcePath,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${hookPath}`].filter(Boolean).join(' '),
        },
      });

      if (expectedError) {
        expect(result.status).toBe(1);
        expect(`${result.stderr}\n${result.stdout}`).toContain(expectedError);
        return;
      }

      expect(result.status, result.stderr || result.stdout).toBe(0);

      const calls = JSON.parse(readFileSync(callsPath, 'utf8')) as Array<{ arch?: string } | null>;
      expect(calls).toContainEqual(expect.objectContaining({ arch: expectedArch }));
    } finally {
      for (const [filePath, content] of buildFileSnapshots) {
        if (content === null) {
          rmSync(filePath, { force: true });
          continue;
        }
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
