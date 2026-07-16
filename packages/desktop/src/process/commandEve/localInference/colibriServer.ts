import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { sha256File } from './bonsaiArtifactCore';
import { ensureColibriArtifacts, type ColibriProvisionProgressReceipt } from './colibriProvisioner';
import {
  COMMAND_EVE_COLIBRI_MODEL_ID,
  COMMAND_EVE_COLIBRI_VERSION,
  resolveColibriPaths,
  type ColibriPaths,
} from './colibriManifest';

const ONE_GIB = 1024 ** 3;
const MIN_TOTAL_MEMORY_BYTES = 48 * ONE_GIB;
const MIN_FREE_MEMORY_PERCENT = 15;
const DEFAULT_CONTEXT_SIZE = 65_536;
const MAX_CONTEXT_SIZE = 65_536;
const START_TIMEOUT_MS = 15 * 60_000;
const STOP_TIMEOUT_MS = 15_000;
const STALE_REAP_TIMEOUT_MS = 5_000;
const MAX_LOG_BYTES = 256 * 1024;

export type ColibriMemorySnapshot = Readonly<{
  totalBytes: number;
  freePercent: number;
}>;

export type ColibriServer = Readonly<{
  baseUrl: string;
  model: typeof COMMAND_EVE_COLIBRI_MODEL_ID;
  apiKey: string;
  pid: number;
  startedAt: string;
  memoryBefore: ColibriMemorySnapshot;
}>;

export type ColibriServerOptions = Readonly<{
  userDataPath: string;
  autoProvision?: boolean;
  allowHomebrewInstall?: boolean;
  contextSize?: number;
  onProgress?: (progress: ColibriProvisionProgressReceipt) => void;
}>;

type ActiveServer = ColibriServer & { process: ChildProcessWithoutNullStreams; paths: ColibriPaths };

let activeServer: ActiveServer | undefined;
let startingServer: { process: ChildProcessWithoutNullStreams; paths: ColibriPaths } | undefined;
let startInFlight: Promise<ColibriServer> | undefined;
let exitHookInstalled = false;

export class ColibriStartFence {
  private generation = 0;

  capture(): number {
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
  }

  assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('Colibrì startup was cancelled.');
  }
}

const startFence = new ColibriStartFence();

export class ColibriAuthBoundaryError extends Error {}

export function normalizeColibriContextSize(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONTEXT_SIZE;
  return Math.max(4_096, Math.min(MAX_CONTEXT_SIZE, Math.floor(value!)));
}

export function buildColibriServerArgs(args: { paths: ColibriPaths; port: number; contextSize: number }): string[] {
  return [
    args.paths.cliPath,
    'serve',
    '--model',
    args.paths.modelDir,
    '--host',
    '127.0.0.1',
    '--port',
    String(args.port),
    '--model-id',
    COMMAND_EVE_COLIBRI_MODEL_ID,
    '--auto-tier',
    '--ctx',
    String(args.contextSize),
    '--ngen',
    '8192',
  ];
}

