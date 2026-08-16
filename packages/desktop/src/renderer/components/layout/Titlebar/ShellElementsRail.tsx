/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import { resolveComposerArtifactReference } from '@/common/config/composerArtifactReferenceCore';
import { eveTeamWorkerLabel } from '@/common/config/eveTeamRoster';
import { isHttpUrl, type TypedUIArtifactKind } from '@/common/typedUI';
import type { PreviewContentType } from '@/common/types/office/preview';
import { useConversationDelegationActivity } from '@/renderer/pages/conversation/runtime/conversationDelegationActivityStore';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import {
  isVisibleConversationArtifact,
  isUsableMediaEditSource,
  mediaArtifactTypeOf,
  useConversationArtifactsById,
} from '@/renderer/pages/conversation/Messages/artifacts';
import { emitter } from '@/renderer/utils/emitter';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { LARGE_TEXT_PREVIEW_MAX_LENGTH } from '@/renderer/pages/conversation/Preview/constants';
import { sanitizeArtifactPreviewSource } from '@/renderer/pages/conversation/Messages/components/artifactPreviewSecurityCore';
import { registerWorkbenchArtifactResolver } from '@/renderer/pages/conversation/Preview/services/workbenchArtifactResolver';
import { ELEMENTS_RAIL_SELECT_EVENT, type ElementsRailTab } from '@/renderer/utils/workspace/workspaceEvents';
import { Button, Message, Spin, Tooltip } from '@arco-design/web-react';
import {
  Caution,
  CheckOne,
  Code,
  EditOne,
  FileText,
  FileWord,
  FolderOpen,
  ImageFiles,
  Music,
  Right,
  Video,
} from '@renderer/components/icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DurableWorkActivity from './DurableWorkActivity';
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
  'fileUrl',
  'href',
  'src',
  'data_url',
  'download_url',
  'output_url',
  'preview_url',
  'thumbnail_url',
  'img_url',
  'image_url',
  'video_url',
  'audio_url',
];
const ARTIFACT_SOURCE_PATH_KEYS = ['path', 'file_path', 'filePath', 'absolute_path', 'absolutePath', 'relative_path'];
const ARTIFACT_INLINE_CONTENT_KEYS = ['html', 'content', 'text', 'markdown', 'diff'];
const LOCAL_MEDIA_PREVIEW_MAX_BYTES = 47 * 1024 * 1024;

const PREVIEW_TYPE_BY_EXTENSION: Record<string, PreviewContentType> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  diff: 'diff',
  patch: 'diff',
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  odt: 'word',
  ppt: 'ppt',
  pptx: 'ppt',
  odp: 'ppt',
  xls: 'excel',
  xlsx: 'excel',
  ods: 'excel',
  csv: 'excel',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  bmp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  aac: 'audio',
};

const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'css',
  'go',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
};

