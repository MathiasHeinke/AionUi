/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import {
  isVisibleConversationArtifact,
  mediaArtifactTypeOf,
  useConversationArtifactsById,
} from '@/renderer/pages/conversation/Messages/artifacts';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { ELEMENTS_RAIL_SELECT_EVENT, type ElementsRailTab } from '@/renderer/utils/workspace/workspaceEvents';
import { Button, Spin } from '@arco-design/web-react';
import {
  Caution,
  CheckOne,
  Code,
  FileText,
  FileWord,
  FolderOpen,
  ImageFiles,
  Music,
  Right,
  Video,
} from '@icon-park/react';
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
  activeTab?: ElementsRailTab;
  onTabChange?: (tab: ElementsRailTab) => void;
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

type RailArtifactType = 'image' | 'video' | 'audio' | 'html' | 'file' | null;

const ARTIFACT_SOURCE_URL_KEYS = [
  'url',
  'file_url',
  'href',
  'src',
  'data_url',
  'download_url',
  'output_url',
  'preview_url',
  'thumbnail_url',
];
const ARTIFACT_SOURCE_PATH_KEYS = ['path', 'file_path', 'absolute_path', 'relative_path'];

const readPayloadString = (payload: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const fileNameOf = (value?: string): string | undefined => {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').split('?')[0].split('#')[0];
  return normalized.split('/').filter(Boolean).pop();
};

const railArtifactTypeOf = (artifact: IConversationArtifact): RailArtifactType => {
  const mediaType = mediaArtifactTypeOf(artifact);
  if (mediaType) return mediaType;
  if (artifact.kind === 'cron_trigger' || artifact.kind === 'skill_suggest') return null;
  if (artifact.kind === 'image' || artifact.kind === 'video' || artifact.kind === 'audio' || artifact.kind === 'html') {
    return artifact.kind;
  }
  const payload = artifact.payload as Record<string, unknown>;
  const explicit = payload.artifact_type;
  return explicit === 'audio' || explicit === 'html' || explicit === 'file' ? explicit : 'file';
};

const railArtifactTypeLabel = (t: (key: string) => string, type: RailArtifactType): string => {
  switch (type) {
    case 'image':
      return t('messages.artifact.image');
    case 'video':
      return t('messages.artifact.video');
    case 'audio':
      return t('messages.artifact.audio');
    case 'html':
      return t('messages.artifact.html');
    default:
      return t('messages.artifact.file');
  }
};

const railArtifactTitle = (
  artifact: IConversationArtifact,
  type: RailArtifactType,
  t: (key: string, options?: { type?: string }) => string
): string => {
  const payload = artifact.payload as Record<string, unknown>;
  if (artifact.kind === 'cron_trigger') {
    return readPayloadString(payload, ['cron_job_name']) || t('messages.artifact.file');
  }
  if (artifact.kind === 'skill_suggest') {
    return readPayloadString(payload, ['name']) || t('messages.artifact.file');
  }
  return (
    readPayloadString(payload, ['title', 'name', 'file_name']) ||
    fileNameOf(readPayloadString(payload, ARTIFACT_SOURCE_PATH_KEYS)) ||
    fileNameOf(readPayloadString(payload, ARTIFACT_SOURCE_URL_KEYS)) ||
    t('messages.artifact.generated', { type: railArtifactTypeLabel(t, type) })
  );
};

const artifactIcon = (type: RailArtifactType, fileName?: string): React.ReactNode => {
  if (type === 'image') return <ImageFiles size={16} aria-hidden='true' />;
  if (type === 'video') return <Video size={16} aria-hidden='true' />;
  if (type === 'audio') return <Music size={16} aria-hidden='true' />;
  if (type === 'html') return <Code size={16} aria-hidden='true' />;
  if (fileName && /\.(docx?|odt)$/i.test(fileName)) return <FileWord size={16} aria-hidden='true' />;
  return <FileText size={16} aria-hidden='true' />;
};

const ShellElementsRail: React.FC<ShellElementsRailProps> = ({
  conversationId,
  conversationTitle,
  workspacePath,
  contextContent,
  onRequestClose,
  initialTab = 'activity',
  activeTab: controlledActiveTab,
  onTabChange,
}) => {
  const { t } = useTranslation();
  const [uncontrolledActiveTab, setUncontrolledActiveTab] = useState<ElementsRailTab>(initialTab);
  const activeTab = controlledActiveTab ?? uncontrolledActiveTab;
  const runtime = useConversationRuntimeView(conversationId || '');
  const preview = usePreviewContext();
  // MAT-1773 — the SAME shared store the chat tray renders from
  // (ConversationArtifactContext), not preview tabs: managed artifacts (img_h_
  // images, videos) never become preview tabs, which is exactly why this list
  // used to stay empty. Reactive by subscription — a managed-lane bind or a
  // staged report re-renders the list in place.
  const conversationArtifacts = useConversationArtifactsById(conversationId);
  const artifacts = useMemo(() => conversationArtifacts.filter(isVisibleConversationArtifact), [conversationArtifacts]);

  // The SAME open path chat artifact cards use: images go to the preview
  // panel (managed images resolve their bytes by artifact id first — they
  // carry no path by contract), everything else opens in the system viewer
  // via shell.openFile / openExternal.
  const openArtifact = async (artifact: IConversationArtifact): Promise<void> => {
    const type = railArtifactTypeOf(artifact);
    const payload = artifact.payload as Record<string, unknown>;
    const title = railArtifactTitle(artifact, type, t);
    const metadata = {
      title,
      file_name: fileNameOf(readPayloadString(payload, ARTIFACT_SOURCE_PATH_KEYS)) || title,
      conversation_id: artifact.conversation_id,
    };
    const urlSource = readPayloadString(payload, ARTIFACT_SOURCE_URL_KEYS);
    const path = readPayloadString(payload, ARTIFACT_SOURCE_PATH_KEYS);

    if (type === 'image') {
      let source = urlSource;
      if (!source && payload.managed_image === true) {
        try {
          const response = await ipcBridge.commandEve.imageArtifactPreview.invoke({
            conversationId: artifact.conversation_id,
            artifactId: artifact.id,
          });
          const previewData = response?.data;
          if (previewData) source = `data:${previewData.mime_type};base64,${previewData.data_base64}`;
        } catch {
          // Fall through to the path-based viewers below.
        }
      }
      if (!source && path) {
        try {
          const approved = await ipcBridge.application.readGeneratedArtifactPreview.invoke({ path, kind: 'image' });
          if (approved?.encoding === 'base64') source = `data:${approved.mimeType};base64,${approved.data}`;
        } catch {
          // Fall through to the system viewer below.
        }
      }
      if (source) {
        preview.openPreview(source, 'image', metadata);
        onRequestClose?.();
        return;
      }
    }

    if (path) {
      try {
        await ipcBridge.shell.openFile.invoke(path);
        onRequestClose?.();
      } catch (openError) {
        console.error('[ShellElementsRail] Failed to open artifact:', openError);
      }
      return;
    }
    if (urlSource && /^https?:/i.test(urlSource)) {
      try {
        await ipcBridge.shell.openExternal.invoke(urlSource);
        onRequestClose?.();
      } catch (openError) {
        console.error('[ShellElementsRail] Failed to open artifact:', openError);
      }
    }
  };

  useEffect(() => {
    const selectTab = (event: Event) => {
      const tab = (event as CustomEvent<ElementsRailTab>).detail;
      if (tab !== 'activity' && tab !== 'artifacts' && tab !== 'context') return;
      if (controlledActiveTab === undefined) setUncontrolledActiveTab(tab);
      onTabChange?.(tab);
    };
    window.addEventListener(ELEMENTS_RAIL_SELECT_EVENT, selectTab);
    return () => window.removeEventListener(ELEMENTS_RAIL_SELECT_EVENT, selectTab);
  }, [controlledActiveTab, onTabChange]);

  const selectTab = (tab: ElementsRailTab) => {
    if (controlledActiveTab === undefined) setUncontrolledActiveTab(tab);
    onTabChange?.(tab);
  };

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
            onClick={() => selectTab(tab.key)}
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
                {artifacts.map((artifact) => {
                  const type = railArtifactTypeOf(artifact);
                  const title = railArtifactTitle(artifact, type, t);
                  const payload = artifact.payload as Record<string, unknown>;
                  const openable =
                    type !== null &&
                    Boolean(
                      readPayloadString(payload, ARTIFACT_SOURCE_URL_KEYS) ||
                      readPayloadString(payload, ARTIFACT_SOURCE_PATH_KEYS) ||
                      payload.managed_image === true
                    );
                  return (
                    <Button
                      key={artifact.id}
                      type='text'
                      className={styles.artifactButton}
                      disabled={!openable}
                      onClick={() => {
                        void openArtifact(artifact);
                      }}
                      aria-label={t('conversation.elementsRail.openArtifact', { name: title })}
                    >
                      <span className={styles.artifactIcon}>
                        {artifactIcon(type, readPayloadString(payload, ['file_name']) || title)}
                      </span>
                      <span className={styles.artifactName}>{title}</span>
                      <Right size={13} aria-hidden='true' />
                    </Button>
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {activeTab === 'context' ? (
          <section className={`${styles.section} ${styles.contextSection}`}>
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
