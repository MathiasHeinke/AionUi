import {
  createHermesNativeKanbanTask,
  ensureHermesNativeKanbanBoard,
  readHermesNativeKanbanBoard,
  updateHermesNativeKanbanTask,
} from '@/process/commandEve/hermesNativeKanbanCore';
import {
  captureNativeKanbanSeatScope,
  nativeKanbanSeatScopeStillActive,
  type NativeKanbanSeatScope,
} from '@/process/commandEve/nativeKanbanSeatScopeCore';
import { __resetActiveSeatForTests, setActiveSeatId } from '@/process/commandEve/seatContextCore';
import { prepareHermesWheelOverlay, type HermesWheelOverlay } from './helpers/hermesWheelOverlay';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const python = process.env.COMMAND_EVE_HERMES_PYTHON || '';
const hermesWheel = process.env.COMMAND_EVE_HERMES_WHEEL || '';
const runReal = Boolean(python && fs.existsSync(python) && hermesWheel && fs.existsSync(hermesWheel));
const ACCOUNT_SEAT_ID = '11111111-1111-4111-8111-111111111111';
const SEED_SEAT_ID = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!runReal)('native Hermes 0.20 Kanban integration', () => {
  let root = '';
  let accountHome = '';
  let seedHome = '';
  let overlay: HermesWheelOverlay;
  let previousPythonPath: string | undefined;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-native-kanban-real-'));
    overlay = prepareHermesWheelOverlay(python, hermesWheel);
    previousPythonPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = overlay.pythonPath;
  });

  afterAll(() => {
    __resetActiveSeatForTests();
    if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPythonPath;
    overlay?.dispose();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('provisions, creates, updates, moves, restarts and isolates Account from Seed', async () => {
    const options = (scope: NativeKanbanSeatScope) => ({
      ...scope,
      pythonExecutable: python,
    });

    setActiveSeatId(ACCOUNT_SEAT_ID);
    const accountScope = captureNativeKanbanSeatScope(root);
    accountHome = accountScope.hermesHome;
    expect(nativeKanbanSeatScopeStillActive(accountScope)).toBe(true);
    const account = await ensureHermesNativeKanbanBoard(options(accountScope));

    setActiveSeatId(SEED_SEAT_ID);
    expect(nativeKanbanSeatScopeStillActive(accountScope)).toBe(false);
    const seedScope = captureNativeKanbanSeatScope(root);
    seedHome = seedScope.hermesHome;
    expect(nativeKanbanSeatScopeStillActive(seedScope)).toBe(true);
    const seed = await ensureHermesNativeKanbanBoard(options(seedScope));
    expect(account).toMatchObject({ ok: true, state: 'ready', source: { hermes_version: '0.20.0' } });
    expect(seed).toMatchObject({ ok: true, state: 'ready', source: { hermes_version: '0.20.0' } });
    expect(account.source.home_scope_id).not.toBe(seed.source.home_scope_id);

    setActiveSeatId(ACCOUNT_SEAT_ID);
    const activeAccountScope = captureNativeKanbanSeatScope(root);
    expect(activeAccountScope.hermesHome).toBe(accountHome);
    const created = await createHermesNativeKanbanTask(
      {
        title: 'Account durable goal',
        body: 'Local integration acceptance criteria',
        assignee: 'worker',
        triage: true,
        record_kind: 'goal',
        idempotency_key: 'account-goal-proof-v1',
      },
      options(activeAccountScope)
    );
    expect(created).toMatchObject({ ok: true, task: { goal_mode: true, status: 'triage' } });
    const taskId = created.task?.id || '';
    expect(taskId).toMatch(/^t_/);

    const updated = await updateHermesNativeKanbanTask(
      { task_id: taskId, title: 'Account durable goal updated', status: 'todo' },
      options(activeAccountScope)
    );
    expect(updated).toMatchObject({
      ok: true,
      task: { id: taskId, title: 'Account durable goal updated', status: 'todo', goal_mode: true },
    });

    // Seed the worker lifecycle through Hermes' own kanban_db API. This is not
    // an application-side schema or store: it proves that the native board
    // projection links a real claimed run and durable session back to its card.
    const workerId = childProcess
      .execFileSync(
        python,
        [
          '-c',
          [
            'from hermes_cli import kanban_db',
            'conn = kanban_db.connect()',
            'task_id = kanban_db.create_task(conn, title="Account worker run", initial_status="running", session_id="session-real", idempotency_key="worker-run-proof-v1")',
            'assert kanban_db.claim_task(conn, task_id, claimer="worker-real") is not None',
            'print(task_id)',
          ].join('; '),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, HERMES_HOME: accountHome, HERMES_KANBAN_BOARD: 'default', HERMES_DESKTOP: '1' },
          timeout: 30_000,
        }
      )
      .trim();
    expect(workerId).toMatch(/^t_/);

    const lifecycleEdit = await updateHermesNativeKanbanTask(
      { task_id: workerId, title: 'Operator must not rewrite an active worker', status: 'todo' },
      options(activeAccountScope)
    );
    expect(lifecycleEdit).toMatchObject({
      ok: false,
      state: 'blocked',
      reason_code: 'HERMES_KANBAN_OPERATION_REJECTED',
    });

    // Every adapter call above ran in a fresh Python process. This read is the
    // process-restart proof: state must come from the canonical SQLite file.
    setActiveSeatId(ACCOUNT_SEAT_ID);
    const accountAfterRestart = await readHermesNativeKanbanBoard(options(captureNativeKanbanSeatScope(root)));
    setActiveSeatId(SEED_SEAT_ID);
    const seedAfterRestart = await readHermesNativeKanbanBoard(options(captureNativeKanbanSeatScope(root)));
    expect(accountAfterRestart.board?.task_count).toBe(2);
    expect(accountAfterRestart.board?.columns.find((column) => column.name === 'todo')?.tasks[0]).toMatchObject({
      id: taskId,
      title: 'Account durable goal updated',
    });
    expect(accountAfterRestart.board?.columns.find((column) => column.name === 'running')?.tasks[0]).toMatchObject({
      id: workerId,
      current_run_id: '1',
      session_id: 'session-real',
      goal_mode: false,
    });
    expect(seedAfterRestart.board?.task_count).toBe(0);

    expect(fs.existsSync(path.join(accountHome, 'kanban.db'))).toBe(true);
    expect(fs.existsSync(path.join(seedHome, 'kanban.db'))).toBe(true);
    expect(fs.realpathSync(path.join(accountHome, 'kanban.db'))).not.toBe(
      fs.realpathSync(path.join(seedHome, 'kanban.db'))
    );
  });
});
