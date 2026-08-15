import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export type RegisteredProcessStartTime = Readonly<{
  kind: 'unix_epoch_us' | 'linux_boot_ticks' | 'windows_filetime_100ns';
  value: string;
}>;

export type RegisteredAgentProcessIdentity = Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  start_time: RegisteredProcessStartTime;
  parent_pid: number;
  executable_path: string;
}>;

export type RegisteredAgentProcessV2 = Readonly<{
  pid: number;
  process_group_id?: number;
  conversation_id: string;
  agent_type: string;
  backend?: string;
  command_preview?: string;
  registered_at_ms: number;
  process_identity: RegisteredAgentProcessIdentity;
}>;

export type RegisteredAgentProcessIdentityProbeResult = 'match' | 'absent' | 'mismatch' | 'unknown';
export type RegisteredAgentProcessIdentityProbe = (
  entry: RegisteredAgentProcessV2
) => Promise<RegisteredAgentProcessIdentityProbeResult>;

type ReadRegistryResult = Readonly<{
  version: number;
  processes: unknown[];
  structurallyValid: boolean;
}>;

export type AgentProcessCleanupResult = Readonly<{
  survivor_pids: number[];
  registry_unproven: boolean;
}>;

export type AgentProcessCleanupOptions = Readonly<{
  identityProbe?: RegisteredAgentProcessIdentityProbe;
  termGraceMs?: number;
}>;

export const AGENT_PROCESS_REGISTRY_RELATIVE_PATH = path.join('runtime', 'agent-process-registry.json');

const TERM_GRACE_MS = 1_000;
const REGISTRY_VERSION = 2;
const ENTRY_REQUIRED_KEYS = ['agent_type', 'conversation_id', 'pid', 'process_identity', 'registered_at_ms'] as const;
const ENTRY_OPTIONAL_KEYS = ['backend', 'command_preview', 'process_group_id'] as const;

export function resolveAgentProcessRegistryPath(dataDir: string): string {
  return path.join(dataDir, AGENT_PROCESS_REGISTRY_RELATIVE_PATH);
}

export async function cleanupRegisteredAgentProcesses(
  dataDir?: string,
  options: AgentProcessCleanupOptions = {}
): Promise<AgentProcessCleanupResult> {
  if (!dataDir) return { survivor_pids: [], registry_unproven: false };

  const registryPath = resolveAgentProcessRegistryPath(dataDir);
  const registry = await readRegistry(registryPath);
  if (!registry.structurallyValid) return { survivor_pids: [], registry_unproven: true };
  if (registry.processes.length === 0) return { survivor_pids: [], registry_unproven: false };

  // Legacy, future-version and malformed entries are durable evidence, not
  // disposable hints. Retain them verbatim and refuse to signal a numeric PID
  // whose launch identity cannot be re-proven.
  if (registry.version !== REGISTRY_VERSION) {
    return {
      survivor_pids: numericPids(registry.processes),
      registry_unproven: true,
    };
  }

  const identityProbe = options.identityProbe;
  const retainedUnknown = registry.processes.filter((entry) => !isRegisteredProcessV2(entry));
  let candidates = registry.processes.filter(isRegisteredProcessV2);
  let changed = false;

  const afterTerm: RegisteredAgentProcessV2[] = [];
  for (const entry of candidates) {
    const outcome = await signalVerifiedProcess(entry, 'SIGTERM', identityProbe);
    if (outcome === 'absent') changed = true;
    else afterTerm.push(entry);
  }
  candidates = afterTerm;

  if (candidates.length > 0) await delay(options.termGraceMs ?? TERM_GRACE_MS);

  const afterKill: RegisteredAgentProcessV2[] = [];
  for (const entry of candidates) {
    const observed = await probeRegisteredProcess(entry, identityProbe);
    if (observed === 'absent') {
      changed = true;
      continue;
    }
    if (observed !== 'match') {
      afterKill.push(entry);
      continue;
    }
    const outcome = await signalVerifiedProcess(entry, 'SIGKILL', identityProbe);
    if (outcome === 'absent') changed = true;
    else afterKill.push(entry);
  }

  const survivors: RegisteredAgentProcessV2[] = [];
  for (const entry of afterKill) {
    const observed = await probeRegisteredProcess(entry, identityProbe);
    if (observed === 'absent') changed = true;
    else survivors.push(entry);
  }

  const retained = [...retainedUnknown, ...survivors];
  if (changed) {
    await writeRegistry(registryPath, {
      version: REGISTRY_VERSION,
      processes: retained,
    });
  }
  return {
    survivor_pids: numericPids(retained),
    registry_unproven: retained.length > 0,
  };
}

async function readRegistry(registryPath: string): Promise<ReadRegistryResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    if (!isPlainObject(parsed) || !hasExactKeys(parsed, ['processes', 'version'])) {
      return { version: 0, processes: [], structurallyValid: false };
    }
    if (!Number.isSafeInteger(parsed.version) || !Array.isArray(parsed.processes)) {
      return { version: 0, processes: [], structurallyValid: false };
    }
    return {
      version: parsed.version as number,
      processes: parsed.processes,
      structurallyValid: true,
    };
  } catch (error) {
    if (isNotFound(error)) return { version: REGISTRY_VERSION, processes: [], structurallyValid: true };
    return { version: 0, processes: [], structurallyValid: false };
  }
}

