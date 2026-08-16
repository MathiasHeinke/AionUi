import {
  Alert,
  Button,
  Card,
  Empty,
  Message,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { FolderOpen, Plus, Refresh, Undo } from '@renderer/components/icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createIdempotencyKey, ProjectWorkspaceClientError, useProjectWorkspaceClient } from './client';
import AdoptProjectDialog from './components/AdoptProjectDialog';
import CreateProjectDialog from './components/CreateProjectDialog';
import EditProjectDialog from './components/EditProjectDialog';
import { getProjectWorkspaceActionKey, getProjectWorkspaceReasonPresentation } from './reasonCodes';
import type {
  ProjectSummaryDTO,
  ProjectWorkspaceAction,
  ProjectWorkspaceListDTO,
  ProjectWorkspaceRealmKind,
  ProjectWorkspaceReasonCode,
} from './types';

type RealmFilter = 'all' | ProjectWorkspaceRealmKind;

const ProjectsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const client = useProjectWorkspaceClient();
  const [snapshot, setSnapshot] = useState<ProjectWorkspaceListDTO>();
  const [reason, setReason] = useState<ProjectWorkspaceReasonCode>();
  const [loading, setLoading] = useState(true);
  const [busyProjectId, setBusyProjectId] = useState<string>();
  const [filter, setFilter] = useState<RealmFilter>('all');
  const [createVisible, setCreateVisible] = useState(false);
  const [adoptVisible, setAdoptVisible] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectSummaryDTO | null>(null);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setReason(undefined);
    try {
      setSnapshot(await client.list());
    } catch (error) {
      setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'service_unavailable');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const projects = useMemo(
    () => snapshot?.projects.filter((project) => filter === 'all' || project.realm_kind === filter) ?? [],
    [filter, snapshot?.projects]
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  );

  const runAction = async (project: ProjectSummaryDTO, action: ProjectWorkspaceAction) => {
    setBusyProjectId(project.project_id);
    try {
      const base = {
        project_id: project.project_id,
        expected_revision: project.revision,
        seat_context_revision: snapshot?.seat_context_revision ?? 0,
        idempotency_key: createIdempotencyKey(),
      };
      if (action === 'reveal') {
        await client.reveal({ project_id: project.project_id, seat_context_revision: base.seat_context_revision });
        return;
      }
      const receipt =
        action === 'archive'
          ? await client.archive(base)
          : action === 'restore'
            ? await client.restore(base)
            : action === 'recover'
              ? await client.recover(base)
              : action === 'undo'
                ? await client.undo(base)
                : undefined;
      if (!receipt) return;
      if (receipt.outcome === 'completed') {
        Message.success(t('common.projects.actionCompleted'));
        await load();
      } else {
        setReason(receipt.reason_code ?? 'invariant_failure');
      }
    } catch (error) {
      setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'invariant_failure');
    } finally {
      setBusyProjectId(undefined);
    }
  };

  const confirmAction = (project: ProjectSummaryDTO, action: 'archive' | 'undo') => {
    Modal.confirm({
      title: t(`common.projects.confirm.${action}.title`),
      content: t(`common.projects.confirm.${action}.description`, { title: project.title }),
      okText: t(`common.projects.actions.${action}`),
      cancelText: t('common.cancel'),
      onOk: () => runAction(project, action),
    });
  };

  const closeDialogs = () => {
    setCreateVisible(false);
    setAdoptVisible(false);
    setEditingProject(null);
  };

  const restoreDialogFocus = () => {
    dialogOpenerRef.current?.focus();
    dialogOpenerRef.current = null;
  };

  const rememberDialogOpener = (target: EventTarget | null) => {
    dialogOpenerRef.current = target instanceof HTMLElement ? target : null;
  };

  const completeDialog = () => {
    closeDialogs();
    void load();
  };

  const presentation = reason ? getProjectWorkspaceReasonPresentation(reason) : undefined;

  return (
    <main className='size-full overflow-y-auto bg-bg-1' aria-labelledby='projects-page-title'>
      <div className='mx-auto max-w-1120px flex flex-col gap-20px px-16px py-24px sm:px-24px lg:px-32px'>
        <header className='flex flex-wrap items-start justify-between gap-16px'>
          <div className='min-w-0'>
            <Typography.Title id='projects-page-title' heading={3} className='!m-0'>
              {t('common.projects.title')}
            </Typography.Title>
            <Typography.Paragraph className='!mt-6px !mb-0 text-t-secondary'>
              {t('common.projects.description')}
            </Typography.Paragraph>
          </div>
          <Space wrap>
            <Button
              icon={<FolderOpen />}
              onClick={(event) => {
                rememberDialogOpener(event.currentTarget);
                setAdoptVisible(true);
              }}
              disabled={!snapshot}
            >
              {t('common.projects.adopt.action')}
            </Button>
            <Button
              type='primary'
              icon={<Plus />}
              onClick={(event) => {
                rememberDialogOpener(event.currentTarget);
                setCreateVisible(true);
              }}
              disabled={!snapshot}
            >
              {t('common.projects.create.action')}
            </Button>
          </Space>
        </header>

        {snapshot && !snapshot.automatic_creation_enabled ? (
          <div role='status'>
            <Alert type='info' title={t('common.projects.automaticDisabled')} />
          </div>
        ) : null}
        {presentation ? (
          <div>
            <Alert
              type='error'
              title={t(presentation.titleKey)}
              content={t(presentation.descriptionKey)}
              action={
                presentation.action === 'refresh' || presentation.action === 'retry' ? (
                  <Button size='small' icon={<Refresh />} onClick={() => void load()}>
                    {t('common.refresh')}
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : null}

        <div className='flex flex-wrap items-center justify-between gap-12px'>
          <Typography.Text className='text-t-secondary'>
            {snapshot ? t('common.projects.currentSeat', { seat: snapshot.seat_label }) : t('common.loading')}
          </Typography.Text>
          <Select
            value={filter}
            onChange={(value) => setFilter(value as RealmFilter)}
            aria-label={t('common.projects.filter.label')}
            className='w-full sm:w-220px'
          >
            <Select.Option value='all'>{t('common.projects.filter.all')}</Select.Option>
            <Select.Option value='private'>{t('common.projects.realms.private')}</Select.Option>
            <Select.Option value='business'>{t('common.projects.realms.business')}</Select.Option>
            <Select.Option value='custom'>{t('common.projects.realms.custom')}</Select.Option>
          </Select>
        </div>

        {loading ? (
          <div role='status' aria-live='polite' className='min-h-260px flex items-center justify-center'>
            <Spin tip={t('common.projects.loading')} />
          </div>
        ) : projects.length === 0 && !reason ? (
          <div className='flex min-h-260px flex-col items-center justify-center gap-14px'>
            <Empty
              description={t('common.projects.empty.description')}
              icon={<FolderOpen theme='outline' size='48' fill='currentColor' />}
            />
            <Space wrap>
              <Button
                onClick={(event) => {
                  rememberDialogOpener(event.currentTarget);
                  setAdoptVisible(true);
                }}
              >
                {t('common.projects.adopt.action')}
              </Button>
              <Button
                type='primary'
                onClick={(event) => {
                  rememberDialogOpener(event.currentTarget);
                  setCreateVisible(true);
                }}
              >
                {t('common.projects.create.action')}
              </Button>
            </Space>
          </div>
        ) : (
          <section aria-label={t('common.projects.listLabel')} className='grid grid-cols-1 gap-14px lg:grid-cols-2'>
            {projects.map((project) => {
              const busy = busyProjectId === project.project_id;
              return (
                <Card key={project.project_id} className='min-w-0' bordered>
                  <div className='flex flex-col gap-12px'>
                    <div className='flex items-start justify-between gap-12px'>
                      <div className='min-w-0'>
                        <Typography.Title heading={6} className='!m-0 break-words'>
                          {project.title}
                        </Typography.Title>
                        <Typography.Text className='text-t-secondary'>
                          {project.realm_label} · {project.root_label}
                        </Typography.Text>
                      </div>
                      <Tag
                        color={
                          project.status === 'recovery_required'
                            ? 'orangered'
                            : project.status === 'active'
                              ? 'green'
                              : 'gray'
                        }
                      >
                        {t(`common.projects.status.${project.status}`)}
                      </Tag>
                    </div>
                    <div className='grid grid-cols-1 gap-6px text-13px text-t-secondary sm:grid-cols-2'>
                      <span>
                        {t('common.projects.updated', { date: dateFormatter.format(project.last_safe_update) })}
                      </span>
                      <span>{t('common.projects.conversations', { count: project.conversation_count })}</span>
                    </div>
                    <Space wrap>
                      {project.allowed_actions.includes('edit') ? (
                        <Button
                          size='small'
                          disabled={busy}
                          onClick={(event) => {
                            rememberDialogOpener(event.currentTarget);
                            setEditingProject(project);
                          }}
                        >
                          {t(getProjectWorkspaceActionKey('edit'))}
                        </Button>
                      ) : null}
                      {project.allowed_actions.includes('archive') ? (
                        <Button
                          size='small'
                          status='warning'
                          disabled={busy}
                          onClick={() => confirmAction(project, 'archive')}
                        >
                          {t(getProjectWorkspaceActionKey('archive'))}
                        </Button>
                      ) : null}
                      {project.allowed_actions.includes('restore') ? (
                        <Button size='small' loading={busy} onClick={() => void runAction(project, 'restore')}>
                          {t(getProjectWorkspaceActionKey('restore'))}
                        </Button>
                      ) : null}
                      {project.allowed_actions.includes('reveal') ? (
                        <Button size='small' disabled={busy} onClick={() => void runAction(project, 'reveal')}>
                          {t(getProjectWorkspaceActionKey('reveal'))}
                        </Button>
                      ) : null}
                      {project.allowed_actions.includes('recover') ? (
                        <Button
                          size='small'
                          status='danger'
                          loading={busy}
                          onClick={() => void runAction(project, 'recover')}
                        >
                          {t(getProjectWorkspaceActionKey('recover'))}
                        </Button>
                      ) : null}
                      {project.allowed_actions.includes('undo') ? (
                        <Button
                          size='small'
                          icon={<Undo />}
                          disabled={busy}
                          onClick={() => confirmAction(project, 'undo')}
                        >
                          {t(getProjectWorkspaceActionKey('undo'))}
                        </Button>
                      ) : null}
                    </Space>
                  </div>
                </Card>
              );
            })}
          </section>
        )}
      </div>

      <CreateProjectDialog
        visible={createVisible}
        placements={snapshot?.placements ?? []}
        seatContextRevision={snapshot?.seat_context_revision ?? 0}
        onClose={closeDialogs}
        onAfterClose={restoreDialogFocus}
        onCompleted={completeDialog}
      />
      <AdoptProjectDialog
        visible={adoptVisible}
        seatContextRevision={snapshot?.seat_context_revision ?? 0}
        onClose={closeDialogs}
        onAfterClose={restoreDialogFocus}
        onCompleted={completeDialog}
      />
      <EditProjectDialog
        project={editingProject}
        seatContextRevision={snapshot?.seat_context_revision ?? 0}
        onClose={closeDialogs}
        onAfterClose={restoreDialogFocus}
        onCompleted={completeDialog}
      />
    </main>
  );
};

// NOTE: the project workspace client is provided globally at the protected
// layout level (Router.tsx). Tests mount their own provider around this page,
// so the default export must stay the plain component (no nested self-wrap).
export default ProjectsPage;
