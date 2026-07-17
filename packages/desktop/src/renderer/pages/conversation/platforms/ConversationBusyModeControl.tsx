import { Button, Dropdown, Menu } from '@arco-design/web-react';
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
  const [popupVisible, setPopupVisible] = React.useState(false);

  React.useEffect(() => {
    if (!visible) {
      setPopupVisible(false);
    }
  }, [visible]);

  const queueLabel = t('conversation.commandQueue.busyModeQueue', { defaultValue: 'Afterwards' });
  const steerLabel = t('conversation.commandQueue.busyModeSteer', { defaultValue: 'Correction' });
  const queueTooltip = t('conversation.commandQueue.busyModeQueueTooltip', {
    defaultValue: 'Send after the current run finishes.',
  });
  const steerTooltip = t('conversation.commandQueue.busyModeSteerTooltip', {
    defaultValue: 'Push into the current run after the next tool step.',
  });
  const ariaLabel = t('conversation.commandQueue.busyModeAria', { defaultValue: 'Busy send mode' });
  const activeLabel = value === 'steer' ? steerLabel : queueLabel;
  const activeTooltip = value === 'steer' ? steerTooltip : queueTooltip;
  const ActiveIcon = value === 'steer' ? EditOne : Time;

  const droplist = (
    <Menu className='conversation-busy-mode-menu' selectedKeys={[value]}>
      <Menu.Item
        key='queue'
        role='menuitemradio'
        onClick={() => onChange('queue')}
        aria-checked={value === 'queue'}
        data-testid='conversation-busy-mode-queue'
      >
        <span className='conversation-busy-mode-menu__item'>
          <Time theme='outline' size='16' aria-hidden='true' />
          <span className='conversation-busy-mode-menu__copy'>
            <strong>{queueLabel}</strong>
            <small>{queueTooltip}</small>
          </span>
        </span>
      </Menu.Item>
      <Menu.Item
        key='steer'
        role='menuitemradio'
        onClick={() => onChange('steer')}
        aria-checked={value === 'steer'}
        data-testid='conversation-busy-mode-steer'
      >
        <span className='conversation-busy-mode-menu__item'>
          <EditOne theme='outline' size='16' aria-hidden='true' />
          <span className='conversation-busy-mode-menu__copy'>
            <strong>{steerLabel}</strong>
            <small>{steerTooltip}</small>
          </span>
        </span>
      </Menu.Item>
    </Menu>
  );

  return (
    <div
      className={`conversation-busy-mode-control ${visible ? 'is-visible' : 'is-hidden'}`}
      data-testid='conversation-busy-mode-control'
      data-state={visible ? 'busy' : 'idle'}
      data-mode={value}
      aria-hidden={!visible}
    >
      <Dropdown
        trigger='click'
        droplist={droplist}
        position='top'
        popupVisible={visible && popupVisible}
        onVisibleChange={(nextVisible) => setPopupVisible(visible && nextVisible)}
      >
        <Button
          type='text'
          shape='circle'
          className='conversation-busy-mode-trigger'
          aria-disabled={!visible}
          tabIndex={visible ? undefined : -1}
          aria-label={`${ariaLabel}: ${activeLabel}`}
          title={`${activeLabel}: ${activeTooltip}`}
          data-testid='conversation-busy-mode-trigger'
        >
          <ActiveIcon theme='outline' size='16' aria-hidden='true' />
        </Button>
      </Dropdown>
    </div>
  );
};

export default ConversationBusyModeControl;
