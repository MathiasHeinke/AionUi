import { Loading } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type AcpDocumentPreparationPhase =
  | 'reading_local'
  | 'awaiting_cloud_ocr'
  | 'reading_cloud'
  | 'handoff'
  | 'reading_presentation_local'
  | 'awaiting_cloud_vision'
  | 'reading_cloud_vision'
  | 'presentation_handoff'
  | 'presentation_error'
  | 'reading_image_local'
  | 'awaiting_image_cloud_vision'
  | 'reading_image_cloud_vision'
  | 'image_handoff'
  | 'image_error'
  | 'error';

export type AcpDocumentPreparationState = {
  phase: AcpDocumentPreparationPhase;
  fileCount: number;
  startedAt: number;
};

const ACTIVE_PHASES = new Set<AcpDocumentPreparationPhase>([
  'reading_local',
  'reading_cloud',
  'handoff',
  'reading_presentation_local',
  'reading_cloud_vision',
  'presentation_handoff',
  'reading_image_local',
  'reading_image_cloud_vision',
  'image_handoff',
]);

function formatElapsed(milliseconds: number): string {
  return `${Math.max(0, Math.floor(milliseconds / 1000))}s`;
}

const AcpDocumentPreparationStatus: React.FC<{ state: AcpDocumentPreparationState | null }> = ({ state }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!state || !ACTIVE_PHASES.has(state.phase)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  if (!state) return null;

  const isActive = ACTIVE_PHASES.has(state.phase);
  const translationRoot = state.phase.includes('image')
    ? 'conversation.image.phase'
    : state.phase.includes('presentation') || state.phase.includes('vision')
      ? 'conversation.presentation.phase'
      : 'conversation.pdf.phase';
  const label = t(`${translationRoot}.${state.phase}`, {
    count: state.fileCount,
    defaultValue: state.phase,
  });

  return (
    <div
      className={`acp-document-preparation acp-document-preparation--${state.phase}`}
      data-testid='acp-document-preparation'
      role={state.phase === 'error' || state.phase.endsWith('_error') ? 'alert' : 'status'}
      aria-live={state.phase === 'error' || state.phase.endsWith('_error') ? 'assertive' : 'polite'}
    >
      {isActive ? <Loading theme='outline' size='14' className='animate-spin shrink-0' /> : null}
      <span className='acp-document-preparation__label'>{label}</span>
      {isActive ? (
        <span className='acp-document-preparation__elapsed'>{formatElapsed(now - state.startedAt)}</span>
      ) : null}
    </div>
  );
};

export default AcpDocumentPreparationStatus;
