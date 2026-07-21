/**
 * Command EVE over-the-air update cycle – detection + visible signal proof.
 *
 * Founder requirement: "once delivered to Alois, updates must run through
 * cleanly and we must be able to signal that an update exists." This spec proves
 * the DETECT + SIGNAL half of the A→B cycle against a LOCAL static feed, driving
 * the real W8 feed-agnostic electron-updater wiring (resolveUpdateFeedUrl →
 * configureFeed → setFeedURL → autoUpdater.checkForUpdates → 'update-available')
 * end to end through the production startup auto-check. The full ~450MB
 * download/install half is out of e2e scope and is scripted separately by
 * scripts/release/update-cycle-receipt.mjs in the Company.OS repo.
 *
 * What is proven here (fail-loud, no test.skip):
 *   (a) With COMMAND_EVE_UPDATE_FEED_URL pointing at a local HTTP feed that
 *       advertises a HIGHER version (9.9.9-test), the real autoUpdaterService
 *       reaches status 'available' and then 'downloaded' with version 9.9.9-test,
 *       broadcast on the production ipcBridge.autoUpdate.status channel.
 *   (b) The UI stays non-interruptive until the footer update icon is clicked;
 *       it then renders the German "Bereit zur Installation" signal, version,
 *       and release notes.
 *   (c) With the EXPLICIT empty-env opt-out (COMMAND_EVE_UPDATE_FEED_URL='') the
 *       startup check no-ops quietly — no 'available'/'error'/'checking' status is
 *       broadcast and no error dialog is shown (the W8 quiet "no feed source"
 *       state, now reached via the opt-out in a CE-shell build).
 *   (d) With NO feed env at all, the CE-shell R2 default (FIX 1) activates: the
 *       startup check actually runs (broadcasts 'checking') instead of staying
 *       quiet — the Alois-machine path. (Asserts the seam activated, not the
 *       non-deterministic network outcome; the exact R2 url is unit-tested.)
 *
 * Why the PACKAGED app (not dev, not the shared fixtures app):
 *   electron-updater refuses to run when !app.isPackaged (isUpdaterActive gate),
 *   so a dev `electron .` launch can never reach real 'update-available' detection
 *   without a product-code change. This spec therefore launches the PACKAGED
 *   build where app.isPackaged === true and the production startup auto-check
 *   runs the real detection against the feed. It launches its own instance with
 *   the dedicated AIONUI_AUTO_UPDATE_E2E override so the updater stays active
 *   while E2E runtime ports remain isolated, and resolves
 *   COMMAND_EVE_UPDATE_FEED_URL from the environment exactly as an installed app.
 *
 * GATE (1.818 C4 harness finding): auto-update proofs only run against
 * electron-builder output (a notary/packaged build), never in dev runs. Every
 * suite in this file is SKIPPED unless the packaged build artifact path is
 * provided explicitly:
 *
 *   COMMAND_EVE_AUTO_UPDATE_E2E_PACKAGED_APP=/path/to/'Command EVE.app' \
 *     npx playwright test --config playwright.config.ts tests/e2e/specs/command-eve-auto-update.e2e.ts
 *
 * The env value may point at the .app bundle, the executable inside it, or an
 * unpacked electron-builder output directory. Produce the artifact with:
 *   npx electron-vite build --config packages/desktop/electron.vite.config.ts
 *   CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
 *     --config packages/desktop/electron-builder.yml --mac dir --arm64 --publish=never
 * (or the notarized `build-mac:*:notarized` lanes for the release artifact).
 *
 * The Command EVE shell downloads the referenced artifact in the background.
 * A tiny checksum-valid dummy zip is sufficient because this spec never invokes
 * quitAndInstall; the release-cycle receipt covers the real signed package swap.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'http';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { invokeBridge } from '../helpers';

// ── Fixture feed (higher version → must be detected) ──────────────────────────

const FEED_VERSION = '9.9.9-test';
const ZIP_NAME = `Command-EVE-${FEED_VERSION}-mac-arm64.zip`;
const BLOCKMAP_NAME = `${ZIP_NAME}.blockmap`;
const STATUS_CHANNEL = 'auto-update.status';
const PACKAGED_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-auto-update-user-data-'));

/**
 * Packaged-artifact gate (1.818 C4): this spec only runs when the runner
 * explicitly provides the electron-builder output to exercise. Dev runs leave
 * it unset and skip the whole file instead of failing against a missing or
 * stale out/ directory.
 */
