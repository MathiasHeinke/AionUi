import { Radio, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationBusyControlMode } from './useConversationCommandQueue';

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

  return (
    <div className='mb-8px flex items-center justify-end'>
      <Radio.Group
        type='button'
        value={value}
        onChange={(nextValue) => onChange(nextValue as ConversationBusyControlMode)}
        aria-label={t('conversation.commandQueue.busyModeAria', { defaultValue: 'Busy send mode' })}
        data-testid='conversation-busy-mode-control'
      >
        <Radio value='queue'>
          <Tooltip
            mini
            content={t('conversation.commandQueue.busyModeQueueTooltip', {
              defaultValue: 'Send after the current run finishes.',
            })}
          >
            <span>{t('conversation.commandQueue.busyModeQueue', { defaultValue: 'Afterwards' })}</span>
          </Tooltip>
        </Radio>
        <Radio value='steer'>
          <Tooltip
            mini
            content={t('conversation.commandQueue.busyModeSteerTooltip', {
              defaultValue: 'Push into the current run after the next tool step.',
            })}
          >
            <span>{t('conversation.commandQueue.busyModeSteer', { defaultValue: 'Correction' })}</span>
          </Tooltip>
        </Radio>
      </Radio.Group>
    </div>
  );
};

export default ConversationBusyModeControl;
