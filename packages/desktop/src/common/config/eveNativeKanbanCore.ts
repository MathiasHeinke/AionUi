/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Renderer-safe projection of Hermes 0.20's canonical Kanban plugin API. */

export const COMMAND_EVE_NATIVE_KANBAN_VERSION = 'command-eve-native-kanban/v1' as const;

export const COMMAND_EVE_NATIVE_KANBAN_STATUSES = [
  'triage',
  'todo',
  'scheduled',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
] as const;

export type CommandEveNativeKanbanStatus = (typeof COMMAND_EVE_NATIVE_KANBAN_STATUSES)[number];

export type CommandEveNativeKanbanTask = {
  id: string;
  title: string;
  body: string | null;
  status: CommandEveNativeKanbanStatus;
  priority: number;
  assignee: string | null;
  tenant: string | null;
  created_at: number;
  updated_at: number | null;
  current_run_id: string | null;
  session_id: string | null;
  project_id: string | null;
  goal_mode: boolean;
  latest_summary: string | null;
  link_counts: { parents: number; children: number };
  progress: { done: number; total: number } | null;
};

export type CommandEveNativeKanbanColumn = {
  name: CommandEveNativeKanbanStatus;
  tasks: CommandEveNativeKanbanTask[];
};

export type CommandEveNativeKanbanBoard = {
  slug: string;
  name: string;
  description: string;
  project_id: string | null;
  columns: CommandEveNativeKanbanColumn[];
  latest_event_id: number;
  task_count: number;
};

export type CommandEveNativeKanbanResult = {
  version: typeof COMMAND_EVE_NATIVE_KANBAN_VERSION;
  ok: boolean;
  state: 'ready' | 'needs_user' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  board?: CommandEveNativeKanbanBoard;
  task?: CommandEveNativeKanbanTask;
  source: {
    adapter: 'hermes-plugin-api';
    hermes_version: string | null;
    board_slug: string;
    home_scope_id: string;
    seat_scope: 'active-hermes-home';
  };
};

export type CommandEveNativeKanbanCreateRequest = {
  title: string;
  body?: string;
  assignee?: string;
  priority?: number;
  parents?: string[];
  triage?: boolean;
  idempotency_key: string;
  record_kind?: 'task' | 'goal';
};

export type CommandEveNativeKanbanUpdateRequest = {
  task_id: string;
  status?: CommandEveNativeKanbanStatus;
  title?: string;
  body?: string;
  assignee?: string;
  priority?: number;
};
