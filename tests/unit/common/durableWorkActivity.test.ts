import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_ASYNC_COMPLETION_VERSION,
  DURABLE_WORK_ACTIVITY_VERSION,
  canPromiseBackgroundFollowUp,
  durableWorkRuntimeMs,
  normalizeDurableWorkSnapshot,
  projectLegacyDelegation,
  type DurableWorkItemV1,
  type DurableWorkSnapshotV1,
} from '@/common/runtime/durableWorkActivity';

const capability = {
  available: false,
  authority: 'hermes_delegation' as const,
  requiresApproval: false,
};

const item = (overrides: Partial<DurableWorkItemV1> = {}): DurableWorkItemV1 => ({
  id: 'work-1',
  kind: 'worker',
  origin: { conversationId: 'conv-1', sessionId: 'session-1' },
  engine: { name: 'hermes', version: '0.20.0' },
  goal: 'Audit the release',
  role: 'cto',
  status: 'running',
  queuedAt: 1_000,
  startedAt: 2_000,
  lastActivityAt: 3_000,
  gates: [],
  evidence: [],
  actions: { pause: capability, resume: capability, retry: capability, cancel: capability },
  receipts: {},
  sequence: 4,
  ...overrides,
});

const snapshot = (items: DurableWorkItemV1[] = [item()]): DurableWorkSnapshotV1 => ({
  version: DURABLE_WORK_ACTIVITY_VERSION,
  conversationId: 'conv-1',
  reconstructedFrom: 'persistent_receipts',
  generatedAt: 4_000,
  revision: 7,
  items,
});

describe('durable work activity contract', () => {
  it('accepts only the versioned, conversation-bound persistent receipt projection', () => {
    expect(normalizeDurableWorkSnapshot(snapshot(), 'conv-1')).toMatchObject({
      version: DURABLE_WORK_ACTIVITY_VERSION,
      conversationId: 'conv-1',
      revision: 7,
    });
    expect(normalizeDurableWorkSnapshot({ ...snapshot(), version: 'future/v2' }, 'conv-1')).toBeNull();
    expect(normalizeDurableWorkSnapshot(snapshot(), 'conv-2')).toBeNull();
  });

  it('drops foreign and duplicate work items instead of leaking them into the chat', () => {
    const foreign = item({ id: 'foreign', origin: { conversationId: 'conv-2', sessionId: 'session-2' } });
    const normalized = normalizeDurableWorkSnapshot(snapshot([item(), foreign, item()]), 'conv-1');

    expect(normalized?.items).toHaveLength(1);
    expect(normalized?.items[0].id).toBe('work-1');
  });

  it('allows a future follow-up promise only after the accepted versioned wake receipt', () => {
    expect(canPromiseBackgroundFollowUp(item())).toBe(false);
    expect(
      canPromiseBackgroundFollowUp(
        item({
          receipts: {
            wake: {
              version: COMMAND_EVE_ASYNC_COMPLETION_VERSION,
              id: 'wake-1',
              recordedAt: 5_000,
              sequence: 5,
              state: 'accepted',
            },
          },
        })
      )
    ).toBe(true);
    expect(
      canPromiseBackgroundFollowUp(
        item({
          receipts: {
            wake: {
              version: COMMAND_EVE_ASYNC_COMPLETION_VERSION,
              id: 'wake-2',
              recordedAt: 5_000,
              sequence: 5,
              state: 'retryable',
            },
          },
        })
      )
    ).toBe(false);
  });

  it('fails non-terminal legacy message projections closed after reconnect', () => {
    const projected = projectLegacyDelegation(
      {
        id: 'legacy-1',
        toolCallId: 'tool-1',
        goal: 'Continue in background',
        status: 'in_progress',
        taskIndex: 0,
        taskCount: 1,
        createdAt: 2_000,
      },
      'conv-1'
    );

    expect(projected.status).toBe('reconnect_unavailable');
    expect(projected.actions.pause.available).toBe(false);
    expect(projected.actions.cancel.available).toBe(false);
    expect(projected.receipts.wake).toBeUndefined();
  });

  it('never infers terminal success from historical chat and computes bounded runtime', () => {
    const projected = projectLegacyDelegation(
      {
        id: 'legacy-2',
        toolCallId: 'tool-2',
        goal: 'Finished task',
        status: 'completed',
        taskIndex: 0,
        taskCount: 1,
        createdAt: 2_000,
      },
      'conv-1'
    );

    expect(projected.status).toBe('reconnect_unavailable');
    expect(projected.statusReason).toBe('historical_chat_is_not_a_live_receipt');
    expect(durableWorkRuntimeMs(item({ startedAt: 5_000, finishedAt: 8_500 }), 20_000)).toBe(3_500);
    expect(durableWorkRuntimeMs(item({ startedAt: 5_000, finishedAt: 4_000 }), 20_000)).toBe(0);
  });

  it.each([
    ['background dispatch', 'completed', true, 'running'],
    ['pending call', 'pending', false, 'queued'],
    ['active call', 'in_progress', false, 'running'],
    ['failed call', 'failed', false, 'failed'],
    ['completed tool call without a typed child outcome', 'completed', false, 'reconnect_unavailable'],
  ] as const)(
    'maps renderer-observed %s without inventing child success',
    (_label, status, backgroundDispatched, expected) => {
      const projected = projectLegacyDelegation(
        {
          id: `live-${status}`,
          toolCallId: `tool-${status}`,
          goal: 'Observed during this renderer epoch',
          status,
          taskIndex: 0,
          taskCount: 1,
          createdAt: 2_000,
          backgroundDispatched,
          observedLive: true,
        },
        'conv-1'
      );

      expect(projected.status).toBe(expected);
      expect(projected.status).not.toBe('succeeded');
      expect(projected.queuedAt).toBe(2_000);
      expect(projected.lastActivityAt).toBe(2_000);
    }
  );
});
