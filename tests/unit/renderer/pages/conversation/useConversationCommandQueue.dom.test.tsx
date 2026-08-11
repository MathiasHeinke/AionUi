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

  it('preserves private agent sidecars separately from user-visible files', async () => {
    const onExecute = vi.fn().mockResolvedValue(undefined);
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
    expect(JSON.parse(window.sessionStorage.getItem('conversation-command-queue/pdf-sidecar-queue') ?? '{}')).toEqual(
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

  it('hides generated PDF sidecars when restoring a queue written before display files existed', () => {
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
    ).toEqual({
      items: [
        {
          id: 'legacy-pdf',
          input: 'Analyze this PDF',
          files: ['/tmp/report.pdf', '/tmp/hermes/document-intelligence/pdf/abc123/document.md'],
          displayFiles: ['/tmp/report.pdf'],
          created_at: 1,
        },
      ],
      isPaused: true,
    });
  });
});
