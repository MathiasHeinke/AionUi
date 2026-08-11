import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seedCreateInvoke = vi.hoisted(() => vi.fn());

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: { seedCreate: { invoke: seedCreateInvoke } },
}));

import { useSeedLifecycle } from '@/renderer/hooks/useSeedLifecycle';

afterEach(() => vi.clearAllMocks());

describe('useSeedLifecycle', () => {
  it('coalesces rapid renderer calls into one IPC request', async () => {
    let release!: (value: unknown) => void;
    seedCreateInvoke.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { result } = renderHook(() => useSeedLifecycle());

    let first!: ReturnType<typeof result.current.createSeed>;
    let second!: ReturnType<typeof result.current.createSeed>;
    act(() => {
      first = result.current.createSeed('Seed A');
      second = result.current.createSeed('Seed A');
    });

    expect(second).toBe(first);
    expect(seedCreateInvoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({
        data: {
          ok: true,
          seed_id: '22222222-2222-4222-8222-222222222222',
          created: true,
          seed_count: 2,
          seed_limit: 10,
        },
      });
      await first;
    });
    expect(result.current.provisioning).toBe(false);
  });

  it('reuses the idempotency key when reconciling after a timeout', async () => {
    seedCreateInvoke
      .mockResolvedValueOnce({ data: { ok: false, seed_limit: 10, reason_code: 'SEED_PROVISION_TIMEOUT' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          seed_id: '22222222-2222-4222-8222-222222222222',
          created: false,
          seed_count: 2,
          seed_limit: 10,
        },
      });
    const { result } = renderHook(() => useSeedLifecycle());

    await act(async () => {
      expect((await result.current.createSeed('Seed A')).reasonCode).toBe('SEED_PROVISION_TIMEOUT');
    });
    expect(result.current.retryPending).toBe(true);
    await act(async () => {
      expect((await result.current.createSeed('Seed A')).ok).toBe(true);
    });

    const firstId = seedCreateInvoke.mock.calls[0]?.[0]?.clientRequestId;
    const retryId = seedCreateInvoke.mock.calls[1]?.[0]?.clientRequestId;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(retryId).toBe(firstId);
    expect(result.current.retryPending).toBe(false);
  });
});
