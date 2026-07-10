import { afterEach, describe, expect, it, vi } from 'vitest';

import { preferElectronDesktopShell } from '@/common/adapter/desktopShellAdapter';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('desktop shell transport selection', () => {
  it('uses the Electron preload lane without touching the HTTP fallback', async () => {
    const openExternal = vi.fn(async () => undefined);
    const fallback = { provider: vi.fn(), invoke: vi.fn(async () => undefined) };
    vi.stubGlobal('window', { electronAPI: { desktopShell: { openExternal } } });

    await preferElectronDesktopShell('openExternal', fallback).invoke('https://command-eve.com');

    expect(openExternal).toHaveBeenCalledWith('https://command-eve.com');
    expect(fallback.invoke).not.toHaveBeenCalled();
  });

  it('keeps the HTTP transport as the WebUI and legacy-preload fallback', async () => {
    const fallback = { provider: vi.fn(), invoke: vi.fn(async () => undefined) };
    vi.stubGlobal('window', {});

    await preferElectronDesktopShell('openFile', fallback).invoke('/tmp/report.pdf');

    expect(fallback.invoke).toHaveBeenCalledWith('/tmp/report.pdf');
  });
});
