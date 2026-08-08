/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { Browser, CloseSmall, Code, FileText, ImageFiles, Plus, Terminal } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ShellWorkbenchTabs.module.css';
import WorkbenchLayoutControls from './WorkbenchLayoutControls';

type ShellWorkbenchTabsProps = {
  conversationId: string;
  launcherOnly?: boolean;
};

type WorkbenchTarget = 'browser' | 'terminal';

const iconForTab = (tab: PreviewTab) => {
  switch (tab.content_type) {
    case 'url':
      return <Browser theme='outline' size={16} fill='currentColor' />;
    case 'image':
      return <ImageFiles theme='outline' size={16} fill='currentColor' />;
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

const ShellWorkbenchTabs: React.FC<ShellWorkbenchTabsProps> = ({ conversationId, launcherOnly = false }) => {
  const { t } = useTranslation();
  const { isOpen, tabs, activeTabId, openPreview, showPreview, hidePreview, requestCloseTab, setWorkbenchLayoutMode } =
    usePreviewContext();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const launcherButtonRef = useRef<HTMLButtonElement | null>(null);
  const launcherMenuRef = useRef<HTMLDivElement | null>(null);
  const tablistRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (launcherOnly || !isOpen || !activeTabId) return;
    if (!conversationTabs.some((tab) => tab.id === activeTabId)) hidePreview();
  }, [activeTabId, conversationTabs, hidePreview, isOpen, launcherOnly]);

  const activateTarget = useCallback(
    (target: WorkbenchTarget) => {
      setLauncherOpen(false);
      switch (target) {
        case 'browser': {
          setWorkbenchLayoutMode('split-right');
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
        case 'terminal':
          return;
      }
    },
    [conversationId, conversationTabs, focusPane, openPreview, previewPaneId, setWorkbenchLayoutMode, showPreviewTab]
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
      icon: <Browser theme='outline' size={18} fill='currentColor' />,
    },
    {
      target: 'terminal',
      label: t('conversation.workbench.terminal'),
      detail: t('conversation.workbench.notConnected'),
      icon: <Terminal theme='outline' size={18} fill='currentColor' />,
      disabled: true,
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
                  tabIndex={selected ? 0 : -1}
                  className={styles.tabButton}
                  onClick={() => showPreviewTab(tab.id)}
                  onKeyDown={focusSiblingTab}
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
            aria-label={t('conversation.workbench.openLauncher')}
            onKeyDown={handleMenuKeyDown}
          >
            {launcherItems.map((item) => (
              <button
                key={item.target}
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
            ))}
          </div>
        )}
      </div>

      {!launcherOnly && isOpen && visibleActiveTab && visibleActiveTab.content_type !== 'url' && (
        <WorkbenchLayoutControls />
      )}
    </div>
  );
};

export default ShellWorkbenchTabs;
