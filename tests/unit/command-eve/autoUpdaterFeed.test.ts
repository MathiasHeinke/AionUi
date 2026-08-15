/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The autoUpdaterService module pulls in electron-updater / electron / electron-log
// which are not loadable under the vitest node env. Mock them with the minimal
// surface the module touches at import time so we can exercise the pure
// feed-resolution logic and the no-feed quiet state.
// vi.hoisted lets the mock factory (hoisted to top of file) safely reference this.
const { setFeedURL, checkForUpdates, checkForUpdatesAndNotify } = vi.hoisted(() => ({
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  checkForUpdatesAndNotify: vi.fn(),
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: { transports: { file: { level: 'info' } } },
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: undefined as string | undefined,
    on: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL,
    checkForUpdates,
    downloadUpdate: vi.fn(),
    checkForUpdatesAndNotify,
    quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0-alpha.5', getPath: () => '/tmp/command-eve-test' },
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

// Control the CE-shell flag deterministically so we can exercise BOTH the
// CE-scoped R2 default (shell on) AND the upstream quiet no-op (shell off)
// without depending on the test runner's AIONUI_UPSTREAM_MODE env. `shellEnabled`
// is mutable so individual tests can flip it before calling resolveUpdateFeedUrl
// (the service reads the live export at call time).
const ceShellState = vi.hoisted(() => ({ shellEnabled: true }));
// Spread the REAL module and override only the one dynamic flag the test toggles.
// (A full hand-written mock kept whack-a-mole'ing on missing exports — getConfigPath/
// getDataPath/initStorage pull a chain of dir-name + cli-safe-name exports; mirroring
// the real surface via importOriginal is robust to that chain.)
vi.mock('@/common/config/commandEveShell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/config/commandEveShell')>()),
  get COMMAND_EVE_SHELL_ENABLED() {
    return ceShellState.shellEnabled;
  },
}));

import {
  resolveUpdateFeedUrl,
  UPDATE_FEED_URL_ENV,
  UPDATE_FEED_URL_CONFIG_KEY,
  autoUpdaterService,
} from '@/process/services/autoUpdaterService';
import {
  COMMAND_EVE_UPDATE_FEED_BASE_URL,
  COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL,
} from '@/common/config/commandEveShell';
import { autoUpdater } from 'electron-updater';

const ORIGINAL_ENV = process.env[UPDATE_FEED_URL_ENV];

beforeEach(() => {
  delete process.env[UPDATE_FEED_URL_ENV];
  setFeedURL.mockClear();
  checkForUpdates.mockReset();
  checkForUpdatesAndNotify.mockReset();
  autoUpdaterService.reset();
  // Default to the Command EVE shell being ON for each test (the production
  // installed-app condition); upstream-quiet tests flip this explicitly.
  ceShellState.shellEnabled = true;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[UPDATE_FEED_URL_ENV];
  else process.env[UPDATE_FEED_URL_ENV] = ORIGINAL_ENV;
});

