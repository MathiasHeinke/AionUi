/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform-agnostic application bridge handlers.
 * Safe to use in both Electron and WebUI server mode.
 * Electron-only handlers (restart, devtools, zoom, CDP) remain in applicationBridge.ts.
 */
import os from 'os';
import path from 'path';
import { ipcBridge } from '@/common';
import { getSystemDir, ProcessEnv } from '@process/utils/initStorage';
import { copyDirectoryRecursively, getConfigPath, getDataPath, resolveCliSafePath } from '@process/utils';
import { stripActiveSeatScopeFromRoot } from '@process/commandEve/seatContextCore';

export function initApplicationBridgeCore(): void {
  // application.systemInfo is served by the backend via HTTP; updateSystemInfo
  // and getPath below remain buildProvider (true IPC) because they need
  // main-process-only APIs (copyDirectoryRecursively, os.homedir()).
  ipcBridge.application.updateSystemInfo.provider(async ({ cacheDir, workDir, logDir }) => {
    const oldDir = getSystemDir();
    const safeCacheDir = resolveCliSafePath(cacheDir, getConfigPath());
    const safeWorkDir = resolveCliSafePath(workDir, getDataPath());
    const safeLogDir = logDir ? resolveCliSafePath(logDir, oldDir.logDir) : oldDir.logDir;

    if (oldDir.cacheDir !== safeCacheDir) {
      await copyDirectoryRecursively(oldDir.cacheDir, safeCacheDir);
    }
    // ISO-4: the incoming cacheDir/workDir come from getSystemDir() and are
    // therefore SEAT-SCOPED when a non-legacy seat is active. `aionui.dir` is the
    // INSTALL-GLOBAL base override that initStorage re-seat-scopes on every boot,
    // so we must persist the BASE (de-seat-scoped) form — persisting the scoped
    // path verbatim would double-nest `.../seats/<id>/seats/<id>` on next boot.
    // For the legacy seat (the shipped default) this strip is a no-op → byte-
    // identical to 1.1.3.
    await ProcessEnv.set('aionui.dir', {
      cacheDir: stripActiveSeatScopeFromRoot(safeCacheDir),
      workDir: stripActiveSeatScopeFromRoot(safeWorkDir),
      logDir: safeLogDir,
    });
  });

  ipcBridge.application.getPath.provider(({ name }) => {
    // Resolve common paths without Electron
    const home = os.homedir();
    const map: Record<string, string> = {
      home,
      desktop: path.join(home, 'Desktop'),
      downloads: path.join(home, 'Downloads'),
    };
    return Promise.resolve(map[name] ?? home);
  });
}
