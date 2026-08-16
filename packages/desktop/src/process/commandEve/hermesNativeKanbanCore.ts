/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin MAIN-process adapter over Hermes 0.20's canonical Kanban plugin routes.
 *
 * This module owns no schema and issues no application-side SQL. Every
 * operation runs inside the app-managed Hermes venv and calls the same
 * `plugins.kanban.dashboard.plugin_api` handlers used by Hermes Desktop. The
 * update path joins that handler to one canonical `kanban_db.write_txn` so the
 * operator-status guard and mutation are atomic with dispatcher claims.
 */

import {
  COMMAND_EVE_NATIVE_KANBAN_STATUSES,
  COMMAND_EVE_NATIVE_KANBAN_VERSION,
  type CommandEveNativeKanbanBoard,
  type CommandEveNativeKanbanCreateRequest,
  type CommandEveNativeKanbanResult,
  type CommandEveNativeKanbanStatus,
  type CommandEveNativeKanbanTask,
  type CommandEveNativeKanbanUpdateRequest,
} from '@/common/config/eveNativeKanbanCore';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCommandEveRuntimeBootstrapPaths } from './runtimeBootstrapCore';

const NATIVE_KANBAN_TIMEOUT_MS = 30_000;
const NATIVE_KANBAN_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const BOARD_SLUG = 'default';
const OPERATOR_TARGET_STATUSES = new Set<CommandEveNativeKanbanStatus>(['triage', 'todo']);

