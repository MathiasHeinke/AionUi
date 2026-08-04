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
  useConversationListSync,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
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
  runtimeSummary: TConversationRuntimeSummary
): IConversationTurnCompletedEvent => ({
  session_id: conversation_id,
  turn_id,
  status: 'finished',
  state: 'ai_waiting_input',
  detail: '',
  can_send_message: true,
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
    ]);
    harness.rowsBySeat.set('seat-b', [conversation('conversation-b', runtime())]);

    const listHook = renderHook(() => useConversationListSync());
    await act(flushPromises);
    expect(listHook.result.current.conversations.map(({ id }) => id)).toEqual(['conversation-a', 'native-a']);
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

    await act(async () => {
      harness.setCurrentSeatId('seat-b');
      harness.seatRebindHandlers.forEach((handler) => handler('seat-b'));
      await flushPromises();
    });
    expect(listHook.result.current.conversations.map(({ id }) => id)).toEqual(['conversation-b']);
    expect(listHook.result.current.isConversationGenerating('conversation-a')).toBe(false);

    await act(async () => {
      harness.setCurrentSeatId('seat-a');
      harness.seatRebindHandlers.forEach((handler) => handler('seat-a'));
      await flushPromises();
    });
    expect(listHook.result.current.conversations.map(({ id }) => id)).toEqual(['conversation-a', 'native-a']);
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
