/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { COMMAND_EVE_ASSISTANT_AVATAR } from '@/common/config/commandEveShell';
import { getAgentLogo } from '@/renderer/utils/model/agentLogo';
import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import { usePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { cleanupSiderTooltips, getSiderTooltipProps } from '@/renderer/utils/ui/siderTooltip';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { Checkbox, Dropdown, Menu, Spin, Tooltip } from '@arco-design/web-react';
import { DeleteOne, EditOne, Export, MessageOne, MoreOne, Pushpin } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';

import type { ConversationRowProps } from './types';
import { getBackendKeyFromConversation } from './utils/exportHelpers';
import { isConversationPinned } from './utils/groupingHelpers';
import SessionStatusDot from './SessionStatusDot';
import { deriveSessionStatus } from './sessionStatus';

// State-driven avatar with a ⌘ fallback. Conversation avatars frequently resolve to a
// runtime API URL (http://127.0.0.1:<port>/api/assistants/:id/avatar) that 404s. A plain
// onError that mutates img.src is undone by React's controlled `src` on the next render
// (and the broken cached URL won't re-fire onError), so the broken glyph returns — that
// was the founder's "kaputte Symbole" across the sidebar. Driving the src from STATE
// survives re-renders: on error we switch to the bundled ⌘ mark (which always loads).
const RowLeadingImg: React.FC<{ src: string; alt: string; className: string }> = ({ src, alt, className }) => {
  const [resolvedSrc, setResolvedSrc] = React.useState(src);
  React.useEffect(() => setResolvedSrc(src), [src]);
  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className={className}
      onError={() => setResolvedSrc((cur) => (cur === COMMAND_EVE_ASSISTANT_AVATAR ? cur : COMMAND_EVE_ASSISTANT_AVATAR))}
    />
  );
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
    getJobStatus,
  } = props;
  const { t } = useTranslation();
  const { info: assistantInfo } = usePresetAssistantInfo(conversation);
  const isPinned = isConversationPinned(conversation);
  const cronStatus = getJobStatus(conversation.id);
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);
  const inlineNameTooltipEnabled = !collapsed && !isMobile && !!conversation.name;

  // ONE semantic status for the row (Variante B): the leading icon stays the
  // agent/⌘ avatar (identity), and a single colored dot — done=green,
  // attention=orange, error=red, running=Spin overlay — replaces the old mix of a
  // separate unread dot + the cron alarm/pause/attention glyph swapped in as the
  // leading icon. The dots now fire for NORMAL chats too (waiting-input + errored
  // turns), not just scheduled/cron tasks. See sessionStatus.ts for the full
  // mapping + rationale.
  const sessionStatus = deriveSessionStatus({ isGenerating, hasCompletionUnread, isWaitingInput, hasError, cronStatus });

  const renderLeadingIcon = () => {
    // When the row is pinned, hovering reveals a pushpin marker that overlays
    // the leading icon. We dim the resting icon on hover so the pin reads cleanly.
    const pinnedHoverFade = isPinned ? 'group-hover:opacity-0 transition-opacity' : '';
    // Variante B: "erledigt"/idle rows render the brand mark in an ANTHRACITE
    // (muted) treatment so they recede; pending states (running/attention/error/
    // done) render it at full strength so they pop. grayscale + reduced opacity
    // keeps it subtle and works for both the colored agent logos and the ⌘ mark.
    const idleMuted = sessionStatus === 'idle' ? 'grayscale opacity-55' : '';
    const composedClass = classNames(pinnedHoverFade, idleMuted, 'transition-all');

    if (assistantInfo) {
      if (assistantInfo.isEmoji) {
        return (
          <span className={classNames('text-16px leading-none flex-shrink-0', composedClass)}>
            {assistantInfo.logo}
          </span>
        );
      }
      return (
        <RowLeadingImg
          src={assistantInfo.logo}
          alt={assistantInfo.name}
          className={classNames('w-16px h-16px rounded-50% flex-shrink-0', composedClass)}
        />
      );
    }

    const backendKey = getBackendKeyFromConversation(conversation);
    const logo = getAgentLogo(backendKey);
    if (logo) {
      return (
        <RowLeadingImg
          src={logo}
          alt={`${backendKey || 'agent'} logo`}
          className={classNames('w-16px h-16px rounded-50% flex-shrink-0', composedClass)}
        />
      );
    }

    // GUARANTEED EVE fallback: when no preset assistant info and no backend logo
    // resolves (EVE/hermes/aionrs lanes already map to the ⌘ mark via getAgentLogo,
    // but this covers any lane that returns falsy), render the Command EVE ⌘ brand
    // mark instead of the generic MessageOne glyph so an EVE row always reads as EVE.
    const isEveLane = backendKey === 'hermes' || backendKey === 'aionrs';
    if (isEveLane || !backendKey) {
      return (
        <img
          src={COMMAND_EVE_ASSISTANT_AVATAR}
          alt='Command EVE'
          className={classNames('w-16px h-16px rounded-50% flex-shrink-0', composedClass)}
        />
      );
    }

    return (
      <MessageOne
        theme='outline'
        size='16'
        className={classNames('line-height-0 flex-shrink-0 text-t-secondary', composedClass)}
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
        className={classNames(
          'chat-history__item h-34px rd-8px flex items-center group cursor-pointer relative overflow-hidden shrink-0 conversation-item [&.conversation-item+&.conversation-item]:mt-2px min-w-0 transition-colors',
          collapsed ? 'justify-center px-0' : 'justify-start gap-8px pr-16px',
          // dimIcon means this row sits inside a project/cron parent — visually indent the row content while keeping the bg full-width
          !collapsed && (dimIcon ? 'pl-34px' : 'pl-10px'),
          {
            'hover:bg-fill-3': !batchMode && !selected,
            '!bg-fill-3': selected,
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
          {/* Variante B: the ⌘/agent avatar ALWAYS renders (identity stays put);
              while a turn streams we overlay a small Spin on its bottom-right
              instead of replacing the avatar with a bare spinner. */}
          {renderLeadingIcon()}
          {isGenerating && !batchMode && (
            <span
              className='absolute -bottom-2px -right-2px flex-center pointer-events-none'
              style={{ lineHeight: 0 }}
            >
              <Spin size={14} />
            </span>
          )}
          {/* ONE semantic status dot, overlaid on the avatar's bottom-right. Hidden
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
        <FlexFullContainer className='h-24px min-w-0 flex-1 collapsed-hidden'>
          <Tooltip
            content={conversation.name}
            disabled={!inlineNameTooltipEnabled}
            trigger='hover'
            popupVisible={inlineNameTooltipEnabled ? undefined : false}
            unmountOnExit
            popupHoverStay={false}
            position='top'
          >
            <div className='chat-history__item-name overflow-hidden text-ellipsis block w-full text-14px font-[500] lh-24px whitespace-nowrap min-w-0 text-t-primary'>
              <span className='block overflow-hidden text-ellipsis whitespace-nowrap'>{conversation.name}</span>
            </div>
          </Tooltip>
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
