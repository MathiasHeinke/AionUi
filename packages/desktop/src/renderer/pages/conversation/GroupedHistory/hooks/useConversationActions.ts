/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { refreshConversationCache } from '@/renderer/pages/conversation/utils/conversationCache';
import { emitter } from '@/renderer/utils/emitter';
import { blockMobileInputFocus, blurActiveElement } from '@/renderer/utils/ui/focus';
import { Message, Modal } from '@arco-design/web-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import {
  buildConversationFolderExtra,
  createConversationFolderId,
  getConversationFolderId,
  getConversationFolderName,
  isConversationArchived,
  isConversationPinned,
  type ConversationFolderTarget,
} from '../utils/groupingHelpers';
import { setWorkspaceCustomName } from '@/renderer/utils/workspace/workspaceName';

type UseConversationActionsParams = {
  batchMode: boolean;
  onSessionClick?: () => void;
  onBatchModeChange?: (value: boolean) => void;
  selectedConversationIds: Set<string>;
  setSelectedConversationIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleSelectedConversation: (conversation: TChatConversation) => void;
  markAsRead: (conversation_id: string) => void;
};

type FolderBatchTarget = {
  id: string;
  display_name: string;
  conversations: TChatConversation[];
};

export const useConversationActions = ({
  batchMode,
  onSessionClick,
  onBatchModeChange,
  selectedConversationIds,
  setSelectedConversationIds,
  toggleSelectedConversation,
  markAsRead,
}: UseConversationActionsParams) => {
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameModalName, setRenameModalName] = useState<string>('');
  const [renameModalId, setRenameModalId] = useState<string | null>(null);
  const [renameLoading, setRenameLoading] = useState(false);
  const [dropdownVisibleId, setDropdownVisibleId] = useState<string | null>(null);
  const [moveTargetConversation, setMoveTargetConversation] = useState<TChatConversation | null>(null);
  const [moveFolderName, setMoveFolderName] = useState('');
  const [moveFolderLoading, setMoveFolderLoading] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderBatchTarget | null>(null);
  const [renameFolderName, setRenameFolderName] = useState('');
  const [renameFolderLoading, setRenameFolderLoading] = useState(false);
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Close dropdown when entering batch mode
  useEffect(() => {
    if (batchMode) {
      setDropdownVisibleId(null);
    }
  }, [batchMode]);

  const handleConversationClick = useCallback(
    (conversation: TChatConversation) => {
      setDropdownVisibleId(null);
      if (batchMode) {
        toggleSelectedConversation(conversation);
        return;
      }
      blockMobileInputFocus();
      blurActiveElement();

      markAsRead(conversation.id);

      void navigate(`/conversation/${conversation.id}`);
      if (onSessionClick) {
        onSessionClick();
      }
    },
    [batchMode, toggleSelectedConversation, markAsRead, navigate, onSessionClick]
  );

  const removeConversation = useCallback(
    async (conversation_id: string) => {
      const success = await ipcBridge.conversation.remove.invoke({ id: conversation_id });
      if (!success) {
        return false;
      }

      emitter.emit('conversation.deleted', conversation_id);
      if (id === conversation_id) {
        void navigate('/');
      }
      return true;
    },
    [id, navigate]
  );

  const handleDeleteClick = useCallback(
    (conversation_id: string) => {
      Modal.confirm({
        title: t('conversation.history.deleteTitle'),
        content: t('conversation.history.deleteConfirm'),
        okText: t('conversation.history.confirmDelete'),
        cancelText: t('conversation.history.cancelDelete'),
        okButtonProps: { status: 'warning' },
        onOk: async () => {
          try {
            const success = await removeConversation(conversation_id);
            if (success) {
              emitter.emit('chat.history.refresh');
              Message.success(t('conversation.history.deleteSuccess'));
            } else {
              Message.error(t('conversation.history.deleteFailed'));
            }
          } catch (error) {
            console.error('Failed to remove conversation:', error);
            Message.error(t('conversation.history.deleteFailed'));
          }
        },
        style: { borderRadius: '12px' },
        alignCenter: true,
        getPopupContainer: () => document.body,
      });
    },
    [removeConversation, t]
  );

  const handleBatchDelete = useCallback(() => {
    if (selectedConversationIds.size === 0) {
      Message.warning(t('conversation.history.batchNoSelection'));
      return;
    }

    Modal.confirm({
      title: t('conversation.history.batchDelete'),
      content: t('conversation.history.batchDeleteConfirm', { count: selectedConversationIds.size }),
      okText: t('conversation.history.confirmDelete'),
      cancelText: t('conversation.history.cancelDelete'),
      okButtonProps: { status: 'warning' },
      onOk: async () => {
        const selectedIds = Array.from(selectedConversationIds);
        try {
          const results = await Promise.all(selectedIds.map((conversation_id) => removeConversation(conversation_id)));
          const successCount = results.filter(Boolean).length;
          emitter.emit('chat.history.refresh');
          if (successCount > 0) {
            Message.success(t('conversation.history.batchDeleteSuccess', { count: successCount }));
          } else {
            Message.error(t('conversation.history.deleteFailed'));
          }
        } catch (error) {
          console.error('Failed to batch delete conversations:', error);
          Message.error(t('conversation.history.deleteFailed'));
        } finally {
          setSelectedConversationIds(new Set());
          onBatchModeChange?.(false);
        }
      },
      style: { borderRadius: '12px' },
      alignCenter: true,
      getPopupContainer: () => document.body,
    });
  }, [onBatchModeChange, removeConversation, selectedConversationIds, t, setSelectedConversationIds]);

  const handleEditStart = useCallback((conversation: TChatConversation) => {
    setRenameModalId(conversation.id);
    setRenameModalName(conversation.name);
    setRenameModalVisible(true);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (!renameModalId || !renameModalName.trim()) return;

    setRenameLoading(true);
    try {
      const success = await ipcBridge.conversation.update.invoke({
        id: renameModalId,
        updates: { name: renameModalName.trim() },
      });

      if (success) {
        await refreshConversationCache(renameModalId);
        emitter.emit('chat.history.refresh');
        setRenameModalVisible(false);
        setRenameModalId(null);
        setRenameModalName('');
        Message.success(t('conversation.history.renameSuccess'));
      } else {
        Message.error(t('conversation.history.renameFailed'));
      }
    } catch (error) {
      console.error('Failed to update conversation name:', error);
      Message.error(t('conversation.history.renameFailed'));
    } finally {
      setRenameLoading(false);
    }
  }, [renameModalId, renameModalName, t]);

  const handleRenameCancel = useCallback(() => {
    setRenameModalVisible(false);
    setRenameModalId(null);
    setRenameModalName('');
  }, []);

  const handleTogglePin = useCallback(
    async (conversation: TChatConversation) => {
      const pinned = isConversationPinned(conversation);

      try {
        const success = await ipcBridge.conversation.update.invoke({
          id: conversation.id,
          updates: {
            extra: {
              pinned: !pinned,
              pinned_at: pinned ? undefined : Date.now(),
            } as Partial<TChatConversation['extra']>,
          } as Partial<TChatConversation>,
          merge_extra: true,
        });

        if (success) {
          emitter.emit('chat.history.refresh');
        } else {
          Message.error(t('conversation.history.pinFailed'));
        }
      } catch (error) {
        console.error('Failed to toggle pin conversation:', error);
        Message.error(t('conversation.history.pinFailed'));
      }
    },
    [t]
  );

  // 1.7.4a — archive is the REVERSIBLE alternative to hard delete: it soft-hides
  // the conversation (extra.archived) into the Archive section, from where it can
  // be restored. No data loss — important for per-client work.
  const handleToggleArchive = useCallback(
    async (conversation: TChatConversation) => {
      const archived = isConversationArchived(conversation);
      try {
        const success = await ipcBridge.conversation.update.invoke({
          id: conversation.id,
          updates: {
            extra: {
              archived: !archived,
              archived_at: archived ? undefined : Date.now(),
            } as Partial<TChatConversation['extra']>,
          } as Partial<TChatConversation>,
          merge_extra: true,
        });

        if (success) {
          await refreshConversationCache(conversation.id);
          emitter.emit('chat.history.refresh');
          Message.success(t(archived ? 'conversation.history.restoreSuccess' : 'conversation.history.archiveSuccess'));
        } else {
          Message.error(t('conversation.history.archiveFailed'));
        }
      } catch (error) {
        console.error('Failed to toggle archive conversation:', error);
        Message.error(t('conversation.history.archiveFailed'));
      }
    },
    [t]
  );

  const handleMoveStart = useCallback((conversation: TChatConversation) => {
    setMoveTargetConversation(conversation);
    setMoveFolderName('');
    setDropdownVisibleId(null);
  }, []);

  const handleMoveCancel = useCallback(() => {
    if (moveFolderLoading) return;
    setMoveTargetConversation(null);
    setMoveFolderName('');
  }, [moveFolderLoading]);

  const handleMoveToFolder = useCallback(
    async (target: ConversationFolderTarget | null) => {
      if (!moveTargetConversation) return;

      const currentFolderId = getConversationFolderId(moveTargetConversation);
      const currentFolderName = getConversationFolderName(moveTargetConversation);
      if (target?.id === currentFolderId && target.name === currentFolderName) {
        handleMoveCancel();
        return;
      }

      setMoveFolderLoading(true);
      try {
        const success = await ipcBridge.conversation.update.invoke({
          id: moveTargetConversation.id,
          updates: {
            extra: buildConversationFolderExtra(target),
          } as Partial<TChatConversation>,
          merge_extra: true,
        });

        if (success) {
          await refreshConversationCache(moveTargetConversation.id);
          emitter.emit('chat.history.refresh');
          Message.success(
            t(target ? 'conversation.history.moveToFolderSuccess' : 'conversation.history.removeFromFolderSuccess')
          );
          setMoveTargetConversation(null);
          setMoveFolderName('');
        } else {
          Message.error(t('conversation.history.moveToFolderFailed'));
        }
      } catch (error) {
        console.error('Failed to move conversation to folder:', error);
        Message.error(t('conversation.history.moveToFolderFailed'));
      } finally {
        setMoveFolderLoading(false);
      }
    },
    [handleMoveCancel, moveTargetConversation, t]
  );

  const handleMoveToNewFolder = useCallback(async () => {
    const name = moveFolderName.trim();
    if (!name) return;
    await handleMoveToFolder({
      id: createConversationFolderId(name),
      name,
    });
  }, [handleMoveToFolder, moveFolderName]);

  const updateFolderForConversations = useCallback(
    async (conversations: TChatConversation[], target: ConversationFolderTarget | null) => {
      const results = await Promise.all(
        conversations.map(async (conversation) => {
          const success = await ipcBridge.conversation.update.invoke({
            id: conversation.id,
            updates: {
              extra: buildConversationFolderExtra(target),
            } as Partial<TChatConversation>,
            merge_extra: true,
          });
          if (success) {
            await refreshConversationCache(conversation.id);
          }
          return success;
        })
      );
      return {
        successCount: results.filter(Boolean).length,
        allSucceeded: results.every(Boolean),
      };
    },
    []
  );

  const handleRenameFolderStart = useCallback((folder: FolderBatchTarget) => {
    setRenameFolderTarget(folder);
    setRenameFolderName(folder.display_name);
    setDropdownVisibleId(null);
  }, []);

  const handleRenameFolderCancel = useCallback(() => {
    if (renameFolderLoading) return;
    setRenameFolderTarget(null);
    setRenameFolderName('');
  }, [renameFolderLoading]);

  const handleRenameFolderConfirm = useCallback(async () => {
    if (!renameFolderTarget) return;
    const next = renameFolderName.trim();
    if (!next) return;
    if (next === renameFolderTarget.display_name.trim()) {
      handleRenameFolderCancel();
      return;
    }

    setRenameFolderLoading(true);
    try {
      const result = await updateFolderForConversations(renameFolderTarget.conversations, {
        id: renameFolderTarget.id,
        name: next,
      });
      if (result.successCount > 0) {
        emitter.emit('chat.history.refresh');
      }
      if (result.allSucceeded) {
        Message.success(t('conversation.history.renameFolderSuccess'));
        setRenameFolderTarget(null);
        setRenameFolderName('');
      } else {
        Message.error(t('conversation.history.renameFolderFailed'));
      }
    } catch (error) {
      console.error('Failed to rename conversation folder:', error);
      Message.error(t('conversation.history.renameFolderFailed'));
    } finally {
      setRenameFolderLoading(false);
    }
  }, [handleRenameFolderCancel, renameFolderName, renameFolderTarget, t, updateFolderForConversations]);

  const handleRemoveFolder = useCallback(
    (folder: FolderBatchTarget) => {
      if (folder.conversations.length === 0) return;

      Modal.confirm({
        title: t('conversation.history.removeFolderTitle'),
        content: t('conversation.history.removeFolderConfirm', {
          name: folder.display_name,
          count: folder.conversations.length,
        }),
        okText: t('conversation.history.removeFolder'),
        cancelText: t('conversation.history.cancelEdit'),
        okButtonProps: { status: 'warning' },
        onOk: async () => {
          try {
            const result = await updateFolderForConversations(folder.conversations, null);
            if (result.successCount > 0) {
              emitter.emit('chat.history.refresh');
            }
            if (result.allSucceeded) {
              Message.success(t('conversation.history.removeFolderSuccess'));
            } else {
              Message.error(t('conversation.history.removeFolderFailed'));
            }
          } catch (error) {
            console.error('Failed to remove conversation folder:', error);
            Message.error(t('conversation.history.removeFolderFailed'));
          }
        },
        style: { borderRadius: '12px' },
        alignCenter: true,
        getPopupContainer: () => document.body,
      });
    },
    [t, updateFolderForConversations]
  );

  const handleMenuVisibleChange = useCallback((conversation_id: string, visible: boolean) => {
    setDropdownVisibleId(visible ? conversation_id : null);
  }, []);

  const handleOpenMenu = useCallback((conversation: TChatConversation) => {
    setDropdownVisibleId(conversation.id);
  }, []);

  /**
   * Remove project state — rendered via AionModal in the GroupedHistory component.
   * Uses project's design system: AionModal component with danger-styled action button.
   */
  const [removeProjectTarget, setRemoveProjectTarget] = useState<{
    name: string;
    conversations: TChatConversation[];
  } | null>(null);
  const [removeProjectLoading, setRemoveProjectLoading] = useState(false);

  const handleRemoveProject = useCallback((projectName: string, conversations: TChatConversation[]) => {
    if (conversations.length === 0) return;
    setRemoveProjectTarget({ name: projectName, conversations });
  }, []);

  const handleRemoveProjectCancel = useCallback(() => {
    if (removeProjectLoading) return;
    setRemoveProjectTarget(null);
  }, [removeProjectLoading]);

  const handleRemoveProjectConfirm = useCallback(async () => {
    if (!removeProjectTarget) return;
    setRemoveProjectLoading(true);
    try {
      const results = await Promise.all(removeProjectTarget.conversations.map((c) => removeConversation(c.id)));
      const successCount = results.filter(Boolean).length;
      emitter.emit('chat.history.refresh');
      if (successCount > 0) {
        Message.success(
          t('conversation.history.batchDeleteSuccess', {
            count: successCount,
          })
        );
      } else {
        Message.error(t('conversation.history.deleteFailed'));
      }
      setRemoveProjectTarget(null);
    } catch (error) {
      console.error('Failed to remove project:', error);
      Message.error(t('conversation.history.deleteFailed'));
    } finally {
      setRemoveProjectLoading(false);
    }
  }, [removeProjectTarget, removeConversation, t]);

  /**
   * Rename a project (workspace). Persists a label OVERRIDE keyed by the
   * workspace path (workspaceName store) — the on-disk directory and every
   * conversation's `extra.workspace` path are left untouched, so the rename is
   * purely cosmetic and fully reversible (blank restores the default label).
   */
  const [renameProjectTarget, setRenameProjectTarget] = useState<{
    workspace: string;
    name: string;
  } | null>(null);
  const [renameProjectName, setRenameProjectName] = useState('');

  const handleRenameProjectStart = useCallback((workspace: string, currentName: string) => {
    setRenameProjectTarget({ workspace, name: currentName });
    setRenameProjectName(currentName);
  }, []);

  const handleRenameProjectCancel = useCallback(() => {
    setRenameProjectTarget(null);
    setRenameProjectName('');
  }, []);

  const handleRenameProjectConfirm = useCallback(() => {
    if (!renameProjectTarget) return;
    const next = renameProjectName.trim();
    // No-op (and no toast) when nothing actually changed.
    if (next === renameProjectTarget.name.trim()) {
      handleRenameProjectCancel();
      return;
    }
    setWorkspaceCustomName(renameProjectTarget.workspace, next);
    emitter.emit('chat.history.refresh');
    Message.success(t('conversation.history.renameSuccess'));
    handleRenameProjectCancel();
  }, [renameProjectTarget, renameProjectName, handleRenameProjectCancel, t]);

  return {
    renameModalVisible,
    renameModalName,
    setRenameModalName,
    renameLoading,
    dropdownVisibleId,
    handleConversationClick,
    handleDeleteClick,
    handleBatchDelete,
    handleEditStart,
    handleRenameConfirm,
    handleRenameCancel,
    handleTogglePin,
    handleToggleArchive,
    moveTargetConversation,
    moveFolderName,
    setMoveFolderName,
    moveFolderLoading,
    handleMoveStart,
    handleMoveCancel,
    handleMoveToFolder,
    handleMoveToNewFolder,
    renameFolderTarget,
    renameFolderName,
    setRenameFolderName,
    renameFolderLoading,
    handleRenameFolderStart,
    handleRenameFolderCancel,
    handleRenameFolderConfirm,
    handleRemoveFolder,
    handleMenuVisibleChange,
    handleOpenMenu,
    handleRemoveProject,
    removeProjectTarget,
    removeProjectLoading,
    handleRemoveProjectCancel,
    handleRemoveProjectConfirm,
    renameProjectTarget,
    renameProjectName,
    setRenameProjectName,
    handleRenameProjectStart,
    handleRenameProjectCancel,
    handleRenameProjectConfirm,
  };
};
