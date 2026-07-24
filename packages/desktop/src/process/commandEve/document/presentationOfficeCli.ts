/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandEvePresentationPreparationError } from './presentationIntelligenceTypes';

const PRESENTATION_MAX_OFFICECLI_JSON_BYTES = 16 * 1024 * 1024;
const PRESENTATION_OFFICECLI_TIMEOUT_MS = 120_000;

export function resolveOfficeCliPath(): string | null {
  const executable = process.platform === 'win32' ? 'officecli.exe' : 'officecli';
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', executable),
    ...(process.platform === 'win32' && process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, 'OfficeCli', executable)]
      : []),
    '/opt/homebrew/bin/officecli',
    '/usr/local/bin/officecli',
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
  ];
  for (const candidate of Array.from(new Set(candidates))) {
    try {
      const real = fs.realpathSync(candidate);
      const stat = fs.statSync(real);
      if (!stat.isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch {
      // Continue through the bounded known candidates.
    }
  }
  return null;
}

export function runOfficeCliJson(args: readonly string[]): Promise<unknown> {
  const executable = resolveOfficeCliPath();
  if (!executable) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_ENGINE_UNAVAILABLE',
      'The local presentation engine is not ready yet.'
    );
  }
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      executable,
      [...args],
      {
        timeout: PRESENTATION_OFFICECLI_TIMEOUT_MS,
        maxBuffer: PRESENTATION_MAX_OFFICECLI_JSON_BYTES,
        windowsHide: true,
        shell: false,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG || 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
          SystemRoot: process.env.SystemRoot,
          NO_COLOR: '1',
          // The office CLI resolves a system interpreter (e.g. python 3.13)
          // whose imports of the signed artifact site must never mutate it:
          // a stray __pycache__/*.pyc breaks the post-sign tree allowlist and
          // fails the bootstrap's signed-site verification on the NEXT launch.
          PYTHONDONTWRITEBYTECODE: '1',
        },
      },
      (error, stdout) => {
        if (error) {
          reject(
            new CommandEvePresentationPreparationError(
              'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
              'The local presentation engine could not process this deck.'
            )
          );
          return;
        }
        if (Buffer.byteLength(stdout, 'utf8') > PRESENTATION_MAX_OFFICECLI_JSON_BYTES) {
          reject(
            new CommandEvePresentationPreparationError(
              'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
              'The local presentation engine returned too much data.'
            )
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new CommandEvePresentationPreparationError(
              'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
              'The local presentation engine returned an invalid receipt.'
            )
          );
        }
      }
    );
  });
}
