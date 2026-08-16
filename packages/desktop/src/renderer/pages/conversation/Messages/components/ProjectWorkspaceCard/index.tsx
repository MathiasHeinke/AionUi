import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Caution, CheckOne as CheckCircle, Down, FolderOpen, Info, Open } from '@renderer/components/icons';
import AionCollapse from '@renderer/components/base/AionCollapse';
import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectWorkspaceClient } from '@renderer/pages/projects/client';
import { parseProjectWorkspaceConversationArtifactDTO } from '@renderer/pages/projects/dto';
import { resolveProjectWorkspaceI18n } from '@renderer/pages/projects/i18nRef';
import { getProjectWorkspaceReasonPresentation } from '@renderer/pages/projects/reasonCodes';
import type { ProjectWorkspaceConversationArtifactDTO } from '@renderer/pages/projects/types';
import FinalizeProjectAssignmentDialog from './FinalizeProjectAssignmentDialog';
import styles from './ProjectWorkspaceCard.module.css';

type ProjectWorkspaceCardProps = { artifact: unknown };

const iconProps = { theme: 'outline' as const, size: 18, fill: 'currentColor', 'aria-hidden': true };

const normalizedPlacement = (label: string): string => {
  const parts = label
    .split(/\s*(?:·|\/)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' · ');
};