const PACKAGED_APP_ENV = 'COMMAND_EVE_AUTO_UPDATE_E2E_PACKAGED_APP';
const PACKAGED_APP_SKIP_REASON =
  `Auto-update e2e only runs against electron-builder output (notary/packaged build). ` +
  `Set ${PACKAGED_APP_ENV}=<path to Command EVE.app, executable, or unpacked dir> — skipped in dev runs.`;

test.afterAll(() => {
  try {
    const packaged = resolvePackagedApp();
    if (process.platform === 'darwin' && packaged) {
      const appBundle = path.resolve(path.dirname(packaged.executablePath), '../..');
      execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], {
        stdio: 'pipe',
      });
    }
  } finally {
    fs.rmSync(PACKAGED_USER_DATA_DIR, { recursive: true, force: true });
  }
});

type CapturedStatus = { status: string; version?: string; error?: string };
type PackagedAppHandle = {
  browser: Browser;
  process: ChildProcessWithoutNullStreams;
  close: () => Promise<void>;
};

/**
 * Build an isolated temp feed directory with a dummy artifact and the channel
 * yml files electron-updater requests on macOS. On darwin arm64 the service sets
 * autoUpdater.channel = 'latest-arm64' and electron-updater appends '-mac', so it
 * fetches 'latest-arm64-mac.yml'. We also emit 'latest-mac.yml' (darwin x64
 * default channel) so the fixture is robust if the release machine is Intel.
 */
function buildFeedDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-update-feed-'));

  // Small checksum-valid artifact. It is downloaded but never installed.
  const zipBytes = Buffer.from(`command-eve dummy update artifact ${FEED_VERSION}\n`);
  fs.writeFileSync(path.join(dir, ZIP_NAME), zipBytes);
  fs.writeFileSync(path.join(dir, BLOCKMAP_NAME), Buffer.from('dummy-blockmap'));

  const sha512 = createHash('sha512').update(zipBytes).digest('base64');
  const releaseDate = new Date().toISOString();
  const yml =
    `version: ${FEED_VERSION}\n` +
    `files:\n` +
    `  - url: ${ZIP_NAME}\n` +
    `    sha512: ${sha512}\n` +
    `    size: ${zipBytes.length}\n` +
    `path: ${ZIP_NAME}\n` +
    `sha512: ${sha512}\n` +
    `releaseDate: '${releaseDate}'\n` +
    `releaseNotes: |\n` +
    `  Ruhige Hintergrund-Updates\n`;

  // Emit every channel-yml name the updater might request across mac arch/channel
  // permutations so the proof does not depend on the runner's exact arch.
  for (const name of ['latest-arm64-mac.yml', 'latest-mac.yml']) {
    fs.writeFileSync(path.join(dir, name), yml);
  }

  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Minimal static file server over the feed dir on a random loopback port.
 * Mirrors how a real static HTTPS feed (e.g. static.command-eve.com) serves the
 * channel yml + artifacts, but locally and disposable.
 */
