/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import { app } from 'electron';
import log from 'electron-log';
import { EventEmitter } from 'events';
import {
  COMMAND_EVE_SHELL_ENABLED,
  COMMAND_EVE_UPDATE_FEED_BASE_URL,
  COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL,
} from '@/common/config/commandEveShell';
import { mergeAutoUpdateStatus } from '@/common/update/autoUpdateState';
import { resolveInstallableUpdateVersion } from '@/common/update/updateReadyPromptCore';
import type { AutoUpdateStatus } from '@/common/update/updateTypes';
import { recordAutoUpdateQuitAndInstall, recordAutoUpdateStatus } from './autoUpdateDiagnostics';
import { setIsQuitting, setTrayUpdateReady } from '@process/utils/tray';

export type { AutoUpdateStatus } from '@/common/update/updateTypes';

/**
 * Environment variable that supplies the generic auto-update feed base URL.
 * Highest-priority feed source; overrides any persisted ProcessConfig value AND
 * the CE-scoped R2 default. A present-but-empty value is an explicit "force no
 * feed" opt-out (see resolveUpdateFeedUrl for the full priority ladder).
 */
export const UPDATE_FEED_URL_ENV = 'COMMAND_EVE_UPDATE_FEED_URL';

/**
 * Persisted ProcessConfig key for the generic auto-update feed base URL.
 * Lower priority than UPDATE_FEED_URL_ENV.
 */
export const UPDATE_FEED_URL_CONFIG_KEY = 'update.feedUrl' as const;

/** Re-check while the app remains open so deferred installs are superseded by the latest release. */
export const COMMAND_EVE_BACKGROUND_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Resolve the configured generic-provider update feed base URL.
 *
 * Priority:
 *   1. COMMAND_EVE_UPDATE_FEED_URL env var, when set to a non-empty value
 *      (highest priority explicit override — e.g. the e2e local feed).
 *   2. EXPLICIT OPT-OUT: COMMAND_EVE_UPDATE_FEED_URL set but empty/whitespace.
 *      A *present-but-empty* env value is an intentional "force no feed" signal
 *      (distinct from the var being absent). It returns undefined regardless of
 *      anything else, which keeps the W8 quiet no-op provable in CE-shell builds
 *      (Suite C launches the packaged CE app with COMMAND_EVE_UPDATE_FEED_URL='').
 *   3. The persisted ProcessConfig `update.feedUrl` setting, when non-empty.
 *   4. CE-SCOPED DEFAULT: when COMMAND_EVE_SHELL_ENABLED is true and nothing
 *      above resolved, use COMMAND_EVE_UPDATE_FEED_BASE_URL for stable checks,
 *      or the fixed COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL only when the user
 *      explicitly included preview/dev builds for this check. This is what makes
 *      an installed Command EVE build actually check the selected R2 feed while
 *      keeping stable as the startup/background default.
 *   5. Otherwise undefined — the first-class quiet "no feed" state (NOT an
 *      error). Upstream/non-CE builds (COMMAND_EVE_SHELL_ENABLED === false)
 *      always land here when no explicit feed is configured, so the W8
 *      feed-agnostic default-quiet behaviour is preserved for upstream.
 *
 * NOTE (feed wiring): this runtime resolver intentionally does NOT read the
 * bundled app-update.yml. electron-builder.yml `publish` (generic, R2) is what
 * bakes app-update.yml into the build; the runtime then re-points the updater
 * via setFeedURL using THIS resolved value (W8 feed-agnostic design). The
 * CE-scoped default (step 4) points at the SAME R2 base that publish.url bakes
 * in, so build-time and runtime feeds agree.
 *
 * The config reader is injected so this stays unit-testable without booting
 * Electron storage; production passes ProcessConfig.get.
 */