const HERMES_KANBAN_ADAPTER = String.raw`
import importlib.metadata
import contextlib
import json
import os
import sys
import types

# Hermes ships the dashboard route module under its optional web extra.
# Command EVE invokes the plain route functions without running an HTTP server,
# so a base runtime needs only no-op decorator/type shims. The business logic,
# models and every Kanban mutation still come from the official plugin module.
try:
    from fastapi import HTTPException
except ModuleNotFoundError as exc:
    if exc.name != "fastapi":
        raise

    fastapi_stub = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(str(detail))
            self.status_code = status_code
            self.detail = detail

    class APIRouter:
        def _route(self, *_args, **_kwargs):
            return lambda function: function

        get = _route
        post = _route
        put = _route
        patch = _route
        delete = _route
        websocket = _route

    class WebSocket:
        pass

    class WebSocketDisconnect(Exception):
        pass

    class UploadFile:
        pass

    class FileResponse:
        def __init__(self, path, *_args, **_kwargs):
            self.path = path

    def parameter(default=None, *_args, **_kwargs):
        return default

    fastapi_stub.__path__ = []
    fastapi_stub.APIRouter = APIRouter
    fastapi_stub.File = parameter
    fastapi_stub.Form = parameter
    fastapi_stub.HTTPException = HTTPException
    fastapi_stub.Query = parameter
    fastapi_stub.UploadFile = UploadFile
    fastapi_stub.WebSocket = WebSocket
    fastapi_stub.WebSocketDisconnect = WebSocketDisconnect
    fastapi_stub.status = types.SimpleNamespace(WS_1008_POLICY_VIOLATION=1008)
    responses_stub = types.ModuleType("fastapi.responses")
    responses_stub.FileResponse = FileResponse
    sys.modules["fastapi"] = fastapi_stub
    sys.modules["fastapi.responses"] = responses_stub

from hermes_cli import kanban_db
from plugins.kanban.dashboard import plugin_api

CONTRACT = "command-eve-native-kanban-python/v1"
OPERATOR_MUTABLE_SOURCE_STATUSES = {"triage", "todo", "blocked"}

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def board_view(slug):
    board = plugin_api.get_board(
        tenant=None,
        include_archived=False,
        board=slug,
        workflow_template_id=None,
        current_step_key=None,
    )
    return {
        "board": board,
        "metadata": kanban_db.read_board_metadata(slug),
    }

class NonClosingConnection:
    """Let the upstream route use one caller-owned canonical connection."""

    def __init__(self, connection):
        self._connection = connection

    def __getattr__(self, name):
        return getattr(self._connection, name)

    def close(self):
        # plugin_api.update_task owns connections in normal route use. The
        # adapter owns this one until the outer transaction commits.
        return None

def update_task_atomically(task_id, payload, slug):
    original_conn_factory = getattr(plugin_api, "_conn", None)
    original_write_txn = getattr(kanban_db, "write_txn", None)
    if not callable(original_conn_factory) or not callable(original_write_txn):
        raise HTTPException(status_code=503, detail="Hermes atomic update contract unavailable")

    connection = kanban_db.connect(board=slug)
    proxy = NonClosingConnection(connection)

    @contextlib.contextmanager
    def joined_write_txn(_connection):
        # The outer canonical BEGIN IMMEDIATE already serializes every write in
        # this isolated adapter process. Nested Hermes helpers must join it.
        yield proxy

    try:
        with original_write_txn(connection):
            current = kanban_db.get_task(connection, task_id)
            if current is None:
                raise HTTPException(status_code=404, detail=f"task {task_id} not found")
            if current.status not in OPERATOR_MUTABLE_SOURCE_STATUSES:
                raise HTTPException(status_code=409, detail="task is lifecycle-owned and read-only")

            # Reuse the exact upstream route and helper lifecycle. Rebinding is
            # process-local and always restored before the outer commit.
            plugin_api._conn = lambda board=None: proxy
            kanban_db.write_txn = joined_write_txn
            try:
                return plugin_api.update_task(task_id, plugin_api.UpdateTaskBody(**payload), board=slug)
            finally:
                plugin_api._conn = original_conn_factory
                kanban_db.write_txn = original_write_txn
    finally:
        plugin_api._conn = original_conn_factory
        kanban_db.write_txn = original_write_txn
        connection.close()

try:
    request = json.loads(sys.stdin.read())
    if not isinstance(request, dict) or request.get("contract") != CONTRACT:
        raise ValueError("unknown adapter contract")
    operation = request.get("operation")
    slug = kanban_db._normalize_board_slug(request.get("board")) or kanban_db.DEFAULT_BOARD

    if operation in {"ensure", "read"}:
        if slug != kanban_db.DEFAULT_BOARD and not kanban_db.board_exists(slug):
            kanban_db.create_board(slug, name=request.get("board_name"))
        kanban_db.init_db(board=slug)
        result = board_view(slug)
    elif operation == "create":
        kanban_db.init_db(board=slug)
        payload = request.get("payload") or {}
        result = plugin_api.create_task(plugin_api.CreateTaskBody(**payload), board=slug)
        result.update(board_view(slug))
    elif operation == "update":
        kanban_db.init_db(board=slug)
        payload = request.get("payload") or {}
        task_id = str(request.get("task_id") or "")
        result = update_task_atomically(task_id, payload, slug)
        result.update(board_view(slug))
    elif operation == "get":
        result = plugin_api.get_task(
            str(request.get("task_id") or ""),
            board=slug,
            run_state_type=None,
            run_state_name=None,
        )
    else:
        raise ValueError("unknown kanban operation")

    try:
        hermes_version = importlib.metadata.version("hermes-agent")
    except Exception:
        hermes_version = None
    emit({"ok": True, "contract": CONTRACT, "hermes_version": hermes_version, "result": result})
except HTTPException as exc:
    emit({"ok": False, "contract": CONTRACT, "error": str(exc.detail), "status_code": int(exc.status_code)})
except Exception as exc:
    emit({"ok": False, "contract": CONTRACT, "error": str(exc), "error_type": type(exc).__name__})
`;

export type HermesNativeKanbanRunnerRequest = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
};

export type HermesNativeKanbanRunnerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type HermesNativeKanbanRunner = (
  request: HermesNativeKanbanRunnerRequest
) => Promise<HermesNativeKanbanRunnerResult>;

export type HermesNativeKanbanOptions = {
  userDataPath: string;
  hermesHome?: string;
  pythonExecutable?: string;
  runner?: HermesNativeKanbanRunner;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
};

type AdapterPayload = {
  ok?: unknown;
  contract?: unknown;
  hermes_version?: unknown;
  error?: unknown;
  result?: unknown;
};

