/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow, Tray as TrayInstance } from 'electron';
import {
  electronApp as app,
  electronMenu as Menu,
  electronNativeImage as nativeImage,
  electronTray as Tray,
} from '@/common/electronSafe';
import * as path from 'path';
import { ipcBridge } from '@/common';
import { COMMAND_EVE_APP_NAME, COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import i18n from '@process/services/i18n';

let tray: TrayInstance | null = null;
/** Set with `tray`, cleared with it. Non-null exactly while a tray exists. */
let trayDeps: ElectronTrayDeps | null = null;
let closeToTrayEnabled = false;
let isQuitting = false;
let mainWindowRef: BrowserWindow | null = null;
let cachedActiveCount = 0;
/** Version of the downloaded update awaiting a restart, null when none is ready. */
let updateReadyVersion: string | null = null;

/**
 * The four shim exports, proven present — or null, once, for the whole process.
 *
 * WHY A BUNDLE AND NOT `?.` AT THIRTEEN SITES. The runtime branch in
 * `createOrUpdateTray` already decides the null case correctly, but a runtime
 * branch proves nothing to the compiler: `app` and friends are module-level
 * bindings, and narrowing one inside `createOrUpdateTray` says nothing inside
 * `getTrayIcon`. Answering that with optional chaining would have made twelve
 * silent no-ops out of twelve real calls.
 *
 * Resolving them into ONE value instead makes the fact checkable. Electron is
 * either present for this whole process or absent for all of it — there is no
 * state where `app` exists and `Menu` does not — so a single nullable bundle is
 * a truer model than four independent nullable bindings, and one guard narrows
 * all four at once. Every function below that needs them takes the narrowed
 * bundle as an argument, so the compiler carries the proof instead of the reader.
 */
type ElectronTrayDeps = {
  app: NonNullable<typeof app>;
  Menu: NonNullable<typeof Menu>;
  nativeImage: NonNullable<typeof nativeImage>;
  Tray: NonNullable<typeof Tray>;
};

const electronTrayDeps: ElectronTrayDeps | null =
  app && Menu && nativeImage && Tray ? { app, Menu, nativeImage, Tray } : null;

const isSecondaryTrayClick = (event: unknown): boolean => {
  if (!event || typeof event !== 'object') return false;
  const maybeNativeEvent = (event as { event?: { button?: number } }).event;
  return maybeNativeEvent?.button === 2;
};

export const setTrayMainWindow = (win: BrowserWindow): void => {
  mainWindowRef = win;
};

export const getCloseToTrayEnabled = (): boolean => closeToTrayEnabled;

export const setCloseToTrayEnabled = (enabled: boolean): void => {
  closeToTrayEnabled = enabled;
};

export const getIsQuitting = (): boolean => isQuitting;

export const setIsQuitting = (quitting: boolean): void => {
  isQuitting = quitting;
};

/**
 * Reflect the "update downloaded — restart to install" state in the tray menu.
 * Called by the auto-updater service whenever the merged updater status changes;
 * rebuilds the context menu so the update entry advertises the pending restart
 * instead of a plain "Check Update" while a downloaded build waits on disk.
 */
export const setTrayUpdateReady = (version: string | null): void => {
  if (updateReadyVersion === version) return;
  updateReadyVersion = version;
  rebuildTrayMenu();
};

/**
 * Get tray icon.
 * macOS uses Template image to adapt to dark/light menu bar.
 */
const getTrayIcon = (deps: ElectronTrayDeps): Electron.NativeImage => {
  const resourcesPath = deps.app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources');
  const icon = deps.nativeImage.createFromPath(path.join(resourcesPath, 'app.png'));
  if (process.platform === 'darwin') {
    return icon.resize({ width: 16, height: 16 });
  }
  return icon.resize({ width: 32, height: 32 });
};

/**
 * Build tray context menu (async to support dynamic content).
 */
const buildTrayContextMenu = async (deps: ElectronTrayDeps): Promise<Electron.Menu> => {
  const getRecentConversations = async (): Promise<Array<{ id: string; title: string }>> => {
    try {
      const result = await ipcBridge.database.getUserConversations.invoke({ limit: 5 });
      return (result.items || []).slice(0, 5).map((conv) => ({
        id: conv.id,
        title: conv.name || i18n.t('common.tray.untitled'),
      }));
    } catch {
      return [];
    }
  };

  const getRunningTasksCount = (): number => cachedActiveCount;

  const recentConversations = await getRecentConversations();
  const runningTasksCount = getRunningTasksCount();

  const showAndFocus = () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (process.platform === 'darwin' && deps.app.dock) {
        void deps.app.dock.show();
      }
      if (mainWindowRef.isMinimized()) {
        mainWindowRef.restore();
      }
      mainWindowRef.show();
      mainWindowRef.focus();
    }
  };

  const hideToTray = () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.hide();
      if (process.platform === 'darwin' && deps.app.dock) {
        void deps.app.dock.hide();
      }
    }
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: i18n.t('common.tray.showWindow'),
      click: showAndFocus,
    },
    {
      label: i18n.t('common.tray.closeToTray'),
      click: hideToTray,
    },
    { type: 'separator' },
    {
      label: i18n.t('common.tray.newChat'),
      click: () => {
        showAndFocus();
        mainWindowRef?.webContents.send('tray:navigate-to-guid');
      },
    },
  ];

  if (recentConversations.length > 0) {
    template.push({ type: 'separator' });
    template.push({
      label: i18n.t('common.tray.recentChats'),
      enabled: false,
    });
    for (const conv of recentConversations) {
      const displayTitle = conv.title.length > 20 ? conv.title.slice(0, 20) + '...' : conv.title;
      template.push({
        label: displayTitle,
        click: () => {
          showAndFocus();
          mainWindowRef?.webContents.send('tray:navigate-to-conversation', {
            conversation_id: conv.id,
          });
        },
      });
    }
  }

  template.push({ type: 'separator' });
  template.push({
    label: `${i18n.t('common.tray.runningTasks')}: ${runningTasksCount}`,
    enabled: false,
  });
  template.push({
    label: i18n.t('common.tray.pauseAll'),
    click: () => {
      showAndFocus();
      mainWindowRef?.webContents.send('tray:pause-all-tasks');
    },
  });

  template.push({ type: 'separator' });
  template.push({
    label: `🐾 ${i18n.t('pet.desktopPet')}`,
    submenu: [
      {
        label: i18n.t('pet.showHide'),
        click: async () => {
          try {
            const petManager = await import('../pet/petManager');
            // Toggle: if pet windows exist, hide; otherwise show/create
            petManager.showPetWindow();
          } catch {
            /* pet not available */
          }
        },
      },
      { type: 'separator' as const },
      {
        label: i18n.t('pet.sizeSmall', { px: 200 }),
        click: async () => {
          try {
            const { resizePetWindow } = await import('../pet/petManager');
            resizePetWindow(200);
          } catch {
            /* ignore */
          }
        },
      },
      {
        label: i18n.t('pet.sizeMedium', { px: 280 }),
        click: async () => {
          try {
            const { resizePetWindow } = await import('../pet/petManager');
            resizePetWindow(280);
          } catch {
            /* ignore */
          }
        },
      },
      {
        label: i18n.t('pet.sizeLarge', { px: 360 }),
        click: async () => {
          try {
            const { resizePetWindow } = await import('../pet/petManager');
            resizePetWindow(360);
          } catch {
            /* ignore */
          }
        },
      },
    ],
  });
  template.push({ type: 'separator' });
  template.push({
    label: updateReadyVersion
      ? i18n.t('common.tray.restartToInstallUpdate', { version: updateReadyVersion })
      : i18n.t('common.tray.checkUpdate'),
    click: () => {
      showAndFocus();
      mainWindowRef?.webContents.send('tray:check-update');
    },
  });
  template.push({ type: 'separator' });
  template.push({
    label: i18n.t('common.tray.about'),
    click: () => {
      showAndFocus();
      mainWindowRef?.webContents.send('tray:open-about');
    },
  });
  template.push({
    label: i18n.t('common.tray.restart'),
    click: () => {
      isQuitting = true;
      deps.app.relaunch();
      deps.app.exit(0);
    },
  });
  template.push({ type: 'separator' });
  template.push({
    label: i18n.t('common.tray.quit'),
    click: () => {
      isQuitting = true;
      deps.app.quit();
    },
  });

  return deps.Menu.buildFromTemplate(template);
};

