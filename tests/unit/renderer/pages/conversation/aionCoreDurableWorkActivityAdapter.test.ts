import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IAcpAsyncCompletionReceipt,
  IAcpAsyncCompletionReceiptList,
  IConversationArtifact,
} from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';
import { DURABLE_WORK_ACTIVITY_VERSION, type DurableWorkSnapshotV1 } from '@/common/runtime/durableWorkActivity';

const bridge = vi.hoisted(() => ({
  listReceipts: vi.fn(),
  getConversation: vi.fn(),
  listArtifacts: vi.fn(),
  stop: vi.fn(),
  realtimeListeners: [] as Array<() => void>,
  streamListeners: [] as Array<(message: { type: string; conversation_id: string }) => void>,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  conversation: {
    listAsyncCompletionReceipts: { invoke: bridge.listReceipts },
    get: { invoke: bridge.getConversation },
    listArtifacts: { invoke: bridge.listArtifacts },
    stop: { invoke: bridge.stop },
    realtimeConnected: {
      on: (listener: () => void) => {
        bridge.realtimeListeners.push(listener);
        return () => {
          bridge.realtimeListeners = bridge.realtimeListeners.filter((candidate) => candidate !== listener);
        };
      },
    },
    responseStream: {
      on: (listener: (message: { type: string; conversation_id: string }) => void) => {
        bridge.streamListeners.push(listener);
        return () => {
          bridge.streamListeners = bridge.streamListeners.filter((candidate) => candidate !== listener);
        };
      },
    },
  },
}));

import {
  AIONCORE_ASYNC_COMPLETION_RECEIPTS_VERSION,
  createAionCoreDurableWorkActivityAdapter,
  normalizeAionCoreReceiptList,
  projectAionCoreReceiptList,
} from '@/renderer/pages/conversation/runtime/aionCoreDurableWorkActivityAdapter';

const receipt = (
  completionId: string,
  lastOutcome?: IAcpAsyncCompletionReceipt['last_outcome'],
  state: IAcpAsyncCompletionReceipt['state'] = 'completed'
): IAcpAsyncCompletionReceipt => ({
  projection_id: state === 'rejected' ? `rejection:${completionId}` : `execution:${completionId}`,
  completion_id: completionId,
  acp_session_id: `session-${completionId}`,
  state,
  turn_id: state === 'rejected' ? undefined : `turn-${completionId}`,
  attempt_count: 2,
  created_at: 1_000,
  updated_at: 2_000,
  completed_at: state === 'completed' ? 2_000 : undefined,
  last_outcome: lastOutcome,
  last_outcome_code: lastOutcome === 'retryable' ? 'busy_retry' : undefined,
  last_outcome_at: lastOutcome ? 2_000 : undefined,
});

const receiptList = (
  conversationId = 'conv-1',
  receipts: IAcpAsyncCompletionReceipt[] = [receipt('running', undefined, 'processing')]
): IAcpAsyncCompletionReceiptList => ({
  version: AIONCORE_ASYNC_COMPLETION_RECEIPTS_VERSION,
  conversation_id: conversationId,
  reconstructed_from: 'persistent_receipts',
  generated_at: 3_000,
  receipts,
});

const conversation = (
  id = 'conv-1',
  runtime: TChatConversation['runtime'] = {
    state: 'running',
    can_send_message: false,
    has_task: true,
    task_status: 'running',
    is_processing: true,
    pending_confirmations: 0,
    turn_id: 'turn-running',
  }
): TChatConversation =>
  ({
    id,
    name: `Conversation ${id}`,
    type: 'acp',
    extra: { backend: 'codex' },
    model: { id: 'test', name: 'test', platform: 'test', useModel: 'test' },
    created_at: 500,
    modified_at: 2_500,
    runtime,
  }) as TChatConversation;

const childArtifact = (conversationId = 'conv-1'): IConversationArtifact => ({
  id: 'artifact-child-1',
  conversation_id: conversationId,
  kind: 'html',
  status: 'active',
  payload: {
    artifact_type: 'html',
    title: 'Child worker evidence',
    html: '<main>Verified child evidence</main>',
    receipt: { completion_id: 'accepted' },
  },
  created_at: 2_000,
  updated_at: 2_500,
});