function startFeedServer(rootDir: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const safe = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(rootDir, safe);
    if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', filePath.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Feed server failed to bind a TCP port'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

// ── Window resolution (mirrors fixtures.ts / ext-no-extensions spec) ──────────

function isDevToolsWindow(page: Page): boolean {
  return page.url().startsWith('devtools://');
}

async function resolveMainWindow(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() !== 'about:blank' && !isDevToolsWindow(candidate));
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('[auto-update e2e] Failed to resolve main renderer window.');
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function closePackagedApp(browser: Browser, child: ChildProcessWithoutNullStreams): Promise<void> {
  await browser.close().catch(() => undefined);
  if (await waitForProcessExit(child, 10_000)) return;
  child.kill('SIGTERM');
  if (await waitForProcessExit(child, 10_000)) return;
  child.kill('SIGKILL');
  await waitForProcessExit(child, 5_000);
}

/**
 * Resolve the packaged Electron executable from the explicit
 * COMMAND_EVE_AUTO_UPDATE_E2E_PACKAGED_APP artifact path. Accepts a .app
 * bundle, the executable inside it, or an unpacked electron-builder output
 * directory. Returns null when the gate env is unset or does not resolve to a
 * runnable artifact — callers must treat null as "skip", never as "scan out/".
 */
function resolvePackagedApp(): { executablePath: string; cwd: string } | null {
  const artifact = process.env[PACKAGED_APP_ENV]?.trim();
  if (!artifact) return null;

  const resolved = path.resolve(artifact);
  if (!fs.existsSync(resolved)) return null;

  // Path directly to the executable.
  if (fs.statSync(resolved).isFile()) {
    return { executablePath: resolved, cwd: path.dirname(resolved) };
  }

  // Path to a macOS .app bundle.
  if (process.platform === 'darwin' && resolved.endsWith('.app')) {
    for (const name of ['Command EVE', 'AionUi']) {
      const exe = path.join(resolved, 'Contents', 'MacOS', name);
      if (fs.existsSync(exe)) return { executablePath: exe, cwd: path.dirname(resolved) };
    }
    return null;
  }

  // Path to an unpacked electron-builder directory (linux/win layouts).
  if (fs.statSync(resolved).isDirectory()) {
    const names =
      process.platform === 'win32'
        ? ['Command EVE.exe', 'AionUi.exe']
        : ['Command EVE', 'command-eve', 'AionUi', 'aionui'];
    for (const name of names) {
      const exe = path.join(resolved, name);
      if (fs.existsSync(exe)) return { executablePath: exe, cwd: resolved };
    }
  }

  return null;
}

/** The gated packaged artifact this run was given (null → skip every suite). */
const PACKAGED_APP = resolvePackagedApp();

/**
 * Launch the PACKAGED Electron app with the given extra env. WITHOUT
 * AIONUI_DISABLE_AUTO_UPDATE so the production startup auto-update wiring runs
 * (initialize + delayed checkForUpdatesAndNotify). AIONUI_E2E_TEST isolates the
 * local runtime, while AIONUI_AUTO_UPDATE_E2E keeps only the updater enabled.
 * Fails loud if no packaged app exists.
 */
async function launchPackagedApp(extraEnv: Record<string, string>): Promise<PackagedAppHandle> {
  const packaged = resolvePackagedApp();
  if (!packaged) {
    // Unreachable when the describe-level gate is active — the suites skip
    // before beforeAll runs. Kept as a fail-closed guard for direct reuse.
    throw new Error(`[auto-update e2e] ${PACKAGED_APP_SKIP_REASON}`);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_MULTI_INSTANCE: '1',
    AIONUI_CDP_PORT: '0',
    AIONUI_E2E_TEST: '1',
    AIONUI_AUTO_UPDATE_E2E: '1',
    COMMAND_EVE_REGISTRATION_REQUIRED: '0',
    NODE_ENV: 'production',
    ...extraEnv,
  };
  // Ensure the gates that would disable the updater are NOT inherited from the
  // playwright runner environment.
  delete env.AIONUI_DISABLE_AUTO_UPDATE;
  delete env.CI;
  delete env.GITHUB_ACTIONS;

  const launchArgs: string[] = [`--user-data-dir=${PACKAGED_USER_DATA_DIR}`];
  if (process.platform === 'darwin') launchArgs.push('--use-mock-keychain');
  if (process.platform === 'linux' && process.env.CI) launchArgs.push('--no-sandbox');

  const child = spawn(packaged.executablePath, ['--remote-debugging-port=0', ...launchArgs], {
    cwd: packaged.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let diagnostics = '';
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`[auto-update e2e] CDP endpoint did not appear. Output:\n${diagnostics}`));
    }, 60_000);
    const consume = (chunk: Buffer) => {
      diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-20_000);
      const match = diagnostics.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      resolve(match[1]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `[auto-update e2e] Packaged app exited before CDP was ready (code=${code}, signal=${signal}). Output:\n${diagnostics}`
        )
      );
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('exit', onExit);
  });

  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 30_000 });
    return {
      browser,
      process: child,
      close: () => closePackagedApp(browser, child),
    };
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}

