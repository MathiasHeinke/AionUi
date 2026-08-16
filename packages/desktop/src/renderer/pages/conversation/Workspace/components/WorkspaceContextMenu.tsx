/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IDirOrFile } from '@/common/adapter/ipcBridge';
import React from 'react';
import type { TFunction } from 'i18next';
import { isPreviewSupportedExt } from '../utils/filePreview';

type WorkspaceContextMenuProps = {
  visible: boolean;
  style: React.CSSProperties | undefined;
  node: IDirOrFile | null;
  t: TFunction;
  // File operation handlers
  handleAddToChat: (node: IDirOrFile) => void;
  handleOpenNode: (node: IDirOrFile) => Promise<void>;
  handleRevealNode: (node: IDirOrFile) => Promise<void>;
  handlePreviewFile: (node: IDirOrFile) => Promise<void>;
  handleDownloadFile: (node: IDirOrFile) => Promise<void>;
  handleDeleteNode: (node: IDirOrFile) => void;
  openRenameModal: (node: IDirOrFile) => void;
  closeContextMenu: () => void;
};

const MENU_BUTTON_BASE =
  'w-full flex items-center gap-8px px-14px py-6px text-13px text-left text-t-primary rounded-md transition-colors duration-300 hover:bg-2 border-none bg-transparent appearance-none focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eve-focus-ring)]';
const MENU_BUTTON_DISABLED = 'opacity-40 cursor-not-allowed hover:bg-transparent';

/** Right-click context menu with file/folder operations. */
const WorkspaceContextMenu: React.FC<WorkspaceContextMenuProps> = ({
  visible,
  style,
  node,
  t,
  handleAddToChat,
  handleOpenNode,
  handleRevealNode,
  handlePreviewFile,
  handleDownloadFile,
  handleDeleteNode,
  openRenameModal,
  closeContextMenu,
}) => {
  if (!visible || !node || !style) return null;

  const isFile = !!node.isFile;
  const isRoot = !node.relativePath || node.relativePath === '';
  const isPreviewSupported = isFile && !!node.name && isPreviewSupportedExt(node.name);

  return (
    <div
      className='eve-overlay fixed z-100 min-w-200px max-w-240px rounded-8px p-6px'
      data-eve-interaction-role='event-boundary'
      role='menu'
      style={{ top: style.top, left: style.left }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className='flex flex-col gap-4px'>
        <button
          type='button'
          role='menuitem'
          className={MENU_BUTTON_BASE}
          onClick={() => {
            handleAddToChat(node);
          }}
        >
          {t('conversation.workspace.contextMenu.addToChat')}
        </button>
        <button
          type='button'
          role='menuitem'
          className={MENU_BUTTON_BASE}
          onClick={() => {
            void handleOpenNode(node);
            closeContextMenu();
          }}
        >
          {t('conversation.workspace.contextMenu.open')}
        </button>
        <button
          type='button'
          role='menuitem'
          className={MENU_BUTTON_BASE}
          onClick={() => {
            void handleRevealNode(node);
            closeContextMenu();
          }}
        >
          {t('conversation.workspace.contextMenu.openLocation')}
        </button>
        {isFile && isPreviewSupported && (
          <button
            type='button'
            role='menuitem'
            className={MENU_BUTTON_BASE}
            onClick={() => {
              void handlePreviewFile(node);
            }}
          >
            {t('conversation.workspace.contextMenu.preview')}
          </button>
        )}
        {isFile && (
          <button
            type='button'
            role='menuitem'
            className={MENU_BUTTON_BASE}
            onClick={() => {
              void handleDownloadFile(node);
            }}
          >
            {t('conversation.workspace.contextMenu.download')}
          </button>
        )}
        <div className='h-1px my-2px bg-[var(--glass-overlay-border)]' role='separator'></div>
        <button
          type='button'
          role='menuitem'
          className={`${MENU_BUTTON_BASE} ${isRoot ? MENU_BUTTON_DISABLED : ''}`.trim()}
          disabled={isRoot}
          onClick={() => {
            handleDeleteNode(node);
          }}
        >
          {t('common.delete')}
        </button>
        <button
          type='button'
          role='menuitem'
          className={`${MENU_BUTTON_BASE} ${isRoot ? MENU_BUTTON_DISABLED : ''}`.trim()}
          disabled={isRoot}
          onClick={() => {
            openRenameModal(node);
          }}
        >
          {t('conversation.workspace.contextMenu.rename')}
        </button>
      </div>
    </div>
  );
};

export default WorkspaceContextMenu;
