/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import type { WorkbenchLayoutMode } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { BottomBar, FullScreenOne, LeftBar, MessageOne, RightBar } from '@renderer/components/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import styles from './WorkbenchLayoutControls.module.css';

const WorkbenchLayoutControls: React.FC<{ effectiveMode?: WorkbenchLayoutMode }> = ({ effectiveMode }) => {
  const { t } = useTranslation();
  const { activeTab, hidePreview, workbenchLayoutMode, setWorkbenchLayoutMode } = usePreviewContext();
  const displayedMode = effectiveMode ?? workbenchLayoutMode;
  const modes = [
    {
      mode: 'focus' as const,
      label: t('conversation.workbench.focus'),
      icon: <FullScreenOne theme='outline' size={15} fill='currentColor' />,
    },
    {
      mode: 'split-left' as const,
      label: t('conversation.workbench.splitLeft'),
      icon: <LeftBar theme='outline' size={15} fill='currentColor' />,
    },
    {
      mode: 'split-right' as const,
      label: t('conversation.workbench.splitRight'),
      icon: <RightBar theme='outline' size={15} fill='currentColor' />,
    },
    {
      mode: 'split-bottom' as const,
      label: t('conversation.workbench.splitBottom'),
      icon: <BottomBar theme='outline' size={15} fill='currentColor' />,
    },
  ];

  return (
    <div className={styles.root} role='group' aria-label={t('conversation.workbench.layoutLabel')}>
      <button
        type='button'
        className={styles.button}
        aria-label={t('conversation.workbench.returnToChat')}
        title={t('conversation.workbench.returnToChat')}
        onClick={() => {
          const conversationId = activeTab?.metadata?.conversation_id;
          hidePreview();
          window.requestAnimationFrame(() => {
            if (conversationId)
              document.getElementById(`eve-chat-pane-${conversationId}`)?.focus({ preventScroll: true });
          });
        }}
      >
        <MessageOne theme='outline' size={15} fill='currentColor' />
      </button>
      <span className={styles.separator} aria-hidden='true' />
      {modes.map((item) => (
        <button
          key={item.mode}
          type='button'
          className={styles.button}
          data-active={displayedMode === item.mode ? 'true' : 'false'}
          aria-label={item.label}
          aria-pressed={displayedMode === item.mode}
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
