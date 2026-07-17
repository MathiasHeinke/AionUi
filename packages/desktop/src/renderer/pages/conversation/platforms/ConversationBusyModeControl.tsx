import { Radio } from '@arco-design/web-react';
import { EditOne, Time } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationBusyControlMode } from './useConversationCommandQueue';
import './ConversationBusyModeControl.css';

type ConversationBusyModeControlProps = {
  visible: boolean;
  value: ConversationBusyControlMode;
  onChange: (value: ConversationBusyControlMode) => void;
};

const ConversationBusyModeControl: React.FC<ConversationBusyModeControlProps> = ({ visible, value, onChange }) => {
  const { t } = useTranslation();

  const queueLabel = t('conversation.commandQueue.busyModeQueue', { defaultValue: 'Afterwards' });
  const steerLabel = t('conversation.commandQueue.busyModeSteer', { defaultValue: 'Correction' });
  const queueTooltip = t('conversation.commandQueue.busyModeQueueTooltip', {
    defaultValue: 'Send after the current run finishes.',
  });
  const steerTooltip = t('conversation.commandQueue.busyModeSteerTooltip', {
    defaultValue: 'Push into the current run after the next tool step.',
  });

  return (
    <div
      className={`conversation-busy-mode-control ${visible ? 'is-visible' : 'is-hidden'}`}
      data-testid='conversation-busy-mode-control'
      aria-hidden={!visible}
    >
      <Radio.Group
        type='button'
        size='mini'
        value={value}
        disabled={!visible}
        onChange={(nextValue) => onChange(nextValue as ConversationBusyControlMode)}
        aria-label={t('conversation.commandQueue.busyModeAria', { defaultValue: 'Busy send mode' })}
      >
        <Radio
          value='queue'
          aria-label={queueLabel}
          title={`${queueLabel}: ${queueTooltip}`}
          data-testid='conversation-busy-mode-queue'
        >
          <Time theme='outline' size='16' aria-hidden='true' />
        </Radio>
        <Radio
          value='steer'
          aria-label={steerLabel}
          title={`${steerLabel}: ${steerTooltip}`}
          data-testid='conversation-busy-mode-steer'
        >
          <EditOne theme='outline' size='16' aria-hidden='true' />
        </Radio>
      </Radio.Group>
    </div>
  );
};

export default ConversationBusyModeControl;