const ProjectWorkspaceCard: React.FC<ProjectWorkspaceCardProps> = ({ artifact }) => {
  const { t } = useTranslation();
  const client = useProjectWorkspaceClient();
  const reviewButtonRef = useRef<HTMLButtonElement | null>(null);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [committedArtifact, setCommittedArtifact] = useState<ProjectWorkspaceConversationArtifactDTO | null>(null);
  const parsedArtifact = useMemo(() => {
    try {
      return parseProjectWorkspaceConversationArtifactDTO(artifact);
    } catch {
      return null;
    }
  }, [artifact]);
  const displayArtifact =
    committedArtifact &&
    parsedArtifact &&
    committedArtifact.id === parsedArtifact.id &&
    committedArtifact.updated_at >= parsedArtifact.updated_at
      ? committedArtifact
      : parsedArtifact;

  if (!displayArtifact) {
    return (
      <div className={styles.standaloneNotice} data-tone='danger' role='alert'>
        <Caution {...iconProps} />
        <span>
          <strong>{t('common.projects.artifact.invalidTitle')}</strong>
          <span>{t('common.projects.artifact.invalidDescription')}</span>
        </span>
      </div>
    );
  }

  const payload = displayArtifact.payload;
  const reason = payload.reason_code ? getProjectWorkspaceReasonPresentation(payload.reason_code) : undefined;
  const question = payload.question_i18n
    ? resolveProjectWorkspaceI18n(payload.question_i18n, t, payload.question ?? '')
    : payload.question;
  const placement = normalizedPlacement(payload.target_label);
  const isTemporary = !payload.project_id;
  const displayTitle = isTemporary
    ? t('common.projects.assignment.temporaryTarget', { defaultValue: 'Temporärer Bereich' })
    : payload.project_title;
  const showPlacement =
    !isTemporary && placement && placement.toLocaleLowerCase() !== displayTitle.trim().toLocaleLowerCase();
  const isFinalized = payload.assignment_finalized_at !== undefined;
  const tone =
    payload.state === 'rejected' ? 'danger' : payload.state === 'recovery_required' ? 'attention' : 'success';
  const statusLabel = isFinalized
    ? t('common.projects.artifact.finalized', { defaultValue: 'Finalisiert' })
    : payload.state === 'completed'
      ? t('common.projects.artifact.assigned', { defaultValue: 'Zugeordnet' })
      : t(`common.projects.artifact.state.${payload.state}`);
  const eyebrow = isFinalized
    ? t('common.projects.artifact.assignmentFinalized', { defaultValue: 'Projektzuordnung finalisiert' })
    : t('common.projects.artifact.autoAssigned', { defaultValue: 'Projekt automatisch zugeordnet' });

  const closeDialog = () => {
    setDialogVisible(false);
    window.setTimeout(() => reviewButtonRef.current?.focus(), 0);
  };

  const reveal = async () => {
    if (!payload.project_id || revealing) return;
    setRevealing(true);
    try {
      const catalog = await client.list();
      const project = catalog.projects.find((candidate) => candidate.project_id === payload.project_id);
      if (!project || !project.allowed_actions.includes('reveal')) throw new Error('project-reveal-unavailable');
      await client.reveal({ project_id: project.project_id, seat_context_revision: catalog.seat_context_revision });
    } catch {
      Message.error({
        content: t('common.projects.artifact.revealFailed', {
          defaultValue: 'Das Projekt konnte nicht im Finder geöffnet werden.',
        }),
        duration: 5000,
      });
    } finally {
      setRevealing(false);
    }
  };

  return (
    <>
      <article className={styles.card} data-testid='project-workspace-card' aria-live='polite'>
        <div className={styles.main}>
          <span className={styles.icon}>
            <FolderOpen {...iconProps} />
          </span>
          <div className={styles.copy}>
            <div className={styles.eyebrow}>{eyebrow}</div>
            <div className={styles.titleRow}>
              <span className={styles.title}>{displayTitle}</span>
              <span className={styles.status} data-tone={tone}>
                <span className={styles.statusDot} aria-hidden='true' />
                {statusLabel}
              </span>
            </div>
            {showPlacement ? <div className={styles.placement}>{placement}</div> : null}
          </div>
          <div className={styles.actions}>
            {payload.state === 'completed' && (
              <Button ref={reviewButtonRef} className={styles.reviewButton} onClick={() => setDialogVisible(true)}>
                <CheckCircle size={16} aria-hidden='true' />
                {isFinalized
                  ? t('common.projects.artifact.changeAssignment', { defaultValue: 'Zuordnung ändern' })
                  : t('common.projects.artifact.review', { defaultValue: 'Zuordnung prüfen' })}
              </Button>
            )}
            {payload.project_id && (
              <Tooltip content={t('common.projects.actions.reveal')}>
                <Button
                  className={styles.iconButton}
                  loading={revealing}
                  aria-label={t('common.projects.actions.reveal')}
                  onClick={() => void reveal()}
                >
                  <Open size={17} aria-hidden='true' />
                </Button>
              </Tooltip>
            )}
          </div>
        </div>

        {question ? (
          <div className={styles.notice} data-tone='info' role='status'>
            <Info size={16} aria-hidden='true' />
            <span>{question}</span>
          </div>
        ) : null}
        {reason ? (
          <div className={styles.notice} data-tone='danger' role='alert'>
            <Caution size={16} aria-hidden='true' />
            <span>
              <strong>{t(reason.titleKey)}</strong>
              <span>{t(reason.descriptionKey)}</span>
            </span>
          </div>
        ) : null}

        {(payload.delta_summary.length > 0 || payload.receipt) && (
          <AionCollapse
            className={styles.details}
            bordered={false}
            expandIconPosition='right'
            expandIcon={(active) => (
              <Down
                size={14}
                aria-hidden='true'
                className={active ? styles.detailsChevronActive : styles.detailsChevron}
              />
            )}
          >
            <AionCollapse.Item
              name='technical-details'
              header={
                <span className={styles.detailsTitle}>
                  <Info size={15} aria-hidden='true' />
                  {t('common.projects.artifact.technicalDetails', { defaultValue: 'Technische Details' })}
                </span>
              }
              headerClassName={styles.detailsHeader}
              contentClassName={styles.detailsContent}
            >
              <div className={styles.detailsBody}>
                {payload.delta_summary.length > 0 && (
                  <ul className={styles.detailList}>
                    {payload.delta_summary.map((delta) => (
                      <li key={delta}>{delta}</li>
                    ))}
                  </ul>
                )}
                {payload.receipt && (
                  <span className={styles.receipt}>
                    {t('common.projects.artifact.receipt', { receipt: payload.receipt.receipt_id })}
                  </span>
                )}
              </div>
            </AionCollapse.Item>
          </AionCollapse>
        )}
      </article>

      {dialogVisible && (
        <FinalizeProjectAssignmentDialog
          artifact={displayArtifact}
          onCancel={closeDialog}
          onArtifactRefresh={setCommittedArtifact}
          onCompleted={(nextArtifact) => {
            if (nextArtifact) setCommittedArtifact(nextArtifact);
            closeDialog();
          }}
        />
      )}
    </>
  );
};

export default ProjectWorkspaceCard;