/**
 * Install a page-side capturing listener that records every auto-update.status
 * event the renderer receives (the production ipcBridge emitter envelope is
 * {name, data}). Stored on window for later polling.
 */
async function installStatusCapture(page: Page): Promise<void> {
  await page.evaluate((channel) => {
    const w = window as unknown as {
      electronAPI?: { on: (cb: (e: { value: string }) => void) => () => void };
      __autoUpdateStatuses?: Array<{ status: string; version?: string; error?: string }>;
    };
    w.__autoUpdateStatuses = w.__autoUpdateStatuses || [];
    if (!w.electronAPI) return;
    w.electronAPI.on((event) => {
      try {
        const { name, data } = JSON.parse(event.value) as {
          name: string;
          data: { status: string; version?: string; error?: string };
        };
        if (name === channel && data && typeof data.status === 'string') {
          w.__autoUpdateStatuses!.push({ status: data.status, version: data.version, error: data.error });
        }
      } catch {
        // ignore non-JSON frames
      }
    });
  }, STATUS_CHANNEL);
}

/** True once a terminal (available | error) status has been captured. */
function hasTerminalStatus(statuses: CapturedStatus[]): boolean {
  return statuses.some((x) => x.status === 'available' || x.status === 'error');
}

async function readCapturedStatuses(page: Page): Promise<CapturedStatus[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __autoUpdateStatuses?: CapturedStatus[] };
    return w.__autoUpdateStatuses || [];
  });
}

