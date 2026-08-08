/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @internal
 *
 * Null-safe Electron shim.
 *
 * PRODUCTION IMPORTERS — exactly one:
 *   - src/process/utils/tray.ts
 *
 * TEST IMPORTERS — exactly one:
 *   - tests/unit/command-eve/trayWithoutElectron.test.ts, via dynamic import, and
 *     only to pin the premise the branch in tray.ts rests on: that in a
 *     non-Electron process these exports really are null.
 *
 * All other modules must use getPlatformServices() from '@/common/platform' instead.
 *
 * Both lines above are checkable in one command, which is the only reason to write
 * an allowlist down at all:
 *
 *   rg -n "electronSafe'" packages/ tests/
 *
 * The previous wording said "today the ONLY importer in the repo" and was untrue
 * the moment it was committed — the same commit added the test importer. A
 * corrected allowlist that is itself false is worse than the stale one it
 * replaced, because it has just been vouched for. Splitting production from test
 * is what makes the claim survive its own grep.
 *
 * The list above used to name two more files, and both entries were false.
 * `src/process/services/conversionService.ts` does not exist anywhere in
 * `packages/` any more, and `src/common/platform/ElectronPlatformServices.ts` was
 * annotated in this very list as importing 'electron' directly rather than this
 * file — so it never belonged on a list of importers of this file at all. An
 * allowlist that names files which do not import the module cannot be checked
 * against reality by reading it, which is the only thing an allowlist is for.
 *
 * WHAT NULL MEANS HERE, since exactly one file has to act on it. Every export
 * below is null whenever `process.versions.electron` is unset — that is any load
 * outside the Electron main process. `tray.ts` handles that in one explicit
 * branch at the top of `createOrUpdateTray`, proved by
 * `tests/unit/command-eve/trayWithoutElectron.test.ts`. A second importer would
 * have to make the same decision for itself; nothing here makes it for them.
 */

// import type is erased at compile time — safe to use in this file
import type {
  BrowserWindow as BrowserWindowClass,
  Menu as MenuClass,
  NativeImage as NativeImageClass,
  Notification as NotificationClass,
  Tray as TrayClass,
} from 'electron';

/** Structural type for the module-level utilityProcess export (static side with fork()). */
interface UtilityProcessModule {
  fork(
    modulePath: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      [key: string]: unknown;
    }
  ): Electron.UtilityProcess;
}

/** Structural type for the module-level powerSaveBlocker export. */
interface PowerSaveBlockerModule {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

type ElectronModule = {
  app: Electron.App;
  utilityProcess: UtilityProcessModule;
  powerSaveBlocker: PowerSaveBlockerModule;
  BrowserWindow: typeof BrowserWindowClass;
  Menu: typeof MenuClass;
  nativeImage: { createFromPath(path: string): NativeImageClass };
  Notification: typeof NotificationClass;
  Tray: typeof TrayClass;
};

function loadElectron(): ElectronModule | null {
  if (process.versions?.electron) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron') as ElectronModule;
  }
  return null;
}

const _electron = loadElectron();

export const electronApp: Electron.App | null = _electron?.app ?? null;

export const electronUtilityProcess: UtilityProcessModule | null = _electron?.utilityProcess ?? null;

export const electronPowerSaveBlocker: PowerSaveBlockerModule | null = _electron?.powerSaveBlocker ?? null;

export const electronBrowserWindow: typeof BrowserWindowClass | null = _electron?.BrowserWindow ?? null;

export const electronNotification: typeof NotificationClass | null = _electron?.Notification ?? null;

export const electronMenu: typeof MenuClass | null = _electron?.Menu ?? null;

export const electronNativeImage: {
  createFromPath(path: string): NativeImageClass;
} | null = _electron?.nativeImage ?? null;

export const electronTray: typeof TrayClass | null = _electron?.Tray ?? null;
