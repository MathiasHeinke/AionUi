import { Radio, Tooltip } from '@arco-design/web-react';
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

  if (!visible) {
    return null;
  }

  const queueLabel = t('conversation.commandQueue.busyModeQueue', { defaultValue: 'Afterwards' });
  const steerLabel = t('conversation.commandQueue.busyModeSteer', { defaultValue: 'Correction' });

  return (
    <div className='conversation-busy-mode-control' data-testid='conversation-busy-mode-control'>
      <Radio.Group
        type='button'
        size='mini'
        value={value}
        onChange={(nextValue) => onChange(nextValue as ConversationBusyControlMode)}
        aria-label={t('conversation.commandQueue.busyModeAria', { defaultValue: 'Busy send mode' })}
      >
        <Tooltip
          mini
          content={t('conversation.commandQueue.busyModeQueueTooltip', {
            defaultValue: 'Send after the current run finishes.',
          })}
        >
          <Radio value='queue' aria-label={queueLabel} data-testid='conversation-busy-mode-queue'>
            <Time theme='outline' size='15' aria-hidden='true' />
          </Radio>
        </Tooltip>
        <Tooltip
          mini
          content={t('conversation.commandQueue.busyModeSteerTooltip', {
            defaultValue: 'Push into the current run after the next tool step.',
          })}
        >
          <Radio value='steer' aria-label={steerLabel} data-testid='conversation-busy-mode-steer'>
            <EditOne theme='outline' size='15' aria-hidden='true' />
          </Radio>
        </Tooltip>
      </Radio.Group>
    </div>
  );
};

export default ConversationBusyModeControl;