export async function resolveUpdateFeedUrl(
  readConfig?: (key: typeof UPDATE_FEED_URL_CONFIG_KEY) => Promise<string | undefined>,
  includePrerelease = false
): Promise<string | undefined> {
  const rawEnv = process.env[UPDATE_FEED_URL_ENV];
  if (typeof rawEnv === 'string') {
    const trimmed = rawEnv.trim();
    if (trimmed !== '') {
      // (1) explicit non-empty override wins.
      return trimmed;
    }
    // (2) explicit opt-out: present-but-empty env forces the quiet no-feed state
    // and short-circuits the persisted config + CE-scoped default below.
    return undefined;
  }
  if (readConfig) {
    try {
      const fromConfig = await readConfig(UPDATE_FEED_URL_CONFIG_KEY);
      if (typeof fromConfig === 'string' && fromConfig.trim() !== '') {
        // (3) persisted override.
        return fromConfig.trim();
      }
    } catch (error) {
      log.warn('Failed to read persisted update feed URL:', error);
    }
  }
  // (4) CE-scoped default: an installed Command EVE build checks the R2 feed even
  // with no env/config set. Upstream (CE shell off) intentionally skips this and
  // falls through to the (5) quiet no-op state.
  if (COMMAND_EVE_SHELL_ENABLED) {
    return includePrerelease ? COMMAND_EVE_UPDATE_PREVIEW_FEED_BASE_URL : COMMAND_EVE_UPDATE_FEED_BASE_URL;
  }
  // (5) quiet "no feed" state.
  return undefined;
}

/**
 * Returns the appropriate update channel name based on the current platform and architecture.
 * Returns undefined for the default channel (Windows x64 / Linux x64).
 */
export function getUpdateChannel(): string | undefined {
  const { platform, arch } = process;

  // electron-updater appends a platform suffix to the channel name:
  //   macOS  → "-mac"       (e.g. "latest" → "latest-mac.yml")
  //   Linux  → "-linux"     (+ arch suffix for non-x64, e.g. "latest-linux-arm64.yml")
  //   Windows → ""          (no suffix, e.g. "latest.yml")
  //
  // Linux arm64 is handled natively by electron-updater (appends "-linux-arm64"),
  // so only Windows arm64 and macOS arm64 need a custom channel.

  if (platform === 'win32' && arch === 'arm64') {
    // "latest-win-arm64" + "" → "latest-win-arm64.yml"
    return 'latest-win-arm64';
  }
  if (platform === 'darwin' && arch === 'arm64') {
    // "latest-arm64" + "-mac" → "latest-arm64-mac.yml"
    return 'latest-arm64';
  }
  // macOS x64  → default "latest" + "-mac"         → "latest-mac.yml"
  // Linux x64  → default "latest" + "-linux"       → "latest-linux.yml"
  // Linux arm64→ default "latest" + "-linux-arm64"  → "latest-linux-arm64.yml"
  // Win x64    → default "latest" + ""             → "latest.yml"
  return undefined;
}

/** Callback type for broadcasting update status */
export type StatusBroadcastCallback = (status: AutoUpdateStatus) => void;

/** Events emitted by AutoUpdaterService */
export interface AutoUpdaterEvents {
  'update-status': (status: AutoUpdateStatus) => void;
}

class AutoUpdaterService extends EventEmitter {
  private _isInitialized = false;
  private _eventHandlersSetup = false;
  /** True once a generic feed URL has been resolved and applied via setFeedURL */
  private _feedConfigured = false;
  /**
   * Serializes feed selection together with the matching electron-updater check.
   * electron-updater owns one process-global feed, so overlapping explicit and
   * background checks must not reconfigure each other mid-request.
   */
  private _updateCheckTail: Promise<void> = Promise.resolve();
  private _statusBroadcastCallback: StatusBroadcastCallback | null = null;
  private _lastStatus: AutoUpdateStatus | null = null;
  private _recurringCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stores registered autoUpdater event handlers for cleanup and test access */
  private readonly _autoUpdaterHandlers = new Map<string, (...args: unknown[]) => void>();

  constructor() {
    super();
    // Configure logging
    autoUpdater.logger = log;
    (autoUpdater.logger as typeof log).transports.file.level = 'info';

    // Command EVE downloads quietly and waits for an explicit restart action.
    // Upstream AionUi keeps its existing manual download/install-on-quit policy.
    autoUpdater.autoDownload = COMMAND_EVE_SHELL_ENABLED;
    autoUpdater.autoInstallOnAppQuit = !COMMAND_EVE_SHELL_ENABLED;

    // Set the correct update channel based on platform and architecture before
    // any update checks are performed
    const channel = getUpdateChannel();
    if (channel !== undefined) {
      autoUpdater.channel = channel;
      log.info(`Update channel set to: ${channel}`);
    }
  }

