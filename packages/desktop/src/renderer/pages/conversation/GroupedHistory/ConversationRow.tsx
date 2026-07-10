/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import CommandEveGlyph from '@/renderer/components/commandEve/CommandEveGlyph';
import { cleanupSiderTooltips, getSiderTooltipProps } from '@/renderer/utils/ui/siderTooltip';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { Checkbox, Dropdown, Menu, Spin, Tooltip } from '@arco-design/web-react';
import { Box, DeleteOne, EditOne, Export, FolderOpen, MoreOne, Pushpin } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';

import type { ConversationRowProps } from './types';
import { isConversationArchived, isConversationPinned } from './utils/groupingHelpers';
import { getActivityTime } from '@/renderer/utils/chat/timeline';
import SessionStatusDot from './SessionStatusDot';
import { deriveSessionStatus } from './sessionStatus';

export const formatConversationActivityTime = (timestamp: number, now = Date.now()): string => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const ConversationRow: React.FC<ConversationRowProps> = (props) => {
  const {
    conversation,
    isGenerating,
    hasCompletionUnread,
    isWaitingInput,
    hasError,
    collapsed,
    tooltipEnabled,
    batchMode,
    checked,
    selected,
    menuVisible,
    dimIcon = false,
  } = props;
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const {
    onToggleChecked,
    onConversationClick,
    onOpenMenu,
    onMenuVisibleChange,
    onEditStart,
    onDelete,
    onExport,
    onTogglePin,
    onToggleArchive,
    onMoveStart,
    getJobStatus,
  } = props;
  const { t } = useTranslation();
  const isPinned = isConversationPinned(conversation);
  const isArchived = isConversationArchived(conversation);
  const cronStatus = getJobStatus(conversation.id);
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);
  const inlineNameTooltipEnabled = !collapsed && !isMobile && !!conversation.name;
  const lastActiveLabel = React.useMemo(
    () => formatConversationActivityTime(getActivityTime(conversation)),
    [conversation]
  );

  // ONE semantic status for the row: the public identity remains EVE regardless
  // of which private runtime executes the work, and a single colored dot — done=green,
  // attention=orange, error=red, running=Spin overlay — replaces the old mix of a
  // separate unread dot + the cron alarm/pause/attention glyph swapped in as the
  // leading icon. The dots now fire for NORMAL chats too (waiting-input + errored
  // turns), not just scheduled/cron tasks. See sessionStatus.ts for the full
  // mapping + rationale.
  const sessionStatus = deriveSessionStatus({
    isGenerating,
    hasCompletionUnread,
    isWaitingInput,
    hasError,
    cronStatus,
  });

  const renderLeadingIcon = () => {
    // When the row is pinned, hovering reveals a pushpin marker that overlays
    // the leading icon. We dim the resting icon on hover so the pin reads cleanly.
    const pinnedHoverFade = isPinned ? 'group-hover:opacity-0 transition-opacity' : '';
    return (
      <CommandEveGlyph
        size={16}
        className={classNames(
          pinnedHoverFade,
          'transition-all',
          sessionStatus === 'idle' && !selected && 'command-eve-glyph--muted'
        )}
      />
    );
  };

  const handleRowClick = () => {
    cleanupSiderTooltips();
    if (batchMode) {
      onToggleChecked(conversation);
      return;
    }
    onConversationClick(conversation);
  };

  const handleRowContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    cleanupSiderTooltips();
    if (batchMode) {
      return;
    }
    onOpenMenu(conversation);
  };

  return (
    <Tooltip
      key={conversation.id}
      {...siderTooltipProps}
      content={conversation.name || t('conversation.welcome.newConversation')}
      position='right'
    >
      <div
        id={'c-' + conversation.id}
        aria-current={selected ? 'page' : undefined}
        className={classNames(
          'chat-history__item eve-row h-34px rd-8px flex items-center group cursor-pointer relative overflow-hidden shrink-0 conversation-item [&.conversation-item+&.conversation-item]:mt-2px min-w-0',
          collapsed ? 'justify-center px-0' : 'justify-start gap-8px pr-16px',
          // dimIcon means this row sits inside a project/cron parent — visually indent the row content while keeping the bg full-width
          !collapsed && (dimIcon ? 'pl-34px' : 'pl-10px'),
          {
            'eve-row--selected': selected,
            'bg-[rgba(var(--primary-6),0.08)]': batchMode && checked,
          }
        )}
        onClick={handleRowClick}
        onContextMenu={handleRowContextMenu}
      >
        {batchMode && (
          <span
            className='mr-8px flex-center'
            onClick={(event) => {
              event.stopPropagation();
              onToggleChecked(conversation);
            }}
          >
            <Checkbox checked={checked} />
          </span>
        )}
        <span className='size-22px flex items-center justify-center shrink-0 relative'>
          {/* The EVE glyph ALWAYS renders (public identity stays put);
              while a turn streams we overlay a small Spin on its bottom-right
              instead of replacing the glyph with a bare spinner. */}
          {renderLeadingIcon()}
          {isGenerating && !batchMode && (
            <span className='absolute -bottom-2px -right-2px flex-center pointer-events-none' style={{ lineHeight: 0 }}>
              <Spin size={14} />
            </span>
          )}
          {/* ONE semantic status dot, overlaid on the glyph's bottom-right. Hidden
              in batch mode (the checkbox owns the row) and while generating (the
              Spin overlay already signals "running"). idle renders nothing. */}
          {!batchMode && !isGenerating && <SessionStatusDot status={sessionStatus} overlay />}
          {/* Pinned indicator: only visible when row is hovered, overlays leading icon */}
          {!batchMode && isPinned && !isMobile && !isGenerating && (
            <span
              className='absolute inset-0 flex-center text-t-secondary pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity'
              style={{ lineHeight: 0 }}
            >
              <Pushpin theme='outline' size='14' />
            </span>
          )}
        </span>
        <FlexFullContainer
          className='h-24px min-w-0 flex-1 collapsed-hidden'
          containerClassName='flex items-center min-w-0 pr-30px'
        >
          <Tooltip
            content={conversation.name}
            disabled={!inlineNameTooltipEnabled}
            trigger='hover'
            popupVisible={inlineNameTooltipEnabled ? undefined : false}
            unmountOnExit
            popupHoverStay={false}
            position='top'
          >
            <div className='chat-history__item-name overflow-hidden text-ellipsis block flex-1 text-14px font-[500] lh-24px whitespace-nowrap min-w-0 text-t-primary'>
              <span className='block overflow-hidden text-ellipsis whitespace-nowrap'>{conversation.name}</span>
            </div>
          </Tooltip>
          {!isMobile && lastActiveLabel && (
            <span className='ml-8px shrink-0 text-11px leading-24px text-t-tertiary tabular-nums'>
              {lastActiveLabel}
            </span>
          )}
        </FlexFullContainer>

        {!batchMode && (
          <div
            className={classNames(
              'absolute right-8px top-1/2 -translate-y-1/2 items-center justify-end !collapsed-hidden',
              {
                flex: isMobile || menuVisible,
                'hidden group-hover:flex': !isMobile && !menuVisible,
              }
            )}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <Dropdown
              droplist={
                <Menu
                  onClickMenuItem={(key) => {
                    if (key === 'pin') {
                      onTogglePin(conversation);
                      return;
                    }
                    if (key === 'archive') {
                      onToggleArchive?.(conversation);
                      return;
                    }
                    if (key === 'move') {
                      onMoveStart?.(conversation);
                      return;
                    }
                    if (key === 'rename') {
                      onEditStart(conversation);
                      return;
                    }
                    if (key === 'export') {
                      onExport?.(conversation);
                      return;
                    }
                    if (key === 'delete') {
                      onDelete(conversation.id);
                    }
                  }}
                >
                  <Menu.Item key='pin'>
                    <div className='flex items-center gap-8px'>
                      <Pushpin theme='outline' size='14' />
                      <span>{isPinned ? t('conversation.history.unpin') : t('conversation.history.pin')}</span>
                    </div>
                  </Menu.Item>
                  {onToggleArchive && (
                    <Menu.Item key='archive'>
                      <div className='flex items-center gap-8px'>
                        <Box theme='outline' size='14' />
                        <span>
                          {isArchived ? t('conversation.history.restore') : t('conversation.history.archive')}
                        </span>
                      </div>
                    </Menu.Item>
                  )}
                  {onMoveStart && (
                    <Menu.Item key='move'>
                      <div className='flex items-center gap-8px'>
                        <FolderOpen theme='outline' size='14' />
                        <span>{t('conversation.history.moveToFolder')}</span>
                      </div>
                    </Menu.Item>
                  )}
                  <Menu.Item key='rename'>
                    <div className='flex items-center gap-8px'>
                      <EditOne theme='outline' size='14' />
                      <span>{t('conversation.history.rename')}</span>
                    </div>
                  </Menu.Item>
                  {onExport && (
                    <Menu.Item key='export'>
                      <div className='flex items-center gap-8px'>
                        <Export theme='outline' size='14' />
                        <span>{t('conversation.history.export')}</span>
                      </div>
                    </Menu.Item>
                  )}
                  <Menu.Item key='delete'>
                    <div className='flex items-center gap-8px text-[rgb(var(--warning-6))]'>
                      <DeleteOne theme='outline' size='14' />
                      <span>{t('conversation.history.deleteTitle')}</span>
                    </div>
                  </Menu.Item>
                </Menu>
              }
              trigger='click'
              position='br'
              popupVisible={menuVisible}
              onVisibleChange={(visible) => onMenuVisibleChange(conversation.id, visible)}
              getPopupContainer={() => document.body}
              unmountOnExit={false}
            >
              <span
                className={classNames(
                  'flex-center cursor-pointer transition-colors text-t-secondary hover:text-t-primary size-20px rd-4px sider-action-btn',
                  {
                    flex: isMobile || menuVisible,
                    'hidden group-hover:flex': !isMobile && !menuVisible,
                  }
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenMenu(conversation);
                }}
              >
                <MoreOne theme='outline' size='14' fill='currentColor' className='block leading-none' />
              </span>
            </Dropdown>
          </div>
        )}
      </div>
    </Tooltip>
  );
};

export default ConversationRow;
