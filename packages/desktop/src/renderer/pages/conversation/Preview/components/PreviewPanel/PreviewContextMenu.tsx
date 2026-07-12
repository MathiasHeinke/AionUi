/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewTab } from './PreviewTabs';

/**
 * 上下文菜单状态
 * Context menu state
 */
export interface ContextMenuState {
  /**
   * 是否显示菜单
   * Whether to show menu
   */
  show: boolean;

  /**
   * 菜单 X 坐标
   * Menu X coordinate
   */
  x: number;

  /**
   * 菜单 Y 坐标
   * Menu Y coordinate
   */
  y: number;

  /**
   * 关联的 Tab ID
   * Associated tab ID
   */
  tabId: string | null;
}

/**
 * PreviewContextMenu 组件属性
 * PreviewContextMenu component props
 */
interface PreviewContextMenuProps {
  /**
   * 上下文菜单状态
   * Context menu state
   */
  contextMenu: ContextMenuState;

  /**
   * Tabs 列表
   * Tabs list
   */
  tabs: PreviewTab[];

  /**
   * 当前主题
   * Current theme
   */
  currentTheme: 'light' | 'dark';

  /**
   * 关闭菜单回调
   * Close menu callback
   */
  onClose: () => void;

  /**
   * 关闭左侧 Tabs
   * Close tabs to the left
   */
  onCloseLeft: (tabId: string) => void;

  /**
   * 关闭右侧 Tabs
   * Close tabs to the right
   */
  onCloseRight: (tabId: string) => void;

  /**
   * 关闭其他 Tabs
   * Close other tabs
   */
  onCloseOthers: (tabId: string) => void;

  /**
   * 关闭所有 Tabs
   * Close all tabs
   */
  onCloseAll: () => void;
}

/**
 * 预览面板右键菜单组件
 * Preview panel context menu component
 *
 * 提供关闭左侧/右侧/其他/所有 Tab 的功能
 * Provides functions to close left/right/other/all tabs
 */
const PreviewContextMenu: React.FC<PreviewContextMenuProps> = ({
  contextMenu,
  tabs,
  onClose,
  onCloseLeft,
  onCloseRight,
  onCloseOthers,
  onCloseAll,
}) => {
  const { t } = useTranslation();
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭上下文菜单 / Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!contextMenu.show) return;
      // 如果点击的是菜单内部，不关闭 / Don't close if clicking inside menu
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) {
        return;
      }
      onClose();
    };

    // 使用 mousedown 而不是 click,避免与右键菜单的 onClick 冲突
    // Use mousedown instead of click to avoid conflicts with context menu onClick
    document.addEventListener('mousedown', handleClickOutside, { passive: true });

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [contextMenu.show, onClose]);

  if (!contextMenu.show || !contextMenu.tabId) {
    return null;
  }

  const currentIndex = tabs.findIndex((tab) => tab.id === contextMenu.tabId);
  const hasLeftTabs = currentIndex > 0;
  const hasRightTabs = currentIndex >= 0 && currentIndex < tabs.length - 1;
  const hasOtherTabs = tabs.length > 1;

  return (
    <div
      ref={contextMenuRef}
      className='preview-toolbar__menu fixed z-9999'
      role='menu'
      style={{
        left: `${contextMenu.x}px`,
        top: `${contextMenu.y}px`,
        minWidth: '140px',
      }}
    >
      {/* 关闭左侧 / Close tabs to the left */}
      <button
        type='button'
        role='menuitem'
        className='preview-toolbar__menu-item'
        disabled={!hasLeftTabs}
        onClick={() => onCloseLeft(contextMenu.tabId!)}
      >
        {t('preview.closeLeft')}
      </button>

      {/* 关闭右侧 / Close tabs to the right */}
      <button
        type='button'
        role='menuitem'
        className='preview-toolbar__menu-item'
        disabled={!hasRightTabs}
        onClick={() => onCloseRight(contextMenu.tabId!)}
      >
        {t('preview.closeRight')}
      </button>

      {/* 关闭其他 / Close other tabs */}
      <button
        type='button'
        role='menuitem'
        className='preview-toolbar__menu-item'
        disabled={!hasOtherTabs}
        onClick={() => onCloseOthers(contextMenu.tabId!)}
      >
        {t('preview.closeOthers')}
      </button>

      {/* 分隔线 / Divider */}
      <div className='h-1px bg-border-1 my-4px mx-8px' />

      {/* 全部关闭 / Close all tabs */}
      <button type='button' role='menuitem' className='preview-toolbar__menu-item' onClick={onCloseAll}>
        {t('preview.closeAll')}
      </button>
    </div>
  );
};

export default PreviewContextMenu;