  /**
   * Initialize the service with an optional status broadcast callback.
   * This decouples the service from any specific window implementation.
   */
  initialize(statusBroadcastCallback?: StatusBroadcastCallback): void {
    this._statusBroadcastCallback = statusBroadcastCallback ?? null;
    this._isInitialized = true;

    // Setup event handlers only once
    if (!this._eventHandlersSetup) {
      this.setupEventHandlers();
      this._eventHandlersSetup = true;
    }
  }

  /**
   * Set the status broadcast callback (can be called after initialize)
   */
  setStatusBroadcastCallback(callback: StatusBroadcastCallback | null): void {
    this._statusBroadcastCallback = callback;
  }

  /**
   * Check if the service has been initialized
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Reset the service state (for production use)
   */
  reset(): void {
    this.clearRecurringCheck();
    this._isInitialized = false;
    // Note: _eventHandlersSetup is NOT reset to avoid duplicate handler registration
    this._feedConfigured = false;
    this._statusBroadcastCallback = null;
    this._lastStatus = null;
    setTrayUpdateReady(null);
  }

  /**
   * Reset the service state completely, including event handlers.
   * Use this only in tests where you need to reset handler state.
   */
  resetForTest(): void {
    this.clearRecurringCheck();
    this._isInitialized = false;
    this._eventHandlersSetup = false;
    this._feedConfigured = false;
    this._statusBroadcastCallback = null;
    this._lastStatus = null;
    setTrayUpdateReady(null);
    // Remove listeners from this EventEmitter instance
    this.removeAllListeners();
    // Remove each registered handler from autoUpdater to prevent
    // duplicate handler accumulation across multiple initialize() calls in tests
    for (const [event, handler] of this._autoUpdaterHandlers) {
      autoUpdater.removeListener(
        event as Parameters<typeof autoUpdater.removeListener>[0],
        handler as Parameters<typeof autoUpdater.removeListener>[1]
      );
    }
    this._autoUpdaterHandlers.clear();
  }

  /**
   * Trigger a registered autoUpdater event handler by event name with optional arguments.
   * Intended for use in tests only — do not call in production code.
   * Throws if the handler for the given event has not been registered yet.
   */
  triggerEventForTest(event: string, ...args: unknown[]): void {
    const handler = this._autoUpdaterHandlers.get(event);
    if (!handler) {
      throw new Error(`No handler registered for autoUpdater event "${event}". Did you call initialize() first?`);
    }
    handler(...args);
  }

  /**
   * Whether a generic update feed has been resolved and applied.
   */
  get isFeedConfigured(): boolean {
    return this._feedConfigured;
  }

  /** Last durable updater state, including metadata preserved across progress events. */
  getStatusSnapshot(): AutoUpdateStatus | null {
    if (!this._lastStatus) return null;
    return {
      ...this._lastStatus,
      progress: this._lastStatus.progress ? { ...this._lastStatus.progress } : undefined,
    };
  }

  /**
   * Resolve and apply the generic-provider update feed.
   *
   * Returns `{ configured: false }` quietly when no feed URL is set anywhere —
   * this is the supported "no feed source" state (no error dialog, no crash).
   * When a URL is present, points electron-updater at it via setFeedURL using
   * the generic provider and the platform/arch channel from getUpdateChannel().
   *
   * The config reader is injectable for testing; production passes
   * ProcessConfig.get.
   */
  async configureFeed(
    readConfig?: (key: typeof UPDATE_FEED_URL_CONFIG_KEY) => Promise<string | undefined>,
    includePreview = false
  ): Promise<{ configured: boolean; url?: string; channel?: string }> {
    // The stable and preview feeds advertise final semver artifacts. Never use
    // electron-updater's prerelease/downgrade modes; the selected feed URL is
    // the only opt-in boundary and is scoped to this one serialized check.
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    const url = await resolveUpdateFeedUrl(readConfig, includePreview);
    if (!url) {
      this._feedConfigured = false;
      log.info(
        `No update feed configured (set ${UPDATE_FEED_URL_ENV} or ${UPDATE_FEED_URL_CONFIG_KEY}); skipping update checks.`
      );
      return { configured: false };
    }

    const channel = getUpdateChannel();
    // electron-updater's GenericServerOptions.channel selects which "<channel>.yml"
    // (plus platform suffix) is fetched from the feed base URL. Passing the same
    // channel getUpdateChannel() applies to autoUpdater.channel keeps the static
    // feed self-consistent with the metadata filename the updater requests.
    autoUpdater.setFeedURL({
      provider: 'generic',
      url,
      ...(channel !== undefined ? { channel } : {}),
    });
    this._feedConfigured = true;
    log.info(`Update feed configured (generic): ${url}${channel ? ` [channel=${channel}]` : ''}`);
    return { configured: true, url, channel };
  }

