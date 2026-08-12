/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_EVE_ASYNC_COMPLETION_VERSION,
  DURABLE_WORK_ACTIVITY_VERSION,
  DURABLE_WORK_STATUSES,
  type DurableWorkActionRequestV1,
  type DurableWorkItemV1,
  type DurableWorkSnapshotV1,
} from '@/common/runtime/durableWorkActivity';
import DurableWorkActivity from '@/renderer/components/layout/Titlebar/DurableWorkActivity';
import {
  installDurableWorkActivityAdapter,
  type DurableWorkActivityAdapterV1,
} from '@/renderer/pages/conversation/runtime/durableWorkActivityAdapter';
import {
  bindConversationDelegationActivitySession,
  publishLiveConversationDelegationActivity,
  resetConversationDelegationActivityForTest,
} from '@/renderer/pages/conversation/runtime/conversationDelegationActivityStore';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: {
      error: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { goal?: string; value?: string }) =>
      options?.goal ? `${key}:${options.goal}` : options?.value ? `${key}:${options.value}` : key,
  }),
}));

const enabled = {
  available: true,
  authority: 'aioncore_approval' as const,
  requiresApproval: true,
};
const disabled = {
  available: false,
  authority: 'hermes_delegation' as const,
  requiresApproval: false,
  reason: 'unsupported',
};

const workItem = (id: string, status: DurableWorkItemV1['status']): DurableWorkItemV1 => ({
  id,
  kind: id.startsWith('goal') ? 'goal' : 'subagent',
  origin: { conversationId: 'conv-1', sessionId: 'session-1', parentSessionId: 'conv-1' },
  engine: { name: 'hermes', version: '0.20.0' },
  goal: `Goal ${id}`,
  role: 'cto',
  status,
  queuedAt: 1_000,
  startedAt: 2_000,
  lastActivityAt: 3_000,
  current: { step: `Step ${id}`, tool: `Tool ${id}` },
  gates: [],
  evidence: [],
  actions: {
    pause: status === 'running' ? enabled : disabled,
    resume: status === 'waiting' || status === 'stalled' ? enabled : disabled,
    retry: status === 'failed' ? enabled : disabled,
    cancel: enabled,
  },
  receipts: {},
  sequence: 9,
});

let uninstall: (() => void) | null = null;
let actionRequests: DurableWorkActionRequestV1[] = [];

const installSnapshot = (items: DurableWorkItemV1[], revision = 12) => {
  const current: DurableWorkSnapshotV1 = {
    version: DURABLE_WORK_ACTIVITY_VERSION,
    conversationId: 'conv-1',
    reconstructedFrom: 'persistent_receipts',
    generatedAt: 4_000,
    revision,
    items,
  };
  const adapter: DurableWorkActivityAdapterV1 = {
    version: DURABLE_WORK_ACTIVITY_VERSION,
    getSnapshot: (conversationId) => (conversationId === 'conv-1' ? current : null),
    subscribe: () => () => {},
    requestAction: vi.fn(async (request) => {
      actionRequests.push(request);
      return {
        version: DURABLE_WORK_ACTIVITY_VERSION,
        request,
        state: 'accepted' as const,
        receiptId: `receipt-${request.action}`,
      };
    }),
  };
  uninstall = installDurableWorkActivityAdapter(adapter);
};

const publishLiveDelegation = (
  toolCallId: string,
  delegationId: string,
  goal: string,
  sessionId = 'session-1'
): void => {
  bindConversationDelegationActivitySession('conv-1', sessionId);
  publishLiveConversationDelegationActivity('conv-1', {
    id: `${toolCallId}-message`,
    type: 'acp_tool_call',
    conversation_id: 'conv-1',
    created_at: 1_000,
    content: {
      session_id: sessionId,
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: toolCallId,
        status: 'in_progress',
        title: `delegate: ${goal}`,
        kind: 'execute',
        rawInput: { goal },
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: JSON.stringify({ delegation_id: delegationId, status: 'dispatched', mode: 'background' }),
            },
          },
        ],
      },
    },
  } as IMessageAcpToolCall);
};

