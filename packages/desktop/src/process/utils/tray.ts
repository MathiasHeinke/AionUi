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
let closeToTrayEnabled = false;
let isQuitting = false;
let mainWindowRef: BrowserWindow | null = null;
let cachedActiveCount = 0;
/** Version of the downloaded update awaiting a restart, null when none is ready. */
let updateReadyVersion: string | null = null;

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
const getTrayIcon = (): Electron.NativeImage => {
  const resourcesPath = app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources');
  const icon = nativeImage.createFromPath(path.join(resourcesPath, 'app.png'));
  if (process.platform === 'darwin') {
    return icon.resize({ width: 16, height: 16 });
  }
  return icon.resize({ width: 32, height: 32 });
};

/**
 * Build tray context menu (async to support dynamic content).
 */
const buildTrayContextMenu = async (): Promise<Electron.Menu> => {
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
      if (process.platform === 'darwin' && app.dock) {
        void app.dock.show();
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
      if (process.platform === 'darwin' && app.dock) {
        void app.dock.hide();
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
      app.relaunch();
      app.exit(0);
    },
  });
  template.push({ type: 'separator' });
  template.push({
    label: i18n.t('common.tray.quit'),
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  return Menu.buildFromTemplate(template);
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
 * one. This single early return is a genuine choke point and covers every one of
 * the thirteen uses:
 *
 *   - `getTrayIcon` (:66 `app.isPackaged`, :67 `nativeImage.createFromPath`) is
 *     called only from inside the `try` below;
 *   - `buildTrayContextMenu` (:97, :98, :111, :112, :243, :244, :252 on `app`,
 *     :256 on `Menu`) is reached only from here and from `rebuildTrayMenu`, which
 *     already returns early on `!tray`;
 *   - `new Tray(icon)` is this function;
 *   - the double-click handler (:274, :275 on `app.dock`) is registered only after
 *     the tray exists.
 *
 * So skipping construction closes all of them, and `tray` staying null keeps them
 * closed for every later call.
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
  if (!app || !Menu || !nativeImage || !Tray) {
    console.warn('[Tray] Electron is unavailable in this process — skipping tray creation.');
    return;
  }
  try {
    const icon = getTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip(COMMAND_EVE_SHELL_ENABLED ? COMMAND_EVE_APP_NAME : 'AionUi');
    void buildTrayContextMenu().then((menu) => tray?.setContextMenu(menu));

    tray.on('double-click', () => {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        if (process.platform === 'darwin' && app.dock) {
          void app.dock.show();
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
        void buildTrayContextMenu().then((menu) => tray?.setContextMenu(menu));
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
  if (!tray) return;
  void buildTrayContextMenu().then((menu) => tray?.setContextMenu(menu));
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
  }
};
