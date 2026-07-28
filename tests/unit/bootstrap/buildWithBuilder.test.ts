/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      expectedError:
        'Command EVE Desktop currently ships bundled Python on macOS arm64 only; x64/universal builds are blocked.',
    },
    {
      args: ['auto', '--mac', '--arm64', '--x64'],
      expectedError:
        'Command EVE Desktop currently ships bundled Python on macOS arm64 only; x64/universal builds are blocked.',
    },
    {
      args: ['arm64', '--mac', '--arm64'],
      expectedArch: 'arm64',
    },
  ])(
    'enforces the target contract for args $args',
    ({ args, expectedArch, expectedError }) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'aionui-build-test-'));
      const hookPath = join(tempDir, 'hook.cjs');
      const callsPath = join(tempDir, 'prepare-calls.json');
      const skillsSourcePath = join(tempDir, 'bundled-skills');
      const selftestOutDir = join(tempDir, 'out');

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
    const outDir = process.env.BUILD_WITH_BUILDER_SELFTEST_OUT_DIR;
    fs.mkdirSync(path.join(outDir, 'main'), { recursive: true });
    fs.mkdirSync(path.join(outDir, 'renderer'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'main/index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(outDir, 'renderer/index.html'), '<!doctype html><html></html>');
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
            BUILD_WITH_BUILDER_SELFTEST_OUT_DIR: selftestOutDir,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${hookPath}`].filter(Boolean).join(' '),
          },
        });

        if (expectedError) {
          expect(result.status).toBe(1);
          expect(`${result.stderr}\n${result.stdout}`).toContain(expectedError);
          return;
        }

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain('source=<committed-snapshot-only>');

        const calls = JSON.parse(readFileSync(callsPath, 'utf8')) as Array<{ arch?: string } | null>;
        expect(calls).toContainEqual(expect.objectContaining({ arch: expectedArch }));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    // 120s (was 30s). This case spawns a REAL `node scripts/build-with-builder.js`
    // child; the whole file costs 6.9s in isolation but the mac/arm64 case alone
    // ran past 30s inside the full suite (measured: the file took 32.2s there),
    // because `maxWorkers: '60%'` keeps heavy jsdom and process-spawning files
    // competing for cores. That is the same headroom problem vitest.config.ts
    // already documents at the suite level — its cap was tuned against 119 files
    // and the suite is now 533.
    //
    // Only the BUDGET moves. Nothing about the target contract this test asserts
    // is relaxed: a timeout can never turn a failing assertion green, and a real
    // hang now surfaces as a 120s stall instead of a red that says nothing about
    // the contract. Raising it is what keeps this gate readable; leaving it would
    // have made "suite green" unavailable for the 1.820 release for a reason
    // unrelated to any defect.
    120_000
  );
});