/**
 * Create system tray (idempotent — no-op if already exists).
 *
 * THE NULL BRANCH electronSafe NAMES THIS FILE FOR. `electronApp`, `electronMenu`,
 * `electronNativeImage` and `electronTray` are all `| null`: the shim returns null
 * for every export when `process.versions.electron` is unset
 * (electronSafe.ts:57-63), which is any load outside the Electron main process.
 * The shim's header lists this file as an allowed importer precisely because it is
 * supposed to deal with that; until now it dereferenced all four unguarded.
 *
 * ONE BRANCH, NOT THIRTEEN `?.`. Optional chaining would build half a tray whose
 * menu handlers silently do nothing — worse than no tray, because it looks like
 * one. This single early return is a genuine choke point, and every use of the
 * four shim exports sits behind it:
 *
 *   - `getTrayIcon` (`app.isPackaged`, `nativeImage.createFromPath`) is called
 *     only from inside the `try` below;
 *   - `buildTrayContextMenu` (seven `app` uses, one `Menu.buildFromTemplate`) is
 *     reached only from here and from `rebuildTrayMenu`, which returns early
 *     unless a tray already exists;
 *   - `new deps.Tray(icon)` is this function;
 *   - the `tray.on('double-click', …)` handler, with its two `app.dock` uses, is
 *     registered only after the tray exists.
 *
 * So skipping construction closes all of them, and `tray` staying null keeps them
 * closed for every later call.
 *
 * NO LINE NUMBERS IN THIS LIST, DELIBERATELY. It carried thirteen of them and
 * they went wrong three times in a row, each time for the same mechanical
 * reason: every site listed here lives in the same file as the list, so editing
 * the list moves them. The first version cited :274/:275, which by then were two
 * lines of this very comment; the correction to :313/:314 was invalidated by the
 * six lines the correction itself added; introducing `ElectronTrayDeps` above
 * then moved the remaining ten. A citation that the act of writing it falsifies
 * is not a citation. Function names do not move, and `grep` finds them.
 *
 * The compiler now carries the same fact independently: `getTrayIcon` and
 * `buildTrayContextMenu` take `ElectronTrayDeps` as an argument, so there is no
 * longer a path to them that has not been through this branch.
 *
 * WHAT THIS IS NOT. On the shipped boot path the branch does not fire: this module
 * is reachable only from `index.ts` and three `process/` modules that themselves
 * load only in Electron main, and neither `packages/web-host` nor
 * `packages/web-cli` imports `@process/`. It fires for a non-Electron load — a
 * test, or any later reuse of this module outside main. Before, that case was
 * absorbed by the broad `catch` below and reported as
 * "[Tray] Failed to create tray: TypeError: Cannot read properties of null",
 * which reads like a tray defect rather than "there is no Electron here". Naming
 * the branch is the difference between an accident that happens to hold and a
 * decision. `trayWithoutElectron.test.ts` exercises it.
 */
