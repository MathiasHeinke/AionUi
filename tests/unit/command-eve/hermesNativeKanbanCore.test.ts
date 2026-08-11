import {
  createHermesNativeKanbanTask,
  ensureHermesNativeKanbanBoard,
  updateHermesNativeKanbanTask,
  type HermesNativeKanbanRunner,
} from '@/process/commandEve/hermesNativeKanbanCore';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-native-kanban-'));
  roots.push(root);
  const python = path.join(root, 'python');
  fs.writeFileSync(python, 'fixture');
  return { root, python, home: path.join(root, 'seat-home') };
}

function board(extraTask: Record<string, unknown> = {}) {
  const statuses = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'];
  const task = {
    id: 't_fixture',
    title: 'Fixture task',
    body: 'Body',
    status: 'triage',
    priority: 4,
    assignee: 'worker',
    tenant: null,
    created_at: 10,
    updated_at: null,
    current_run_id: 17,
    session_id: 'session-real',
    project_id: 'project-real',
    goal_mode: true,
    latest_summary: null,
    link_counts: { parents: 0, children: 1 },
    progress: { done: 0, total: 1 },
    ...extraTask,
  };
  const placement = statuses.includes(String(task.status)) ? String(task.status) : 'todo';
  return {
    board: {
      columns: statuses.map((name) => ({ name, tasks: name === placement ? [task] : [] })),
      latest_event_id: 12,
    },
    metadata: { name: 'Command EVE', description: 'Native', project_id: null },
    task,
  };
}

function response(result: Record<string, unknown>) {
  return JSON.stringify({
    ok: true,
    contract: 'command-eve-native-kanban-python/v1',
    hermes_version: '0.20.0',
    result,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Hermes native Kanban adapter', () => {
  it('provisions and reads the canonical eight-column board through the plugin adapter', async () => {
    const fx = fixture();
    const runner = vi.fn<HermesNativeKanbanRunner>(async () => ({
      status: 0,
      stdout: response(board()),
      stderr: '',
    }));

    const result = await ensureHermesNativeKanbanBoard({
      userDataPath: fx.root,
      hermesHome: fx.home,
      pythonExecutable: fx.python,
      runner,
    });

    expect(result.ok).toBe(true);
    expect(result.board?.columns).toHaveLength(8);
    expect(result.board?.columns[0]?.tasks[0]).toMatchObject({
      id: 't_fixture',
      goal_mode: true,
      current_run_id: '17',
      session_id: 'session-real',
      project_id: 'project-real',
    });
    const request = JSON.parse(runner.mock.calls[0]![0].input);
    expect(request).toMatchObject({ operation: 'ensure', board: 'default' });
    expect(runner.mock.calls[0]![0].env).toMatchObject({ HERMES_HOME: fx.home, HERMES_DESKTOP: '1' });
  });

  it('creates a real goal task with an idempotency key, never a second record store', async () => {
    const fx = fixture();
    const runner = vi.fn<HermesNativeKanbanRunner>(async () => ({
      status: 0,
      stdout: response(board()),
      stderr: '',
    }));

    const result = await createHermesNativeKanbanTask(
      {
        title: 'Durable goal',
        body: 'Acceptance criteria',
        idempotency_key: 'intent-1',
        record_kind: 'goal',
      },
      { userDataPath: fx.root, hermesHome: fx.home, pythonExecutable: fx.python, runner }
    );

    expect(result.ok).toBe(true);
    const request = JSON.parse(runner.mock.calls[0]![0].input);
    expect(request.operation).toBe('create');
    expect(request.payload).toMatchObject({
      title: 'Durable goal',
      idempotency_key: 'intent-1',
      goal_mode: true,
      workspace_kind: 'scratch',
    });
  });

  it('joins the upstream update route to one canonical write transaction before checking lifecycle ownership', async () => {
    const fx = fixture();
    const runner = vi.fn<HermesNativeKanbanRunner>(async (request) => {
      const script = request.args[1] || '';
      const transaction = script.indexOf('with original_write_txn(connection):');
      const guard = script.indexOf('if current.status not in OPERATOR_MUTABLE_SOURCE_STATUSES:');
      const route = script.indexOf('return plugin_api.update_task(');
      expect(transaction).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(transaction);
      expect(route).toBeGreaterThan(guard);
      expect(script).toContain('plugin_api._conn = lambda board=None: proxy');
      expect(script).toContain('kanban_db.write_txn = joined_write_txn');
      expect(script).not.toContain('existing = plugin_api.get_task(');
      return {
        status: 0,
        stdout: response(board({ status: 'todo', title: 'Atomic update' })),
        stderr: '',
      };
    });

    const result = await updateHermesNativeKanbanTask(
      { task_id: 't_fixture', title: 'Atomic update', status: 'todo' },
      { userDataPath: fx.root, hermesHome: fx.home, pythonExecutable: fx.python, runner }
    );

    expect(result).toMatchObject({ ok: true, task: { status: 'todo', title: 'Atomic update' } });
  });

  it('fails closed on an unknown upstream task status', async () => {
    const fx = fixture();
    const runner: HermesNativeKanbanRunner = async () => ({
      status: 0,
      stdout: response(board({ status: 'future-unsafe-status' })),
      stderr: '',
    });

    const result = await ensureHermesNativeKanbanBoard({
      userDataPath: fx.root,
      hermesHome: fx.home,
      pythonExecutable: fx.python,
      runner,
    });

    expect(result).toMatchObject({
      ok: false,
      state: 'failed',
      reason_code: 'HERMES_KANBAN_RESPONSE_INVALID',
    });
  });

  it.each(['scheduled', 'ready', 'running', 'blocked', 'review', 'done'] as const)(
    'refuses a renderer attempt to place a card directly into upstream-owned state %s',
    async (status) => {
      const fx = fixture();
      const runner = vi.fn<HermesNativeKanbanRunner>();
      const result = await updateHermesNativeKanbanTask(
        { task_id: 't_fixture', status },
        { userDataPath: fx.root, hermesHome: fx.home, pythonExecutable: fx.python, runner }
      );

      expect(result).toMatchObject({ ok: false, state: 'blocked', reason_code: 'KANBAN_UPDATE_INVALID' });
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it.each([{ block_reason: 'no-op' }, { summary: 'no-op' }])(
    'fails closed on renderer fields that have no allowed operator transition: %j',
    async (inertField) => {
      const fx = fixture();
      const runner = vi.fn<HermesNativeKanbanRunner>();
      const request = { task_id: 't_fixture', ...inertField } as unknown as Parameters<
        typeof updateHermesNativeKanbanTask
      >[0];

      const result = await updateHermesNativeKanbanTask(request, {
        userDataPath: fx.root,
        hermesHome: fx.home,
        pythonExecutable: fx.python,
        runner,
      });

      expect(result).toMatchObject({ ok: false, state: 'blocked', reason_code: 'KANBAN_UPDATE_INVALID' });
      expect(runner).not.toHaveBeenCalled();
    }
  );
});
