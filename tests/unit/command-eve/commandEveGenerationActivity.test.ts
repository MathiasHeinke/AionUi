/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.7.3 — the generation-activity registry that backs the seat-switch guard.
 *
 * The signal is driven by the GLOBAL ACP response stream (applyAcpStreamActivity)
 * plus a send-time mark — NOT by any mounted component. The seat rail reads
 * isAnyGenerating() to warn before a switch would kill an in-flight turn. These
 * tests pin the two Codex 1.7.3 audit fixes: (#1) a turn stays tracked regardless
 * of any view being mounted, cleared only on a terminal event; (#2) the send-time
 * mark covers the window before the first `start` event.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAcpStreamActivity,
  clearAllGenerating,
  clearConversationGenerating,
  clearGenerationForBackendRespawn,
  isAnyGenerating,
  markConversationGenerating,
} from '@renderer/services/commandEveGenerationActivity';
import {
  localSendAccepted,
  localSendStarted,
  resetConversationRuntimeViewStoreForTest,
  turnCompleted,
} from '@renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import type { TConversationRuntimeSummary } from '@/common/config/storage';

const runningRuntime = (turn_id: string): TConversationRuntimeSummary => ({
  state: 'running',
  can_send_message: false,
  has_task: true,
  task_status: 'running',
  is_processing: true,
  pending_confirmations: 0,
  turn_id,
});

const idleRuntime = (): TConversationRuntimeSummary => ({
  state: 'idle',
  can_send_message: true,
  has_task: false,
  task_status: 'finished',
  is_processing: false,
  pending_confirmations: 0,
  turn_id: null,
});

describe('commandEveGenerationActivity — the seat-switch guard signal (1.7.3)', () => {
  afterEach(() => {
    clearAllGenerating();
    resetConversationRuntimeViewStoreForTest();
  });

  it('is empty by default', () => {
    expect(isAnyGenerating()).toBe(false);
  });

  it('#2 marks generation at send time (before the first stream event) and clears on a failed send', () => {
    markConversationGenerating('conv-a');
    expect(isAnyGenerating()).toBe(true);
    // Send failed before it ever started streaming -> explicit clear.
    clearConversationGenerating('conv-a');
    expect(isAnyGenerating()).toBe(false);
  });

  it('tracks a full turn from the global stream: start → content → finish', () => {
    applyAcpStreamActivity({ type: 'start', conversation_id: 'conv-a' });
    expect(isAnyGenerating()).toBe(true);
    applyAcpStreamActivity({ type: 'content', conversation_id: 'conv-a' });
    expect(isAnyGenerating()).toBe(true);
    applyAcpStreamActivity({ type: 'finish', conversation_id: 'conv-a' });
    expect(isAnyGenerating()).toBe(false);
  });

  it('#1 stays tracked independent of any mounted view — only a terminal event clears it', () => {
    // A turn starts and keeps streaming while the user navigates away. Nothing
    // "unmounts" the flag now — unrelated events do not clear it.
    applyAcpStreamActivity({ type: 'start', conversation_id: 'conv-bg' });
    expect(isAnyGenerating()).toBe(true);
    applyAcpStreamActivity({ type: 'acp_context_usage', conversation_id: 'conv-bg', data: { used: 1, size: 2 } });
    expect(isAnyGenerating()).toBe(true);
    // The real terminal signal (from the global stream) clears it.
    applyAcpStreamActivity({ type: 'error', conversation_id: 'conv-bg' });
    expect(isAnyGenerating()).toBe(false);
  });

  it.each(['error', 'disconnected'] as const)('clears the seat-switch guard when agent_status reports %s', (status) => {
    applyAcpStreamActivity({ type: 'start', conversation_id: 'conv-status', turn_id: 'turn-status' });
    expect(isAnyGenerating()).toBe(true);

    applyAcpStreamActivity({
      type: 'agent_status',
      conversation_id: 'conv-status',
      turn_id: 'turn-status',
      data: { status },
    });
    expect(isAnyGenerating()).toBe(false);
  });

  it('stays true while ANY conversation is generating (multiple in flight)', () => {
    applyAcpStreamActivity({ type: 'start', conversation_id: 'a' });
    markConversationGenerating('b');
    expect(isAnyGenerating()).toBe(true);
    applyAcpStreamActivity({ type: 'finish', conversation_id: 'a' });
    // b is still marked → a switch would still interrupt it.
    expect(isAnyGenerating()).toBe(true);
    clearConversationGenerating('b');
    expect(isAnyGenerating()).toBe(false);
  });

  it('ignores bootstrap / non-turn events so warmup never registers a phantom turn', () => {
    applyAcpStreamActivity({ type: 'agent_status', conversation_id: 'c', data: { status: 'session_active' } });
    applyAcpStreamActivity({ type: 'acp_model_info', conversation_id: 'c' });
    applyAcpStreamActivity({ type: 'acp_context_usage', conversation_id: 'c', data: { used: 1, size: 2 } });
    expect(isAnyGenerating()).toBe(false);
  });

  it('treats a done thinking block as not-activity, but an active thinking block as activity', () => {
    applyAcpStreamActivity({ type: 'thinking', conversation_id: 'c', data: { status: 'done' } });
    expect(isAnyGenerating()).toBe(false);
    applyAcpStreamActivity({ type: 'thinking', conversation_id: 'c', data: {} });
    expect(isAnyGenerating()).toBe(true);
  });

  it('#1 convergence: a committed seat switch empties the set (backend respawn kills all in-flight turns, no terminal event)', () => {
    applyAcpStreamActivity({ type: 'start', conversation_id: 'a' });
    markConversationGenerating('b');
    expect(isAnyGenerating()).toBe(true);
    // Confirmed "switch anyway": the killed turns will never emit finish/error, so
    // without this clear they would linger and nag on every future switch.
    clearGenerationForBackendRespawn();
    expect(isAnyGenerating()).toBe(false);
  });

  it('ignores an empty/invalid conversation id (never a stuck ghost flag)', () => {
    applyAcpStreamActivity({ type: 'start', conversation_id: '' });
    markConversationGenerating('');
    applyAcpStreamActivity(null);
    applyAcpStreamActivity({ type: 'start' });
    expect(isAnyGenerating()).toBe(false);
  });

  it('keeps newer generation live when recovered turn frames arrive late', () => {
    localSendStarted('conv-race');
    localSendAccepted('conv-race', 'turn-a', runningRuntime('turn-a'));
    turnCompleted('conv-race', 'turn-a', idleRuntime());
    // Recovery has not started B yet, so its exact terminal remains admissible.
    applyAcpStreamActivity({ type: 'finish', conversation_id: 'conv-race', turn_id: 'turn-a' });

    localSendStarted('conv-race');
    markConversationGenerating('conv-race');
    localSendAccepted('conv-race', 'turn-b', runningRuntime('turn-b'));
    applyAcpStreamActivity({ type: 'start', conversation_id: 'conv-race', turn_id: 'turn-b' });
    expect(isAnyGenerating()).toBe(true);

    for (const type of ['text', 'error', 'finish']) {
      applyAcpStreamActivity({ type, conversation_id: 'conv-race', turn_id: 'turn-a' });
      expect(isAnyGenerating()).toBe(true);
    }

    applyAcpStreamActivity({ type: 'finish', conversation_id: 'conv-race', turn_id: 'turn-b' });
    expect(isAnyGenerating()).toBe(false);
  });
});
