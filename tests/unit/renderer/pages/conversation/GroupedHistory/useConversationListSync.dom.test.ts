/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IConversationListChangedEvent,
  IConversationTurnCompletedEvent,
  IResponseMessage,
} from '@/common/adapter/ipcBridge';
import type { TChatConversation, TConversationRuntimeSummary } from '@/common/config/storage';
import {
  readConversationSidebarStatusReceipt,
  resetConversationListSyncForTest,
  useConversationListSync,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import {
  markConversationDocumentPreparationSettled,
  markConversationDocumentPreparationStarted,
  resetConversationDocumentPreparationStoreForTest,
} from '@/renderer/pages/conversation/runtime/conversationDocumentPreparationStore';
import {
  resetConversationRuntimeRecoveryMonitorsForTest,
  useConversationRuntimeView,
} from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { resetConversationRuntimeViewStoreForTest } from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import { emitter } from '@/renderer/utils/emitter';

const harness = vi.hoisted(() => {
  const responseHandlers = new Set<(message: IResponseMessage) => void>();
  const turnCompletedHandlers = new Set<(event: IConversationTurnCompletedEvent) => void>();
  const listChangedHandlers = new Set<(event: IConversationListChangedEvent) => void>();
  const seatRebindHandlers = new Set<(seatId: string) => void>();
  const rowsBySeat = new Map<string, TChatConversation[]>();
  let currentSeatId = 'seat-a';

  return {
    responseHandlers,
    turnCompletedHandlers,
    listChangedHandlers,
    seatRebindHandlers,
    rowsBySeat,
    getCurrentSeatId: () => currentSeatId,
    setCurrentSeatId: (seatId: string) => {
      currentSeatId = seatId;
    },
    onResponse: (handler: (message: IResponseMessage) => void) => {
      responseHandlers.add(handler);
      return () => responseHandlers.delete(handler);
    },
    onTurnCompleted: (handler: (event: IConversationTurnCompletedEvent) => void) => {
      turnCompletedHandlers.add(handler);
      return () => turnCompletedHandlers.delete(handler);
    },
    onListChanged: (handler: (event: IConversationListChangedEvent) => void) => {
      listChangedHandlers.add(handler);
      return () => listChangedHandlers.delete(handler);
    },
    onSeatRebind: (handler: (seatId: string) => void) => {
      seatRebindHandlers.add(handler);
      return () => seatRebindHandlers.delete(handler);
    },
    getUserConversations: vi.fn(async () => ({
      items: rowsBySeat.get(currentSeatId) ?? [],
      total: rowsBySeat.get(currentSeatId)?.length ?? 0,
      has_more: false,
    })),
    getConversation: vi.fn(async ({ id }: { id: string }) => {
      return rowsBySeat.get(currentSeatId)?.find((conversation) => conversation.id === id) ?? null;
    }),
    updateConversation: vi.fn(
      async ({ id, updates }: { id: string; updates: Partial<TChatConversation>; merge_extra?: boolean }) => {
        const rows = rowsBySeat.get(currentSeatId) ?? [];
        const index = rows.findIndex((conversation) => conversation.id === id);
        if (index < 0) return false;
        const current = rows[index];
        rows[index] = {
          ...current,
          ...updates,
          extra: {
            ...current.extra,
            ...(updates.extra as Record<string, unknown> | undefined),
          },
        } as TChatConversation;
        return true;
      }
    ),
    writeRendererLog: vi.fn().mockResolvedValue(undefined),
    ensureAfterSuccessfulTurn: vi.fn().mockResolvedValue({
      status: 'created',
      project_id: 'project-auto',
      project_title: 'Automatic project',
    }),
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      writeRendererLog: { invoke: harness.writeRendererLog },
    },
    database: {
      getUserConversations: { invoke: harness.getUserConversations },
    },
    conversation: {
      get: { invoke: harness.getConversation },
      update: { invoke: harness.updateConversation },
      responseStream: { on: harness.onResponse },
      turnCompleted: { on: harness.onTurnCompleted },
      listChanged: { on: harness.onListChanged },
    },
    projectWorkspace: {
      ensureAfterSuccessfulTurn: { invoke: harness.ensureAfterSuccessfulTurn },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    getCurrentSeatId: harness.getCurrentSeatId,
    onSeatRebind: harness.onSeatRebind,
  },
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

const conversation = (
  id: string,
  runtimeSummary?: TConversationRuntimeSummary,
  extra: Record<string, unknown> = {},
  type: 'acp' | 'aionrs' = 'acp'
): TChatConversation =>
  ({
    id,
    name: id,
    type,
    created_at: 1,
    modified_at: 1,
    status: runtimeSummary?.is_processing ? 'running' : 'finished',
    runtime: runtimeSummary,
    extra: { backend: 'hermes', ...extra },
    model: {
      id: 'custom',
      platform: 'custom',
      name: 'EVE',
      base_url: '',
      api_key: '',
      use_model: 'eve',
    },
  }) as TChatConversation;

const responseMessage = (overrides: Partial<IResponseMessage>): IResponseMessage => ({
  type: 'content',
  data: null,
  msg_id: 'message-1',
  turn_id: 'turn-1',
  conversation_id: 'conversation-a',
  ...overrides,
});

const terminalTurn = (
  conversation_id: string,
  turn_id: string,
  runtimeSummary: TConversationRuntimeSummary,
  state: IConversationTurnCompletedEvent['state'] = 'ai_waiting_input'
): IConversationTurnCompletedEvent => ({
  session_id: conversation_id,
  turn_id,
  status: 'finished',
  state,
  detail: '',
  can_send_message: true,
  has_substantive_output: true,
  runtime: runtimeSummary,
  workspace: '',
  model: { platform: '', name: '', use_model: '' },
  last_message: { id: 'assistant-1', content: 'done', status: 'finish', created_at: 2 },
});

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('conversation sidebar continuity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetConversationRuntimeRecoveryMonitorsForTest();
    resetConversationRuntimeViewStoreForTest();
    harness.responseHandlers.clear();
    harness.turnCompletedHandlers.clear();
    harness.listChangedHandlers.clear();
    harness.seatRebindHandlers.clear();
    harness.rowsBySeat.clear();
    harness.setCurrentSeatId('seat-a');
  });

  afterEach(() => {
    resetConversationRuntimeRecoveryMonitorsForTest();
    resetConversationRuntimeViewStoreForTest();
    vi.useRealTimers();
  });

  it('rejects malformed and cross-seat status receipts', () => {
    const malformed = conversation('conversation-a', runtime(), {
      command_eve_sidebar_status: {
        version: 1,
        seat_id: 'seat-a',
        state: 'done',
        turn_id: 'turn-1',
        updated_at: 0,
      },
    });
    const otherSeat = conversation('conversation-a', runtime(), {
      command_eve_sidebar_status: {
        version: 1,
        seat_id: 'seat-b',
        state: 'done',
        turn_id: 'turn-1',
        updated_at: 10,
      },
    });

    expect(readConversationSidebarStatusReceipt(malformed, 'seat-a')).toBeNull();
    expect(readConversationSidebarStatusReceipt(otherSeat, 'seat-a')).toBeNull();
  });

  it('keeps one Hermes turn live across A -> B -> A, persists terminal state, and reconciles its transcript', async () => {
    const runningTurn = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-hermes',
    });
    const terminalRuntime = runtime({ turn_id: 'turn-hermes' });
    harness.rowsBySeat.set('seat-a', [
      conversation('conversation-a', runningTurn),
      conversation('native-a', undefined, {}, 'aionrs'),
      conversation('conversation-auto', runtime()),
    ]);
    harness.rowsBySeat.set('seat-b', [conversation('conversation-b', runtime())]);

    const listHook = renderHook(() => useConversationListSync());
    await act(flushPromises);
    expect(listHook.result.current.conversations.map(({ id }) => id)).toEqual([
      'conversation-a',
      'native-a',
      'conversation-auto',
    ]);
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(true);

    // The shared response stream also covers native/AionRS turns. Its start and
    // finish frames retain the same immediate running -> done behavior.
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'start', conversation_id: 'native-a', turn_id: 'turn-native' }))
      );
    });
    expect(listHook.result.current.isConversationGenerating('native-a')).toBe(true);
    await act(async () => {
      // A list request issued before the stream start may still carry idle
      // runtime. It must not erase the newer live frame.
      emitter.emit('chat.history.refresh');
      await flushPromises();
    });
    expect(listHook.result.current.isConversationGenerating('native-a')).toBe(true);
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'finish', conversation_id: 'native-a', turn_id: 'turn-native' }))
      );
    });
    expect(listHook.result.current.isConversationGenerating('native-a')).toBe(false);
    expect(listHook.result.current.hasCompletionUnread('native-a')).toBe(true);
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'start', conversation_id: 'native-a', turn_id: 'turn-native-error' }))
      );
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'error', conversation_id: 'native-a', turn_id: 'turn-native-error' }))
      );
    });
    expect(listHook.result.current.hasConversationError('native-a')).toBe(true);

    // The auto-project relay is owned by this permanently mounted store. Start
    // a substantive EVE turn in session A, navigate to session B, then finish A
    // in the background. A full replay of the same turn remains once-only.
    await act(async () => {
      listHook.result.current.setActiveConversation('conversation-auto');
      await flushPromises();
    });
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'start', conversation_id: 'conversation-auto', turn_id: 'turn-auto' }))
      );
      harness.responseHandlers.forEach((handler) =>
        handler(
          responseMessage({
            type: 'content',
            data: 'Substantive result',
            conversation_id: 'conversation-auto',
            turn_id: 'turn-auto',
          })
        )
      );
    });
    await act(async () => {
      listHook.result.current.setActiveConversation('native-a');
      await flushPromises();
    });
    await act(async () => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'finish', conversation_id: 'conversation-auto', turn_id: 'turn-auto' }))
      );
      await flushPromises();
    });
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledTimes(1);
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledWith({
      conversation_id: 'conversation-auto',
      turn_id: 'turn-auto',
    });

    await act(async () => {
      for (const type of ['start', 'content', 'finish']) {
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type,
              data: type === 'content' ? 'Substantive result' : null,
              conversation_id: 'conversation-auto',
              turn_id: 'turn-auto',
            })
          )
        );
      }
      await flushPromises();
    });
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledTimes(1);

    // Late T1 terminal frames must never erase a newer, still-live T2 relay.
    harness.ensureAfterSuccessfulTurn.mockClear();
    act(() => {
      for (const [type, turn_id] of [
        ['start', 'turn-race-1'],
        ['content', 'turn-race-1'],
        ['start', 'turn-race-2'],
        ['content', 'turn-race-2'],
        ['error', 'turn-race-1'],
        ['finish', 'turn-race-2'],
      ] as const) {
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type,
              data: type === 'content' ? `Substantive ${turn_id}` : null,
              conversation_id: 'conversation-auto',
              turn_id,
            })
          )
        );
      }
    });
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledTimes(1);
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledWith({
      conversation_id: 'conversation-auto',
      turn_id: 'turn-race-2',
    });

    // Explicit AionCore completion evidence closes a compact stream that
    // delivered substantive output but lost its finish frame.
    harness.ensureAfterSuccessfulTurn.mockClear();
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(
          responseMessage({
            type: 'content',
            data: { content: 'Substantive durable result' },
            conversation_id: 'conversation-auto',
            turn_id: 'turn-completed-only',
          })
        )
      );
      harness.turnCompletedHandlers.forEach((handler) =>
        handler(
          terminalTurn(
            'conversation-auto',
            'turn-completed-only',
            runtime({ turn_id: 'turn-completed-only' }),
            'ai_waiting_input'
          )
        )
      );
    });
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledTimes(1);
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledWith({
      conversation_id: 'conversation-auto',
      turn_id: 'turn-completed-only',
    });

    // A later compact replay of that same turn remains exactly once.
    act(() => {
      for (const type of ['start', 'content', 'finish']) {
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type,
              data: type === 'content' ? 'Substantive result' : null,
              conversation_id: 'conversation-auto',
              turn_id: 'turn-completed-only',
            })
          )
        );
      }
    });
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledTimes(1);

    // Lifecycle completion alone is not success. Missing/false AionCore output
    // proof remains fail-closed even when a historical last_message exists.
    harness.ensureAfterSuccessfulTurn.mockClear();
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(
          responseMessage({
            type: 'start',
            conversation_id: 'conversation-auto',
            turn_id: 'turn-empty-completion',
          })
        )
      );
      const event = terminalTurn(
        'conversation-auto',
        'turn-empty-completion',
        runtime({ turn_id: 'turn-empty-completion' })
      );
      event.has_substantive_output = false;
      event.last_message = { id: 'old-assistant', content: 'historical', status: 'finish', created_at: 1 };
      harness.turnCompletedHandlers.forEach((handler) => handler(event));
    });
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).not.toHaveBeenCalled();

    // A same-tick failure always wins over an optimistic completion candidate,
    // in either event order, and tombstones every later replay for that turn.
    for (const [turnId, successFirst] of [
      ['turn-success-then-error', true],
      ['turn-error-then-success', false],
    ] as const) {
      act(() => {
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type: 'content',
              data: 'Partial output',
              conversation_id: 'conversation-auto',
              turn_id: turnId,
            })
          )
        );
        const success = terminalTurn('conversation-auto', turnId, runtime({ turn_id: turnId }));
        const failure = terminalTurn('conversation-auto', turnId, runtime({ turn_id: turnId }), 'error');
        harness.turnCompletedHandlers.forEach((handler) => handler(successFirst ? success : failure));
        harness.turnCompletedHandlers.forEach((handler) => handler(successFirst ? failure : success));
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type: 'finish',
              conversation_id: 'conversation-auto',
              turn_id: turnId,
            })
          )
        );
      });
    }
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).not.toHaveBeenCalled();

    // A failed turn may terminalize only through turn.completed; a later
    // replayed finish must not resurrect it as a successful auto-project.
    harness.ensureAfterSuccessfulTurn.mockClear();
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'start', conversation_id: 'conversation-auto', turn_id: 'turn-failed' }))
      );
      harness.responseHandlers.forEach((handler) =>
        handler(
          responseMessage({
            type: 'content',
            data: 'Partial output before failure',
            conversation_id: 'conversation-auto',
            turn_id: 'turn-failed',
          })
        )
      );
      harness.turnCompletedHandlers.forEach((handler) =>
        handler(terminalTurn('conversation-auto', 'turn-failed', runtime({ turn_id: 'turn-failed' }), 'error'))
      );
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'finish', conversation_id: 'conversation-auto', turn_id: 'turn-failed' }))
      );
    });
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).not.toHaveBeenCalled();

    // Conversation deletion clears the in-flight relay evidence.
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'start', conversation_id: 'conversation-auto', turn_id: 'turn-deleted' }))
      );
      harness.responseHandlers.forEach((handler) =>
        handler(
          responseMessage({
            type: 'content',
            data: 'Will be deleted',
            conversation_id: 'conversation-auto',
            turn_id: 'turn-deleted',
          })
        )
      );
      harness.listChangedHandlers.forEach((handler) =>
        handler({ conversation_id: 'conversation-auto', action: 'deleted' })
      );
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'finish', conversation_id: 'conversation-auto', turn_id: 'turn-deleted' }))
      );
    });
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).not.toHaveBeenCalled();

    // A rejected renderer->Main invoke removes only the replay suppression key;
    // the same durable stream may retry, then remains once-only after success.
    harness.ensureAfterSuccessfulTurn.mockRejectedValueOnce(new Error('bridge unavailable'));
    await act(async () => {
      for (const type of ['start', 'content', 'finish']) {
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type,
              data: type === 'content' ? 'Retryable result' : null,
              conversation_id: 'conversation-auto',
              turn_id: 'turn-retry',
            })
          )
        );
      }
      await flushPromises();
      for (const type of ['start', 'content', 'finish']) {
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type,
              data: type === 'content' ? 'Retryable result' : null,
              conversation_id: 'conversation-auto',
              turn_id: 'turn-retry',
            })
          )
        );
      }
      await flushPromises();
    });
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledTimes(2);

    // Defined retry policy: Main noop/rejected results get exactly one bounded
    // retry; a third call is impossible even after more timer/replay pressure.
    harness.ensureAfterSuccessfulTurn.mockClear();
    harness.ensureAfterSuccessfulTurn
      .mockResolvedValueOnce({ status: 'noop' })
      .mockResolvedValueOnce({ status: 'rejected', reason_code: 'transient_precommit_failure' });
    await act(async () => {
      for (const type of ['content', 'finish']) {
        harness.responseHandlers.forEach((handler) =>
          handler(
            responseMessage({
              type,
              data: type === 'content' ? 'Bounded retry result' : null,
              conversation_id: 'conversation-auto',
              turn_id: 'turn-result-retry',
            })
          )
        );
      }
      await flushPromises();
      await vi.advanceTimersByTimeAsync(250);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(1_000);
      await flushPromises();
      harness.responseHandlers.forEach((handler) =>
        handler(
          responseMessage({
            type: 'finish',
            conversation_id: 'conversation-auto',
            turn_id: 'turn-result-retry',
          })
        )
      );
      await flushPromises();
    });
    expect(harness.ensureAfterSuccessfulTurn).toHaveBeenCalledTimes(2);

    // A seat rebind invalidates an in-flight turn before an old-seat finish can
    // arrive. The following real A->B switch doubles as the cleanup assertion.
    harness.ensureAfterSuccessfulTurn.mockClear();
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'start', conversation_id: 'conversation-auto', turn_id: 'turn-old-seat' }))
      );
      harness.responseHandlers.forEach((handler) =>
        handler(
          responseMessage({
            type: 'content',
            data: 'Old seat output',
            conversation_id: 'conversation-auto',
            turn_id: 'turn-old-seat',
          })
        )
      );
    });

    await act(async () => {
      harness.setCurrentSeatId('seat-b');
      harness.seatRebindHandlers.forEach((handler) => handler('seat-b'));
      await flushPromises();
    });
    expect(listHook.result.current.conversations.map(({ id }) => id)).toEqual(['conversation-b']);
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'finish', conversation_id: 'conversation-auto', turn_id: 'turn-old-seat' }))
      );
      harness.turnCompletedHandlers.forEach((handler) =>
        handler(terminalTurn('conversation-auto', 'turn-old-seat', runtime({ turn_id: 'turn-old-seat' })))
      );
    });
    await act(flushPromises);
    expect(harness.ensureAfterSuccessfulTurn).not.toHaveBeenCalled();

    await act(async () => {
      harness.setCurrentSeatId('seat-a');
      harness.seatRebindHandlers.forEach((handler) => handler('seat-a'));
      await flushPromises();
    });
    expect(listHook.result.current.conversations.map(({ id }) => id)).toEqual([
      'conversation-a',
      'native-a',
      'conversation-auto',
    ]);
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(true);

    const emitSpy = vi.spyOn(emitter, 'emit');
    const runtimeHook = renderHook(() => useConversationRuntimeView('conversation-a'));
    await act(flushPromises);
    expect(runtimeHook.result.current.activeTurnId).toBe('turn-hermes');
    expect(runtimeHook.result.current.isProcessing).toBe(true);

    // Backend durable truth flips before the event, matching the real turn
    // lifecycle. Both global sidebar and mounted transcript listeners receive it.
    harness.rowsBySeat.set('seat-a', [
      conversation('conversation-a', terminalRuntime),
      ...harness.rowsBySeat.get('seat-a')!.slice(1),
    ]);
    await act(async () => {
      const event = terminalTurn('conversation-a', 'turn-hermes', terminalRuntime);
      harness.turnCompletedHandlers.forEach((handler) => handler(event));
      await flushPromises();
    });

    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);
    expect(listHook.result.current.hasCompletionUnread('conversation-a')).toBe(true);
    expect(listHook.result.current.isConversationWaitingInput('conversation-a')).toBe(true);
    expect(listHook.result.current.hasConversationError('conversation-a')).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith('conversation.messages.refresh', { conversation_id: 'conversation-a' });
    expect(emitSpy).toHaveBeenCalledWith(
      'conversation.runtime.recovered',
      expect.objectContaining({ conversation_id: 'conversation-a', recoveredTurnId: 'turn-hermes' })
    );

    await act(flushPromises);
    const persisted = readConversationSidebarStatusReceipt(
      harness.rowsBySeat.get('seat-a')!.find(({ id }) => id === 'conversation-a')!,
      'seat-a'
    );
    expect(persisted).toMatchObject({ state: 'attention', turn_id: 'turn-hermes', seat_id: 'seat-a' });

    // A second seat round-trip clears all renderer-only sets. The terminal dot
    // returns from conversation.extra, while authoritative idle runtime prevents
    // the old turn from reappearing as a stale spinner.
    await act(async () => {
      harness.setCurrentSeatId('seat-b');
      harness.seatRebindHandlers.forEach((handler) => handler('seat-b'));
      await flushPromises();
      harness.setCurrentSeatId('seat-a');
      harness.seatRebindHandlers.forEach((handler) => handler('seat-a'));
      await flushPromises();
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);
    expect(listHook.result.current.hasCompletionUnread('conversation-a')).toBe(true);
    expect(listHook.result.current.isConversationWaitingInput('conversation-a')).toBe(true);

    await act(async () => {
      listHook.result.current.setActiveConversation('conversation-a');
      await flushPromises();
    });
    expect(listHook.result.current.hasCompletionUnread('conversation-a')).toBe(false);
    expect(listHook.result.current.isConversationWaitingInput('conversation-a')).toBe(false);
    expect(
      readConversationSidebarStatusReceipt(
        harness.rowsBySeat.get('seat-a')!.find(({ id }) => id === 'conversation-a')!,
        'seat-a'
      )
    ).toMatchObject({ state: 'idle', turn_id: 'turn-hermes', seat_id: 'seat-a' });

    runtimeHook.unmount();
    listHook.unmount();
  });
});