const readPayloadString = (payload: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const readPayloadContent = (payload: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

const fileNameOf = (value?: string): string | undefined => {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/').split('?')[0].split('#')[0];
  const lastSeparator = normalized.lastIndexOf('/');
  return normalized.slice(lastSeparator + 1) || undefined;
};

const fileExtensionOf = (value?: string): string | undefined => {
  const fileName = fileNameOf(value);
  const extension = fileName?.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  return extension || undefined;
};

const resolveArtifactPath = (value: string | undefined, workspacePath?: string): string | undefined => {
  if (!value) return undefined;
  let candidate = value;
  if (/^file:/i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'file:') return undefined;
      candidate = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  }
  if (candidate.startsWith('/') || /^[a-z]:[\\/]/i.test(candidate) || !workspacePath) return candidate;
  return `${workspacePath.replace(/[\\/]+$/, '')}/${candidate.replace(/^\.?[\\/]+/, '')}`;
};

const artifactWorkbenchTypeOf = (
  artifactType: RailArtifactType,
  payload: Record<string, unknown>,
  fileName?: string
): PreviewContentType | null => {
  if (artifactType === 'image' || artifactType === 'video' || artifactType === 'audio' || artifactType === 'html') {
    return artifactType;
  }

  const mimeType = readPayloadString(payload, ['mime_type', 'media_type', 'mimeType'])?.toLowerCase();
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.includes('html')) return 'html';
  if (mimeType?.includes('markdown')) return 'markdown';
  if (mimeType?.includes('wordprocessingml') || mimeType === 'application/msword') return 'word';
  if (mimeType?.includes('presentationml') || mimeType === 'application/vnd.ms-powerpoint') return 'ppt';
  if (mimeType?.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel') return 'excel';

  const extension = fileExtensionOf(fileName);
  if (extension && PREVIEW_TYPE_BY_EXTENSION[extension]) return PREVIEW_TYPE_BY_EXTENSION[extension];
  if (extension && CODE_EXTENSIONS.has(extension)) return 'code';
  if (mimeType?.startsWith('text/') || mimeType === 'application/json' || mimeType?.includes('javascript'))
    return 'code';
  if (readPayloadContent(payload, ARTIFACT_INLINE_CONTENT_KEYS)) return 'code';
  return null;
};

const mediaMimeFromPath = (path: string): string | undefined => {
  const extension = fileExtensionOf(path);
  return extension ? MIME_BY_EXTENSION[extension] : undefined;
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

const typedUIContentOf = (payload: Record<string, unknown>): string | undefined => {
  const candidate = payload.typed_ui ?? payload.typedUi;
  if (typeof candidate === 'string' && candidate.trim()) return candidate;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return JSON.stringify(candidate);
  return undefined;
};

export const resolverKindOf = (artifact: IConversationArtifact): TypedUIArtifactKind | null => {
  if (artifact.kind === 'cron_trigger' || artifact.kind === 'skill_suggest') return null;
  const payload = artifact.payload as Record<string, unknown>;
  if (typedUIContentOf(payload)) return 'chat';
  const source = readPayloadString(payload, ARTIFACT_SOURCE_URL_KEYS);
  const path = readPayloadString(payload, ARTIFACT_SOURCE_PATH_KEYS);
  const inline = readPayloadContent(payload, ARTIFACT_INLINE_CONTENT_KEYS);
  if (source && isHttpUrl(source) && !path && !inline) return 'browser';
  return 'file';
};

const isSafeWorkspaceRelativePath = (value: string | undefined, workspacePath?: string): boolean => {
  if (!value || !workspacePath || value.length > 1024 || value.includes('\0')) return false;
  if (/^(?:file:|\/|[a-z]:[\\/]|\\\\)/i.test(value)) return false;
  return !value
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment === '..');
};

export const canOpenArtifactFromTypedAction = (artifact: IConversationArtifact, workspacePath?: string): boolean => {
  if (artifact.kind === 'cron_trigger' || artifact.kind === 'skill_suggest') return false;
  const payload = artifact.payload as Record<string, unknown>;
  const kind = resolverKindOf(artifact);
  if (kind === 'chat') return Boolean(typedUIContentOf(payload));
  if (kind === 'browser') return isHttpUrl(readPayloadString(payload, ARTIFACT_SOURCE_URL_KEYS));
  if (kind !== 'file') return false;
  const declaredPath = readPayloadString(payload, ARTIFACT_SOURCE_PATH_KEYS);
  if (declaredPath && !isSafeWorkspaceRelativePath(declaredPath, workspacePath)) return false;
  if (readPayloadContent(payload, ARTIFACT_INLINE_CONTENT_KEYS)) return true;
  if (payload.managed_image === true) return true;
  return isSafeWorkspaceRelativePath(declaredPath, workspacePath);
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
  const delegatedTasks = useConversationDelegationActivity(conversationId || '');
  const preview = usePreviewContext();
  // MAT-1773 — the SAME shared store the chat tray renders from
  // (ConversationArtifactContext), not preview tabs: managed artifacts (img_h_
  // images, videos) never become preview tabs, which is exactly why this list
  // used to stay empty. Reactive by subscription — a managed-lane bind or a
  // staged report re-renders the list in place.
  const conversationArtifacts = useConversationArtifactsById(conversationId);
  const artifacts = useMemo(() => conversationArtifacts.filter(isVisibleConversationArtifact), [conversationArtifacts]);

  // Route every supported artifact into the same conversation-owned workbench.
  // Unknown local binaries still use the system viewer; a click must never be
  // swallowed merely because an artifact arrived as inline content or a data URL.
  const openArtifact = useCallback(
    async (artifact: IConversationArtifact, allowSystemFallback = true): Promise<void> => {
      const type = railArtifactTypeOf(artifact);
      const payload = artifact.payload as Record<string, unknown>;
      const resolverKind = resolverKindOf(artifact);
      const title = railArtifactTitle(artifact, type, t);
      const urlSource = readPayloadString(payload, ARTIFACT_SOURCE_URL_KEYS);
      const pathValue = readPayloadString(payload, ARTIFACT_SOURCE_PATH_KEYS);
      const path = resolveArtifactPath(pathValue, workspacePath);
      const sourceFileName = fileNameOf(pathValue) || fileNameOf(urlSource);
      const sourceExtension = fileExtensionOf(sourceFileName);
      const titledFileName = fileExtensionOf(title)
        ? title
        : sourceExtension
          ? `${title}.${sourceExtension}`
          : undefined;
      const fileName = readPayloadString(payload, ['file_name']) || titledFileName || sourceFileName || title;
      const contentType = artifactWorkbenchTypeOf(type, payload, fileName);
      const inlineContent = readPayloadContent(payload, ARTIFACT_INLINE_CONTENT_KEYS);
      const sourceMessageId = readPayloadString(payload, ['source_message_id', 'sourceMessageId']);
      const includeFileCoordinates =
        resolverKind === 'file' &&
        (allowSystemFallback || (!inlineContent && isSafeWorkspaceRelativePath(pathValue, workspacePath)));
      const metadata = {
        title,
        file_name: fileName,
        ...(includeFileCoordinates ? { file_path: path, workspace: workspacePath } : {}),
        conversation_id: artifact.conversation_id,
        artifact_id: artifact.id,
        ...(resolverKind ? { artifact_kind: resolverKind } : {}),
        artifact_created_at: artifact.created_at,
        ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
        editable: false,
      };

      const showPreview = (content: string, previewType: PreviewContentType): void => {
        preview.openPreview(content, previewType, metadata);
        onRequestClose?.();
      };

      const showMediaPreview = (candidate: string, mediaType: 'image' | 'video' | 'audio'): boolean => {
        const source = sanitizeArtifactPreviewSource(candidate, mediaType);
        if (!source) return false;
        showPreview(source, mediaType);
        return true;
      };

      const typedUIContent = typedUIContentOf(payload);
      if (typedUIContent) {
        showPreview(typedUIContent, 'typed-ui');
        return;
      }

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
            if (workspacePath) source = await ipcBridge.fs.getImageBase64.invoke({ path, workspace: workspacePath });
          } catch {
            // Generated outputs can live outside the active workspace.
          }
          if (!source) {
            try {
              const approved = await ipcBridge.application.readGeneratedArtifactPreview.invoke({ path, kind: 'image' });
              if (approved?.encoding === 'base64') source = `data:${approved.mimeType};base64,${approved.data}`;
            } catch {
              // Fall through to the system viewer below.
            }
          }
        }
        if (source && showMediaPreview(source, 'image')) return;
      }

      if (inlineContent && contentType && ['markdown', 'html', 'code', 'diff'].includes(contentType)) {
        showPreview(inlineContent.slice(0, LARGE_TEXT_PREVIEW_MAX_LENGTH), contentType);
        return;
      }

      if (urlSource && contentType) {
        if (contentType === 'image' || contentType === 'video' || contentType === 'audio') {
          if (showMediaPreview(urlSource, contentType)) return;
        } else if (
          contentType === 'pdf' &&
          (/^(?:https?|blob):/i.test(urlSource) || /^data:application\/pdf(?:;|,)/i.test(urlSource))
        ) {
          showPreview(urlSource, 'pdf');
          return;
        }
      }

      if (urlSource && isHttpUrl(urlSource)) {
        showPreview(urlSource, 'url');
        return;
      }

      if (path && contentType) {
        if (contentType === 'pdf' || contentType === 'word' || contentType === 'ppt' || contentType === 'excel') {
          showPreview('', contentType);
          return;
        }

        if (contentType === 'video' || contentType === 'audio') {
          let source: string | undefined;
          if (workspacePath) {
            try {
              const fileMetadata = await ipcBridge.fs.getFileMetadata.invoke({ path, workspace: workspacePath });
              if (
                fileMetadata &&
                !fileMetadata.isDirectory &&
                !fileMetadata.is_directory &&
                fileMetadata.size <= LOCAL_MEDIA_PREVIEW_MAX_BYTES
              ) {
                const encoded = await ipcBridge.fs.readFileBuffer.invoke({ path, workspace: workspacePath });
                const mimeType = mediaMimeFromPath(path);
                if (encoded && mimeType?.startsWith(`${contentType}/`)) {
                  source = `data:${mimeType};base64,${encoded}`;
                }
              }
            } catch {
              // Try the bounded generated-artifact bridge below.
            }
          }
          if (!source) {
            try {
              const approved = await ipcBridge.application.readGeneratedArtifactPreview.invoke({
                path,
                kind: contentType,
              });
              if (approved?.encoding === 'base64') source = `data:${approved.mimeType};base64,${approved.data}`;
            } catch {
              // Fall through to the system viewer below.
            }
          }
          if (source && showMediaPreview(source, contentType)) return;
        }

        if (contentType === 'html' || contentType === 'markdown' || contentType === 'code' || contentType === 'diff') {
          let content: string | undefined;
          if (workspacePath) {
            try {
              const value = await ipcBridge.fs.readFile.invoke({ path, workspace: workspacePath });
              if (typeof value === 'string') content = value;
            } catch {
              // Generated HTML can live outside the active workspace.
            }
          }
          if (!content && contentType === 'html') {
            try {
              const approved = await ipcBridge.application.readGeneratedArtifactPreview.invoke({ path, kind: 'html' });
              if (approved?.encoding === 'utf8') content = approved.data;
            } catch {
              // Fall through to the system viewer below.
            }
          }
          if (content) {
            showPreview(content.slice(0, LARGE_TEXT_PREVIEW_MAX_LENGTH), contentType);
            return;
          }
        }
      }

      if (path && allowSystemFallback) {
        try {
          await ipcBridge.shell.openFile.invoke(path);
          onRequestClose?.();
        } catch (openError) {
          console.error('[ShellElementsRail] Failed to open artifact:', openError);
        }
        return;
      }
      if (allowSystemFallback) Message.error(t('messages.artifact.previewUnavailable'));
      else throw new Error('artifact_not_resolved');
    },
    [onRequestClose, preview, t, workspacePath]
  );

  useEffect(() => {
    if (!conversationId) return;
    return registerWorkbenchArtifactResolver({
      id: `conversation-artifacts-${conversationId}`,
      priority: 60,
      canResolve(reference) {
        if (reference.conversationId !== conversationId) return false;
        const artifact = artifacts.find((candidate) => candidate.id === reference.artifactId);
        return Boolean(
          artifact &&
          resolverKindOf(artifact) === reference.kind &&
          canOpenArtifactFromTypedAction(artifact, workspacePath)
        );
      },
      async open(reference) {
        const artifact = artifacts.find(
          (candidate) => candidate.id === reference.artifactId && resolverKindOf(candidate) === reference.kind
        );
        if (
          !artifact ||
          reference.conversationId !== conversationId ||
          !canOpenArtifactFromTypedAction(artifact, workspacePath)
        ) {
          throw new Error('artifact_not_resolved');
        }
        await openArtifact(artifact, false);
      },
    });
  }, [artifacts, conversationId, openArtifact, workspacePath]);

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
  const panelId = 'elements-rail-panel';
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: ElementsRailTab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const currentIndex = tabItems.findIndex((tab) => tab.key === currentTab);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabItems.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabItems.length) % tabItems.length;
    const nextTab = tabItems[nextIndex];
    event.preventDefault();
    selectTab(nextTab.key);
    window.requestAnimationFrame(() => document.getElementById(`elements-rail-tab-${nextTab.key}`)?.focus());
  };

  return (
    <aside className={styles.rail} data-testid='shell-elements-rail'>
      <div className={styles.tabs} role='tablist' aria-label={t('conversation.elementsRail.toggle')}>
        {tabItems.map((tab) => (
          <Button
            key={tab.key}
            id={`elements-rail-tab-${tab.key}`}
            type='text'
            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
            role='tab'
            aria-selected={activeTab === tab.key}
            aria-controls={panelId}
            tabIndex={activeTab === tab.key ? 0 : -1}
            onClick={() => selectTab(tab.key)}
            onKeyDown={(event) => handleTabKeyDown(event, tab.key)}
            data-testid={`elements-rail-tab-${tab.key}`}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div id={panelId} className={styles.content} role='tabpanel' aria-labelledby={`elements-rail-tab-${activeTab}`}>
        {activeTab === 'activity' ? (
          <section className={styles.section}>
            <div className={`${styles.activityCard} ${styles[`activityCard_${activity.tone}`]}`}>
              <span className={styles.activityIcon}>{activity.icon}</span>
              <div className={styles.activityCopy}>
                <strong>{activity.title}</strong>
                <span>{activity.detail}</span>
              </div>
            </div>
            <DurableWorkActivity
              conversationId={conversationId || ''}
              legacyTasks={delegatedTasks}
              onOpen={(item) => {
                preview.openPreview(item.id, 'durable-work', {
                  title: item.goal,
                  conversation_id: conversationId,
                  workspace: workspacePath,
                });
                onRequestClose?.();
              }}
            />
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
                      readPayloadContent(payload, ARTIFACT_INLINE_CONTENT_KEYS) ||
                      payload.managed_image === true
                    );
                  const candidateReference = resolveComposerArtifactReference(artifact);
                  const composerReference =
                    candidateReference &&
                    ((candidateReference.mode !== 'image' && candidateReference.mode !== 'video') ||
                      isUsableMediaEditSource(artifact))
                      ? candidateReference
                      : null;
                  return (
                    <div key={artifact.id} className={styles.artifactRow}>
                      <Button
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
                      {composerReference ? (
                        <Tooltip
                          content={t('conversation.elementsRail.continueEditing', {
                            defaultValue: 'Im Chat bearbeiten',
                          })}
                          position='left'
                          mini
                        >
                          <Button
                            type='text'
                            className={styles.artifactReferenceButton}
                            aria-label={t('conversation.elementsRail.continueEditingArtifact', {
                              defaultValue: '{{name}} im Chat bearbeiten',
                              name: title,
                            })}
                            onClick={() => {
                              emitter.emit('commandEve.composer.reference.select', {
                                conversation_id: composerReference.conversationId,
                                artifact_id: composerReference.artifactId,
                              });
                            }}
                          >
                            <EditOne size={14} aria-hidden='true' />
                          </Button>
                        </Tooltip>
                      ) : null}
                    </div>
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
