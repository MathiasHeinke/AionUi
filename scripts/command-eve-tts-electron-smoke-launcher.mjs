#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const smokeScript = path.join(scriptDir, 'command-eve-tts-electron-smoke.mjs');

const hardTimeoutMs = Number.parseInt(process.env.COMMAND_EVE_TTS_SMOKE_HARD_TIMEOUT_MS || '120000', 10);
const killGraceMs = 5000;
const startedAt = Date.now();

function print(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const child = spawn(electronPath, [smokeScript], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

let finished = false;
let timedOut = false;

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

const timeout = setTimeout(
  () => {
    if (finished) return;
    timedOut = true;
    print({
      ok: false,
      version: 'command-eve-tts-electron-smoke-launcher/v0',
      reason_code: 'EVE_MULTIMODAL_TTS_ELECTRON_LAUNCH_TIMEOUT',
      elapsed_ms: Date.now() - startedAt,
      electronPath,
    });
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!finished) child.kill('SIGKILL');
    }, killGraceMs);
  },
  Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0 ? hardTimeoutMs : 120000
);

child.on('error', (error) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  print({
    ok: false,
    version: 'command-eve-tts-electron-smoke-launcher/v0',
    reason_code: 'EVE_MULTIMODAL_TTS_ELECTRON_SPAWN_FAILED',
    message: error.message,
  });
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (timedOut) {
    process.exitCode = 1;
    return;
  }
  if (signal) {
    print({
      ok: false,
      version: 'command-eve-tts-electron-smoke-launcher/v0',
      reason_code: 'EVE_MULTIMODAL_TTS_ELECTRON_EXIT_SIGNAL',
      signal,
    });
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
