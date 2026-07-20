import { Alert, Card, Tag, Typography } from '@arco-design/web-react';
import { FolderOpen } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { parseProjectWorkspaceArtifactDTO } from '@renderer/pages/projects/dto';
import {
  getProjectWorkspaceActionKey,
  getProjectWorkspaceReasonPresentation,
} from '@renderer/pages/projects/reasonCodes';

const ProjectWorkspaceCard: React.FC<{ payload: unknown }> = ({ payload }) => {
  const { t } = useTranslation();
  const parsed = useMemo(() => {
    try {
      return parseProjectWorkspaceArtifactDTO(payload);
    } catch {
      return null;
    }
  }, [payload]);

  if (!parsed) {
    return (
      <div>
        <Alert
          type='error'
          title={t('common.projects.artifact.invalidTitle')}
          content={t('common.projects.artifact.invalidDescription')}
        />
      </div>
    );
  }

  const reason = parsed.reason_code ? getProjectWorkspaceReasonPresentation(parsed.reason_code) : undefined;
  const stateColor =
    parsed.state === 'completed'
      ? 'green'
      : parsed.state === 'rejected'
        ? 'red'
        : parsed.state === 'recovery_required'
          ? 'orangered'
          : 'blue';

  return (
    <Card
      bordered
      title={
        <span className='flex min-w-0 items-center gap-8px'>
          <FolderOpen theme='outline' size='18' fill='currentColor' className='shrink-0' />
          <span className='truncate'>{parsed.project_title}</span>
        </span>
      }
      extra={<Tag color={stateColor}>{t(`common.projects.artifact.state.${parsed.state}`)}</Tag>}
      data-testid='project-workspace-card'
    >
      <div className='flex flex-col gap-10px' aria-live='polite'>
        <Typography.Paragraph className='!m-0'>{parsed.intent_summary}</Typography.Paragraph>
        <Typography.Text className='text-t-secondary'>{parsed.target_label}</Typography.Text>
        {parsed.delta_summary.length ? (
          <ul className='m-0 pl-20px text-t-secondary'>
            {parsed.delta_summary.map((delta) => (
              <li key={delta}>{delta}</li>
            ))}
          </ul>
        ) : null}
        {parsed.question ? (
          <div role='status'>
            <Alert type='info' content={parsed.question} />
          </div>
        ) : null}
        {reason ? (
          <div>
            <Alert type='error' title={t(reason.titleKey)} content={t(reason.descriptionKey)} />
          </div>
        ) : null}
        {parsed.receipt ? (
          <Typography.Text className='text-t-secondary'>
            {t('common.projects.artifact.receipt', { receipt: parsed.receipt.receipt_id })}
          </Typography.Text>
        ) : null}
        {parsed.safe_follow_ups.length ? (
          <div className='flex flex-wrap gap-6px' aria-label={t('common.projects.artifact.followUps')}>
            {parsed.safe_follow_ups.map((action) => (
              <Tag key={action}>{t(getProjectWorkspaceActionKey(action))}</Tag>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
};

export default ProjectWorkspaceCard;
