/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { Button, Form, Tooltip } from '@arco-design/web-react';
import { FolderOpen } from '@renderer/components/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Directory selection input component
 * Used for selecting and displaying system directory paths
 */
const DirInputItem: React.FC<{
  label: string;
  field: string;
}> = ({ label, field }) => {
  const { t } = useTranslation();
  return (
    <Form.Item label={label} field={field}>
      {(_value, form) => {
        const current_value = form.getFieldValue(field) || '';
        const actionTooltip = field === 'workDir' ? t('settings.changeWorkDir') : t('settings.changeLogDir');

        const handlePick = () => {
          ipcBridge.dialog.showOpen
            .invoke({
              defaultPath: current_value,
              properties: ['openDirectory', 'createDirectory'],
            })
            .then((data) => {
              if (data?.[0]) {
                form.setFieldValue(field, data[0]);
              }
            })
            .catch((error) => {
              console.error('Failed to open directory dialog:', error);
            });
        };

        return (
          <Tooltip content={actionTooltip} position='top'>
            <Button type='secondary' long className='eve-dir-input' aria-label={actionTooltip} onClick={handlePick}>
              <span className='eve-dir-input__value'>{current_value || t('settings.dirNotConfigured')}</span>
              <FolderOpen theme='outline' size='17' />
            </Button>
          </Tooltip>
        );
      }}
    </Form.Item>
  );
};

export default DirInputItem;
