/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { ipcBridge } from '@/common';
import { COMMAND_EVE_FILE_SELECTION_GRANT_CHANNEL } from '@/common/config/commandEveFileSelectionGrant';
import { registerCommandEveFileSelectionGrant } from '@process/commandEve/fileSelectionGrantCore';
import { getActiveSeatId } from '@process/commandEve/seatContextCore';

export function initDialogBridge(): void {
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
