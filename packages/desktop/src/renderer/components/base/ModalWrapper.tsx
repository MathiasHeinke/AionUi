import type { ModalProps } from '@arco-design/web-react';
import { Button, Modal } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface ModalWrapperProps extends Omit<ModalProps, 'title'> {
  children?: React.ReactNode;
  title?: React.ReactNode;
  showCustomClose?: boolean;
}

const ModalWrapper: React.FC<ModalWrapperProps> = ({
  children,
  title,
  showCustomClose = true,
  onCancel,
  className = '',
  ...props
}) => {
  const { t } = useTranslation();

  return (
    <Modal
      {...props}
      title={null}
      closable={false}
      onCancel={onCancel}
      className={`aionui-modal aionui-modal--legacy ${className}`}
    >
      <div className='aionui-modal-wrapper'>
        {showCustomClose && title && (
          <div className='aionui-modal-header'>
            <h3 className='aionui-modal-title'>{title}</h3>
            <Button
              type='text'
              onClick={onCancel}
              className='aionui-modal-close-btn eve-focus-ring'
              aria-label={t('common.close', { defaultValue: 'Close' })}
              icon={<Close size={18} fill='currentColor' />}
            />
          </div>
        )}
        {children}
      </div>
    </Modal>
  );
};

export default ModalWrapper;
