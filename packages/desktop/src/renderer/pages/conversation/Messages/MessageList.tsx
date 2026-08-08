/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationArtifact, IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';
import type { ProjectWorkspaceConversationArtifactDTO } from '@renderer/pages/projects/types';
import { useProjectWorkspaceConversationArtifacts } from '@renderer/pages/projects/client';
import type { IMessageAcpToolCall, IMessageToolCall, IMessageToolGroup, TMessage } from '@/common/chat/chatLib';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { iconColors } from '@/renderer/styles/colors';
import { CHAT_MESSAGE_JUMP_EVENT, type ChatMessageJumpDetail } from '@/renderer/utils/chat/chatMinimapEvents';
import { Image } from '@arco-design/web-react';
import { Down } from '@icon-park/react';
import MessageAcpPermission from '@renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import MessagePermission from './components/MessagePermission';
import MessageAcpToolCall from '@renderer/pages/conversation/Messages/acp/MessageAcpToolCall';
import classNames from 'classnames';
import React, { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { uuid } from '@renderer/utils/common';
import './messages.css';
import HOC from '@renderer/utils/ui/HOC';
import type { FileChangeInfo } from './MessageFileChanges';
import MessageFileChanges, { parseDiff } from './MessageFileChanges';
import { useConversationArtifacts, isVisibleConversationArtifact } from './artifacts';
import {
  emptyMessageHistoryPagination,
  shouldLoadOlderConversationMessages,
  useMessageList,
  useMessageListLoading,
  type MessageHistoryPagination,
} from './hooks';
import MessageAgentStatus from './components/MessageAgentStatus';
import MessagePlan from './components/MessagePlan';
import MessageTips from './components/MessageTips';
import MessageToolCall from './components/MessageToolCall';
import MessageToolGroup from './components/MessageToolGroup';
import MessageToolGroupSummary from './components/MessageToolGroupSummary';
import MessageCronTrigger from './components/MessageCronTrigger';
import MessageGeneratedArtifact from './components/MessageGeneratedArtifact';
import MessageSkillSuggest from './components/MessageSkillSuggest';
import ProjectWorkspaceCard from './components/ProjectWorkspaceCard';
import MessageText from './components/MessageText';
import MessageThinking from './components/MessageThinking';
import { buildGeneratedArtifactFromHermesMediaDirective, parseHermesMediaDirectives } from './hermesMediaDirectiveCore';
import {
  getGeneratedArtifactPayloadSourceKeys,
  getToolResultArtifactSourceKeys,
  hasToolResultGeneratedArtifact,
  type WriteFileResult,
} from './types';
import { useAutoScroll } from './useAutoScroll';
import { useAutoPreviewOfficeFiles } from '@/renderer/hooks/file/useAutoPreviewOfficeFiles';
import SelectionReplyButton from './components/SelectionReplyButton';

type IMessageVO =
  | TMessage
  | { type: 'file_summary'; id: string; diffs: FileChangeInfo[]; sourceMessageIds: string[]; created_at: number }
  | {
      type: 'tool_summary';
      id: string;
      messages: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall>;
      sourceMessageIds: string[];
      created_at: number;
    };
type ConversationArtifactView = IConversationArtifact | ProjectWorkspaceConversationArtifactDTO;
type IArtifactVO = { type: 'artifact'; id: string; artifact: ConversationArtifactView; created_at: number };
type IProcessedItem = IMessageVO | IArtifactVO;

type ConversationLocationState = {
  targetMessageId?: string;
  fromConversationSearch?: boolean;
};

const getProcessedItemSourceMessageIds = (item: IProcessedItem): string[] => {
  if ('type' in item && item.type === 'artifact') {
    return [item.id];
  }
  if ('type' in item && item.type === 'tool_summary') {
    return item.sourceMessageIds;
  }
  if ('type' in item && item.type === 'file_summary') {
    return item.sourceMessageIds;
  }
  return 'id' in item ? [item.id] : [];
};

const matchesTargetMessage = (item: IProcessedItem, targetMessageId?: string): boolean => {
  if (!targetMessageId) {
    return false;
  }
  return getProcessedItemSourceMessageIds(item).includes(targetMessageId);
};

const getProcessedItemAnchorId = (item: IProcessedItem): string => {
  const sourceIds = getProcessedItemSourceMessageIds(item);
  return sourceIds[0] || ('id' in item ? item.id : uuid());
};

const getProcessedItemCreatedAt = (item: IProcessedItem): number => {
  // Both branches read the same optional field; only the second one said so. The
  // first returned it raw into a `number` return type, so a summary or artifact
  // without a timestamp would have sorted as `undefined`. Same fallback, both ways.
  if ('type' in item && ['file_summary', 'tool_summary', 'artifact'].includes(item.type)) {
    return item.created_at ?? 0;
  }
  return item.created_at ?? 0;
};

const highlightStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-aou-1)',
  boxShadow: '0 0 0 1px var(--color-aou-6-brand) inset',
  borderRadius: '12px',
};

