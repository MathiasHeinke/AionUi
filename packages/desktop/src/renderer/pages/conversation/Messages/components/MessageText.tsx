/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageText } from '@/common/chat/chatLib';
import type { IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';
import { AIONUI_FILES_MARKER } from '@/common/config/constants';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import {
  isReadAloudAvailable,
  readAloudText,
  stopReadAloud,
  type ReadAloudCloudArtifact,
} from '@/renderer/services/ReadAloudService';
import { iconColors } from '@/renderer/styles/colors';
import { Alert, Button, Message, Tooltip } from '@arco-design/web-react';
import { Copy, PauseOne, VolumeNotice } from '@icon-park/react';
import classNames from 'classnames';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '@/renderer/utils/ui/clipboard';
import CollapsibleContent from '@renderer/components/chat/CollapsibleContent';
import FilePreview from '@renderer/components/media/FilePreview';
import HorizontalFileList from '@renderer/components/media/HorizontalFileList';
import MarkdownView from '@renderer/components/Markdown';
import { stripThinkTags, hasThinkTags } from '@renderer/utils/chat/thinkTagFilter';
import { stripSkillSuggest, hasSkillSuggest } from '@renderer/utils/chat/skillSuggestParser';
import { useUpsertConversationArtifact } from '@renderer/pages/conversation/Messages/artifacts';

/**
 * Format a timestamp for message display.
 * Today: "HH:mm", older: "MM-DD HH:mm".
 */
export const formatMessageTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const time = `${hours}:${minutes}`;

  if (
    date.getFullYear() !== now.getFullYear() ||
    date.getMonth() !== now.getMonth() ||
    date.getDate() !== now.getDate()
  ) {
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${month}-${day} ${time}`;
  }
  return time;
};
import MessageCronBadge from './MessageCronBadge';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';
import TeammateMessageAvatar from './TeammateMessageAvatar';

const CODE_STYLE = { marginTop: 4, marginBlock: 4 };

const parseFileMarker = (content: string) => {
  const markerIndex = content.indexOf(AIONUI_FILES_MARKER);
  if (markerIndex === -1) {
    return { text: content, files: [] as string[] };
  }
  const text = content.slice(0, markerIndex).trimEnd();
  const afterMarker = content.slice(markerIndex + AIONUI_FILES_MARKER.length).trim();
  const files = afterMarker
    ? afterMarker
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return { text, files };
};

const isAbsoluteMessageFilePath = (file_path: string): boolean =>
  file_path.startsWith('/') || /^[A-Za-z]:/.test(file_path);

export const resolveMessageFilePath = (file_path: string, workspace?: string): string => {
  if (!file_path || isAbsoluteMessageFilePath(file_path) || !workspace) {
    return file_path;
  }

  const normalizedWorkspace = workspace.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const normalizedFilePath = file_path.replace(/^\.?[\\/]+/, '').replace(/\\/g, '/');
  return `${normalizedWorkspace}/${normalizedFilePath}`.replace(/\/+/g, '/');
};

const useFormatContent = (content: string) => {
  return useMemo(() => {
    try {
      const json = JSON.parse(content);
      const isJson = typeof json === 'object';
      return {
        json: isJson,
        data: isJson ? json : content,
      };
    } catch {
      return { data: content };
    }
  }, [content]);
};

const MessageText: React.FC<{ message: IMessageText }> = ({ message }) => {
  // Filter think tags from content before rendering
  // 在渲染前过滤 think 标签
  const contentToRender = useMemo(() => {
    let content = message.content.content;
    if (typeof content === 'string') {
      if (hasThinkTags(content)) {
        content = stripThinkTags(content);
      }
      // Strip any inline [SKILL_SUGGEST] blocks (now handled via separate skill_suggest message type)
      if (hasSkillSuggest(content)) {
        content = stripSkillSuggest(content);
      }
      return content;
    }
    return content;
  }, [message.content.content]);

  const { text, files } = parseFileMarker(contentToRender);
  const { data, json } = useFormatContent(text);
  const { i18n, t } = useTranslation();
  const [showCopyAlert, setShowCopyAlert] = useState(false);
  const [isReadingAloud, setIsReadingAloud] = useState(false);
  const isReadingAloudRef = useRef(false);
  const isUserMessage = message.position === 'right';
  const isTeammateMessage = message.position === 'left' && message.content.teammateMessage === true;
  const shouldRenderPlainText = isUserMessage;
  const conversationContext = useConversationContextSafe();
  const upsertConversationArtifact = useUpsertConversationArtifact();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const resolvedFiles = useMemo(
    () => files.map((file_path) => resolveMessageFilePath(file_path, conversationContext?.workspace)),
    [conversationContext?.workspace, files]
  );
  useEffect(() => {
    isReadingAloudRef.current = isReadingAloud;
  }, [isReadingAloud]);
  useEffect(() => {
    return () => {
      if (isReadingAloudRef.current) {
        stopReadAloud();
      }
    };
  }, []);

  // 过滤空内容，避免渲染空DOM
  if (!message.content.content || (typeof message.content.content === 'string' && !message.content.content.trim())) {
    return null;
  }

  const handleCopy = () => {
    const baseText = shouldRenderPlainText ? text : json ? JSON.stringify(data, null, 2) : text;
    const fileList = files.length ? `Files:\n${files.map((path) => `- ${path}`).join('\n')}\n\n` : '';
    const textToCopy = fileList + baseText;
    copyText(textToCopy)
      .then(() => {
        setShowCopyAlert(true);
        setTimeout(() => setShowCopyAlert(false), 2000);
      })
      .catch(() => {
        Message.error(t('common.copyFailed'));
      });
  };

  const readAloudTextValue = shouldRenderPlainText ? text : json ? JSON.stringify(data, null, 2) : text;
  const canReadAloud = !isUserMessage && readAloudTextValue.trim().length > 0 && isReadAloudAvailable();
  const createReadAloudArtifact = (cloudArtifact: ReadAloudCloudArtifact): IGeneratedConversationArtifact | null => {
    if (!conversationContext?.conversation_id) {
      return null;
    }
    const createdAt = cloudArtifact.createdAt;
    return {
      id: `read-aloud-artifact-${message.id}`,
      conversation_id: conversationContext.conversation_id,
      kind: 'audio',
      status: 'active',
      payload: {
        artifact_type: 'audio',
        title: t('messages.artifact.generated', { type: t('messages.artifact.audio') }),
        // Ephemeral React-context preview only. Persisted artifacts must switch to hosted URLs.
        src: cloudArtifact.sourceUrl,
        mime_type: cloudArtifact.artifact.mime_type,
        size: cloudArtifact.artifact.bytes,
        provider: cloudArtifact.provider,
        model: cloudArtifact.tts?.voice_id,
      },
      created_at: createdAt,
      updated_at: createdAt,
    };
  };

  const handleReadAloud = () => {
    if (isReadingAloud) {
      stopReadAloud();
      setIsReadingAloud(false);
      return;
    }
    setIsReadingAloud(true);
    void readAloudText(readAloudTextValue, {
      lang: i18n.language,
      onCloudArtifact: (cloudArtifact) => {
        const artifact = createReadAloudArtifact(cloudArtifact);
        if (artifact) {
          upsertConversationArtifact(artifact);
        }
      },
      onEnd: () => setIsReadingAloud(false),
      onError: () => {
        setIsReadingAloud(false);
        Message.error(t('conversation.chat.readAloudFailed'));
      },
      onStart: () => setIsReadingAloud(true),
    })
      .then((didStart) => {
        if (!didStart) {
          setIsReadingAloud(false);
          Message.error(t('conversation.chat.readAloudUnavailable'));
        }
      })
      .catch(() => {
        setIsReadingAloud(false);
        Message.error(t('conversation.chat.readAloudFailed'));
      });
  };

  const copyButton = (
    <Tooltip content={t('common.copy', { defaultValue: 'Copy' })}>
      <button
        type='button'
        className='p-4px border-none bg-transparent rd-4px cursor-pointer hover:bg-3 transition-colors opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus:opacity-100 focus:pointer-events-auto'
        onClick={handleCopy}
        aria-label={t('common.copy', { defaultValue: 'Copy' })}
        style={{ lineHeight: 0 }}
      >
        <Copy theme='outline' size='16' fill={iconColors.secondary} />
      </button>
    </Tooltip>
  );
  const readAloudButton = canReadAloud ? (
    <Tooltip
      content={isReadingAloud ? t('conversation.chat.stopReadAloudTooltip') : t('conversation.chat.readAloudTooltip')}
    >
      <Button
        type='text'
        size='mini'
        shape='circle'
        className='opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto'
        onClick={handleReadAloud}
        aria-label={
          isReadingAloud ? t('conversation.chat.stopReadAloudTooltip') : t('conversation.chat.readAloudTooltip')
        }
        icon={
          isReadingAloud ? (
            <PauseOne theme='outline' size='16' fill={iconColors.secondary} />
          ) : (
            <VolumeNotice theme='outline' size='16' fill={iconColors.secondary} />
          )
        }
      />
    </Tooltip>
  ) : null;

  const cronMeta = message.content.cronMeta;
  const senderName = message.content.senderName;
  const senderAgentType = message.content.senderAgentType;
  const senderConversationId = message.content.senderConversationId;
  const fallbackBackendLogo = senderAgentType ? getAgentLogo(senderAgentType) : null;

  return (
    <>
      <div className={classNames('min-w-0 flex flex-col group', isUserMessage ? 'items-end' : 'items-start')}>
        {cronMeta && <MessageCronBadge meta={cronMeta} />}
        {isTeammateMessage && senderName && (
          <div className='flex items-center gap-6px mb-4px'>
            <TeammateMessageAvatar
              senderName={senderName}
              senderConversationId={senderConversationId}
              backendLogo={fallbackBackendLogo}
            />
            <span className='text-12px text-t-secondary'>{senderName}</span>
          </div>
        )}
        {files.length > 0 && (
          <div className={classNames('mt-6px', { 'self-end': isUserMessage })}>
            {resolvedFiles.length === 1 ? (
              <div className='flex items-center'>
                <FilePreview path={resolvedFiles[0]} onRemove={() => undefined} readonly />
              </div>
            ) : (
              <HorizontalFileList>
                {resolvedFiles.map((path) => (
                  <FilePreview key={path} path={path} onRemove={() => undefined} readonly />
                ))}
              </HorizontalFileList>
            )}
          </div>
        )}
        <div
          className={classNames('min-w-0 [&>p:first-child]:mt-0px [&>p:last-child]:mb-0px md:max-w-780px', {
            'p-6px md:p-8px': isUserMessage || cronMeta,
            'eve-message-surface p-6px md:p-8px': isTeammateMessage,
            'w-full': !(isUserMessage || cronMeta || isTeammateMessage),
          })}
          style={{
            ...(isUserMessage || cronMeta
              ? {
                  borderRadius: '8px 0 8px 8px',
                  color: 'var(--text-primary)',
                  background: 'var(--eve-message-user-bg)',
                }
              : isTeammateMessage
                ? { borderRadius: '0 8px 8px 8px' }
                : undefined),
          }}
        >
          {/* JSON 内容使用折叠组件 Use CollapsibleContent for JSON content */}
          {shouldRenderPlainText ? (
            <div className='whitespace-pre-wrap break-words' data-testid='message-text-content'>
              {text}
            </div>
          ) : json ? (
            <CollapsibleContent maxHeight={200} defaultCollapsed={true}>
              <div data-testid='message-text-content'>
                <MarkdownView
                  codeStyle={CODE_STYLE}
                >{`\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``}</MarkdownView>
              </div>
            </CollapsibleContent>
          ) : (
            <div data-testid='message-text-content'>
              <MarkdownView codeStyle={CODE_STYLE}>{data}</MarkdownView>
            </div>
          )}
        </div>
        {/* Hover-revealed copy + timestamp row. Mobile has no hover affordance,
            so we drop the row entirely — system-level long-press still copies. */}
        {!isMobile && (
          <div
            className={classNames('h-32px flex items-center mt-4px gap-8px', {
              'flex-row-reverse': isUserMessage,
            })}
          >
            {copyButton}
            {readAloudButton}
            {message.created_at && (
              <span className='text-12px text-t-secondary opacity-0 group-hover:opacity-100 transition-opacity select-none'>
                {formatMessageTime(message.created_at)}
              </span>
            )}
          </div>
        )}
      </div>
      {showCopyAlert && (
        <Alert
          type='success'
          content={t('messages.copySuccess')}
          showIcon
          className='fixed top-20px left-50% transform -translate-x-50% z-9999 w-max max-w-[80%]'
          style={{ boxShadow: '0px 2px 12px rgba(0,0,0,0.12)' }}
          closable={false}
        />
      )}
    </>
  );
};

export default MessageText;