describe('resolveUpdateFeedUrl', () => {
  it('prefers the env var over the persisted config and the CE default', async () => {
    process.env[UPDATE_FEED_URL_ENV] = 'https://env.example/feed';
    const read = vi.fn(async () => 'https://config.example/feed');
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBe('https://env.example/feed');
    expect(read).not.toHaveBeenCalled();
  });

  it('falls back to the persisted config when env is unset', async () => {
    const read = vi.fn(async (key: typeof UPDATE_FEED_URL_CONFIG_KEY) => {
      expect(key).toBe(UPDATE_FEED_URL_CONFIG_KEY);
      return 'https://config.example/feed';
    });
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBe('https://config.example/feed');
  });

  it('trims and prefers a non-empty env over the config', async () => {
    process.env[UPDATE_FEED_URL_ENV] = '  https://env.example/feed  ';
    const read = vi.fn(async () => 'https://config.example/feed');
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBe('https://env.example/feed');
    expect(read).not.toHaveBeenCalled();
  });

  it('trims the persisted config value when env is unset', async () => {
    const read = vi.fn(async () => '  https://config.example/feed  ');
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBe('https://config.example/feed');
  });

  // FIX 1 — CE-scoped R2 default: an installed Command EVE build (shell ON)
  // checks the R2 feed even with NO env and NO persisted config (Alois path).
  it('defaults to the R2 feed base when CE shell is ON and nothing else is set', async () => {
    const read = vi.fn(async () => undefined);
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
  });

  it('defaults to the R2 feed base when CE shell is ON and no config reader is supplied', async () => {
    const url = await resolveUpdateFeedUrl();
    expect(url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
  });

  it('uses the fixed R2 dev prefix only for an explicit preview check', async () => {
    const read = vi.fn(async () => undefined);
    const url = await resolveUpdateFeedUrl(read, true);
    expect(url).toBe(COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL);
    expect(COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL).toBe(`${COMMAND_EVE_UPDATE_FEED_BASE_URL}/channels/dev`);
  });

  it('keeps an explicit env feed byte-exact when preview is enabled', async () => {
    process.env[UPDATE_FEED_URL_ENV] = 'https://preview-fixture.example/custom-root';
    const read = vi.fn(async () => undefined);
    const url = await resolveUpdateFeedUrl(read, true);
    expect(url).toBe('https://preview-fixture.example/custom-root');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps an explicit persisted feed byte-exact when preview is enabled', async () => {
    const url = await resolveUpdateFeedUrl(async () => 'https://config.example/custom-root', true);
    expect(url).toBe('https://config.example/custom-root');
  });

  // FIX 1 — explicit opt-out: a present-but-empty env value forces the quiet
  // no-feed state even with CE shell ON (this is exactly how the W8 e2e Suite C
  // launches the packaged CE app: COMMAND_EVE_UPDATE_FEED_URL='').
  it('treats a present-but-empty env as an explicit "no feed" opt-out (CE shell ON)', async () => {
    process.env[UPDATE_FEED_URL_ENV] = '';
    const read = vi.fn(async () => 'https://config.example/feed');
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBeUndefined();
    // Opt-out short-circuits before the persisted config is even read.
    expect(read).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only env as the same opt-out (CE shell ON)', async () => {
    process.env[UPDATE_FEED_URL_ENV] = '   ';
    const read = vi.fn(async () => 'https://config.example/feed');
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  // W8 default-quiet preserved for upstream: CE shell OFF + no explicit feed
  // returns undefined (no R2 default for non-Command-EVE / upstream builds).
  it('returns undefined (quiet no-feed) when CE shell is OFF and nothing is set', async () => {
    ceShellState.shellEnabled = false;
    const read = vi.fn(async () => undefined);
    const url = await resolveUpdateFeedUrl(read);
    expect(url).toBeUndefined();
  });

  it('still honors an explicit env/config feed when CE shell is OFF', async () => {
    ceShellState.shellEnabled = false;
    process.env[UPDATE_FEED_URL_ENV] = 'https://env.example/feed';
    const url = await resolveUpdateFeedUrl(async () => undefined);
    expect(url).toBe('https://env.example/feed');
  });
});

describe('autoUpdaterService.configureFeed', () => {
  it('no-ops quietly and does not call setFeedURL when CE shell is OFF and no feed is configured', async () => {
    ceShellState.shellEnabled = false;
    const result = await autoUpdaterService.configureFeed(async () => undefined);
    expect(result.configured).toBe(false);
    expect(autoUpdaterService.isFeedConfigured).toBe(false);
    expect(setFeedURL).not.toHaveBeenCalled();
  });

  it('no-ops quietly under the present-but-empty env opt-out even when CE shell is ON', async () => {
    process.env[UPDATE_FEED_URL_ENV] = '';
    const result = await autoUpdaterService.configureFeed(async () => 'https://config.example/feed');
    expect(result.configured).toBe(false);
    expect(autoUpdaterService.isFeedConfigured).toBe(false);
    expect(setFeedURL).not.toHaveBeenCalled();
  });

  // FIX 1 — CE shell ON + no override resolves to the R2 base and wires the
  // generic provider, so the installed Command EVE startup check hits the R2 feed.
  it('applies the CE-scoped R2 feed via setFeedURL when CE shell is ON and nothing else is set', async () => {
    const result = await autoUpdaterService.configureFeed(async () => undefined);
    expect(result.configured).toBe(true);
    expect(result.url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
    expect(autoUpdaterService.isFeedConfigured).toBe(true);
    expect(setFeedURL).toHaveBeenCalledTimes(1);
    const arg = setFeedURL.mock.calls[0][0];
    expect(arg.provider).toBe('generic');
    expect(arg.url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
  });

  it('applies a generic feed via setFeedURL when an explicit URL is present (the R2 base flows through verbatim)', async () => {
    // The R2 feed base electron-builder.yml `publish.url` bakes into app-update.yml
    // is the same value passed here at runtime via env/config → generic provider.
    const R2_FEED = 'https://pub-0a282738bf7a4731a6bb71c2420bfd69.r2.dev';
    const result = await autoUpdaterService.configureFeed(async () => R2_FEED);
    expect(result.configured).toBe(true);
    expect(autoUpdaterService.isFeedConfigured).toBe(true);
    expect(setFeedURL).toHaveBeenCalledTimes(1);
    const arg = setFeedURL.mock.calls[0][0];
    // generic provider so electron-updater reads `<url>/latest-mac.yml` over static HTTPS.
    expect(arg.provider).toBe('generic');
    expect(arg.url).toBe(R2_FEED);
  });

  it('reconfigures the CE default between preview and stable without enabling updater downgrade mode', async () => {
    const preview = await autoUpdaterService.configureFeed(async () => undefined, true);
    expect(preview.url).toBe(COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL);
    expect(setFeedURL.mock.calls.at(-1)?.[0]?.url).toBe(COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.allowDowngrade).toBe(false);

    const stable = await autoUpdaterService.configureFeed(async () => undefined, false);
    expect(stable.url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
    expect(setFeedURL.mock.calls.at(-1)?.[0]?.url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
    expect(autoUpdater.allowDowngrade).toBe(false);
  });
});

describe('autoUpdaterService.checkForUpdatesAndNotify', () => {
  it('uses quiet background download policy in the Command EVE shell', () => {
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('checks silently instead of invoking the native notification flow', async () => {
    checkForUpdates.mockResolvedValue(null);
    autoUpdaterService.initialize();

    await autoUpdaterService.checkForUpdatesAndNotify(async () => COMMAND_EVE_UPDATE_FEED_BASE_URL);

    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(checkForUpdatesAndNotify).not.toHaveBeenCalled();
  });

  it('returns to the stable feed for background checks after an explicit preview check', async () => {
    checkForUpdates.mockResolvedValue({ isUpdateAvailable: false });
    autoUpdaterService.initialize();

    await autoUpdaterService.checkForUpdates(async () => undefined, true);
    await autoUpdaterService.checkForUpdatesAndNotify(async () => undefined);

    expect(setFeedURL).toHaveBeenCalledTimes(2);
    expect(setFeedURL.mock.calls[0]?.[0]?.url).toBe(COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL);
    expect(setFeedURL.mock.calls[1]?.[0]?.url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
    expect(autoUpdater.allowPrerelease).toBe(false);
    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  it('serializes an explicit preview check with a concurrent stable background check', async () => {
    let releasePreview!: (value: { isUpdateAvailable: false }) => void;
    checkForUpdates
      .mockImplementationOnce(
        () =>
          new Promise<{ isUpdateAvailable: false }>((resolve) => {
            releasePreview = resolve;
          })
      )
      .mockResolvedValueOnce({ isUpdateAvailable: false });
    autoUpdaterService.initialize();

    const previewCheck = autoUpdaterService.checkForUpdates(async () => undefined, true);
    await vi.waitFor(() => expect(setFeedURL).toHaveBeenCalledTimes(1));
    const backgroundCheck = autoUpdaterService.checkForUpdatesAndNotify(async () => undefined);
    await Promise.resolve();

    expect(setFeedURL).toHaveBeenCalledTimes(1);
    expect(setFeedURL.mock.calls[0]?.[0]?.url).toBe(COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL);

    releasePreview({ isUpdateAvailable: false });
    await Promise.all([previewCheck, backgroundCheck]);

    expect(setFeedURL).toHaveBeenCalledTimes(2);
    expect(setFeedURL.mock.calls[1]?.[0]?.url).toBe(COMMAND_EVE_UPDATE_FEED_BASE_URL);
  });

  it('does not throw and no-ops when CE shell is OFF and no feed is configured', async () => {
    ceShellState.shellEnabled = false;
    autoUpdaterService.initialize();
    await expect(autoUpdaterService.checkForUpdatesAndNotify(async () => undefined)).resolves.toBeUndefined();
    expect(setFeedURL).not.toHaveBeenCalled();
  });

  it('does not throw and no-ops under the present-but-empty env opt-out (CE shell ON)', async () => {
    process.env[UPDATE_FEED_URL_ENV] = '';
    autoUpdaterService.initialize();
    await expect(autoUpdaterService.checkForUpdatesAndNotify(async () => undefined)).resolves.toBeUndefined();
    expect(setFeedURL).not.toHaveBeenCalled();
  });
});

describe('autoUpdaterService durable status', () => {
  it('preserves release metadata through progress and downloaded events', () => {
    autoUpdaterService.initialize();
    autoUpdaterService.triggerEventForTest('update-available', {
      version: '1.8.12',
      releaseDate: '2026-07-14T12:00:00.000Z',
      releaseNotes: 'Background updates',
    });
    autoUpdaterService.triggerEventForTest('download-progress', {
      bytesPerSecond: 1024,
      percent: 50,
      transferred: 5,
      total: 10,
    });
    autoUpdaterService.triggerEventForTest('update-downloaded', { version: '1.8.12' });

    expect(autoUpdaterService.getStatusSnapshot()).toMatchObject({
      status: 'downloaded',
      version: '1.8.12',
      releaseDate: '2026-07-14T12:00:00.000Z',
      releaseNotes: 'Background updates',
    });
  });

  it('keeps a deferred package until a newer version supersedes it', () => {
    autoUpdaterService.initialize();
    autoUpdaterService.triggerEventForTest('update-available', { version: '1.8.12' });
    autoUpdaterService.triggerEventForTest('update-downloaded', { version: '1.8.12' });
    autoUpdaterService.triggerEventForTest('checking-for-update');
    autoUpdaterService.triggerEventForTest('update-not-available');
    expect(autoUpdaterService.getStatusSnapshot()).toMatchObject({ status: 'downloaded', version: '1.8.12' });

    autoUpdaterService.triggerEventForTest('update-available', { version: '1.8.13' });
    expect(autoUpdaterService.getStatusSnapshot()).toMatchObject({ status: 'available', version: '1.8.13' });
  });
});
