import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_PROCESS_REGISTRY_EMERGENCY_RELATIVE_DIR,
  AGENT_PROCESS_REGISTRY_FALLBACK_RELATIVE_DIR,
  cleanupRegisteredAgentProcesses,
  resolveExternalAgentProcessEmergencyDirectory,
  resolveAgentProcessRegistryPath,
  type RegisteredAgentProcessIdentityProbe,
  type RegisteredAgentProcessIdentityProbeProvider,
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

    expect(identityProbe).toHaveBeenCalledTimes(5);
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
      .mockResolvedValueOnce('match')
      .mockResolvedValueOnce('absent');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === -6883 && signal === 'SIGTERM') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (target === -6883 && signal === 0) throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
      return true;
    });

    await cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 });

    expect(identityProbe).toHaveBeenCalledTimes(4);
    expect(killSpy.mock.calls).toEqual([
      [-6883, 'SIGTERM'],
      [6883, 'SIGTERM'],
      [-6883, 0],
    ]);
  });

  it.each([
    ['legacy v1', 1, registeredProcess({ process_identity: undefined as never })],
    ['nullable v2 identity', 2, { ...registeredProcess(), process_identity: null }],
  ])('migrates live %s to exact nullable v2 and sends observation-only probes', async (_label, version, entry) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-unproven-'));
    const registryPath = await writeRegistry(dataDir, version, [entry]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      return true;
    });
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('match');

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [6883],
      registry_unproven: true,
    });

    expect(identityProbe).not.toHaveBeenCalled();
    expect(killSpy.mock.calls).toEqual([[6883, 0]]);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({
      version: 2,
      processes: [{ ...entry, process_identity: null }],
    });
  });

  it('retires an absent pre-v2 record only after both PID and PGID observation prove ESRCH', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-legacy-absent-'));
    const registryPath = await writeRegistry(dataDir, 1, [registeredProcess({ process_identity: undefined as never })]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });
    expect(killSpy.mock.calls).toEqual([
      [6883, 0],
      [-6883, 0],
    ]);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({ version: 2, processes: [] });
  });

  it('retains an absent legacy PID when its PGID is missing or nonpositive', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-legacy-no-pgid-'));
    const legacy = { ...registeredProcess({ process_identity: undefined as never }) } as Record<string, unknown>;
    delete legacy.process_group_id;
    const registryPath = await writeRegistry(dataDir, 1, [legacy]);
    const killSpy = vi.spyOn(process, 'kill');

    await expect(cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [6883],
      registry_unproven: true,
    });

    expect(killSpy).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(registryPath, 'utf8')).processes).toEqual([{ ...legacy, process_identity: null }]);
  });

  it('retains an EPERM pre-v2 record as nullable v2 and never sends a terminating signal', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-legacy-eperm-'));
    const registryPath = await writeRegistry(dataDir, 1, [registeredProcess({ process_identity: undefined as never })]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0 })).resolves.toMatchObject({
      survivor_pids: [6883],
      registry_unproven: true,
    });
    expect(killSpy.mock.calls).toEqual([[6883, 0]]);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).processes[0].process_identity).toBeNull();
  });

  it('quarantines a live malformed entry without sending TERM or KILL', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-entry-quarantine-'));
    const registryPath = await writeRegistry(dataDir, 2, [{ ...registeredProcess(), injected: true }]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      return true;
    });

    const result = await cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0 });
    expect(result).toMatchObject({ survivor_pids: [6883], registry_unproven: true });
    expect(result.diagnostic_paths).toHaveLength(1);
    expect(killSpy.mock.calls).toEqual([[6883, 0]]);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({ version: 2, processes: [] });
    expect(JSON.parse(await readFile(result.diagnostic_paths![0], 'utf8')).entries).toHaveLength(1);
  });

  it('stores only redacted digest evidence for malformed bytes and recovers after a proven reboot boundary', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-malformed-'));
    const registryPath = resolveAgentProcessRegistryPath(dataDir);
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, 'null', 'utf8');
    const killSpy = vi.spyOn(process, 'kill');

    const first = await cleanupRegisteredAgentProcesses(dataDir, { bootEpochMs: 1_000 });
    expect(first).toMatchObject({ survivor_pids: [], registry_unproven: true });
    expect(first.diagnostic_paths).toHaveLength(1);
    expect(killSpy).not.toHaveBeenCalled();
    await expect(lstat(registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const diagnostic = JSON.parse(await readFile(first.diagnostic_paths![0], 'utf8'));
    expect(diagnostic).toMatchObject({ version: 2, source_size: 4, entries: [] });
    expect(JSON.stringify(diagnostic)).not.toContain('null');
    await expect(cleanupRegisteredAgentProcesses(dataDir, { bootEpochMs: 1_000 })).resolves.toMatchObject({
      survivor_pids: [],
      registry_unproven: true,
      diagnostic_paths: first.diagnostic_paths,
    });
    await expect(cleanupRegisteredAgentProcesses(dataDir, { bootEpochMs: 10_000 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });
  });

  it('quarantines a nonnumeric registry version without erasing its evidence', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-version-'));
    const registryPath = await writeRegistry(dataDir, 'evil', [registeredProcess()]);

    const result = await cleanupRegisteredAgentProcesses(dataDir);
    expect(result).toMatchObject({ survivor_pids: [], registry_unproven: true });
    expect(result.diagnostic_paths).toHaveLength(1);
    await expect(lstat(registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(result.diagnostic_paths![0], 'utf8'))).toMatchObject({
      version: 2,
      reason: 'registry_structure_invalid',
    });
  });

  it('opens one batch probe session for many v2 entries and closes it once', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-batch-'));
    const entries = [registeredProcess(), registeredProcess({ pid: 6884, process_group_id: 6884 })];
    await writeRegistry(dataDir, 2, entries);
    const probeMany = vi
      .fn()
      .mockResolvedValueOnce(['match', 'match'])
      .mockResolvedValueOnce(['match'])
      .mockResolvedValueOnce(['match'])
      .mockResolvedValueOnce(['match', 'match'])
      .mockResolvedValueOnce(['match'])
      .mockResolvedValueOnce(['match'])
      .mockResolvedValueOnce(['absent', 'absent']);
    const close = vi.fn();
    const provider: RegisteredAgentProcessIdentityProbeProvider = {
      open: vi.fn().mockResolvedValue({ probeMany, close }),
    };
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (signal === 0 && (target === -6883 || target === -6884)) {
        throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
      }
      return true;
    });

    await expect(
      cleanupRegisteredAgentProcesses(dataDir, { identityProbeProvider: provider, termGraceMs: 0 })
    ).resolves.toEqual({ survivor_pids: [], registry_unproven: false });
    expect(provider.open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(probeMany).toHaveBeenCalledTimes(7);
    expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(2);
    expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(2);
  });

  it('drains exact Core emergency evidence only after v2 identity and PGID absence proof', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-emergency-drain-'));
    const emergencyDir = path.join(dataDir, AGENT_PROCESS_REGISTRY_EMERGENCY_RELATIVE_DIR);
    await mkdir(emergencyDir, { recursive: true });
    const evidencePath = path.join(emergencyDir, 'agent-process-1-6883.json');
    await writeFile(
      evidencePath,
      JSON.stringify({
        version: 1,
        reason: 'registry_write_failed_cleanup_unproven',
        process: registeredProcess(),
      })
    );
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('absent');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });
    await expect(lstat(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(killSpy.mock.calls).toEqual([[-6883, 0]]);
  });

  it('retains live Core emergency evidence as an explicit diagnostic blocker', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-emergency-live-'));
    const emergencyDir = path.join(dataDir, AGENT_PROCESS_REGISTRY_EMERGENCY_RELATIVE_DIR);
    await mkdir(emergencyDir, { recursive: true });
    const evidencePath = path.join(emergencyDir, 'agent-process-1-6883.json');
    await writeFile(
      evidencePath,
      JSON.stringify({
        version: 1,
        reason: 'registry_write_failed_cleanup_unproven',
        process: { ...registeredProcess(), process_identity: null },
      })
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      return true;
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [6883],
      registry_unproven: true,
      diagnostic_paths: [evidencePath],
    });
    expect(killSpy.mock.calls).toEqual([[6883, 0]]);
    expect(await lstat(evidencePath)).toMatchObject({ mode: expect.any(Number) });
  });

  it('consumes the independent Core fallback evidence directory', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-fallback-drain-'));
    const emergencyDir = path.join(dataDir, AGENT_PROCESS_REGISTRY_FALLBACK_RELATIVE_DIR);
    await mkdir(emergencyDir, { recursive: true });
    const evidencePath = path.join(emergencyDir, 'agent-process-2-6883.json');
    await writeFile(
      evidencePath,
      JSON.stringify({
        version: 1,
        reason: 'registry_write_failed_cleanup_unproven',
        process: registeredProcess(),
      })
    );
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('absent');
    vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });
    await expect(lstat(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('consumes the external fallback when the data-root evidence location failed', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-external-fallback-'));
    const emergencyDir = await resolveExternalAgentProcessEmergencyDirectory(dataDir);
    await mkdir(emergencyDir, { recursive: true });
    const evidencePath = path.join(emergencyDir, 'agent-process-3-6883.json');
    await writeFile(
      evidencePath,
      JSON.stringify({
        version: 1,
        reason: 'registry_write_failed_cleanup_unproven',
        process: registeredProcess(),
      })
    );
    const identityProbe = vi.fn<RegisteredAgentProcessIdentityProbe>().mockResolvedValue('absent');
    vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
    });

    await expect(cleanupRegisteredAgentProcesses(dataDir, { identityProbe, termGraceMs: 0 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });
    await expect(lstat(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(emergencyDir, { recursive: true, force: true });
  });

  it('re-evaluates structured quarantine entries and retires only after PID and PGID are both absent', async () => {
    if (process.platform === 'win32') return;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-quarantine-recovery-'));
    await writeRegistry(dataDir, 2, [{ ...registeredProcess(), injected: true }]);
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    const first = await cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0, bootEpochMs: 1_000 });
    expect(first.registry_unproven).toBe(true);
    expect(first.diagnostic_paths).toHaveLength(1);

    killSpy.mockImplementation((_target, signal) => {
      expect(signal).toBe(0);
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    });
    await expect(cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0, bootEpochMs: 1_000 })).resolves.toEqual({
      survivor_pids: [],
      registry_unproven: false,
    });
    await expect(lstat(first.diagnostic_paths![0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('scrubs raw ACP arguments from migrated and quarantined evidence', async () => {
    const secret = '--api-key=secret-arg-value';
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-redaction-'));
    const legacy = { ...registeredProcess({ process_identity: undefined as never }), command_preview: secret };
    const registryPath = await writeRegistry(dataDir, 1, [legacy]);
    vi.spyOn(process, 'kill').mockReturnValue(true);

    await cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0 });
    expect(await readFile(registryPath, 'utf8')).not.toContain(secret);

    await writeRegistry(dataDir, 2, [{ ...registeredProcess(), command_preview: secret, injected: true }]);
    const quarantined = await cleanupRegisteredAgentProcesses(dataDir, { termGraceMs: 0 });
    expect(quarantined.diagnostic_paths).toHaveLength(1);
    expect(await readFile(quarantined.diagnostic_paths![0], 'utf8')).not.toContain(secret);
  });
});
