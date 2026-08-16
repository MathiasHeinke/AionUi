/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import AionModal from '@/renderer/components/base/AionModal';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { Button, Spin } from '@arco-design/web-react';
import { FileText, FolderOpen, Up } from '@renderer/components/icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBaseUrl } from '@/common/adapter/httpBridge';
import styles from './DirectorySelectionModal.module.css';

interface DirectoryItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile?: boolean;
}

interface DirectoryData {
  items: DirectoryItem[];
  canGoUp: boolean;
  parentPath?: string;
}

interface DirectorySelectionModalProps {
  visible: boolean;
  isFileMode?: boolean;
  onConfirm: (paths: string[] | undefined) => void;
  onCancel: () => void;
}

const DirectorySelectionModal: React.FC<DirectorySelectionModalProps> = ({
  visible,
  isFileMode = false,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [directoryData, setDirectoryData] = useState<DirectoryData>({ items: [], canGoUp: false });
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadDirectory = useCallback(
    async (dirPath = '') => {
      setLoading(true);
      setLoadError(null);
      try {
        const showFiles = isFileMode ? 'true' : 'false';
        const response = await fetch(
          `${getBaseUrl()}/api/fs/browse?path=${encodeURIComponent(dirPath)}&showFiles=${showFiles}`,
          {
            method: 'GET',
            credentials: 'include',
          }
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          setLoadError(errorData.error || `HTTP ${response.status}`);
          return;
        }
        const envelope = await response.json();
        // Backend wraps the payload in { success, data, ... }.
        const data = envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : envelope;
        if (!data || !Array.isArray(data.items)) {
          setLoadError('Invalid response from server');
          return;
        }
        setDirectoryData(data);
        setCurrentPath(dirPath);
      } catch (err) {
        console.error('Failed to load directory:', err);
        setLoadError(err instanceof Error ? err.message : 'Failed to load directory');
      } finally {
        setLoading(false);
      }
    },
    [isFileMode]
  );

  useEffect(() => {
    if (visible) {
      setSelectedPath('');
      loadDirectory('').catch((loadFailure) => console.error('Failed to load initial directory:', loadFailure));
    }
  }, [visible, loadDirectory]);

  const handleItemClick = (item: DirectoryItem) => {
    if (item.isDirectory) {
      loadDirectory(item.path).catch((loadFailure) => console.error('Failed to load directory:', loadFailure));
    }
  };

  const handleSelect = (path: string) => {
    setSelectedPath(path);
  };

  const handleGoUp = () => {
    if (directoryData.parentPath !== undefined) {
      // Handle '__ROOT__' as empty path to show drive list on Windows
      // 处理 '__ROOT__' 为空路径，在 Windows 上显示驱动器列表
      const targetPath = directoryData.parentPath === '__ROOT__' ? '' : directoryData.parentPath;
      loadDirectory(targetPath).catch((loadFailure) => console.error('Failed to load parent directory:', loadFailure));
    }
  };

  const handleConfirm = () => {
    if (selectedPath) {
      onConfirm([selectedPath]);
    }
  };

  const canSelect = (item: DirectoryItem) => {
    return isFileMode ? item.isFile : item.isDirectory;
  };

  return (
    <AionModal
      visible={visible}
      header={
        <span className='inline-flex items-center gap-8px'>
          {isFileMode ? (
            <FileText theme='outline' size={17} fill='currentColor' aria-hidden='true' />
          ) : (
            <FolderOpen theme='outline' size={17} fill='currentColor' aria-hidden='true' />
          )}
          <span>{isFileMode ? t('fileSelection.selectFile') : t('fileSelection.selectDirectory')}</span>
        </span>
      }
      onCancel={onCancel}
      onOk={handleConfirm}
      okButtonProps={{ disabled: !selectedPath }}
      className='directory-selection-modal'
      style={{ width: 'min(600px, 90vw)' }}
      wrapStyle={{ zIndex: 3000 }}
      maskStyle={{ zIndex: 2990 }}
      contentStyle={{ padding: '14px 20px 0', overflow: 'hidden' }}
      footer={
        <div className='w-full flex flex-wrap justify-between items-center gap-12px'>
          <div
            className='text-t-secondary text-14px overflow-hidden text-ellipsis whitespace-nowrap max-w-[70vw]'
            title={selectedPath || currentPath}
          >
            {selectedPath ||
              currentPath ||
              (isFileMode ? t('fileSelection.pleaseSelectFile') : t('fileSelection.pleaseSelectDirectory'))}
          </div>
          <div className='flex gap-10px'>
            <Button onClick={onCancel}>{t('common.cancel')}</Button>
            <Button type='primary' onClick={handleConfirm} disabled={!selectedPath}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      }
    >
      <Spin loading={loading} className='w-full'>
        <div className={`eve-menu-surface ${styles.browser}`} aria-busy={loading}>
          <AionScrollArea
            className={styles.scrollArea}
            role='listbox'
            aria-label={isFileMode ? t('fileSelection.pleaseSelectFile') : t('fileSelection.pleaseSelectDirectory')}
          >
            {directoryData.canGoUp && (
              <button
                type='button'
                role='option'
                aria-selected='false'
                className={`eve-menu-item ${styles.parentRow}`}
                onClick={handleGoUp}
              >
                <span className='eve-menu-icon'>
                  <Up theme='outline' size={16} fill='currentColor' />
                </span>
                <span>{t('common.historyBack')}</span>
              </button>
            )}
            {loadError && (
              <div className='p-16px text-center text-danger text-13px'>
                <div>{loadError}</div>
                <Button size='mini' className='mt-8px' onClick={() => loadDirectory(currentPath).catch(() => {})}>
                  {t('common.retry', { defaultValue: 'Retry' })}
                </Button>
              </div>
            )}
            {directoryData.items.map((item) => (
              <div
                key={item.path}
                role='presentation'
                className={`eve-menu-item ${styles.directoryRow}`}
                data-selected={selectedPath === item.path ? 'true' : 'false'}
              >
                <button
                  type='button'
                  role='option'
                  aria-selected={selectedPath === item.path}
                  className={styles.itemAction}
                  onClick={() => handleItemClick(item)}
                >
                  {item.isDirectory ? (
                    <span className='eve-menu-icon'>
                      <FolderOpen theme='outline' size={17} fill='currentColor' />
                    </span>
                  ) : (
                    <span className='eve-menu-icon'>
                      <FileText theme='outline' size={17} fill='currentColor' />
                    </span>
                  )}
                  <span className='overflow-hidden text-ellipsis whitespace-nowrap'>{item.name}</span>
                </button>
                {canSelect(item) && (
                  <Button
                    type='primary'
                    size='mini'
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(item.path);
                    }}
                  >
                    {t('common.select')}
                  </Button>
                )}
              </div>
            ))}
          </AionScrollArea>
        </div>
      </Spin>
    </AionModal>
  );
};

export default DirectorySelectionModal;
