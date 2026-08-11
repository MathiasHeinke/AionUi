/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import type { PreviewTab, WorkbenchLayoutMode } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { addEventListener } from '@/renderer/utils/emitter';
import {
  BottomBar,
  CheckOne,
  CloseSmall,
  Code,
  Earth,
  FileText,
  FolderOpen,
  ImageFiles,
  LeftBar,
  ListCheckbox,
  Music,
  Plus,
  RightBar,
  Robot,
  Terminal,
  Video,
} from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import styles from './ShellWorkbenchTabs.module.css';
import WorkbenchLayoutControls from './WorkbenchLayoutControls';

type ShellWorkbenchTabsProps = {
  conversationId: string;
  workspacePath?: string;
  workspaceEventPrefix?: 'acp' | 'codex' | 'aionrs';
  isTemporaryWorkspace?: boolean;
  launcherOnly?: boolean;
  /** Responsive mode actually rendered by ChatLayout (may stack below 680px). */
  effectiveLayoutMode?: WorkbenchLayoutMode;
};

type WorkbenchTarget = 'browser' | 'terminal' | 'kanban' | 'files' | 'review';
type DockTarget = Exclude<WorkbenchLayoutMode, 'focus'>;

type DockState = {
  target: DockTarget | null;
  bounds: { top: number; left: number; width: number; height: number };
};

const DOCK_OVERLAY_PADDING_PX = 14;
const DOCK_BOTTOM_MIN_PX = 92;
const DOCK_BOTTOM_FRACTION = 0.36;

const dockTargetForPoint = (bounds: DockState['bounds'], clientX: number, clientY: number): DockTarget | null => {
  if (
    clientX < bounds.left ||
    clientX > bounds.left + bounds.width ||
    clientY < bounds.top ||
    clientY > bounds.top + bounds.height
  ) {
    return null;
  }
  const innerHeight = Math.max(0, bounds.height - DOCK_OVERLAY_PADDING_PX * 2);
  const bottomHeight = Math.min(innerHeight, Math.max(DOCK_BOTTOM_MIN_PX, innerHeight * DOCK_BOTTOM_FRACTION));
  const bottomStart = bounds.top + bounds.height - DOCK_OVERLAY_PADDING_PX - bottomHeight;
  if (clientY >= bottomStart) return 'split-bottom';
  return clientX < bounds.left + bounds.width / 2 ? 'split-left' : 'split-right';
};

const iconForTab = (tab: PreviewTab) => {
  switch (tab.content_type) {
    case 'url':
      return <Earth theme='outline' size={16} fill='currentColor' />;
    case 'terminal':
      return <Terminal theme='outline' size={16} fill='currentColor' />;
    case 'kanban':
      return <ListCheckbox theme='outline' size={16} fill='currentColor' />;
    case 'durable-work':
      return <Robot theme='outline' size={16} fill='currentColor' />;
    case 'workspace-files':
      return <FolderOpen theme='outline' size={16} fill='currentColor' />;
    case 'workspace-review':
      return <CheckOne theme='outline' size={16} fill='currentColor' />;
    case 'image':
      return <ImageFiles theme='outline' size={16} fill='currentColor' />;
    case 'video':
      return <Video theme='outline' size={16} fill='currentColor' />;
    case 'audio':
      return <Music theme='outline' size={16} fill='currentColor' />;
    case 'code':
    case 'diff':
      return <Code theme='outline' size={16} fill='currentColor' />;
    default:
      return <FileText theme='outline' size={16} fill='currentColor' />;
  }
};

const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if (!buttons.length) return;
  const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
  event.preventDefault();
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (Math.max(0, currentIndex) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
};

