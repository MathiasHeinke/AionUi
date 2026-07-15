import { describe, expect, it, vi } from 'vitest';

import {
  assertBonsaiMemoryAdmission,
  assertBonsaiMemoryAfterStart,
  buildBonsaiServerArgs,
  normalizeBonsaiContextSize,
  waitForBonsaiMemoryAdmission,
  type BonsaiMemorySnapshot,
} from '@/process/commandEve/localInference/bonsaiServer';
import {
  COMMAND_EVE_BONSAI_ACP_MODEL_ID,
  COMMAND_EVE_BONSAI_MODEL_ID,
  isBonsaiModelRequest,
  resolveBonsaiPilotPaths,
} from '@/process/commandEve/localInference/bonsaiManifest';

const GIB = 1024 ** 3;

function memory(overrides: Partial<BonsaiMemorySnapshot> = {}): BonsaiMemorySnapshot {
  return {
    totalBytes: 24 * GIB,
    freePercent: 35,
    pageouts: 1_000,
    pageSizeBytes: 16_384,
    ...overrides,
  };
}

describe('Bonsai server launch contract', () => {
  it('binds an authenticated single-slot server to OS-assigned IPv4 loopback', () => {
    const paths = resolveBonsaiPilotPaths('/tmp/Command EVE');
    const args = buildBonsaiServerArgs({ paths, contextSize: 65_536 });
    expect(args).toEqual(
      expect.arrayContaining([
        '--alias',
        COMMAND_EVE_BONSAI_MODEL_ID,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--parallel',
        '1',
        '--cache-type-k',
        'q4_0',
        '--cache-type-v',
        'q4_0',
        '--api-key-file',
        paths.apiKeyPath,
        '--reasoning-budget',
        '-1',
        '--reasoning-format',
        'deepseek',
        '--no-ui',
      ])
    );
    expect(args).not.toContain('0.0.0.0');
    expect(args).not.toContain('--tools');
  });

  it('defaults to the Hermes-compatible 64K context and clamps unsafe requests', () => {
    expect(normalizeBonsaiContextSize()).toBe(65_536);
    expect(normalizeBonsaiContextSize(Number.NaN)).toBe(65_536);
    expect(normalizeBonsaiContextSize(2_048)).toBe(4_096);
    expect(normalizeBonsaiContextSize(262_144)).toBe(65_536);
  });

  it('activates only for the explicit Bonsai runtime or ACP model id', () => {
    expect(isBonsaiModelRequest(COMMAND_EVE_BONSAI_MODEL_ID)).toBe(true);
    expect(isBonsaiModelRequest(COMMAND_EVE_BONSAI_ACP_MODEL_ID)).toBe(true);
    expect(isBonsaiModelRequest('custom:command-eve-gemma4-e4b-64k:latest')).toBe(false);
    expect(isBonsaiModelRequest(undefined)).toBe(false);
  });

  it('fails admission below the total/free-memory floor', () => {
    expect(() => assertBonsaiMemoryAdmission(memory())).not.toThrow();
    expect(() => assertBonsaiMemoryAdmission(memory({ totalBytes: 16 * GIB }))).toThrow(/enough memory/);
    expect(() => assertBonsaiMemoryAdmission(memory({ totalBytes: 8 * GIB }))).toThrow(/enough memory/);
    expect(() => assertBonsaiMemoryAdmission(memory({ freePercent: 10 }))).toThrow(/Close other heavy apps/);
  });

  it('fails closed when startup causes severe pressure or more than 1 GiB of pageouts', () => {
    const before = memory();
    expect(() => assertBonsaiMemoryAfterStart(before, memory({ pageouts: 1_001 }))).not.toThrow();
    expect(() => assertBonsaiMemoryAfterStart(before, memory({ freePercent: 2 }))).toThrow(/safe memory budget/);
    expect(() =>
      assertBonsaiMemoryAfterStart(
        before,
        memory({ pageouts: before.pageouts + Math.ceil(GIB / before.pageSizeBytes) + 1 })
      )
    ).toThrow(/safe memory budget/);
  });

  it('waits for memory recovery without weakening the admission threshold', async () => {
    const snapshots = [memory({ freePercent: 8 }), memory({ freePercent: 14 }), memory({ freePercent: 24 })];
    const sleep = vi.fn(async (): Promise<void> => undefined);

    await expect(
      waitForBonsaiMemoryAdmission({
        readSnapshot: () => snapshots.shift() || memory({ freePercent: 24 }),
        sleep,
        timeoutMs: 5_000,
      })
    ).resolves.toMatchObject({ freePercent: 24 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
