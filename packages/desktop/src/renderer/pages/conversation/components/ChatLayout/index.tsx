import { AgentLogoIcon } from '@/renderer/components/agent/AgentBadge';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import type { PresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import ShellWorkbenchTabs from '@/renderer/components/layout/Titlebar/ShellWorkbenchTabs';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useResizableSplit } from '@/renderer/hooks/ui/useResizableSplit';
import ChatTitleEditor from '@/renderer/pages/conversation/components/ChatTitleEditor';
import ShellElementsRail from '@/renderer/components/layout/Titlebar/ShellElementsRail';
import MobileWorkspaceOverlay from './MobileWorkspaceOverlay';
import WorkspacePanelHeader, { DesktopWorkspaceToggle } from './WorkspacePanelHeader';
import { useContainerWidth } from '@/renderer/pages/conversation/hooks/useContainerWidth';
import { useLayoutConstraints } from '@/renderer/pages/conversation/hooks/useLayoutConstraints';
import { useTitleRename } from '@/renderer/pages/conversation/hooks/useTitleRename';
import { useWorkspaceCollapse } from '@/renderer/pages/conversation/hooks/useWorkspaceCollapse';
import { PreviewPanel, usePreviewContext } from '@/renderer/pages/conversation/Preview';
import {
  ELEMENTS_RAIL_REVEAL_EVENT,
  dispatchWorkspaceTabSelectEvent,
  dispatchWorkspaceToggleEvent,
  type ElementsRailRevealDetail,
  type ElementsRailTab,
  type WorkspaceSurfaceTab,
} from '@/renderer/utils/workspace/workspaceEvents';
import { useConversationAgents } from '@/renderer/pages/conversation/hooks/useConversationAgents';
import classNames from 'classnames';
import { isMacEnvironment, isWindowsEnvironment } from '@/renderer/pages/conversation/utils/detectPlatform';
import {
  DEFAULT_WORKSPACE_PANEL_PX,
  MAX_WORKSPACE_PANEL_PX,
  MIN_WORKSPACE_PANEL_PX,
  WORKSPACE_HEADER_HEIGHT,
  calcLayoutMetrics,
} from '@/renderer/pages/conversation/utils/layoutCalc';
import { Layout as ArcoLayout } from '@arco-design/web-react';
import { ExpandLeft, ExpandRight } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import './chat-layout.css';

const BOTTOM_SPLIT_STORAGE_KEY = 'eve-workbench-bottom-preview-ratio';
const DEFAULT_BOTTOM_PREVIEW_RATIO = 62;

const loadBottomPreviewRatio = (): number => {
  try {
    const stored = Number.parseFloat(localStorage.getItem(BOTTOM_SPLIT_STORAGE_KEY) || '');
    if (Number.isFinite(stored) && stored >= 36 && stored <= 72) return stored;
  } catch {
    // Use the balanced default when storage is unavailable.
  }
  return DEFAULT_BOTTOM_PREVIEW_RATIO;
};

