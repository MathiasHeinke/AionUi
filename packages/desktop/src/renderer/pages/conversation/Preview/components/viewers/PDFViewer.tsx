/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { buildPdfSrc } from '../../previewUrls';
import { usePreviewToolbarExtras } from '../../context/PreviewToolbarExtrasContext';
import { Button, Message } from '@arco-design/web-react';
import { Caution, FilePdf, Open } from '@renderer/components/icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface PDFPreviewProps {
  /**
   * PDF file path (absolute path on disk)
   * PDF 文件路径（磁盘上的绝对路径）
   */
  file_path?: string;
  /**
   * PDF content as base64 or blob URL
   * PDF 内容（base64 或 blob URL）
   */
  content?: string;
  hideToolbar?: boolean;
}

const PDFPreview: React.FC<PDFPreviewProps> = ({ file_path, content, hideToolbar = false }) => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const hasSource = Boolean(file_path || content);
  const [loading, setLoading] = useState(hasSource);
  const [messageApi, messageContextHolder] = Message.useMessage();
  const toolbarExtrasContext = usePreviewToolbarExtras();
  const usePortalToolbar = Boolean(toolbarExtrasContext) && !hideToolbar;

  const handleOpenInSystem = useCallback(async () => {
    if (!file_path) {
      messageApi.error(t('preview.errors.openWithoutPath'));
      return;
    }

    try {
      await ipcBridge.shell.openFile.invoke(file_path);
      messageApi.success(t('preview.openInSystemSuccess'));
    } catch {
      messageApi.error(t('preview.openInSystemFailed'));
    }
  }, [file_path, messageApi, t]);

  useEffect(() => {
    setLoading(hasSource);
    if (!hasSource) {
      setError(t('preview.pdf.pathMissing'));
      return;
    }
    setError(null);
  }, [file_path, content, hasSource, t]);

  // 设置工具栏扩展（必须在所有条件返回之前调用）
  // Set toolbar extras (must be called before any conditional returns)
  useEffect(() => {
    if (!usePortalToolbar || !toolbarExtrasContext || loading || error) return;
    toolbarExtrasContext.setExtras({
      left: (
        <div className='flex items-center gap-8px'>
          <span className='inline-flex items-center gap-6px text-13px text-t-secondary'>
            <FilePdf theme='outline' size={15} fill='currentColor' aria-hidden='true' />
            {t('preview.pdf.title')}
          </span>
          <span className='text-11px text-t-tertiary'>{t('preview.readOnlyLabel')}</span>
        </div>
      ),
      right: null,
    });
    return () => toolbarExtrasContext.setExtras(null);
  }, [usePortalToolbar, toolbarExtrasContext, t, loading, error]);

  // Chrome's PDF viewer renders data and file URLs reliably in an iframe.
  // Electron webviews can report a successful load while remaining blank.
  const pdfSrc = buildPdfSrc(file_path, content);

  if (error) {
    return (
      <div className='flex items-center justify-center h-full'>
        {messageContextHolder}
        <div className='text-center'>
          <div className='mb-8px inline-flex items-center justify-center gap-7px text-16px text-t-error'>
            <Caution theme='outline' size={18} fill='currentColor' aria-hidden='true' />
            <span>{error}</span>
          </div>
          <div className='text-12px text-t-secondary'>{t('preview.pdf.unableDisplay')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className='h-full w-full bg-bg-1 flex flex-col'>
      {messageContextHolder}
      {!usePortalToolbar && !hideToolbar && (
        <div className='flex items-center justify-between h-40px px-12px bg-bg-2 flex-shrink-0'>
          <div className='flex items-center gap-8px'>
            <span className='inline-flex items-center gap-6px text-13px text-t-secondary'>
              <FilePdf theme='outline' size={15} fill='currentColor' aria-hidden='true' />
              <span>{t('preview.pdf.title')}</span>
            </span>
            <span className='text-11px text-t-tertiary'>{t('preview.readOnlyLabel')}</span>
          </div>
          {file_path && (
            <Button size='mini' type='text' onClick={handleOpenInSystem} title={t('preview.openInSystemApp')}>
              <Open theme='outline' size={14} fill='currentColor' aria-hidden='true' />
              <span>{t('preview.openInSystemApp')}</span>
            </Button>
          )}
        </div>
      )}
      {/* PDF 内容区域 / PDF content area */}
      <div className='relative flex-1 overflow-hidden bg-bg-1'>
        <iframe
          key={pdfSrc}
          src={pdfSrc}
          title={t('preview.pdf.title')}
          className='w-full h-full'
          style={{ border: 0 }}
          onLoad={() => setLoading(false)}
          onError={() => {
            setError(t('preview.pdf.loadFailed'));
            setLoading(false);
          }}
        />
        {loading && (
          <div className='absolute inset-0 flex items-center justify-center bg-bg-1'>
            <div className='text-14px text-t-secondary'>{t('preview.loading')}</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PDFPreview;
