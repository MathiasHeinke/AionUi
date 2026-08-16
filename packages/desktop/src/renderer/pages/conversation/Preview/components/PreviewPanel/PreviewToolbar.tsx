/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PreviewHistoryTarget } from '@/common/types/office/preview';
import { Dropdown, Tooltip } from '@arco-design/web-react';
import { Camera, Close, Download, FileText, History, Inspection, Open, Split } from '@renderer/components/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { shouldShowDownload } from './previewToolbarUtils';

/**
 * 暂时隐藏快照/历史入口（保留底层逻辑，日后翻 true 即恢复）
 * Temporarily hide the snapshot/history entry (underlying logic is kept;
 * flip to true to restore the UI).
 */
const SHOW_SNAPSHOT_HISTORY = false;

/**
 * PreviewToolbar 组件属性
 * PreviewToolbar component props
 */
interface PreviewToolbarProps {
  /**
   * 内容类型
   * Content type
   */
  content_type: string;

  /**
   * 是否为 Markdown 文件
   * Whether it's a Markdown file
   */
  isMarkdown: boolean;

  /**
   * 是否为 HTML 文件
   * Whether it's an HTML file
   */
  isHTML: boolean;

  /**
   * 当前视图模式
   * Current view mode
   */
  viewMode: 'source' | 'preview';

  /**
   * 是否启用分屏模式
   * Whether split-screen mode is enabled
   */
  isSplitScreenEnabled: boolean;

  /**
   * 文件名
   * Filename
   */
  file_name?: string;

  /**
   * 是否显示"在系统中打开"按钮
   * Whether to show "Open in System" button
   */
  showOpenInSystemButton: boolean;

  /**
   * 历史目标
   * History target
   */
  historyTarget: PreviewHistoryTarget | null;

  /**
   * 是否正在保存快照
   * Whether snapshot is saving
   */
  snapshotSaving: boolean;

  /**
   * 设置视图模式
   * Set view mode
   */
  onViewModeChange: (mode: 'source' | 'preview') => void;

  /**
   * 设置分屏模式
   * Set split-screen mode
   */
  onSplitScreenToggle: () => void;

  /**
   * 保存快照
   * Save snapshot
   */
  onSaveSnapshot: () => void;

  /**
   * 刷新历史列表
   * Refresh history list
   */
  onRefreshHistory: () => void;

  /**
   * 渲染历史下拉菜单
   * Render history dropdown
   */
  renderHistoryDropdown: () => React.ReactNode;

  /**
   * 在系统中打开文件
   * Open file in system
   */
  onOpenInSystem: () => void;

  /**
   * 下载文件
   * Download file
   */
  onDownload: () => void;

  /**
   * 导出报告（PDF / Word / Markdown，带运营商品牌，限定当前 seat）
   * Export the report as a branded client deliverable (PDF / Word / Markdown),
   * fenced to the active seat. Absent ⇒ the Export entry is hidden.
   */
  onExport?: (format: 'pdf' | 'docx' | 'md') => void;

  /**
   * 关闭预览面板
   * Close preview panel
   */
  onClose: () => void;

  /**
   * HTML 审核元素模式（仅HTML类型使用）
   * HTML inspect mode (only for HTML type)
   */
  inspectMode?: boolean;

  /**
   * 切换HTML审核元素模式（仅HTML类型使用）
   * Toggle HTML inspect mode (only for HTML type)
   */
  onInspectModeToggle?: () => void;

  /**
   * 左侧额外渲染内容
   * Extra content rendered on the left section
   */
  leftExtra?: React.ReactNode;

  /**
   * 右侧额外渲染内容
   * Extra content rendered on the right section
   */
  rightExtra?: React.ReactNode;
}

type ToolbarIconButtonProps = {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
};

