import { execFileSync } from 'node:child_process';

export type ProcessTableRow = {
  pid: number;
  ppid: number;
  rssBytes: number;
};

export type ProcessTreeTermination = {
  captured: number[];
  forced: number[];
  survivors: number[];
};

export function parsePosixProcessTable(output: string): ProcessTableRow[] {
  return output
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+.*)?$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
    }));
}

export function readProcessTable(): ProcessTableRow[] {
  if (process.platform === 'win32') return [];
  try {
    return parsePosixProcessTable(execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }));
  } catch {
    return [];
  }
}

export function collectProcessTreePids(rootPid: number, rows: ProcessTableRow[]): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return [];
  const byParent = new Map<number, number[]>();
  const byPid = new Set(rows.map((row) => row.pid));
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row.pid);
    byParent.set(row.ppid, children);
  }

  const processIds: number[] = [];
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (!pid || visited.has(pid)) continue;
    visited.add(pid);
    if (byPid.has(pid)) processIds.push(pid);
    pending.push(...(byParent.get(pid) ?? []));
  }
  return processIds;
}

export function rememberProcessTree(rootPid: number, knownProcessIds: Set<number>): number[] {
  if (Number.isInteger(rootPid) && rootPid > 1) knownProcessIds.add(rootPid);
  const processIds = collectProcessTreePids(rootPid, readProcessTable());
  for (const pid of processIds) knownProcessIds.add(pid);
  return processIds;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalKnownProcessTree(
  rootPid: number,
  knownProcessIds: ReadonlySet<number>,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill
): number[] {
  const descendants = [...knownProcessIds].filter(
    (pid) => Number.isInteger(pid) && pid > 1 && pid !== rootPid && pid !== process.pid
  );
  const ordered = [...descendants.reverse(), rootPid].filter(
    (pid, index, all) => Number.isInteger(pid) && pid > 1 && pid !== process.pid && all.indexOf(pid) === index
  );
  const signaled: number[] = [];
  for (const pid of ordered) {
    try {
      kill(pid, signal);
      signaled.push(pid);
    } catch {
      // Processes may exit between discovery and signaling.
    }
  }
  return signaled;
}

async function waitForTreeExit(
  knownProcessIds: Set<number>,
  rootPid: number,
  timeoutMs: number,
  pollMs: number
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isProcessAlive(rootPid)) rememberProcessTree(rootPid, knownProcessIds);
    const survivors = [...knownProcessIds].filter(isProcessAlive);
    if (survivors.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return [...knownProcessIds].filter(isProcessAlive);
}

export async function terminateProcessTree(
  rootPid: number,
  options: {
    knownProcessIds?: Set<number>;
    graceMs?: number;
    forceWaitMs?: number;
    pollMs?: number;
  } = {}
): Promise<ProcessTreeTermination> {
  const knownProcessIds = options.knownProcessIds ?? new Set<number>();
  const graceMs = options.graceMs ?? 5_000;
  const forceWaitMs = options.forceWaitMs ?? 2_000;
  const pollMs = options.pollMs ?? 100;

  rememberProcessTree(rootPid, knownProcessIds);
  const captured = [...knownProcessIds];
  signalKnownProcessTree(rootPid, knownProcessIds, 'SIGTERM');
  let survivors = await waitForTreeExit(knownProcessIds, rootPid, graceMs, pollMs);
  let forced: number[] = [];
  if (survivors.length > 0) {
    if (isProcessAlive(rootPid)) rememberProcessTree(rootPid, knownProcessIds);
    forced = signalKnownProcessTree(rootPid, new Set(survivors), 'SIGKILL');
    survivors = await waitForTreeExit(knownProcessIds, rootPid, forceWaitMs, pollMs);
  }

  return { captured, forced, survivors };
}
