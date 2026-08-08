/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync as defaultExecFileSync } from 'node:child_process';

/**
 * OPTIONS ARE REQUIRED, and that is the fix rather than a cast.
 *
 * Node's `execFileSync` returns a Buffer when no encoding is given and a string
 * when `encoding: 'utf8'` is. Declaring `options?` here promised a `string` for
 * the no-options call shape too, which is why the real `execFileSync` was not
 * assignable to this type — the seam was claiming something the platform does
 * not do. The single caller (`readSysctlInt`) always passes both fields, so
 * requiring them describes the seam accurately and keeps the `string` return
 * honest.
 */
type ExecFileSync = (command: string, args: string[], options: { encoding: 'utf8'; timeout: number }) => string;

type StartupArchitectureCompatibilityEnv = {
  arch?: string;
  execFileSync?: ExecFileSync;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
};

export type StartupArchitectureMismatchDetails = {
  deviceArch: string;
  expectedDownloadArch: string;
  isPackaged: true;
  isRosettaTranslated: boolean;
  packageArch: string;
  platform: 'darwin';
  stage: 'startup_architecture_check';
};

export class StartupArchitectureMismatchError extends Error {
  readonly details: StartupArchitectureMismatchDetails;

  constructor(details: StartupArchitectureMismatchDetails) {
    super('AionUi package architecture does not match this Mac. Please download the matching package.');
    this.name = 'StartupArchitectureMismatchError';
    this.details = details;
  }
}

function readSysctlInt(name: string, execFileSync: ExecFileSync): number | undefined {
  try {
    const output = execFileSync('sysctl', ['-in', name], { encoding: 'utf8', timeout: 1000 }).trim();
    const value = Number(output);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function detectStartupArchitectureMismatch(
  env: StartupArchitectureCompatibilityEnv = {}
): StartupArchitectureMismatchDetails | null {
  const platform = env.platform ?? process.platform;
  const packageArch = env.arch ?? process.arch;
  const isPackaged = env.isPackaged ?? false;
  if (platform !== 'darwin' || !isPackaged || packageArch !== 'x64') {
    return null;
  }

  const execFileSync = env.execFileSync ?? defaultExecFileSync;
  const isRosettaTranslated = readSysctlInt('sysctl.proc_translated', execFileSync) === 1;
  const deviceSupportsArm64 = readSysctlInt('hw.optional.arm64', execFileSync) === 1;
  if (!isRosettaTranslated && !deviceSupportsArm64) {
    return null;
  }

  return {
    deviceArch: 'arm64',
    expectedDownloadArch: 'arm64',
    isPackaged: true,
    isRosettaTranslated,
    packageArch,
    platform: 'darwin',
    stage: 'startup_architecture_check',
  };
}

export function assertStartupArchitectureCompatible(env: StartupArchitectureCompatibilityEnv = {}): void {
  const mismatch = detectStartupArchitectureMismatch(env);
  if (!mismatch) return;
  throw new StartupArchitectureMismatchError(mismatch);
}