const defaultRunner: HermesNativeKanbanRunner = (request) =>
  new Promise((resolve) => {
    const child = childProcess.spawn(request.executable, request.args, {
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (result: HermesNativeKanbanRunnerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-NATIVE_KANBAN_MAX_OUTPUT_BYTES);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => finish({ status: null, stdout, stderr, error: error.message }));
    child.on('close', (status) => finish({ status, stdout, stderr }));
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: null, stdout, stderr, error: 'Hermes Kanban adapter timed out.' });
    }, request.timeoutMs);
    child.stdin.end(request.input);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function nullableText(value: unknown, max = 512): string | null {
  const text = boundedText(value, max);
  return text || null;
}

function nullableIdentifier(value: unknown, max = 160): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return nullableText(value, max);
}

function finiteInteger(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function normalizeTask(value: unknown): CommandEveNativeKanbanTask | null {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id, 160);
  const title = boundedText(value.title, 500);
  const status = boundedText(value.status, 32) as CommandEveNativeKanbanStatus;
  if (!id || !title || !COMMAND_EVE_NATIVE_KANBAN_STATUSES.includes(status)) return null;
  const rawLinks = isRecord(value.link_counts) ? value.link_counts : {};
  const rawProgress = isRecord(value.progress) ? value.progress : null;
  return {
    id,
    title,
    body: nullableText(value.body, 20_000),
    status,
    priority: finiteInteger(value.priority),
    assignee: nullableText(value.assignee, 160),
    tenant: nullableText(value.tenant, 160),
    created_at: finiteInteger(value.created_at),
    updated_at: typeof value.updated_at === 'number' ? finiteInteger(value.updated_at) : null,
    current_run_id: nullableIdentifier(value.current_run_id),
    session_id: nullableText(value.session_id, 160),
    project_id: nullableText(value.project_id, 160),
    goal_mode: value.goal_mode === true || value.goal_mode === 1,
    latest_summary: nullableText(value.latest_summary, 2_000),
    link_counts: {
      parents: Math.max(0, finiteInteger(rawLinks.parents)),
      children: Math.max(0, finiteInteger(rawLinks.children)),
    },
    progress: rawProgress
      ? {
          done: Math.max(0, finiteInteger(rawProgress.done)),
          total: Math.max(0, finiteInteger(rawProgress.total)),
        }
      : null,
  };
}

function normalizeBoard(value: unknown, slug: string): CommandEveNativeKanbanBoard | null {
  if (!isRecord(value) || !isRecord(value.board)) return null;
  const boardPayload = value.board;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const rawColumns = boardPayload.columns;
  if (!Array.isArray(rawColumns)) return null;
  const upstreamColumnNames = rawColumns.map((entry) => (isRecord(entry) ? boundedText(entry.name, 32) : ''));
  if (
    upstreamColumnNames.length !== COMMAND_EVE_NATIVE_KANBAN_STATUSES.length ||
    new Set(upstreamColumnNames).size !== COMMAND_EVE_NATIVE_KANBAN_STATUSES.length ||
    upstreamColumnNames.some(
      (name) => !COMMAND_EVE_NATIVE_KANBAN_STATUSES.includes(name as CommandEveNativeKanbanStatus)
    )
  ) {
    return null;
  }
  const seen = new Set<string>();
  const columns = COMMAND_EVE_NATIVE_KANBAN_STATUSES.map((name) => {
    const candidate = rawColumns.find((entry) => isRecord(entry) && boundedText(entry.name, 32) === name);
    const tasks: CommandEveNativeKanbanTask[] = [];
    if (isRecord(candidate) && Array.isArray(candidate.tasks)) {
      for (const raw of candidate.tasks.slice(0, 2_000)) {
        const task = normalizeTask(raw);
        if (!task || seen.has(task.id)) continue;
        seen.add(task.id);
        tasks.push(task);
      }
    }
    return { name, tasks };
  });
  const knownTaskCount = columns.reduce((sum, column) => sum + column.tasks.length, 0);
  const rawTaskCount = rawColumns.reduce((sum: number, entry: unknown) => {
    if (!isRecord(entry) || !Array.isArray(entry.tasks)) return sum;
    return sum + entry.tasks.length;
  }, 0);
  if (knownTaskCount !== rawTaskCount) return null;
  return {
    slug,
    name: boundedText(metadata.name, 160) || 'Default',
    description: boundedText(metadata.description, 1_000),
    project_id: nullableText(metadata.project_id, 160),
    columns,
    latest_event_id: finiteInteger(boardPayload.latest_event_id),
    task_count: knownTaskCount,
  };
}

