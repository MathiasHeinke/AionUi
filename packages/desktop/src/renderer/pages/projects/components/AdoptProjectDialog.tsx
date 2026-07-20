import { Alert, Button, Modal, Space, Typography } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createIdempotencyKey, ProjectWorkspaceClientError, useProjectWorkspaceClient } from '../client';
import { getProjectWorkspaceReasonPresentation } from '../reasonCodes';
import type { ProjectWorkspacePreviewDTO, ProjectWorkspaceReasonCode } from '../types';

type AdoptProjectDialogProps = {
  visible: boolean;
  seatContextRevision: number;
  onClose: () => void;
  onAfterClose: () => void;
  onCompleted: () => void;
};

const AdoptProjectDialog: React.FC<AdoptProjectDialogProps> = ({
  visible,
  seatContextRevision,
  onClose,
  onAfterClose,
  onCompleted,
}) => {
  const { t } = useTranslation();
  const client = useProjectWorkspaceClient();
  const [preview, setPreview] = useState<ProjectWorkspacePreviewDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<ProjectWorkspaceReasonCode>();

  useEffect(() => {
    if (!visible) return;
    setPreview(null);
    setReason(undefined);
  }, [visible]);

  const captureReason = (error: unknown) => {
    setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'invariant_failure');
  };

  const choose = async () => {
    setBusy(true);
    setReason(undefined);
    try {
      setPreview(await client.previewAdopt({ seat_context_revision: seatContextRevision }));
    } catch (error) {
      captureReason(error);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setReason(undefined);
    try {
      const receipt = await client.adopt({
        preview_id: preview.preview_id,
        expected_preview_revision: preview.preview_revision,
        seat_context_revision: seatContextRevision,
        idempotency_key: createIdempotencyKey(),
      });
      if (receipt.outcome === 'completed') {
        onCompleted();
        return;
      }
      setReason(receipt.reason_code ?? 'invariant_failure');
    } catch (error) {
      captureReason(error);
    } finally {
      setBusy(false);
    }
  };

  const reasonPresentation = reason ? getProjectWorkspaceReasonPresentation(reason) : undefined;

  return (
    <Modal
      visible={visible}
      title={t('common.projects.adopt.title')}
      onCancel={busy ? undefined : onClose}
      afterClose={onAfterClose}
      footer={
        <Space>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {preview ? (
            <Button type='primary' loading={busy} aria-busy={busy} onClick={() => void commit()}>
              {t('common.projects.adopt.confirm')}
            </Button>
          ) : (
            <Button type='primary' loading={busy} aria-busy={busy} onClick={() => void choose()}>
              {t('common.projects.adopt.chooseFolder')}
            </Button>
          )}
        </Space>
      }
      focusLock
      autoFocus={false}
      unmountOnExit
    >
      <div className='flex flex-col gap-16px' aria-live='polite'>
        {reasonPresentation ? (
          <div>
            <Alert type='error' title={t(reasonPresentation.titleKey)} content={t(reasonPresentation.descriptionKey)} />
          </div>
        ) : null}
        {preview ? (
          <section aria-labelledby='project-adopt-preview-title' className='flex flex-col gap-10px'>
            <Typography.Title id='project-adopt-preview-title' heading={6} className='!m-0'>
              {preview.project_title}
            </Typography.Title>
            <Typography.Paragraph className='!m-0'>
              {t('common.projects.create.destination', { destination: preview.destination_label })}
            </Typography.Paragraph>
            <ul className='m-0 pl-20px text-t-secondary'>
              {preview.semantic_writes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ) : (
          <Typography.Paragraph className='!m-0 text-t-secondary'>
            {t('common.projects.adopt.description')}
          </Typography.Paragraph>
        )}
      </div>
    </Modal>
  );
};

export default AdoptProjectDialog;
