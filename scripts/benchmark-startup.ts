/**
 * Electron Cold Startup Benchmark
 *
 * Launches the Electron app N times and measures per-phase startup timings by
 * parsing the electron-log file for [AionUi:ready] / [AionUi:init] /
 * [AionUi:process] marks, plus `ready-to-show` / `did-finish-load` /
 * time-to-interactive (chat input visible).
 *
 * Optional `--with-memory` mode samples RSS / heap in the main and renderer
 * processes at three checkpoints (idle, afterConversation, afterClose) to
 * estimate per-conversation memory pressure and leaks. Packaged production
 * builds keep CDP disabled, so their safe measurement lane uses lifecycle
 * logs plus process-tree RSS and does not claim renderer heap samples.
 *
 * Usage:
 *   bunx tsx scripts/benchmark-startup.ts [--iterations 5] [--cooldown 2000]
 *   bunx tsx scripts/benchmark-startup.ts --with-memory
 *   bunx tsx scripts/benchmark-startup.ts --packaged --warmup 1 --with-memory
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  collectProcessTreePids,
  readProcessTable,
  rememberProcessTree,
  terminateProcessTree,
} from './benchmark-process-tree';
import { collectStartupGateFailures } from './benchmark-gates';

// ── CLI args ────────────────────────────────────────────────────────────────

type Args = {
  iterations: number;
  cooldownMs: number;
  launchTimeoutMs: number;
  interactiveTimeoutMs: number;
  outputJson: string | null;
  withMemory: boolean;
  packaged: boolean;
  userDataDir: string | null;
  resetProfile: boolean;
  warmupIterations: number;
  strict: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    iterations: 5,
    cooldownMs: 2_000,
    launchTimeoutMs: 90_000,
    interactiveTimeoutMs: 60_000,
    outputJson: null,
    withMemory: false,
    packaged: false,
    userDataDir: null,
    resetProfile: true,
    warmupIterations: 0,
    strict: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--iterations' && next) {
      args.iterations = parseInt(next, 10);
      i++;
    } else if (flag === '--cooldown' && next) {
      args.cooldownMs = parseInt(next, 10);
      i++;
    } else if (flag === '--launch-timeout' && next) {
      args.launchTimeoutMs = parseInt(next, 10);
      i++;
    } else if (flag === '--interactive-timeout' && next) {
      args.interactiveTimeoutMs = parseInt(next, 10);
      i++;
    } else if (flag === '--output' && next) {
      args.outputJson = next;
      i++;
    } else if (flag === '--with-memory') {
      args.withMemory = true;
    } else if (flag === '--packaged') {
      args.packaged = true;
    } else if (flag === '--user-data-dir' && next) {
      args.userDataDir = path.resolve(next);
      i++;
    } else if (flag === '--keep-profile') {
      args.resetProfile = false;
    } else if (flag === '--warmup' && next) {
      args.warmupIterations = parseInt(next, 10);
      i++;
    } else if (flag === '--strict') {
      args.strict = true;
    }
  }

  if (!Number.isFinite(args.iterations) || args.iterations < 1) args.iterations = 5;
  if (!Number.isFinite(args.warmupIterations) || args.warmupIterations < 0) args.warmupIterations = 0;
  return args;
}

// ── Types ───────────────────────────────────────────────────────────────────

type MainMemorySample = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

type RendererMemorySample = {
  usedSize: number;
  totalSize: number;
};

type ProcessTreeMemorySample = {
  rootRss: number;
  totalRss: number;
  processCount: number;
};

type MemorySnapshot = {
  main: MainMemorySample | null;
  renderer: RendererMemorySample | null;
  processTree: ProcessTreeMemorySample | null;
  takenAt: string;
};

type MemoryProfile = {
  idle: MemorySnapshot | null;
  afterConversation: MemorySnapshot | null;
  afterClose: MemorySnapshot | null;
  // Leak estimate = afterClose - idle (main RSS + renderer usedSize)
  leakMainRssBytes: number;
  leakRendererUsedBytes: number;
  leakProcessTreeRssBytes: number;
  // Convenience deltas (afterConversation - idle)
  openDeltaMainRssBytes: number;
  openDeltaRendererUsedBytes: number;
  openDeltaProcessTreeRssBytes: number;
};

type BenchmarkApp =
  | {
      kind: 'electron';
      app: ElectronApplication;
      pid: number;
    }
  | {
      kind: 'packaged';
      process: ChildProcess;
      pid: number;
      knownProcessIds: Set<number>;
      diagnostics: () => string;
    };

type StartupTiming = {
  iteration: number;
  timestamp: string;
  measurementMode: 'playwright' | 'packaged-lifecycle';
  failed: boolean;
  failureReason: string | null;
  // Wall-clock measurements from Playwright side
  wallFirstWindowMs: number;
  wallDomContentLoadedMs: number;
  wallTimeToInteractiveMs: number;
  wallTotalMs: number;
  // Parsed from [AionUi:ready] marks
  readyInitializeProcessMs: number;
  readyInitializeZoomFactorMs: number;
  readyCreateWindowMs: number;
  readyInitializeAcpDetectorMs: number;
  // Parsed from [AionUi:init] marks
  initTotalMs: number;
  // Parsed from [AionUi:process] marks
  processInitStorageMs: number;
  processExtensionRegistryMs: number;
  processChannelManagerMs: number;
  // Parsed from window lifecycle logs
  logRendererDidFinishLoadPresent: boolean;
  logWindowReadyToShowPresent: boolean;
  logShowingMainWindowPresent: boolean;
  // Optional memory profile (only when --with-memory is passed)
  memory: MemoryProfile | null;
};

// ── Selectors ───────────────────────────────────────────────────────────────

const GUID_INPUT = '.guid-input-card-shell textarea';
const AGENT_PILL = '[data-agent-pill="true"]';

// ── Log file helpers ────────────────────────────────────────────────────────

function getLogFilePath(packaged: boolean, homeDir = os.homedir()): string {
  const today = new Date().toISOString().slice(0, 10);
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    const logRoot = path.join(homeDir, 'Library', 'Logs');
    if (packaged) {
      candidates.push(path.join(logRoot, 'Command EVE', `${today}.log`));
    } else {
      candidates.push(
        path.join(logRoot, 'Command EVE-dev', `${today}.log`),
        path.join(logRoot, 'Command EVE-dev-2', `${today}.log`),
        path.join(logRoot, 'AionUi-Dev', `${today}.log`)
      );
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(path.join(appData, packaged ? 'Command EVE' : 'Command EVE-dev', 'logs', `${today}.log`));
  } else {
    candidates.push(
      path.join(homeDir, '.config', packaged ? 'Command EVE' : 'Command EVE-dev', 'logs', `${today}.log`)
    );
  }
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function getLogFileSize(logPath: string): number {
  try {
    return fs.statSync(logPath).size;
  } catch {
    return 0;
  }
}

function readNewLogLines(logPath: string, offset: number): string[] {
  try {
    const currentSize = fs.statSync(logPath).size;
    if (currentSize <= offset) return [];
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(currentSize - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf-8').split('\n');
  } catch {
    return [];
  }
}

// ── Log parsing ─────────────────────────────────────────────────────────────

// Matches: [AionUi:ready] <label> +<ms>ms
// Matches: [AionUi:init]  <label> +<ms>ms
// Matches: [AionUi:process] <label> +<ms>ms
const MARK_REGEX = /\[(?:AionUi|CommandEVE):(ready|init|process)\]\s+([^+]+?)\s+\+(\d+)ms/;

type ParsedMarks = {
  ready: Map<string, number>;
  init: Map<string, number>;
  process: Map<string, number>;
  logs: { rendererDidFinishLoad: boolean; windowReadyToShow: boolean; showingMainWindow: boolean };
};

function parseStartupLog(lines: string[]): ParsedMarks {
  const marks: ParsedMarks = {
    ready: new Map(),
    init: new Map(),
    process: new Map(),
    logs: { rendererDidFinishLoad: false, windowReadyToShow: false, showingMainWindow: false },
  };

  for (const line of lines) {
    const m = MARK_REGEX.exec(line);
    if (m) {
      const [, scope, label, msStr] = m;
      const ms = parseInt(msStr, 10);
      const key = label.trim();
      if (scope === 'ready') marks.ready.set(key, ms);
      else if (scope === 'init') marks.init.set(key, ms);
      else if (scope === 'process') marks.process.set(key, ms);
      continue;
    }

    if (line.includes('Renderer did-finish-load')) marks.logs.rendererDidFinishLoad = true;
    else if (line.includes('Window ready-to-show')) marks.logs.windowReadyToShow = true;
    else if (line.includes('Showing main window')) marks.logs.showingMainWindow = true;
  }

  return marks;
}

// ── App launch ──────────────────────────────────────────────────────────────

function getProjectRoot(): string {
  const requestedRoot = process.env.AIONUI_BENCH_PROJECT_ROOT?.trim();
  return requestedRoot ? path.resolve(requestedRoot) : path.resolve(__dirname, '..');
}

function resolvePackagedApp(projectRoot: string): { executablePath: string; cwd: string } | null {
  if (process.platform === 'darwin') {
    for (const directory of ['mac-arm64', 'mac-x64', 'mac', 'mac-universal']) {
      const cwd = path.join(projectRoot, 'out', directory);
      if (!fs.existsSync(cwd)) continue;
      const appBundle = fs.readdirSync(cwd).find((entry) => entry.endsWith('.app'));
      if (!appBundle) continue;
      for (const executable of ['Command EVE', 'AionUi']) {
        const executablePath = path.join(cwd, appBundle, 'Contents', 'MacOS', executable);
        if (fs.existsSync(executablePath)) return { executablePath, cwd };
      }
    }
  }

  if (process.platform === 'win32') {
    for (const directory of ['win-unpacked', 'win-arm64-unpacked', 'win-x64-unpacked']) {
      const cwd = path.join(projectRoot, 'out', directory);
      for (const executable of ['Command EVE.exe', 'AionUi.exe']) {
        const executablePath = path.join(cwd, executable);
        if (fs.existsSync(executablePath)) return { executablePath, cwd };
      }
    }
  }

  for (const directory of ['linux-unpacked', 'linux-arm64-unpacked', 'linux-x64-unpacked']) {
    const cwd = path.join(projectRoot, 'out', directory);
    for (const executable of ['command-eve', 'Command EVE', 'aionui', 'AionUi']) {
      const executablePath = path.join(cwd, executable);
      if (fs.existsSync(executablePath)) return { executablePath, cwd };
    }
  }

  return null;
}

function launchPackagedApp(
  packaged: { executablePath: string; cwd: string },
  launchArgs: string[],
  env: NodeJS.ProcessEnv
): BenchmarkApp {
  const child = spawn(packaged.executablePath, launchArgs, {
    cwd: packaged.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  const consume = (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-20_000);
  };
  child.stdout?.on('data', consume);
  child.stderr?.on('data', consume);
  const pid = child.pid ?? 0;
  return {
    kind: 'packaged',
    process: child,
    pid,
    knownProcessIds: new Set(pid > 1 ? [pid] : []),
    diagnostics: () => diagnostics,
  };
}

async function launchApp(args: Args): Promise<BenchmarkApp> {
  const projectRoot = getProjectRoot();
  const isolatedHome = args.packaged && args.userDataDir ? path.join(args.userDataDir, 'home') : null;
  if (isolatedHome) fs.mkdirSync(isolatedHome, { recursive: true });
  const commonEnv = {
    ...process.env,
    ...(isolatedHome
      ? {
          HOME: isolatedHome,
          XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
          XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
        }
      : {}),
    AIONUI_DISABLE_AUTO_UPDATE: '1',
    AIONUI_E2E_TEST: '1',
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_MULTI_INSTANCE: '1',
    AIONUI_CDP_PORT: '0',
    COMMAND_EVE_REGISTRATION_REQUIRED: '0',
    NODE_ENV: 'production',
  };

  if (args.packaged) {
    const packaged = resolvePackagedApp(projectRoot);
    if (!packaged) {
      throw new Error('No packaged app found under out/. Build the arm64 directory package before benchmarking.');
    }
    const launchArgs = args.userDataDir ? [`--user-data-dir=${args.userDataDir}`] : [];
    if (process.platform === 'darwin') launchArgs.push('--use-mock-keychain');
    if (args.withMemory) launchArgs.push('--js-flags=--expose-gc');
    return launchPackagedApp(packaged, launchArgs, commonEnv);
  }

  // Ensure production build exists
  const mainEntry = path.join(projectRoot, 'out/main/index.js');
  if (!fs.existsSync(mainEntry)) {
    console.log('[bench:startup] Building production bundle (electron-vite build)...');
    const { execSync } = require('child_process');
    execSync('npx electron-vite build', { cwd: projectRoot, stdio: 'inherit' });
  }

  const launchArgs = args.withMemory ? [mainEntry, '--js-flags=--expose-gc'] : [mainEntry];
  const app = await electron.launch({
    args: launchArgs,
    cwd: projectRoot,
    env: commonEnv,
    timeout: args.launchTimeoutMs,
  });
  return { kind: 'electron', app, pid: app.process().pid ?? 0 };
}

async function resolveMainWindow(handle: BenchmarkApp, timeoutMs: number): Promise<Page> {
  if (handle.kind === 'packaged') {
    throw new Error('Packaged production builds must use the CDP-free lifecycle benchmark path');
  }

  const existing = handle.app.windows().find((w) => !w.url().startsWith('devtools://'));
  if (existing) {
    await existing.waitForLoadState('domcontentloaded');
    return existing;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(250, deadline - Date.now());
    const win = await handle.app.waitForEvent('window', { timeout: Math.min(1_000, remaining) }).catch(() => null);
    if (win && !win.url().startsWith('devtools://')) {
      await win.waitForLoadState('domcontentloaded');
      return win;
    }
  }
  throw new Error('Failed to resolve main window within timeout');
}

type PackagedLifecycleTiming = {
  rendererDidFinishLoadMs: number;
  showingMainWindowMs: number;
  windowReadyToShowMs: number;
};

function logLineElapsedMs(line: string, wallStart: number): number {
  const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/.exec(line);
  if (!match) return Date.now() - wallStart;
  const timestamp = Date.parse(match[1].replace(' ', 'T'));
  return Number.isFinite(timestamp) ? Math.max(1, timestamp - wallStart) : Date.now() - wallStart;
}

async function waitForPackagedLifecycle(
  handle: Extract<BenchmarkApp, { kind: 'packaged' }>,
  logPath: string,
  logOffset: number,
  wallStart: number,
  timeoutMs: number
): Promise<PackagedLifecycleTiming> {
  const deadline = wallStart + timeoutMs;
  const timing: PackagedLifecycleTiming = {
    rendererDidFinishLoadMs: 0,
    showingMainWindowMs: 0,
    windowReadyToShowMs: 0,
  };

  while (Date.now() < deadline) {
    rememberProcessTree(handle.pid, handle.knownProcessIds);
    if (handle.process.exitCode !== null) {
      throw new Error(
        `Packaged app exited before the main window was ready (code=${handle.process.exitCode}).\n${handle.diagnostics()}`
      );
    }

    for (const line of readNewLogLines(logPath, logOffset)) {
      if (!timing.rendererDidFinishLoadMs && line.includes('Renderer did-finish-load')) {
        timing.rendererDidFinishLoadMs = logLineElapsedMs(line, wallStart);
      } else if (!timing.showingMainWindowMs && line.includes('Showing main window')) {
        timing.showingMainWindowMs = logLineElapsedMs(line, wallStart);
      } else if (!timing.windowReadyToShowMs && line.includes('Window ready-to-show')) {
        timing.windowReadyToShowMs = logLineElapsedMs(line, wallStart);
      }
    }

    if (timing.rendererDidFinishLoadMs && timing.showingMainWindowMs) return timing;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Packaged lifecycle logs did not reach renderer-ready + window-shown within ${timeoutMs}ms. ` +
      `log=${logPath}\n${handle.diagnostics()}`
  );
}

async function closeApp(handle: BenchmarkApp): Promise<void> {
  if (handle.kind === 'electron') {
    try {
      await handle.app.evaluate(async ({ app }) => app.exit(0));
    } catch {
      // The app may already have exited after a failed launch.
    }
    await handle.app.close().catch(() => {});
    return;
  }

  rememberProcessTree(handle.pid, handle.knownProcessIds);
  const cleanup = await terminateProcessTree(handle.pid, { knownProcessIds: handle.knownProcessIds });
  if (cleanup.survivors.length > 0) {
    throw new Error(`Packaged benchmark left process-tree survivors: ${cleanup.survivors.join(', ')}`);
  }
}

// ── Memory sampling ─────────────────────────────────────────────────────────

async function sampleMainMemory(handle: BenchmarkApp): Promise<MainMemorySample | null> {
  if (handle.kind !== 'electron') return null;
  try {
    return await handle.app.evaluate(async () => {
      const gc = (globalThis as { gc?: () => void }).gc;
      if (typeof gc === 'function') {
        gc();
        gc();
      }
      const m = process.memoryUsage();
      return {
        rss: m.rss,
        heapTotal: m.heapTotal,
        heapUsed: m.heapUsed,
        external: m.external,
        arrayBuffers: m.arrayBuffers,
      };
    });
  } catch {
    return null;
  }
}

function sampleProcessTreeMemory(handle: BenchmarkApp): ProcessTreeMemorySample | null {
  if (!handle.pid || process.platform === 'win32') return null;
  const rows = readProcessTable();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const processIds = collectProcessTreePids(handle.pid, rows);
  if (handle.kind === 'packaged') {
    for (const pid of processIds) handle.knownProcessIds.add(pid);
  }
  if (processIds.length === 0) return null;
  return {
    rootRss: byPid.get(handle.pid)?.rssBytes ?? 0,
    totalRss: processIds.reduce((sum, pid) => sum + (byPid.get(pid)?.rssBytes ?? 0), 0),
    processCount: processIds.length,
  };
}

async function sampleRendererMemory(page: Page): Promise<RendererMemorySample | null> {
  try {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send('HeapProfiler.enable').catch(() => {});
      await client.send('HeapProfiler.collectGarbage').catch(() => {});
      const heap = (await client.send('Runtime.getHeapUsage')) as { usedSize: number; totalSize: number };
      return { usedSize: heap.usedSize, totalSize: heap.totalSize };
    } finally {
      await client.detach().catch(() => {});
    }
  } catch {
    return null;
  }
}

async function takeSnapshot(handle: BenchmarkApp, page: Page | null): Promise<MemorySnapshot> {
  // Let pending microtasks settle before sampling
  await new Promise((r) => setTimeout(r, 500));
  const [main, renderer] = await Promise.all([
    sampleMainMemory(handle),
    page ? sampleRendererMemory(page) : Promise.resolve(null),
  ]);
  return {
    main,
    renderer,
    processTree: sampleProcessTreeMemory(handle),
    takenAt: new Date().toISOString(),
  };
}

function computeMemoryDeltas(
  idle: MemorySnapshot | null,
  afterConversation: MemorySnapshot | null,
  afterClose: MemorySnapshot | null
): Pick<
  MemoryProfile,
  | 'leakMainRssBytes'
  | 'leakRendererUsedBytes'
  | 'leakProcessTreeRssBytes'
  | 'openDeltaMainRssBytes'
  | 'openDeltaRendererUsedBytes'
  | 'openDeltaProcessTreeRssBytes'
> {
  const idleRss = idle?.main?.rss ?? 0;
  const idleRenderer = idle?.renderer?.usedSize ?? 0;
  const convRss = afterConversation?.main?.rss ?? 0;
  const convRenderer = afterConversation?.renderer?.usedSize ?? 0;
  const closeRss = afterClose?.main?.rss ?? 0;
  const closeRenderer = afterClose?.renderer?.usedSize ?? 0;
  const idleProcessTree = idle?.processTree?.totalRss ?? 0;
  const convProcessTree = afterConversation?.processTree?.totalRss ?? 0;
  const closeProcessTree = afterClose?.processTree?.totalRss ?? 0;

  return {
    leakMainRssBytes: closeRss > 0 && idleRss > 0 ? closeRss - idleRss : 0,
    leakRendererUsedBytes: closeRenderer > 0 && idleRenderer > 0 ? closeRenderer - idleRenderer : 0,
    leakProcessTreeRssBytes: closeProcessTree > 0 && idleProcessTree > 0 ? closeProcessTree - idleProcessTree : 0,
    openDeltaMainRssBytes: convRss > 0 && idleRss > 0 ? convRss - idleRss : 0,
    openDeltaRendererUsedBytes: convRenderer > 0 && idleRenderer > 0 ? convRenderer - idleRenderer : 0,
    openDeltaProcessTreeRssBytes: convProcessTree > 0 && idleProcessTree > 0 ? convProcessTree - idleProcessTree : 0,
  };
}

// ── Conversation open/close actions ─────────────────────────────────────────

/**
 * Open a conversation by clicking the first available agent pill on the guid page.
 * Does not send a message; waits until the pill enters the `data-agent-selected`
 * state. Returns true if a pill was successfully selected.
 */