export function readColibriMemorySnapshot(): ColibriMemorySnapshot {
  const totalBytes = os.totalmem();
  const fallbackFreePercent = Math.floor((os.freemem() / Math.max(1, totalBytes)) * 100);
  let freePercent = fallbackFreePercent;
  if (process.platform === 'darwin') {
    const pressure = childProcess.spawnSync('/usr/bin/memory_pressure', ['-Q'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    freePercent = parseMacMemoryPressureFreePercent(String(pressure.stdout || '')) ?? fallbackFreePercent;
  }
  return {
    totalBytes,
    freePercent,
  };
}

export function parseMacMemoryPressureFreePercent(output: string): number | undefined {
  const match = output.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

export function assertColibriMemoryAdmission(snapshot: ColibriMemorySnapshot): void {
  if (snapshot.totalBytes < MIN_TOTAL_MEMORY_BYTES) {
    throw new Error('Colibrì needs at least 48 GB unified memory and is recommended with 128 GB.');
  }
  if (snapshot.freePercent < MIN_FREE_MEMORY_PERCENT) {
    throw new Error('Not enough unified memory is currently free for Colibrì. Close heavy apps and try again.');
  }
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function writePrivateFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function processCommand(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 1) return '';
  const result = childProcess.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already stopped.
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processCommand(pid)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !processCommand(pid);
}

export async function terminateColibriProcess(
  pid: number,
  gracefulTimeoutMs = STOP_TIMEOUT_MS,
  killTimeoutMs = 1_000
): Promise<void> {
  killProcessGroup(pid, 'SIGTERM');
  if (await waitForProcessExit(pid, gracefulTimeoutMs)) return;
  killProcessGroup(pid, 'SIGKILL');
  if (!(await waitForProcessExit(pid, killTimeoutMs))) {
    throw new Error('A Colibrì process could not be stopped after SIGKILL.');
  }
}

export async function reapStaleColibriProcess(paths: ColibriPaths): Promise<void> {
  let stalePid: number | undefined;
  try {
    const receipt = JSON.parse(fs.readFileSync(paths.processReceiptPath, 'utf8')) as { pid?: number };
    const pid = Number(receipt.pid);
    const command = processCommand(pid);
    if (command.includes(paths.cliPath) && command.includes(paths.modelDir)) stalePid = pid;
  } catch {
    // No valid prior process receipt.
  }
  if (stalePid) {
    try {
      await terminateColibriProcess(stalePid, STALE_REAP_TIMEOUT_MS);
    } catch {
      throw new Error('A stale Colibrì process could not be stopped before the memory check.');
    }
  }
  fs.rmSync(paths.processReceiptPath, { force: true });
  fs.rmSync(paths.apiKeyPath, { force: true });
}

export function cleanupColibriProcessFilesIfOwned(paths: ColibriPaths, pid: number): boolean {
  let receiptPid: number | undefined;
  try {
    const receipt = JSON.parse(fs.readFileSync(paths.processReceiptPath, 'utf8')) as { pid?: number };
    const candidate = Number(receipt.pid);
    if (Number.isSafeInteger(candidate) && candidate > 1) receiptPid = candidate;
  } catch {
    return false;
  }
  if (receiptPid !== pid) return false;
  fs.rmSync(paths.apiKeyPath, { force: true });
  fs.rmSync(paths.processReceiptPath, { force: true });
  return true;
}

export async function assertColibriEngineIntegrity(paths: ColibriPaths, expectedSha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('Colibrì installation receipt has no valid engine SHA256.');
  }
  const actualSha256 = await sha256File(paths.enginePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error('Colibrì runtime engine no longer matches its verified installation receipt.');
  }
}

async function unloadOllamaModels(): Promise<void> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return;
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    await Promise.all(
      (payload.models || []).map((model) =>
        model.name
          ? fetch('http://127.0.0.1:11434/api/generate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: model.name, keep_alive: 0 }),
              signal: AbortSignal.timeout(5_000),
            }).catch((): undefined => undefined)
          : undefined
      )
    );
  } catch {
    // Ollama not running is already the desired state.
  }
}

function appendLog(paths: ColibriPaths, line: string, apiKey: string): void {
  if (!line || /prompt|completion|request body/i.test(line)) return;
  let size = 0;
  try {
    size = fs.statSync(paths.logPath).size;
  } catch {
    size = 0;
  }
  if (size >= MAX_LOG_BYTES) return;
  const sanitized = line.replaceAll(apiKey, '[REDACTED]').replaceAll(paths.modelDir, '[LOCAL_MODEL]');
  fs.appendFileSync(paths.logPath, `${sanitized}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function probeColibriServerAuthBoundary(args: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorized = await fetchImpl(`${args.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${args.apiKey}` },
    signal: AbortSignal.timeout(2_000),
  });
  if (!authorized.ok) return false;
  const anonymous = await fetchImpl(`${args.baseUrl}/v1/models`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (anonymous.status !== 401 && anonymous.status !== 403) {
    throw new ColibriAuthBoundaryError('Colibrì loopback server accepted a request without its private API key.');
  }
  return true;
}

async function waitForServer(args: {
  child: ChildProcessWithoutNullStreams;
  paths: ColibriPaths;
  port: number;
  apiKey: string;
}): Promise<void> {
  let exited = false;
  args.child.once('exit', () => {
    exited = true;
  });
  const onChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) appendLog(args.paths, line, args.apiKey);
  };
  args.child.stdout.on('data', onChunk);
  args.child.stderr.on('data', onChunk);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Colibrì stopped during startup.');
    try {
      // Polls must remain sequential so startup never creates overlapping requests.
      // eslint-disable-next-line no-await-in-loop
      const ready = await probeColibriServerAuthBoundary({
        baseUrl: `http://127.0.0.1:${args.port}`,
        apiKey: args.apiKey,
      });
      if (ready) return;
    } catch (error) {
      if (error instanceof ColibriAuthBoundaryError) throw error;
      // Model is still loading.
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('Colibrì did not become ready in time.');
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    if (startingServer) killProcessGroup(startingServer.process.pid, 'SIGTERM');
    if (activeServer) killProcessGroup(activeServer.pid, 'SIGTERM');
  });
}