describe('DurableWorkActivity', () => {
  beforeEach(() => {
    actionRequests = [];
    resetConversationDelegationActivityForTest();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it('renders every contract lifecycle state inside the owning chat and no second composer', () => {
    installSnapshot(DURABLE_WORK_STATUSES.map((status) => workItem(status, status)));
    render(<DurableWorkActivity conversationId='conv-1' />);

    for (const status of DURABLE_WORK_STATUSES) {
      expect(screen.getByText(`conversation.durableWork.status.${status}`)).toBeTruthy();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(DURABLE_WORK_STATUSES.length);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('submits pause, resume, retry and cancel only through adapter capabilities without optimistic state changes', async () => {
    installSnapshot([
      workItem('running-1', 'running'),
      workItem('waiting-1', 'waiting'),
      workItem('failed-1', 'failed'),
    ]);
    render(<DurableWorkActivity conversationId='conv-1' />);

    fireEvent.click(screen.getByRole('button', { name: 'conversation.durableWork.action.pause:Goal running-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.durableWork.action.resume:Goal waiting-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.durableWork.action.retry:Goal failed-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.durableWork.action.cancel:Goal running-1' }));

    await waitFor(() => expect(actionRequests).toHaveLength(4));
    expect(actionRequests.map(({ action }) => action)).toEqual(['pause', 'resume', 'retry', 'cancel']);
    expect(actionRequests[0]).toMatchObject({
      version: DURABLE_WORK_ACTIVITY_VERSION,
      conversationId: 'conv-1',
      workItemId: 'running-1',
      expectedRevision: 12,
      expectedSequence: 9,
    });
    expect(screen.getByText('conversation.durableWork.status.running')).toBeTruthy();
    expect(screen.getByText('conversation.durableWork.status.waiting')).toBeTruthy();
  });

  it('shows needs-input gates, evidence and honest wake-receipt truth in the workbench detail', () => {
    const needsInput = workItem('goal-1', 'needs_input');
    needsInput.gates = [{ id: 'gate-1', label: 'Founder approval', state: 'needs_input', evidenceIds: ['ev-1'] }];
    needsInput.evidence = [{ id: 'ev-1', label: 'Approval receipt', kind: 'receipt' }];
    installSnapshot([needsInput]);

    const { rerender } = render(<DurableWorkActivity conversationId='conv-1' mode='detail' workItemId='goal-1' />);
    expect(screen.getByText('Founder approval · conversation.durableWork.gate.needs_input')).toBeTruthy();
    expect(screen.getByText('Approval receipt')).toBeTruthy();
    expect(screen.getByText('conversation.durableWork.wakeReceiptAbsent')).toBeTruthy();

    uninstall?.();
    needsInput.receipts.wake = {
      version: COMMAND_EVE_ASYNC_COMPLETION_VERSION,
      id: 'wake-1',
      recordedAt: 5_000,
      sequence: 10,
      state: 'accepted',
    };
    installSnapshot([needsInput], 13);
    rerender(<DurableWorkActivity conversationId='conv-1' mode='detail' workItemId='goal-1' />);
    expect(screen.getByText('conversation.durableWork.receiptOutcome.accepted')).toBeTruthy();
  });

  it('marks legacy non-terminal activity reconnect-unavailable and disables unsupported controls', () => {
    render(
      <DurableWorkActivity
        conversationId='conv-1'
        legacyTasks={[
          {
            id: 'legacy-1',
            toolCallId: 'tool-1',
            goal: 'Legacy background work',
            status: 'in_progress',
            taskIndex: 0,
            taskCount: 1,
            createdAt: 1_000,
          },
        ]}
      />
    );

    expect(screen.getByText('conversation.durableWork.status.reconnect_unavailable')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'conversation.durableWork.action.pause:Legacy background work' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'conversation.durableWork.action.cancel:Legacy background work' })
    ).toBeDisabled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('merges a delegation receipt with its chat metadata into one authoritative worker row', () => {
    installSnapshot([workItem('hermes:execution:delegation-1', 'stalled')]);
    act(() => publishLiveDelegation('tool-delegation-1', 'delegation-1', 'Chat-derived release audit'));

    render(
      <DurableWorkActivity
        conversationId='conv-1'
        legacyTasks={[
          {
            id: 'tool-delegation-1:0',
            toolCallId: 'tool-delegation-1',
            delegationId: 'delegation-1',
            goal: 'Chat-derived release audit',
            agentId: 'reviewer',
            status: 'completed',
            taskIndex: 0,
            taskCount: 1,
            createdAt: 1_000,
            observedLive: true,
          },
        ]}
      />
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Chat-derived release audit')).toBeTruthy();
    expect(screen.queryByText('Goal hermes:execution:delegation-1')).toBeNull();
    expect(screen.getByText('conversation.durableWork.status.stalled')).toBeTruthy();
  });

  it('folds a multi-task fan-out into its single receipt-authoritative batch row', () => {
    installSnapshot([workItem('hermes:execution:delegation-batch', 'stalled')]);
    act(() => {
      bindConversationDelegationActivitySession('conv-1', 'session-1');
      publishLiveConversationDelegationActivity('conv-1', {
        id: 'tool-batch-message',
        type: 'acp_tool_call',
        conversation_id: 'conv-1',
        created_at: 1_000,
        content: {
          session_id: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: 'tool-batch',
            status: 'in_progress',
            title: 'delegate: Audit the UI',
            kind: 'execute',
            rawInput: {
              tasks: [
                { goal: 'Audit the UI', role: 'reviewer-a' },
                { goal: 'Audit the core', role: 'reviewer-b' },
                { goal: 'Audit reconnect', role: 'reviewer-a' },
              ],
            },
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: JSON.stringify({ delegation_id: 'delegation-batch', status: 'dispatched', mode: 'background' }),
                },
              },
            ],
          },
        },
      } as IMessageAcpToolCall);
    });

    render(
      <DurableWorkActivity
        conversationId='conv-1'
        legacyTasks={[
          {
            id: 'tool-batch:0',
            toolCallId: 'tool-batch',
            delegationId: 'delegation-batch',
            goal: 'Audit the UI',
            agentId: 'reviewer-a',
            status: 'completed',
            taskIndex: 0,
            taskCount: 3,
            createdAt: 1_000,
            backgroundDispatched: true,
            observedLive: true,
          },
          {
            id: 'tool-batch:1',
            toolCallId: 'tool-batch',
            delegationId: 'delegation-batch',
            goal: 'Audit the core',
            agentId: 'reviewer-b',
            status: 'completed',
            taskIndex: 1,
            taskCount: 3,
            createdAt: 1_000,
            backgroundDispatched: true,
            observedLive: true,
          },
          {
            id: 'tool-batch:2',
            toolCallId: 'tool-batch',
            delegationId: 'delegation-batch',
            goal: 'Audit reconnect',
            agentId: 'reviewer-a',
            status: 'completed',
            taskIndex: 2,
            taskCount: 3,
            createdAt: 1_000,
            backgroundDispatched: true,
            observedLive: true,
          },
        ]}
      />
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Audit the UI · Audit the core · Audit reconnect')).toBeTruthy();
    expect(screen.getByText(/reviewer-a · reviewer-b/)).toBeTruthy();
    expect(screen.getByText('conversation.durableWork.status.stalled')).toBeTruthy();
    expect(screen.queryByText('conversation.durableWork.status.running')).toBeNull();
    expect(screen.queryByText('Goal hermes:execution:delegation-batch')).toBeNull();
  });

  it('does not fold observed legacy metadata into a receipt from a rotated ACP session', () => {
    const receipt = workItem('hermes:execution:delegation-rotation', 'stalled');
    receipt.origin = { ...receipt.origin, sessionId: 'session-b' };
    installSnapshot([receipt]);
    act(() => publishLiveDelegation('tool-rotation', 'delegation-rotation', 'Worker from session A', 'session-a'));

    render(
      <DurableWorkActivity
        conversationId='conv-1'
        legacyTasks={[
          {
            id: 'tool-rotation:0',
            toolCallId: 'tool-rotation',
            delegationId: 'delegation-rotation',
            goal: 'Worker from session A',
            agentId: 'reviewer',
            status: 'in_progress',
            taskIndex: 0,
            taskCount: 1,
            createdAt: 1_000,
            observedLive: true,
          },
        ]}
      />
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Goal hermes:execution:delegation-rotation')).toBeTruthy();
    expect(screen.queryByText('Worker from session A')).toBeNull();
    expect(screen.getByText('conversation.durableWork.status.stalled')).toBeTruthy();
    expect(screen.queryByText('conversation.durableWork.status.running')).toBeNull();
  });

  it('opens the selected worker in the existing workbench callback', () => {
    const open = vi.fn();
    installSnapshot([workItem('workbench-1', 'running')]);
    render(<DurableWorkActivity conversationId='conv-1' onOpen={open} />);

    fireEvent.click(screen.getByRole('button', { name: 'conversation.durableWork.action.open:Goal workbench-1' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'workbench-1' }));
  });

  it('rejects regressive snapshot revisions and per-item sequences', () => {
    const listeners = new Set<() => void>();
    const running = { ...workItem('monotonic-1', 'running'), sequence: 20 };
    let current: DurableWorkSnapshotV1 = {
      version: DURABLE_WORK_ACTIVITY_VERSION,
      conversationId: 'conv-1',
      reconstructedFrom: 'persistent_receipts',
      generatedAt: 20_000,
      revision: 20,
      items: [running],
    };
    uninstall = installDurableWorkActivityAdapter({
      version: DURABLE_WORK_ACTIVITY_VERSION,
      getSnapshot: () => current,
      subscribe: (_conversationId, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      requestAction: vi.fn(),
    });
    render(<DurableWorkActivity conversationId='conv-1' />);
    expect(screen.getByText('conversation.durableWork.status.running')).toBeTruthy();

    act(() => {
      current = { ...current, revision: 19, items: [{ ...running, status: 'failed', sequence: 21 }] };
      listeners.forEach((listener) => listener());
    });
    expect(screen.queryByText('conversation.durableWork.status.failed')).toBeNull();

    act(() => {
      current = { ...current, revision: 21, items: [{ ...running, status: 'failed', sequence: 19 }] };
      listeners.forEach((listener) => listener());
    });
    expect(screen.queryByText('conversation.durableWork.status.failed')).toBeNull();

    act(() => {
      current = { ...current, revision: 22, items: [{ ...running, status: 'failed', sequence: 22 }] };
      listeners.forEach((listener) => listener());
    });
    expect(screen.getByText('conversation.durableWork.status.failed')).toBeTruthy();
  });
});