const ShellWorkbenchTabs: React.FC<ShellWorkbenchTabsProps> = ({
  conversationId,
  workspacePath,
  workspaceEventPrefix = 'acp',
  isTemporaryWorkspace = false,
  launcherOnly = false,
  effectiveLayoutMode,
}) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const {
    isOpen,
    tabs,
    activeTabId,
    openPreview,
    showPreview,
    hidePreview,
    requestCloseTab,
    workbenchLayoutMode,
    setWorkbenchLayoutMode,
  } = usePreviewContext();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [dockState, setDockState] = useState<DockState | null>(null);
  const launcherButtonRef = useRef<HTMLButtonElement | null>(null);
  const launcherMenuRef = useRef<HTMLDivElement | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const dockCleanupRef = useRef<(() => void) | null>(null);

  const conversationTabs = useMemo(
    () => tabs.filter((tab) => tab.metadata?.conversation_id === conversationId),
    [conversationId, tabs]
  );
  const visibleActiveTab = conversationTabs.find((tab) => tab.id === activeTabId) ?? null;
  const previewPaneId = `eve-workbench-pane-${conversationId}`;

  const focusPane = useCallback((paneId: string) => {
    window.requestAnimationFrame(() => document.getElementById(paneId)?.focus({ preventScroll: true }));
  }, []);

  const showPreviewTab = useCallback(
    (tabId: string) => {
      showPreview(tabId);
      focusPane(previewPaneId);
    },
    [focusPane, previewPaneId, showPreview]
  );

  const beginTabDock = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, tabId: string) => {
      if (event.button !== 0) return;
      const source = event.currentTarget;
      const layoutSurface = source.closest<HTMLElement>('[data-eve-workbench-layout]');
      const rect = layoutSurface?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;

      dockCleanupRef.current?.();
      const startX = event.clientX;
      const startY = event.clientY;
      const bounds = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      const renderedLayout = effectiveLayoutMode ?? workbenchLayoutMode;
      let latestTarget: DockTarget | null = renderedLayout === 'focus' ? 'split-right' : renderedLayout;
      let dragging = false;
      let finished = false;
      const originalUserSelect = document.body.style.userSelect;
      const originalCursor = document.body.style.cursor;

      const cleanup = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        window.removeEventListener('blur', handleWindowBlur);
        if (dragging) {
          document.body.style.userSelect = originalUserSelect;
          document.body.style.cursor = originalCursor;
        }
        if (dockCleanupRef.current === cancelDock) dockCleanupRef.current = null;
      };

      const finishDock = (commit: boolean) => {
        if (finished) return;
        if (dragging && commit && latestTarget) setWorkbenchLayoutMode(latestTarget);
        setDockState(null);
        cleanup();
      };
      const cancelDock = () => finishDock(false);

      function handleMouseMove(moveEvent: MouseEvent) {
        if (finished) return;
        if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 6) return;
        moveEvent.preventDefault();
        if (!dragging) {
          dragging = true;
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'grabbing';
          showPreviewTab(tabId);
        }
        latestTarget = dockTargetForPoint(bounds, moveEvent.clientX, moveEvent.clientY);
        setDockState({ target: latestTarget, bounds });
      }

      function handleMouseUp() {
        finishDock(true);
      }
      function handleWindowBlur() {
        finishDock(false);
      }

      window.addEventListener('mousemove', handleMouseMove, { passive: false });
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('blur', handleWindowBlur);
      dockCleanupRef.current = cancelDock;
    },
    [effectiveLayoutMode, setWorkbenchLayoutMode, showPreviewTab, workbenchLayoutMode]
  );

  useEffect(
    () => () => {
      dockCleanupRef.current?.();
      dockCleanupRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (launcherOnly || !isOpen || !activeTabId) return;
    if (conversationTabs.some((tab) => tab.id === activeTabId)) return;

    // `openPreview` adds the new conversation-scoped tab and publishes its
    // active id in the following state effect. Hiding synchronously here races
    // that handoff when an older conversation still owns activeTabId: the new
    // Worker Detail becomes active but remains display:none. One animation
    // frame preserves the cross-conversation fence while giving the pending
    // active-tab commit a chance to cancel this stale hide.
    const frame = window.requestAnimationFrame(() => hidePreview());
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, conversationTabs, hidePreview, isOpen, launcherOnly]);

  const activateTarget = useCallback(
    (target: WorkbenchTarget) => {
      setLauncherOpen(false);
      switch (target) {
        case 'browser': {
          const existingBrowser = conversationTabs.find(
            (tab) => tab.content_type === 'url' && tab.metadata?.title === 'Browser'
          );
          if (existingBrowser) {
            showPreviewTab(existingBrowser.id);
            return;
          }
          openPreview('about:blank', 'url', { title: 'Browser', conversation_id: conversationId });
          focusPane(previewPaneId);
          return;
        }
        case 'terminal': {
          const existingTerminal = conversationTabs.find((tab) => tab.content_type === 'terminal');
          if (existingTerminal) {
            showPreviewTab(existingTerminal.id);
            return;
          }
          openPreview(`terminal:${conversationId}`, 'terminal', {
            title: t('conversation.workbench.terminal'),
            conversation_id: conversationId,
            workspace: workspacePath,
          });
          focusPane(previewPaneId);
          return;
        }
        case 'kanban': {
          const existingKanban = conversationTabs.find((tab) => tab.content_type === 'kanban');
          if (existingKanban) {
            showPreviewTab(existingKanban.id);
            return;
          }
          openPreview('kanban:default', 'kanban', {
            title: t('kanban.title', { defaultValue: 'Aufgaben' }),
            conversation_id: conversationId,
          });
          focusPane(previewPaneId);
          return;
        }
        case 'files': {
          const existingFiles = conversationTabs.find((tab) => tab.content_type === 'workspace-files');
          if (existingFiles) {
            showPreviewTab(existingFiles.id);
            return;
          }
          openPreview(workspacePath ?? 'workspace:unavailable', 'workspace-files', {
            title: t('conversation.workbench.files'),
            conversation_id: conversationId,
            ...(workspacePath ? { workspace: workspacePath } : {}),
            workspace_event_prefix: workspaceEventPrefix,
            is_temporary_workspace: isTemporaryWorkspace,
          });
          focusPane(previewPaneId);
          return;
        }
        case 'review': {
          const existingReview = conversationTabs.find((tab) => tab.content_type === 'workspace-review');
          if (existingReview) {
            showPreviewTab(existingReview.id);
            return;
          }
          openPreview(workspacePath ?? 'workspace:unavailable', 'workspace-review', {
            title: t('conversation.workbench.review'),
            conversation_id: conversationId,
            ...(workspacePath ? { workspace: workspacePath } : {}),
            workspace_event_prefix: workspaceEventPrefix,
            is_temporary_workspace: isTemporaryWorkspace,
          });
          focusPane(previewPaneId);
          return;
        }
      }
    },
    [
      conversationId,
      conversationTabs,
      focusPane,
      openPreview,
      previewPaneId,
      showPreviewTab,
      t,
      workspacePath,
      workspaceEventPrefix,
      isTemporaryWorkspace,
    ]
  );

  useEffect(
    () =>
      addEventListener('commandEve.workbench.reveal', ({ conversation_id, pane }) => {
        // The launcher-only header is the only workbench component mounted
        // before the first tab exists. It must therefore be able to create that
        // first tab; ignoring the event here made Hermes' first focus_pane call
        // report success while nothing appeared.
        if (conversation_id !== conversationId) return;
        if (pane === 'chat') {
          hidePreview();
          window.requestAnimationFrame(() => {
            document.getElementById(`eve-chat-pane-${conversationId}`)?.focus({ preventScroll: true });
          });
          return;
        }
        if (pane === 'sessions') {
          layout?.setSiderCollapsed(false);
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>('[data-command-eve-pane="sessions"]')?.focus({ preventScroll: true });
          });
          return;
        }
        activateTarget(pane);
      }),
    [activateTarget, conversationId, hidePreview, launcherOnly, layout]
  );

  useEffect(() => {
    if (!launcherOpen) return undefined;

    const closeOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (launcherMenuRef.current?.contains(target) || launcherButtonRef.current?.contains(target)) return;
      setLauncherOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setLauncherOpen(false);
      launcherButtonRef.current?.focus();
    };

    document.addEventListener('mousedown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    const frame = window.requestAnimationFrame(() => {
      launcherMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [launcherOpen]);

  const focusSiblingTab = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    if (!buttons.length) return;
    const currentIndex = buttons.indexOf(event.currentTarget);
    if (currentIndex < 0) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }, []);

  useEffect(() => {
    if (launcherOnly) return undefined;
    const cycleTabs = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab') return;
      const orderedIds = conversationTabs.map((tab) => tab.id);
      if (orderedIds.length < 2) return;
      const delta = event.shiftKey ? -1 : 1;
      const currentIndex = activeTabId ? orderedIds.indexOf(activeTabId) : -1;
      const nextIndex =
        currentIndex < 0
          ? event.shiftKey
            ? orderedIds.length - 1
            : 0
          : (currentIndex + delta + orderedIds.length) % orderedIds.length;
      const nextId = orderedIds[nextIndex];
      event.preventDefault();
      showPreviewTab(nextId);
    };
    document.addEventListener('keydown', cycleTabs);
    return () => document.removeEventListener('keydown', cycleTabs);
  }, [activeTabId, conversationTabs, launcherOnly, showPreviewTab]);

  const launcherItems: Array<{
    target: WorkbenchTarget;
    label: string;
    detail?: string;
    icon: React.ReactNode;
    disabled?: boolean;
  }> = [
    {
      target: 'browser',
      label: t('conversation.workbench.browser'),
      icon: <Earth theme='outline' size={16} fill='currentColor' />,
    },
    {
      target: 'terminal',
      label: t('conversation.workbench.terminal'),
      icon: <Terminal theme='outline' size={16} fill='currentColor' />,
    },
    {
      target: 'kanban',
      label: t('kanban.title', { defaultValue: 'Aufgaben' }),
      icon: <ListCheckbox theme='outline' size={16} fill='currentColor' />,
    },
    {
      target: 'files',
      label: t('conversation.workbench.files'),
      detail: workspacePath ? undefined : t('conversation.workbench.notConnected'),
      icon: <FolderOpen theme='outline' size={16} fill='currentColor' />,
      disabled: !workspacePath,
    },
    {
      target: 'review',
      label: t('conversation.workbench.review'),
      detail: workspacePath ? undefined : t('conversation.workbench.notConnected'),
      icon: <CheckOne theme='outline' size={16} fill='currentColor' />,
      disabled: !workspacePath,
    },
  ];

  return (
    <div
      className={styles.root}
      data-launcher-only={launcherOnly ? 'true' : undefined}
      data-testid='eve-workbench-tabs'
    >
      {!launcherOnly && conversationTabs.length > 0 && (
        <div ref={tablistRef} className={styles.tablist} role='tablist' aria-label={t('conversation.workbench.label')}>
          {conversationTabs.map((tab) => {
            const selected = isOpen && tab.id === activeTabId;
            const accessibleTitle = tab.isDirty
              ? t('conversation.workbench.unsavedTab', { title: tab.title })
              : tab.title;
            return (
              <div key={tab.id} className={styles.tabShell} data-selected={selected ? 'true' : 'false'}>
                <button
                  id={`eve-workbench-tab-${tab.id}`}
                  type='button'
                  role='tab'
                  aria-selected={selected}
                  aria-controls={previewPaneId}
                  aria-label={accessibleTitle}
                  title={accessibleTitle}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tabButton}
                  onClick={() => showPreviewTab(tab.id)}
                  onKeyDown={focusSiblingTab}
                  onMouseDown={(event) => beginTabDock(event, tab.id)}
                >
                  {iconForTab(tab)}
                  <span className={styles.tabLabel}>{tab.title}</span>
                  {tab.isDirty && <span className={styles.dirtyDot} aria-hidden='true' />}
                </button>
                <button
                  type='button'
                  className={styles.closeButton}
                  onClick={(event) => {
                    event.stopPropagation();
                    requestCloseTab(tab.id);
                  }}
                  aria-label={t('conversation.workbench.closeTab', { title: tab.title })}
                  title={t('conversation.workbench.closeTab', { title: tab.title })}
                >
                  <CloseSmall theme='outline' size={14} fill='currentColor' />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.launcher}>
        <button
          ref={launcherButtonRef}
          type='button'
          className={styles.launcherButton}
          aria-label={t('conversation.workbench.openLauncher')}
          aria-haspopup='menu'
          aria-expanded={launcherOpen}
          onClick={() => setLauncherOpen((open) => !open)}
        >
          <Plus theme='outline' size={18} fill='currentColor' />
        </button>
        {launcherOpen && (
          <div
            ref={launcherMenuRef}
            className={styles.launcherMenu}
            role='menu'
            data-eve-interaction-role='composite-control'
            aria-label={t('conversation.workbench.openLauncher')}
            onKeyDown={handleMenuKeyDown}
          >
            {launcherItems.map((item) => (
              <React.Fragment key={item.target}>
                {item.target === 'files' && <span className={styles.menuDivider} role='separator' />}
                <button
                  type='button'
                  role='menuitem'
                  className={styles.menuItem}
                  disabled={item.disabled}
                  onClick={() => activateTarget(item.target)}
                >
                  <span className={styles.menuIcon} aria-hidden='true'>
                    {item.icon}
                  </span>
                  <span className={styles.menuCopy}>
                    <span className={styles.menuLabel}>{item.label}</span>
                    {item.detail && <span className={styles.menuDetail}>{item.detail}</span>}
                  </span>
                </button>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      {!launcherOnly && isOpen && visibleActiveTab && <WorkbenchLayoutControls effectiveMode={effectiveLayoutMode} />}
      {dockState &&
        createPortal(
          <div
            className={styles.dockOverlay}
            style={dockState.bounds}
            aria-hidden='true'
            data-testid='eve-workbench-dock-overlay'
          >
            {(
              [
                {
                  target: 'split-left' as const,
                  label: t('conversation.workbench.splitLeft'),
                  icon: <LeftBar theme='outline' size={20} />,
                },
                {
                  target: 'split-right' as const,
                  label: t('conversation.workbench.splitRight'),
                  icon: <RightBar theme='outline' size={20} />,
                },
                {
                  target: 'split-bottom' as const,
                  label: t('conversation.workbench.splitBottom'),
                  icon: <BottomBar theme='outline' size={20} />,
                },
              ] satisfies Array<{ target: DockTarget; label: string; icon: React.ReactNode }>
            ).map((item) => (
              <div
                key={item.target}
                className={styles.dockZone}
                data-target={item.target}
                data-active={dockState.target === item.target ? 'true' : 'false'}
                data-testid={`eve-workbench-dock-${item.target}`}
              >
                {item.icon}
                <span>{item.label}</span>
              </div>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
};

export default ShellWorkbenchTabs;
