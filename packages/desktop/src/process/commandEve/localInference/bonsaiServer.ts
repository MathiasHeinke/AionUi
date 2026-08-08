import childProcess, { type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * What `childProcess.spawn(..., { stdio: ['ignore', 'pipe', 'pipe'] })` actually
 * returns: no stdin, readable stdout and stderr.
 *
 * The handle used to be typed `SpawnedServerProcess`, which promises a
 * WRITABLE stdin this process was never given — `'ignore'` is the first stdio
 * slot. Nothing wrote to it, so nothing broke; but the declared type invited a
 * `server.process.stdin.write(...)` that would have thrown on null at runtime.
 * Naming the real shape removes the invitation instead of casting it away.
 */
type SpawnedServerProcess = ChildProcessByStdio<null, Readable, Readable>;
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureBonsaiPilotArtifacts, type BonsaiProvisionProgress } from './bonsaiProvisioner';
import {
  COMMAND_EVE_BONSAI_MODEL_ID,
  COMMAND_EVE_BONSAI_PILOT_VERSION,
  resolveBonsaiPilotPaths,
  type BonsaiPilotPaths,
} from './bonsaiManifest';

const ONE_GIB = 1024 ** 3;
const MIN_TOTAL_MEMORY_BYTES = 24 * ONE_GIB;
const MIN_FREE_MEMORY_PERCENT_BEFORE_START = 20;
const MIN_FREE_MEMORY_PERCENT_AFTER_START = 7;
const MAX_STARTUP_PAGEOUT_BYTES = ONE_GIB;
const SERVER_START_TIMEOUT_MS = 180_000;
const MEMORY_RECOVERY_TIMEOUT_MS = 120_000;
const SERVER_STOP_TIMEOUT_MS = 10_000;
const MAX_STARTUP_LOG_BYTES = 256 * 1024;
const PROCESS_RECEIPT_VERSION = 'command-eve-bonsai-server-process/v0';
const DEFAULT_BONSAI_CONTEXT_SIZE = 65_536;
const MAX_BONSAI_CONTEXT_SIZE = 65_536;

export type BonsaiMemorySnapshot = Readonly<{
  totalBytes: number;
  freePercent: number;
  pageouts: number;
  pageSizeBytes: number;
}>;

export type BonsaiPilotServer = Readonly<{
  baseUrl: string;
  model: typeof COMMAND_EVE_BONSAI_MODEL_ID;
  apiKey: string;
  pid: number;
  startedAt: string;
  memoryBefore: BonsaiMemorySnapshot;
  memoryAfter: BonsaiMemorySnapshot;
}>;

export type BonsaiServerOptions = Readonly<{
  userDataPath: string;
  autoProvision?: boolean;
  contextSize?: number;
  onProgress?: (progress: BonsaiProvisionProgress) => void;
}>;

type ActiveServer = BonsaiPilotServer & {
  process: SpawnedServerProcess;
  paths: BonsaiPilotPaths;
};

type StartingServer = Readonly<{
  process: SpawnedServerProcess;
  paths: BonsaiPilotPaths;
}>;

let activeServer: ActiveServer | undefined;
let startingServer: StartingServer | undefined;
let startInFlight: Promise<BonsaiPilotServer> | undefined;
let exitHookInstalled = false;

export function buildBonsaiServerArgs(args: { paths: BonsaiPilotPaths; contextSize: number }): string[] {
  return [
    '-m',
    args.paths.modelPath,
    '--alias',
    COMMAND_EVE_BONSAI_MODEL_ID,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '-ngl',
    '99',
    '-fa',
    'on',
    '-c',
    String(args.contextSize),
    '--parallel',
    '1',
    '--cache-type-k',
    'q4_0',
    '--cache-type-v',
    'q4_0',
    '--temp',
    '0.7',
    '--top-p',
    '0.95',
    '--top-k',
    '20',
    '--min-p',
    '0',
    '--jinja',
    '--reasoning',
    'on',
    '--reasoning-budget',
    '-1',
    '--reasoning-budget-message',
    'I have enough information. I will now provide the final answer.',
    '--reasoning-format',
    'deepseek',
    '--api-key-file',
    args.paths.apiKeyPath,
    '--no-ui',
    '--no-slots',
    '--timeout',
    '3600',
    '--sse-ping-interval',
    '15',
  ];
}

