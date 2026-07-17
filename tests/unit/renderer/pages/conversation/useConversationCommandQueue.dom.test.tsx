/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import React, { type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationCommandQueue } from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';

const { messageWarningMock } = vi.hoisted(() => ({
  messageWarningMock: vi.fn(),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    warning: messageWarningMock,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('@/renderer/utils/emitter', () => ({
  useAddEventListener: vi.fn(),
}));

const Wrapper = ({ children }: PropsWithChildren) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

describe('useConversationCommandQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('continues after a fast turn resolves without exposing a busy render', async () => {
    const onExecute = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () =>
        useConversationCommandQueue({
          conversation_id: 'fast-turn-queue',
          isBusy: false,
          runtimeGate: {
            hydrated: true,
            canSendMessage: true,
            isProcessing: false,
          },
          onExecute,
        }),
      { wrapper: Wrapper }
    );

    act(() => {
      result.current.enqueue({ input: 'first', files: [] });
      result.current.enqueue({ input: 'second', files: [] });
    });

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls.map(([item]) => item.input)).toEqual(['first', 'second']);
    await waitFor(() => expect(result.current.items).toEqual([]));
  });

  it('restores and pauses a command whose execution rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onExecute = vi.fn().mockRejectedValue(new Error('send rejected'));
    const { result } = renderHook(
      () =>
        useConversationCommandQueue({
          conversation_id: 'rejected-turn-queue',
          isBusy: false,
          runtimeGate: {
            hydrated: true,
            canSendMessage: true,
            isProcessing: false,
          },
          onExecute,
        }),
      { wrapper: Wrapper }
    );

    act(() => {
      result.current.enqueue({ input: 'retry me', files: ['/tmp/context.txt'] });
    });

    await waitFor(() => expect(result.current.isPaused).toBe(true));
    expect(result.current.items).toEqual([expect.objectContaining({ input: 'retry me', files: ['/tmp/context.txt'] })]);
    expect(messageWarningMock).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });
});
