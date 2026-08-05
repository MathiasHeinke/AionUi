/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773: the tray's update entry must reflect a downloaded, awaiting-restart
 * update so the state is visible even when the renderer banner is snoozed.
 * These tests pin the service -> tray wiring: update-downloaded advertises the
 * pending restart, a superseding release clears it, background re-checks keep
 * it, and service reset clears it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trayMock = vi.hoisted(() => ({
  setIsQuitting: vi.fn(),
  setTrayUpdateReady: vi.fn(),
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: { transports: { file: { level: 'info' } } },
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    channel: undefined as string | undefined,
    on: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.820.3', getPath: () => '/tmp/command-eve-test' },
}));
vi.mock('electron-log', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    transports: { file: { level: 'info' } },
  };
  return { default: log, ...log };
});
vi.mock('@/process/services/autoUpdateDiagnostics', () => ({
  recordAutoUpdateStatus: vi.fn(),
  recordAutoUpdateQuitAndInstall: vi.fn(),
}));
vi.mock('@process/utils/tray', () => trayMock);
vi.mock('@/common/config/commandEveShell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/config/commandEveShell')>()),
  get COMMAND_EVE_SHELL_ENABLED() {
    return true;
  },
}));

import { autoUpdaterService } from '@/process/services/autoUpdaterService';

const lastTrayCall = (): unknown[] | undefined => trayMock.setTrayUpdateReady.mock.calls.at(-1);

beforeEach(() => {
  trayMock.setIsQuitting.mockClear();
  trayMock.setTrayUpdateReady.mockClear();
  autoUpdaterService.resetForTest();
  autoUpdaterService.initialize();
});

afterEach(() => {
  autoUpdaterService.resetForTest();
});

describe('autoUpdaterService -> tray update-ready state', () => {
  it('advertises the downloaded version once update-downloaded fires', () => {
    autoUpdaterService.triggerEventForTest('update-downloaded', { version: '1.820.4' });
    expect(lastTrayCall()).toEqual(['1.820.4']);
  });

  it('keeps the pending restart advertised across background re-checks', () => {
    autoUpdaterService.triggerEventForTest('update-downloaded', { version: '1.820.4' });
    autoUpdaterService.triggerEventForTest('checking-for-update');
    expect(lastTrayCall()).toEqual(['1.820.4']);
    autoUpdaterService.triggerEventForTest('update-not-available');
    expect(lastTrayCall()).toEqual(['1.820.4']);
  });

  it('clears the entry when a newer release supersedes the downloaded build', () => {
    autoUpdaterService.triggerEventForTest('update-downloaded', { version: '1.820.4' });
    autoUpdaterService.triggerEventForTest('update-available', { version: '1.820.5' });
    expect(lastTrayCall()).toEqual([null]);
  });

  it('clears the entry on service reset', () => {
    autoUpdaterService.triggerEventForTest('update-downloaded', { version: '1.820.4' });
    autoUpdaterService.resetForTest();
    expect(lastTrayCall()).toEqual([null]);
  });
});
