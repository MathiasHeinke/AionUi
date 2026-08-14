import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seedCreateInvoke = vi.hoisted(() => vi.fn());

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: { seedCreate: { invoke: seedCreateInvoke } },
}));

import { resetSeedLifecycleAttemptsForTests, useSeedLifecycle } from '@/renderer/hooks/useSeedLifecycle';

afterEach(() => {
  resetSeedLifecycleAttemptsForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

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
          seed_limit: 1000,
        },
      });
      await first;
    });
    expect(result.current.provisioning).toBe(false);
  });

  it('reuses the idempotency key when reconciling after a timeout', async () => {
    seedCreateInvoke
      .mockResolvedValueOnce({ data: { ok: false, seed_limit: 1000, reason_code: 'SEED_PROVISION_TIMEOUT' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          seed_id: '22222222-2222-4222-8222-222222222222',
          created: false,
          seed_count: 2,
          seed_limit: 1000,
        },
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          seed_id: '33333333-3333-4333-8333-333333333333',
          created: true,
          seed_count: 3,
          seed_limit: 1000,
        },
      });
    const { result } = renderHook(() => useSeedLifecycle());

    await act(async () => {
      expect((await result.current.createSeed('Seed A')).reasonCode).toBe('SEED_PROVISION_TIMEOUT');
    });
    expect(result.current.retryPending).toBe(true);
    let reconciled!: Awaited<ReturnType<typeof result.current.createSeed>>;
    await act(async () => {
      reconciled = await result.current.createSeed('Seed A');
    });
    expect(reconciled).toMatchObject({ ok: true, created: false });

    const firstId = seedCreateInvoke.mock.calls[0]?.[0]?.clientRequestId;
    const retryId = seedCreateInvoke.mock.calls[1]?.[0]?.clientRequestId;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(retryId).toBe(firstId);
    expect(result.current.retryPending).toBe(false);

    await act(async () => {
      expect((await result.current.createSeed('Seed A')).created).toBe(true);
    });
    expect(seedCreateInvoke.mock.calls[2]?.[0]?.clientRequestId).not.toBe(firstId);
  });

  it('reuses a commit-uncertain network key after the original hook unmounts', async () => {
    seedCreateInvoke
      .mockResolvedValueOnce({ data: { ok: false, seed_limit: null, reason_code: 'SEED_NETWORK' } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          seed_id: '22222222-2222-4222-8222-222222222222',
          created: false,
          seed_count: 2,
          seed_limit: null,
        },
      });
    const firstHook = renderHook(() => useSeedLifecycle());
    await act(async () => {
      expect((await firstHook.result.current.createSeed('Malte')).reasonCode).toBe('SEED_NETWORK');
    });
    expect(firstHook.result.current.retryPending).toBe(true);
    firstHook.unmount();

    const secondHook = renderHook(() => useSeedLifecycle());
    await act(async () => {
      expect((await secondHook.result.current.createSeed('Malte')).ok).toBe(true);
    });

    expect(seedCreateInvoke.mock.calls[1]?.[0]?.clientRequestId).toBe(
      seedCreateInvoke.mock.calls[0]?.[0]?.clientRequestId
    );
  });

  it('shares one request key across create surfaces while distinct names stay independent', async () => {
    const releases: Array<(value: unknown) => void> = [];
    seedCreateInvoke.mockImplementation(
      () => new Promise((resolve) => releases.push(resolve as (value: unknown) => void))
    );
    const rail = renderHook(() => useSeedLifecycle());
    const account = renderHook(() => useSeedLifecycle());

    let railRequest!: ReturnType<typeof rail.result.current.createSeed>;
    let accountRequest!: ReturnType<typeof account.result.current.createSeed>;
    act(() => {
      railRequest = rail.result.current.createSeed('Malte');
      accountRequest = account.result.current.createSeed('Malte');
    });
    expect(seedCreateInvoke.mock.calls[0]?.[0]?.clientRequestId).toBe(
      seedCreateInvoke.mock.calls[1]?.[0]?.clientRequestId
    );
    releases.forEach((release) =>
      release({ data: { ok: true, seed_id: '22222222-2222-4222-8222-222222222222', seed_limit: null } })
    );
    await act(async () => {
      await Promise.all([railRequest, accountRequest]);
    });

    seedCreateInvoke.mockResolvedValue({
      data: { ok: true, seed_id: '33333333-3333-4333-8333-333333333333', seed_limit: null },
    });
    await act(async () => {
      await rail.result.current.createSeed('Kunde A');
      await account.result.current.createSeed('Kunde B');
    });
    expect(seedCreateInvoke.mock.calls[2]?.[0]?.clientRequestId).not.toBe(
      seedCreateInvoke.mock.calls[3]?.[0]?.clientRequestId
    );
  });

  it('fails closed instead of emitting a constant UUID when Web Crypto is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    const { result } = renderHook(() => useSeedLifecycle());
    await act(async () => {
      expect(await result.current.createSeed('Malte')).toMatchObject({
        ok: false,
        reasonCode: 'SEED_REQUEST_ID_UNAVAILABLE',
      });
    });
    expect(seedCreateInvoke).not.toHaveBeenCalled();
  });
});
