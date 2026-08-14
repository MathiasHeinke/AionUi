/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  beginLocalSendAttempt,
  admitConversationTurnCompleted,
  createDefaultConversationRuntimeView,
  getConversationRuntimeViewSnapshot,
  hydrateSucceededConversationRuntimeView,
  hydrateSucceeded,
  localSendAccepted as applyLocalSendAccepted,
  localSendAcceptedConversationRuntimeView,
  localSendFailedConversationRuntimeView,
  localSendStartedConversationRuntimeView,
  issueLocalStopAttempt,
  localStopAcknowledged as applyLocalStopAcknowledged,
  localStopAcknowledgedConversationRuntimeView,
  localStopRequested as applyLocalStopRequested,
  localStopRequestedConversationRuntimeView,
  resetConversationRuntimeViewStoreForTest,
  replayDeferredConversationTurnCompleted,
  subscribeConversationTurnCompletedReplay,
  turnCompleted,
  turnCompletedConversationRuntimeView,
  type ConversationRuntimeAttemptTicket,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';

const conversation_id = 'conversation-1';
const sendTickets = new Map<string, ConversationRuntimeAttemptTicket>();
const stopTickets = new Map<string, ConversationRuntimeAttemptTicket>();
const localSendStarted = (id: string) => {
  const ticket = beginLocalSendAttempt(id);
  expect(ticket).not.toBeNull();
  sendTickets.set(id, ticket!);
};
const localSendAccepted = (id: string, turnId: string, summary: TConversationRuntimeSummary, messageId?: string) =>
  applyLocalSendAccepted(id, turnId, summary, messageId, sendTickets.get(id)!).logs;
const localStopRequested = (id: string, turnId: string) => {
  const ticket = issueLocalStopAttempt(id);
  expect(ticket).not.toBeNull();
  expect(applyLocalStopRequested(id, turnId, ticket!).applied).toBe(true);
  stopTickets.set(id, ticket!);
};
const localStopAcknowledged = (id: string, turnId: string, summary: TConversationRuntimeSummary) =>
  applyLocalStopAcknowledged(id, turnId, summary, stopTickets.get(id)!).logs;

const runtime = (overrides: Partial<TConversationRuntimeSummary>): TConversationRuntimeSummary => ({
  state: 'idle',
  can_send_message: true,
  has_task: false,
  task_status: 'finished',
  is_processing: false,
  pending_confirmations: 0,
  turn_id: null,
  ...overrides,
});

const completedEvent = (turnId: string): IConversationTurnCompletedEvent => ({
  session_id: conversation_id,
  turn_id: turnId,
  status: 'finished',
  state: 'ai_waiting_input',
  detail: 'done',
  can_send_message: true,
  has_substantive_output: true,
  runtime: runtime({ turn_id: turnId }),
  workspace: '/tmp/workspace',
  model: { platform: 'acp', name: 'EVE', use_model: 'eve' },
  last_message: { id: 'message-1', type: 'content', content: 'done', status: 'finished', created_at: 1 },
});

