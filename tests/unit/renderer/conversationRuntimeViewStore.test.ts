import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConversationTurnCompletedEvent } from '@/common/adapter/ipcBridge';
import type { TConversationRuntimeSummary } from '@/common/config/storage';

const seatHarness = vi.hoisted(() => ({
  currentSeatId: 'seat-a',
  nextSeat: 0,
  rebindEpoch: 0,
  initialized: true,
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
import {
  abandonLocalRuntimeAttempt,
  admitConversationTurnCompleted,
  getConversationRuntimeViewSnapshot,
  hydrateSucceeded,
  issueLocalSendAttempt,
  issueLocalStopAttempt,
  invalidateConversationRuntimeForSeatRebind,
  localSendAccepted,
  localSendFailed,
  localSendStarted,
  localStopAcknowledged,
  localStopRequested,
  resetConversationRuntimeViewStoreForTest,
  shouldApplyConversationTurnCompleted,
  shouldApplyConversationStreamTurn,
  turnCompleted,
  waitForConversationActiveTurnId,
  type ConversationRuntimeAttemptTicket,
} from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';

const idleRuntime = (): TConversationRuntimeSummary => ({
  state: 'idle',
  can_send_message: true,
  has_task: true,
  task_status: 'finished',
  is_processing: false,
  pending_confirmations: 0,
  turn_id: null,
});

const runningRuntime = (turn_id: string): TConversationRuntimeSummary => ({
  state: 'running',
  can_send_message: false,
  has_task: true,
  task_status: 'running',
  is_processing: true,
  pending_confirmations: 0,
  turn_id,
});

const sendTickets = new Map<string, ConversationRuntimeAttemptTicket>();
const stopTickets = new Map<string, ConversationRuntimeAttemptTicket>();

const startLocalSend = (conversation_id: string): ConversationRuntimeAttemptTicket => {
  const ticket = issueLocalSendAttempt(conversation_id);
  expect(ticket).not.toBeNull();
  expect(localSendStarted(conversation_id, ticket!).applied).toBe(true);
  sendTickets.set(conversation_id, ticket!);
  return ticket!;
};

const acceptLocalSend = (
  conversation_id: string,
  turn_id: string,
  runtime: TConversationRuntimeSummary,
  msg_id?: string
) => {
  const ticket = sendTickets.get(conversation_id);
  expect(ticket).toBeDefined();
  const result = localSendAccepted(conversation_id, turn_id, runtime, msg_id, ticket!);
  if (result.applied) sendTickets.delete(conversation_id);
  return result.logs;
};

const failLocalSend = (conversation_id: string, reason: string) => {
  const ticket = sendTickets.get(conversation_id);
  expect(ticket).toBeDefined();
  const result = localSendFailed(conversation_id, reason, ticket!);
  if (result.applied) sendTickets.delete(conversation_id);
  return result.logs;
};

const requestLocalStop = (conversation_id: string, turn_id: string): ConversationRuntimeAttemptTicket => {
  const ticket = issueLocalStopAttempt(conversation_id);
  expect(ticket).not.toBeNull();
  expect(localStopRequested(conversation_id, turn_id, ticket!).applied).toBe(true);
  stopTickets.set(conversation_id, ticket!);
  return ticket!;
};

const acknowledgeLocalStop = (conversation_id: string, turn_id: string, runtime: TConversationRuntimeSummary) => {
  const ticket = stopTickets.get(conversation_id);
  expect(ticket).toBeDefined();
  const result = localStopAcknowledged(conversation_id, turn_id, runtime, ticket!);
  if (result.applied) stopTickets.delete(conversation_id);
  return result.logs;
};

describe('conversationRuntimeViewStore turn id contract', () => {
  beforeEach(() => {
    seatHarness.currentSeatId = 'seat-a';
    seatHarness.nextSeat = 0;
    seatHarness.rebindEpoch = 0;
    seatHarness.initialized = true;
    resetConversationRuntimeViewStoreForTest();
    sendTickets.clear();
    stopTickets.clear();
  });

  const rebindSeat = () => {
    seatHarness.nextSeat += 1;
    seatHarness.rebindEpoch += 1;
    seatHarness.currentSeatId = `seat-rebound-${seatHarness.nextSeat}`;
    invalidateConversationRuntimeForSeatRebind();
  };

  it('seals the authoritative boot seat without fencing background completion', () => {
    seatHarness.currentSeatId = 'seat-1';
    seatHarness.initialized = false;
    resetConversationRuntimeViewStoreForTest();

    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-background',
        consumer: 'conversation_list_sync',
      })
    ).toBe(true);

    // initialize() resolves the real seat before its settings GET completes.
    seatHarness.currentSeatId = 'seat-a';
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-background',
        consumer: 'runtime_view',
      })
    ).toBe(true);

    seatHarness.initialized = true;
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-background',
        consumer: 'conversation_list_sync',
      })
    ).toBe(true);

    // A seat-id mutation without an epoch advance is an invariant breach and
    // must fail closed rather than silently rebasing.
    seatHarness.currentSeatId = 'seat-impossible';
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-background',
        consumer: 'runtime_view',
      })
    ).toBe(false);

    seatHarness.rebindEpoch = 1;
    seatHarness.currentSeatId = 'seat-b';
    seatHarness.initialized = false;
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-background',
        consumer: 'runtime_view',
      })
    ).toBe(false);
  });

  it('rejects stale, overlapping, and replayed local lifecycle callbacks without recreating state', () => {
    const oldSend = issueLocalSendAttempt('conv-seat');
    expect(oldSend).not.toBeNull();
    expect(issueLocalSendAttempt('conv-seat')).toBeNull();

    rebindSeat();
    expect(localSendStarted('conv-seat', oldSend!)).toEqual({ applied: false, logs: [] });
    expect(abandonLocalRuntimeAttempt(oldSend!)).toBe(false);
    expect(getConversationRuntimeViewSnapshot('conv-seat')).toMatchObject({
      activeTurnId: null,
      isProcessing: false,
      localSubmitting: false,
    });

    const currentSend = issueLocalSendAttempt('conv-seat');
    expect(currentSend).not.toBeNull();
    expect(localSendStarted('conv-seat', currentSend!).applied).toBe(true);
    expect(
      localSendAccepted('conv-seat', 'turn-seat-b', runningRuntime('turn-seat-b'), 'msg-seat-b', currentSend!).applied
    ).toBe(true);
    expect(
      localSendAccepted('conv-seat', 'turn-seat-b', runningRuntime('turn-seat-b'), 'msg-seat-b', currentSend!)
    ).toEqual({ applied: false, logs: [] });

    const oldStop = issueLocalStopAttempt('conv-seat');
    expect(oldStop).not.toBeNull();
    expect(localStopRequested('conv-seat', 'turn-seat-b', oldStop!).applied).toBe(true);
    rebindSeat();
    expect(localStopAcknowledged('conv-seat', 'turn-seat-b', idleRuntime(), oldStop!)).toEqual({
      applied: false,
      logs: [],
    });
  });

  it('does not let an unrelated durable completion consume a pending local send attempt', () => {
    const ticket = issueLocalSendAttempt('conv-race');
    expect(ticket).not.toBeNull();
    expect(localSendStarted('conv-race', ticket!).applied).toBe(true);

    turnCompleted('conv-race', 'turn-old', idleRuntime());
    expect(localSendAccepted('conv-race', 'turn-new', runningRuntime('turn-new'), 'msg-new', ticket!).applied).toBe(
      true
    );
    expect(getConversationRuntimeViewSnapshot('conv-race')).toMatchObject({
      activeTurnId: 'turn-new',
      isProcessing: true,
      localSubmitting: false,
    });
  });

  it('keeps idle when turn.completed arrives before local send accepted', () => {
    const ticket = startLocalSend('conv-1');
    const event: IConversationTurnCompletedEvent = {
      session_id: 'conv-1',
      turn_id: 'turn-1',
      status: 'finished',
      state: 'ai_waiting_input',
      detail: 'done',
      can_send_message: true,
      has_substantive_output: true,
      runtime: idleRuntime(),
      workspace: '/tmp/workspace',
      model: { platform: 'acp', name: 'EVE', use_model: 'eve' },
      last_message: { id: 'message-1', type: 'content', content: 'done', status: 'finished', created_at: 1 },
    };
    expect(admitConversationTurnCompleted({ event, consumer: 'runtime_view' })).toBe('defer');
    const accepted = localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1', ticket);
    expect(accepted.replayTurnCompleted).toEqual(event);
    turnCompleted('conv-1', event.turn_id, event.runtime);

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.localSubmitting).toBe(false);
    expect(view.activeTurnId).toBeNull();
  });

  it('keeps idle when a stale running hydrate arrives after turn.completed', () => {
    startLocalSend('conv-1');
    acceptLocalSend('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');
    turnCompleted('conv-1', 'turn-1', idleRuntime());
    const logs = hydrateSucceeded('conv-1', runningRuntime('turn-1'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.activeTurnId).toBeNull();
    expect(logs[0]).toMatchObject({
      event: 'runtime_hydrated',
      data: {
        stale_after_completed: true,
        source: 'hydrate',
      },
    });
  });

  it('keeps idle when a stale stop acknowledgement arrives after turn.completed', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-1'));
    requestLocalStop('conv-1', 'turn-1');
    turnCompleted('conv-1', 'turn-1', idleRuntime());
    const logs = acknowledgeLocalStop('conv-1', 'turn-1', runningRuntime('turn-1'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.localStopping).toBe(false);
    expect(view.activeTurnId).toBeNull();
    expect(logs).toEqual([]);
  });

  it('uses send response runtime summary as authoritative active turn', () => {
    startLocalSend('conv-1');
    acceptLocalSend('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('running');
    expect(view.isProcessing).toBe(true);
    expect(view.canSendMessage).toBe(false);
    expect(view.localSubmitting).toBe(false);
    expect(view.activeTurnId).toBe('turn-1');
  });

  it('waits for a locally submitted turn before steering', async () => {
    startLocalSend('conv-1');
    const pendingTurn = waitForConversationActiveTurnId('conv-1', { timeoutMs: 100 });

    acceptLocalSend('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    await expect(pendingTurn).resolves.toBe('turn-1');
  });

  it('fails closed when the local send ends before a turn becomes active', async () => {
    startLocalSend('conv-1');
    const pendingTurn = waitForConversationActiveTurnId('conv-1', { timeoutMs: 100 });

    failLocalSend('conv-1', 'send failed');

    await expect(pendingTurn).resolves.toBeNull();
  });

  it('keeps an existing active turn running when a concurrent send fails', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-1'));
    startLocalSend('conv-1');
    failLocalSend('conv-1', 'conversation is already running');

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('running');
    expect(view.isProcessing).toBe(true);
    expect(view.canSendMessage).toBe(false);
    expect(view.activeTurnId).toBe('turn-1');
    expect(view.localSubmitting).toBe(false);
  });

  it('ignores stale stop ack for an older turn', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-2'));
    requestLocalStop('conv-1', 'turn-1');
    acknowledgeLocalStop('conv-1', 'turn-1', runningRuntime('turn-2'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.activeTurnId).toBe('turn-2');
    expect(view.isProcessing).toBe(true);
    expect(view.localStopping).toBe(false);
  });

  it('uses cancel response runtime summary as authoritative state', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-1'));
    requestLocalStop('conv-1', 'turn-1');
    acknowledgeLocalStop('conv-1', 'turn-1', runningRuntime('turn-2'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.activeTurnId).toBe('turn-2');
    expect(view.isProcessing).toBe(true);
    expect(view.localStopping).toBe(false);
  });

  it('allows only a recovered turn terminal before a newer local send begins', () => {
    startLocalSend('conv-1');
    acceptLocalSend('conv-1', 'turn-a', runningRuntime('turn-a'), 'msg-a');
    turnCompleted('conv-1', 'turn-a', idleRuntime());

    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-1',
        consumer: 'conversation_list_sync',
        terminal: true,
        turn_id: 'turn-a',
        type: 'error',
      })
    ).toBe(false);
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-1',
        consumer: 'conversation_list_sync',
        terminal: true,
        turn_id: 'turn-a',
        type: 'finish',
      })
    ).toBe(true);
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-1',
        consumer: 'conversation_list_sync',
        terminal: false,
        turn_id: 'turn-a',
        type: 'text',
      })
    ).toBe(false);

    startLocalSend('conv-1');
    for (const [type, terminal] of [
      ['text', false],
      ['error', true],
      ['finish', true],
    ] as const) {
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-1',
          consumer: 'conversation_list_sync',
          terminal,
          turn_id: 'turn-a',
          type,
        })
      ).toBe(false);
    }

    acceptLocalSend('conv-1', 'turn-b', runningRuntime('turn-b'), 'msg-b');
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-1',
        consumer: 'conversation_list_sync',
        terminal: true,
        turn_id: 'turn-b',
        type: 'finish',
      })
    ).toBe(true);
  });

  it('preserves repeated successful terminals for the bounded downstream retry policy', () => {
    for (const consumer of ['generation_activity', 'conversation_list_sync'] as const) {
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-finish',
          consumer,
          terminal: false,
          turn_id: 'turn-finish',
          type: 'start',
        })
      ).toBe(true);
    }

    for (const consumer of ['generation_activity', 'conversation_list_sync', 'conversation_list_sync'] as const) {
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-finish',
          consumer,
          terminal: true,
          turn_id: 'turn-finish',
          type: 'finish',
        })
      ).toBe(true);
    }
  });

  it('requires positive new-seat identity before accepting a terminal after rebind', () => {
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-seat',
        consumer: 'conversation_list_sync',
        terminal: true,
        turn_id: 'turn-background',
        type: 'error',
      })
    ).toBe(true);

    rebindSeat();
    for (const turn_id of ['turn-background', undefined] as const) {
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-seat',
          consumer: 'conversation_list_sync',
          terminal: true,
          turn_id,
          type: 'error',
        })
      ).toBe(false);
    }

    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-seat',
        consumer: 'conversation_list_sync',
        terminal: false,
        turn_id: 'turn-new-seat',
        type: 'start',
      })
    ).toBe(true);
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-seat',
        consumer: 'conversation_list_sync',
        terminal: true,
        turn_id: 'turn-new-seat',
        type: 'error',
      })
    ).toBe(true);
  });

  it('fences durable completion until positive current-seat identity is bound', () => {
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-background',
        consumer: 'conversation_list_sync',
      })
    ).toBe(true);

    rebindSeat();
    for (const turn_id of ['turn-old-seat', undefined] as const) {
      expect(
        shouldApplyConversationTurnCompleted({
          conversation_id: 'conv-seat',
          consumer: 'conversation_list_sync',
          turn_id,
        })
      ).toBe(false);
    }

    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-seat',
        consumer: 'conversation_list_sync',
        terminal: false,
        turn_id: 'turn-new-seat',
        type: 'start',
      })
    ).toBe(true);
    for (const consumer of ['conversation_list_sync', 'runtime_view'] as const) {
      expect(
        shouldApplyConversationTurnCompleted({
          conversation_id: 'conv-seat',
          consumer,
          turn_id: 'turn-old-seat',
        })
      ).toBe(false);
      expect(
        shouldApplyConversationTurnCompleted({
          conversation_id: 'conv-seat',
          consumer,
          turn_id: 'turn-new-seat',
        })
      ).toBe(true);
    }

    rebindSeat();
    hydrateSucceeded('conv-runtime', runningRuntime('turn-runtime'));
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-runtime',
        consumer: 'runtime_view',
        turn_id: 'turn-runtime',
      })
    ).toBe(true);

    rebindSeat();
    startLocalSend('conv-local-send');
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-local-send',
        consumer: 'runtime_view',
        turn_id: 'turn-local-send',
      })
    ).toBe(false);
    acceptLocalSend('conv-local-send', 'turn-local-send', runningRuntime('turn-local-send'));
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-local-send',
        consumer: 'runtime_view',
        turn_id: 'turn-local-send',
      })
    ).toBe(true);
  });

  it('rejects an uncorrelated terminal after an exact current-seat start', () => {
    rebindSeat();
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-seat',
        consumer: 'generation_activity',
        terminal: false,
        turn_id: 'turn-new-seat',
        type: 'start',
      })
    ).toBe(true);
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-seat',
        consumer: 'generation_activity',
        terminal: true,
        turn_id: undefined,
        type: 'error',
      })
    ).toBe(false);
    expect(
      shouldApplyConversationStreamTurn({
        conversation_id: 'conv-seat',
        consumer: 'generation_activity',
        terminal: true,
        turn_id: 'turn-new-seat',
        type: 'error',
      })
    ).toBe(true);
  });

  it.each([
    ['generation activity first', ['generation_activity', 'conversation_list_sync']],
    ['conversation list first', ['conversation_list_sync', 'generation_activity']],
  ] as const)('delivers one start-to-error terminal to both stream consumers with %s', (_label, consumers) => {
    for (const consumer of consumers) {
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-error',
          consumer,
          terminal: false,
          turn_id: 'turn-error',
          type: 'start',
        })
      ).toBe(true);
    }

    for (const consumer of consumers) {
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-error',
          consumer,
          terminal: true,
          turn_id: 'turn-error',
          type: 'error',
        })
      ).toBe(true);
    }

    for (const consumer of consumers) {
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-error',
          consumer,
          terminal: true,
          turn_id: 'turn-error',
          type: 'error',
        })
      ).toBe(false);
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-error',
          consumer,
          terminal: true,
          turn_id: 'turn-error',
          type: 'finish',
        })
      ).toBe(false);
      expect(
        shouldApplyConversationStreamTurn({
          conversation_id: 'conv-error',
          consumer,
          terminal: false,
          turn_id: 'turn-error',
          type: 'text',
        })
      ).toBe(false);
    }
  });
});
