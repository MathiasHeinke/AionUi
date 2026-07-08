/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyAcpStreamWatchdog, useAcpMessage } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';

const {
  addOrUpdateMessageMock,
  responseStreamOnMock,
  responseStreamHandlerRef,
  conversationGetInvokeMock,
  reportInferenceErrorMock,
} = vi.hoisted(() => ({
  addOrUpdateMessageMock: vi.fn(),
  responseStreamOnMock: vi.fn(),
  responseStreamHandlerRef: {
    current: undefined as ((message: IResponseMessage) => void) | undefined,
  },
  conversationGetInvokeMock: vi.fn(),
  // Default: NO quota/cap signal recognized → the error path renders the cold bubble
  // exactly as before. Tests flip this to true to exercise the suppression (M-quotawall).
  reportInferenceErrorMock: vi.fn((): boolean => false),
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useAddOrUpdateMessage: () => addOrUpdateMessageMock,
}));

vi.mock('@renderer/hooks/useQuotaWall', () => ({
  useQuotaWall: () => ({
    body: null,
    jobInFlight: false,
    dailyCapReached: false,
    autoReload: false,
    reportInferenceError: reportInferenceErrorMock,
    closeWall: vi.fn(),
    setAutoReload: vi.fn(),
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      responseStream: {
        on: responseStreamOnMock.mockImplementation((handler: (message: IResponseMessage) => void) => {
          responseStreamHandlerRef.current = handler;
          return vi.fn();
        }),
      },
    },
    conversation: {
      get: {
        invoke: conversationGetInvokeMock,
      },
      warmup: {
        invoke: vi.fn().mockResolvedValue(undefined),
      },
      getSlashCommands: {
        invoke: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));

describe('useAcpMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseStreamHandlerRef.current = undefined;
    reportInferenceErrorMock.mockReturnValue(false);
  });

  describe('ACP stream watchdog', () => {
    it('classifies stale buffered renderer work as ui_backlog', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_900,
          lastRendererCommitAt: 1_000,
          pendingBufferedEvents: 1,
        })
      ).toBe('ui_backlog');
    });

    it('does not classify a first buffered event as backlog before a baseline exists', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_900,
          pendingBufferedEvents: 1,
        })
      ).toBe('streaming');
    });

    it('uses the newer pending-buffer baseline instead of an old renderer commit', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_900,
          lastRendererCommitAt: 1_000,
          pendingBufferedSinceAt: 9_900,
          pendingBufferedEvents: 1,
        })
      ).toBe('streaming');
    });

    it('classifies active tools before heartbeat-only streams', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 1_000,
          lastRendererCommitAt: 1_000,
          pendingBufferedEvents: 0,
          activeToolName: 'Write file',
        })
      ).toBe('tool_wait');
    });

    it('distinguishes recent backend activity from heartbeat-only silence', () => {
      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 9_000,
          lastRendererCommitAt: 8_500,
          pendingBufferedEvents: 0,
        })
      ).toBe('streaming');

      expect(
        classifyAcpStreamWatchdog({
          now: 10_000,
          lastBackendEventAt: 4_000,
          lastRendererCommitAt: 4_000,
          pendingBufferedEvents: 0,
        })
      ).toBe('heartbeat_only');
    });

    it('surfaces heartbeat-only activity while a turn is still running', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAcpMessage('conv-1'));

        await act(async () => {
          await Promise.resolve();
        });

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'start',
            data: null,
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
        });

        act(() => {
          vi.advanceTimersByTime(6_000);
        });

        expect(result.current.runtimeActivity.phase).toBe('heartbeat_only');
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers from heartbeat-only to streaming when backend thinking resumes', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAcpMessage('conv-1'));

        await act(async () => {
          await Promise.resolve();
        });

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'start',
            data: null,
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
          vi.advanceTimersByTime(6_000);
        });
        expect(result.current.runtimeActivity.phase).toBe('heartbeat_only');

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: 'still working',
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
          vi.advanceTimersByTime(1_000);
        });

        expect(result.current.runtimeActivity.phase).toBe('streaming');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not overwrite a specific thinking phase with generic streaming ticks', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() => useAcpMessage('conv-1'));

        await act(async () => {
          await Promise.resolve();
        });

        act(() => {
          responseStreamHandlerRef.current?.({
            type: 'request_trace',
            data: {
              timestamp: Date.now(),
              backend: 'hermes',
              model_id: 'model-1',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: 'planning',
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
          });
        });

        expect(result.current.runtimeActivity.phase).toBe('thinking');

        act(() => {
          vi.advanceTimersByTime(1_000);
        });

        expect(result.current.runtimeActivity.phase).toBe('thinking');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps tool_wait active until all concurrent ACP tools finish', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      const { result } = renderHook(() => useAcpMessage('conv-1'));

      await act(async () => {
        await Promise.resolve();
      });

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-a',
              status: 'in_progress',
              title: 'Tool A',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            update: {
              sessionUpdate: 'tool_call',
              tool_call_id: 'tool-b',
              status: 'in_progress',
              title: 'Tool B',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
      });

      expect(result.current.runtimeActivity.phase).toBe('tool_wait');
      expect(result.current.runtimeActivity.detail).toBe('Tool A');

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-a',
              status: 'completed',
              title: 'Tool A',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
      });

      expect(result.current.runtimeActivity.phase).toBe('tool_wait');
      expect(result.current.runtimeActivity.detail).toBe('Tool B');

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'acp_tool_call',
          data: {
            update: {
              session_update: 'tool_call_update',
              tool_call_id: 'tool-b',
              status: 'completed',
              title: 'Tool B',
              kind: 'execute',
            },
          },
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
        });
      });

      expect(result.current.runtimeActivity.phase).toBe('streaming');
      expect(result.current.runtimeActivity.detail).toBeUndefined();
    });
  });

  it('completes hydration when the conversation lookup fails', async () => {
    conversationGetInvokeMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    expect(result.current.running).toBe(false);
    expect(result.current.aiProcessing).toBe(false);
  });

  it('emits a synthetic thinking done update on finish when the stream never sends one', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const now = Date.now();
    renderHook(() => useAcpMessage('conv-1'));

    expect(responseStreamHandlerRef.current).toBeTypeOf('function');

    responseStreamHandlerRef.current?.({
      type: 'request_trace',
      data: {
        timestamp: now - 4200,
        backend: 'claude',
        model_id: 'model-1',
      },
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
    });

    responseStreamHandlerRef.current?.({
      type: 'thinking',
      data: {
        content: 'alpha',
        status: 'thinking',
      },
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
    });

    responseStreamHandlerRef.current?.({
      type: 'finish',
      data: null,
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
    });

    expect(addOrUpdateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'thinking',
        msg_id: 'msg-1',
        conversation_id: 'conv-1',
        content: expect.objectContaining({
          status: 'done',
          duration: expect.any(Number),
        }),
      })
    );
  });

  it('completes thinking as soon as the first non-thinking message arrives', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    renderHook(() => useAcpMessage('conv-1'));

    responseStreamHandlerRef.current?.({
      type: 'thinking',
      data: {
        content: 'alpha',
        status: 'thinking',
      },
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
      created_at: 1_000,
    });

    responseStreamHandlerRef.current?.({
      type: 'text',
      data: 'beta',
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
      created_at: 4_200,
    });

    expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'thinking',
        msg_id: 'msg-1',
        content: expect.objectContaining({
          status: 'thinking',
        }),
      })
    );
    expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'thinking',
        msg_id: 'msg-1',
        content: expect.objectContaining({
          status: 'done',
          duration: 3200,
        }),
      })
    );
    expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        type: 'text',
        msg_id: 'msg-1',
      })
    );
  });

  it('throttles active thinking stream updates so inference start cannot flood the transcript', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 20; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }
      });

      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(49);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(2);
      expect(addOrUpdateMessageMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-0 ',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: Array.from({ length: 19 }, (_, index) => `chunk-${index + 1} `).join(''),
          }),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending thinking before the synthetic done update when final content arrives', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 3; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }
      });

      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'text',
          data: 'final',
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
          created_at: 2_000,
        });
      });

      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-1 chunk-2 ',
            status: 'thinking',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            status: 'done',
            duration: 1000,
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          type: 'text',
          msg_id: 'msg-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending thinking before an error message', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 3; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }
      });

      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);

      act(() => {
        responseStreamHandlerRef.current?.({
          type: 'error',
          data: 'boom',
          msg_id: 'msg-1',
          conversation_id: 'conv-1',
          created_at: 2_000,
        });
      });

      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-1 chunk-2 ',
            status: 'thinking',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            status: 'done',
            duration: 1000,
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          type: 'tips',
          msg_id: 'msg-1',
        })
      );

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending thinking before starting a new thinking message id', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    await waitFor(() => {
      expect(result.current.hasHydratedRunningState).toBe(true);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        for (let i = 0; i < 3; i += 1) {
          responseStreamHandlerRef.current?.({
            type: 'thinking',
            data: {
              content: `chunk-${i} `,
              status: 'thinking',
            },
            msg_id: 'msg-1',
            conversation_id: 'conv-1',
            created_at: 1_000 + i,
          });
        }

        responseStreamHandlerRef.current?.({
          type: 'thinking',
          data: {
            content: 'next-0 ',
            status: 'thinking',
          },
          msg_id: 'msg-2',
          conversation_id: 'conv-1',
          created_at: 2_000,
        });
      });

      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-0 ',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-1',
          content: expect.objectContaining({
            content: 'chunk-1 chunk-2 ',
          }),
        })
      );
      expect(addOrUpdateMessageMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          type: 'thinking',
          msg_id: 'msg-2',
          content: expect.objectContaining({
            content: 'next-0 ',
          }),
        })
      );

      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves slash-command metadata from available_commands stream updates', async () => {
    conversationGetInvokeMock.mockResolvedValue(null);

    const { result } = renderHook(() => useAcpMessage('conv-1'));

    act(() => {
      responseStreamHandlerRef.current?.({
        type: 'available_commands',
        data: {
          commands: [
            {
              name: 'review',
              description: 'Review the current diff',
              input: {
                hint: '⌘R',
              },
              _meta: {
                completion_behavior: 'neutral_tip_on_empty',
                empty_turn_tip_code: 'acp.empty_turn.choose_command',
                empty_turn_tip_params: {
                  command_count: 1,
                },
              },
            },
          ],
        },
        msg_id: 'cmd-1',
        conversation_id: 'conv-1',
      });
    });

    await waitFor(() => {
      expect(result.current.slashCommands).toEqual([
        {
          name: 'review',
          description: 'Review the current diff',
          hint: '⌘R',
          kind: 'template',
          source: 'acp',
          selectionBehavior: 'insert',
          completionBehavior: 'neutral_tip_on_empty',
          emptyTurnTipCode: 'acp.empty_turn.choose_command',
          emptyTurnTipParams: {
            command_count: 1,
          },
        },
      ]);
    });
  });

  describe('M-quotawall-suppress — the cold error bubble yields to a recognized warm wall', () => {
    const emitError = (): void => {
      // A turn must be in-flight so the wall would actually surface (both walls
      // idle-suppress on jobInFlight). A non-terminal message before the error sets
      // running=true → jobWasInFlight=true.
      responseStreamHandlerRef.current?.({ type: 'text', data: 'partial', msg_id: 'm-1', conversation_id: 'conv-1' });
      responseStreamHandlerRef.current?.({
        type: 'error',
        data: { code: 'eve_daily_cap' },
        msg_id: 'm-1',
        conversation_id: 'conv-1',
      });
    };

    it('suppresses the cold error message when a quota/cap signal is recognized AND a turn was in-flight', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      reportInferenceErrorMock.mockReturnValue(true); // wall takes over
      renderHook(() => useAcpMessage('conv-1'));
      expect(responseStreamHandlerRef.current).toBeTypeOf('function');

      act(() => emitError());

      expect(reportInferenceErrorMock).toHaveBeenCalledWith({ code: 'eve_daily_cap' }, { jobInFlight: true });
      // Only the in-flight 'text' message reached the transcript; the error did NOT add
      // a second (cold) bubble — the warm wall owns the surface.
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(1);
    });

    it('STILL renders the cold error bubble when NO quota/cap signal is recognized (never swallow a real error)', async () => {
      conversationGetInvokeMock.mockResolvedValue(null);
      reportInferenceErrorMock.mockReturnValue(false); // ordinary error
      renderHook(() => useAcpMessage('conv-1'));

      act(() => emitError());

      // Both the 'text' message AND the error bubble reached the transcript.
      expect(addOrUpdateMessageMock).toHaveBeenCalledTimes(2);
    });
  });
});
