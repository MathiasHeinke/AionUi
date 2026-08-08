import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

type RegisteredAgentProcess = {
  pid: number;
  process_group_id?: number;
  conversation_id: string;
  agent_type: string;
  backend?: string;
  command_preview?: string;
  registered_at_ms: number;
};

type AgentProcessRegistry = {
  version: number;
  processes: RegisteredAgentProcess[];
};

export const AGENT_PROCESS_REGISTRY_RELATIVE_PATH = path.join('runtime', 'agent-process-registry.json');

const TERM_GRACE_MS = 1_000;

export function resolveAgentProcessRegistryPath(dataDir: string): string {
  return path.join(dataDir, AGENT_PROCESS_REGISTRY_RELATIVE_PATH);
}

export async function cleanupRegisteredAgentProcesses(dataDir?: string): Promise<void> {
  if (!dataDir) return;

  const registryPath = resolveAgentProcessRegistryPath(dataDir);
  const registry = await readRegistry(registryPath);
  if (registry.processes.length === 0) return;

  for (const entry of registry.processes) {
    await terminateRegisteredProcess(entry, 'SIGTERM');
  }

  await delay(TERM_GRACE_MS);

  for (const entry of registry.processes) {
    if (isRegisteredProcessTreeAlive(entry)) {
      await terminateRegisteredProcess(entry, 'SIGKILL');
    }
  }

  const survivors = registry.processes.filter((entry) => isRegisteredProcessTreeAlive(entry));
  await writeRegistry(registryPath, {
    version: registry.version,
    processes: survivors,
  });
}

async function readRegistry(registryPath: string): Promise<AgentProcessRegistry> {
  try {
    const raw = await readFile(registryPath, 'utf8');
    // CHECK THE ROOT, do not cast it. This used to read
    // `JSON.parse(raw) as Partial<AgentProcessRegistry>`, and a cast is not a
    // check — it only tells the compiler to stop asking. `JSON.parse` may hand
    // back null, a number, a string or an array, and the entries were already
    // validated one by one (`isRegisteredProcess`) while the object holding them
    // was not.
    //
    // Two things went wrong, both reproducible from a file on disk:
    //   - a file containing `null` made `parsed.version` throw a TypeError.
    //     `isNotFound` does not recognise it, so `readRegistry` rethrew — and both
    //     callers await this without a try/catch (backend-launcher.ts:875, :892),
    //     so `stop()` aborted before the capability-file cleanup, before clearing
    //     `childProcess`, and before signalling a single orphaned ACP child. The
    //     one function whose job is killing orphans was stopped by one bad byte.
    //   - `version` is typed `number`, but `?? 1` only replaces null/undefined,
    //     so `"evil"` passed through and `writeRegistry` persisted it again.
    //
    // A malformed registry is treated as an empty one, which is the same answer
    // this function already gives for a missing file: nothing to clean up.
    const parsed: unknown = JSON.parse(raw);
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    const version = record?.version;
    const processes = record?.processes;
    return {
      version: typeof version === 'number' ? version : 1,
      processes: Array.isArray(processes) ? processes.filter(isRegisteredProcess) : [],
    };
  } catch (error) {
    if (isNotFound(error)) {
      return {
        version: 1,
        processes: [],
      };
    }
    throw error;
  }
}

async function writeRegistry(registryPath: string, registry: AgentProcessRegistry): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true });
  const tmpPath = `${registryPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rm(registryPath, { force: true });
  await rename(tmpPath, registryPath);
}

async function terminateRegisteredProcess(entry: RegisteredAgentProcess, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  if (process.platform === 'win32') {
    if (!isProcessAlive(entry.pid)) return;
    await runTaskkill(entry.pid, signal === 'SIGKILL');
    return;
  }

  const target = entry.process_group_id ?? entry.pid;
  try {
    process.kill(-target, signal);
  } catch {
    try {
      process.kill(entry.pid, signal);
    } catch {
      // already exited
    }
  }
}

function isRegisteredProcessTreeAlive(entry: RegisteredAgentProcess): boolean {
  if (process.platform !== 'win32' && typeof entry.process_group_id === 'number' && entry.process_group_id > 1) {
    try {
      process.kill(-entry.process_group_id, 0);
      return true;
    } catch {
      // fall through to wrapper PID check
    }
  }

  return isProcessAlive(entry.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRegisteredProcess(value: unknown): value is RegisteredAgentProcess {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RegisteredAgentProcess).pid === 'number' &&
    typeof (value as RegisteredAgentProcess).conversation_id === 'string' &&
    typeof (value as RegisteredAgentProcess).agent_type === 'string' &&
    typeof (value as RegisteredAgentProcess).registered_at_ms === 'number'
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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