async function writeRegistry(
  registryPath: string,
  registry: Readonly<{ version: number; processes: unknown[] }>
): Promise<void> {
  const parent = path.dirname(registryPath);
  await mkdir(parent, { recursive: true });
  const tmpPath = path.join(parent, `.${path.basename(registryPath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // rename is the publication point. Never unlink the prior registry first:
    // a crash between unlink and rename would erase the only process evidence.
    await rename(tmpPath, registryPath);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch((): undefined => undefined);
    await rm(tmpPath, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync through Node. The rename remains
    // atomic there; POSIX/macOS must not silently ignore a real fsync failure.
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close().catch((): undefined => undefined);
  }
}

async function signalVerifiedProcess(
  entry: RegisteredAgentProcessV2,
  signal: 'SIGTERM' | 'SIGKILL',
  identityProbe: RegisteredAgentProcessIdentityProbe | undefined
): Promise<'signalled' | 'absent' | 'unproven'> {
  const observed = await probeRegisteredProcess(entry, identityProbe);
  if (observed === 'absent') return 'absent';
  if (observed !== 'match') return 'unproven';

  if (process.platform === 'win32') {
    await runTaskkill(entry.pid, signal === 'SIGKILL');
    return 'signalled';
  }

  const target = entry.process_group_id && entry.process_group_id > 1 ? -entry.process_group_id : entry.pid;
  try {
    process.kill(target, signal);
    return 'signalled';
  } catch (error) {
    if (!isProcessAbsent(error)) return 'unproven';
    if (target === entry.pid) return 'absent';

    // The group disappearing does not authorize a fallback numeric PID signal.
    // Revalidate the complete launch identity again at the actual fallback
    // signal boundary.
    const fallbackObserved = await probeRegisteredProcess(entry, identityProbe);
    if (fallbackObserved === 'absent') return 'absent';
    if (fallbackObserved !== 'match') return 'unproven';
    try {
      process.kill(entry.pid, signal);
      return 'signalled';
    } catch (fallbackError) {
      return isProcessAbsent(fallbackError) ? 'absent' : 'unproven';
    }
  }
}

async function probeRegisteredProcess(
  entry: RegisteredAgentProcessV2,
  identityProbe: RegisteredAgentProcessIdentityProbe | undefined
): Promise<RegisteredAgentProcessIdentityProbeResult> {
  if (!identityProbe) return 'unknown';
  try {
    return await identityProbe(entry);
  } catch {
    return 'unknown';
  }
}

function isRegisteredProcessV2(value: unknown): value is RegisteredAgentProcessV2 {
  if (!isPlainObject(value) || !hasExactKeys(value, ENTRY_REQUIRED_KEYS, ENTRY_OPTIONAL_KEYS)) return false;
  if (!isPositiveU32(value.pid) || !isNonNegativeSafeInteger(value.registered_at_ms)) return false;
  if (
    typeof value.conversation_id !== 'string' ||
    typeof value.agent_type !== 'string' ||
    (value.backend !== undefined && typeof value.backend !== 'string') ||
    (value.command_preview !== undefined && typeof value.command_preview !== 'string') ||
    (value.process_group_id !== undefined && !isPositiveU32(value.process_group_id))
  ) {
    return false;
  }
  return isRegisteredProcessIdentity(value.process_identity);
}

function isRegisteredProcessIdentity(value: unknown): value is RegisteredAgentProcessIdentity {
  if (!isPlainObject(value) || !hasExactKeys(value, ['executable_path', 'parent_pid', 'platform', 'start_time'])) {
    return false;
  }
  if (!['darwin', 'linux', 'win32'].includes(String(value.platform))) return false;
  if (
    !isPositiveU32(value.parent_pid) ||
    typeof value.executable_path !== 'string' ||
    value.executable_path.length === 0
  ) {
    return false;
  }
  const startTime = value.start_time;
  if (!isPlainObject(startTime) || !hasExactKeys(startTime, ['kind', 'value'])) return false;
  const expectedKind = {
    darwin: 'unix_epoch_us',
    linux: 'linux_boot_ticks',
    win32: 'windows_filetime_100ns',
  }[value.platform as 'darwin' | 'linux' | 'win32'];
  return startTime.kind === expectedKind && typeof startTime.value === 'string' && /^[0-9]+$/.test(startTime.value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value).toSorted();
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function isPositiveU32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function numericPids(entries: readonly unknown[]): number[] {
  return [
    ...new Set(entries.flatMap((entry) => (isPlainObject(entry) && isPositiveU32(entry.pid) ? [entry.pid] : []))),
  ];
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isProcessAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.unshift('/F');

    try {
      const child = spawn('taskkill', args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    } catch {
      resolve();
    }
  });
}
