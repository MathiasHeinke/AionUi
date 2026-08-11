/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  COMMAND_EVE_NATIVE_KANBAN_STATUSES,
  type CommandEveNativeKanbanCreateRequest,
  type CommandEveNativeKanbanResult,
  type CommandEveNativeKanbanStatus,
  type CommandEveNativeKanbanTask,
  type CommandEveNativeKanbanUpdateRequest,
} from '@/common/config/eveNativeKanbanCore';
import type {
  CommandEveComputerUseActionResult,
  CommandEveComputerUseStatus,
} from '@/common/config/eveComputerUseCore';
import { COMMAND_EVE_KANBAN_ACP_APPLIED_EVENT } from '@/common/config/kanbanAcpEvents';
import { useSeatAccess } from '@/renderer/hooks/useSeatAccess';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { bridge } from '@office-ai/platform';
import { Button, Empty, Input, Message, Modal, Select, Spin, Tag } from '@arco-design/web-react';
import { Computer } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface BridgeResponse<D> {
  success: boolean;
  msg?: string;
  data?: D;
}

const boardProvider = bridge.buildProvider<BridgeResponse<CommandEveNativeKanbanResult>, undefined>(
  'command-eve.native-kanban-board'
);
const createProvider = bridge.buildProvider<
  BridgeResponse<CommandEveNativeKanbanResult>,
  CommandEveNativeKanbanCreateRequest
>('command-eve.native-kanban-task-create');
const updateProvider = bridge.buildProvider<
  BridgeResponse<CommandEveNativeKanbanResult>,
  CommandEveNativeKanbanUpdateRequest
>('command-eve.native-kanban-task-update');
const computerStatusProvider = bridge.buildProvider<BridgeResponse<CommandEveComputerUseStatus>, undefined>(
  'command-eve.computer-use-status'
);
const computerInstallProvider = bridge.buildProvider<BridgeResponse<CommandEveComputerUseActionResult>, undefined>(
  'command-eve.computer-use-install'
);
const computerGrantProvider = bridge.buildProvider<BridgeResponse<CommandEveComputerUseActionResult>, undefined>(
  'command-eve.computer-use-permissions-grant'
);
const computerRevokeProvider = bridge.buildProvider<BridgeResponse<CommandEveComputerUseActionResult>, undefined>(
  'command-eve.computer-use-permissions-revoke-guide'
);

const OPERATOR_MUTABLE_SOURCE_STATUSES = new Set<CommandEveNativeKanbanStatus>(['triage', 'todo', 'blocked']);
const OPERATOR_TARGET_STATUSES: CommandEveNativeKanbanStatus[] = ['triage', 'todo'];