describe('conversationRuntimeViewStore', () => {
  it('defers an exact fast completion and replays it once to both real consumers after acceptance', () => {
    resetConversationRuntimeViewStoreForTest();
    const ticket = beginLocalSendAttempt(conversation_id)!;
    const event = completedEvent('turn-fast');
    const runtimeConsumer = vi.fn();
    const listConsumer = vi.fn();
    subscribeConversationTurnCompletedReplay('runtime_view', runtimeConsumer);
    subscribeConversationTurnCompletedReplay('conversation_list_sync', listConsumer);

    expect(admitConversationTurnCompleted({ event, consumer: 'runtime_view' })).toBe('defer');
    expect(admitConversationTurnCompleted({ event, consumer: 'conversation_list_sync' })).toBe('defer');
    const accepted = applyLocalSendAccepted(
      conversation_id,
      'turn-fast',
      runtime({ turn_id: 'turn-fast' }),
      'message-fast',
      ticket
    );

    expect(accepted.replayTurnCompleted).toEqual(event);
    if (accepted.replayTurnCompleted) {
      replayDeferredConversationTurnCompleted(accepted.replayTurnCompleted);
    }
    expect(runtimeConsumer).toHaveBeenCalledTimes(1);
    expect(listConsumer).toHaveBeenCalledTimes(1);
  });

  it('drops a deferred completion whose exact turn does not match the accepted send', () => {
    resetConversationRuntimeViewStoreForTest();
    const ticket = beginLocalSendAttempt(conversation_id)!;
    expect(admitConversationTurnCompleted({ event: completedEvent('turn-old'), consumer: 'runtime_view' })).toBe(
      'defer'
    );

    const accepted = applyLocalSendAccepted(
      conversation_id,
      'turn-new',
      runtime({ turn_id: 'turn-new' }),
      'message-new',
      ticket
    );
    expect(accepted.replayTurnCompleted).toBeUndefined();
  });
  it('hydrates a running runtime as processing and not sendable', () => {
    const { view } = hydrateSucceededConversationRuntimeView(
      undefined,
      conversation_id,
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
      })
    );

    expect(view).toMatchObject({
      state: 'running',
      isProcessing: true,
      canSendMessage: false,
      hasBackendRuntime: true,
      hydrated: true,
    });
  });

  it('hydrates an idle runtime as sendable', () => {
    const { view, logs } = hydrateSucceededConversationRuntimeView(undefined, conversation_id, runtime({}));

    expect(view).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      hasBackendRuntime: true,
      hydrated: true,
    });
    expect(logs.map((log) => log.event)).toContain('runtime_release_confirmed');
  });

  it('marks local send start as busy before backend runtime arrives', () => {
    const { view } = localSendStartedConversationRuntimeView(undefined, conversation_id);

    expect(view).toMatchObject({
      state: 'starting',
      isProcessing: true,
      canSendMessage: false,
      localSubmitting: true,
      hydrated: true,
    });
  });

  it('clears a failed local send gate and restores sendability without backend runtime', () => {
    const started = localSendStartedConversationRuntimeView(undefined, conversation_id).view;
    const { view } = localSendFailedConversationRuntimeView(started, conversation_id, 'network error');

    expect(view).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
      hydrated: true,
    });
  });

  it('clears a failed local send gate after an idle backend runtime was hydrated', () => {
    const hydrated = hydrateSucceededConversationRuntimeView(undefined, conversation_id, runtime({})).view;
    const started = localSendStartedConversationRuntimeView(hydrated, conversation_id).view;
    const { view } = localSendFailedConversationRuntimeView(started, conversation_id, 'network error');

    expect(view).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
      hasBackendRuntime: true,
      hydrated: true,
    });
  });

  it('low-level hydrate helper follows backend runtime when no metadata is supplied', () => {
    const started = localSendStartedConversationRuntimeView(undefined, conversation_id).view;
    const { view, logs } = hydrateSucceededConversationRuntimeView(started, conversation_id, runtime({}));

    expect(view).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
      hasBackendRuntime: true,
      hydrated: true,
    });
    expect(logs.map((log) => log.event)).toContain('runtime_release_confirmed');
  });

  it('keeps an unaccepted local send busy when a stale idle hydrate arrives', () => {
    resetConversationRuntimeViewStoreForTest();

    localSendStarted(conversation_id);
    const logs = hydrateSucceeded(conversation_id, runtime({}));

    expect(getConversationRuntimeViewSnapshot(conversation_id)).toMatchObject({
      state: 'starting',
      isProcessing: true,
      canSendMessage: false,
      localSubmitting: true,
      hasBackendRuntime: true,
      hydrated: true,
    });
    expect(logs.map((log) => log.event)).not.toContain('runtime_release_confirmed');
  });

  it('releases an accepted local send when a later hydrate confirms the backend is idle', () => {
    resetConversationRuntimeViewStoreForTest();

    localSendStarted(conversation_id);
    localSendAccepted(
      conversation_id,
      'turn-1',
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        turn_id: 'turn-1',
      }),
      'message-1'
    );
    const logs = hydrateSucceeded(conversation_id, runtime({}));

    expect(getConversationRuntimeViewSnapshot(conversation_id)).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
      hasBackendRuntime: true,
      hydrated: true,
    });
    expect(logs.map((log) => log.event)).toContain('runtime_release_confirmed');
  });

  it('uses send accepted runtime as authoritative processing state', () => {
    const started = localSendStartedConversationRuntimeView(undefined, conversation_id).view;
    const accepted = localSendAcceptedConversationRuntimeView(
      started,
      conversation_id,
      'turn-1',
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        turn_id: 'turn-1',
      }),
      'message-1'
    ).view;

    expect(accepted).toMatchObject({
      state: 'running',
      isProcessing: true,
      canSendMessage: false,
      localSubmitting: false,
      activeTurnId: 'turn-1',
    });

    const { view } = turnCompletedConversationRuntimeView(accepted, conversation_id, 'turn-1', runtime({}));

    expect(view).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
    });
  });

  it('replays a fast completion after send acceptance instead of letting the running response win', () => {
    resetConversationRuntimeViewStoreForTest();

    const ticket = beginLocalSendAttempt(conversation_id)!;
    const event = completedEvent('turn-1');
    expect(admitConversationTurnCompleted({ event, consumer: 'runtime_view' })).toBe('defer');
    const accepted = applyLocalSendAccepted(
      conversation_id,
      'turn-1',
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        turn_id: 'turn-1',
      }),
      'message-1',
      ticket
    );
    expect(accepted.replayTurnCompleted).toEqual(event);
    turnCompleted(conversation_id, event.turn_id, event.runtime);

    expect(getConversationRuntimeViewSnapshot(conversation_id)).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
      hasBackendRuntime: true,
      hydrated: true,
    });
    expect(accepted.logs.map((log) => log.event)).toContain('local_send_accepted');
  });

  it('does not unlock when turn completed has no runtime', () => {
    const started = localSendStartedConversationRuntimeView(undefined, conversation_id).view;
    const { view, logs } = turnCompletedConversationRuntimeView(started, conversation_id, 'turn-1', null);

    expect(view).toMatchObject({
      isProcessing: true,
      canSendMessage: false,
      localSubmitting: true,
      hydrated: true,
    });
    expect(logs.map((log) => log.event)).toEqual(['turn_completed_missing_runtime']);
  });

  it('uses stop acknowledgement runtime as authoritative state', () => {
    const running = runtime({
      state: 'running',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      turn_id: 'turn-1',
    });
    const hydrated = hydrateSucceededConversationRuntimeView(undefined, conversation_id, running).view;
    const requested = localStopRequestedConversationRuntimeView(hydrated, conversation_id, 'turn-1').view;
    const acknowledged = localStopAcknowledgedConversationRuntimeView(
      requested,
      conversation_id,
      'turn-1',
      runtime({})
    ).view;

    expect(acknowledged).toMatchObject({
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
      localStopping: false,
    });
  });

  it('does not re-mark stopping after runtime has already released', () => {
    const running = hydrateSucceededConversationRuntimeView(
      undefined,
      conversation_id,
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        turn_id: 'turn-1',
      })
    ).view;
    const requested = localStopRequestedConversationRuntimeView(running, conversation_id, 'turn-1').view;
    const completed = turnCompletedConversationRuntimeView(requested, conversation_id, 'turn-1', runtime({})).view;
    const acknowledged = localStopAcknowledgedConversationRuntimeView(
      completed,
      conversation_id,
      'turn-1',
      runtime({})
    ).view;

    expect(acknowledged).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      localSubmitting: false,
      localStopping: false,
    });
  });

  it('keeps next local send gate when stale stop acknowledgement returns running runtime', () => {
    resetConversationRuntimeViewStoreForTest();

    localSendStarted(conversation_id);
    localSendAccepted(
      conversation_id,
      'turn-1',
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        turn_id: 'turn-1',
      }),
      'message-1'
    );
    hydrateSucceeded(
      conversation_id,
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        turn_id: 'turn-1',
      })
    );
    localStopRequested(conversation_id, 'turn-1');
    turnCompleted(conversation_id, 'turn-1', runtime({}));
    localSendStarted(conversation_id);
    const logs = localStopAcknowledged(
      conversation_id,
      'turn-1',
      runtime({
        state: 'running',
        can_send_message: false,
        has_task: true,
        task_status: 'running',
        is_processing: true,
        turn_id: 'turn-2',
      })
    );

    expect(getConversationRuntimeViewSnapshot(conversation_id)).toMatchObject({
      state: 'starting',
      isProcessing: true,
      canSendMessage: false,
      localSubmitting: true,
      localStopping: false,
    });
    expect(logs).toEqual([]);
  });

  it('defaults to an idle view before hydration', () => {
    expect(createDefaultConversationRuntimeView(conversation_id)).toMatchObject({
      state: 'idle',
      isProcessing: false,
      canSendMessage: true,
      hasBackendRuntime: false,
      hydrated: false,
    });
  });
});