export function normalizeBonsaiContextSize(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BONSAI_CONTEXT_SIZE;
  return Math.max(4096, Math.min(MAX_BONSAI_CONTEXT_SIZE, Math.floor(value!)));
}

function runText(command: string, args: string[]): string {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout: 5_000 });
  return result.status === 0 ? result.stdout || '' : '';
}

export function readBonsaiMemorySnapshot(): BonsaiMemorySnapshot {
  const pressure = runText('/usr/bin/memory_pressure', ['-Q']);
  const freeMatch = /System-wide memory free percentage:\s*(\d+)%/i.exec(pressure);
  const vmStat = runText('/usr/bin/vm_stat', []);
  const pageSizeMatch = /page size of\s+(\d+)\s+bytes/i.exec(vmStat);
  const pageoutsMatch = /^Pageouts:\s+(\d+)\.?$/im.exec(vmStat);
  return {
    totalBytes: os.totalmem(),
    freePercent: freeMatch ? Number(freeMatch[1]) : Math.floor((os.freemem() / Math.max(1, os.totalmem())) * 100),
    pageouts: pageoutsMatch ? Number(pageoutsMatch[1]) : 0,
    pageSizeBytes: pageSizeMatch ? Number(pageSizeMatch[1]) : 4096,
  };
}

export function assertBonsaiMemoryAdmission(snapshot: BonsaiMemorySnapshot): void {
  if (snapshot.totalBytes < MIN_TOTAL_MEMORY_BYTES) {
    throw new Error('This Mac does not have enough memory for the local model pilot.');
  }
  if (snapshot.freePercent < MIN_FREE_MEMORY_PERCENT_BEFORE_START) {
    throw new Error('Not enough memory is free for the local model pilot. Close other heavy apps and try again.');
  }
}

export async function waitForBonsaiMemoryAdmission(
  options: {
    readSnapshot?: () => BonsaiMemorySnapshot;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<BonsaiMemorySnapshot> {
  const readSnapshot = options.readSnapshot ?? readBonsaiMemorySnapshot;
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + (options.timeoutMs ?? MEMORY_RECOVERY_TIMEOUT_MS);
  let snapshot = readSnapshot();
  while (
    snapshot.totalBytes >= MIN_TOTAL_MEMORY_BYTES &&
    snapshot.freePercent < MIN_FREE_MEMORY_PERCENT_BEFORE_START &&
    Date.now() < deadline
  ) {
    await sleep(500);
    snapshot = readSnapshot();
  }
  assertBonsaiMemoryAdmission(snapshot);
  return snapshot;
}

export function assertBonsaiMemoryAfterStart(before: BonsaiMemorySnapshot, after: BonsaiMemorySnapshot): void {
  const pageoutBytes = Math.max(0, after.pageouts - before.pageouts) * after.pageSizeBytes;
  if (after.freePercent < MIN_FREE_MEMORY_PERCENT_AFTER_START || pageoutBytes > MAX_STARTUP_PAGEOUT_BYTES) {
    throw new Error("The local model pilot exceeded this Mac's safe memory budget.");
  }
}

function writePrivateFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeProcessReceipt(paths: BonsaiPilotPaths, server: BonsaiPilotServer): void {
  writePrivateFile(
    paths.processReceiptPath,
    `${JSON.stringify(
      {
        version: PROCESS_RECEIPT_VERSION,
        pilot_version: COMMAND_EVE_BONSAI_PILOT_VERSION,
        pid: server.pid,
        started_at: server.startedAt,
        base_url: server.baseUrl,
        model: server.model,
      },
      null,
      2
    )}\n`
  );
}

function writeStartingProcessReceipt(paths: BonsaiPilotPaths, pid: number, startedAt: string): void {
  writePrivateFile(
    paths.processReceiptPath,
    `${JSON.stringify(
      {
        version: PROCESS_RECEIPT_VERSION,
        pilot_version: COMMAND_EVE_BONSAI_PILOT_VERSION,
        status: 'starting',
        pid,
        started_at: startedAt,
        model: COMMAND_EVE_BONSAI_MODEL_ID,
      },
      null,
      2
    )}\n`
  );
}

/**
 * ACCEPTS `undefined`, because the caller genuinely may not have a pid: a spawn
 * that never started has none. Widening the parameter rather than guarding at
 * four call sites keeps the check in the one place that already performs it —
 * the `Number.isSafeInteger` line below, which `undefined` fails, so the
 * behaviour is exactly what it already was. The narrower signature was the part
 * that did not match the implementation.
 */
function processCommand(pid: number | undefined): string {
  // The `typeof` half is what narrows: `Number.isSafeInteger` is typed
  // `(x: unknown) => boolean`, so it rejects `undefined` at runtime but tells
  // the compiler nothing. Same guard, now legible to both.
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return '';
  return runText('/bin/ps', ['-p', String(pid), '-o', 'command=']).trim();
}

/**
 * ACCEPTS `undefined`, because the caller genuinely may not have a pid: a spawn
 * that never started has none. Widening the parameter rather than guarding at
 * four call sites keeps the check in the one place that already performs it —
 * the `Number.isSafeInteger` line below, which `undefined` fails, so the
 * behaviour is exactly what it already was. The narrower signature was the part
 * that did not match the implementation.
 */
function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  // The `typeof` half is what narrows: `Number.isSafeInteger` is typed
  // `(x: unknown) => boolean`, so it rejects `undefined` at runtime but tells
  // the compiler nothing. Same guard, now legible to both.
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function reapStaleBonsaiProcess(paths: BonsaiPilotPaths): void {
  try {
    const receipt = JSON.parse(fs.readFileSync(paths.processReceiptPath, 'utf8')) as { pid?: number };
    const pid = Number(receipt.pid);
    const command = processCommand(pid);
    if (command.includes(paths.serverPath) && command.includes(paths.modelPath)) killProcessGroup(pid, 'SIGTERM');
  } catch {
    // No valid prior process receipt.
  }
  fs.rmSync(paths.processReceiptPath, { force: true });
  fs.rmSync(paths.apiKeyPath, { force: true });
}

async function unloadOllamaModels(): Promise<void> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return;
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    for (const model of payload.models || []) {
      if (!model.name) continue;
      await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(5_000),
      }).catch((): undefined => undefined);
    }
  } catch {
    // Ollama may not be running; that is already the desired unloaded state.
  }
}

