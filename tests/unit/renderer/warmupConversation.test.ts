import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONVERSATION_WARMUP_RETRY_COOLDOWN_MS,
  MAX_ACTIVE_CONVERSATION_RUNTIMES,
  resetWarmupConversationStateForTests,
  warmupConversation,
} from '@/renderer/pages/conversation/utils/warmupConversation';

const { activeCountInvokeMock, warmupInvokeMock } = vi.hoisted(() => ({
  activeCountInvokeMock: vi.fn(),
  warmupInvokeMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      activeCount: {
        invoke: activeCountInvokeMock,
      },
      warmup: {
        invoke: warmupInvokeMock,
      },
    },
  },
}));

describe('warmupConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWarmupConversationStateForTests();
    activeCountInvokeMock.mockResolvedValue({ count: 0 });
  });

  it('coalesces concurrent warmups for the same conversation', async () => {
    let resolveWarmup: (() => void) | undefined;
    warmupInvokeMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWarmup = resolve;
      })
    );

    const first = warmupConversation('conv-1');
    const second = warmupConversation('conv-1');

    await vi.waitFor(() => expect(warmupInvokeMock).toHaveBeenCalledTimes(1));
    expect(warmupInvokeMock).toHaveBeenCalledTimes(1);
    expect(warmupInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1' });

    resolveWarmup?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('retries after a failed warmup', async () => {
    warmupInvokeMock.mockRejectedValueOnce(new Error('warmup failed')).mockResolvedValueOnce(undefined);

    await expect(warmupConversation('conv-1')).rejects.toThrow('warmup failed');
    await expect(warmupConversation('conv-1')).resolves.toBeUndefined();

    expect(warmupInvokeMock).toHaveBeenCalledTimes(2);
  });

  it('skips repeated warmup after a conversation is already ready', async () => {
    warmupInvokeMock.mockResolvedValue(undefined);

    await expect(warmupConversation('conv-1')).resolves.toBeUndefined();
    await expect(warmupConversation('conv-1')).resolves.toBeUndefined();

    expect(warmupInvokeMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates an explicitly grounded send even after cached readiness', async () => {
    warmupInvokeMock.mockResolvedValue(undefined);

    await expect(warmupConversation('conv-1')).resolves.toBeUndefined();
    activeCountInvokeMock.mockResolvedValue({ count: MAX_ACTIVE_CONVERSATION_RUNTIMES });
    await expect(warmupConversation('conv-1', { revalidate: true })).resolves.toBeUndefined();

    expect(warmupInvokeMock).toHaveBeenCalledTimes(2);
  });

  it('serializes warmups for different conversations', async () => {
    const resolvers: Array<() => void> = [];
    warmupInvokeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const first = warmupConversation('conv-1');
    const second = warmupConversation('conv-2');

    await vi.waitFor(() => expect(warmupInvokeMock).toHaveBeenCalledTimes(1));
    expect(warmupInvokeMock).toHaveBeenNthCalledWith(1, { conversation_id: 'conv-1' });

    resolvers[0]?.();
    await first;
    await vi.waitFor(() => expect(warmupInvokeMock).toHaveBeenCalledTimes(2));
    expect(warmupInvokeMock).toHaveBeenNthCalledWith(2, { conversation_id: 'conv-2' });

    resolvers[1]?.();
    await second;
  });

  it('fails closed before materializing a sixth active runtime', async () => {
    activeCountInvokeMock.mockResolvedValue({ count: MAX_ACTIVE_CONVERSATION_RUNTIMES });

    await expect(warmupConversation('conv-cap')).rejects.toMatchObject({
      code: 'WARMUP_ACTIVE_RUNTIME_CAP',
    });
    expect(warmupInvokeMock).not.toHaveBeenCalled();
  });

  it('applies a cooldown after three failed materializations', async () => {
    vi.useFakeTimers();
    warmupInvokeMock.mockRejectedValue(new Error('spawn failed'));

    await expect(warmupConversation('conv-fail')).rejects.toThrow('spawn failed');
    await expect(warmupConversation('conv-fail')).rejects.toThrow('spawn failed');
    await expect(warmupConversation('conv-fail')).rejects.toThrow('spawn failed');
    await expect(warmupConversation('conv-fail')).rejects.toMatchObject({ code: 'WARMUP_RETRY_COOLDOWN' });
    expect(warmupInvokeMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(CONVERSATION_WARMUP_RETRY_COOLDOWN_MS);
    warmupInvokeMock.mockResolvedValueOnce(undefined);
    await expect(warmupConversation('conv-fail')).resolves.toBeUndefined();
    expect(warmupInvokeMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
