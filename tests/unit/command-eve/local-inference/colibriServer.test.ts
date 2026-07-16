import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertColibriEngineIntegrity,
  assertColibriMemoryAdmission,
  buildColibriServerArgs,
  cleanupColibriProcessFilesIfOwned,
  ColibriStartFence,
  normalizeColibriContextSize,
  parseMacMemoryPressureFreePercent,
  probeColibriServerAuthBoundary,
  reapStaleColibriProcess,
  terminateColibriProcess,
} from '@/process/commandEve/localInference/colibriServer';
import { COMMAND_EVE_COLIBRI_MODEL_ID, resolveColibriPaths } from '@/process/commandEve/localInference/colibriManifest';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Colibrì server contract', () => {
  it('binds only IPv4 loopback and keeps the API key out of process arguments', () => {
    const paths = resolveColibriPaths('/tmp/eve-user');
    const args = buildColibriServerArgs({ paths, port: 31999, contextSize: 65_536 });
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('31999');
    expect(args).toContain(COMMAND_EVE_COLIBRI_MODEL_ID);
    expect(args).toContain('--auto-tier');
    expect(args).not.toContain('--api-key');
  });

  it('clamps Colibrì to the qualified 64K local context', () => {
    expect(normalizeColibriContextSize(262_144)).toBe(65_536);
    expect(normalizeColibriContextSize(2_000)).toBe(4_096);
  });

  it('fails hardware admission below 48 GB or without free-memory headroom', () => {
    expect(() => assertColibriMemoryAdmission({ totalBytes: 32 * 1024 ** 3, freePercent: 80 })).toThrow(/48 GB/);
    expect(() => assertColibriMemoryAdmission({ totalBytes: 128 * 1024 ** 3, freePercent: 10 })).toThrow(/free/);
    expect(() => assertColibriMemoryAdmission({ totalBytes: 128 * 1024 ** 3, freePercent: 50 })).not.toThrow();
  });

  it('uses the macOS memory-pressure availability percentage instead of raw free pages', () => {
    expect(
      parseMacMemoryPressureFreePercent('The system has 137438953472 bytes.\nSystem-wide memory free percentage: 24%\n')
    ).toBe(24);
    expect(parseMacMemoryPressureFreePercent('System-wide memory free percentage: 101%')).toBeUndefined();
    expect(parseMacMemoryPressureFreePercent('unavailable')).toBeUndefined();
  });

  it('invalidates a pending start generation before another local model can take over', () => {
    const fence = new ColibriStartFence();
    const pending = fence.capture();
    fence.assertCurrent(pending);
    fence.cancel();
    expect(() => fence.assertCurrent(pending)).toThrow(/cancelled/i);
    expect(() => fence.assertCurrent(fence.capture())).not.toThrow();
  });

  it('reaps a matching detached Colibrì process before removing its private bootstrap files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-colibri-reap-'));
    roots.push(root);
    const paths = resolveColibriPaths(root);
    fs.mkdirSync(path.dirname(paths.processReceiptPath), { recursive: true });
    fs.writeFileSync(paths.processReceiptPath, JSON.stringify({ pid: 4242 }));
    fs.writeFileSync(paths.apiKeyPath, 'temporary-key\n');
    vi.spyOn(childProcess, 'spawnSync')
      .mockReturnValueOnce({ status: 0, stdout: `${paths.cliPath} serve --model ${paths.modelDir}\n` } as never)
      .mockReturnValue({ status: 1, stdout: '' } as never);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await reapStaleColibriProcess(paths);

    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(fs.existsSync(paths.processReceiptPath)).toBe(false);
    expect(fs.existsSync(paths.apiKeyPath)).toBe(false);
  });

  it('never lets an old process exit delete a replacement generation receipt or key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-colibri-owner-'));
    roots.push(root);
    const paths = resolveColibriPaths(root);
    fs.mkdirSync(path.dirname(paths.processReceiptPath), { recursive: true });
    fs.writeFileSync(paths.processReceiptPath, JSON.stringify({ pid: 5252 }));
    fs.writeFileSync(paths.apiKeyPath, 'replacement-key\n');

    expect(cleanupColibriProcessFilesIfOwned(paths, 4242)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.processReceiptPath, 'utf8'))).toMatchObject({ pid: 5252 });
    expect(fs.readFileSync(paths.apiKeyPath, 'utf8')).toBe('replacement-key\n');
    expect(cleanupColibriProcessFilesIfOwned(paths, 5252)).toBe(true);
    expect(fs.existsSync(paths.processReceiptPath)).toBe(false);
    expect(fs.existsSync(paths.apiKeyPath)).toBe(false);
  });

  it('re-hashes the compiled engine immediately before every server start', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-colibri-engine-'));
    roots.push(root);
    const paths = resolveColibriPaths(root);
    fs.mkdirSync(path.dirname(paths.enginePath), { recursive: true });
    fs.writeFileSync(paths.enginePath, 'verified-engine');
    const digest = crypto.createHash('sha256').update('verified-engine').digest('hex');

    await expect(assertColibriEngineIntegrity(paths, digest)).resolves.toBeUndefined();
    await expect(assertColibriEngineIntegrity(paths, 'f'.repeat(64))).rejects.toThrow(/no longer matches/i);
  });

  it('requires the loopback server to reject requests without its API key', async () => {
    const protectedFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(
      probeColibriServerAuthBoundary({
        baseUrl: 'http://127.0.0.1:31999',
        apiKey: 'private-key',
        fetchImpl: protectedFetch as typeof fetch,
      })
    ).resolves.toBe(true);
    expect(protectedFetch).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:31999/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer private-key' } })
    );
    expect(protectedFetch).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:31999/v1/models',
      expect.not.objectContaining({ headers: expect.anything() })
    );

    const openFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await expect(
      probeColibriServerAuthBoundary({
        baseUrl: 'http://127.0.0.1:31999',
        apiKey: 'private-key',
        fetchImpl: openFetch as typeof fetch,
      })
    ).rejects.toThrow(/without its private API key/i);
  });

  it('escalates a SIGTERM-ignoring process and confirms exit before cleanup can continue', async () => {
    vi.spyOn(childProcess, 'spawnSync')
      .mockReturnValueOnce({ status: 0, stdout: 'still-running' } as never)
      .mockReturnValueOnce({ status: 1, stdout: '' } as never);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await terminateColibriProcess(4343, 0, 0);

    expect(kill).toHaveBeenNthCalledWith(1, -4343, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, -4343, 'SIGKILL');
  });
});
