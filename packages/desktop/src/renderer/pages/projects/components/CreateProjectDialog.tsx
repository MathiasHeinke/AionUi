import { Alert, Button, Input, Modal, Select, Space, Typography } from '@arco-design/web-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createIdempotencyKey, ProjectWorkspaceClientError, useProjectWorkspaceClient } from '../client';
import { getProjectWorkspaceReasonPresentation } from '../reasonCodes';
import type { ProjectPlacementDTO, ProjectWorkspacePreviewDTO, ProjectWorkspaceReasonCode } from '../types';

type CreateProjectDialogProps = {
  visible: boolean;
  placements: ProjectPlacementDTO[];
  seatContextRevision: number;
  onClose: () => void;
  onAfterClose: () => void;
  onCompleted: () => void;
};

const CreateProjectDialog: React.FC<CreateProjectDialogProps> = ({
  visible,
  placements,
  seatContextRevision,
  onClose,
  onAfterClose,
  onCompleted,
}) => {
  const { t } = useTranslation();
  const client = useProjectWorkspaceClient();
  const [placementId, setPlacementId] = useState('');
  const [title, setTitle] = useState('');
  const [profile, setProfile] = useState('');
  const [preview, setPreview] = useState<ProjectWorkspacePreviewDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<ProjectWorkspaceReasonCode>();

  const writablePlacements = useMemo(() => placements.filter((placement) => placement.writable), [placements]);

  useEffect(() => {
    if (!visible) return;
    setPlacementId(writablePlacements[0]?.placement_id ?? '');
    setTitle('');
    setProfile('');
    setPreview(null);
    setReason(undefined);
  }, [visible, writablePlacements]);

  const captureReason = (error: unknown) => {
    setReason(error instanceof ProjectWorkspaceClientError ? error.reason_code : 'invariant_failure');
  };

  const requestPreview = async () => {
    if (!placementId || !title.trim()) return;
    setBusy(true);
    setReason(undefined);
    try {
      setPreview(
        await client.previewCreate({
          placement_id: placementId,
          title: title.trim(),
          profile: profile.trim() || undefined,
          seat_context_revision: seatContextRevision,
        })
      );
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
      const receipt = await client.create({
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
      title={t('common.projects.create.title')}
      onCancel={busy ? undefined : onClose}
      afterClose={onAfterClose}
      footer={
        <Space>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {preview ? (
            <Button type='primary' loading={busy} aria-busy={busy} onClick={() => void commit()}>
              {t('common.projects.create.confirm')}
            </Button>
          ) : (
            <Button
              type='primary'
              loading={busy}
              aria-busy={busy}
              disabled={!placementId || !title.trim()}
              onClick={() => void requestPreview()}
            >
              {t('common.projects.create.preview')}
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
          <section aria-labelledby='project-create-preview-title' className='flex flex-col gap-10px'>
            <Typography.Title id='project-create-preview-title' heading={6} className='!m-0'>
              {t('common.projects.create.previewTitle')}
            </Typography.Title>
            <Typography.Paragraph className='!m-0'>
              {t('common.projects.create.destination', { destination: preview.destination_label })}
            </Typography.Paragraph>
            <ul className='m-0 pl-20px text-t-secondary'>
              {preview.scaffold_summary.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <Typography.Paragraph className='!m-0 text-t-secondary'>{preview.conversation_effect}</Typography.Paragraph>
          </section>
        ) : (
          <>
            <label className='flex flex-col gap-6px'>
              <span className='text-13px font-500 text-t-primary'>{t('common.projects.fields.placement')}</span>
              <Select
                value={placementId || undefined}
                onChange={setPlacementId}
                aria-label={t('common.projects.fields.placement')}
              >
                {writablePlacements.map((placement) => (
                  <Select.Option key={placement.placement_id} value={placement.placement_id}>
                    {placement.realm_label} · {placement.root_label}
                  </Select.Option>
                ))}
              </Select>
            </label>
            <label className='flex flex-col gap-6px'>
              <span className='text-13px font-500 text-t-primary'>{t('common.projects.fields.title')}</span>
              <Input
                value={title}
                maxLength={120}
                autoFocus
                onChange={setTitle}
                placeholder={t('common.projects.fields.titlePlaceholder')}
              />
            </label>
            <label className='flex flex-col gap-6px'>
              <span className='text-13px font-500 text-t-primary'>{t('common.projects.fields.profile')}</span>
              <Input.TextArea
                value={profile}
                maxLength={500}
                onChange={setProfile}
                placeholder={t('common.projects.fields.profilePlaceholder')}
                autoSize={{ minRows: 2, maxRows: 5 }}
              />
            </label>
          </>
        )}
      </div>
    </Modal>
  );
};

export default CreateProjectDialog;
