/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ipcBridge } from '@/common';
import {
  COMMAND_EVE_APP_UPLOAD_GRANT_CHANNEL,
  COMMAND_EVE_FILE_SELECTION_GRANT_CHANNEL,
} from '@/common/config/commandEveFileSelectionGrant';
import {
  registerCommandEveAppOwnedUploadGrant,
  registerCommandEveFileSelectionGrant,
} from '@process/commandEve/fileSelectionGrantCore';
import { getActiveSeatId } from '@process/commandEve/seatContextCore';

export function initDialogBridge(): void {
  // Renderer HTTP uploads are not native picker selections. The main process
  // therefore verifies the returned path against AionCore's app-owned temp
  // root before granting it; arbitrary renderer paths remain rejected.
  ipcMain.handle(COMMAND_EVE_APP_UPLOAD_GRANT_CHANNEL, (event, filePath: unknown): boolean => {
    const sender = event.sender;
    const ownerWindow = BrowserWindow.fromWebContents(sender);
    const rejectionReason = !ownerWindow
      ? 'owner-window-missing'
      : ownerWindow.isDestroyed()
        ? 'owner-window-destroyed'
        : sender.isDestroyed()
          ? 'sender-destroyed'
          : !event.senderFrame
            ? 'sender-frame-missing'
            : event.senderFrame !== sender.mainFrame
              ? 'sender-frame-not-main'
              : null;
    if (rejectionReason) {
      console.warn(`[Command EVE] App-owned upload grant rejected before path verification: ${rejectionReason}`);
      return false;
    }
    const granted = registerCommandEveAppOwnedUploadGrant({
      filePath,
      tempDir: app.getPath('temp'),
      seatId: getActiveSeatId(),
    });
    if (!granted) {
      console.warn('[Command EVE] App-owned upload grant rejected by path verification.');
    }
    return granted;
  });

  // Drag/drop paths are resolved in the isolated preload through
  // webUtils.getPathForFile. The hidden sync channel records only that resolved
  // path; the renderer has no raw ipcRenderer surface with which to mint an
  // arbitrary grant.
  ipcMain.on(COMMAND_EVE_FILE_SELECTION_GRANT_CHANNEL, (event, filePath: unknown) => {
    event.returnValue = false;
    const sender = event.sender;
    const ownerWindow = BrowserWindow.fromWebContents(sender);
    if (
      !ownerWindow ||
      ownerWindow.isDestroyed() ||
      sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== sender.mainFrame
    ) {
      return;
    }
    event.returnValue = registerCommandEveFileSelectionGrant({
      filePath,
      seatId: getActiveSeatId(),
      purpose: 'read',
    });
  });

  ipcBridge.dialog.showOpen.provider((options) => {
    // Get the focused window or the first available window as parent
    // This ensures the dialog appears in front on Windows and has proper modal behavior
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const dialogOptions = {
      defaultPath: options?.defaultPath,
      properties: options?.properties,
    };

    const showDialogPromise = parentWindow
      ? dialog.showOpenDialog(parentWindow, dialogOptions)
      : dialog.showOpenDialog(dialogOptions);

    return showDialogPromise.then((res) => {
      for (const filePath of res.filePaths) {
        registerCommandEveFileSelectionGrant({ filePath, seatId: getActiveSeatId(), purpose: 'read' });
      }
      return res.filePaths;
    });
  });

  // Native SAVE dialog (RPT-1 report export). Returns the chosen path, or
  // undefined when the user cancels. Mirrors showOpen's parent-window handling.
  ipcBridge.dialog.showSave.provider((options) => {
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const dialogOptions = {
      defaultPath: options?.defaultPath,
      filters: options?.filters,
    };

    const showDialogPromise = parentWindow
      ? dialog.showSaveDialog(parentWindow, dialogOptions)
      : dialog.showSaveDialog(dialogOptions);

    return showDialogPromise.then((res) => {
      if (res.canceled || !res.filePath) return undefined;
      const granted = registerCommandEveFileSelectionGrant({
        filePath: res.filePath,
        seatId: getActiveSeatId(),
        purpose: 'write',
      });
      return granted ? res.filePath : undefined;
    });
  });
}
