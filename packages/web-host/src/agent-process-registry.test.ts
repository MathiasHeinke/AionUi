import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupRegisteredAgentProcesses, resolveAgentProcessRegistryPath } from './agent-process-registry.js';

describe('cleanupRegisteredAgentProcesses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('kills a registered process group even when the wrapper pid has already exited', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-'));
    const registryPath = resolveAgentProcessRegistryPath(dataDir);
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        processes: [
          {
            pid: 6883,
            process_group_id: 6883,
            conversation_id: 'conv-1',
            agent_type: 'acp',
            backend: 'codex',
            registered_at_ms: 1,
          },
        ],
      }),
      'utf8'
    );

    let groupAlive = true;
    const notFound = () => Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      target: number,
      signal?: NodeJS.Signals | number
    ) => {
      if (target === -6883 && signal === 0) {
        if (groupAlive) return true;
        throw notFound();
      }
      if (target === 6883 && signal === 0) {
        throw notFound();
      }
      if (target === -6883 && signal === 'SIGTERM') {
        groupAlive = false;
        return true;
      }
      if (target === -6883 && signal === 'SIGKILL') {
        groupAlive = false;
        return true;
      }
      throw notFound();
    }) as typeof process.kill);

    await cleanupRegisteredAgentProcesses(dataDir);

    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      processes: Array<{ pid: number }>;
    };

    expect(killSpy).toHaveBeenCalledWith(-6883, 'SIGTERM');
    expect(registry.processes).toEqual([]);
  });

  // The registry file is data from disk, and `readRegistry` used to cast it
  // straight to `Partial<AgentProcessRegistry>`. A cast is not a check: it tells
  // the compiler to stop asking, and `JSON.parse` is free to return null, a
  // number, a string or an array. These two tests send a genuinely broken file
  // through and assert what the program does afterwards — not that a guard
  // exists.

  it('a corrupt registry root does not abort the shutdown that has to kill orphaned agents', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-null-'));
    const registryPath = resolveAgentProcessRegistryPath(dataDir);
    await mkdir(path.dirname(registryPath), { recursive: true });
    // Valid JSON, and not an object. `parsed.version` on it throws a TypeError,
    // which `isNotFound` does not recognise, so `readRegistry` rethrows.
    await writeFile(registryPath, 'null', 'utf8');

    // WHY A REJECTION HERE IS THE DAMAGE, not merely an untidy error: both call
    // sites await this without a try/catch (backend-launcher.ts:875 and :892).
    // A throw therefore aborts `stop()` before `cleanupLocalCapabilityFile()` and
    // before `this.childProcess = null` — and, the point of the function, before a
    // single orphaned ACP child has been signalled. One malformed byte on disk
    // keeps every orphan alive.
    await expect(cleanupRegisteredAgentProcesses(dataDir)).resolves.toBeUndefined();
  });

  it('refuses a non-numeric version instead of writing it back into the file', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aionui-agent-registry-version-'));
    const registryPath = resolveAgentProcessRegistryPath(dataDir);
    await mkdir(path.dirname(registryPath), { recursive: true });
    // `version` is typed `number`. `?? 1` only replaces null/undefined, so any
    // other JSON value passed straight through the cast — and back out through
    // `writeRegistry`, which persists whatever it was handed.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 'evil',
        processes: [{ pid: 2147483646, conversation_id: 'conv-x', agent_type: 'acp', registered_at_ms: 1 }],
      }),
      'utf8'
    );

    const notFound = () => Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw notFound();
    }) as typeof process.kill);

    await cleanupRegisteredAgentProcesses(dataDir);

    const written = JSON.parse(await readFile(registryPath, 'utf8')) as { version: unknown };
    expect(typeof written.version).toBe('number');
    expect(written.version).toBe(1);
  });
});