/** Poll until the predicate over captured statuses holds, or time out. */
async function waitForStatus(
  page: Page,
  predicate: (statuses: CapturedStatus[]) => boolean,
  timeoutMs: number
): Promise<CapturedStatus[]> {
  const deadline = Date.now() + timeoutMs;
  let last: CapturedStatus[] = [];
  while (Date.now() < deadline) {
    last = await readCapturedStatuses(page);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

async function openUpdateModalViaFooter(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.getByTestId('sider-footer-update').click();
    const visible = await page
      .getByText('Bereit zur Installation')
      .waitFor({ state: 'visible', timeout: attempt === 3 ? 30_000 : 5_000 })
      .then(() => true)
      .catch(() => false);
    if (visible) return;
    await page.waitForTimeout(500);
  }
  throw new Error('Update modal did not render the downloaded-state signal after repeated footer clicks.');
}

// ── Suite A: feed configured → detect + broadcast + visible German signal ─────

test.describe.serial('Command EVE auto-update – detect + signal against local feed', () => {
  test.skip(!PACKAGED_APP, PACKAGED_APP_SKIP_REASON);
  test.setTimeout(300_000);

  let feed: { dir: string; cleanup: () => void };
  let feedServer: Server;
  let feedUrl: string;
  let packagedApp: PackagedAppHandle;
  let page: Page;

  test.beforeAll(async () => {
    feed = buildFeedDir();
    const started = await startFeedServer(feed.dir);
    feedServer = started.server;
    feedUrl = started.url;
    packagedApp = await launchPackagedApp({ COMMAND_EVE_UPDATE_FEED_URL: feedUrl });
    page = await resolveMainWindow(packagedApp.browser);
    // Install the status capture as early as possible — ideally before the ~3s
    // startup auto-check broadcasts. The renderer-bridge backstop in test (a)
    // covers the case where the auto-check already fired.
    await installStatusCapture(page);
  });

  test.afterAll(async () => {
    await packagedApp?.close().catch(() => {});
    await new Promise<void>((resolve) => feedServer?.close(() => resolve()));
    feed?.cleanup();
  });

  test('(a) reaches status available with the feed version via the real startup check', async () => {
    // Sanity: the feed server actually serves the channel yml the updater requests.
    const ymlRes = await page.evaluate(async (url) => {
      const r = await fetch(`${url}latest-arm64-mac.yml`);
      return { ok: r.ok, body: await r.text() };
    }, feedUrl);
    expect(ymlRes.ok, 'local feed must serve latest-arm64-mac.yml').toBe(true);
    expect(ymlRes.body).toContain(`version: ${FEED_VERSION}`);

    // The production startup wiring fires checkForUpdatesAndNotify() ~3s after
    // app-ready. As a deterministic backstop (init-order independent), also drive
    // the same W8 configureFeed path through the renderer auto-update bridge if the
    // startup auto-check has not yet produced a terminal status.
    let statuses = await waitForStatus(page, hasTerminalStatus, 12_000);
    if (!hasTerminalStatus(statuses)) {
      await invokeBridge(page, 'auto-update.check', { includePrerelease: false }, 30_000);
      statuses = await waitForStatus(page, hasTerminalStatus, 25_000);
    }

    const errorStatus = statuses.find((s) => s.status === 'error');
    expect(errorStatus, `update check broadcast an error: ${errorStatus?.error ?? ''}`).toBeUndefined();

    const available = statuses.find((s) => s.status === 'available');
    expect(available, `updater must reach 'available'; captured: ${JSON.stringify(statuses)}`).toBeTruthy();
    expect(available?.version, 'available version must equal the feed version').toBe(FEED_VERSION);
  });

  test('(b) stays quiet, then shows ready details only after the footer icon is clicked', async () => {
    const statuses = await waitForStatus(page, (items) => items.some((item) => item.status === 'downloaded'), 30_000);
    const errorStatus = statuses.find((item) => item.status === 'error');
    expect(errorStatus, `background download failed: ${errorStatus?.error ?? ''}`).toBeUndefined();
    expect(statuses.some((item) => item.status === 'downloaded' && item.version === FEED_VERSION)).toBe(true);

    await expect(page.getByText('Bereit zur Installation')).toBeHidden();
    await expect(page.getByTestId('sider-footer-update')).toHaveAttribute('data-update-status', 'downloaded');

    await openUpdateModalViaFooter(page);

    await expect(page.getByText('Bereit zur Installation')).toBeVisible({ timeout: 30_000 });
    // The version the user sees must be the feed version.
    await expect(page.getByText(FEED_VERSION).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Ruhige Hintergrund-Updates')).toBeVisible({ timeout: 10_000 });
  });
});

// ── Suite B: CE shell default → R2 feed active (no env override) ──────────────

/**
 * Proves FIX 1: an installed Command EVE build with NO COMMAND_EVE_UPDATE_FEED_URL
 * and NO persisted update.feedUrl no longer stays in the W8 quiet no-op — the
 * resolver falls back to the CE-scoped R2 base (COMMAND_EVE_UPDATE_FEED_BASE_URL),
 * so configureFeed wires the generic provider and the startup check actually runs
 * (it broadcasts 'checking'). This is the discriminator against Suite C's
 * explicit empty-env opt-out, which stays silent.
 *
 * We assert the OBSERVABLE seam ('checking' is broadcast → the feed activated and
 * the updater started), NOT the network outcome: against the real public R2
 * bucket the result may be 'available', 'not-available', or a transient network
 * 'error', none of which are deterministic in e2e. The hermetic proof that the
 * default resolves to the exact R2 base lives in the autoUpdaterFeed unit test
 * (configureFeed → setFeedURL url === COMMAND_EVE_UPDATE_FEED_BASE_URL).
 */
test.describe.serial('Command EVE auto-update – CE shell defaults to the R2 feed (no env override)', () => {
  test.skip(!PACKAGED_APP, PACKAGED_APP_SKIP_REASON);
  test.setTimeout(300_000);

  let packagedApp: PackagedAppHandle;
  let page: Page;

  test.beforeAll(async () => {
    // Launch WITHOUT COMMAND_EVE_UPDATE_FEED_URL at all (delete any inherited
    // value) so the CE-scoped R2 default is the only feed source. This is the
    // Alois-machine condition.
    packagedApp = await launchPackagedApp({});
    page = await resolveMainWindow(packagedApp.browser);
    await installStatusCapture(page);
  });

  test.afterAll(async () => {
    await packagedApp?.close().catch(() => {});
  });

  test('(d) startup check activates (broadcasts "checking") instead of the quiet no-op', async () => {
    // The R2 default makes configureFeed resolve a feed, so the startup
    // checkForUpdatesAndNotify() calls into electron-updater and the
    // 'checking-for-update' handler broadcasts a 'checking' status. We poll for
    // ANY broadcast status (checking/available/not-available/error all prove the
    // feed activated); the empty-env opt-out (Suite C) produces none of these.
    const sawAnyStatus = (statuses: CapturedStatus[]) => statuses.length > 0;
    let statuses = await waitForStatus(page, sawAnyStatus, 20_000);

    // Deterministic backstop: if the ~3s startup auto-check has not surfaced a
    // status yet, drive the same W8 configureFeed path via the renderer bridge.
    if (!sawAnyStatus(statuses)) {
      await invokeBridge(page, 'auto-update.check', { includePrerelease: false }, 30_000);
      statuses = await waitForStatus(page, sawAnyStatus, 25_000);
    }

    expect(
      statuses.length,
      `CE-shell default must activate the R2 feed and start a real check; captured: ${JSON.stringify(statuses)}`
    ).toBeGreaterThan(0);

    // If the check reached a terminal error, it must be a NETWORK/feed error from
    // actually contacting R2 — never the W8 "no feed configured" short-circuit
    // (which would mean the CE default failed to apply).
    const noFeedError = statuses.find(
      (s) => s.status === 'error' && /no feed|kein feed|feed configured/i.test(s.error || '')
    );
    expect(
      noFeedError,
      `the CE default must apply — no "no feed configured" error allowed: ${noFeedError?.error ?? ''}`
    ).toBeUndefined();
  });
});

// ── Suite C: no feed → quiet no-op, no error dialog ───────────────────────────

test.describe.serial('Command EVE auto-update – quiet no-op when no feed configured', () => {
  test.skip(!PACKAGED_APP, PACKAGED_APP_SKIP_REASON);
  test.setTimeout(300_000);

  let packagedApp: PackagedAppHandle;
  let page: Page;

  test.beforeAll(async () => {
    // COMMAND_EVE_UPDATE_FEED_URL='' is the EXPLICIT "force no feed" opt-out.
    // After FIX 1 the packaged CE build (COMMAND_EVE_SHELL_ENABLED === true) would
    // otherwise fall back to the R2 default (see Suite B), so the empty-string env
    // is what pins this instance into the W8 quiet no-op state for the proof.
    packagedApp = await launchPackagedApp({ COMMAND_EVE_UPDATE_FEED_URL: '' });
    page = await resolveMainWindow(packagedApp.browser);
    await installStatusCapture(page);
  });

  test.afterAll(async () => {
    await packagedApp?.close().catch(() => {});
  });

  test('(c) startup check resolves quietly, no available/error broadcast, no error dialog', async () => {
    // Give the production startup auto-check ample time to have run (and no-op).
    await new Promise((r) => setTimeout(r, 8_000));
    const statuses = await readCapturedStatuses(page);

    // Quiet no-op: the service short-circuits before electron-updater runs.
    // No 'checking', no 'available', no 'error' is broadcast.
    expect(
      statuses.find((s) => s.status === 'available'),
      'no update should be signalled without a feed'
    ).toBeUndefined();
    expect(
      statuses.find((s) => s.status === 'error'),
      'no error should be broadcast without a feed'
    ).toBeUndefined();
    expect(
      statuses.find((s) => s.status === 'checking'),
      'updater must not even start checking without a feed'
    ).toBeUndefined();

    // No error dialog / modal surfaced to the user.
    await expect(page.getByText('Update verfügbar')).toHaveCount(0);
    await expect(page.getByText('Update fehlgeschlagen')).toHaveCount(0);
    await expect(page.getByText('Update failed')).toHaveCount(0);
  });
});
