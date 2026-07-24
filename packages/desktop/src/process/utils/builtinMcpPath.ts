/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPlatformServices } from '@/common/platform';

function isPackagedRuntime(): boolean {
  try {
    return getPlatformServices().paths.isPackaged();
  } catch {
    // Pure helpers are imported by unit tests and child-process entrypoints
    // before Electron registers platform services. Those environments are not
    // packaged; deferring the platform dependency keeps module import inert.
    return false;
  }
}

function getBuiltinMcpBaseDir(): string {
  const mainModuleDir =
    typeof require !== 'undefined' && require.main?.filename ? path.dirname(require.main.filename) : __dirname;
  const baseDir = path.basename(mainModuleDir) === 'chunks' ? path.dirname(mainModuleDir) : mainModuleDir;
  // External node processes cannot read scripts from ASAR archives. Point at
  // the unpacked copy when the registered Electron runtime is packaged.
  return isPackagedRuntime() ? baseDir.replace('app.asar', 'app.asar.unpacked') : baseDir;
}

/**
 * Resolve a built-in MCP entry script without importing storage singletons.
 * The helper is intentionally side-effect free at module load so runtime-core
 * imports cannot initialize user storage or require registered Electron APIs.
 */
export function getBuiltinMcpScriptPath(scriptName: string): string {
  const baseDir = getBuiltinMcpBaseDir();
  const fileName = `${scriptName}.js`;
  const candidates = [
    path.resolve(baseDir, fileName),
    path.resolve(baseDir, 'out', 'main', fileName),
    path.resolve(baseDir, '..', fileName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}
