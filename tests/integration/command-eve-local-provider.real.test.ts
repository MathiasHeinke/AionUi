/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Real AionCore proof for the 1.818 seat-scoped local-provider bootstrap.
 * The release gate sets AIONUI_BACKEND_BINARY so this suite must RUN; normal
 * source-only environments without a binary skip instead of downloading one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IProvider } from '@/common/config/storage';
import { ensureCommandEveShimAuthToken } from '@/process/commandEve/ollamaOpenAiShim';
import { ensureCommandEveLocalRuntimeProvider } from '@/process/commandEve/providerBootstrap';
import { installMainProcessLocalBackendCapability } from '@/process/security/localBackendCapabilityCore';
import { resolveAioncoreBinary } from '../e2e/helpers/aioncoreBinary';

const LOCAL_PROVIDER_ID = 'command-eve-local-runtime';

function resolvedBinary(): string | undefined {
  try {
    return resolveAioncoreBinary();
  } catch {
    return undefined;
  }
}

const backendBinary = resolvedBinary();
const describeWithBackend = backendBinary ? describe : describe.skip;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a loopback port.')));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`AionCore did not become healthy on port ${port}.`);
}

async function stopBackend(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
}

async function unwrapJson<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { data?: T } | T;
  return body && typeof body === 'object' && 'data' in body ? (body.data as T) : (body as T);
}

describeWithBackend('Command EVE local provider bootstrap (real AionCore)', () => {
  let root = '';
  let backend: ChildProcess | undefined;
  let port = 0;
  let capability = '';
  let restoreCapabilityFetch: (() => void) | undefined;

  async function startBackend(dataDir: string): Promise<void> {
    await stopBackend(backend);
    port = await freePort();
    capability = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
    const capabilityFile = path.join(root, `local-capability-${port}`);
    await fsp.writeFile(capabilityFile, `${capability}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(capabilityFile, 0o600);
    backend = spawn(
      backendBinary!,
      [
        '--local',
        '--local-capability-file',
        capabilityFile,
        '--port',
        String(port),
        '--data-dir',
        dataDir,
        '--work-dir',
        path.join(dataDir, 'work'),
        '--log-level',
        'warn',
        '--app-version',
        '0.1.37',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, RUST_LOG: 'warn' } }
    );
    let stderr = '';
    backend.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    backend.once('exit', (code) => {
      if (code && code !== 0) console.error(`[provider-real-test] AionCore exited ${code}: ${stderr}`);
    });
    await waitForHealth(port);
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = port;
  }

  async function providers(): Promise<IProvider[]> {
    return await unwrapJson<IProvider[]>(await fetch(`http://127.0.0.1:${port}/api/providers`));
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'eve-1818-provider-real-'));
    restoreCapabilityFetch = installMainProcessLocalBackendCapability({
      getPort: () => port,
      getCapability: () => capability,
    });
  });

  afterEach(async () => {
    delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    await stopBackend(backend);
    backend = undefined;
    restoreCapabilityFetch?.();
    restoreCapabilityFetch = undefined;
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  it('seeds both seat DBs and repairs stale security fields without losing operator models', async () => {
    const seatA = path.join(root, 'seat-a');
    const seatB = path.join(root, 'seat-b');

    await startBackend(seatA);
    await expect(ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 })).resolves.toMatchObject({
      status: 'ready',
      created: true,
    });
    const modifiedModels = ['custom:operator-preserved-model'];
    await unwrapJson<IProvider>(
      await fetch(`http://127.0.0.1:${port}/api/providers/${LOCAL_PROVIDER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'openai',
          base_url: 'https://credential-sink.invalid/v1',
          api_key: 'previous-process-token',
          models: modifiedModels,
          enabled: false,
          is_full_url: true,
        }),
      })
    );

    await startBackend(seatB);
    await expect(ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 })).resolves.toMatchObject({
      status: 'ready',
      created: true,
    });
    expect((await providers()).filter((provider) => provider.id === LOCAL_PROVIDER_ID)).toHaveLength(1);

    await startBackend(seatA);
    await expect(ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 })).resolves.toMatchObject({
      status: 'ready',
      created: false,
    });
    const restored = (await providers()).find((provider) => provider.id === LOCAL_PROVIDER_ID);
    expect(restored).toMatchObject({
      platform: 'custom',
      base_url: 'http://127.0.0.1:25811/v1',
      api_key: ensureCommandEveShimAuthToken(),
      models: modifiedModels,
      enabled: true,
      is_full_url: false,
    });
  }, 60_000);

  it('recovers from an injected first POST 500 in the same process', async () => {
    await startBackend(path.join(root, 'retry-seat'));
    const realFetch = globalThis.fetch;
    let injected = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!injected && init?.method === 'POST' && url.endsWith('/api/providers')) {
        injected = true;
        return new Response(JSON.stringify({ success: false, error: 'injected transient', code: 'TEST_500' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return await realFetch(input, init);
    }) as typeof fetch;
    try {
      await expect(ensureCommandEveLocalRuntimeProvider({ maxAttempts: 2, retryDelayMs: 0 })).resolves.toMatchObject({
        status: 'ready',
        attempts: 2,
        created: true,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(injected).toBe(true);
    expect((await providers()).filter((provider) => provider.id === LOCAL_PROVIDER_ID)).toHaveLength(1);
  }, 30_000);

  it('concurrent seeds against one real DB leave exactly one row', async () => {
    await startBackend(path.join(root, 'race-seat'));
    const results = await Promise.all([
      ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 }),
      ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 }),
    ]);
    expect(results.every((result) => result.status === 'ready')).toBe(true);
    expect((await providers()).filter((provider) => provider.id === LOCAL_PROVIDER_ID)).toHaveLength(1);
  }, 30_000);

  it('concurrent stale-token repairs converge on the current boot nonce', async () => {
    await startBackend(path.join(root, 'repair-race-seat'));
    await ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 });
    await unwrapJson<IProvider>(
      await fetch(`http://127.0.0.1:${port}/api/providers/${LOCAL_PROVIDER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'previous-process-token' }),
      })
    );

    const results = await Promise.all([
      ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 }),
      ensureCommandEveLocalRuntimeProvider({ retryDelayMs: 0 }),
    ]);
    expect(results.every((result) => result.status === 'ready')).toBe(true);
    const rows = (await providers()).filter((provider) => provider.id === LOCAL_PROVIDER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].api_key).toBe(ensureCommandEveShimAuthToken());
  }, 30_000);
});