async function openConversation(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    const pill = page.locator(AGENT_PILL).first();
    await pill.waitFor({ state: 'visible', timeout: timeoutMs });
    await pill.click();
    // Wait for the selected state to indicate the agent is ready
    await page.waitForSelector(`${AGENT_PILL}[data-agent-selected="true"]`, { timeout: timeoutMs }).catch(() => {});
    // Also wait for the textarea to become interactive (agent probe finished)
    await page
      .locator(GUID_INPUT)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the current conversation by navigating back to the guid landing page.
 * This mirrors the user gesture of returning to "new chat" without picking an agent.
 */
async function closeConversation(page: Page): Promise<void> {
  await page.evaluate(() => window.location.assign('#/guid'));
  await page.waitForFunction(() => window.location.hash === '#/guid', undefined, { timeout: 5_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
}

// ── Single iteration ────────────────────────────────────────────────────────

async function runOneIteration(iteration: number, args: Args): Promise<StartupTiming> {
  const logHome = args.packaged && args.userDataDir ? path.join(args.userDataDir, 'home') : os.homedir();
  const logPath = getLogFilePath(args.packaged, logHome);
  const logOffset = getLogFileSize(logPath);
  const timestamp = new Date().toISOString();

  let failed = false;
  let failureReason: string | null = null;
  let app: BenchmarkApp | null = null;
  let memory: MemoryProfile | null = null;

  const wallStart = Date.now();
  let wallFirstWindow = 0;
  let wallDomContentLoaded = 0;
  let wallInteractive = 0;
  let wallTotal = 0;

  try {
    app = await launchApp(args);
    if (app.kind === 'packaged') {
      const lifecycle = await waitForPackagedLifecycle(app, logPath, logOffset, wallStart, args.launchTimeoutMs);
      wallFirstWindow = lifecycle.windowReadyToShowMs || lifecycle.showingMainWindowMs;
      wallDomContentLoaded = lifecycle.rendererDidFinishLoadMs;
      // Production CDP stays disabled. Renderer-loaded + window-shown is the
      // strongest non-invasive usable-window proxy available in a signed app.
      wallInteractive = Math.max(lifecycle.rendererDidFinishLoadMs, lifecycle.showingMainWindowMs);
      await new Promise((r) => setTimeout(r, 1_000));
      wallTotal = Date.now() - wallStart;

      if (args.withMemory) {
        await new Promise((r) => setTimeout(r, 5_000));
        const idle = await takeSnapshot(app, null);
        memory = {
          idle,
          afterConversation: null,
          afterClose: null,
          ...computeMemoryDeltas(idle, null, null),
        };
      }
    } else {
      const page = await resolveMainWindow(app, args.launchTimeoutMs);
      wallFirstWindow = Date.now() - wallStart;

      await page.waitForLoadState('domcontentloaded', { timeout: args.interactiveTimeoutMs });
      wallDomContentLoaded = Date.now() - wallStart;

      // Chat input visible = time-to-interactive (app is usable)
      await page.locator(GUID_INPUT).first().waitFor({ state: 'visible', timeout: args.interactiveTimeoutMs });
      wallInteractive = Date.now() - wallStart;

      // Give async init (ACP detector, etc.) a brief window to finish and flush logs
      await new Promise((r) => setTimeout(r, 1_000));
      wallTotal = Date.now() - wallStart;

      if (args.withMemory) {
        // 1. Idle — wait longer so background tasks (ACP detection, tray, i18n) settle
        await new Promise((r) => setTimeout(r, 5_000));
        const idle = await takeSnapshot(app, page);

        // 2. After opening a conversation (agent pill selected, no message sent)
        let afterConversation: MemorySnapshot | null = null;
        const opened = await openConversation(page, 15_000);
        if (opened) {
          await new Promise((r) => setTimeout(r, 2_000));
          afterConversation = await takeSnapshot(app, page);
        }

        // 3. After closing / navigating back to guid
        await closeConversation(page);
        await new Promise((r) => setTimeout(r, 2_000));
        const afterClose = await takeSnapshot(app, page);

        memory = {
          idle,
          afterConversation,
          afterClose,
          ...computeMemoryDeltas(idle, afterConversation, afterClose),
        };
      }
    }
  } catch (err) {
    failed = true;
    failureReason = err instanceof Error ? err.message : String(err);
    wallTotal = Date.now() - wallStart;
  } finally {
    if (app) await closeApp(app);
  }

  // Wait briefly for the log file to flush after process exit
  await new Promise((r) => setTimeout(r, 500));
  const logLines = readNewLogLines(logPath, logOffset);
  const marks = parseStartupLog(logLines);

  return {
    iteration,
    timestamp,
    measurementMode: args.packaged ? 'packaged-lifecycle' : 'playwright',
    failed,
    failureReason,
    wallFirstWindowMs: wallFirstWindow,
    wallDomContentLoadedMs: wallDomContentLoaded,
    wallTimeToInteractiveMs: wallInteractive,
    wallTotalMs: wallTotal,
    readyInitializeProcessMs: marks.ready.get('initializeProcess') ?? 0,
    readyInitializeZoomFactorMs: marks.ready.get('initializeZoomFactor') ?? 0,
    readyCreateWindowMs: marks.ready.get('createWindow') ?? 0,
    readyInitializeAcpDetectorMs: marks.ready.get('initializeAcpDetector') ?? 0,
    initTotalMs: marks.init.get('done') ?? 0,
    processInitStorageMs: marks.process.get('initStorage') ?? 0,
    processExtensionRegistryMs: marks.process.get('ExtensionRegistry') ?? 0,
    processChannelManagerMs: marks.process.get('ChannelManager') ?? 0,
    logRendererDidFinishLoadPresent: marks.logs.rendererDidFinishLoad,
    logWindowReadyToShowPresent: marks.logs.windowReadyToShow,
    logShowingMainWindowPresent: marks.logs.showingMainWindow,
    memory,
  };
}

// ── Statistics ──────────────────────────────────────────────────────────────

type Stats = { count: number; mean: number; median: number; p95: number; min: number; max: number };

function computeStats(values: number[]): Stats {
  const sorted = [...values].filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, mean: 0, median: 0, p95: 0, min: 0, max: 0 };
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = Math.round(sum / sorted.length);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { count: sorted.length, mean, median, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

function computeMemoryStats(values: number[]): Stats {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, mean: 0, median: 0, p95: 0, min: 0, max: 0 };
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = Math.round(sum / sorted.length);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return { count: sorted.length, mean, median, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

// ── Memory summary ──────────────────────────────────────────────────────────

type MemorySummary = {
  idleMainRss: Stats;
  idleMainHeapUsed: Stats;
  idleRendererUsed: Stats;
  idleProcessTreeRss: Stats;
  afterConversationMainRss: Stats;
  afterConversationRendererUsed: Stats;
  afterConversationProcessTreeRss: Stats;
  afterCloseMainRss: Stats;
  afterCloseRendererUsed: Stats;
  afterCloseProcessTreeRss: Stats;
  leakMainRssBytes: Stats;
  leakRendererUsedBytes: Stats;
  leakProcessTreeRssBytes: Stats;
  openDeltaMainRssBytes: Stats;
  openDeltaRendererUsedBytes: Stats;
  openDeltaProcessTreeRssBytes: Stats;
};

function computeMemorySummary(results: StartupTiming[]): MemorySummary | null {
  const withMem = results.filter((r) => !r.failed && r.memory);
  if (withMem.length === 0) return null;

  const pick = <T>(snapGet: (m: MemoryProfile) => number): Stats =>
    computeMemoryStats(withMem.map((r) => (r.memory ? snapGet(r.memory) : 0)));

  return {
    idleMainRss: pick((m) => m.idle?.main?.rss ?? 0),
    idleMainHeapUsed: pick((m) => m.idle?.main?.heapUsed ?? 0),
    idleRendererUsed: pick((m) => m.idle?.renderer?.usedSize ?? 0),
    idleProcessTreeRss: pick((m) => m.idle?.processTree?.totalRss ?? 0),
    afterConversationMainRss: pick((m) => m.afterConversation?.main?.rss ?? 0),
    afterConversationRendererUsed: pick((m) => m.afterConversation?.renderer?.usedSize ?? 0),
    afterConversationProcessTreeRss: pick((m) => m.afterConversation?.processTree?.totalRss ?? 0),
    afterCloseMainRss: pick((m) => m.afterClose?.main?.rss ?? 0),
    afterCloseRendererUsed: pick((m) => m.afterClose?.renderer?.usedSize ?? 0),
    afterCloseProcessTreeRss: pick((m) => m.afterClose?.processTree?.totalRss ?? 0),
    leakMainRssBytes: pick((m) => m.leakMainRssBytes),
    leakRendererUsedBytes: pick((m) => m.leakRendererUsedBytes),
    leakProcessTreeRssBytes: pick((m) => m.leakProcessTreeRssBytes),
    openDeltaMainRssBytes: pick((m) => m.openDeltaMainRssBytes),
    openDeltaRendererUsedBytes: pick((m) => m.openDeltaRendererUsedBytes),
    openDeltaProcessTreeRssBytes: pick((m) => m.openDeltaProcessTreeRssBytes),
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

function formatMb(bytes: number): string {
  if (bytes === 0) return '0MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

function printTerminalReport(results: StartupTiming[]): void {
  const successful = results.filter((r) => !r.failed);
  const failed = results.filter((r) => r.failed);

  console.log('\n' + '='.repeat(80));
  console.log('  Electron Cold Startup Benchmark — Summary');
  console.log('='.repeat(80));
  console.log(`  Iterations: ${results.length} (successful: ${successful.length}, failed: ${failed.length})`);
  console.log(`  Measurement: ${results[0]?.measurementMode ?? 'unknown'}`);
  console.log('-'.repeat(80));

  const rows: [string, Stats][] = [
    ['Wall: first window', computeStats(successful.map((r) => r.wallFirstWindowMs))],
    ['Wall: DOM loaded', computeStats(successful.map((r) => r.wallDomContentLoadedMs))],
    ['Wall: interactive', computeStats(successful.map((r) => r.wallTimeToInteractiveMs))],
    ['Wall: total', computeStats(successful.map((r) => r.wallTotalMs))],
    ['ready: initializeProcess', computeStats(successful.map((r) => r.readyInitializeProcessMs))],
    ['ready: createWindow', computeStats(successful.map((r) => r.readyCreateWindowMs))],
    ['ready: initAcpDetector', computeStats(successful.map((r) => r.readyInitializeAcpDetectorMs))],
    ['init: done (storage)', computeStats(successful.map((r) => r.initTotalMs))],
    ['process: initStorage', computeStats(successful.map((r) => r.processInitStorageMs))],
    ['process: ExtensionReg', computeStats(successful.map((r) => r.processExtensionRegistryMs))],
    ['process: ChannelMgr', computeStats(successful.map((r) => r.processChannelManagerMs))],
  ];

  const pad = 26;
  console.log(
    `  ${'Phase'.padEnd(pad)} ${'Mean'.padStart(8)} ${'Median'.padStart(8)} ${'P95'.padStart(8)} ${'Min'.padStart(8)} ${'Max'.padStart(8)} ${'N'.padStart(4)}`
  );
  console.log('-'.repeat(80));
  for (const [label, s] of rows) {
    console.log(
      `  ${label.padEnd(pad)} ${(s.mean + 'ms').padStart(8)} ${(s.median + 'ms').padStart(8)} ${(s.p95 + 'ms').padStart(8)} ${(s.min + 'ms').padStart(8)} ${(s.max + 'ms').padStart(8)} ${String(s.count).padStart(4)}`
    );
  }

  const memSummary = computeMemorySummary(successful);
  if (memSummary) {
    console.log('-'.repeat(80));
    console.log('  Memory Profile (median across runs)');
    console.log('-'.repeat(80));
    const memRows: [string, number][] = [
      ['Idle — main RSS', memSummary.idleMainRss.median],
      ['Idle — main heapUsed', memSummary.idleMainHeapUsed.median],
      ['Idle — renderer used', memSummary.idleRendererUsed.median],
      ['Idle — process tree', memSummary.idleProcessTreeRss.median],
      ['After conv — main RSS', memSummary.afterConversationMainRss.median],
      ['After conv — renderer', memSummary.afterConversationRendererUsed.median],
      ['After conv — proc tree', memSummary.afterConversationProcessTreeRss.median],
      ['After close — main RSS', memSummary.afterCloseMainRss.median],
      ['After close — renderer', memSummary.afterCloseRendererUsed.median],
      ['After close — proc tree', memSummary.afterCloseProcessTreeRss.median],
      ['Leak — main RSS', memSummary.leakMainRssBytes.median],
      ['Leak — renderer used', memSummary.leakRendererUsedBytes.median],
      ['Leak — process tree', memSummary.leakProcessTreeRssBytes.median],
      ['Δopen — main RSS', memSummary.openDeltaMainRssBytes.median],
      ['Δopen — renderer used', memSummary.openDeltaRendererUsedBytes.median],
      ['Δopen — process tree', memSummary.openDeltaProcessTreeRssBytes.median],
    ];
    for (const [label, bytes] of memRows) {
      console.log(`  ${label.padEnd(pad)} ${formatMb(bytes).padStart(10)}`);
    }
  }

  if (failed.length > 0) {
    console.log('-'.repeat(80));
    console.log('  Failed iterations:');
    for (const r of failed) {
      console.log(`    #${r.iteration}: ${r.failureReason ?? 'unknown'}`);
    }
  }

  console.log('='.repeat(80) + '\n');
}

function writeJsonReport(results: StartupTiming[], outputPath: string | null): string {
  const outputDir = path.join(__dirname, 'benchmark-results');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resolved = outputPath ?? path.join(outputDir, `startup-${now}.json`);

  const successful = results.filter((r) => !r.failed);
  const summary = {
    generatedAt: new Date().toISOString(),
    measurementMode: results[0]?.measurementMode ?? 'unknown',
    iterations: results.length,
    successful: successful.length,
    failed: results.length - successful.length,
    stats: {
      wallTimeToInteractive: computeStats(successful.map((r) => r.wallTimeToInteractiveMs)),
      wallTotal: computeStats(successful.map((r) => r.wallTotalMs)),
      readyInitializeProcess: computeStats(successful.map((r) => r.readyInitializeProcessMs)),
      readyCreateWindow: computeStats(successful.map((r) => r.readyCreateWindowMs)),
      readyInitializeAcpDetector: computeStats(successful.map((r) => r.readyInitializeAcpDetectorMs)),
      initTotal: computeStats(successful.map((r) => r.initTotalMs)),
      processInitStorage: computeStats(successful.map((r) => r.processInitStorageMs)),
      processExtensionRegistry: computeStats(successful.map((r) => r.processExtensionRegistryMs)),
      processChannelManager: computeStats(successful.map((r) => r.processChannelManagerMs)),
    },
    memorySummary: computeMemorySummary(successful),
    results,
  };

  fs.writeFileSync(resolved, JSON.stringify(summary, null, 2), 'utf-8');
  return resolved;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.packaged && !args.userDataDir) {
    args.userDataDir = path.join(os.tmpdir(), `command-eve-benchmark-${process.pid}`);
  }
  if (args.packaged && args.userDataDir && args.resetProfile) {
    fs.rmSync(args.userDataDir, { recursive: true, force: true });
  }
  console.log(
    `[bench:startup] iterations=${args.iterations} warmup=${args.warmupIterations} cooldown=${args.cooldownMs}ms ` +
      `launchTimeout=${args.launchTimeoutMs}ms withMemory=${args.withMemory} packaged=${args.packaged}`
  );

  const warmupArgs = { ...args, withMemory: false };
  for (let i = 1; i <= args.warmupIterations; i++) {
    console.log(`\n[bench:startup] --- warmup ${i}/${args.warmupIterations} (not measured) ---`);
    const warmup = await runOneIteration(0, warmupArgs);
    if (warmup.failed) {
      throw new Error(`Startup warmup failed: ${warmup.failureReason ?? 'unknown error'}`);
    }
    if (args.cooldownMs > 0) await new Promise((resolve) => setTimeout(resolve, args.cooldownMs));
  }

  const results: StartupTiming[] = [];
  for (let i = 1; i <= args.iterations; i++) {
    console.log(`\n[bench:startup] --- iteration ${i}/${args.iterations} ---`);
    const timing = await runOneIteration(i, args);
    results.push(timing);

    if (timing.failed) {
      console.log(`[bench:startup] #${i} FAILED: ${timing.failureReason}`);
    } else {
      const memSuffix = timing.memory
        ? ` idleRss=${formatMb(
            timing.memory.idle?.main?.rss ?? timing.memory.idle?.processTree?.totalRss ?? 0
          )} leakRss=${formatMb(timing.memory.leakMainRssBytes || timing.memory.leakProcessTreeRssBytes)}`
        : '';
      console.log(
        `[bench:startup] #${i} interactive=${timing.wallTimeToInteractiveMs}ms ` +
          `domLoaded=${timing.wallDomContentLoadedMs}ms ` +
          `createWindow=${timing.readyCreateWindowMs}ms ` +
          `initProcess=${timing.readyInitializeProcessMs}ms ` +
          `acp=${timing.readyInitializeAcpDetectorMs}ms` +
          memSuffix
      );
    }

    if (i < args.iterations && args.cooldownMs > 0) {
      await new Promise((r) => setTimeout(r, args.cooldownMs));
    }
  }

  printTerminalReport(results);
  const reportPath = writeJsonReport(results, args.outputJson);
  console.log(`[bench:startup] JSON report: ${reportPath}`);

  if (args.strict) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    const gateFailures = collectStartupGateFailures(report);
    if (gateFailures.length > 0) {
      console.error('[bench:startup] Strict startup gate failed:');
      for (const failure of gateFailures) {
        console.error(`  - ${failure}`);
      }
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('[bench:startup] Fatal error:', err);
  process.exit(1);
});