const getUnhandledMessageType = (_message: never): string => 'unknown';

// The predicate moved to ./artifacts as the shared visibility contract
// (1.820.3) — MessageList and the AcpSendBox media gate now judge
// "visible" identically. Its definition is unchanged.

const getGeneratedArtifactSourceKeys = (artifact: IConversationArtifact): string[] => {
  if (artifact.kind === 'cron_trigger' || artifact.kind === 'skill_suggest') return [];
  return getGeneratedArtifactPayloadSourceKeys(artifact.payload);
};

const getInlineToolGroupArtifactSourceKeys = (message: IMessageToolGroup): string[] =>
  message.content.flatMap((item) => getToolResultArtifactSourceKeys(item.result_display));

const hasInlineToolGroupArtifact = (message: IMessageToolGroup): boolean =>
  message.content.some((item) => hasToolResultGeneratedArtifact(item.result_display));

const hasConversationArtifactDuplicate = (
  message: IMessageToolGroup,
  generatedArtifactSourceKeys: ReadonlySet<string>
): boolean => getInlineToolGroupArtifactSourceKeys(message).some((key) => generatedArtifactSourceKeys.has(key));

// Image preview context
export const ImagePreviewContext = createContext<{ inPreviewGroup: boolean }>({ inPreviewGroup: false });