// headerExtra allows injecting custom actions (e.g., model picker) into the header's right area
const ChatLayout: React.FC<{
  children: React.ReactNode;
  title?: React.ReactNode;
  sider: React.ReactNode;
  siderTitle?: React.ReactNode;
  backend?: string;
  /** Preset assistant info — when provided, badge shows assistant identity instead of backend */
  presetAssistant?: PresetAssistantInfo & { id?: string };
  /** Fallback agent name (used when no presetAssistant, e.g. from conversation.extra.agent_name) */
  agent_name?: string;
  headerExtra?: React.ReactNode;
  workspaceEnabled?: boolean;
  /** Conversation ID for mode switching */
  conversation_id?: string;
  /** Custom tabs slot; when provided, replaces the default ConversationTabs */
  tabsSlot?: React.ReactNode;
  /** Workspace path for opening in external tools */
  workspacePath?: string;
  /** Workspace event namespace follows the conversation transport, never the selected model/backend. */
  workspaceEventPrefix?: 'acp' | 'codex' | 'aionrs';
  /** Authoritative temp-workspace flag from `conversation.extra.is_temporary_workspace`. */
  isTemporaryWorkspace?: boolean;
  /**
   * Stable key for persisting the workspace collapse preference. Defaults to
   * `conversation_id` for single chats; team mode passes `team_id` so the
   * preference survives agent-tab switches.
   */
  workspacePreferenceKey?: string;
  /** Custom rename handler; when provided, replaces the default conversation.update rename flow */
  onRenameTitle?: (new_name: string) => Promise<boolean>;
  /** Optional override for the leading icon shown before the title (e.g. team Peoples icon) */
  headerLeading?: React.ReactNode;
}> = (props) => {
  const { t } = useTranslation();
  const { conversation_id, workspacePath, isTemporaryWorkspace } = props;
  const { backend, presetAssistant, agent_name, workspaceEnabled = true, workspacePreferenceKey } = props;
  const workspaceEventPrefix = props.workspaceEventPrefix ?? 'acp';
  // Command EVE: the EVE logo here duplicates the macOS window title-bar brand, so the
  // chat-header logo icon is suppressed throughout the branded EVE shell. Older
  // conversations can lack preset-assistant metadata and must not fall back to a
  // stale backend logo request.
  const isCommandEveAssistant = COMMAND_EVE_SHELL_ENABLED;
  const layout = useLayoutContext();
  const isMacRuntime = isMacEnvironment();
  const isWindowsRuntime = isWindowsEnvironment();
  const isDesktop = !layout?.isMobile;
  const isMobile = Boolean(layout?.isMobile);
  const elementsRailEnabled = COMMAND_EVE_SHELL_ENABLED && isDesktop;
  const desktopPanelEnabled = elementsRailEnabled || workspaceEnabled;
  const [elementsRailTab, setElementsRailTab] = useState<ElementsRailTab>('activity');
  const pendingWorkspaceTabRef = useRef<WorkspaceSurfaceTab | null>(null);

  // Preview panel state
  const { isOpen: isPreviewOpen, tabs: previewTabs, activeTabId, activeTab, workbenchLayoutMode } = usePreviewContext();
  const keepPreviewMounted = COMMAND_EVE_SHELL_ENABLED && previewTabs.length > 0;
  const [bottomPreviewRatio, setBottomPreviewRatio] = useState(loadBottomPreviewRatio);

  // --- Hook A: workspace collapse ---
  const { rightSiderCollapsed, setRightSiderCollapsed } = useWorkspaceCollapse({
    workspaceEnabled: isMobile ? workspaceEnabled : desktopPanelEnabled,
    isMobile,
    conversation_id,
    preferenceKey: workspacePreferenceKey ?? conversation_id,
    isTemporaryWorkspace,
  });

  // Hermes desktop tools must reveal the files surface as one state change.
  // Keeping visibility and selection here prevents a green tool receipt from
  // racing two independent window events owned by different components.
  useEffect(() => {
    if (!elementsRailEnabled || typeof window === 'undefined') return undefined;
    const revealElementsRail = (event: Event) => {
      const detail = (event as CustomEvent<ElementsRailRevealDetail>).detail;
      const tab = detail?.tab;
      if (tab !== 'activity' && tab !== 'artifacts' && tab !== 'context') return;
      if (detail.workspaceTab) {
        if (tab === 'context' && elementsRailTab === 'context' && !rightSiderCollapsed) {
          dispatchWorkspaceTabSelectEvent(detail.workspaceTab);
        } else {
          pendingWorkspaceTabRef.current = detail.workspaceTab;
        }
      }
      setElementsRailTab(tab);
      setRightSiderCollapsed(false);
    };
    window.addEventListener(ELEMENTS_RAIL_REVEAL_EVENT, revealElementsRail);
    return () => window.removeEventListener(ELEMENTS_RAIL_REVEAL_EVENT, revealElementsRail);
  }, [elementsRailEnabled, elementsRailTab, rightSiderCollapsed, setRightSiderCollapsed]);

  useEffect(() => {
    if (!elementsRailEnabled || elementsRailTab !== 'context' || rightSiderCollapsed) return undefined;
    const pendingTab = pendingWorkspaceTabRef.current;
    if (!pendingTab) return undefined;
    pendingWorkspaceTabRef.current = null;
    const frame = window.requestAnimationFrame(() => dispatchWorkspaceTabSelectEvent(pendingTab));
    return () => window.cancelAnimationFrame(frame);
  }, [elementsRailEnabled, elementsRailTab, rightSiderCollapsed]);

  // --- Hook B: container width ---
  const { containerRef, containerWidth } = useContainerWidth();
  const isEveWorkbenchActive =
    COMMAND_EVE_SHELL_ENABLED &&
    isDesktop &&
    isPreviewOpen &&
    Boolean(activeTab) &&
    (!conversation_id || activeTab?.metadata?.conversation_id === conversation_id);
  const isWorkspaceWorkbenchSurface =
    isEveWorkbenchActive &&
    (activeTab?.content_type === 'workspace-files' || activeTab?.content_type === 'workspace-review');
  const activeWorkbenchLayout = isEveWorkbenchActive ? workbenchLayoutMode : 'focus';
  const showChatBesideWorkbench = isEveWorkbenchActive && activeWorkbenchLayout !== 'focus';

  // --- Hook C: title rename ---
  const { editingTitle, setEditingTitle, titleDraft, setTitleDraft, renameLoading, canRenameTitle, submitTitleRename } =
    useTitleRename({
      title: props.title,
      conversation_id,
      onRename: props.onRenameTitle,
    });

  // Resolve backend display name from detected agents catalog (backend-authoritative).
  // Custom ACP agents live in the same catalog with `agent_source === 'custom'`,
  // so we no longer need a separate `acp.customAgents` ConfigStorage fallback.
  const { cliAgents } = useConversationAgents();
  const backendAgentName = backend
    ? cliAgents.find((a) => a.backend === backend || a.agent_type === backend)?.name
    : undefined;
  const capitalizedBackend = backend ? backend.charAt(0).toUpperCase() + backend.slice(1) : backend;

  // Compute display name with fallback chain
  const display_name = presetAssistant?.name || agent_name || backendAgentName || capitalizedBackend;

  const {
    splitRatio: workspaceWidthPxPref,
    setSplitRatio: setWorkspaceWidthPxPref,
    createDragHandle: createWorkspaceDragHandle,
  } = useResizableSplit({
    unit: 'px',
    defaultWidth: DEFAULT_WORKSPACE_PANEL_PX,
    minWidth: MIN_WORKSPACE_PANEL_PX,
    maxWidth: MAX_WORKSPACE_PANEL_PX,
    storageKey: 'chat-workspace-width-px',
  });

  const handleBottomDividerPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' && event.button !== 0) return;
      const container = event.currentTarget.parentElement;
      const containerHeight = container?.getBoundingClientRect().height || 0;
      if (!containerHeight) return;

      event.preventDefault();
      const startY = event.clientY;
      const startRatio = bottomPreviewRatio;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const ratioAt = (clientY: number) =>
        Math.max(36, Math.min(72, startRatio + ((clientY - startY) / containerHeight) * 100));

      const onMove = (moveEvent: PointerEvent) => setBottomPreviewRatio(ratioAt(moveEvent.clientY));
      const finish = (finishEvent?: PointerEvent) => {
        const finalRatio = finishEvent ? ratioAt(finishEvent.clientY) : bottomPreviewRatio;
        setBottomPreviewRatio(finalRatio);
        try {
          localStorage.setItem(BOTTOM_SPLIT_STORAGE_KEY, String(finalRatio));
        } catch {
          // The current split remains active even when persistence is unavailable.
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [bottomPreviewRatio]
  );
  const handleBottomDividerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextRatio =
        event.key === 'Home'
          ? 36
          : event.key === 'End'
            ? 72
            : Math.max(36, Math.min(72, bottomPreviewRatio + (event.key === 'ArrowDown' ? 2 : -2)));
      setBottomPreviewRatio(nextRatio);
      try {
        localStorage.setItem(BOTTOM_SPLIT_STORAGE_KEY, String(nextRatio));
      } catch {
        // The current split remains active even when persistence is unavailable.
      }
    },
    [bottomPreviewRatio]
  );
  const effectiveWorkspaceWidthPx = elementsRailEnabled ? 308 : workspaceWidthPxPref;

  // Pre-hook metrics: compute dynamic min/max for the chat-preview split hook
  const { dynamicChatMinRatio, dynamicChatMaxRatio } = calcLayoutMetrics({
    containerWidth,
    workspaceWidthPx: effectiveWorkspaceWidthPx,
    chatSplitRatio: 60, // placeholder; only dynamicChatMinRatio/dynamicChatMaxRatio are used here
    workspaceEnabled: desktopPanelEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    isMobile,
  });

  const {
    splitRatio: chatSplitRatio,
    setSplitRatio: setChatSplitRatio,
    createDragHandle: createPreviewDragHandle,
  } = useResizableSplit({
    defaultWidth: COMMAND_EVE_SHELL_ENABLED ? 42 : 60,
    minWidth: dynamicChatMinRatio,
    maxWidth: dynamicChatMaxRatio,
    storageKey: COMMAND_EVE_SHELL_ENABLED ? 'eve-workbench-chat-preview-ratio-v2' : 'chat-preview-split-ratio',
  });

  // Full metrics with real chatSplitRatio
  const { chatFlex, workspaceWidthPx, titleAreaMaxWidth, mobileWorkspaceHandleRight } = calcLayoutMetrics({
    containerWidth,
    workspaceWidthPx: effectiveWorkspaceWidthPx,
    chatSplitRatio,
    workspaceEnabled: desktopPanelEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    isMobile,
  });

  // --- Hook E: layout constraints ---
  useLayoutConstraints({
    containerWidth,
    workspaceEnabled: desktopPanelEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    setRightSiderCollapsed,
    workspaceWidthPx: effectiveWorkspaceWidthPx,
    setWorkspaceWidthPx: setWorkspaceWidthPxPref,
    chatSplitRatio,
    setChatSplitRatio,
    dynamicChatMinRatio,
    dynamicChatMaxRatio,
  });

  const [mobileActionsSlot, setMobileActionsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!layout?.isMobile) {
      setMobileActionsSlot(null);
      return;
    }
    const findSlot = () => document.getElementById('app-titlebar-actions-slot');
    setMobileActionsSlot(findSlot());
    const observer = new MutationObserver(() => {
      const next = findSlot();
      setMobileActionsSlot((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [layout?.isMobile]);

  const desktopHeader = (
    <ArcoLayout.Header
      className={classNames(
        'min-h-44px flex items-center justify-between px-16px pt-8px pb-10px gap-16px chat-layout-header chat-layout-header--glass',
        COMMAND_EVE_SHELL_ENABLED ? 'chat-layout-header--eve-launcher overflow-visible' : 'overflow-hidden'
      )}
    >
      <FlexFullContainer className='h-full min-w-0' containerClassName='flex items-center'>
        <ChatTitleEditor
          editingTitle={editingTitle}
          titleDraft={titleDraft}
          setTitleDraft={setTitleDraft}
          setEditingTitle={setEditingTitle}
          renameLoading={renameLoading}
          canRenameTitle={canRenameTitle}
          submitTitleRename={submitTitleRename}
          titleAreaMaxWidth={titleAreaMaxWidth}
          title={props.title}
          conversation_id={conversation_id}
          leading={
            props.headerLeading ??
            (!isCommandEveAssistant && (backend || presetAssistant) && (
              <AgentLogoIcon
                backend={backend}
                agent_name={display_name}
                agentLogo={presetAssistant?.logo}
                agentLogoIsEmoji={presetAssistant?.isEmoji}
              />
            ))
          }
        />
      </FlexFullContainer>
      <div className='flex items-center gap-12px shrink-0'>
        {COMMAND_EVE_SHELL_ENABLED && conversation_id && !isPreviewOpen && (
          <ShellWorkbenchTabs
            conversationId={conversation_id}
            workspacePath={workspacePath}
            workspaceEventPrefix={workspaceEventPrefix}
            isTemporaryWorkspace={isTemporaryWorkspace}
            launcherOnly
          />
        )}
        {props.headerExtra}
        {isWindowsRuntime && workspaceEnabled && !COMMAND_EVE_SHELL_ENABLED && (
          <button
            type='button'
            className='workspace-header__toggle'
            aria-label='Toggle workspace'
            onClick={() => dispatchWorkspaceToggleEvent()}
          >
            {rightSiderCollapsed ? <ExpandRight size={16} /> : <ExpandLeft size={16} />}
          </button>
        )}
      </div>
    </ArcoLayout.Header>
  );

  const headerBlock = (
    <>
      {layout?.isMobile && mobileActionsSlot && props.headerExtra && createPortal(props.headerExtra, mobileActionsSlot)}
      {props.tabsSlot}
    </>
  );

  const chatPaneDisplay =
    isPreviewOpen && (isMobile || (COMMAND_EVE_SHELL_ENABLED && !showChatBesideWorkbench)) ? 'none' : 'flex';
  const chatPaneFlexBasis = isEveWorkbenchActive
    ? activeWorkbenchLayout === 'split-right'
      ? `${chatSplitRatio}%`
      : activeWorkbenchLayout === 'split-bottom'
        ? `${100 - bottomPreviewRatio}%`
        : 0
    : isPreviewOpen && isDesktop && !COMMAND_EVE_SHELL_ENABLED
      ? `${chatFlex}%`
      : 0;
  const previewPaneFlexBasis =
    isEveWorkbenchActive && activeWorkbenchLayout === 'split-bottom' ? `${bottomPreviewRatio}%` : 0;

  return (
    <ArcoLayout
      className='size-full color-black chat-layout-shell'
      style={{
        // fontFamily: `cursive,"anthropicSans","anthropicSans Fallback",system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif`,
      }}
    >
      <div ref={containerRef} className='flex flex-1 relative w-full overflow-hidden'>
        {/* Unified layout: single DOM structure prevents children unmount/remount on preview toggle */}
        <div
          className='flex flex-col min-w-0'
          style={{
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
          }}
        >
          <div className='shrink-0 chat-layout-header-block'>{headerBlock}</div>
          <div
            className={classNames(
              'flex flex-1 min-h-0 relative',
              isEveWorkbenchActive && 'eve-workbench-layout',
              isEveWorkbenchActive && `eve-workbench-layout--${activeWorkbenchLayout}`
            )}
            data-eve-workbench-layout={isEveWorkbenchActive ? activeWorkbenchLayout : undefined}
          >
            {/* Chat area - always mounted, never unmounted on preview toggle */}
            <div
              id={COMMAND_EVE_SHELL_ENABLED && conversation_id ? `eve-chat-pane-${conversation_id}` : undefined}
              data-eve-interaction-role='focus-surface'
              aria-hidden={COMMAND_EVE_SHELL_ENABLED ? isPreviewOpen && !showChatBesideWorkbench : undefined}
              tabIndex={COMMAND_EVE_SHELL_ENABLED ? -1 : undefined}
              className={classNames(
                'flex flex-col relative',
                isEveWorkbenchActive && showChatBesideWorkbench && 'eve-chat-pane--workbench',
                isEveWorkbenchActive && activeWorkbenchLayout === 'split-bottom' && 'eve-chat-pane--split-bottom'
              )}
              style={{
                flexGrow: isEveWorkbenchActive ? 0 : isPreviewOpen && isDesktop && !COMMAND_EVE_SHELL_ENABLED ? 0 : 1,
                flexShrink: 0,
                flexBasis: chatPaneFlexBasis,
                display: chatPaneDisplay,
                minWidth: '240px',
                order: isEveWorkbenchActive && activeWorkbenchLayout === 'split-bottom' ? 2 : 1,
              }}
              onClick={() => {
                if (window.innerWidth < 768 && !rightSiderCollapsed) setRightSiderCollapsed(true);
              }}
            >
              {isEveWorkbenchActive && activeWorkbenchLayout === 'split-bottom' && (
                <div
                  className='eve-workbench-divider eve-workbench-divider--horizontal'
                  role='separator'
                  data-eve-interaction-role='resize-handle'
                  aria-orientation='horizontal'
                  aria-label={t('conversation.workbench.resizeSplit')}
                  aria-valuemin={36}
                  aria-valuemax={72}
                  aria-valuenow={Math.round(bottomPreviewRatio)}
                  tabIndex={0}
                  onPointerDown={handleBottomDividerPointerDown}
                  onKeyDown={handleBottomDividerKeyDown}
                  onDoubleClick={() => {
                    setBottomPreviewRatio(DEFAULT_BOTTOM_PREVIEW_RATIO);
                    try {
                      localStorage.setItem(BOTTOM_SPLIT_STORAGE_KEY, String(DEFAULT_BOTTOM_PREVIEW_RATIO));
                    } catch {
                      // The balanced default remains active for this session.
                    }
                  }}
                >
                  <span aria-hidden='true' />
                </div>
              )}
              {!layout?.isMobile && desktopHeader}
              <ArcoLayout.Content className='flex flex-col flex-1 overflow-hidden chat-layout-content'>
                {props.children}
              </ArcoLayout.Content>
            </div>
            {/* Preview panel - conditionally rendered */}
            {(isPreviewOpen || keepPreviewMounted) && (
              <div
                className={classNames(
                  'preview-panel flex flex-col relative',
                  COMMAND_EVE_SHELL_ENABLED ? 'eve-workbench-pane' : 'overflow-visible rounded-[15px]',
                  !COMMAND_EVE_SHELL_ENABLED && (isDesktop ? 'mb-[12px] mr-[12px] ml-[8px]' : 'm-[8px]')
                )}
                style={{
                  flexGrow: 1,
                  flexShrink: isEveWorkbenchActive && activeWorkbenchLayout === 'split-bottom' ? 0 : 1,
                  flexBasis: previewPaneFlexBasis,
                  display: isPreviewOpen ? 'flex' : 'none',
                  border: COMMAND_EVE_SHELL_ENABLED ? 'none' : '1px solid var(--bg-3)',
                  minWidth: isDesktop ? '260px' : 0,
                  maxWidth: isMobile && !COMMAND_EVE_SHELL_ENABLED ? 'calc(100% - 16px)' : undefined,
                  width: isMobile && !COMMAND_EVE_SHELL_ENABLED ? 'calc(100% - 16px)' : undefined,
                  boxSizing: 'border-box',
                  order: isEveWorkbenchActive && activeWorkbenchLayout === 'split-right' ? 2 : 1,
                }}
              >
                {isDesktop &&
                  !COMMAND_EVE_SHELL_ENABLED &&
                  createPreviewDragHandle({
                    className: 'absolute top-0 bottom-0 z-30',
                    style: { width: '20px', left: '-20px' },
                    linePlacement: 'end',
                    lineClassName: 'opacity-30 group-hover:opacity-100 group-active:opacity-100',
                    lineStyle: { width: '2px' },
                  })}
                {isEveWorkbenchActive &&
                  activeWorkbenchLayout === 'split-right' &&
                  createPreviewDragHandle({
                    className: 'eve-workbench-divider eve-workbench-divider--split-right',
                    style: { left: '-6px', width: '12px' },
                    linePlacement: 'end',
                    lineClassName: 'eve-workbench-divider__line',
                    lineStyle: { width: '1px' },
                    ariaLabel: t('conversation.workbench.resizeSplit'),
                  })}
                {COMMAND_EVE_SHELL_ENABLED && conversation_id && (
                  <div className='eve-workbench-pane__tabbar'>
                    <ShellWorkbenchTabs
                      conversationId={conversation_id}
                      workspacePath={workspacePath}
                      workspaceEventPrefix={workspaceEventPrefix}
                      isTemporaryWorkspace={isTemporaryWorkspace}
                    />
                  </div>
                )}
                <div
                  id={
                    COMMAND_EVE_SHELL_ENABLED && conversation_id ? `eve-workbench-pane-${conversation_id}` : undefined
                  }
                  className={classNames(
                    'flex flex-1 min-h-0 w-full overflow-hidden eve-workbench-pane__surface',
                    !COMMAND_EVE_SHELL_ENABLED && 'rounded-[15px]'
                  )}
                  role={COMMAND_EVE_SHELL_ENABLED ? 'tabpanel' : undefined}
                  aria-labelledby={
                    COMMAND_EVE_SHELL_ENABLED && isPreviewOpen && previewTabs.some((tab) => tab.id === activeTabId)
                      ? `eve-workbench-tab-${activeTabId}`
                      : undefined
                  }
                  aria-hidden={COMMAND_EVE_SHELL_ENABLED ? !isPreviewOpen : undefined}
                  tabIndex={COMMAND_EVE_SHELL_ENABLED ? -1 : undefined}
                >
                  <PreviewPanel />
                </div>
              </div>
            )}
          </div>
        </div>
        {desktopPanelEnabled && !layout?.isMobile && (
          <div
            className={classNames(
              'relative chat-layout-right-sider layout-sider',
              elementsRailEnabled && 'chat-layout-right-sider--elements'
            )}
            style={{
              flexGrow: 0,
              flexShrink: 0,
              flexBasis: rightSiderCollapsed ? '0px' : `${Math.round(workspaceWidthPx)}px`,
              width: rightSiderCollapsed ? '0px' : `${Math.round(workspaceWidthPx)}px`,
              minWidth: rightSiderCollapsed ? '0px' : `${MIN_WORKSPACE_PANEL_PX}px`,
              overflow: 'hidden',
              borderLeft: rightSiderCollapsed ? 'none' : '1px solid var(--bg-3)',
            }}
          >
            {isDesktop &&
              !elementsRailEnabled &&
              !rightSiderCollapsed &&
              createWorkspaceDragHandle({ className: 'absolute left-0 top-0 bottom-0', style: {}, reverse: true })}
            {elementsRailEnabled ? (
              <ShellElementsRail
                conversationId={conversation_id}
                conversationTitle={props.title}
                workspacePath={workspacePath}
                contextContent={isWorkspaceWorkbenchSurface ? undefined : props.sider}
                onRequestClose={() => setRightSiderCollapsed(true)}
                activeTab={elementsRailTab}
                onTabChange={setElementsRailTab}
              />
            ) : (
              <>
                <WorkspacePanelHeader
                  showToggle={!isMacRuntime && !isWindowsRuntime}
                  collapsed={rightSiderCollapsed}
                  onToggle={() => dispatchWorkspaceToggleEvent()}
                  togglePlacement={layout?.isMobile ? 'left' : 'right'}
                  workspacePath={workspacePath}
                  isTemporaryWorkspace={isTemporaryWorkspace}
                >
                  {props.siderTitle}
                </WorkspacePanelHeader>
                <ArcoLayout.Content style={{ height: `calc(100% - ${WORKSPACE_HEADER_HEIGHT}px)` }}>
                  {props.sider}
                </ArcoLayout.Content>
              </>
            )}
          </div>
        )}

        {/* Mobile workspace overlay: backdrop + fixed panel + floating collapse handle */}
        {workspaceEnabled && layout?.isMobile && (
          <MobileWorkspaceOverlay
            rightSiderCollapsed={rightSiderCollapsed}
            setRightSiderCollapsed={setRightSiderCollapsed}
            workspaceWidthPx={workspaceWidthPx}
            mobileWorkspaceHandleRight={mobileWorkspaceHandleRight}
            siderTitle={props.siderTitle}
            sider={props.sider}
            workspacePath={workspacePath}
            isTemporaryWorkspace={isTemporaryWorkspace}
          />
        )}

        {/* Desktop expand button when workspace is collapsed */}
        {!COMMAND_EVE_SHELL_ENABLED &&
          !isMacRuntime &&
          !isWindowsRuntime &&
          workspaceEnabled &&
          rightSiderCollapsed &&
          !layout?.isMobile && <DesktopWorkspaceToggle />}
      </div>
    </ArcoLayout>
  );
};

export default ChatLayout;
