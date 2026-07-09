/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { httpRequestMock, startWebHostMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  startWebHostMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/command-eve-test',
    getVersion: () => 'test',
    getAppPath: () => '/tmp/command-eve-test/app',
    isPackaged: false,
  },
}));

vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: httpRequestMock,
}));

vi.mock('@/process/utils/initStorage', () => ({
  getSystemDir: () => ({
    cacheDir: '/tmp/command-eve-test/cache',
    workDir: '/tmp/command-eve-test/work',
    logDir: '/tmp/command-eve-test/log',
  }),
}));

vi.mock('@/process/utils/utils', () => ({
  getDataPath: () => '/tmp/command-eve-test/data',
}));

vi.mock('@aionui/web-host', () => ({
  startWebHost: startWebHostMock,
}));

import {
  getDesktopWebUIStatus,
  restoreDesktopWebUIFromPreferences,
  startDesktopWebUI,
  stopDesktopWebUI,
} from '@/process/utils/webuiConfig';

const createHandle = (port: number, stop = vi.fn().mockResolvedValue(undefined)) => ({
  port,
  localUrl: `http://localhost:${port}`,
  stop,
});

describe('desktop WebUI remote-access gate', () => {
  beforeEach(async () => {
    await stopDesktopWebUI();
    httpRequestMock.mockReset();
    startWebHostMock.mockReset();
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = 30123;
  });

  it('rejects remote mode before starting a host', async () => {
    await expect(startDesktopWebUI({ port: 25809, allowRemote: true })).rejects.toThrow('REMOTE_WEBUI_DISABLED');

    expect(startWebHostMock).not.toHaveBeenCalled();
  });

  it('keeps a healthy local host running when remote mode is requested', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    startWebHostMock.mockResolvedValueOnce(createHandle(25809, stop));

    await startDesktopWebUI({ port: 25809, allowRemote: false });
    await expect(startDesktopWebUI({ port: 25809, allowRemote: true })).rejects.toThrow('REMOTE_WEBUI_DISABLED');

    expect(stop).not.toHaveBeenCalled();
    expect(startWebHostMock).toHaveBeenCalledTimes(1);
    expect(getDesktopWebUIStatus()).toMatchObject({ running: true, allowRemote: false, port: 25809 });
  });

  it('restores stale remote installations in local mode without disabling WebUI', async () => {
    httpRequestMock.mockImplementation(async (method: string) => {
      if (method === 'GET') {
        return {
          'webui.desktop.enabled': true,
          'webui.desktop.allowRemote': true,
          'webui.desktop.port': 26000,
        };
      }
      return undefined;
    });
    startWebHostMock.mockResolvedValueOnce(createHandle(26000));

    await restoreDesktopWebUIFromPreferences();

    expect(startWebHostMock).toHaveBeenCalledWith(expect.objectContaining({ port: 26000, allowRemote: false }));
    expect(httpRequestMock).toHaveBeenCalledWith('PUT', '/api/settings/client', {
      'webui.desktop.allowRemote': false,
    });
    expect(httpRequestMock).not.toHaveBeenCalledWith('PUT', '/api/settings/client', {
      'webui.desktop.enabled': false,
    });
    expect(getDesktopWebUIStatus()).toMatchObject({ running: true, allowRemote: false, port: 26000 });
  });
});