  private setupEventHandlers(): void {
    const register = <T extends unknown[]>(event: string, handler: (...args: T) => void) => {
      // Cast to satisfy overloaded autoUpdater.on signature
      autoUpdater.on(event as Parameters<typeof autoUpdater.on>[0], handler as Parameters<typeof autoUpdater.on>[1]);
      this._autoUpdaterHandlers.set(event, handler as (...args: unknown[]) => void);
    };

    register('checking-for-update', () => {
      log.info('Checking for updates...');
      this.broadcastStatus({ status: 'checking' });
    });

    register('update-available', (info: UpdateInfo) => {
      log.info(`Update available: ${info.version}`);
      this.broadcastStatus({
        status: 'available',
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      });
    });

    register('update-not-available', () => {
      log.info('Application is up to date');
      this.broadcastStatus({ status: 'not-available' });
    });

    register('download-progress', (progress: ProgressInfo) => {
      log.info(`Download progress: ${progress.percent.toFixed(2)}%`);
      this.broadcastStatus({
        status: 'downloading',
        progress: {
          bytesPerSecond: progress.bytesPerSecond,
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        },
      });
    });

    register('update-downloaded', (info: UpdateInfo) => {
      log.info('Update downloaded');
      this.broadcastStatus({
        status: 'downloaded',
        version: info.version,
      });
    });

    register('error', (error: Error) => {
      log.error('Auto-updater error:', error);
      this.broadcastStatus({
        status: 'error',
        error: error.message,
      });
    });
  }

  /**
   * Broadcast status to both EventEmitter listeners and the registered callback
   */
  private broadcastStatus(status: AutoUpdateStatus): void {
    this._lastStatus = mergeAutoUpdateStatus(this._lastStatus, status);
    // Reflect the downloaded/awaiting-restart state in the tray menu entry.
    setTrayUpdateReady(resolveInstallableUpdateVersion(this._lastStatus));
    recordAutoUpdateStatus(status, {
      currentAppVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
    });

    // Emit to internal listeners (for testing and extensibility)
    this.emit('update-status', status);

    // Call the registered callback if available
    if (this._statusBroadcastCallback) {
      this._statusBroadcastCallback(status);
    }
  }

  private clearRecurringCheck(): void {
    if (!this._recurringCheckTimer) return;
    clearTimeout(this._recurringCheckTimer);
    this._recurringCheckTimer = null;
  }

  private async runUpdateCheckExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this._updateCheckTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._updateCheckTail = predecessor.then(
      () => current,
      () => current
    );

    try {
      await predecessor;
    } catch {
      // A failed predecessor must release the serialized lane for the next check.
    }
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private scheduleRecurringCheck(): void {
    if (!COMMAND_EVE_SHELL_ENABLED || !this._isInitialized) return;
    this.clearRecurringCheck();
    this._recurringCheckTimer = setTimeout(() => {
      this._recurringCheckTimer = null;
      void this.checkForUpdatesAndNotify();
    }, COMMAND_EVE_BACKGROUND_UPDATE_INTERVAL_MS);
    this._recurringCheckTimer.unref?.();
  }