function token(): string {
  return `command-eve-kanban-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function statusColor(status: CommandEveNativeKanbanStatus): 'blue' | 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'done') return 'green';
  if (status === 'blocked') return 'red';
  if (status === 'review' || status === 'scheduled') return 'orange';
  if (status === 'ready' || status === 'running') return 'blue';
  return 'gray';
}

const RecordReference: React.FC<{ label: string; value: string | null }> = ({ label, value }) => {
  if (!value) return null;
  return (
    <div className='grid grid-cols-[auto_minmax(0,1fr)] gap-8px text-11px leading-16px'>
      <span className='text-t-tertiary'>{label}</span>
      <code className='truncate text-t-secondary' title={value}>
        {value}
      </code>
    </div>
  );
};

const ComputerUsePanel: React.FC<{ locked: boolean }> = ({ locked }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CommandEveComputerUseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const refresh = useCallback(async () => {
    if (!isElectronDesktop()) return;
    setLoading(true);
    try {
      const response = await computerStatusProvider.invoke();
      setStatus(response.data ?? null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invoke = useCallback(
    async (provider: typeof computerInstallProvider | typeof computerGrantProvider | typeof computerRevokeProvider) => {
      setActing(true);
      try {
        const response = await provider.invoke();
        const result = response.data;
        if (result?.ok) Message.success(t('kanban.native.computer.actionReady'));
        else if (result?.message) Message.info(result.message);
        else Message.warning(response.msg || t('kanban.native.computer.actionFailed'));
        await refresh();
      } catch {
        Message.error(t('kanban.native.computer.actionFailed'));
      } finally {
        setActing(false);
      }
    },
    [refresh, t]
  );

  const stateLabel = status
    ? t(`kanban.native.computer.state.${status.state}`)
    : t('kanban.native.computer.state.failed');
  return (
    <section
      aria-labelledby='native-computer-use-title'
      className='rounded-14px border border-solid border-[var(--color-border-2)] bg-fill-1 px-14px py-12px'
      data-testid='native-computer-use-panel'
    >
      <div className='flex flex-wrap items-start justify-between gap-10px'>
        <div className='flex min-w-0 items-start gap-10px'>
          <Computer aria-hidden='true' size={20} className='mt-1px shrink-0 text-t-secondary' />
          <div className='min-w-0'>
            <h2 id='native-computer-use-title' className='m-0 text-14px font-600 leading-20px text-t-primary'>
              {t('kanban.native.computer.title')}
            </h2>
            <p className='m-0 mt-2px text-11px leading-16px text-t-secondary'>
              {t('kanban.native.computer.description')}
            </p>
          </div>
        </div>
        <div className='flex flex-wrap items-center justify-end gap-6px'>
          <Tag color={status?.ready ? 'green' : status?.installed ? 'orange' : 'gray'}>{stateLabel}</Tag>
          <Button size='mini' loading={loading} onClick={() => void refresh()} data-testid='native-computer-refresh'>
            {t('kanban.native.refresh')}
          </Button>
        </div>
      </div>

      {loading && !status ? (
        <div className='flex min-h-48px items-center justify-center'>
          <Spin size={18} />
        </div>
      ) : status ? (
        <div className='mt-10px flex flex-col gap-8px'>
          {status.message ? (
            <p className='m-0 text-11px leading-16px text-t-secondary' role='status'>
              {status.message}
            </p>
          ) : null}
          <div className='flex flex-wrap gap-x-16px gap-y-4px text-11px text-t-secondary'>
            <span data-testid='native-computer-accessibility'>
              {t('kanban.native.computer.accessibility')}:{' '}
              {status.accessibility === true ? '✓' : status.accessibility === false ? '×' : '–'}
            </span>
            <span data-testid='native-computer-screen-recording'>
              {t('kanban.native.computer.screenRecording')}:{' '}
              {status.screen_recording === true ? '✓' : status.screen_recording === false ? '×' : '–'}
            </span>
            <span>{status.provenance.driver_version || t('kanban.native.computer.noDriverVersion')}</span>
          </div>
          <div className='flex flex-wrap items-center gap-6px'>
            {!status.installed && status.can_install ? (
              <Button
                size='mini'
                type='primary'
                loading={acting}
                disabled={locked}
                onClick={() => void invoke(computerInstallProvider)}
                data-testid='native-computer-install'
              >
                {t('kanban.native.computer.install')}
              </Button>
            ) : null}
            {status.installed && status.can_grant && status.state === 'needs_permission' ? (
              <Button
                size='mini'
                type='primary'
                loading={acting}
                disabled={locked}
                onClick={() => void invoke(computerGrantProvider)}
                data-testid='native-computer-grant'
              >
                {t('kanban.native.computer.grant')}
              </Button>
            ) : null}
            {status.installed && status.can_grant ? (
              <Button
                size='mini'
                loading={acting}
                disabled={locked}
                onClick={() => void invoke(computerRevokeProvider)}
                data-testid='native-computer-revoke-guide'
              >
                {t('kanban.native.computer.revoke')}
              </Button>
            ) : null}
          </div>
          <details className='text-11px text-t-secondary' data-testid='native-computer-provenance'>
            <summary className='cursor-pointer select-none'>{t('kanban.native.computer.provenance')}</summary>
            <div className='mt-6px flex flex-col gap-4px rounded-8px bg-fill-2 px-10px py-8px'>
              <RecordReference label={t('kanban.native.computer.version')} value={status.provenance.driver_version} />
              <RecordReference label={t('kanban.native.computer.expected')} value={status.provenance.release_tag} />
              <RecordReference label='SHA-256' value={status.provenance.executable_sha256} />
              <RecordReference
                label={t('kanban.native.computer.expectedChecksum')}
                value={status.provenance.expected_executable_sha256}
              />
              <div className='flex items-center gap-6px'>
                <Tag size='small' color={status.provenance.checksum_verified ? 'green' : 'red'}>
                  {status.provenance.checksum_verified ? '✓' : '×'}
                </Tag>
                <span>{t('kanban.native.computer.checksum')}</span>
              </div>
              <RecordReference label={t('kanban.native.computer.identity')} value={status.provenance.identity} />
              <RecordReference label={t('kanban.native.computer.team')} value={status.provenance.team_identifier} />
              {status.checks.map((check, index) => (
                <div key={`${check.label}-${index}`} className='flex gap-6px'>
                  <Tag size='small' color={check.status === 'pass' || check.status === 'ok' ? 'green' : 'orange'}>
                    {check.status || '–'}
                  </Tag>
                  <span>{`${check.label}${check.message ? ` · ${check.message}` : ''}`}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      ) : (
        <p className='m-0 mt-8px text-11px text-red-6'>{t('kanban.native.computer.actionFailed')}</p>
      )}
    </section>
  );
};

const KanbanTaskCard: React.FC<{
  task: CommandEveNativeKanbanTask;
  busy: boolean;
  locked: boolean;
  onMove: (task: CommandEveNativeKanbanTask, status: CommandEveNativeKanbanStatus) => void;
  onEdit: (task: CommandEveNativeKanbanTask) => void;
}> = ({ task, busy, locked, onMove, onEdit }) => {
  const { t } = useTranslation();
  const operatorMutable = OPERATOR_MUTABLE_SOURCE_STATUSES.has(task.status);
  return (
    <article
      id={`kanban-task-${task.id}`}
      data-testid={`native-kanban-task-${task.id}`}
      data-record-kind={task.goal_mode ? 'goal' : task.current_run_id ? 'worker' : 'task'}
      className='rounded-12px border border-solid border-[var(--color-border-2)] bg-fill-1 px-11px py-10px shadow-sm'
    >
      <div className='flex items-start justify-between gap-8px'>
        <div className='min-w-0'>
          <div className='break-words text-12px font-600 leading-18px text-t-primary'>{task.title}</div>
          <code className='mt-2px block truncate text-10px text-t-tertiary'>{task.id}</code>
        </div>
        <Tag color={statusColor(task.status)} size='small'>
          {t(`kanban.native.status.${task.status}`)}
        </Tag>
      </div>
      <div className='mt-7px flex flex-wrap gap-4px'>
        {task.goal_mode ? (
          <Tag size='small' color='purple'>
            {t('kanban.native.record.goal')}
          </Tag>
        ) : null}
        {task.current_run_id ? (
          <Tag size='small' color='blue'>
            {t('kanban.native.record.worker')}
          </Tag>
        ) : null}
        {task.progress ? <Tag size='small'>{`${task.progress.done}/${task.progress.total}`}</Tag> : null}
      </div>
      <details className='mt-7px text-11px text-t-secondary'>
        <summary className='cursor-pointer select-none'>{t('kanban.native.details')}</summary>
        <div className='mt-6px flex flex-col gap-4px rounded-8px bg-fill-2 px-8px py-7px'>
          <RecordReference label={t('kanban.native.record.session')} value={task.session_id} />
          <RecordReference label={t('kanban.native.record.run')} value={task.current_run_id} />
          <RecordReference label={t('kanban.native.record.project')} value={task.project_id} />
          <RecordReference label={t('kanban.native.record.assignee')} value={task.assignee} />
          {task.body ? <p className='m-0 whitespace-pre-wrap break-words'>{task.body}</p> : null}
          {task.latest_summary ? <p className='m-0 whitespace-pre-wrap break-words'>{task.latest_summary}</p> : null}
        </div>
      </details>
      <div className='mt-8px flex flex-wrap items-center justify-end gap-6px'>
        <Button
          size='mini'
          disabled={busy || locked || !operatorMutable}
          onClick={() => onEdit(task)}
          data-testid={`native-kanban-edit-${task.id}`}
        >
          {t('kanban.native.edit')}
        </Button>
        <Select
          size='mini'
          value={task.status}
          disabled={busy || locked || !operatorMutable}
          aria-label={t('kanban.native.move')}
          data-testid={`native-kanban-move-${task.id}`}
          onChange={(value) => onMove(task, value as CommandEveNativeKanbanStatus)}
          style={{ width: 116 }}
        >
          {task.status === 'blocked' ? (
            <Select.Option value='blocked' disabled>
              {t('kanban.native.status.blocked')}
            </Select.Option>
          ) : null}
          {OPERATOR_TARGET_STATUSES.map((status) => (
            <Select.Option key={status} value={status}>
              {t(`kanban.native.status.${status}`)}
            </Select.Option>
          ))}
        </Select>
      </div>
    </article>
  );
};

const KanbanColumn: React.FC<{
  name: CommandEveNativeKanbanStatus;
  tasks: CommandEveNativeKanbanTask[];
  busyTaskId: string | null;
  locked: boolean;
  onMove: (task: CommandEveNativeKanbanTask, status: CommandEveNativeKanbanStatus) => void;
  onEdit: (task: CommandEveNativeKanbanTask) => void;
}> = ({ name, tasks, busyTaskId, locked, onMove, onEdit }) => {
  const { t } = useTranslation();
  return (
    <section
      className='w-252px shrink-0'
      aria-labelledby={`kanban-column-${name}`}
      data-testid={`native-kanban-column-${name}`}
    >
      <div className='mb-8px flex items-center justify-between gap-8px px-2px'>
        <h3 id={`kanban-column-${name}`} className='m-0 text-12px font-600 text-t-primary'>
          {t(`kanban.native.status.${name}`)}
        </h3>
        <Tag size='small'>{tasks.length}</Tag>
      </div>
      <div className='flex flex-col gap-8px'>
        {tasks.length > 0 ? (
          tasks.map((task) => (
            <KanbanTaskCard
              key={task.id}
              task={task}
              busy={busyTaskId === task.id}
              locked={locked}
              onMove={onMove}
              onEdit={onEdit}
            />
          ))
        ) : (
          <div className='rounded-12px border border-dashed border-[var(--color-border-2)] px-10px py-18px text-center text-11px text-t-tertiary'>
            {t('kanban.native.emptyColumn')}
          </div>
        )}
      </div>
    </section>
  );
};

const CreateTaskModal: React.FC<{
  visible: boolean;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (request: CommandEveNativeKanbanCreateRequest) => void;
}> = ({ visible, submitting, onCancel, onSubmit }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [kind, setKind] = useState<'task' | 'goal'>('task');
  const submit = () => {
    if (!title.trim()) return Message.warning(t('kanban.native.create.titleRequired'));
    onSubmit({
      title: title.trim(),
      body: body.trim() || undefined,
      assignee: assignee.trim() || undefined,
      triage: true,
      record_kind: kind,
      idempotency_key: token(),
    });
  };
  return (
    <Modal
      visible={visible}
      title={t('kanban.native.create.title')}
      okText={t('kanban.native.create.submit')}
      cancelText={t('kanban.native.cancel')}
      confirmLoading={submitting}
      onOk={submit}
      onCancel={onCancel}
      unmountOnExit
    >
      <div className='flex flex-col gap-12px'>
        <Input
          value={title}
          onChange={setTitle}
          placeholder={t('kanban.native.create.titlePlaceholder')}
          maxLength={500}
          data-testid='native-kanban-create-title'
        />
        <Input.TextArea
          value={body}
          onChange={setBody}
          placeholder={t('kanban.native.create.bodyPlaceholder')}
          maxLength={20_000}
          autoSize={{ minRows: 3, maxRows: 8 }}
          data-testid='native-kanban-create-body'
        />
        <Input
          value={assignee}
          onChange={setAssignee}
          placeholder={t('kanban.native.create.assigneePlaceholder')}
          maxLength={160}
          data-testid='native-kanban-create-assignee'
        />
        <Select
          value={kind}
          onChange={(value) => setKind(value as 'task' | 'goal')}
          data-testid='native-kanban-create-kind'
        >
          <Select.Option value='task'>{t('kanban.native.record.task')}</Select.Option>
          <Select.Option value='goal'>{t('kanban.native.record.goal')}</Select.Option>
        </Select>
      </div>
    </Modal>
  );
};

const EditTaskModal: React.FC<{
  task: CommandEveNativeKanbanTask | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (request: CommandEveNativeKanbanUpdateRequest) => void;
}> = ({ task, submitting, onCancel, onSubmit }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  useEffect(() => {
    setTitle(task?.title ?? '');
    setBody(task?.body ?? '');
    setAssignee(task?.assignee ?? '');
  }, [task]);
  return (
    <Modal
      visible={!!task}
      title={t('kanban.native.edit')}
      okText={t('kanban.native.save')}
      cancelText={t('kanban.native.cancel')}
      confirmLoading={submitting}
      onOk={() => task && onSubmit({ task_id: task.id, title, body, assignee })}
      onCancel={onCancel}
      unmountOnExit
    >
      <div className='flex flex-col gap-12px'>
        <Input value={title} onChange={setTitle} maxLength={500} data-testid='native-kanban-edit-title' />
        <Input.TextArea
          value={body}
          onChange={setBody}
          maxLength={20_000}
          autoSize={{ minRows: 3, maxRows: 8 }}
          data-testid='native-kanban-edit-body'
        />
        <Input value={assignee} onChange={setAssignee} maxLength={160} data-testid='native-kanban-edit-assignee' />
      </div>
    </Modal>
  );
};

const NativeKanbanBoard: React.FC = () => {
  const { t } = useTranslation();
  const { switching } = useSeatAccess();
  const [result, setResult] = useState<CommandEveNativeKanbanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [createVisible, setCreateVisible] = useState(false);
  const [editing, setEditing] = useState<CommandEveNativeKanbanTask | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const board = result?.board ?? null;
  const refresh = useCallback(async () => {
    if (!isElectronDesktop()) {
      setResult(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await boardProvider.invoke();
      setResult(response.data ?? null);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onApplied = () => void refresh();
    window.addEventListener(COMMAND_EVE_KANBAN_ACP_APPLIED_EVENT, onApplied);
    return () => window.removeEventListener(COMMAND_EVE_KANBAN_ACP_APPLIED_EVENT, onApplied);
  }, [refresh]);

  const applyBoard = useCallback(
    async (response: BridgeResponse<CommandEveNativeKanbanResult>) => {
      if (response.data?.board) setResult(response.data);
      else await refresh();
      if (!response.data?.ok)
        Message.warning(response.data?.message || response.msg || t('kanban.native.actionFailed'));
      return response.data?.ok === true;
    },
    [refresh, t]
  );

  const createTask = useCallback(
    async (request: CommandEveNativeKanbanCreateRequest) => {
      setSubmitting(true);
      try {
        const ok = await applyBoard(await createProvider.invoke(request));
        if (ok) {
          setCreateVisible(false);
          Message.success(t('kanban.native.create.success'));
        }
      } catch {
        Message.error(t('kanban.native.actionFailed'));
      } finally {
        setSubmitting(false);
      }
    },
    [applyBoard, t]
  );

  const updateTask = useCallback(
    async (request: CommandEveNativeKanbanUpdateRequest) => {
      setBusyTaskId(request.task_id);
      setSubmitting(true);
      try {
        const ok = await applyBoard(await updateProvider.invoke(request));
        if (ok) {
          setEditing(null);
          Message.success(t('kanban.native.update.success'));
        }
      } catch {
        Message.error(t('kanban.native.actionFailed'));
      } finally {
        setSubmitting(false);
        setBusyTaskId(null);
      }
    },
    [applyBoard, t]
  );

  const orderedColumns = useMemo(() => {
    if (!board) return [];
    return COMMAND_EVE_NATIVE_KANBAN_STATUSES.map(
      (name) => board.columns.find((column) => column.name === name) ?? { name, tasks: [] }
    );
  }, [board]);

  return (
    <div className='size-full overflow-y-auto bg-fill-0' data-testid='native-kanban-board'>
      <div className='mx-auto flex max-w-1440px flex-col gap-14px px-16px py-16px'>
        <header className='flex flex-wrap items-start justify-between gap-12px'>
          <div className='min-w-0'>
            <h1 className='m-0 text-20px font-700 leading-28px text-t-primary'>{t('kanban.native.title')}</h1>
            <p className='m-0 mt-3px max-w-720px text-12px leading-18px text-t-secondary'>
              {t('kanban.native.subtitle')}
            </p>
          </div>
          <div className='flex flex-wrap items-center justify-end gap-6px'>
            <Button shape='round' loading={loading} onClick={() => void refresh()} data-testid='native-kanban-refresh'>
              {t('kanban.native.refresh')}
            </Button>
            <Button
              type='primary'
              shape='round'
              disabled={!board || switching}
              onClick={() => setCreateVisible(true)}
              data-testid='native-kanban-create'
            >
              {t('kanban.native.create.open')}
            </Button>
          </div>
        </header>
        <ComputerUsePanel locked={switching} />
        {loading && !result ? (
          <div className='flex min-h-220px items-center justify-center'>
            <Spin />
          </div>
        ) : !board ? (
          <div className='flex min-h-220px items-center justify-center'>
            <Empty description={result?.message || result?.reason_code || t('kanban.native.unavailable')} />
          </div>
        ) : (
          <section aria-label={t('kanban.native.boardLabel')}>
            <div className='mb-10px flex flex-wrap items-center gap-6px'>
              <Tag>{`${t('kanban.native.board')}: ${board.name}`}</Tag>
              <Tag>{`${t('kanban.native.tasks')}: ${board.task_count}`}</Tag>
              <Tag color='green'>Hermes {result?.source.hermes_version || '0.20'}</Tag>
              <Tag color='blue'>{result?.source.home_scope_id}</Tag>
            </div>
            <div className='overflow-x-auto pb-8px' data-testid='native-kanban-columns'>
              <div className='flex min-w-max items-start gap-10px'>
                {orderedColumns.map((column) => (
                  <KanbanColumn
                    key={column.name}
                    name={column.name}
                    tasks={column.tasks}
                    busyTaskId={busyTaskId}
                    locked={switching}
                    onMove={(task, status) => void updateTask({ task_id: task.id, status })}
                    onEdit={setEditing}
                  />
                ))}
              </div>
            </div>
          </section>
        )}
        <CreateTaskModal
          visible={createVisible}
          submitting={submitting}
          onCancel={() => setCreateVisible(false)}
          onSubmit={(request) => void createTask(request)}
        />
        <EditTaskModal
          task={editing}
          submitting={submitting}
          onCancel={() => setEditing(null)}
          onSubmit={(request) => void updateTask(request)}
        />
      </div>
    </div>
  );
};

export default NativeKanbanBoard;