async function startOnce(options: ColibriServerOptions, generation: number): Promise<ColibriServer> {
  if (activeServer) return activeServer;
  const paths = resolveColibriPaths(options.userDataPath);
  await reapStaleColibriProcess(paths);
  startFence.assertCurrent(generation);
  await unloadOllamaModels();
  startFence.assertCurrent(generation);
  const memoryBefore = readColibriMemorySnapshot();
  assertColibriMemoryAdmission(memoryBefore);
  const { receipt } = await ensureColibriArtifacts({
    userDataPath: options.userDataPath,
    autoDownload: options.autoProvision,
    allowHomebrewInstall: options.allowHomebrewInstall,
    onProgress: options.onProgress,
  });
  await assertColibriEngineIntegrity(paths, receipt.runtime.engine_sha256);
  startFence.assertCurrent(generation);
  fs.rmSync(paths.logPath, { force: true });
  const apiKey = crypto.randomBytes(32).toString('hex');
  writePrivateFile(paths.apiKeyPath, `${apiKey}\n`);
  const port = await reservePort();
  try {
    startFence.assertCurrent(generation);
  } catch (error) {
    fs.rmSync(paths.apiKeyPath, { force: true });
    throw error;
  }
  const contextSize = normalizeColibriContextSize(options.contextSize);
  const child = childProcess.spawn('/usr/bin/python3', buildColibriServerArgs({ paths, port, contextSize }), {
    cwd: path.join(paths.runtimeDir, 'c'),
    detached: true,
    env: {
      ...process.env,
      COLI_API_KEY: apiKey,
      COLI_MODEL: paths.modelDir,
      COLI_MODEL_ID: COMMAND_EVE_COLIBRI_MODEL_ID,
      COLI_POLICY: 'quality',
      COLI_TOOL_SALVAGE: '0',
      COLI_THINK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) {
    fs.rmSync(paths.apiKeyPath, { force: true });
    throw new Error('Colibrì could not start.');
  }
  const childPid = child.pid;
  const startedAt = new Date().toISOString();
  startingServer = { process: child, paths };
  writePrivateFile(
    paths.processReceiptPath,
    `${JSON.stringify(
      {
        version: 'command-eve-colibri-server-process/v0',
        runtime_version: COMMAND_EVE_COLIBRI_VERSION,
        status: 'starting',
        pid: childPid,
        started_at: startedAt,
        model: COMMAND_EVE_COLIBRI_MODEL_ID,
      },
      null,
      2
    )}\n`
  );
  child.once('exit', () => {
    if (activeServer?.pid === childPid) activeServer = undefined;
    if (startingServer?.process.pid === childPid) startingServer = undefined;
    cleanupColibriProcessFilesIfOwned(paths, childPid);
  });
  try {
    installExitHook();
    await waitForServer({ child, paths, port, apiKey });
    startFence.assertCurrent(generation);
    fs.rmSync(paths.apiKeyPath, { force: true });
    const server: ActiveServer = {
      process: child,
      paths,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: COMMAND_EVE_COLIBRI_MODEL_ID,
      apiKey,
      pid: childPid,
      startedAt,
      memoryBefore,
    };
    activeServer = server;
    startingServer = undefined;
    writePrivateFile(
      paths.processReceiptPath,
      `${JSON.stringify(
        {
          version: 'command-eve-colibri-server-process/v0',
          runtime_version: COMMAND_EVE_COLIBRI_VERSION,
          status: 'ready',
          pid: childPid,
          started_at: startedAt,
          base_url: server.baseUrl,
          model: server.model,
        },
        null,
        2
      )}\n`
    );
    return server;
  } catch (error) {
    try {
      await terminateColibriProcess(childPid, STALE_REAP_TIMEOUT_MS);
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const startupMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Colibrì startup failed (${startupMessage}) and its process could not be stopped: ${cleanupMessage}`,
        { cause: cleanupError }
      );
    }
    if (startingServer?.process.pid === childPid) startingServer = undefined;
    cleanupColibriProcessFilesIfOwned(paths, childPid);
    throw error;
  }
}

export async function ensureColibriServer(options: ColibriServerOptions): Promise<ColibriServer> {
  if (activeServer) return activeServer;
  if (!startInFlight) {
    const task = startOnce(options, startFence.capture());
    startInFlight = task;
    task.then(
      () => {
        if (startInFlight === task) startInFlight = undefined;
      },
      () => {
        if (startInFlight === task) startInFlight = undefined;
      }
    );
  }
  return startInFlight;
}

export async function stopColibriServer(): Promise<void> {
  startFence.cancel();
  startInFlight = undefined;
  const starting = startingServer;
  const active = activeServer;
  const pid = active?.pid ?? starting?.process.pid;
  const paths = active?.paths ?? starting?.paths;
  if (!pid || !paths) {
    startingServer = undefined;
    activeServer = undefined;
    return;
  }
  await terminateColibriProcess(pid);
  if (startingServer?.process.pid === pid) startingServer = undefined;
  if (activeServer?.pid === pid) activeServer = undefined;
  cleanupColibriProcessFilesIfOwned(paths, pid);
}