describe('AionCore durable work adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.realtimeListeners = [];
    bridge.streamListeners = [];
    bridge.listReceipts.mockResolvedValue(receiptList());
    bridge.getConversation.mockResolvedValue(conversation());
    bridge.listArtifacts.mockResolvedValue([]);
    bridge.stop.mockResolvedValue({ outcome: 'accepted', runtime: conversation().runtime });
  });

  afterEach(() => {
    bridge.realtimeListeners = [];
    bridge.streamListeners = [];
  });

  it('keeps all committed acknowledgement outcomes distinct and never infers worker success', () => {
    const source = receiptList('conv-1', [
      receipt('accepted', 'accepted'),
      receipt('already', 'already_applied'),
      receipt('busy', 'retryable', 'pending'),
      receipt('rejected', 'rejected', 'rejected'),
      receipt('unknown', 'explicit_unknown', 'explicit_unknown'),
    ]);
    const projected = projectAionCoreReceiptList(source, 'conv-1', 1);

    expect(projected?.snapshot.items.map((item) => item.receipts.wake?.state)).toEqual([
      'accepted',
      'already_applied',
      'retryable',
      'rejected',
      'explicit_unknown',
    ]);
    expect(projected?.snapshot.items.map((item) => item.status)).toEqual([
      'stalled',
      'stalled',
      'waiting',
      'failed',
      'stalled',
    ]);
    expect(projected?.snapshot.items.some((item) => item.status === 'succeeded')).toBe(false);
    expect(projected?.snapshot.items.slice(0, 2).map((item) => item.statusReason)).toEqual([
      'worker_terminal_outcome_untyped',
      'worker_terminal_outcome_untyped',
    ]);
  });

  it('fails closed on foreign versions, conversations and duplicate receipt ids', () => {
    expect(normalizeAionCoreReceiptList({ ...receiptList(), version: 'future/v2' }, 'conv-1')).toBeNull();
    expect(normalizeAionCoreReceiptList(receiptList('conv-2'), 'conv-1')).toBeNull();
    expect(
      normalizeAionCoreReceiptList(receiptList('conv-1', [receipt('same'), receipt('same')]), 'conv-1')
    ).toBeNull();
  });

  it('keeps execution and rejection projection identities distinct for the same completion id', () => {
    const execution = receipt('shared', 'accepted');
    const rejection = receipt('shared', 'rejected', 'rejected');
    const normalized = normalizeAionCoreReceiptList(receiptList('conv-1', [execution, rejection]), 'conv-1');
    expect(normalized?.receipts).toHaveLength(2);

    const projected = projectAionCoreReceiptList(receiptList('conv-1', [execution, rejection]), 'conv-1', 2);
    expect(projected?.snapshot.items.map((item) => item.id)).toEqual([
      'hermes:execution:shared',
      'hermes:rejection:shared',
    ]);
    expect(projected?.snapshot.items[1]).toMatchObject({
      status: 'failed',
      actions: { cancel: { available: false } },
    });
  });

  it('projects the real waiting-confirmation runtime and only explicitly bound child artifacts', () => {
    const waiting = conversation('conv-1', {
      state: 'waiting_confirmation',
      can_send_message: false,
      has_task: true,
      task_status: 'running',
      is_processing: true,
      pending_confirmations: 1,
      turn_id: 'turn-needs-user',
    });
    const projected = projectAionCoreReceiptList(
      receiptList('conv-1', [receipt('accepted', 'accepted')]),
      'conv-1',
      4,
      waiting,
      [childArtifact(), { ...childArtifact('conv-2'), id: 'foreign-artifact' }]
    );

    const worker = projected?.snapshot.items.find((item) => item.id === 'hermes:execution:accepted');
    const needsUser = projected?.snapshot.items.find((item) => item.id === 'aioncore-turn:turn-needs-user');
    expect(worker?.evidence).toContainEqual(
      expect.objectContaining({ kind: 'artifact', ref: 'artifact:artifact-child-1' })
    );
    expect(worker?.evidence.some((item) => item.ref === 'artifact:foreign-artifact')).toBe(false);
    expect(needsUser).toMatchObject({ status: 'needs_input', kind: 'goal' });
    expect(needsUser?.actions.cancel).toMatchObject({ available: true, authority: 'aioncore_cancel' });
  });

  it('never revives a persisted processing receipt without a matching live runtime turn', () => {
    const idleConversation = conversation('conv-1', {
      state: 'idle',
      can_send_message: true,
      has_task: false,
      is_processing: false,
      pending_confirmations: 0,
      turn_id: null,
    });
    const projected = projectAionCoreReceiptList(receiptList(), 'conv-1', 3, idleConversation);
    expect(projected?.snapshot.items[0]).toMatchObject({
      status: 'reconnect_unavailable',
      statusReason: 'processing_receipt_without_live_turn',
      actions: { cancel: { available: false, reason: 'no_active_aioncore_turn' } },
    });
  });

  it('uses only the typed cancel route and reconstructs after adapter restart', async () => {
    const adapter = createAionCoreDurableWorkActivityAdapter();
    const unsubscribe = adapter.subscribe('conv-1', () => {});
    await vi.waitFor(() => expect(adapter.getSnapshot('conv-1')).not.toBeNull());
    const snapshot = adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1;
    const item = snapshot.items[0];

    const cancelAck = await adapter.requestAction({
      version: DURABLE_WORK_ACTIVITY_VERSION,
      conversationId: 'conv-1',
      workItemId: item.id,
      action: 'cancel',
      expectedRevision: snapshot.revision,
      expectedSequence: item.sequence,
    });
    expect(cancelAck.state).toBe('accepted');
    expect(bridge.stop).toHaveBeenCalledWith({ conversation_id: 'conv-1', turn_id: 'turn-running' });

    bridge.stop.mockResolvedValueOnce({ outcome: 'no_active_agent', runtime: conversation().runtime });
    const noOpAck = await adapter.requestAction({
      version: DURABLE_WORK_ACTIVITY_VERSION,
      conversationId: 'conv-1',
      workItemId: item.id,
      action: 'cancel',
      expectedRevision: snapshot.revision,
      expectedSequence: item.sequence,
    });
    expect(noOpAck).toMatchObject({ state: 'rejected', reason: 'aioncore_cancel_no_active_agent' });

    const retryAck = await adapter.requestAction({
      version: DURABLE_WORK_ACTIVITY_VERSION,
      conversationId: 'conv-1',
      workItemId: item.id,
      action: 'retry',
      expectedRevision: snapshot.revision,
      expectedSequence: item.sequence,
    });
    expect(retryAck).toMatchObject({ state: 'unavailable', reason: 'unsupported_typed_action' });
    expect(bridge.stop).toHaveBeenCalledTimes(2);

    unsubscribe();
    adapter.dispose();
    const restarted = createAionCoreDurableWorkActivityAdapter();
    const unsubscribeRestarted = restarted.subscribe('conv-1', () => {});
    await vi.waitFor(() => expect(restarted.getSnapshot('conv-1')).not.toBeNull());
    expect((restarted.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].id).toBe('hermes:execution:running');
    unsubscribeRestarted();
    restarted.dispose();
  });

  it('degrades after two reconnect failures and recovers from persistent receipts', async () => {
    const adapter = createAionCoreDurableWorkActivityAdapter();
    const unsubscribe = adapter.subscribe('conv-1', () => {});
    await vi.waitFor(() => expect(adapter.getSnapshot('conv-1')).not.toBeNull());
    const originalSequence = (adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].sequence;
    expect((adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].status).toBe('running');

    bridge.listReceipts.mockRejectedValue(new Error('offline'));
    bridge.realtimeListeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(bridge.listReceipts).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect((adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].status).toBe('running');

    bridge.realtimeListeners.forEach((listener) => listener());
    await vi.waitFor(() =>
      expect((adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].status).toBe('reconnect_unavailable')
    );
    expect((adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].actions.cancel.available).toBe(false);
    expect((adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].sequence).toBe(originalSequence);

    bridge.listReceipts.mockResolvedValue(receiptList());
    bridge.realtimeListeners.forEach((listener) => listener());
    await vi.waitFor(() =>
      expect((adapter.getSnapshot('conv-1') as DurableWorkSnapshotV1).items[0].status).toBe('running')
    );

    unsubscribe();
    adapter.dispose();
  });
});
