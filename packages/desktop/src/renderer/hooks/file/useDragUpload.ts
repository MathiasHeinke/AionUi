/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Message } from '@arco-design/web-react';
import type { FileMetadata } from '@renderer/services/FileService';
import { isSupportedFile, FileService } from '@renderer/services/FileService';

export interface UseDragUploadOptions {
  supportedExts?: string[];
  onFilesAdded?: (files: FileMetadata[]) => void;
  /** Conversation ID for WebUI file uploads */
  conversation_id?: string;
}

type DragUploadEvent = {
  preventDefault: () => void;
  stopPropagation: () => void;
  dataTransfer?: DataTransfer | null;
  nativeEvent?: { dataTransfer?: DataTransfer | null };
};

const getDragDataTransfer = (event: DragUploadEvent): DataTransfer | null | undefined =>
  event.nativeEvent?.dataTransfer ?? event.dataTransfer;

/**
 * The upload target may cover the complete conversation column. Only claim a
 * drag when the platform says it contains files; text selections, links and
 * app-internal drags must retain their native behaviour.
 */
const isFileDrag = (event: DragUploadEvent): boolean => {
  const dataTransfer = getDragDataTransfer(event);
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes('Files') || dataTransfer.files.length > 0;
};

export const useDragUpload = ({ supportedExts = [], onFilesAdded, conversation_id }: UseDragUploadOptions) => {
  const { t } = useTranslation();
  const [isFileDragging, setIsFileDragging] = useState(false);

  // 拖拽计数器，防止状态闪烁
  const dragCounter = useRef(0);

  const handleDragOver = useCallback((e: DragUploadEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    // `dragover` fires continuously. Nesting belongs exclusively to the
    // paired enter/leave events or the counter can grow without a matching
    // leave and keep the overlay stuck on screen.
    setIsFileDragging(true);
  }, []);

  const handleDragEnter = useCallback((e: DragUploadEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    dragCounter.current += 1;
    setIsFileDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragUploadEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();

    dragCounter.current -= 1;

    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsFileDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: DragUploadEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();

      // 重置状态
      dragCounter.current = 0;
      setIsFileDragging(false);

      if (!onFilesAdded) return;

      try {
        const droppedFiles = getDragDataTransfer(e)?.files;
        if (!droppedFiles) return;

        // 第一步：先校验文件类型，筛选出支持的文件
        const validFiles: File[] = [];
        let unsupportedCount = 0;

        for (let i = 0; i < droppedFiles.length; i++) {
          const file = droppedFiles[i];
          if (supportedExts.length === 0 || isSupportedFile(file.name, supportedExts)) {
            validFiles.push(file);
          } else {
            unsupportedCount += 1;
          }
        }

        if (unsupportedCount > 0) {
          Message.warning(
            t('common.fileAttach.unsupported', {
              count: unsupportedCount,
              defaultValue: '{{count}} file(s) not supported',
            })
          );
        }

        // 第二步：只处理校验通过的文件
        if (validFiles.length > 0) {
          // 创建 FileList 对象给 processDroppedFiles
          const validFileList = Object.assign(validFiles, {
            length: validFiles.length,
            item: (index: number) => validFiles[index] || null,
          }) as unknown as FileList;
          const processedFiles = await FileService.processDroppedFiles(validFileList, conversation_id);

          if (processedFiles.length > 0) {
            onFilesAdded(processedFiles);
          }
        }
      } catch (err) {
        console.error('Failed to process dropped files:', err);
        Message.error(t('conversation.workspace.dragFailed', 'Failed to process dropped files'));
      }
    },
    [conversation_id, onFilesAdded, supportedExts, t]
  );

  const dragHandlers = {
    onDragOver: handleDragOver,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  };

  return {
    isFileDragging,
    dragHandlers,
  };
};
