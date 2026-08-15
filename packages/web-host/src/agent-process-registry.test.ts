import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupRegisteredAgentProcesses,
  resolveAgentProcessRegistryPath,
  type RegisteredAgentProcessIdentityProbe,
  type RegisteredAgentProcessV2,
} from './agent-process-registry.js';

function registeredProcess(overrides: Partial<RegisteredAgentProcessV2> = {}): RegisteredAgentProcessV2 {
  return {
    pid: 6883,
    process_group_id: 6883,
    conversation_id: 'conv-1',
    agent_type: 'acp',
    backend: 'codex',
    registered_at_ms: 1,
    process_identity: {
      platform: 'darwin',
      start_time: { kind: 'unix_epoch_us', value: '1770000000123456' },
      parent_pid: 522,
      executable_path: '/signed/hermes',
    },
    ...overrides,
  };
}

async function writeRegistry(dataDir: string, version: unknown, processes: unknown[]): Promise<string> {
  const registryPath = resolveAgentProcessRegistryPath(dataDir);
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({ version, processes }, null, 2)}\n`, 'utf8');
  return registryPath;
}

describe('cleanupRegisteredAgentProcesses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('signals only a fully verified v2 birth and revalidates before every signal', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-v2-'));
    const registryPath = await writeRegistry(dataDir, 2, [registeredProcess()]);
    const identityProbe = vi
      .fn<RegisteredAgentProcessIdentityProbe>()
      .mockResolvedValueOnce('match')
      .mockResolvedValueOnce('match')
      .mockResolvedValueOnce('match')
      .mockResolvedValueOnce('absent');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    killSpy.mockImplementation((target, signal) => {
      if (target === -6883 && signal === 0) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
      return true;
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });

    expect(identityProbe).toHaveBeenCalledTimes(4);
    expect(killSpy.mock.calls).toEqual([
      [-6883, 'SIGTERM'],
      [-6883, 'SIGKILL'],
      [-6883, 0],
    ]);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({ version: 2, processes: [] });
    expect((await readdir(path.dirname(registryPath))).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('retains a recycled PID or PGID identity and sends no numeric signal', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-reused-'));
    const entry = registeredProcess();
    const registryPath = await writeRegistry(dataDir, 2, [entry]);
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('mismatch');
    const killSpy = vi.spyOn(process, 'kill');

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [6883],
      registry_unproven: true,
    });

    expect(killSpy).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(registryPath, 'utf8')).processes).toEqual([entry]);
  });

  it('retains a registry entry when the wrapper exited but a detached descendant still owns the PGID', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-descendant-'));
    const entry = registeredProcess();
    const registryPath = await writeRegistry(dataDir, 2, [entry]);
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('absent');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      expect([target, signal]).toEqual([-6883, 0]);
      return true;
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [6883],
      registry_unproven: true,
    });

    expect(killSpy).toHaveBeenCalledTimes(3);
    expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).processes).toEqual([entry]);
  });

  it('observes after TERM and never escalates when the leader exits but its process group survives', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-post-term-descendant-'));
    const entry = registeredProcess();
    const registryPath = await writeRegistry(dataDir, 2, [entry]);
    const identityProbe = vi
      .fn<RegisteredAgentProcessIdentityProbe>()
      .mockResolvedValueOnce('match')
      .mockResolvedValue('absent');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [6883],
      registry_unproven: true,
    });

    expect(killSpy.mock.calls[0]).toEqual([-6883, 'SIGTERM']);
    expect(killSpy.mock.calls.slice(1).every((call) => call[0] === -6883 && call[1] === 0)).toBe(true);
    expect(killSpy.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).processes).toEqual([entry]);
  });

  it('removes an absent leader only after observation proves its PGID is absent', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-tree-gone-'));
    const registryPath = await writeRegistry(dataDir, 2, [registeredProcess()]);
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('absent');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      expect([target, signal]).toEqual([-6883, 0]);
      throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).processes).toEqual([]);
  });

  it('revalidates the exact v2 identity before a PGID-ESRCH PID fallback', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-fallback-'));
    await writeRegistry(dataDir, 2, [registeredProcess()]);
    const identityProbe = vi
      .fn<RegisteredAgentProcessIdentityProbe>()
      .mockResolvedValueOnce('match')
      .mockResolvedValueOnce('match')
      .mockResolvedValueOnce('absent');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -6883 && signal === 'SIGTERM') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (target === -6883 && signal === 0) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
      return true;
    });

    await cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 });

    expect(identityProbe).toHaveBeenCalledTimes(3);
    expect(killSpy.mock.calls).toEqual([
      [-6883, 'SIGTERM'],
      [6883, 'SIGTERM'],
      [-6883, 0],
    ]);
  });

  it.each([
    ['legacy v1', 1, registeredProcess({ process_identity: undefined as never })],
    ['nullable v2 identity', 2, { ...registeredProcess(), process_identity: null }],
    ['v2 entry with an extra key', 2, { ...registeredProcess(), injected: true }],
  ])('retains %s as unproven and sends no signal', async (_label, version, entry) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-unproven-'));
    const registryPath = await writeRegistry(dataDir, version, [entry]);
    const killSpy = vi.spyOn(process, 'kill');
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('match');

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [6883],
      registry_unproven: true,
    });

    expect(identityProbe).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(registryPath, 'utf8')).processes).toEqual([entry]);
  });

  it('keeps malformed registry bytes intact and reports cleanup as unproven', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-malformed-'));
    const registryPath = resolveAgentProcessRegistryPath(dataDir);
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, 'null', 'utf8');
    const killSpy = vi.spyOn(process, 'kill');

    await expect(cleanupRegisteredAgentProcesses(dataDir)).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: true,
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(await readFile(registryPath, 'utf8')).toBe('null');
  });

  it('does not rewrite a nonnumeric registry version or erase its evidence', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-version-'));
    const registryPath = await writeRegistry(dataDir, 'evil', [registeredProcess()]);

    await expect(cleanupRegisteredAgentProcesses(dataDir)).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: true,
    });
    expect(JSON.parse(await readFile(registryPath, 'utf8')).version).toBe('evil');
  });
});
