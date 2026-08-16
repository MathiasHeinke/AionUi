import { Button, Input } from '@arco-design/web-react';
import {
  ArrowRight,
  CheckOne as CheckCircle,
  FolderBlock,
  FolderFocus,
  FolderOpen,
  Loading,
  Refresh,
  Search,
} from '@icon-park/react';
import AionModal from '@renderer/components/base/AionModal';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createIdempotencyKey,
  ProjectWorkspaceClientError,
  useProjectWorkspaceClient,
} from '@renderer/pages/projects/client';
import { getProjectWorkspaceReasonPresentation } from '@renderer/pages/projects/reasonCodes';
import type {
  ProjectSummaryDTO,
  ProjectWorkspaceAssignmentChoice,
  ProjectWorkspaceAssignmentPreviewDTO,
  ProjectWorkspaceConversationArtifactDTO,
  ProjectWorkspaceListDTO,
  ProjectWorkspaceReasonCode,
} from '@renderer/pages/projects/types';
import styles from './FinalizeProjectAssignmentDialog.module.css';

type AssignmentKind = ProjectWorkspaceAssignmentChoice['kind'];

type FinalizeProjectAssignmentDialogProps = {
  artifact: ProjectWorkspaceConversationArtifactDTO | null;
  onCancel: () => void;
  onArtifactRefresh: (artifact: ProjectWorkspaceConversationArtifactDTO) => void;
  onCompleted: (artifact?: ProjectWorkspaceConversationArtifactDTO) => void;
};

const iconProps = { theme: 'outline' as const, size: 17, fill: 'currentColor', 'aria-hidden': true };
const ASSIGNMENT_KINDS: AssignmentKind[] = ['keep', 'project', 'temporary'];

const placementLabel = (project: ProjectSummaryDTO): string => {
  const labels = [project.realm_label, project.root_label].map((value) => value.trim()).filter(Boolean);
  return [...new Set(labels)].join(' · ');
};