function sourceFor(home: string, hermesVersion: string | null) {
  return {
    adapter: 'hermes-plugin-api' as const,
    hermes_version: hermesVersion,
    board_slug: BOARD_SLUG,
    home_scope_id: home
      ? crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)
      : 'unavailable',
    seat_scope: 'active-hermes-home' as const,
  };
}

function failure(
  home: string,
  reasonCode: string,
  message: string,
  state: CommandEveNativeKanbanResult['state'] = 'failed'
): CommandEveNativeKanbanResult {
  return {
    version: COMMAND_EVE_NATIVE_KANBAN_VERSION,
    ok: false,
    state,
    reason_code: reasonCode,
    message,
    source: sourceFor(home, null),
  };
}

function resolveExecution(options: HermesNativeKanbanOptions): {
  hermesHome: string;
  python: string;
  env: NodeJS.ProcessEnv;
} {
  const platform = options.platform ?? process.platform;
  const paths = resolveCommandEveRuntimeBootstrapPaths(options.userDataPath, undefined, platform);
  const hermesHome = path.resolve(options.hermesHome ?? paths.hermesHome);
  const python = path.resolve(
    options.pythonExecutable ??
      (platform === 'win32'
        ? path.join(paths.hermesVenv, 'Scripts', 'python.exe')
        : path.join(paths.hermesVenv, 'bin', 'python'))
  );
  return {
    hermesHome,
    python,
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      HERMES_KANBAN_BOARD: BOARD_SLUG,
      HERMES_DESKTOP: '1',
    },
  };
}

async function invokeAdapter(
  operation: 'ensure' | 'read' | 'create' | 'update' | 'get',
  payload: Record<string, unknown>,
  options: HermesNativeKanbanOptions
): Promise<CommandEveNativeKanbanResult> {
  let execution: ReturnType<typeof resolveExecution>;
  try {
    execution = resolveExecution(options);
  } catch (error) {
    return failure('', 'KANBAN_SEAT_SCOPE_INVALID', error instanceof Error ? error.message : 'Seat scope is invalid.');
  }
  if (!fs.existsSync(execution.python)) {
    return failure(
      execution.hermesHome,
      'HERMES_RUNTIME_NOT_READY',
      'The app-managed Hermes runtime is not ready.',
      'needs_user'
    );
  }
  const request = JSON.stringify({
    contract: 'command-eve-native-kanban-python/v1',
    operation,
    board: BOARD_SLUG,
    board_name: 'Command EVE',
    ...payload,
  });
  const result = await (options.runner ?? defaultRunner)({
    executable: execution.python,
    args: ['-c', HERMES_KANBAN_ADAPTER],
    env: execution.env,
    input: request,
    timeoutMs: options.timeoutMs ?? NATIVE_KANBAN_TIMEOUT_MS,
  });
  let parsed: AdapterPayload;
  try {
    parsed = JSON.parse(result.stdout.trim()) as AdapterPayload;
  } catch {
    return failure(
      execution.hermesHome,
      'HERMES_KANBAN_ADAPTER_UNAVAILABLE',
      result.error || result.stderr.trim().slice(0, 1_000) || 'Hermes did not return a Kanban payload.'
    );
  }
  const hermesVersion = nullableText(parsed.hermes_version, 80);
  if (parsed.contract !== 'command-eve-native-kanban-python/v1' || parsed.ok !== true) {
    return failure(
      execution.hermesHome,
      'HERMES_KANBAN_OPERATION_REJECTED',
      boundedText(parsed.error, 1_000) || 'Hermes rejected the Kanban operation.',
      'blocked'
    );
  }
  const rawResult = isRecord(parsed.result) ? parsed.result : {};
  const board = normalizeBoard(rawResult, BOARD_SLUG);
  const task = normalizeTask(rawResult.task);
  if ((operation === 'ensure' || operation === 'read' || operation === 'create' || operation === 'update') && !board) {
    return failure(
      execution.hermesHome,
      'HERMES_KANBAN_RESPONSE_INVALID',
      'Hermes returned an unknown board column, task status, or response shape.'
    );
  }
  return {
    version: COMMAND_EVE_NATIVE_KANBAN_VERSION,
    ok: true,
    state: 'ready',
    ...(board ? { board } : {}),
    ...(task ? { task } : {}),
    source: sourceFor(execution.hermesHome, hermesVersion),
  };
}