export const createOrUpdateTray = (): void => {
  if (tray) {
    return;
  }
  const deps = electronTrayDeps;
  if (!deps) {
    console.warn('[Tray] Electron is unavailable in this process — skipping tray creation.');
    return;
  }
  trayDeps = deps;
  try {
    const icon = getTrayIcon(deps);
    tray = new deps.Tray(icon);
    tray.setToolTip(COMMAND_EVE_SHELL_ENABLED ? COMMAND_EVE_APP_NAME : 'AionUi');
    void buildTrayContextMenu(deps).then((menu) => tray?.setContextMenu(menu));

    tray.on('double-click', () => {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        if (process.platform === 'darwin' && deps.app.dock) {
          void deps.app.dock.show();
        }
        if (mainWindowRef.isMinimized()) {
          mainWindowRef.restore();
        }
        mainWindowRef.show();
        mainWindowRef.focus();
      }
    });

    tray.on('click', (event: unknown) => {
      if (isSecondaryTrayClick(event)) {
        void buildTrayContextMenu(deps).then((menu) => tray?.setContextMenu(menu));
      }
    });

    void fetchActiveCountAndMaybeRebuild();
  } catch (err) {
    console.error('[Tray] Failed to create tray:', err);
  }
};

/**
 * Rebuild tray menu with current cached state (synchronous wrapper).
 */
const rebuildTrayMenu = (): void => {
  // `trayDeps` is set in lockstep with `tray` and cleared with it, so in practice
  // the second half of this guard never decides anything. It is still written out
  // rather than asserted away: the pairing is an invariant of two module-level
  // bindings, and nothing but this line makes the compiler check that it holds.
  if (!tray || !trayDeps) return;
  void buildTrayContextMenu(trayDeps).then((menu) => tray?.setContextMenu(menu));
};

/**
 * Fetch active count from backend, update cache if changed, and rebuild menu.
 */
const fetchActiveCountAndMaybeRebuild = async (): Promise<void> => {
  try {
    const { count } = await ipcBridge.conversation.activeCount.invoke();
    if (count !== cachedActiveCount) {
      cachedActiveCount = count;
      rebuildTrayMenu();
    }
  } catch {
    // Keep last cached value on error
  }
};

/**
 * Refresh tray context menu labels (called on language change).
 * Immediately rebuilds with current cache, then fetches latest count.
 */
export const refreshTrayMenu = async (): Promise<void> => {
  rebuildTrayMenu();
  await fetchActiveCountAndMaybeRebuild();
};

/**
 * Destroy system tray.
 */
export const destroyTray = (): void => {
  if (tray) {
    tray.destroy();
    tray = null;
    trayDeps = null;
  }
};
