/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { FullScreenOne, LayoutThree, LayoutTwo, RightBar } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './WorkbenchLayoutControls.module.css';

const WorkbenchLayoutControls: React.FC = () => {
  const { t } = useTranslation();
  const { workbenchLayoutMode, setWorkbenchLayoutMode } = usePreviewContext();
  const modes = [
    {
      mode: 'focus' as const,
      label: t('conversation.workbench.focus'),
      icon: <FullScreenOne theme='outline' size={15} fill='currentColor' />,
    },
    {
      mode: 'split-right' as const,
      label: t('conversation.workbench.splitRight'),
      icon: <LayoutTwo theme='outline' size={15} fill='currentColor' />,
    },
    {
      mode: 'split-bottom' as const,
      label: t('conversation.workbench.splitBottom'),
      icon: <LayoutThree theme='outline' size={15} fill='currentColor' />,
    },
    {
      mode: 'sidecar' as const,
      label: t('conversation.workbench.sidecar'),
      icon: <RightBar theme='outline' size={15} fill='currentColor' />,
    },
  ];

  return (
    <div className={styles.root} role='group' aria-label={t('conversation.workbench.layoutLabel')}>
      {modes.map((item) => (
        <button
          key={item.mode}
          type='button'
          className={styles.button}
          data-active={workbenchLayoutMode === item.mode ? 'true' : 'false'}
          aria-label={item.label}
          aria-pressed={workbenchLayoutMode === item.mode}
          title={item.label}
          onClick={() => setWorkbenchLayoutMode(item.mode)}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
};

export default WorkbenchLayoutControls;
