import { ipcMain, shell } from 'electron';

import { DESKTOP_SHELL_CHANNELS } from '@/common/config/desktopShellChannels';
import { isTrustedAdapterIpcSender } from '@/common/adapter/main';
import { parseDesktopAbsolutePath, parseDesktopExternalUrl } from '@/process/security/desktopShellCore';

ipcMain.handle(DESKTOP_SHELL_CHANNELS.openExternal, async (event, value: unknown) => {
  if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted desktop shell sender.');
  await shell.openExternal(parseDesktopExternalUrl(value));
});

ipcMain.handle(DESKTOP_SHELL_CHANNELS.openFile, async (event, value: unknown) => {
  if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted desktop shell sender.');
  const errorMessage = await shell.openPath(parseDesktopAbsolutePath(value));
  if (errorMessage) throw new Error('The operating system could not open the requested file.');
});

ipcMain.handle(DESKTOP_SHELL_CHANNELS.showItemInFolder, async (event, value: unknown) => {
  if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted desktop shell sender.');
  shell.showItemInFolder(parseDesktopAbsolutePath(value));
});
