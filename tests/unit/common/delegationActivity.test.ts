import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall, IMessageToolCall } from '@/common/chat/chatLib';
import { projectDelegatedTasksFromMessage } from '@/common/chat/delegationActivity';

describe('delegation activity projection', () => {
  it('recognizes the real Hermes ACP delegate title even though its ACP kind is execute', () => {
    const message = {
      id: 'msg-1',
      type: 'acp_tool_call',
      conversation_id: 'conv-1',
      created_at: 100,
      content: {
        session_id: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          tool_call_id: 'tc-1',
          kind: 'execute',
          title: 'delegate: Audit the release flow',
          status: 'in_progress',
          rawInput: { goal: 'Audit the release flow' },
        },
      },
    } as IMessageAcpToolCall;

    expect(projectDelegatedTasksFromMessage(message)).toEqual([
      expect.objectContaining({
        id: 'tc-1:0',
        goal: 'Audit the release flow',
        status: 'in_progress',
        taskCount: 1,
      }),
    ]);
  });

  it('projects Hermes’ pre-dispatch delegate validation failure even without structured output', () => {
    const message = {
      id: 'msg-pre-dispatch-failed',
      type: 'acp_tool_call',
      conversation_id: 'conv-1',
      created_at: 300,
      content: {
        session_id: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          tool_call_id: 'tc-pre-dispatch-failed',
          kind: 'execute',
          title: 'delegate: Recherche für einen AAA-Forschungsbericht',
          status: 'failed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Delegation failed: Batch mode requires at least 2 tasks. For a single task, use the goal parameter instead of tasks.',
              },
            },
          ],
        },
      },
    } as IMessageAcpToolCall;

    expect(projectDelegatedTasksFromMessage(message)).toEqual([
      expect.objectContaining({
        id: 'tc-pre-dispatch-failed:0',
        goal: 'Recherche für einen AAA-Forschungsbericht',
        status: 'failed',
        taskCount: 1,
        createdAt: 300,
      }),
    ]);
  });

  it('expands a Hermes batch delegation without inventing worker identities', () => {
    const message = {
      id: 'msg-2',
      type: 'tool_call',
      conversation_id: 'conv-1',
      created_at: 200,
      content: {
        call_id: 'tc-2',
        name: 'delegate_task',
        status: 'completed',
        args: {
          tasks: [{ goal: 'Review UX' }, { goal: 'Review transport' }, { goal: 'Review tests' }],
        },
      },
    } as IMessageToolCall;

    const tasks = projectDelegatedTasksFromMessage(message);
    expect(tasks.map((task) => task.goal)).toEqual(['Review UX', 'Review transport', 'Review tests']);
    expect(tasks.every((task) => task.agentId === undefined)).toBe(true);
    expect(tasks.every((task) => task.taskCount === 3 && task.status === 'completed')).toBe(true);
  });

  it('ignores ordinary execute calls', () => {
    const message = {
      id: 'msg-3',
      type: 'acp_tool_call',
      conversation_id: 'conv-1',
      content: {
        session_id: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          tool_call_id: 'tc-3',
          kind: 'execute',
          title: 'terminal: bun test',
          status: 'in_progress',
          rawInput: { command: 'bun test' },
        },
      },
    } as IMessageAcpToolCall;

    expect(projectDelegatedTasksFromMessage(message)).toEqual([]);
  });
});
