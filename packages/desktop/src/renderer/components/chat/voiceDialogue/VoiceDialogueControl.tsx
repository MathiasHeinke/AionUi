import { Button, Tooltip } from '@arco-design/web-react';
import { VolumeNotice } from '@renderer/components/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { iconColors } from '@/renderer/styles/colors';
import type { VoiceDialoguePhase } from './voiceDialogueCore';

const ACTIVE_PHASES = new Set<VoiceDialoguePhase>(['listening', 'transcribing', 'thinking', 'speaking']);

const VoiceDialogueControl: React.FC<{
  disabled?: boolean;
  enabled: boolean;
  phase: VoiceDialoguePhase;
  onToggle: () => void;
}> = ({ disabled, enabled, phase, onToggle }) => {
  const { t } = useTranslation();
  const status = t(`conversation.chat.voiceDialogue.status.${phase}`, { defaultValue: phase });
  const label = enabled
    ? t('conversation.chat.voiceDialogue.disable', { defaultValue: 'Sprachdialog ausschalten' })
    : t('conversation.chat.voiceDialogue.enable', { defaultValue: 'Sprachdialog einschalten' });
  const active = ACTIVE_PHASES.has(phase);

  return (
    <Tooltip content={`${label} · ${status}`} mini>
      <Button
        type='text'
        size='small'
        shape='circle'
        className={`voice-dialogue-toggle ${enabled ? 'bg-fill-2 text-primary-6' : 'text-t-secondary'}`}
        disabled={disabled}
        aria-label={`${label}. ${status}`}
        aria-pressed={enabled}
        data-testid='voice-dialogue-toggle'
        data-phase={phase}
        onClick={onToggle}
      >
        <span className='relative inline-flex h-18px w-18px items-center justify-center' aria-hidden='true'>
          <VolumeNotice
            theme={enabled ? 'filled' : 'outline'}
            size='17'
            fill={enabled ? iconColors.primary : iconColors.secondary}
          />
          {enabled ? (
            <span
              className={`absolute -right-2px -top-2px h-6px w-6px rd-full ${phase === 'error' ? 'bg-danger-6' : active ? 'bg-success-6 animate-pulse' : 'bg-primary-6'}`}
            />
          ) : null}
        </span>
      </Button>
    </Tooltip>
  );
};

export default VoiceDialogueControl;
