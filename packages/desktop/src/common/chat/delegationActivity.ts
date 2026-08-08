/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from './chatLib';

export type DelegatedTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type DelegatedTaskProjection = {
  id: string;
  toolCallId: string;
  goal: string;
  status: DelegatedTaskStatus;
  agentId?: string;
  taskIndex: number;
  taskCount: number;
  createdAt: number;
};

type DelegationToolInput = {
  toolCallId: string;
  toolName?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  createdAt?: number;
};

const compactString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const compact = value.trim().replace(/\s+/g, ' ');
  return compact || undefined;
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const normalizeStatus = (value: string | undefined): DelegatedTaskStatus => {
  switch (value) {
    case 'completed':
    case 'Success':
      return 'completed';
    case 'failed':
    case 'error':
    case 'Error':
    case 'Canceled':
      return 'failed';
    case 'in_progress':
    case 'running':
    case 'Executing':
    case 'Confirming':
      return 'in_progress';
    default:
      return 'pending';
  }
};

const isDelegationTool = (toolName?: string, title?: string): boolean => {
  const name = compactString(toolName)?.toLowerCase().replace(/[ -]+/g, '_');
  if (name === 'delegate_task' || name === 'delegate') return true;
  const normalizedTitle = compactString(title)?.toLowerCase();
  return (
    normalizedTitle === 'delegate task' ||
    normalizedTitle === 'delegate_task' ||
    normalizedTitle === 'delegate' ||
    normalizedTitle?.startsWith('delegate:') === true
  );
};

const agentIdOf = (input: Record<string, unknown> | undefined): string | undefined =>
  compactString(input?.agent_id ?? input?.agentId ?? input?.role_agent_id ?? input?.role);

const fallbackGoalFromTitle = (title?: string): string => {
  const compact = compactString(title);
  if (!compact) return 'Delegated task';
  return compact.replace(/^delegate(?:[_ ]task)?\s*:\s*/i, '').replace(/^delegate task$/i, 'Delegated task');
};

export function projectDelegatedTasks(input: DelegationToolInput): DelegatedTaskProjection[] {
  if (!input.toolCallId || !isDelegationTool(input.toolName, input.title)) return [];

  const rawInput = recordOf(input.rawInput);
  const rootAgentId = agentIdOf(rawInput);
  const rawTasks = Array.isArray(rawInput?.tasks) ? rawInput.tasks.map(recordOf).filter(Boolean) : [];
  const taskInputs = rawTasks.length > 0 ? rawTasks : [rawInput];
  const taskCount = taskInputs.length;
  const fallbackGoal = fallbackGoalFromTitle(input.title || input.toolName);

  return taskInputs.map((task, taskIndex) => ({
    id: `${input.toolCallId}:${taskIndex}`,
    toolCallId: input.toolCallId,
    goal: compactString(task?.goal ?? task?.task ?? task?.description) || fallbackGoal,
    status: normalizeStatus(input.status),
    agentId: agentIdOf(task) || rootAgentId,
    taskIndex,
    taskCount,
    createdAt: input.createdAt ?? 0,
  }));
}

export function projectDelegatedTasksFromMessage(message: TMessage): DelegatedTaskProjection[] {
  if (message.type === 'acp_tool_call') {
    const update = message.content?.update;
    if (!update) return [];
    return projectDelegatedTasks({
      toolCallId: update.tool_call_id,
      toolName: update.kind,
      title: update.title,
      status: update.status,
      rawInput: update.rawInput,
      createdAt: message.created_at,
    });
  }

  if (message.type === 'tool_call') {
    return projectDelegatedTasks({
      toolCallId: message.content.call_id,
      toolName: message.content.name,
      title: message.content.name,
      status: message.content.status,
      rawInput: message.content.input ?? message.content.args,
      createdAt: message.created_at,
    });
  }

  if (message.type === 'tool_group') {
    return message.content.flatMap((tool) =>
      projectDelegatedTasks({
        toolCallId: tool.call_id,
        toolName: tool.name,
        title: tool.description || tool.name,
        status: tool.status,
        createdAt: message.created_at,
      })
    );
  }

  return [];
}