  async checkForUpdates(
    readConfig?: (key: typeof UPDATE_FEED_URL_CONFIG_KEY) => Promise<string | undefined>,
    includePreview = false
  ): Promise<{ success: boolean; updateInfo?: UpdateInfo; error?: string }> {
    return this.runUpdateCheckExclusive(async () => {
      try {
        if (!this._isInitialized) {
          throw new Error('AutoUpdaterService not initialized');
        }

        let reader = readConfig;
        if (!reader) {
          const { ProcessConfig } = await import('@process/utils/initStorage');
          reader = (key) => ProcessConfig.get(key);
        }
        const feed = await this.configureFeed(reader, includePreview);
        if (!feed.configured) {
          // No feed source: surface a clean, localized reason rather than letting
          // electron-updater throw an opaque error.
          const { default: i18n } = await import('./i18n');
          return { success: false, error: i18n.t('update.errors.noFeedConfigured') };
        }

        const result = await autoUpdater.checkForUpdates();
        if (!result) {
          const { default: i18n } = await import('./i18n');
          return { success: false, error: i18n.t('update.errors.checkReturnedNull') };
        }
        // Only report updateInfo when electron-updater internally confirms the update is available.
        // When isUpdateAvailable is false, updateInfoAndProvider is NOT set internally,
        // so a subsequent downloadUpdate() call would fail with "Please check update first".
        if (!result.isUpdateAvailable) {
          return { success: true };
        }
        return {
          success: true,
          updateInfo: result.updateInfo,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Check for updates failed:', message);
        return {
          success: false,
          error: message,
        };
      }
    });
  }

  async downloadUpdate(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this._isInitialized) {
        throw new Error('AutoUpdaterService not initialized');
      }

      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Download update failed:', message);
      return {
        success: false,
        error: message,
      };
    }
  }

  quitAndInstall(): void {
    log.info('Quitting and installing update...');
    recordAutoUpdateQuitAndInstall({
      currentAppVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
    });
    // electron-updater's quitAndInstall() closes all windows and THEN calls
    // app.quit(). The mainWindow 'close' handler hides-to-tray while isQuitting is
    // false, so without this flag the close is hijacked (window just hides), the
    // "all windows closed" gate never trips, and the install stalls. Set the flag
    // FIRST so the window actually closes and the quit proceeds.
    setIsQuitting(true);
    // Do NOT app.exit() here. On macOS electron-updater serves the downloaded
    // update from an HTTP server running INSIDE this process; Squirrel.Mac re-reads
    // the bundle from it during quitAndInstall. A forced exit kills that server
    // mid-install -> the installer aborts and nothing is written (the exact crash we
    // had). The graceful quit lets Squirrel finish the swap and relaunch
    // (isForceRunAfter=true).
    autoUpdater.quitAndInstall(true, true);
  }

  /**
   * Startup update check. Command EVE checks silently, lets electron-updater
   * download in the background, and schedules another check while the app stays
   * open. Upstream AionUi retains the native notification path.
   */
  async checkForUpdatesAndNotify(
    readConfig?: (key: typeof UPDATE_FEED_URL_CONFIG_KEY) => Promise<string | undefined>
  ): Promise<void> {
    return this.runUpdateCheckExclusive(async () => {
      let shouldScheduleNextCheck = false;
      try {
        let reader = readConfig;
        if (!reader) {
          const { ProcessConfig } = await import('@process/utils/initStorage');
          reader = (key) => ProcessConfig.get(key);
        }
        // Background/startup checks are always stable. Preview is available only
        // to the explicit user-triggered check that supplies includePreview=true.
        const feed = await this.configureFeed(reader, false);
        if (!feed.configured) {
          // First-class quiet state: nothing to check against, so do not call into
          // electron-updater (which would otherwise error into the void).
          return;
        }
        shouldScheduleNextCheck = COMMAND_EVE_SHELL_ENABLED;
        if (COMMAND_EVE_SHELL_ENABLED) {
          // Do not call checkForUpdatesAndNotify here: it creates a native popup.
          // autoDownload=true starts the verified generic-feed download quietly.
          await autoUpdater.checkForUpdates();
        } else {
          await autoUpdater.checkForUpdatesAndNotify();
        }
      } catch (error) {
        log.error('Auto-update check failed:', error);
      } finally {
        if (shouldScheduleNextCheck) this.scheduleRecurringCheck();
      }
    });
  }
}

// Singleton instance
export const autoUpdaterService = new AutoUpdaterService();
