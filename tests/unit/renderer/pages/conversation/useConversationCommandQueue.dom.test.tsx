/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import React, { type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeQueueState,
  useConversationCommandQueue,
} from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';

const { messageWarningMock, seatState, seatRebindListeners } = vi.hoisted(() => ({
  messageWarningMock: vi.fn(),
  seatState: { current: 'seat-1', epoch: 0 },
  seatRebindListeners: new Set<(seatId: string) => void>(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    getCurrentSeatId: () => seatState.current,
    getSeatBindingSnapshot: () => ({ seatId: seatState.current, rebindEpoch: seatState.epoch, initialized: true }),
    onSeatRebind: (listener: (seatId: string) => void) => {
      seatRebindListeners.add(listener);
      return () => seatRebindListeners.delete(listener);
    },
  },
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('useConversationCommandQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seatState.current = 'seat-1';
    seatState.epoch = 0;
    seatRebindListeners.clear();
    window.sessionStorage.clear();
  });

  it('continues after a fast turn resolves without exposing a busy render', async () => {
    const onExecute = vi.fn().mockResolvedValue('accepted' as const);
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

  it('preserves private agent sidecars separately from user-visible files', async () => {
    const onExecute = vi.fn().mockResolvedValue('accepted' as const);
    const attachmentGrounding = {
      version: 'command-eve-attachment-grounding/v1' as const,
      entries: [
        {
          kind: 'pdf' as const,
          source_path: '/tmp/report.pdf',
          source_sha256: 'a'.repeat(64),
          source_bytes: 512,
          grounding_path: '/tmp/document-intelligence/report.md',
          grounding_sha256: 'b'.repeat(64),
          grounding_bytes: 128,
        },
      ],
    };
    const { result } = renderHook(
      () =>
        useConversationCommandQueue({
          conversation_id: 'pdf-sidecar-queue',
          isBusy: true,
          runtimeGate: {
            hydrated: true,
            canSendMessage: false,
            isProcessing: true,
          },
          onExecute,
        }),
      { wrapper: Wrapper }
    );

    act(() => {
      result.current.enqueue({
        input: 'Analyze this PDF',
        files: ['/tmp/report.pdf', '/tmp/document-intelligence/report.md'],
        displayFiles: ['/tmp/report.pdf'],
        preparedContext: 'Prepared private evidence',
        attachmentGrounding,
      });
    });

    await waitFor(() =>
      expect(result.current.items).toEqual([
        expect.objectContaining({
          files: ['/tmp/report.pdf', '/tmp/document-intelligence/report.md'],
          displayFiles: ['/tmp/report.pdf'],
          preparedContext: 'Prepared private evidence',
          attachmentGrounding,
        }),
      ])
    );
    expect(
      JSON.parse(window.sessionStorage.getItem('conversation-command-queue/seat-1/pdf-sidecar-queue') ?? '{}')
    ).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            files: ['/tmp/report.pdf', '/tmp/document-intelligence/report.md'],
            displayFiles: ['/tmp/report.pdf'],
            preparedContext: 'Prepared private evidence',
            attachmentGrounding,
          }),
        ],
      })
    );
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('rejects a legacy unscoped queue item because its seat and conversation cannot be proven', () => {
    expect(
      normalizeQueueState({
        items: [
          {
            id: 'legacy-pdf',
            input: 'Analyze this PDF',
            files: ['/tmp/report.pdf', '/tmp/hermes/document-intelligence/pdf/abc123/document.md'],
            created_at: 1,
          },
        ],
        isPaused: true,
      })
    ).toEqual({ items: [], isPaused: false });
  });

  it('drops a seat-A completion after A-to-B rebind without restoring or pausing the seat-B queue', async () => {
    const deferred = createDeferred<'accepted' | 'rejected' | 'stale'>();
    const onExecute = vi.fn(() => deferred.promise);
    window.sessionStorage.setItem(
      'conversation-command-queue/seat-2/shared-conversation',
      JSON.stringify({
        items: [
          {
            id: 'seat-b-preserved',
            conversationId: 'shared-conversation',
            input: 'seat B preserved command',
            files: [],
            displayFiles: [],
            seatId: 'seat-2',
            created_at: 2,
          },
        ],
        isPaused: true,
      })
    );
    const { result } = renderHook(
      () =>
        useConversationCommandQueue({
          conversation_id: 'shared-conversation',
          isBusy: false,
          runtimeGate: { hydrated: true, canSendMessage: true, isProcessing: false },
          onExecute,
        }),
      { wrapper: Wrapper }
    );

    act(() => {
      result.current.enqueue({ input: 'seat A command', files: [] });
    });
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));

    act(() => {
      seatState.current = 'seat-2';
      seatState.epoch += 1;
      seatRebindListeners.forEach((listener) => listener('seat-2'));
    });
    deferred.resolve('stale');

    await act(async () => {
      await deferred.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.items.map(({ id }) => id)).toEqual(['seat-b-preserved']));
    expect(result.current.isPaused).toBe(true);
    expect(messageWarningMock).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.sessionStorage.getItem('conversation-command-queue/seat-2/shared-conversation') ?? '{}')
    ).toMatchObject({
      items: [expect.objectContaining({ id: 'seat-b-preserved', seatId: 'seat-2' })],
      isPaused: true,
    });
  });
});
