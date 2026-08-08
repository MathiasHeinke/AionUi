/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `tray.ts` loaded WITHOUT Electron — the case `electronSafe` names this file as
 * the handler for.
 *
 * WHY THIS SUITE EXISTS AT ALL. Until now nothing executed the real `tray.ts`.
 * The one test that mentions it (`autoUpdaterTrayUpdateReady.test.ts:53`) mocks
 * the whole module away, so the thirteen unguarded dereferences of the shim's
 * nullable exports were never run by anything. A guard nobody exercises is a
 * claim, not a fix — this file is what turns the new early return into a
 * measured one.
 *
 * The environment is the fixture: under vitest `process.versions.electron` is
 * unset, so `loadElectron()` returns null (electronSafe.ts:57-63) and every
 * shim export really is null here. Nothing needs to be faked to reach the
 * branch — which is the point.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { activeCount: { invoke: vi.fn(async () => ({ count: 0 })) } },
  },
}));

vi.mock('@process/services/i18n', () => ({
  default: { t: (key: string) => key },
}));

const importTray = async () => await import('@process/utils/tray');

describe('tray without Electron', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('the shim really does hand this module nulls in this environment', async () => {
    // Pinning the premise. If Electron ever WERE present under vitest, every
    // assertion below would pass for the wrong reason.
    const shim = await import('@/common/electronSafe');
    expect(process.versions.electron).toBeUndefined();
    expect(shim.electronApp).toBeNull();
    expect(shim.electronMenu).toBeNull();
    expect(shim.electronTray).toBeNull();
    expect(shim.electronNativeImage).toBeNull();
  });

  it('does not build a tray, and does not throw doing it', async () => {
    const tray = await importTray();
    expect(() => tray.createOrUpdateTray()).not.toThrow();
  });

  it('says WHY it skipped, instead of reporting a tray defect', async () => {
    // The old behaviour reached `new Tray(...)` through `app.isPackaged` and
    // died with "Cannot read properties of null", which the broad catch logged
    // as "[Tray] Failed to create tray". That message blames the tray for the
    // absence of Electron. This assertion is the difference.
    const tray = await importTray();
    tray.createOrUpdateTray();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Electron is unavailable');
    expect(error).not.toHaveBeenCalled();
  });

  it('stays skipped on every later call, and the dependent entry points stay inert', async () => {
    // `tray` never becomes non-null, which is what keeps the menu path — and the
    // eight `app` dereferences inside it — unreachable for good.
    const tray = await importTray();
    tray.createOrUpdateTray();
    tray.createOrUpdateTray();

    await expect(tray.refreshTrayMenu()).resolves.toBeUndefined();
    expect(() => tray.destroyTray()).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  it('the state setters were always safe and stay safe', async () => {
    // These five touch no shim symbol; asserted so a later "tidy-up" that routes
    // them through `app` shows up here rather than in production.
    const tray = await importTray();
    expect(() => tray.setIsQuitting(true)).not.toThrow();
    expect(tray.getIsQuitting()).toBe(true);
    expect(() => tray.setCloseToTrayEnabled(true)).not.toThrow();
    expect(tray.getCloseToTrayEnabled()).toBe(true);
    expect(() => tray.setTrayUpdateReady('1.821.0')).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});