function sanitizeStartupLog(line: string, paths: BonsaiPilotPaths, apiKey: string): string | undefined {
  const lower = line.toLowerCase();
  if (lower.includes('prompt') || lower.includes('completion') || lower.includes('request body')) return undefined;
  return line
    .replaceAll(apiKey, '[REDACTED]')
    .replaceAll(paths.modelPath, BONSAI_MODEL_FILE_LABEL)
    .replaceAll(paths.root, '[LOCAL_RUNTIME]');
}

const BONSAI_MODEL_FILE_LABEL = '[LOCAL_MODEL]';

function appendBoundedStartupLog(paths: BonsaiPilotPaths, line: string): void {
  let existingBytes = 0;
  try {
    existingBytes = fs.statSync(paths.logPath).size;
  } catch {
    existingBytes = 0;
  }
  if (existingBytes >= MAX_STARTUP_LOG_BYTES) return;
  fs.appendFileSync(paths.logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

function parseListeningPort(line: string): number | undefined {
  const explicit = /127\.0\.0\.1:(\d{2,5})/.exec(line);
  const generic = /\bport[:= ]+(\d{2,5})\b/i.exec(line);
  const value = Number(explicit?.[1] || generic?.[1]);
  return Number.isSafeInteger(value) && value > 0 && value <= 65535 ? value : undefined;
}

async function waitForHealthyServer(args: {
  child: SpawnedServerProcess;
  paths: BonsaiPilotPaths;
  apiKey: string;
}): Promise<number> {
  const startedAt = Date.now();
  let listeningPort: number | undefined;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let startupLogging = true;

  const onChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      listeningPort ??= parseListeningPort(line);
      if (!startupLogging) continue;
      const sanitized = sanitizeStartupLog(line, args.paths, args.apiKey);
      if (sanitized) appendBoundedStartupLog(args.paths, sanitized);
    }
  };
  args.child.stdout.on('data', onChunk);
  args.child.stderr.on('data', onChunk);
  args.child.once('exit', (code, signal) => {
    exited = { code, signal };
  });

  while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
    if (exited) throw new Error('The local model pilot stopped during startup.');
    if (listeningPort) {
      try {
        const response = await fetch(`http://127.0.0.1:${listeningPort}/health`, {
          headers: { authorization: `Bearer ${args.apiKey}` },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          startupLogging = false;
          return listeningPort;
        }
      } catch {
        // Model is still loading.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The local model pilot did not become ready in time.');
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    if (startingServer) killProcessGroup(startingServer.process.pid, 'SIGTERM');
    if (activeServer) killProcessGroup(activeServer.pid, 'SIGTERM');
  });
}

async function startBonsaiPilotServerOnce(options: BonsaiServerOptions): Promise<BonsaiPilotServer> {
  if (activeServer) return activeServer;
  await unloadOllamaModels();
  const before = await waitForBonsaiMemoryAdmission();

  const { paths } = await ensureBonsaiPilotArtifacts({
    userDataPath: options.userDataPath,
    autoDownload: options.autoProvision,
    onProgress: options.onProgress,
  });
  reapStaleBonsaiProcess(paths);
  fs.rmSync(paths.logPath, { force: true });
  const apiKey = crypto.randomBytes(32).toString('hex');
  writePrivateFile(paths.apiKeyPath, `${apiKey}\n`);
  const contextSize = normalizeBonsaiContextSize(options.contextSize);
  const child = childProcess.spawn(paths.serverPath, buildBonsaiServerArgs({ paths, contextSize }), {
    cwd: paths.runtimeDir,
    detached: true,
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: paths.runtimeDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) throw new Error('The local model pilot could not start.');
  const startedAt = new Date().toISOString();
  startingServer = { process: child, paths };
  child.once('exit', () => {
    if (activeServer?.pid === child.pid) activeServer = undefined;
    if (startingServer?.process.pid === child.pid) startingServer = undefined;
    fs.rmSync(paths.apiKeyPath, { force: true });
    fs.rmSync(paths.processReceiptPath, { force: true });
  });

  try {
    writeStartingProcessReceipt(paths, child.pid, startedAt);
    installExitHook();
    const port = await waitForHealthyServer({ child, paths, apiKey });
    const after = readBonsaiMemorySnapshot();
    assertBonsaiMemoryAfterStart(before, after);
    const server: ActiveServer = {
      process: child,
      paths,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: COMMAND_EVE_BONSAI_MODEL_ID,
      apiKey,
      pid: child.pid,
      startedAt,
      memoryBefore: before,
      memoryAfter: after,
    };
    activeServer = server;
    startingServer = undefined;
    writeProcessReceipt(paths, server);
    return server;
  } catch (error) {
    if (startingServer?.process.pid === child.pid) startingServer = undefined;
    killProcessGroup(child.pid, 'SIGTERM');
    fs.rmSync(paths.apiKeyPath, { force: true });
    fs.rmSync(paths.processReceiptPath, { force: true });
    throw error;
  }
}

export async function ensureBonsaiPilotServer(options: BonsaiServerOptions): Promise<BonsaiPilotServer> {
  if (activeServer) return activeServer;
  if (startInFlight) return startInFlight;
  startInFlight = startBonsaiPilotServerOnce(options);
  try {
    return await startInFlight;
  } finally {
    startInFlight = undefined;
  }
}

export async function stopBonsaiPilotServer(): Promise<void> {
  const server = activeServer;
  const starting = startingServer;
  if (!server && !starting) return;
  activeServer = undefined;
  startingServer = undefined;
  const pid = server?.pid ?? starting!.process.pid;
  const paths = server?.paths ?? starting!.paths;
  killProcessGroup(pid, 'SIGTERM');
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  while (Date.now() < deadline && processCommand(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processCommand(pid)) killProcessGroup(pid, 'SIGKILL');
  fs.rmSync(paths.apiKeyPath, { force: true });
  fs.rmSync(paths.processReceiptPath, { force: true });
}

export function readBonsaiPilotProcessReceipt(userDataPath: string): unknown {
  const paths = resolveBonsaiPilotPaths(userDataPath);
  try {
    return JSON.parse(fs.readFileSync(paths.processReceiptPath, 'utf8'));
  } catch {
    return undefined;
  }
}
