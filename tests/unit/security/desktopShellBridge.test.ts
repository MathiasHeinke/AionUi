import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_SHELL_CHANNELS } from '@/common/config/desktopShellChannels';

const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
const state = vi.hoisted(() => ({ trusted: true }));
const electron = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
}));

vi.mock('@/common/adapter/main', () => ({
  isTrustedAdapterIpcSender: () => state.trusted,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, value: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  shell: electron,
}));

beforeEach(async () => {
  handlers.clear();
  state.trusted = true;
  electron.openExternal.mockReset().mockResolvedValue(undefined);
  electron.openPath.mockReset().mockResolvedValue('');
  electron.showItemInFolder.mockReset();
  vi.resetModules();
  await import('@/process/bridge/desktopShellBridge');
});

describe('desktop shell IPC bridge', () => {
  it('registers only the three bounded shell operations', () => {
    expect([...handlers.keys()].toSorted()).toEqual(Object.values(DESKTOP_SHELL_CHANNELS).toSorted());
  });

  it('blocks untrusted renderers before invoking the operating system', async () => {
    state.trusted = false;
    await expect(handlers.get(DESKTOP_SHELL_CHANNELS.openExternal)!({}, 'https://command-eve.com')).rejects.toThrow(
      'untrusted'
    );
    expect(electron.openExternal).not.toHaveBeenCalled();
  });

  it('validates external URLs before opening them', async () => {
    await handlers.get(DESKTOP_SHELL_CHANNELS.openExternal)!({}, 'https://command-eve.com/help');
    expect(electron.openExternal).toHaveBeenCalledWith('https://command-eve.com/help');

    await expect(
      handlers.get(DESKTOP_SHELL_CHANNELS.openExternal)!({}, 'javascript:alert(document.cookie)')
    ).rejects.toThrow('not allowed');
    expect(electron.openExternal).toHaveBeenCalledTimes(1);
  });

  it('opens and reveals only absolute file paths', async () => {
    await handlers.get(DESKTOP_SHELL_CHANNELS.openFile)!({}, '/tmp/report.pdf');
    await handlers.get(DESKTOP_SHELL_CHANNELS.showItemInFolder)!({}, '/tmp/report.pdf');

    expect(electron.openPath).toHaveBeenCalledWith('/tmp/report.pdf');
    expect(electron.showItemInFolder).toHaveBeenCalledWith('/tmp/report.pdf');
    await expect(handlers.get(DESKTOP_SHELL_CHANNELS.openFile)!({}, '../report.pdf')).rejects.toThrow('absolute');
  });

  it('converts an operating-system open failure into a renderer rejection', async () => {
    electron.openPath.mockResolvedValueOnce('No application is registered');
    await expect(handlers.get(DESKTOP_SHELL_CHANNELS.openFile)!({}, '/tmp/report.xyz')).rejects.toThrow(
      'could not open'
    );
  });
});
