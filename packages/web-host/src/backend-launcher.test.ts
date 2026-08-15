/**
 * M4 unit tests for backend-launcher.
 * All external I/O mocked: node:child_process.spawn, node:net.createServer, fetch.
 * No real backend is spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';

// ---- Module-level mocks ----
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('node:fs', () => ({
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('./agent-process-registry.js', () => ({
  cleanupRegisteredAgentProcesses: vi.fn().mockResolvedValue({ survivor_pids: [], registry_unproven: false }),
}));

import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { cleanupRegisteredAgentProcesses } from './agent-process-registry.js';
import {
  buildSpawnArgs,
  buildSpawnEnv,
  findAvailablePort,
  BackendLifecycleManager,
  COMMAND_EVE_BACKEND_TERMINATION_UNPROVEN,
  resolveLocalBackendOrigins,
} from './backend-launcher.js';
import type { AppMetadata } from './types.js';

const APP_META: AppMetadata = {
  version: '1.2.3',
  isPackaged: false,
  resourcesPath: '/mock/resources',
  userDataPath: '/mock/userData',
};

const APP_META_PACKAGED: AppMetadata = { ...APP_META, isPackaged: true };
let exitListenersBeforeTest = new Set(process.listeners('exit'));

function makeFakeServer(port = 54321) {
  const server = new EventEmitter() as EventEmitter & {
    listen: (p: number, h: string, cb: () => void) => void;
    address: () => { port: number };
    close: (cb?: () => void) => void;
  };
  server.listen = (_p, _h, cb) => {
    setImmediate(cb);
  };
  server.address = () => ({ port });
  server.close = (cb) => {
    if (cb) setImmediate(cb);
  };
  return server;
}

function makeSyncFakeServer(port = 54321) {
  const server = makeFakeServer(port);
  server.listen = (_p, _h, cb) => {
    cb();
  };
  server.close = (cb) => {
    if (cb) cb();
  };
  return server;
}

function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  child.stdout = new EventEmitter() as ChildProcess['stdout'];
  child.stderr = new EventEmitter() as ChildProcess['stderr'];
  (child.stdin as unknown) = { end: vi.fn() };
  child.kill = vi.fn() as unknown as ChildProcess['kill'];
  child.pid = 99999;
  return child as ChildProcess;
}

function processError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function markChildTerminal(
  child: ChildProcess,
  exitCode: number | null = 0,
  signalCode: NodeJS.Signals | null = null
): void {
  Object.assign(child, { exitCode, signalCode });
  (child as unknown as EventEmitter).emit('exit', exitCode, signalCode);
  (child as unknown as EventEmitter).emit('close', exitCode, signalCode);
}

function emitListening(child: ChildProcess, port: number): void {
  child.stdout?.emit('data', Buffer.from(`AIONCORE_LISTENING {"host":"127.0.0.1","port":${port}}\n`));
}

function makeFakeSocket(): Socket {
  const socket = new EventEmitter() as EventEmitter & Partial<Socket>;
  socket.setTimeout = vi.fn(() => socket as Socket) as unknown as Socket['setTimeout'];
  socket.destroy = vi.fn() as unknown as Socket['destroy'];
  socket.end = vi.fn() as unknown as Socket['end'];
  return socket as Socket;
}

beforeEach(() => {
  vi.clearAllMocks();
  exitListenersBeforeTest = new Set(process.listeners('exit'));
});

afterEach(() => {
  // Do NOT call restoreAllMocks; it would remove vi.mock() module factories.
  for (const listener of process.listeners('exit')) {
    if (!exitListenersBeforeTest.has(listener)) process.removeListener('exit', listener);
  }
  vi.useRealTimers();
});

describe('buildSpawnArgs', () => {
  it('produces all required flags with logDir and local=true', () => {
    const args = buildSpawnArgs({
      port: 12345,
      dbPath: '/data/path',
      local: true,
      logDir: '/log/dir',
      appVersion: '9.9.9',
      isPackaged: true,
      localCapabilityFile: '/run/capability',
    });
    expect(args).toEqual([
      '--port',
      '12345',
      '--data-dir',
      '/data/path',
      '--log-level',
      'info',
      '--app-version',
      '9.9.9',
      '--managed-resources-mode',
      'bundled',
      '--log-dir',
      '/log/dir',
      '--local',
      '--local-capability-file',
      '/run/capability',
      '--local-origin',
      'null',
    ]);
  });

  it('uses debug log level when not packaged', () => {
    const args = buildSpawnArgs({
      port: 1,
      dbPath: '/d',
      local: false,
      appVersion: '0.0.1',
      isPackaged: false,
    });
    expect(args).toContain('debug');
    expect(args).not.toContain('--managed-resources-mode');
    expect(args).not.toContain('--log-dir');
    expect(args).not.toContain('--local');
  });

  it('fails closed when local mode has no capability file', () => {
    expect(() =>
      buildSpawnArgs({
        port: 1,
        dbPath: '/d',
        local: true,
        appVersion: '0.0.1',
        isPackaged: true,
      })
    ).toThrow('local backend requires a capability file');
  });

  it('passes bundled managed resources mode when packaged', () => {
    const args = buildSpawnArgs({
      port: 1,
      dbPath: '/d',
      local: false,
      appVersion: '0.0.1',
      isPackaged: true,
    });
    expect(args).toContain('--managed-resources-mode');
    expect(args).toContain('bundled');
  });

  it('respects AIONUI_LOG_LEVEL override', () => {
    const prev = process.env.AIONUI_LOG_LEVEL;
    process.env.AIONUI_LOG_LEVEL = 'trace';
    try {
      const args = buildSpawnArgs({
        port: 1,
        dbPath: '/d',
        local: false,
        appVersion: 'x',
        isPackaged: true,
      });
      expect(args).toContain('trace');
    } finally {
      if (prev === undefined) delete process.env.AIONUI_LOG_LEVEL;
      else process.env.AIONUI_LOG_LEVEL = prev;
    }
  });
});

describe('buildSpawnEnv', () => {
  it('merges process.env with AIONUI_* dir vars', () => {
    const env = buildSpawnEnv({
      cacheDir: '/c',
      workDir: '/w',
      logDir: '/l',
    });
    expect(env.AIONUI_CACHE_DIR).toBe('/c');
    expect(env.AIONUI_WORK_DIR).toBe('/w');
    expect(env.AIONUI_LOG_DIR).toBe('/l');
    expect(env.PATH).toBe(process.env.PATH); // inherits
  });
});

describe('resolveLocalBackendOrigins', () => {
  it('keeps packaged builds on the opaque file origin', () => {
    expect(resolveLocalBackendOrigins(true, 'http://localhost:5173')).toEqual(['null']);
  });

  it('allows an exact loopback development origin', () => {
    expect(resolveLocalBackendOrigins(false, 'http://127.0.0.1:5173/app')).toEqual(['null', 'http://127.0.0.1:5173']);
  });

  it('rejects non-loopback and malformed development origins', () => {
    expect(resolveLocalBackendOrigins(false, 'https://example.com:5173')).toEqual(['null']);
    expect(resolveLocalBackendOrigins(false, 'not a url')).toEqual(['null']);
  });
});

describe('findAvailablePort', () => {
  it('resolves with the port reported by the listening server', async () => {
    vi.mocked(createServer).mockImplementationOnce(
      () => makeFakeServer(40404) as unknown as ReturnType<typeof createServer>
    );
    const port = await findAvailablePort();
    expect(port).toBe(40404);
  });

  it('resolves the preferred port when it is available', async () => {
    const server = makeFakeServer(65303);
    server.listen = (port, host, cb) => {
      expect(port).toBe(65303);
      expect(host).toBe('127.0.0.1');
      setImmediate(cb);
    };
    vi.mocked(createServer).mockImplementationOnce(() => server as unknown as ReturnType<typeof createServer>);

    const port = await findAvailablePort(65303);

    expect(port).toBe(65303);
  });

  it('skips ports blocked by Fetch so health checks can use the selected port', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      vi.mocked(createServer)
        .mockImplementationOnce(() => makeFakeServer(1720) as unknown as ReturnType<typeof createServer>)
        .mockImplementationOnce(() => makeFakeServer(40404) as unknown as ReturnType<typeof createServer>);

      const port = await findAvailablePort();

      expect(port).toBe(40404);
      expect(createServer).toHaveBeenCalledTimes(2);
      expect(infoSpy).toHaveBeenCalledWith('[aioncore] skipped fetch-blocked backend port 1720');
      expect(infoSpy).toHaveBeenCalledWith('[aioncore] selected backend port 40404 after 2 attempts');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('does not bind a preferred port when Fetch would block requests to it', async () => {
    const server = makeFakeServer(40404);
    server.listen = (port, host, cb) => {
      expect(port).toBe(0);
      expect(host).toBe('127.0.0.1');
      setImmediate(cb);
    };
    vi.mocked(createServer).mockImplementationOnce(() => server as unknown as ReturnType<typeof createServer>);

    const port = await findAvailablePort(1720);

    expect(port).toBe(40404);
  });

  it('rejects instead of retrying forever when every attempt returns a Fetch-blocked port', async () => {
    vi.mocked(createServer).mockImplementation(
      () => makeFakeServer(1720) as unknown as ReturnType<typeof createServer>
    );

    await expect(findAvailablePort(undefined, 2)).rejects.toThrow('Failed to get a fetch-compatible port');

    expect(createServer).toHaveBeenCalledTimes(2);
  });
});

describe('BackendLifecycleManager.start (success path)', () => {
  it('lets aioncore choose the backend port and waits for the reported listening event', async () => {
    vi.mocked(createServer).mockImplementation(() => {
      throw new Error('launcher must not pre-bind backend ports');
    });
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path', '/log/dir', {
      cacheDir: '/c',
      workDir: '/w',
      logDir: '/l',
    });

    await Promise.resolve();
    child.stdout?.emit('data', Buffer.from('AIONCORE_LISTENING {"host":"127.0.0.1","port":55555}\n'));

    const port = await startPromise;

    expect(port).toBe(55555);
    expect(mgr.port).toBe(55555);
    expect(createServer).not.toHaveBeenCalled();
    expect(mgr.localCapability).toMatch(/^[a-f0-9]{64}$/);
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/db\/path\/runtime-security\/local-capability-/),
      mgr.localCapability,
      expect.objectContaining({ flag: 'wx', mode: 0o600 })
    );
    const capabilityPath = vi
      .mocked(writeFileSync)
      .mock.calls.find((call) => String(call[0]).includes('/runtime-security/local-capability-'))?.[0];
    expect(capabilityPath).toEqual(expect.stringMatching(/^\/db\/path\/runtime-security\/local-capability-/));
    expect(rmSync).toHaveBeenCalledWith(capabilityPath, { force: true });
    expect(vi.mocked(spawn).mock.calls[0][1]).not.toContain(mgr.localCapability);
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:55555/health');
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual([
      '--port',
      '0',
      '--data-dir',
      '/db/path',
      '--parent-pid',
      String(process.pid),
      '--log-level',
      'info',
      '--app-version',
      '1.2.3',
      '--managed-resources-mode',
      'bundled',
      '--log-dir',
      '/log/dir',
      '--work-dir',
      '/w',
      '--local',
      '--local-capability-file',
      expect.stringMatching(/^\/db\/path\/runtime-security\/local-capability-/),
      '--local-origin',
      'null',
    ]);

    fetchSpy.mockRestore();
  });

  it('spawns with correct args, waits for /health, reports running', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const resolveBackend = vi.fn(() => '/abs/path/aioncore');
    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, resolveBackend);

    try {
      const startPromise = mgr.start('/db/path', '/log/dir', {
        cacheDir: '/c',
        workDir: '/w',
        logDir: '/l',
      });
      await Promise.resolve();
      emitListening(child, 55555);

      const port = await startPromise;

      expect(port).toBe(55555);
      expect(mgr.port).toBe(55555);
      expect(mgr.status).toBe('running');
      expect(resolveBackend).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      expect(spawnCall[0]).toBe('/abs/path/aioncore');
      expect(spawnCall[1]).toEqual([
        '--port',
        '0',
        '--data-dir',
        '/db/path',
        '--parent-pid',
        String(process.pid),
        '--log-level',
        'info',
        '--app-version',
        '1.2.3',
        '--managed-resources-mode',
        'bundled',
        '--log-dir',
        '/log/dir',
        '--work-dir',
        '/w',
        '--local',
        '--local-capability-file',
        expect.stringMatching(/^\/db\/path\/runtime-security\/local-capability-/),
        '--local-origin',
        'null',
      ]);
      const opts = spawnCall[2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.AIONUI_CACHE_DIR).toBe('/c');
      expect(opts.env.AIONUI_WORK_DIR).toBe('/w');
      expect(opts.env.AIONUI_LOG_DIR).toBe('/l');
      expect((spawnCall[2] as { detached?: boolean }).detached).toBe(process.platform !== 'win32');

      expect(fetchSpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[aioncore] health ready on port 55555 after 1 attempts, elapsed_ms=')
      );
    } finally {
      fetchSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('retries capability file cleanup on stop when post-bootstrap unlink fails', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw processError('ESRCH');
      return true;
    });
    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');

    try {
      const startPromise = mgr.start('/db/path', '/log/dir', {
        cacheDir: '/c',
        workDir: '/w',
        logDir: '/l',
      });
      await Promise.resolve();
      emitListening(child, 55555);
      await startPromise;

      const capabilityPath = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => String(call[0]).includes('/runtime-security/local-capability-'))?.[0];
      expect(capabilityPath).toEqual(expect.stringMatching(/^\/db\/path\/runtime-security\/local-capability-/));
      expect(warnSpy).toHaveBeenCalledWith(
        '[aioncore] failed to unlink bootstrap capability file after startup; will retry on cleanup',
        expect.objectContaining({ error: 'permission denied' })
      );

      const stopPromise = mgr.stop();
      markChildTerminal(child, 0, null);
      await stopPromise;

      expect(rmSync).toHaveBeenCalledWith(capabilityPath, { force: true });
      expect(rmSync).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
      killSpy.mockRestore();
    }
  });
});

describe('BackendLifecycleManager.start (health timeout)', () => {
  it('captures backend boundary code and stage from early-exit stderr', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33337) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path', '/log/dir', {
      cacheDir: '/cache',
      workDir: '/work',
      logDir: '/log',
    });

    await Promise.resolve();
    child.stderr?.emit(
      'data',
      Buffer.from(
        'BOOTSTRAP_DATA_INIT_FAILED stage=database.open databasePath=/db/path/aionui-backend.db: failed to initialize application data\n'
      )
    );
    child.emit('exit', 1, null);
    child.emit('close', 1, null);

    await expect(startPromise).rejects.toMatchObject({
      name: 'BackendStartupError',
      details: expect.objectContaining({
        backendBoundaryCode: 'BOOTSTRAP_DATA_INIT_FAILED',
        backendBoundaryStage: 'database.open',
      }),
    });
  });

  it('captures backend boundary code when stderr drains after exit but before close', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33337) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path', '/log/dir', {
      cacheDir: '/cache',
      workDir: '/work',
      logDir: '/log',
    });

    await Promise.resolve();
    child.emit('exit', 1, null);
    child.stderr?.emit(
      'data',
      Buffer.from(
        'BOOTSTRAP_DATA_INIT_FAILED stage=database.migration databasePath=/db/path/aionui-backend.db: failed to initialize application data\n'
      )
    );
    child.emit('close', 1, null);

    await expect(startPromise).rejects.toMatchObject({
      name: 'BackendStartupError',
      details: expect.objectContaining({
        backendBoundaryCode: 'BOOTSTRAP_DATA_INIT_FAILED',
        backendBoundaryStage: 'database.migration',
      }),
    });
  });

  it('kills child and reports listen_timeout when aioncore never reports a port', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path');
    const expectedRejection = expect(startPromise).rejects.toMatchObject({
      name: 'BackendStartupError',
      details: expect.objectContaining({
        stage: 'listen_timeout',
        port: 0,
      }),
    });

    await vi.advanceTimersByTimeAsync(31_000);
    await expectedRejection;

    expect(mgr.status).toBe('error');
    expect(killSpy).toHaveBeenCalled();

    killSpy.mockRestore();
  }, 15_000);

  it('kills child and throws when /health never responds OK within timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeFakeServer(33333) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db');
    const expectedRejection = expect(startPromise).rejects.toThrow(/failed to start within timeout/);

    await Promise.resolve();
    emitListening(child, 33333);

    // First await the timer advance so all setTimeout callbacks fire
    await vi.advanceTimersByTimeAsync(31_000);
    // Then await the rejection
    await expectedRejection;

    expect(mgr.status).toBe('error');
    expect(killSpy).toHaveBeenCalled();

    fetchSpy.mockRestore();
    killSpy.mockRestore();
    vi.useRealTimers();
  }, 15_000);

  it('includes startup diagnostics when health check times out', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33334) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path', '/log/dir', {
      cacheDir: '/cache',
      workDir: '/work',
      logDir: '/log',
    });
    const expectedRejection = expect(startPromise).rejects.toMatchObject({
      name: 'BackendStartupError',
      details: expect.objectContaining({
        stage: 'health_timeout',
        binaryPath: '/abs/path/aioncore',
        port: 33334,
        healthCheckAttempts: expect.any(Number),
        healthCheckLastError: 'ECONNREFUSED',
        dataDir: '/db/path',
        stderrTail: expect.stringContaining('database is locked'),
      }),
    });

    await Promise.resolve();
    await Promise.resolve();
    emitListening(child, 33334);
    child.stderr?.emit('data', Buffer.from('database is locked\n'));
    await vi.advanceTimersByTimeAsync(31_000);

    await expectedRejection;

    fetchSpy.mockRestore();
  }, 15_000);

  it('records the last non-OK health response when health check times out', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33336) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('starting', { status: 503 })));

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path');
    const expectedRejection = expect(startPromise).rejects.toMatchObject({
      name: 'BackendStartupError',
      details: expect.objectContaining({
        stage: 'health_timeout',
        port: 33336,
        healthCheckAttempts: expect.any(Number),
        healthCheckLastStatus: 503,
        healthCheckLastBody: 'starting',
      }),
    });

    await Promise.resolve();
    emitListening(child, 33336);
    await vi.advanceTimersByTimeAsync(31_000);
    await expectedRejection;

    fetchSpy.mockRestore();
  }, 15_000);

  it('records when server listening appears before health check times out', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33337) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path');
    const expectedRejection = expect(startPromise).rejects.toMatchObject({
      name: 'BackendStartupError',
      details: expect.objectContaining({
        stage: 'health_timeout',
        port: 33337,
        healthCheckLastError: 'fetch failed',
        serverListeningObserved: true,
        serverListeningObservedAfterMs: expect.any(Number),
        serverListeningLine: expect.stringContaining('AIONCORE_LISTENING'),
      }),
    });

    await Promise.resolve();
    emitListening(child, 33337);
    await vi.advanceTimersByTimeAsync(31_000);

    await expectedRejection;

    fetchSpy.mockRestore();
  }, 15_000);

  it('records TCP reachability when fetch fails after the server starts listening', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33338) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const socket = makeFakeSocket();
    vi.mocked(connect).mockImplementation((_options, onConnect) => {
      queueMicrotask(() => onConnect?.());
      return socket;
    });

    const fetchError = new TypeError('fetch failed') as TypeError & { cause?: NodeJS.ErrnoException };
    fetchError.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:33338'), {
      code: 'ECONNREFUSED',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(fetchError);

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path');
    const expectedRejection = expect(startPromise).rejects.toMatchObject({
      details: expect.objectContaining({
        backendPid: 99999,
        healthCheckUrl: 'http://127.0.0.1:33338/health',
        healthCheckTimeoutMs: 30_000,
        healthCheckIntervalMs: 200,
        healthCheckExpectedAttempts: 150,
        healthCheckElapsedMs: expect.any(Number),
        healthCheckLastAttemptAfterMs: expect.any(Number),
        healthCheckAttemptDeficit: expect.any(Number),
        healthCheckTimeoutOverrunMs: expect.any(Number),
        healthCheckPollingDelayed: expect.any(Boolean),
        healthCheckLastError: 'fetch failed',
        healthCheckLastErrorName: 'TypeError',
        healthCheckLastErrorCauseMessage: 'connect ECONNREFUSED 127.0.0.1:33338',
        healthCheckLastErrorCauseCode: 'ECONNREFUSED',
        healthCheckTcpProbeOk: true,
        healthCheckTcpProbeElapsedMs: expect.any(Number),
        healthCheckTcpProbeTimeoutMs: 1_000,
      }),
    });

    await Promise.resolve();
    emitListening(child, 33338);
    await vi.advanceTimersByTimeAsync(31_000);

    await expectedRejection;

    expect(connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 33338 }, expect.any(Function));
    expect(socket.destroy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  }, 15_000);

  it('records polling delay when a health attempt stalls past the timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33340) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const socket = makeFakeSocket();
    vi.mocked(connect).mockImplementation(() => {
      queueMicrotask(() => {
        socket.emit(
          'error',
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:33340'), { code: 'ECONNREFUSED' })
        );
      });
      return socket;
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new Error('fetch failed')), 545_000);
        })
    );

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path');
    const expectedRejection = expect(startPromise).rejects.toMatchObject({
      details: expect.objectContaining({
        port: 33340,
        healthCheckAttempts: 1,
        healthCheckExpectedAttempts: 150,
        healthCheckAttemptDeficit: 149,
        healthCheckPollingDelayed: true,
        healthCheckTimeoutOverrunMs: expect.any(Number),
      }),
    });

    await Promise.resolve();
    emitListening(child, 33340);
    await vi.advanceTimersByTimeAsync(545_250);
    await expectedRejection;

    fetchSpy.mockRestore();
  }, 15_000);

  it('records TCP connection errors when fetch fails and the port is unreachable', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33339) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const socket = makeFakeSocket();
    vi.mocked(connect).mockImplementation(() => {
      queueMicrotask(() => {
        socket.emit(
          'error',
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:33339'), { code: 'ECONNREFUSED' })
        );
      });
      return socket;
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path');
    const expectedRejection = expect(startPromise).rejects.toMatchObject({
      details: expect.objectContaining({
        port: 33339,
        healthCheckLastError: 'fetch failed',
        healthCheckTcpProbeOk: false,
        healthCheckTcpProbeError: 'connect ECONNREFUSED 127.0.0.1:33339',
        healthCheckTcpProbeErrorName: 'Error',
        healthCheckTcpProbeErrorCode: 'ECONNREFUSED',
        healthCheckTcpProbeElapsedMs: expect.any(Number),
      }),
    });

    await Promise.resolve();
    emitListening(child, 33339);
    await vi.advanceTimersByTimeAsync(31_000);

    await expectedRejection;

    expect(socket.destroy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  }, 15_000);

  it('keeps child alive and reports ready later when pending timeout is allowed', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(33335) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const onHealthTimeout = vi.fn();
    const onReady = vi.fn();

    const mgr = new BackendLifecycleManager(APP_META_PACKAGED, () => '/abs/path/aioncore');
    const startPromise = mgr.start('/db/path', '/log/dir', undefined, {
      allowPendingOnHealthTimeout: true,
      onHealthTimeout,
      onReady,
    });

    await Promise.resolve();
    emitListening(child, 33335);
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(startPromise).resolves.toBe(33335);

    expect(mgr.status).toBe('starting');
    expect(child.kill).not.toHaveBeenCalled();
    expect(onHealthTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'BackendStartupError',
        details: expect.objectContaining({
          stage: 'health_timeout',
          port: 33335,
        }),
      })
    );

    fetchSpy.mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    expect(mgr.status).toBe('running');
    expect(onReady).toHaveBeenCalledWith(33335);

    fetchSpy.mockRestore();
  }, 15_000);
});

describe('BackendLifecycleManager.stop', () => {
  it('cleans registered agent children even when no backend process remains', async () => {
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, { _lastDbPath: '/db-with-orphaned-agents' });

    await mgr.stop();

    expect(cleanupRegisteredAgentProcesses).toHaveBeenCalledWith('/db-with-orphaned-agents');
    expect(mgr.status).toBe('stopped');
  });

  it('reports termination_unproven when persisted registered descendants survive cleanup', async () => {
    vi.mocked(cleanupRegisteredAgentProcesses).mockResolvedValueOnce({
      survivor_pids: [7711],
      registry_unproven: true,
    });
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, { _lastDbPath: '/db-with-survivor', _port: 4816, _status: 'running' });

    await expect(mgr.stop()).rejects.toMatchObject({
      code: COMMAND_EVE_BACKEND_TERMINATION_UNPROVEN,
      details: { phase: 'registered_descendants_survived', signal: 0 },
    });

    expect(mgr.port).toBe(0);
  });

  it('never signals a terminal leader numeric PGID when the observed group may have been reused', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    const child = makeFakeChild();
    Object.assign(child, { pid: 31337, exitCode: 1 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, {
      childProcess: child,
      _lastDbPath: '/db-with-detached-grandchildren',
      _status: 'running',
      _port: 4811,
    });

    const stopPromise = mgr.stop();
    const assertion = expect(stopPromise).rejects.toMatchObject({
      code: COMMAND_EVE_BACKEND_TERMINATION_UNPROVEN,
      details: { phase: 'group_identity_unproven', signal: 0 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(killSpy).toHaveBeenCalledTimes(11);
    expect(killSpy.mock.calls.every(([target, signal]) => target === -31337 && signal === 0)).toBe(true);
    expect(killSpy).not.toHaveBeenCalledWith(-31337, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-31337, 'SIGKILL');
    expect(cleanupRegisteredAgentProcesses).toHaveBeenCalledWith('/db-with-detached-grandchildren');
    expect(mgr.port).toBe(0);
    expect((mgr as unknown as { childProcess: ChildProcess | null }).childProcess).toBeNull();
    killSpy.mockRestore();
  });

  it('accepts one ESRCH absence proof and never signals a later reused PGID', async () => {
    if (process.platform === 'win32') return;
    const child = makeFakeChild();
    Object.assign(child, { pid: 31340, exitCode: 1 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw processError('ESRCH');
      throw new Error('a reused group must never be signalled');
    });
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, { childProcess: child, _lastDbPath: '/db', _status: 'running', _port: 4815 });

    await mgr.stop();

    expect(killSpy.mock.calls).toEqual([[-31340, 0]]);
    expect(cleanupRegisteredAgentProcesses).toHaveBeenCalledWith('/db');
    killSpy.mockRestore();
  });

  it('observes a terminal leaders descendants drain during grace without sending another signal', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    const child = makeFakeChild();
    Object.assign(child, { pid: 31341, exitCode: 1 });
    let probes = 0;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      expect(signal).toBe(0);
      probes += 1;
      if (probes >= 4) throw processError('ESRCH');
      return true;
    });
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, { childProcess: child, _lastDbPath: '/db', _status: 'running', _port: 4817 });

    const stopPromise = mgr.stop();
    await vi.advanceTimersByTimeAsync(300);
    await stopPromise;

    expect(killSpy.mock.calls).toEqual([
      [-31341, 0],
      [-31341, 0],
      [-31341, 0],
      [-31341, 0],
    ]);
    expect(cleanupRegisteredAgentProcesses).toHaveBeenCalledWith('/db');
    expect((mgr as unknown as { childProcess: ChildProcess | null }).childProcess).toBeNull();
    killSpy.mockRestore();
  });

  it('clears manager port before registry cleanup can reject after a destructive stop', async () => {
    const child = makeFakeChild();
    Object.assign(child, { exitCode: 1 });
    vi.mocked(cleanupRegisteredAgentProcesses).mockRejectedValueOnce(new Error('registry cleanup failed'));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw processError('ESRCH');
      return true;
    });
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, { childProcess: child, _lastDbPath: '/db', _status: 'running', _port: 4812 });

    await expect(mgr.stop()).rejects.toThrow('registry cleanup failed');
    expect(mgr.port).toBe(0);
    expect(mgr.status).toBe('stopped');
    killSpy.mockRestore();
  });

  it('rejects startup as cancelled when stopped before health check passes', async () => {
    vi.mocked(createServer).mockImplementation(
      () => makeSyncFakeServer(22221) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db');

    await Promise.resolve();
    const stopPromise = mgr.stop();
    markChildTerminal(child, null, 'SIGTERM');
    await stopPromise;

    await expect(startPromise).rejects.toMatchObject({
      name: 'BackendStartupCancelledError',
    });
    expect(mgr.status).toBe('stopped');

    fetchSpy.mockRestore();
  });

  it('sends SIGTERM then resolves when child emits exit', async () => {
    vi.mocked(createServer).mockImplementation(
      () => makeFakeServer(22222) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw processError('ESRCH');
      return true;
    });

    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db');
    await Promise.resolve();
    emitListening(child, 22222);
    await startPromise;

    const stopPromise = mgr.stop();
    // Simulate graceful child exit
    markChildTerminal(child, 0);
    await stopPromise;

    expect(killSpy).toHaveBeenCalled();
    expect(cleanupRegisteredAgentProcesses).toHaveBeenCalledWith('/db');
    expect(mgr.status).toBe('stopped');

    fetchSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('escalates to SIGKILL when SIGTERM times out', async () => {
    vi.useFakeTimers();
    vi.mocked(createServer).mockImplementation(
      () => makeFakeServer(22223) as unknown as ReturnType<typeof createServer>
    );
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);
    let killed = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') {
        killed = true;
        markChildTerminal(child, null, 'SIGKILL');
      }
      if (signal === 0 && killed) throw processError('ESRCH');
      return true;
    });

    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db');
    await Promise.resolve();
    emitListening(child, 22223);
    await startPromise;

    const stopPromise = mgr.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopPromise;

    expect(killSpy.mock.calls).toEqual(expect.arrayContaining([[expect.any(Number), 'SIGTERM']]));
    expect(killSpy.mock.calls).toEqual(expect.arrayContaining([[expect.any(Number), 'SIGKILL']]));
    expect(cleanupRegisteredAgentProcesses).toHaveBeenCalledWith('/db');

    fetchSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('reports termination_unproven when SIGKILL is refused and never runs registry cleanup', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    const child = makeFakeChild();
    Object.assign(child, { pid: 31338 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') throw processError('EPERM');
      return true;
    });
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, { childProcess: child, _lastDbPath: '/db', _status: 'running', _port: 4813 });

    const stopPromise = mgr.stop();
    const assertion = expect(stopPromise).rejects.toMatchObject({
      code: COMMAND_EVE_BACKEND_TERMINATION_UNPROVEN,
      details: { phase: 'signal_failed', signal: 'SIGKILL', error_code: 'EPERM' },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(mgr.port).toBe(0);
    expect(cleanupRegisteredAgentProcesses).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('reports termination_unproven without signalling when a terminal leader group is still present', async () => {
    if (process.platform === 'win32') return;
    vi.useFakeTimers();
    const child = makeFakeChild();
    Object.assign(child, { pid: 31339, exitCode: 1 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    Object.assign(mgr, { childProcess: child, _lastDbPath: '/db', _status: 'running', _port: 4814 });

    const stopPromise = mgr.stop();
    const assertion = expect(stopPromise).rejects.toMatchObject({
      code: COMMAND_EVE_BACKEND_TERMINATION_UNPROVEN,
      details: { phase: 'group_identity_unproven', signal: 0 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    expect(mgr.port).toBe(0);
    expect(killSpy).toHaveBeenCalledTimes(11);
    expect(killSpy.mock.calls.every(([target, signal]) => target === -31339 && signal === 0)).toBe(true);
    expect(cleanupRegisteredAgentProcesses).toHaveBeenCalledWith('/db');
    killSpy.mockRestore();
  });
});

describe('BackendLifecycleManager crash restart', () => {
  it('restarts on the existing backend port after an unexpected exit', async () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(child1 as unknown as ChildProcess)
      .mockReturnValueOnce(child2 as unknown as ChildProcess);
    const onReady = vi.fn();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);

    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db', undefined, undefined, { onReady });
    await Promise.resolve();
    emitListening(child1, 65303);
    await startPromise;
    expect(mgr.status).toBe('running');
    expect(vi.mocked(spawn).mock.calls[0][1]).toContain('0');

    (child1 as unknown as EventEmitter).emit('exit', 1, 'SIGABRT');
    await new Promise((r) => setTimeout(r, 1_200));
    emitListening(child2, 65303);
    await new Promise((r) => setTimeout(r, 1));

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1][1]).toContain('65303');
    expect(mgr.port).toBe(65303);
    expect(onReady).toHaveBeenCalledWith(65303);

    fetchSpy.mockRestore();
  }, 5_000);

  it('delegates a crash restart to the injected lifecycle owner before starting another child', async () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(child1 as unknown as ChildProcess)
      .mockReturnValueOnce(child2 as unknown as ChildProcess);
    let markOwnerEntered!: () => void;
    let releaseOwner!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let mgr!: BackendLifecycleManager;
    const restartAfterCrash = vi.fn(async ({ claimIfCurrent }: { claimIfCurrent: () => boolean }) => {
      markOwnerEntered();
      await ownerGate;
      if (!claimIfCurrent()) return undefined;
      return mgr.start('/db', undefined, undefined, { restartAfterCrash }, 65303);
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);

    mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db', undefined, undefined, { restartAfterCrash });
    await Promise.resolve();
    emitListening(child1, 65303);
    await startPromise;

    (child1 as unknown as EventEmitter).emit('exit', 1, 'SIGABRT');
    await ownerEntered;
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    releaseOwner();
    await Promise.resolve();
    emitListening(child2, 65303);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(restartAfterCrash).toHaveBeenCalledOnce();

    fetchSpy.mockRestore();
  }, 5_000);

  it('suppresses a queued crash restart when another lifecycle transaction replaced the crashed child', async () => {
    const crashedChild = makeFakeChild();
    const replacementChild = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(crashedChild as unknown as ChildProcess);
    let markOwnerEntered!: () => void;
    let releaseOwner!: () => void;
    const ownerEntered = new Promise<void>((resolve) => {
      markOwnerEntered = resolve;
    });
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const restartAfterCrash = vi.fn(async ({ claimIfCurrent }: { claimIfCurrent: () => boolean }) => {
      markOwnerEntered();
      await ownerGate;
      expect(claimIfCurrent()).toBe(false);
      return undefined;
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db', undefined, undefined, { restartAfterCrash });
    await Promise.resolve();
    emitListening(crashedChild, 65303);
    await startPromise;

    (crashedChild as unknown as EventEmitter).emit('exit', 1, 'SIGABRT');
    await ownerEntered;
    const mutableManager = mgr as unknown as {
      childProcess: ChildProcess | null;
      _status: 'stopped' | 'starting' | 'running' | 'error';
    };
    mutableManager.childProcess = replacementChild;
    mutableManager._status = 'running';
    releaseOwner();
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(restartAfterCrash).toHaveBeenCalledOnce();
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    expect(mgr.status).toBe('running');

    fetchSpy.mockRestore();
  }, 5_000);

  it('clears manager port truth when the injected crash owner claims the child and then fails', async () => {
    const child = makeFakeChild();
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const restartAfterCrash = vi.fn(async ({ claimIfCurrent }: { claimIfCurrent: () => boolean }) => {
      expect(claimIfCurrent()).toBe(true);
      throw new Error('runtime admission failed before replacement');
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db', undefined, undefined, { restartAfterCrash });
    await Promise.resolve();
    emitListening(child, 65303);
    await startPromise;

    (child as unknown as EventEmitter).emit('exit', 1, 'SIGABRT');
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(restartAfterCrash).toHaveBeenCalledOnce();
    expect(mgr.status).toBe('error');
    expect(mgr.port).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
    fetchSpy.mockRestore();
  }, 5_000);

  it('binds post-await failure cleanup and output listeners to the child that start actually spawned', async () => {
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    Object.assign(child1, { pid: 11111 });
    Object.assign(child2, { pid: 22222 });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.mocked(spawn)
      .mockReturnValueOnce(child1 as unknown as ChildProcess)
      .mockReturnValueOnce(child2 as unknown as ChildProcess);
    let releaseFirstHealth!: () => void;
    let markFirstHealthEntered!: () => void;
    const firstHealthGate = new Promise<void>((resolve) => {
      releaseFirstHealth = resolve;
    });
    const firstHealthEntered = new Promise<void>((resolve) => {
      markFirstHealthEntered = resolve;
    });
    let healthCall = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      healthCall += 1;
      if (healthCall === 1) {
        markFirstHealthEntered();
        await firstHealthGate;
      }
      return new Response('ok', { status: 200 }) as unknown as Response;
    });
    const mgr = new BackendLifecycleManager(APP_META, () => '/x');

    const first = mgr.start('/db-one');
    const firstAssertion = expect(first).rejects.toThrow('superseded before health admission');
    await Promise.resolve();
    emitListening(child1, 65301);
    await firstHealthEntered;
    const second = mgr.start('/db-two');
    await Promise.resolve();
    emitListening(child2, 65302);
    await expect(second).resolves.toBe(65302);

    releaseFirstHealth();
    await firstAssertion;
    child1.stdout?.emit('data', Buffer.from('AIONCORE_LISTENING {"host":"127.0.0.1","port":65499}\n'));

    expect(mgr.status).toBe('running');
    expect(mgr.port).toBe(65302);
    expect(killSpy).toHaveBeenCalledWith(-11111, 'SIGKILL');
    expect(killSpy).not.toHaveBeenCalledWith(-22222, 'SIGKILL');
    expect((mgr as unknown as { childProcess: ChildProcess | null }).childProcess).toBe(child2);

    killSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('logs crash restart scheduling details', async () => {
    vi.mocked(createServer).mockImplementation(
      () => makeFakeServer(65303) as unknown as ReturnType<typeof createServer>
    );
    const child1 = makeFakeChild();
    const child2 = makeFakeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(child1 as unknown as ChildProcess)
      .mockReturnValueOnce(child2 as unknown as ChildProcess);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }) as unknown as Response);

    const mgr = new BackendLifecycleManager(APP_META, () => '/x');
    const startPromise = mgr.start('/db');
    await Promise.resolve();
    emitListening(child1, 65303);
    await startPromise;

    (child1 as unknown as EventEmitter).emit('exit', 1, 'SIGABRT');
    await new Promise((r) => setTimeout(r, 1_200));

    expect(warnSpy).toHaveBeenCalledWith('[aioncore] child exited unexpectedly; scheduling restart', {
      exitCode: 1,
      signal: 'SIGABRT',
      port: 65303,
      restartCount: 1,
      maxRestarts: 3,
      delayMs: 1000,
    });

    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  }, 5_000);

  it('logs when crash restart limit is exceeded', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mgr = new BackendLifecycleManager(APP_META, () => '/x') as unknown as {
      restartCount: number;
      restartWindowStart: number;
      handleCrash: (code: number | null, signal?: NodeJS.Signals | string | null) => void;
      status: string;
    };
    mgr.restartCount = 3;
    mgr.restartWindowStart = Date.now();

    mgr.handleCrash(1, 'SIGABRT');

    expect(mgr.status).toBe('error');
    expect(errorSpy).toHaveBeenCalledWith('[aioncore] child exited unexpectedly; restart limit exceeded', {
      exitCode: 1,
      signal: 'SIGABRT',
      port: 0,
      restartCount: 4,
      maxRestarts: 3,
    });

    errorSpy.mockRestore();
  });
});