const FinalizeProjectAssignmentDialog: React.FC<FinalizeProjectAssignmentDialogProps> = ({
  artifact,
  onCancel,
  onArtifactRefresh,
  onCompleted,
}) => {
  const { t } = useTranslation();
  const client = useProjectWorkspaceClient();
  const [catalog, setCatalog] = useState<ProjectWorkspaceListDTO | null>(null);
  const [choice, setChoice] = useState<AssignmentKind>('keep');
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectWorkspaceAssignmentPreviewDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [reason, setReason] = useState<ProjectWorkspaceReasonCode>();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [recoveryRequired, setRecoveryRequired] = useState(false);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setChoice('keep');
    setTitle(artifact?.payload.project_title ?? '');
    setQuery('');
    setSelectedProjectId(null);
    setPreview(null);
    setReason(undefined);
    setRecoveryRequired(false);
    if (!artifact) return () => undefined;

    setLoading(true);
    void client
      .list()
      .then((nextCatalog) => {
        if (!active) return;
        setCatalog(nextCatalog);
        const currentProject = nextCatalog.projects.find(
          (project) => project.project_id === artifact.payload.project_id
        );
        if (currentProject) setTitle(currentProject.title);
      })
      .catch((error) => {
        if (!active) return;
        setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'service_unavailable');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [artifact, client, reloadVersion]);

  const currentProject = useMemo(
    () => catalog?.projects.find((project) => project.project_id === artifact?.payload.project_id),
    [artifact?.payload.project_id, catalog?.projects]
  );
  const availableProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (catalog?.projects ?? []).filter(
      (project) =>
        project.status === 'active' &&
        project.project_id !== currentProject?.project_id &&
        (!normalizedQuery ||
          `${project.title} ${project.realm_label} ${project.root_label}`.toLocaleLowerCase().includes(normalizedQuery))
    );
  }, [catalog?.projects, currentProject?.project_id, query]);
  const selectedProject = useMemo(
    () => availableProjects.find((project) => project.project_id === selectedProjectId),
    [availableProjects, selectedProjectId]
  );
  const rovingProjectId = selectedProject?.project_id ?? availableProjects[0]?.project_id ?? null;

  const resetPreview = (nextChoice?: AssignmentKind) => {
    setPreview(null);
    setReason(undefined);
    if (nextChoice) setChoice(nextChoice);
  };

  const moveChoiceFocus = (event: React.KeyboardEvent<HTMLElement>, current: AssignmentKind) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const currentIndex = ASSIGNMENT_KINDS.indexOf(current);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ASSIGNMENT_KINDS.length - 1
          : ['ArrowDown', 'ArrowRight'].includes(event.key)
            ? (currentIndex + 1) % ASSIGNMENT_KINDS.length
            : (currentIndex - 1 + ASSIGNMENT_KINDS.length) % ASSIGNMENT_KINDS.length;
    const nextChoice = ASSIGNMENT_KINDS[nextIndex];
    resetPreview(nextChoice);
    const choices = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
    choices?.item(nextIndex).focus();
  };

  const moveProjectFocus = (event: React.KeyboardEvent<HTMLElement>, currentProjectId: string) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key) || availableProjects.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(
      0,
      availableProjects.findIndex((project) => project.project_id === currentProjectId)
    );
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? availableProjects.length - 1
          : ['ArrowDown', 'ArrowRight'].includes(event.key)
            ? (currentIndex + 1) % availableProjects.length
            : (currentIndex - 1 + availableProjects.length) % availableProjects.length;
    const nextProjectId = availableProjects[nextIndex].project_id;
    setSelectedProjectId(nextProjectId);
    setReason(undefined);
    const options = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="option"]');
    options?.item(nextIndex).focus();
  };

  const buildChoice = (): ProjectWorkspaceAssignmentChoice | null => {
    if (choice === 'temporary') return { kind: 'temporary' };
    if (choice === 'project') {
      if (!selectedProject) return null;
      return {
        kind: 'project',
        project_id: selectedProject.project_id,
        expected_project_revision: selectedProject.revision,
      };
    }
    const normalizedTitle = title.trim();
    if (!normalizedTitle || normalizedTitle.length > 120) return null;
    return {
      kind: 'keep',
      ...(normalizedTitle === currentProject?.title ? {} : { title: normalizedTitle }),
    };
  };

  const requestPreview = async () => {
    if (!artifact || !catalog || loading || committing) return;
    const nextChoice = buildChoice();
    if (!nextChoice) return;
    setLoading(true);
    setReason(undefined);
    try {
      const result = await client.previewAssignment({
        conversation_id: artifact.conversation_id,
        artifact_id: artifact.id,
        expected_artifact_updated_at: artifact.updated_at,
        expected_catalog_revision: catalog.catalog_revision,
        ...(currentProject ? { expected_current_project_revision: currentProject.revision } : {}),
        seat_context_revision: catalog.seat_context_revision,
        choice: nextChoice,
      });
      if (result.ok === false) {
        setReason(result.reason_code);
        return;
      }
      setPreview(result.preview);
    } catch (error) {
      setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'invariant_failure');
    } finally {
      setLoading(false);
    }
  };

  const recoverLatestState = async () => {
    if (!artifact || loading || committing) return;
    setLoading(true);
    setCatalog(null);
    setPreview(null);
    try {
      const [nextCatalog, artifacts] = await Promise.all([
        client.list(),
        client.listConversationArtifacts({ conversation_id: artifact.conversation_id }),
      ]);
      const freshArtifact = artifacts.find((candidate) => candidate.id === artifact.id);
      if (
        !freshArtifact ||
        freshArtifact.updated_at < artifact.updated_at ||
        freshArtifact.payload.state !== 'completed'
      ) {
        setReason('stale_snapshot');
        setRecoveryRequired(true);
        return;
      }
      setCatalog(nextCatalog);
      if (nextCatalog.notice_reason) {
        setReason(nextCatalog.notice_reason);
        setRecoveryRequired(true);
        return;
      }
      const refreshedProject = nextCatalog.projects.find(
        (project) => project.project_id === freshArtifact.payload.project_id
      );
      setTitle(refreshedProject?.title ?? freshArtifact.payload.project_title);
      setChoice('keep');
      setQuery('');
      setSelectedProjectId(null);
      setReason(undefined);
      setRecoveryRequired(false);
      onArtifactRefresh(freshArtifact);
    } catch (error) {
      setCatalog(null);
      setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'service_unavailable');
      setRecoveryRequired(true);
    } finally {
      setLoading(false);
    }
  };

  const commit = async () => {
    if (!preview || !catalog || committing) return;
    setCommitting(true);
    setReason(undefined);
    try {
      const receipt = await client.commitAssignment({
        preview_id: preview.preview_id,
        expected_preview_revision: preview.preview_revision,
        seat_context_revision: catalog.seat_context_revision,
        idempotency_key: createIdempotencyKey(),
      });
      if (receipt.outcome !== 'completed') {
        setCatalog(null);
        setPreview(null);
        setReason(receipt.reason_code ?? 'invariant_failure');
        setRecoveryRequired(true);
        return;
      }
      onCompleted(receipt.artifact);
    } catch (error) {
      setCatalog(null);
      setPreview(null);
      setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'invariant_failure');
      setRecoveryRequired(true);
    } finally {
      setCommitting(false);
    }
  };

  const effectiveReason = reason ?? catalog?.notice_reason;
  const presentation = effectiveReason ? getProjectWorkspaceReasonPresentation(effectiveReason) : undefined;
  const canRetryCatalog = !recoveryRequired && Boolean(effectiveReason) && (!catalog || Boolean(catalog.notice_reason));
  const canPreview = Boolean(
    catalog &&
    !catalog.notice_reason &&
    !loading &&
    !committing &&
    ((choice === 'keep' && title.trim() && title.trim().length <= 120) ||
      choice === 'temporary' ||
      (choice === 'project' && selectedProject))
  );
  const previewTarget =
    preview?.choice.kind === 'temporary'
      ? t('common.projects.assignment.temporaryTarget', { defaultValue: 'Temporärer Bereich' })
      : (preview?.target_project?.title ?? preview?.current_project?.title ?? '—');
  const dialogTitle = t('common.projects.assignment.title', { defaultValue: 'Projekt finalisieren' });

  return (
    <AionModal
      visible={Boolean(artifact)}
      modalRender={(modalNode) =>
        React.isValidElement(modalNode)
          ? React.cloneElement(modalNode as React.ReactElement<{ 'aria-label'?: string }>, {
              'aria-label': dialogTitle,
            })
          : modalNode
      }
      className='project-assignment-finalize-modal'
      style={{ width: 640 }}
      header={{
        title: dialogTitle,
        showClose: true,
      }}
      onCancel={committing ? undefined : onCancel}
      footerUnpadded
      footer={
        <div className={styles.footer}>
          {recoveryRequired ? (
            <>
              <Button disabled={loading || committing} onClick={onCancel}>
                {t('common.projects.assignment.later', { defaultValue: 'Später' })}
              </Button>
              <Button type='primary' loading={loading} onClick={() => void recoverLatestState()}>
                {t('common.projects.assignment.reloadCurrent', { defaultValue: 'Aktuellen Stand laden' })}
              </Button>
            </>
          ) : preview ? (
            <>
              <Button disabled={committing} onClick={() => resetPreview()}>
                {t('common.back', { defaultValue: 'Zurück' })}
              </Button>
              <Button type='primary' loading={committing} aria-busy={committing} onClick={() => void commit()}>
                {t('common.projects.assignment.commit', { defaultValue: 'Zuordnung finalisieren' })}
              </Button>
            </>
          ) : (
            <>
              <Button disabled={committing} onClick={onCancel}>
                {t('common.projects.assignment.later', { defaultValue: 'Später' })}
              </Button>
              <Button type='primary' loading={loading} disabled={!canPreview} onClick={() => void requestPreview()}>
                {t('common.projects.assignment.preview', { defaultValue: 'Vorschau prüfen' })}
              </Button>
            </>
          )}
        </div>
      }
      contentStyle={{ padding: '2px 24px 20px', maxHeight: 'min(72vh, 680px)' }}
      focusLock
      unmountOnExit
    >
      <div className={styles.body}>
        <p className={styles.intro}>
          {t('common.projects.assignment.description', {
            defaultValue:
              'EVE hat diesen Chat automatisch einem Projekt zugeordnet. Prüfe den Vorschlag oder ändere ihn, bevor du ihn finalisierst.',
          })}
        </p>

        {presentation && (
          <div className={styles.error} role='alert'>
            <span>
              <strong>{t(presentation.titleKey)}</strong>
              <br />
              {t(presentation.descriptionKey)}
            </span>
            {canRetryCatalog && (
              <Button type='text' className={styles.retryButton} onClick={() => setReloadVersion((value) => value + 1)}>
                {t('common.retry', { defaultValue: 'Erneut versuchen' })}
              </Button>
            )}
          </div>
        )}

        {recoveryRequired ? (
          <section className={styles.recovery} role='status'>
            {loading ? <Loading {...iconProps} className='eve-spin' /> : <Refresh {...iconProps} />}
            <span>
              <strong>
                {t('common.projects.assignment.recovery.title', { defaultValue: 'Aktuellen Stand neu laden' })}
              </strong>
              <span>
                {t('common.projects.assignment.recovery.description', {
                  defaultValue:
                    'Die Zuordnung hat sich seit der Vorschau geändert. Lade den aktuellen Stand, bevor du erneut entscheidest.',
                })}
              </span>
            </span>
          </section>
        ) : loading && !catalog ? (
          <div className={styles.loading} role='status'>
            <Loading {...iconProps} className='eve-spin' />
            <span className='ml-8px'>{t('common.projects.loading')}</span>
          </div>
        ) : preview ? (
          <section className={styles.preview} aria-label={t('common.projects.assignment.previewSummary')}>
            <div className={styles.previewTitle}>
              {preview.will_change
                ? t('common.projects.assignment.previewChange', { defaultValue: 'Diese Zuordnung wird übernommen' })
                : t('common.projects.assignment.previewKeep', { defaultValue: 'Diese Zuordnung wird bestätigt' })}
            </div>
            <div className={styles.previewFlow}>
              <div className={styles.previewNode}>
                <div className={styles.previewLabel}>
                  {t('common.projects.assignment.current', { defaultValue: 'Aktuell' })}
                </div>
                <div className={styles.previewValue}>{preview.current_project?.title ?? '—'}</div>
              </div>
              <ArrowRight {...iconProps} className={styles.previewArrow} />
              <div className={styles.previewNode}>
                <div className={styles.previewLabel}>
                  {t('common.projects.assignment.afterwards', { defaultValue: 'Danach' })}
                </div>
                <div className={styles.previewValue}>{previewTarget}</div>
              </div>
            </div>
          </section>
        ) : (
          <>
            <div className={styles.choices} role='radiogroup' aria-label={t('common.projects.assignment.choiceLabel')}>
              <Button
                type='text'
                className={styles.choice}
                role='radio'
                aria-checked={choice === 'keep'}
                tabIndex={choice === 'keep' ? 0 : -1}
                onClick={() => resetPreview('keep')}
                onKeyDown={(event) => moveChoiceFocus(event, 'keep')}
              >
                <span className={styles.choiceIcon}>
                  <FolderOpen {...iconProps} />
                </span>
                <span className={styles.choiceCopy}>
                  <span className={styles.choiceTitle}>
                    {t('common.projects.assignment.keep.title', { defaultValue: 'Dieses Projekt behalten' })}
                  </span>
                  <span className={styles.choiceDescription}>
                    {t('common.projects.assignment.keep.description', {
                      defaultValue: 'Bestätige die Zuordnung und passe bei Bedarf den Projektnamen an.',
                    })}
                  </span>
                </span>
                <CheckCircle {...iconProps} className={styles.choiceCheck} />
              </Button>
              <Button
                type='text'
                className={styles.choice}
                role='radio'
                aria-checked={choice === 'project'}
                tabIndex={choice === 'project' ? 0 : -1}
                onClick={() => resetPreview('project')}
                onKeyDown={(event) => moveChoiceFocus(event, 'project')}
              >
                <span className={styles.choiceIcon}>
                  <FolderFocus {...iconProps} />
                </span>
                <span className={styles.choiceCopy}>
                  <span className={styles.choiceTitle}>
                    {t('common.projects.assignment.project.title', { defaultValue: 'Anderem Projekt zuordnen' })}
                  </span>
                  <span className={styles.choiceDescription}>
                    {t('common.projects.assignment.project.description', {
                      defaultValue: 'Wähle ein bestehendes Projekt dieses Seats.',
                    })}
                  </span>
                </span>
                <CheckCircle {...iconProps} className={styles.choiceCheck} />
              </Button>
              <Button
                type='text'
                className={styles.choice}
                role='radio'
                aria-checked={choice === 'temporary'}
                tabIndex={choice === 'temporary' ? 0 : -1}
                onClick={() => resetPreview('temporary')}
                onKeyDown={(event) => moveChoiceFocus(event, 'temporary')}
              >
                <span className={styles.choiceIcon}>
                  <FolderBlock {...iconProps} />
                </span>
                <span className={styles.choiceCopy}>
                  <span className={styles.choiceTitle}>
                    {t('common.projects.assignment.temporary.title', { defaultValue: 'Temporär weiterarbeiten' })}
                  </span>
                  <span className={styles.choiceDescription}>
                    {t('common.projects.assignment.temporary.description', {
                      defaultValue: 'Löse die Projektzuordnung, ohne Nutzerdaten zu löschen.',
                    })}
                  </span>
                </span>
                <CheckCircle {...iconProps} className={styles.choiceCheck} />
              </Button>
            </div>

            {choice === 'keep' && (
              <label className={styles.field}>
                <span className={styles.label}>{t('common.projects.fields.title')}</span>
                <Input
                  className={styles.input}
                  value={title}
                  maxLength={120}
                  onChange={(value) => {
                    setTitle(value);
                    setReason(undefined);
                  }}
                />
              </label>
            )}

            {choice === 'project' && (
              <div className={styles.projectPicker}>
                <Input
                  className={styles.search}
                  value={query}
                  allowClear
                  prefix={<Search {...iconProps} />}
                  placeholder={t('common.projects.assignment.search', { defaultValue: 'Projekte durchsuchen' })}
                  aria-label={t('common.projects.assignment.search', { defaultValue: 'Projekte durchsuchen' })}
                  onChange={(value) => {
                    setQuery(value);
                    setSelectedProjectId(null);
                    setReason(undefined);
                  }}
                />
                <div className={styles.projectList} role='listbox' aria-label={t('common.projects.listLabel')}>
                  {availableProjects.length ? (
                    availableProjects.map((project) => (
                      <Button
                        type='text'
                        key={project.project_id}
                        className={styles.projectRow}
                        role='option'
                        aria-selected={project.project_id === selectedProjectId}
                        tabIndex={project.project_id === rovingProjectId ? 0 : -1}
                        onClick={() => {
                          setSelectedProjectId(project.project_id);
                          setReason(undefined);
                        }}
                        onKeyDown={(event) => moveProjectFocus(event, project.project_id)}
                      >
                        <span className='min-w-0'>
                          <span className={styles.projectName}>{project.title}</span>
                          <span className={styles.projectPlacement}>{placementLabel(project)}</span>
                        </span>
                        {project.project_id === selectedProjectId && <CheckCircle {...iconProps} />}
                      </Button>
                    ))
                  ) : (
                    <div className={styles.empty}>{t('common.projects.assignment.noProjects')}</div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AionModal>
  );
};

export default FinalizeProjectAssignmentDialog;