describe('conversation sidebar working phases (1.820.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetConversationRuntimeRecoveryMonitorsForTest();
    resetConversationRuntimeViewStoreForTest();
    resetConversationDocumentPreparationStoreForTest();
    harness.responseHandlers.clear();
    harness.turnCompletedHandlers.clear();
    harness.listChangedHandlers.clear();
    harness.seatRebindHandlers.clear();
    harness.rowsBySeat.clear();
    harness.setCurrentSeatId('seat-a');
    // Fresh store init so this suite's harness handlers are the live ones.
    resetConversationListSyncForTest();
  });

  afterEach(() => {
    resetConversationRuntimeRecoveryMonitorsForTest();
    resetConversationRuntimeViewStoreForTest();
    resetConversationDocumentPreparationStoreForTest();
    vi.useRealTimers();
  });

  it('lights the row from the send-lifecycle signal and document preparation before any stream frame', async () => {
    harness.rowsBySeat.set('seat-a', [conversation('conversation-a', runtime())]);
    const listHook = renderHook(() => useConversationListSync());
    await act(flushPromises);
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);

    // Pre-stream: the turn is submitted ("EVE bereitet den Auftrag vor" /
    // backend preparing) — no stream frames exist yet, the row must still
    // show activity.
    act(() => {
      emitter.emit('conversation.turn.working', { conversation_id: 'conversation-a', working: true });
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(true);

    // A terminal stream frame ends the send-gate working flag as well.
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'finish', conversation_id: 'conversation-a', turn_id: 'turn-1' }))
      );
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);

    // A send that failed before the backend took over clears via the same signal.
    act(() => {
      emitter.emit('conversation.turn.working', { conversation_id: 'conversation-a', working: true });
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(true);
    act(() => {
      emitter.emit('conversation.turn.working', { conversation_id: 'conversation-a', working: false });
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);

    // Document preparation mirrors into the same working state...
    act(() => {
      markConversationDocumentPreparationStarted('conversation-a');
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(true);

    // ...and settling preparation while a stream runs keeps the row working —
    // the stream-frame truth is independent of the preparation mirror.
    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'start', conversation_id: 'conversation-a', turn_id: 'turn-2' }))
      );
      markConversationDocumentPreparationSettled('conversation-a');
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(true);

    act(() => {
      harness.responseHandlers.forEach((handler) =>
        handler(responseMessage({ type: 'finish', conversation_id: 'conversation-a', turn_id: 'turn-2' }))
      );
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);
    listHook.unmount();
  });

  it('resets the pre-stream working flags on a seat switch', async () => {
    harness.rowsBySeat.set('seat-a', [conversation('conversation-a', runtime())]);
    harness.rowsBySeat.set('seat-b', [conversation('conversation-b', runtime())]);
    const listHook = renderHook(() => useConversationListSync());
    await act(flushPromises);

    act(() => {
      emitter.emit('conversation.turn.working', { conversation_id: 'conversation-a', working: true });
      markConversationDocumentPreparationStarted('conversation-a');
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(true);

    await act(async () => {
      harness.setCurrentSeatId('seat-b');
      harness.seatRebindHandlers.forEach((handler) => handler('seat-b'));
      await flushPromises();
    });
    // The store-side working flags must not bleed across the seat boundary.
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);

    // The document-preparation mirror reflects its source store, which is
    // seat-agnostic — settling it keeps the mirror quiet too.
    act(() => {
      markConversationDocumentPreparationSettled('conversation-a');
    });
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);
    listHook.unmount();
  });
});