const MessageListSkeleton: React.FC = () => {
  const rows = [
    { align: 'left', bubbleWidth: '100%', lines: [72, 58, 64] },
    { align: 'right', bubbleWidth: '82%', lines: [54, 48] },
    { align: 'left', bubbleWidth: '100%', lines: [68, 76, 44] },
    { align: 'left', bubbleWidth: '100%', lines: [46, 52] },
    { align: 'right', bubbleWidth: '78%', lines: [60, 42, 36] },
    { align: 'left', bubbleWidth: '100%', lines: [74, 62] },
    { align: 'right', bubbleWidth: '84%', lines: [52, 66] },
    { align: 'left', bubbleWidth: '100%', lines: [64, 56, 40] },
    { align: 'right', bubbleWidth: '80%', lines: [58, 46] },
  ] as const;

  return (
    <div
      className='flex-1 h-full overflow-y-auto pb-10px box-border'
      data-testid='message-list-skeleton'
      style={{ minHeight: '100%' }}
    >
      <div className='min-h-full flex flex-col justify-between py-10px box-border'>
        {rows.map((row, index) => (
          <div
            key={index}
            className={classNames(
              'w-full min-w-0 flex items-start message-item px-8px m-t-10px max-w-full md:max-w-780px mx-auto',
              {
                'justify-start': row.align === 'left',
                'justify-end': row.align === 'right',
              }
            )}
          >
            <div
              className='flex-none min-w-0 rd-16px p-14px'
              style={{
                width: row.bubbleWidth,
                maxWidth: '100%',
                background: 'var(--color-fill-1)',
                border: '1px solid var(--color-border-2)',
              }}
            >
              <div className='flex flex-col gap-10px'>
                {row.lines.map((width, lineIndex) => (
                  <div
                    key={lineIndex}
                    className='h-12px rd-999px'
                    style={{
                      width: `${width}%`,
                      background:
                        'linear-gradient(90deg, var(--color-fill-2) 0%, var(--color-fill-3) 50%, var(--color-fill-2) 100%)',
                      backgroundSize: '200% 100%',
                      animation: 'message-list-skeleton-shimmer 1.4s ease-in-out infinite',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <style>{`
        @keyframes message-list-skeleton-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
};

const MessageItem: React.FC<{ message: TMessage; highlighted?: boolean; commandEvePermissionPolicy?: boolean }> =
  React.memo(
    HOC((props) => {
      const { message, highlighted } = props as {
        message: TMessage;
        highlighted?: boolean;
        commandEvePermissionPolicy?: boolean;
      };
      return (
        <div
          id={`message-${message.id}`}
          data-testid={`message-${message.type}-${message.position}`}
          data-message-type={message.type}
          data-message-position={message.position}
          className={classNames(
            'min-w-0 flex items-start message-item [&>div]:max-w-full px-8px m-t-10px max-w-full md:max-w-780px mx-auto',
            message.type,
            {
              'justify-center': message.position === 'center',
              'justify-end': message.position === 'right',
              'justify-start': message.position === 'left',
            }
          )}
          style={highlighted ? highlightStyle : undefined}
        >
          {props.children}
        </div>
      );
    })(({ message, commandEvePermissionPolicy }) => {
      const { t } = useTranslation();
      switch (message.type) {
        case 'text':
          return <MessageText message={message}></MessageText>;
        case 'tips':
          return <MessageTips message={message}></MessageTips>;
        case 'tool_call':
          return <MessageToolCall message={message}></MessageToolCall>;
        case 'tool_group':
          return <MessageToolGroup message={message}></MessageToolGroup>;
        case 'agent_status':
          return <MessageAgentStatus message={message}></MessageAgentStatus>;
        case 'permission':
          return <MessagePermission message={message} isCommandEve={commandEvePermissionPolicy}></MessagePermission>;
        case 'acp_permission':
          return (
            <MessageAcpPermission message={message} isCommandEve={commandEvePermissionPolicy}></MessageAcpPermission>
          );
        case 'acp_tool_call':
          return <MessageAcpToolCall message={message}></MessageAcpToolCall>;
        case 'plan':
          return <MessagePlan message={message}></MessagePlan>;
        case 'thinking':
          return <MessageThinking message={message}></MessageThinking>;
        case 'available_commands':
          return null;
        default:
          return <div>{t('messages.unknownMessageType', { type: getUnhandledMessageType(message) })}</div>;
      }
    }),
    (prev, next) =>
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.position === next.message.position &&
      prev.message.type === next.message.type &&
      prev.commandEvePermissionPolicy === next.commandEvePermissionPolicy &&
      prev.highlighted === next.highlighted
  );

const MessageList: React.FC<{
  className?: string;
  emptySlot?: React.ReactNode;
  tailSlot?: React.ReactNode;
  suppressEmptySlot?: boolean;
  historyPagination?: MessageHistoryPagination;
  /** Apply Command EVE's fail-closed permission-card containment. */
  commandEvePermissionPolicy?: boolean;
}> = ({
  className,
  emptySlot,
  tailSlot,
  suppressEmptySlot = false,
  historyPagination = emptyMessageHistoryPagination,
  commandEvePermissionPolicy = false,
}) => {
  const list = useMessageList();
  const isMessageListLoading = useMessageListLoading();
  const artifacts = useConversationArtifacts();
  const conversationContext = useConversationContextSafe();
  const projectWorkspaceArtifacts = useProjectWorkspaceConversationArtifacts(conversationContext?.conversation_id);
  useAutoPreviewOfficeFiles(conversationContext);
  const { t } = useTranslation();
  const location = useLocation();
  const locationState = (location.state || {}) as ConversationLocationState;
  const targetMessageId = locationState.targetMessageId;
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | undefined>();
  const handledTargetKeyRef = useRef<string>('');
  const scrollerElementRef = useRef<HTMLDivElement | null>(null);
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  const pendingOlderScrollRef = useRef<{
    scroller: HTMLDivElement;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const olderLoadInFlightRef = useRef(false);

  // Pre-process message list to group tool outputs into summary cards
  const processedList = useMemo(() => {
    const result: IProcessedItem[] = [];
    const visibleArtifacts = artifacts.filter(isVisibleConversationArtifact);
    const generatedArtifactSourceKeys = new Set(
      visibleArtifacts.flatMap(getGeneratedArtifactSourceKeys).filter((key): key is string => Boolean(key))
    );
    let diffsChanges: FileChangeInfo[] = [];
    let diffsSourceMessageIds: string[] = [];
    let toolList: Array<IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall> = [];
    let toolSourceMessageIds: string[] = [];

    const pushFileDffChanges = (changes: FileChangeInfo, sourceMessageId: string, created_at: number) => {
      if (!diffsChanges.length) {
        diffsSourceMessageIds = [];
        result.push({
          type: 'file_summary',
          id: `summary-${sourceMessageId}`,
          diffs: diffsChanges,
          sourceMessageIds: diffsSourceMessageIds,
          created_at,
        });
      }
      diffsChanges.push(changes);
      diffsSourceMessageIds.push(sourceMessageId);
      toolList = [];
      toolSourceMessageIds = [];
    };
    const pushToolList = (message: IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall) => {
      if (!toolList.length) {
        toolSourceMessageIds = [];
        result.push({
          type: 'tool_summary',
          id: `tool-summary-${message.id}`,
          messages: toolList,
          sourceMessageIds: toolSourceMessageIds,
          created_at: message.created_at ?? 0,
        });
      }
      toolList.push(message);
      toolSourceMessageIds.push(message.id);
      diffsChanges = [];
      diffsSourceMessageIds = [];
    };

    for (let i = 0, len = list.length; i < len; i++) {
      const message = list[i];
      // Skip hidden and available_commands messages
      if (message.hidden) continue;
      if (message.type === 'available_commands') continue;
      if (message.type === 'tool_group') {
        if (
          hasInlineToolGroupArtifact(message) &&
          !hasConversationArtifactDuplicate(message, generatedArtifactSourceKeys)
        ) {
          toolList = [];
          toolSourceMessageIds = [];
          diffsChanges = [];
          diffsSourceMessageIds = [];
          result.push(message);
          continue;
        }
        if (message.content.length === 1) {
          const writeFileResults = message.content
            .filter(
              (item) =>
                item.name === 'WriteFile' &&
                item.result_display &&
                typeof item.result_display === 'object' &&
                'file_diff' in item.result_display
            )
            .map((item) => item.result_display as WriteFileResult);
          if (writeFileResults.length && writeFileResults[0].file_diff) {
            pushFileDffChanges(
              parseDiff(writeFileResults[0].file_diff, writeFileResults[0].file_name),
              message.id,
              message.created_at ?? 0
            );
            continue;
          }
        }
        pushToolList(message);
        continue;
      }
      if (message.type === 'acp_tool_call') {
        pushToolList(message);
        continue;
      }
      if (message.type === 'tool_call') {
        pushToolList(message);
        continue;
      }
      toolList = [];
      toolSourceMessageIds = [];
      diffsChanges = [];
      diffsSourceMessageIds = [];
      if (message.type === 'text' && message.position === 'left') {
        const parsedMedia = parseHermesMediaDirectives(message.content.content);
        if (parsedMedia.directives.length) {
          result.push({
            ...message,
            content: {
              ...message.content,
              content: parsedMedia.text,
            },
          });
          parsedMedia.directives.forEach((directive, index) => {
            if (generatedArtifactSourceKeys.has(directive.source)) return;
            generatedArtifactSourceKeys.add(directive.source);
            const artifact = buildGeneratedArtifactFromHermesMediaDirective({
              conversation_id: message.conversation_id,
              message_id: message.id,
              index,
              created_at: message.created_at,
              directive,
            });
            result.push({
              type: 'artifact',
              id: artifact.id,
              artifact,
              created_at: artifact.created_at,
            });
          });
          continue;
        }
      }
      result.push(message);
    }
    const visibleArtifactItems = visibleArtifacts.map<IArtifactVO>((artifact) => ({
      type: 'artifact',
      id: artifact.id,
      artifact,
      created_at: artifact.created_at,
    }));
    const projectWorkspaceArtifactItems = projectWorkspaceArtifacts.map<IArtifactVO>((artifact) => ({
      type: 'artifact',
      id: artifact.id,
      artifact,
      created_at: artifact.created_at,
    }));

    return [...result, ...visibleArtifactItems, ...projectWorkspaceArtifactItems].toSorted(
      (a, b) => getProcessedItemCreatedAt(a) - getProcessedItemCreatedAt(b)
    );
  }, [artifacts, list, projectWorkspaceArtifacts]);

  // Use auto-scroll hook
  const {
    handleScrollerRef: handleAutoScrollerRef,
    handleContentRef: handleAutoContentRef,
    handleScroll,
    handleWheel,
    handlePointerDown,
    showScrollButton,
    scrollToBottom,
    scrollElementIntoView,
    hideScrollButton,
  } = useAutoScroll({
    messages: list,
    itemCount: processedList.length,
  });

  const handleScrollerRef = useCallback(
    (ref: HTMLDivElement | null) => {
      scrollerElementRef.current = ref;
      handleAutoScrollerRef(ref);
    },
    [handleAutoScrollerRef]
  );

  const handleContentRef = useCallback(
    (ref: HTMLDivElement | null) => {
      contentElementRef.current = ref;
      handleAutoContentRef(ref);
    },
    [handleAutoContentRef]
  );

  useEffect(() => {
    if (!targetMessageId || processedList.length === 0) {
      return;
    }

    const targetKey = `${location.key}:${targetMessageId}`;
    if (handledTargetKeyRef.current === targetKey) {
      return;
    }

    const targetIndex = processedList.findIndex((item) => matchesTargetMessage(item, targetMessageId));
    if (targetIndex === -1) {
      return;
    }

    handledTargetKeyRef.current = targetKey;
    setHighlightedMessageId(targetMessageId);
    hideScrollButton();

    requestAnimationFrame(() => {
      const targetElement = document.getElementById(`message-${getProcessedItemAnchorId(processedList[targetIndex])}`);
      scrollElementIntoView(targetElement, {
        behavior: 'smooth',
        block: 'center',
      });
    });

    const timer = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === targetMessageId ? undefined : current));
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [hideScrollButton, location.key, processedList, scrollElementIntoView, targetMessageId]);

  useEffect(() => {
    const handleMessageJump = (event: Event) => {
      const detail = (event as CustomEvent<ChatMessageJumpDetail>).detail;
      if (!detail || !detail.conversation_id) return;
      if (!conversationContext?.conversation_id || detail.conversation_id !== conversationContext.conversation_id)
        return;

      const targetIndex = processedList.findIndex((item) => {
        if (
          (item as { type?: string }).type === 'file_summary' ||
          (item as { type?: string }).type === 'tool_summary' ||
          (item as { type?: string }).type === 'artifact'
        ) {
          return false;
        }
        const message = item as TMessage;
        if (detail.messageId && message.id === detail.messageId) return true;
        if (detail.msgId && message.msg_id === detail.msgId) return true;
        return false;
      });
      if (targetIndex < 0) return;

      hideScrollButton();
      requestAnimationFrame(() => {
        const targetElement = document.getElementById(
          `message-${getProcessedItemAnchorId(processedList[targetIndex])}`
        );
        scrollElementIntoView(targetElement, {
          block: detail.align || 'start',
          behavior: detail.behavior || 'smooth',
        });
      });
    };

    window.addEventListener(CHAT_MESSAGE_JUMP_EVENT, handleMessageJump);
    return () => {
      window.removeEventListener(CHAT_MESSAGE_JUMP_EVENT, handleMessageJump);
    };
  }, [conversationContext?.conversation_id, hideScrollButton, processedList, scrollElementIntoView]);

  // Click scroll button
  const handleScrollButtonClick = () => {
    hideScrollButton();
    scrollToBottom('smooth');
  };

  const restoreOlderScrollPosition = useCallback(() => {
    const pending = pendingOlderScrollRef.current;
    if (!pending) return false;

    pendingOlderScrollRef.current = null;
    olderLoadInFlightRef.current = false;
    const heightDelta = pending.scroller.scrollHeight - pending.scrollHeight;
    if (heightDelta > 0) {
      pending.scroller.scrollTop = pending.scrollTop + heightDelta;
      return true;
    }
    return false;
  }, []);

  const startOlderHistoryLoad = useCallback(
    (scroller: HTMLDivElement) => {
      if (olderLoadInFlightRef.current) return false;
      if (
        !shouldLoadOlderConversationMessages({
          scrollTop: scroller.scrollTop,
          hasOlderMessages: historyPagination.hasOlderMessages,
          isLoadingOlderMessages: historyPagination.isLoadingOlderMessages,
          visibleMessageCount: list.length,
        })
      ) {
        return false;
      }

      olderLoadInFlightRef.current = true;
      pendingOlderScrollRef.current = {
        scroller,
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
      };
      void historyPagination.loadOlderMessages().finally(() => {
        requestAnimationFrame(() => {
          if (!restoreOlderScrollPosition()) {
            olderLoadInFlightRef.current = false;
          }
        });
      });
      return true;
    },
    [historyPagination, list.length, restoreOlderScrollPosition]
  );

  useLayoutEffect(() => {
    restoreOlderScrollPosition();
  }, [list.length, restoreOlderScrollPosition]);

  useEffect(() => {
    const scroller = scrollerElementRef.current;
    const content = contentElementRef.current;
    if (!scroller || !content || scroller.clientHeight <= 0 || scroller.scrollHeight > scroller.clientHeight + 24)
      return;
    startOlderHistoryLoad(scroller);
  }, [
    historyPagination.hasOlderMessages,
    historyPagination.isLoadingOlderMessages,
    list.length,
    processedList.length,
    startOlderHistoryLoad,
  ]);

  const handleMessageListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      handleScroll(event);
      startOlderHistoryLoad(event.currentTarget);
    },
    [handleScroll, startOlderHistoryLoad]
  );

  const renderItem = (_index: number, item: (typeof processedList)[0]) => {
    const highlighted = matchesTargetMessage(item, highlightedMessageId);
    if ('type' in item && item.type === 'artifact') {
      return (
        <div
          key={item.id}
          id={`message-${getProcessedItemAnchorId(item)}`}
          data-conversation-artifact-kind={item.artifact.kind}
          data-testid={`conversation-artifact-${item.artifact.kind}`}
          className='min-w-0 message-item px-8px m-t-10px max-w-full md:max-w-780px mx-auto'
          style={highlighted ? highlightStyle : undefined}
        >
          {item.artifact.kind === 'project_workspace' ? (
            <ProjectWorkspaceCard payload={item.artifact.payload} />
          ) : item.artifact.kind === 'cron_trigger' ? (
            <MessageCronTrigger artifact={item.artifact} />
          ) : item.artifact.kind === 'skill_suggest' ? (
            <MessageSkillSuggest artifact={item.artifact} />
          ) : (
            <MessageGeneratedArtifact artifact={item.artifact as IGeneratedConversationArtifact} />
          )}
        </div>
      );
    }
    if ('type' in item && ['file_summary', 'tool_summary'].includes(item.type)) {
      return (
        <div
          key={item.id}
          id={`message-${getProcessedItemAnchorId(item)}`}
          className={'min-w-0 message-item px-8px m-t-10px max-w-full md:max-w-780px mx-auto ' + item.type}
          style={highlighted ? highlightStyle : undefined}
        >
          {item.type === 'file_summary' && <MessageFileChanges diffsChanges={item.diffs} />}
          {item.type === 'tool_summary' && <MessageToolGroupSummary messages={item.messages}></MessageToolGroupSummary>}
        </div>
      );
    }
    return (
      <MessageItem
        message={item as TMessage}
        key={(item as TMessage).id}
        highlighted={highlighted}
        commandEvePermissionPolicy={commandEvePermissionPolicy}
      ></MessageItem>
    );
  };

  if (processedList.length === 0 && (isMessageListLoading || suppressEmptySlot) && !tailSlot) {
    return <MessageListSkeleton />;
  }

  if (processedList.length === 0 && emptySlot && !tailSlot) {
    return <div className='relative flex-1 h-full flex items-center justify-center'>{emptySlot}</div>;
  }

  return (
    <div className={classNames('relative flex-1 h-full', className)}>
      {/* Use PreviewGroup to wrap all messages for cross-message image preview */}
      <Image.PreviewGroup actionsLayout={['zoomIn', 'zoomOut', 'originalSize', 'rotateLeft', 'rotateRight']}>
        <ImagePreviewContext.Provider value={{ inPreviewGroup: true }}>
          <div
            ref={handleScrollerRef}
            data-testid='message-list-scroller'
            data-eve-interaction-role='selection-surface'
            // Break out of the parent's 20px horizontal padding so the scrollbar hugs the
            // window edge, while re-applying that padding inside to keep message content inset.
            className='flex-1 h-full overflow-y-auto pb-10px box-border -mx-20px px-20px'
            style={{ overflowAnchor: 'none' }}
            onPointerDown={handlePointerDown}
            onScroll={handleMessageListScroll}
            onWheel={handleWheel}
          >
            <div ref={handleContentRef} data-testid='message-list-content' style={{ overflowAnchor: 'none' }}>
              {historyPagination.isLoadingOlderMessages && (
                <div data-testid='message-history-loading-older' className='h-28px flex items-center justify-center'>
                  <div className='w-14px h-14px rd-full border-2 border-solid border-3 border-t-primary animate-spin' />
                </div>
              )}
              <div className='h-10px' />
              {processedList.map((item, index) => (
                <React.Fragment key={getProcessedItemAnchorId(item) || index}>{renderItem(index, item)}</React.Fragment>
              ))}
              {tailSlot}
              <div className='h-20px' />
            </div>
          </div>
        </ImagePreviewContext.Provider>
      </Image.PreviewGroup>

      {showScrollButton && (
        <>
          {/* Gradient mask */}
          <div className='absolute bottom-0 left-0 right-0 h-100px pointer-events-none' />
          {/* Scroll button */}
          <div className='absolute bottom-20px left-50% transform -translate-x-50% z-100'>
            <button
              type='button'
              className='eve-focus-ring flex items-center justify-center w-40px h-40px p-0 rd-full cursor-pointer transition-all hover:scale-105 border-1 border-solid'
              onClick={handleScrollButtonClick}
              title={t('messages.scrollToBottom')}
              aria-label={t('messages.scrollToBottom')}
              style={{
                lineHeight: 0,
                color: 'var(--eve-shell-text-secondary)',
                background: 'var(--glass-overlay-bg)',
                borderColor: 'var(--glass-overlay-border)',
                boxShadow: 'var(--glass-shadow-soft)',
                backdropFilter: 'var(--glass-overlay-filter)',
                WebkitBackdropFilter: 'var(--glass-overlay-filter)',
              }}
            >
              <Down theme='filled' size='20' fill={iconColors.secondary} style={{ display: 'block' }} />
            </button>
          </div>
        </>
      )}

      <SelectionReplyButton messages={list} />
    </div>
  );
};

export default MessageList;
