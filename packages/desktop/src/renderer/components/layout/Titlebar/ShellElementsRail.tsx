/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { ELEMENTS_RAIL_SELECT_EVENT, type ElementsRailTab } from '@/renderer/utils/workspace/workspaceEvents';
import { Button, Spin } from '@arco-design/web-react';
import { Caution, CheckOne, Code, FileText, FileWord, FolderOpen, ImageFiles, Right } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ShellElementsRail.module.css';

export type ShellElementsRailProps = {
  conversationId?: string;
  conversationTitle?: React.ReactNode;
  workspacePath?: string;
  contextContent?: React.ReactNode;
  onRequestClose?: () => void;
  initialTab?: ElementsRailTab;
};

const workspaceNameFromPath = (path?: string): string => {
  if (!path) return '';
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || path
  );
};

const artifactIcon = (tab: PreviewTab): React.ReactNode => {
  if (tab.content_type === 'image') return <ImageFiles size={16} aria-hidden='true' />;
  if (tab.content_type === 'code' || tab.content_type === 'html' || tab.content_type === 'diff') {
    return <Code size={16} aria-hidden='true' />;
  }
  if (/\.(docx?|odt)$/i.test(tab.metadata?.file_name || tab.title)) {
    return <FileWord size={16} aria-hidden='true' />;
  }
  return <FileText size={16} aria-hidden='true' />;
};

const ShellElementsRail: React.FC<ShellElementsRailProps> = ({
  conversationId,
  conversationTitle,
  workspacePath,
  contextContent,
  onRequestClose,
  initialTab = 'activity',
}) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ElementsRailTab>(initialTab);
  const runtime = useConversationRuntimeView(conversationId || '');
  const preview = usePreviewContext();
  const artifacts = conversationId
    ? preview.tabs.filter((tab) => tab.metadata?.conversation_id === conversationId)
    : [];

  useEffect(() => {
    const selectTab = (event: Event) => {
      const tab = (event as CustomEvent<ElementsRailTab>).detail;
      if (tab === 'activity' || tab === 'artifacts' || tab === 'context') setActiveTab(tab);
    };
    window.addEventListener(ELEMENTS_RAIL_SELECT_EVENT, selectTab);
    return () => window.removeEventListener(ELEMENTS_RAIL_SELECT_EVENT, selectTab);
  }, []);

  const activity = useMemo(() => {
    if (runtime.view.pendingConfirmations > 0) {
      return {
        icon: <Caution size={18} aria-hidden='true' />,
        tone: 'attention',
        title: t('conversation.elementsRail.needsInput'),
        detail: t('conversation.elementsRail.needsInputDetail'),
      } as const;
    }
    if (runtime.isProcessing) {
      return {
        icon: <Spin size={18} aria-hidden='true' />,
        tone: 'working',
        title: t('conversation.elementsRail.working'),
        detail: t('conversation.elementsRail.workingDetail'),
      } as const;
    }
    return {
      icon: <CheckOne size={18} aria-hidden='true' />,
      tone: 'ready',
      title: t('conversation.elementsRail.ready'),
      detail: t('conversation.elementsRail.readyDetail'),
    } as const;
  }, [runtime.isProcessing, runtime.view.pendingConfirmations, t]);

  const tabItems: Array<{ key: ElementsRailTab; label: string }> = [
    { key: 'activity', label: t('conversation.elementsRail.activity') },
    { key: 'artifacts', label: t('conversation.elementsRail.artifacts') },
    { key: 'context', label: t('conversation.elementsRail.context') },
  ];

  return (
    <aside className={styles.rail} data-testid='shell-elements-rail'>
      <div className={styles.tabs} role='tablist' aria-label={t('conversation.elementsRail.toggle')}>
        {tabItems.map((tab) => (
          <Button
            key={tab.key}
            type='text'
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
            role='tab'
            aria-selected={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
            data-testid={`elements-rail-tab-${tab.key}`}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className={styles.content} role='tabpanel'>
        {activeTab === 'activity' ? (
          <section className={styles.section}>
            <div className={`${styles.activityCard} ${styles[`activityCard_${activity.tone}`]}`}>
              <span className={styles.activityIcon}>{activity.icon}</span>
              <div className={styles.activityCopy}>
                <strong>{activity.title}</strong>
                <span>{activity.detail}</span>
              </div>
            </div>
            {conversationTitle ? (
              <div className={styles.metaBlock}>
                <span className={styles.eyebrow}>{t('conversation.elementsRail.session')}</span>
                <span className={styles.metaValue}>{conversationTitle}</span>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === 'artifacts' ? (
          <section className={styles.section}>
            {artifacts.length === 0 ? (
              <div className={styles.emptyState}>
                <FileText size={22} aria-hidden='true' />
                <strong>{t('conversation.elementsRail.noArtifacts')}</strong>
                <span>{t('conversation.elementsRail.noArtifactsDetail')}</span>
              </div>
            ) : (
              <div className={styles.artifactList}>
                {artifacts.map((tab) => (
                  <Button
                    key={tab.id}
                    type='text'
                    className={styles.artifactButton}
                    onClick={() => {
                      preview.openPreview(tab.content, tab.content_type, tab.metadata);
                      onRequestClose?.();
                    }}
                    aria-label={t('conversation.elementsRail.openArtifact', { name: tab.title })}
                  >
                    <span className={styles.artifactIcon}>{artifactIcon(tab)}</span>
                    <span className={styles.artifactName}>{tab.title}</span>
                    <Right size={13} aria-hidden='true' />
                  </Button>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {activeTab === 'context' ? (
          <section className={styles.section}>
            <div className={styles.contextCard}>
              <span className={styles.contextIcon}>
                <FolderOpen size={17} aria-hidden='true' />
              </span>
              <span className={styles.contextCopy}>
                <span className={styles.eyebrow}>{t('conversation.elementsRail.project')}</span>
                <strong>{workspaceNameFromPath(workspacePath) || t('conversation.elementsRail.noProject')}</strong>
              </span>
            </div>
            {conversationTitle ? (
              <div className={styles.contextCard}>
                <span className={styles.contextCopy}>
                  <span className={styles.eyebrow}>{t('conversation.elementsRail.session')}</span>
                  <strong>{conversationTitle}</strong>
                </span>
              </div>
            ) : null}
            {contextContent ? (
              <div className={styles.contextFiles}>
                <span className={styles.eyebrow}>{t('conversation.elementsRail.projectFiles')}</span>
                <div className={styles.contextFilesContent}>{contextContent}</div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
};

export default ShellElementsRail;
