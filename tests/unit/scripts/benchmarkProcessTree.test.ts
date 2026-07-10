import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectProcessTreePids,
  isProcessAlive,
  parsePosixProcessTable,
  rememberProcessTree,
  signalKnownProcessTree,
  terminateProcessTree,
} from '../../../scripts/benchmark-process-tree';

describe('benchmark process tree cleanup', () => {
  let spawnedRootPid = 0;

  afterEach(async () => {
    if (spawnedRootPid > 1 && isProcessAlive(spawnedRootPid)) {
      await terminateProcessTree(spawnedRootPid, { graceMs: 250, forceWaitMs: 1_000, pollMs: 25 });
    }
    spawnedRootPid = 0;
  });

  it('collects only the requested root and its descendants', () => {
    const rows = parsePosixProcessTable(' 10 1 100 root\n 11 10 50 child\n 12 11 25 grandchild\n 20 1 200 unrelated\n');

    expect(collectProcessTreePids(10, rows)).toEqual([10, 11, 12]);
  });

  it('signals descendants before the root', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const signaled = signalKnownProcessTree(10, new Set([10, 11, 12]), 'SIGTERM', (pid, signal) => {
      calls.push({ pid, signal });
    });

    expect(signaled).toEqual([12, 11, 10]);
    expect(calls).toEqual([
      { pid: 12, signal: 'SIGTERM' },
      { pid: 11, signal: 'SIGTERM' },
      { pid: 10, signal: 'SIGTERM' },
    ]);
  });

  it.runIf(process.platform !== 'win32')('terminates a real parent and helper process', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
      ],
      { stdio: 'ignore' }
    );
    spawnedRootPid = child.pid ?? 0;
    const knownProcessIds = new Set<number>();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && knownProcessIds.size < 2) {
      rememberProcessTree(spawnedRootPid, knownProcessIds);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(knownProcessIds.size).toBeGreaterThanOrEqual(2);
    const result = await terminateProcessTree(spawnedRootPid, {
      knownProcessIds,
      graceMs: 1_000,
      forceWaitMs: 1_000,
      pollMs: 25,
    });

    expect(result.captured.length).toBeGreaterThanOrEqual(2);
    expect(result.survivors).toEqual([]);
    expect([...knownProcessIds].some(isProcessAlive)).toBe(false);
    spawnedRootPid = 0;
  });
});
