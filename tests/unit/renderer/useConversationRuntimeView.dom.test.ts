/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import { emitter } from '@/renderer/utils/emitter';
import {
  resetConversationRuntimeRecoveryMonitorsForTest,
  useConversationRuntimeView,
} from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { resetConversationRuntimeViewStoreForTest } from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';

const { getConversationOrNullMock, turnCompletedHandlerRef } = vi.hoisted(() => ({
  getConversationOrNullMock: vi.fn(),
  turnCompletedHandlerRef: {
    current: undefined as
      | ((event: { session_id: string; turn_id: string; runtime: TConversationRuntimeSummary | null }) => void)
      | undefined,
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      writeRendererLog: { invoke: vi.fn().mockResolvedValue(undefined) },
    },
    conversation: {
      turnCompleted: {
        on: vi
          .fn()
          .mockImplementation(
            (
              handler: (event: {
                session_id: string;
                turn_id: string;
                runtime: TConversationRuntimeSummary | null;
              }) => void
            ) => {
              turnCompletedHandlerRef.current = handler;
              return () => {
                if (turnCompletedHandlerRef.current === handler) turnCompletedHandlerRef.current = undefined;
              };
            }
          ),
      },
      listChanged: { on: vi.fn().mockReturnValue(() => {}) },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: getConversationOrNullMock,
}));

const runtime = (overrides: Partial<TConversationRuntimeSummary> = {}): TConversationRuntimeSummary => ({
  state: 'idle',
  can_send_message: true,
  has_task: false,
  task_status: 'finished',
  is_processing: false,
  pending_confirmations: 0,
  turn_id: null,
  ...overrides,
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('useConversationRuntimeView recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetConversationRuntimeRecoveryMonitorsForTest();
    resetConversationRuntimeViewStoreForTest();
    turnCompletedHandlerRef.current = undefined;
    getConversationOrNullMock.mockResolvedValue({ runtime: runtime() });
  });

  afterEach(() => {
    resetConversationRuntimeRecoveryMonitorsForTest();
    resetConversationRuntimeViewStoreForTest();
    vi.useRealTimers();
  });

  it('polls durable runtime state and releases a run whose terminal stream frame was missed', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.hydrated).toBe(true);

    const runningRuntime = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-1',
    });
    act(() => {
      result.current.markSendStarted();
      result.current.markSendAccepted('turn-1', runningRuntime, 'msg-1');
    });
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.canSendMessage).toBe(false);

    getConversationOrNullMock.mockResolvedValue({ runtime: runtime() });
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.isProcessing).toBe(false);
    expect(result.current.canSendMessage).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith('conversation.runtime.recovered', {
      conversation_id: 'conv-1',
      runtime: runtime(),
      recoveredTurnId: 'turn-1',
    });
    expect(emitSpy).toHaveBeenCalledWith('conversation.messages.refresh', {
      conversation_id: 'conv-1',
      expectedTerminalMessageId: 'msg-1',
    });
  });

  it('keeps recovery active when the terminal transport event has no runtime summary', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const runningRuntime = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-1',
    });
    act(() => {
      result.current.markSendStarted();
      result.current.markSendAccepted('turn-1', runningRuntime, 'msg-1');
      turnCompletedHandlerRef.current?.({ session_id: 'conv-1', turn_id: 'turn-1', runtime: null });
    });

    expect(result.current.isProcessing).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith('conversation.messages.refresh', { conversation_id: 'conv-1' });
    expect(emitSpy).not.toHaveBeenCalledWith(
      'conversation.runtime.recovered',
      expect.objectContaining({ conversation_id: 'conv-1' })
    );

    getConversationOrNullMock.mockResolvedValue({ runtime: runtime() });
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.isProcessing).toBe(false);
    expect(result.current.canSendMessage).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith('conversation.runtime.recovered', {
      conversation_id: 'conv-1',
      runtime: runtime(),
      recoveredTurnId: 'turn-1',
    });
  });

  it('does not let an older recovery poll release a newer accepted turn', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const runningTurnA = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-a',
    });
    act(() => {
      result.current.markSendStarted();
      result.current.markSendAccepted('turn-a', runningTurnA, 'msg-a');
    });

    const stalePoll = createDeferred<{ runtime: TConversationRuntimeSummary }>();
    getConversationOrNullMock.mockReturnValueOnce(stalePoll.promise);
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
    });

    const runningTurnB = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-b',
    });
    act(() => {
      result.current.markSendStarted();
      result.current.markSendAccepted('turn-b', runningTurnB, 'msg-b');
    });
    await act(async () => {
      stalePoll.resolve({ runtime: runtime() });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.activeTurnId).toBe('turn-b');
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.canSendMessage).toBe(false);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'conversation.runtime.recovered',
      expect.objectContaining({ conversation_id: 'conv-1' })
    );
  });

  it('does not let a delayed completion clear a new local submit before acceptance', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      result.current.markSendStarted();
      turnCompletedHandlerRef.current?.({
        session_id: 'conv-1',
        turn_id: 'turn-old',
        runtime: runtime(),
      });
    });

    expect(result.current.view.localSubmitting).toBe(true);
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.canSendMessage).toBe(false);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'conversation.runtime.recovered',
      expect.objectContaining({ conversation_id: 'conv-1' })
    );

    const newRuntime = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-new',
    });
    act(() => {
      result.current.markSendAccepted('turn-new', newRuntime, 'msg-new');
    });

    expect(result.current.view.localSubmitting).toBe(false);
    expect(result.current.activeTurnId).toBe('turn-new');
    expect(result.current.isProcessing).toBe(true);
  });

  it('keeps polling when a turn-completed event still reports processing', async () => {
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const stillRunning = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-1',
    });
    act(() => {
      result.current.markSendStarted();
      result.current.markSendAccepted('turn-1', stillRunning, 'msg-1');
      turnCompletedHandlerRef.current?.({ session_id: 'conv-1', turn_id: 'turn-1', runtime: stillRunning });
    });

    expect(result.current.activeTurnId).toBe('turn-1');
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.canSendMessage).toBe(false);

    getConversationOrNullMock.mockResolvedValue({ runtime: runtime() });
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.isProcessing).toBe(false);
    expect(result.current.canSendMessage).toBe(true);
  });

  it('shares one backend event subscription across hook consumers for the same conversation', async () => {
    const first = renderHook(() => useConversationRuntimeView('conv-1'));
    const second = renderHook(() => useConversationRuntimeView('conv-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ipcBridge.conversation.turnCompleted.on).toHaveBeenCalledTimes(1);
    expect(ipcBridge.conversation.listChanged.on).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(turnCompletedHandlerRef.current).toBeTypeOf('function');

    second.unmount();
    expect(turnCompletedHandlerRef.current).toBeUndefined();
  });

  it('stops durable recovery polling after the last runtime hook unmounts', async () => {
    const { result, unmount } = renderHook(() => useConversationRuntimeView('conv-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const runningRuntime = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-1',
    });
    act(() => {
      result.current.markSendStarted();
      result.current.markSendAccepted('turn-1', runningRuntime, 'msg-1');
    });
    expect(getConversationOrNullMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    expect(getConversationOrNullMock).toHaveBeenCalledTimes(1);
  });
});
