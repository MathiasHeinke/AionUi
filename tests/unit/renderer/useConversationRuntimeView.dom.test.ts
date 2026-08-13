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

const { getConversationOrNullMock, turnCompletedHandlerRef, seatHarness } = vi.hoisted(() => ({
  getConversationOrNullMock: vi.fn(),
  seatHarness: { currentSeatId: 'seat-a', rebindEpoch: 0, initialized: true },
  turnCompletedHandlerRef: {
    current: undefined as
      | ((event: { session_id: string; turn_id: string; runtime: TConversationRuntimeSummary | null }) => void)
      | undefined,
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    getCurrentSeatId: () => seatHarness.currentSeatId,
    getSeatBindingSnapshot: () => ({
      seatId: seatHarness.currentSeatId,
      rebindEpoch: seatHarness.rebindEpoch,
      initialized: seatHarness.initialized,
    }),
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

const beginSend = (hook: { result: { current: ReturnType<typeof useConversationRuntimeView> } }) => {
  const ticket = hook.result.current.issueSendAttempt();
  expect(ticket).not.toBeNull();
  expect(hook.result.current.markSendStarted(ticket!)).toBe(true);
  return ticket!;
};

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
    seatHarness.currentSeatId = 'seat-a';
    seatHarness.rebindEpoch = 0;
    seatHarness.initialized = true;
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
      const ticket = beginSend({ result });
      result.current.markSendAccepted(ticket, 'turn-1', runningRuntime, 'msg-1');
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

  it('requests a silent transcript reconcile while the accepted turn is still running', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const runningRuntime = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-1',
    });
    getConversationOrNullMock.mockResolvedValue({ runtime: runningRuntime });
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      const ticket = beginSend({ result });
      result.current.markSendAccepted(ticket, 'turn-1', runningRuntime, 'msg-1');
    });

    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(emitSpy).toHaveBeenCalledWith('conversation.messages.reconcile', { conversation_id: 'conv-1' });
    expect(result.current.isProcessing).toBe(true);
  });

  it('does not reconcile while a local submission has not been accepted', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const runningRuntime = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-1',
    });
    getConversationOrNullMock.mockResolvedValue({ runtime: runningRuntime });
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => beginSend({ result }));

    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(emitSpy).not.toHaveBeenCalledWith('conversation.messages.reconcile', { conversation_id: 'conv-1' });
    expect(result.current.view.localSubmitting).toBe(true);
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
      const ticket = beginSend({ result });
      result.current.markSendAccepted(ticket, 'turn-1', runningRuntime, 'msg-1');
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
      const ticket = beginSend({ result });
      result.current.markSendAccepted(ticket, 'turn-a', runningTurnA, 'msg-a');
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
      const ticket = beginSend({ result });
      result.current.markSendAccepted(ticket, 'turn-b', runningTurnB, 'msg-b');
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

  it('drops a delayed same-id hydrate and recovery poll after the seat generation changes', async () => {
    const initialHydrate = createDeferred<{ runtime: TConversationRuntimeSummary }>();
    getConversationOrNullMock.mockReturnValueOnce(initialHydrate.promise);
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useConversationRuntimeView('conv-shared'));
    await act(async () => {
      await Promise.resolve();
    });

    seatHarness.currentSeatId = 'seat-b';
    seatHarness.rebindEpoch += 1;
    await act(async () => {
      initialHydrate.resolve({
        runtime: runtime({
          state: 'running',
          can_send_message: false,
          is_processing: true,
          turn_id: 'turn-seat-a',
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.activeTurnId).toBeNull();
    expect(result.current.isProcessing).toBe(false);

    act(() => {
      const ticket = beginSend({ result });
      result.current.markSendAccepted(
        ticket,
        'turn-seat-b',
        runtime({
          state: 'running',
          can_send_message: false,
          is_processing: true,
          turn_id: 'turn-seat-b',
        }),
        'msg-seat-b'
      );
    });
    const oldPoll = createDeferred<{ runtime: TConversationRuntimeSummary }>();
    getConversationOrNullMock.mockReturnValueOnce(oldPoll.promise);
    await act(async () => {
      vi.advanceTimersByTime(1_500);
      await Promise.resolve();
    });

    seatHarness.currentSeatId = 'seat-c';
    await act(async () => {
      oldPoll.resolve({ runtime: runtime() });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.activeTurnId).toBeNull();
    expect(result.current.isProcessing).toBe(false);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'conversation.runtime.recovered',
      expect.objectContaining({ conversation_id: 'conv-shared' })
    );
  });

  it('rejects stale local-send callbacks without emitting new-seat runtime side effects', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useConversationRuntimeView('conv-shared'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const oldTicket = result.current.issueSendAttempt();
    expect(oldTicket).not.toBeNull();

    seatHarness.currentSeatId = 'seat-b';
    seatHarness.rebindEpoch += 1;
    emitSpy.mockClear();
    expect(result.current.markSendStarted(oldTicket!)).toBe(false);
    expect(
      result.current.markSendAccepted(
        oldTicket!,
        'turn-seat-a',
        runtime({ is_processing: true, turn_id: 'turn-seat-a' }),
        'msg-seat-a'
      )
    ).toBe(false);
    expect(result.current.markSendFailed(oldTicket!, 'late seat-a failure')).toBe(false);
    expect(result.current.abandonAttempt(oldTicket!)).toBe(false);

    expect(result.current.view).toMatchObject({
      activeTurnId: null,
      isProcessing: false,
      localSubmitting: false,
    });
    expect(emitSpy).not.toHaveBeenCalledWith('conversation.turn.working', expect.anything());
    expect(emitSpy).not.toHaveBeenCalledWith('conversation.messages.refresh', expect.anything());
    expect(emitSpy).not.toHaveBeenCalledWith('conversation.runtime.recovered', expect.anything());
  });

  it('does not let a delayed completion clear a new local submit before acceptance', async () => {
    const emitSpy = vi.spyOn(emitter, 'emit');
    const { result } = renderHook(() => useConversationRuntimeView('conv-1'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let pendingTicket: NonNullable<ReturnType<typeof result.current.issueSendAttempt>>;
    act(() => {
      pendingTicket = beginSend({ result });
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
      result.current.markSendAccepted(pendingTicket, 'turn-new', newRuntime, 'msg-new');
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
      const ticket = beginSend({ result });
      result.current.markSendAccepted(ticket, 'turn-1', stillRunning, 'msg-1');
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
      const ticket = beginSend({ result });
      result.current.markSendAccepted(ticket, 'turn-1', runningRuntime, 'msg-1');
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
