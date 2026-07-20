import { Alert, Button, Input, Modal, Space } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createIdempotencyKey, ProjectWorkspaceClientError, useProjectWorkspaceClient } from '../client';
import { getProjectWorkspaceReasonPresentation } from '../reasonCodes';
import type { ProjectSummaryDTO, ProjectWorkspaceReasonCode } from '../types';

type EditProjectDialogProps = {
  project: ProjectSummaryDTO | null;
  seatContextRevision: number;
  onClose: () => void;
  onAfterClose: () => void;
  onCompleted: () => void;
};

const EditProjectDialog: React.FC<EditProjectDialogProps> = ({
  project,
  seatContextRevision,
  onClose,
  onAfterClose,
  onCompleted,
}) => {
  const { t } = useTranslation();
  const client = useProjectWorkspaceClient();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<ProjectWorkspaceReasonCode>();

  useEffect(() => {
    setTitle(project?.title ?? '');
    setReason(undefined);
  }, [project]);

  const save = async () => {
    if (!project || !title.trim()) return;
    setBusy(true);
    setReason(undefined);
    try {
      const receipt = await client.updateMetadata({
        project_id: project.project_id,
        expected_revision: project.revision,
        seat_context_revision: seatContextRevision,
        idempotency_key: createIdempotencyKey(),
        title: title.trim(),
      });
      if (receipt.outcome === 'completed') {
        onCompleted();
        return;
      }
      setReason(receipt.reason_code ?? 'invariant_failure');
    } catch (error) {
      setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'invariant_failure');
    } finally {
      setBusy(false);
    }
  };

  const presentation = reason ? getProjectWorkspaceReasonPresentation(reason) : undefined;

  return (
    <Modal
      visible={Boolean(project)}
      title={t('common.projects.edit.title')}
      onCancel={busy ? undefined : onClose}
      afterClose={onAfterClose}
      footer={
        <Space>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type='primary'
            loading={busy}
            aria-busy={busy}
            disabled={!title.trim() || title.trim() === project?.title}
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </Space>
      }
      focusLock
      unmountOnExit
    >
      <div className='flex flex-col gap-12px'>
        {presentation ? (
          <div>
            <Alert type='error' title={t(presentation.titleKey)} content={t(presentation.descriptionKey)} />
          </div>
        ) : null}
        <label className='flex flex-col gap-6px'>
          <span className='text-13px font-500 text-t-primary'>{t('common.projects.fields.title')}</span>
          <Input value={title} maxLength={120} autoFocus onChange={setTitle} />
        </label>
      </div>
    </Modal>
  );
};

export default EditProjectDialog;
