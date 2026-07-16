import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectProcessTreePids,
  isProcessAlive,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  readProcessTable,
  rememberProcessTree,
  signalKnownProcessTree,
  terminateProcessTree,
  windowsTaskkillArgs,
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

  it('parses Windows CIM JSON without lossy RSS conversion', () => {
    const rows = parseWindowsProcessTable(
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: 104857600 },
        { ProcessId: 11, ParentProcessId: 10, WorkingSetSize: '52428800' },
        { ProcessId: 0, ParentProcessId: 0, WorkingSetSize: 0 },
        { ProcessId: 12, ParentProcessId: 10, WorkingSetSize: 'invalid' },
      ])
    );

    expect(rows).toEqual([
      { pid: 10, ppid: 1, rssBytes: 104857600 },
      { pid: 11, ppid: 10, rssBytes: 52428800 },
    ]);
  });

  it('accepts a single Windows CIM row and rejects malformed output', () => {
    expect(
      parseWindowsProcessTable(`\uFEFF${JSON.stringify({ ProcessId: 21, ParentProcessId: 10, WorkingSetSize: 4096 })}`)
    ).toEqual([{ pid: 21, ppid: 10, rssBytes: 4096 }]);
    expect(parseWindowsProcessTable('{invalid')).toEqual([]);
    expect(parseWindowsProcessTable('')).toEqual([]);
  });

  it('reads the Windows process table through PowerShell CIM', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const rows = readProcessTable({
      platform: 'win32',
      execute: (file, args) => {
        calls.push({ file, args });
        return JSON.stringify({ ProcessId: 42, ParentProcessId: 4, WorkingSetSize: 8192 });
      },
    });

    expect(rows).toEqual([{ pid: 42, ppid: 4, rssBytes: 8192 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('powershell.exe');
    expect(calls[0]?.args).toContain(
      'Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'
    );
  });

  it('builds recursive Windows taskkill commands with an explicit force stage', () => {
    expect(windowsTaskkillArgs(42, false)).toEqual(['/PID', '42', '/T']);
    expect(windowsTaskkillArgs(42, true)).toEqual(['/PID', '42', '/T', '/F']);
    expect(windowsTaskkillArgs(1, true)).toEqual([]);
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

  it('terminates a real parent and helper process', async () => {
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
