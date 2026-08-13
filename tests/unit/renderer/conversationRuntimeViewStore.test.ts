import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  getConversationRuntimeViewSnapshot,
  hydrateSucceeded,
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

describe('conversationRuntimeViewStore turn id contract', () => {
  beforeEach(() => {
    seatHarness.currentSeatId = 'seat-a';
    seatHarness.nextSeat = 0;
    seatHarness.rebindEpoch = 0;
    seatHarness.initialized = true;
    resetConversationRuntimeViewStoreForTest();
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

  it('keeps idle when turn.completed arrives before local send accepted', () => {
    localSendStarted('conv-1');
    turnCompleted('conv-1', 'turn-1', idleRuntime());
    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.localSubmitting).toBe(false);
    expect(view.activeTurnId).toBeNull();
  });

  it('keeps idle when a stale running hydrate arrives after turn.completed', () => {
    localSendStarted('conv-1');
    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');
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
    localStopRequested('conv-1', 'turn-1');
    turnCompleted('conv-1', 'turn-1', idleRuntime());
    const logs = localStopAcknowledged('conv-1', 'turn-1', runningRuntime('turn-1'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('idle');
    expect(view.isProcessing).toBe(false);
    expect(view.canSendMessage).toBe(true);
    expect(view.localStopping).toBe(false);
    expect(view.activeTurnId).toBeNull();
    expect(logs[0]).toMatchObject({
      event: 'local_stop_acknowledged',
      data: {
        stale_after_completed: true,
        source: 'stop_response',
      },
    });
  });

  it('uses send response runtime summary as authoritative active turn', () => {
    localSendStarted('conv-1');
    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('running');
    expect(view.isProcessing).toBe(true);
    expect(view.canSendMessage).toBe(false);
    expect(view.localSubmitting).toBe(false);
    expect(view.activeTurnId).toBe('turn-1');
  });

  it('waits for a locally submitted turn before steering', async () => {
    localSendStarted('conv-1');
    const pendingTurn = waitForConversationActiveTurnId('conv-1', { timeoutMs: 100 });

    localSendAccepted('conv-1', 'turn-1', runningRuntime('turn-1'), 'msg-1');

    await expect(pendingTurn).resolves.toBe('turn-1');
  });

  it('fails closed when the local send ends before a turn becomes active', async () => {
    localSendStarted('conv-1');
    const pendingTurn = waitForConversationActiveTurnId('conv-1', { timeoutMs: 100 });

    localSendFailed('conv-1', 'send failed');

    await expect(pendingTurn).resolves.toBeNull();
  });

  it('keeps an existing active turn running when a concurrent send fails', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-1'));
    localSendStarted('conv-1');
    localSendFailed('conv-1', 'conversation is already running');

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.state).toBe('running');
    expect(view.isProcessing).toBe(true);
    expect(view.canSendMessage).toBe(false);
    expect(view.activeTurnId).toBe('turn-1');
    expect(view.localSubmitting).toBe(false);
  });

  it('ignores stale stop ack for an older turn', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-2'));
    localStopRequested('conv-1', 'turn-1');
    localStopAcknowledged('conv-1', 'turn-1', runningRuntime('turn-2'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.activeTurnId).toBe('turn-2');
    expect(view.isProcessing).toBe(true);
    expect(view.localStopping).toBe(false);
  });

  it('uses cancel response runtime summary as authoritative state', () => {
    hydrateSucceeded('conv-1', runningRuntime('turn-1'));
    localStopRequested('conv-1', 'turn-1');
    localStopAcknowledged('conv-1', 'turn-1', runningRuntime('turn-2'));

    const view = getConversationRuntimeViewSnapshot('conv-1');
    expect(view.activeTurnId).toBe('turn-2');
    expect(view.isProcessing).toBe(true);
    expect(view.localStopping).toBe(false);
  });

  it('allows only a recovered turn terminal before a newer local send begins', () => {
    localSendStarted('conv-1');
    localSendAccepted('conv-1', 'turn-a', runningRuntime('turn-a'), 'msg-a');
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

    localSendStarted('conv-1');
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

    localSendAccepted('conv-1', 'turn-b', runningRuntime('turn-b'), 'msg-b');
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
    localSendStarted('conv-local-send');
    expect(
      shouldApplyConversationTurnCompleted({
        conversation_id: 'conv-local-send',
        consumer: 'runtime_view',
        turn_id: 'turn-local-send',
      })
    ).toBe(false);
    localSendAccepted('conv-local-send', 'turn-local-send', runningRuntime('turn-local-send'));
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