const renderIconButton = ({ label, icon, onClick, active = false, disabled = false }: ToolbarIconButtonProps) => (
  <Tooltip content={label} position='bottom' trigger={['hover', 'focus']}>
    <button
      type='button'
      className={`preview-toolbar__icon-button${active ? ' preview-toolbar__icon-button--active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active || undefined}
    >
      {icon}
    </button>
  </Tooltip>
);

/**
 * 预览面板工具栏组件
 * Preview panel toolbar component
 *
 * 包含文件名、视图模式切换、快照/历史按钮、下载按钮、关闭按钮等
 * Contains filename, view mode toggle, snapshot/history buttons, download button, close button, etc.
 */
// eslint-disable-next-line max-len
const PreviewToolbar: React.FC<PreviewToolbarProps> = ({
  content_type,
  isMarkdown,
  isHTML,
  viewMode,
  isSplitScreenEnabled,
  file_name,
  showOpenInSystemButton,
  historyTarget,
  snapshotSaving,
  onViewModeChange,
  onSplitScreenToggle,
  onSaveSnapshot,
  onRefreshHistory,
  renderHistoryDropdown,
  onOpenInSystem,
  onDownload,
  onExport,
  onClose,
  inspectMode,
  onInspectModeToggle,
  leftExtra,
  rightExtra,
}) => {
  const { t } = useTranslation();
  const isDiff = content_type === 'diff';
  const preferActionButtonsInFront = Boolean(leftExtra);
  // showOpenInSystemButton === Boolean(metadata.file_path) upstream — i.e. "file is on disk".
  const showDownload = shouldShowDownload(content_type, showOpenInSystemButton);

  // The branded report Export entry (RPT-1) only makes sense for text reports
  // (markdown / html) and only when the panel supplied an export handler.
  const showExport = Boolean(onExport) && (isMarkdown || isHTML);

  // Reusable Export dropdown (PDF / Word / Markdown). Each item is fenced to the
  // active seat in the main process before any byte is produced.
  const renderExportDropdown = (): React.ReactNode => (
    <div className='preview-toolbar__menu' role='menu'>
      {[
        { fmt: 'pdf' as const, label: t('preview.export.pdf', { defaultValue: 'PDF' }) },
        { fmt: 'docx' as const, label: t('preview.export.word', { defaultValue: 'Word' }) },
        { fmt: 'md' as const, label: t('preview.export.markdown', { defaultValue: 'Markdown' }) },
      ].map(({ fmt, label }) => (
        <button
          type='button'
          role='menuitem'
          key={fmt}
          className='preview-toolbar__menu-item'
          onClick={() => {
            try {
              onExport?.(fmt);
            } catch {
              /* ignore */
            }
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const exportEntry = showExport ? (
    <Dropdown droplist={renderExportDropdown()} trigger={['click']} position='br'>
      <button
        type='button'
        className='preview-toolbar__icon-button'
        title={t('preview.export.title', { defaultValue: 'Export report' })}
        aria-label={t('preview.export.title', { defaultValue: 'Export report' })}
        aria-haspopup='menu'
      >
        <FileText size={16} aria-hidden='true' />
      </button>
    </Dropdown>
  ) : null;

  const openInSystemEntry = showOpenInSystemButton
    ? renderIconButton({
        label: t('preview.openInSystemApp'),
        icon: <Open size={16} aria-hidden='true' />,
        onClick: onOpenInSystem,
      })
    : null;
  const downloadEntry = showDownload
    ? renderIconButton({
        label: t('preview.downloadFile'),
        icon: <Download size={16} aria-hidden='true' />,
        onClick: () => void onDownload(),
      })
    : null;

  return (
    <div className='preview-toolbar'>
      <div className='flex items-center justify-between gap-8px w-full' style={{ minWidth: 'max-content' }}>
        {/* 左侧：Tabs（Markdown/HTML）+ 文件名 / Left: Tabs (Markdown/HTML) + Filename */}
        <div className='flex items-center h-full gap-8px'>
          {(isMarkdown || isHTML || isDiff) && (
            <>
              <div className='preview-toolbar__modes' role='tablist'>
                <button
                  type='button'
                  role='tab'
                  aria-selected={viewMode === 'source'}
                  className={`preview-toolbar__mode${viewMode === 'source' ? ' preview-toolbar__mode--active' : ''}`}
                  onClick={() => {
                    try {
                      onViewModeChange('source');
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  {isHTML ? t('preview.code') : t('preview.source')}
                </button>
                <button
                  type='button'
                  role='tab'
                  aria-selected={viewMode === 'preview'}
                  className={`preview-toolbar__mode${viewMode === 'preview' ? ' preview-toolbar__mode--active' : ''}`}
                  onClick={() => {
                    try {
                      onViewModeChange('preview');
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  {t('preview.preview')}
                </button>
              </div>
              {!isDiff &&
                renderIconButton({
                  label: isSplitScreenEnabled ? t('preview.closeSplitScreen') : t('preview.openSplitScreen'),
                  icon: <Split size={16} aria-hidden='true' />,
                  active: isSplitScreenEnabled,
                  onClick: () => {
                    try {
                      onSplitScreenToggle();
                    } catch {
                      /* ignore */
                    }
                  },
                })}
            </>
          )}

          {file_name && <span className='preview-toolbar__filename'>{file_name}</span>}
          {preferActionButtonsInFront && openInSystemEntry}
          {preferActionButtonsInFront && downloadEntry}
          {preferActionButtonsInFront && exportEntry}
          {leftExtra}
        </div>

        <div className='flex items-center gap-4px flex-shrink-0'>
          {rightExtra}

          {SHOW_SNAPSHOT_HISTORY &&
            ((content_type === 'markdown' && (viewMode === 'source' || isSplitScreenEnabled)) ||
              (content_type === 'html' && (viewMode === 'source' || isSplitScreenEnabled))) && (
              <>
                {renderIconButton({
                  label: historyTarget ? t('preview.saveSnapshot') : t('preview.snapshotNotSupported'),
                  icon: <Camera size={16} aria-hidden='true' />,
                  onClick: historyTarget && !snapshotSaving ? onSaveSnapshot : undefined,
                  disabled: !historyTarget || snapshotSaving,
                })}
                {historyTarget ? (
                  <Dropdown
                    droplist={renderHistoryDropdown()}
                    trigger={['hover']}
                    position='br'
                    onVisibleChange={(visible) => visible && onRefreshHistory()}
                  >
                    <button
                      type='button'
                      className='preview-toolbar__icon-button'
                      aria-label={t('preview.historyVersions')}
                    >
                      <History size={16} aria-hidden='true' />
                    </button>
                  </Dropdown>
                ) : (
                  renderIconButton({
                    label: t('preview.historyNotSupported'),
                    icon: <History size={16} aria-hidden='true' />,
                    disabled: true,
                  })
                )}
              </>
            )}

          {!preferActionButtonsInFront && openInSystemEntry}

          {!preferActionButtonsInFront && downloadEntry}

          {!preferActionButtonsInFront && exportEntry}

          {isHTML &&
            onInspectModeToggle &&
            renderIconButton({
              label: inspectMode ? t('preview.html.inspectElementDisable') : t('preview.html.inspectElementEnable'),
              icon: <Inspection size={16} aria-hidden='true' />,
              active: inspectMode,
              onClick: onInspectModeToggle,
            })}

          {renderIconButton({
            label: t('common.close'),
            icon: <Close size={16} aria-hidden='true' />,
            onClick: onClose,
          })}
        </div>
      </div>
    </div>
  );
};

export default PreviewToolbar;
