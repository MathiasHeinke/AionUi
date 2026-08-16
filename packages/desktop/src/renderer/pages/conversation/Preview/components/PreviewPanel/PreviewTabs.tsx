/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Close, OffScreen } from '@renderer/components/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TabFadeState } from '../../hooks/useTabOverflow';

/**
 * Tab 信息
 * Tab information
 */
export interface PreviewTab {
  /**
   * Tab ID
   */
  id: string;

  /**
   * Tab 标题
   * Tab title
   */
  title: string;

  /**
   * 是否有未保存的修改
   * Whether there are unsaved changes
   */
  isDirty?: boolean;
}

/**
 * PreviewTabs 组件属性
 * PreviewTabs component props
 */
interface PreviewTabsProps {
  /**
   * Tabs 列表
   * Tabs list
   */
  tabs: PreviewTab[];

  /**
   * 当前活动的 Tab ID
   * Current active tab ID
   */
  activeTabId: string | null;

  /**
   * Tab 渐变状态（左右溢出指示器）
   * Tab fade state (left/right overflow indicators)
   */
  tabFadeState: TabFadeState;

  /**
   * Tabs 容器引用
   * Tabs container ref
   */
  tabsContainerRef: React.RefObject<HTMLDivElement | null>;

  /**
   * 切换 Tab 回调
   * Switch tab callback
   */
  onSwitchTab: (tabId: string) => void;

  /**
   * 关闭 Tab 回调
   * Close tab callback
   */
  onCloseTab: (tabId: string) => void;

  /**
   * Tab 右键菜单回调
   * Tab context menu callback
   */
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;

  /**
   * 关闭预览面板回调
   * Close preview panel callback
   */
  onClosePanel?: () => void;
}

/**
 * 预览面板 Tabs 栏组件
 * Preview panel tabs bar component
 *
 * 显示多个 Tab，支持切换、关闭和右键菜单
 * Displays multiple tabs, supports switching, closing, and context menu
 *
 * 包含左右渐变指示器，提示用户可以滚动查看更多 Tab
 * Includes left/right gradient indicators to prompt users that more tabs can be scrolled
 */
const PreviewTabs: React.FC<PreviewTabsProps> = ({
  tabs,
  activeTabId,
  tabFadeState,
  tabsContainerRef,
  onSwitchTab,
  onCloseTab,
  onContextMenu,
  onClosePanel,
}) => {
  const { t } = useTranslation();
  const { left: showLeftFade, right: showRightFade } = tabFadeState;

  return (
    <div className='preview-tabs'>
      <div className='flex items-center h-36px w-full'>
        {/* Tabs 滚动区域 / Tabs scroll area */}
        <div ref={tabsContainerRef} className='flex items-center h-full flex-1 overflow-x-auto' role='tablist'>
          {tabs.length > 0 ? (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={`preview-tab${tab.id === activeTabId ? ' preview-tab--active' : ''}`}
                onContextMenu={(e) => onContextMenu(e, tab.id)}
              >
                <button
                  type='button'
                  role='tab'
                  aria-selected={tab.id === activeTabId}
                  className='preview-tab__select'
                  onClick={() => onSwitchTab(tab.id)}
                >
                  <span className='preview-tab__label'>{tab.title}</span>
                  {tab.isDirty && (
                    <span className='preview-tab__dirty' title={t('preview.unsavedChangesTitle')} aria-hidden='true' />
                  )}
                </button>
                <button
                  type='button'
                  className='preview-tab__close'
                  aria-label={`${t('common.close')}: ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <Close theme='outline' size='14' aria-hidden='true' />
                </button>
              </div>
            ))
          ) : (
            <div className='text-12px text-t-tertiary px-10px'>{t('preview.noTabs')}</div>
          )}
        </div>

        {/* 收起面板按钮 / Collapse panel button */}
        {onClosePanel && (
          <div className='flex items-center h-full px-8px flex-shrink-0'>
            <button
              type='button'
              className='preview-toolbar__icon-button'
              onClick={onClosePanel}
              title={t('preview.collapsePanel')}
              aria-label={t('preview.collapsePanel')}
            >
              <OffScreen theme='outline' size={14} fill='currentColor' aria-hidden='true' />
            </button>
          </div>
        )}
      </div>

      {/* 左侧渐变指示器 / Left gradient indicator */}
      {showLeftFade && (
        <div
          className='pointer-events-none absolute left-0 top-0 bottom-0 w-32px rounded-tl-[16px]'
          style={{
            background: 'linear-gradient(90deg, var(--glass-chrome-bg-solid) 0%, transparent 100%)',
          }}
        />
      )}

      {/* 右侧渐变指示器 / Right gradient indicator */}
      {showRightFade && (
        <div
          className='pointer-events-none absolute right-0 top-0 bottom-0 w-32px rounded-tr-[16px]'
          style={{
            background: 'linear-gradient(270deg, var(--glass-chrome-bg-solid) 0%, transparent 100%)',
          }}
        />
      )}
    </div>
  );
};

export default PreviewTabs;
