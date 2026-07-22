/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { MenuItemConstructorOptions, WebContents } from 'electron';
import { BrowserWindow, Menu, app } from 'electron';

export interface EditableContextMenuFlags {
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canDelete: boolean;
  canSelectAll: boolean;
}

/**
 * Native edit menu shown only for editable Chromium fields. Passwords never
 * leave the renderer through this hook: Electron executes standard edit roles
 * against the focused field and the main process receives no clipboard value.
 */
export function buildEditableContextMenuTemplate(
  flags: EditableContextMenuFlags,
  isMac = process.platform === 'darwin'
): MenuItemConstructorOptions[] {
  return [
    { role: 'undo', enabled: flags.canUndo },
    { role: 'redo', enabled: flags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: flags.canCut },
    { role: 'copy', enabled: flags.canCopy },
    { role: 'paste', enabled: flags.canPaste },
    ...(isMac ? ([{ role: 'pasteAndMatchStyle', enabled: flags.canPaste }] as MenuItemConstructorOptions[]) : []),
    { role: 'delete', enabled: flags.canDelete },
    { type: 'separator' },
    { role: 'selectAll', enabled: flags.canSelectAll },
  ];
}

const editableContextMenuBindings = new WeakSet<WebContents>();

/** Attach the native Cut/Copy/Paste menu exactly once to the main renderer. */
export function setupEditableContextMenu(webContents: WebContents): void {
  if (editableContextMenuBindings.has(webContents)) return;
  editableContextMenuBindings.add(webContents);

  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable || webContents.isDestroyed()) return;
    const menu = Menu.buildFromTemplate(buildEditableContextMenuTemplate(params.editFlags));
    const window = BrowserWindow.fromWebContents(webContents) ?? undefined;
    menu.popup({ window });
  });
}

export function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])
        : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Check for Updates...',
        click: () => {
          ipcBridge.update.open.emit({ source: 'menu' });
        },
      },
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