function normalizeCreate(request: CommandEveNativeKanbanCreateRequest): Record<string, unknown> | null {
  const title = boundedText(request.title, 500);
  const idempotencyKey = boundedText(request.idempotency_key, 256);
  if (!title || !idempotencyKey) return null;
  const parents = Array.isArray(request.parents)
    ? request.parents
        .map((parent) => boundedText(parent, 160))
        .filter(Boolean)
        .slice(0, 100)
    : [];
  return {
    title,
    body: boundedText(request.body, 20_000) || null,
    assignee: boundedText(request.assignee, 160) || null,
    priority: Math.max(-100, Math.min(100, finiteInteger(request.priority))),
    parents,
    // A renderer-created card is always triage-only. Dispatchable lifecycle
    // states are owned by Hermes + the Command EVE authority/controller path.
    triage: true,
    idempotency_key: idempotencyKey,
    goal_mode: request.record_kind === 'goal',
    workspace_kind: 'scratch',
  };
}

function normalizeUpdate(request: CommandEveNativeKanbanUpdateRequest): {
  taskId: string;
  payload: Record<string, unknown>;
} | null {
  const taskId = boundedText(request.task_id, 160);
  if (!taskId) return null;
  const payload: Record<string, unknown> = {};
  if (request.status !== undefined) {
    if (!COMMAND_EVE_NATIVE_KANBAN_STATUSES.includes(request.status) || !OPERATOR_TARGET_STATUSES.has(request.status))
      return null;
    payload.status = request.status;
  }
  if (request.title !== undefined) {
    const title = boundedText(request.title, 500);
    if (!title) return null;
    payload.title = title;
  }
  if (request.body !== undefined) payload.body = boundedText(request.body, 20_000);
  if (request.assignee !== undefined) payload.assignee = boundedText(request.assignee, 160);
  if (request.priority !== undefined) payload.priority = Math.max(-100, Math.min(100, finiteInteger(request.priority)));
  if (Object.keys(payload).length === 0) return null;
  return { taskId, payload };
}

export function ensureHermesNativeKanbanBoard(
  options: HermesNativeKanbanOptions
): Promise<CommandEveNativeKanbanResult> {
  return invokeAdapter('ensure', {}, options);
}

export function readHermesNativeKanbanBoard(options: HermesNativeKanbanOptions): Promise<CommandEveNativeKanbanResult> {
  return invokeAdapter('read', {}, options);
}

export function createHermesNativeKanbanTask(
  request: CommandEveNativeKanbanCreateRequest,
  options: HermesNativeKanbanOptions
): Promise<CommandEveNativeKanbanResult> {
  const payload = normalizeCreate(request);
  if (!payload) return Promise.resolve(failure('', 'KANBAN_CREATE_INVALID', 'The task request is invalid.', 'blocked'));
  return invokeAdapter('create', { payload }, options);
}

export function updateHermesNativeKanbanTask(
  request: CommandEveNativeKanbanUpdateRequest,
  options: HermesNativeKanbanOptions
): Promise<CommandEveNativeKanbanResult> {
  const normalized = normalizeUpdate(request);
  if (!normalized)
    return Promise.resolve(failure('', 'KANBAN_UPDATE_INVALID', 'The task update is invalid.', 'blocked'));
  return invokeAdapter('update', { task_id: normalized.taskId, payload: normalized.payload }, options);
}
