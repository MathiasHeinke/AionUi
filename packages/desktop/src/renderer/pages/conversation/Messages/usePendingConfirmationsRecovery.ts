/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConfirmation, IMessagePermission, TMessage } from '@/common/chat/chatLib';
import { useEffect } from 'react';
import { mergeAcpPermissionWithConfirmation, useUpdateMessageList } from './hooks';
import { shouldApplyPermissionConfirmation } from './acp/permissionCardPolicy';

export const pendingConfirmationMsgId = (confirmationId: string) => `confirmation:${confirmationId}`;

export function buildPendingConfirmationMessage(
  conversation_id: string,
  confirmation: IConfirmation<unknown>
): IMessagePermission {
  return {
    id: pendingConfirmationMsgId(confirmation.id),
    msg_id: pendingConfirmationMsgId(confirmation.id),
    type: 'permission',
    position: 'left',
    conversation_id,
    created_at: Date.now(),
    content: confirmation,
  };
}

export function hasPermissionMessageForCallId(list: TMessage[], callId: string): boolean {
  return list.some((message) => {
    if (message.type === 'permission') return message.content?.call_id === callId;
    if (message.type === 'acp_permission') {
      return (message.content?.tool_call?.tool_call_id || message.msg_id || message.id) === callId;
    }
    return false;
  });
}

export function removePermissionMessage(list: TMessage[], target: { id?: string; call_id?: string }): TMessage[] {
  return list.filter((message) => {
    if (message.type === 'permission') {
      if (target.id && message.content.id === target.id) return false;
      if (target.call_id && message.content.call_id === target.call_id) return false;
      return true;
    }
    if (message.type === 'acp_permission') {
      const callId = message.content?.tool_call?.tool_call_id || message.msg_id || message.id;
      if (target.id && (message.id === target.id || callId === target.id)) return false;
      if (target.call_id && callId === target.call_id) return false;
    }
    return true;
  });
}

export function upsertPendingConfirmationMessage(
  list: TMessage[],
  conversation_id: string,
  confirmation: IConfirmation<unknown>
): TMessage[] {
  const existing = list.find((message) => {
    if (message.type === 'permission') return message.content?.call_id === confirmation.call_id;
    if (message.type === 'acp_permission') {
      return (message.content?.tool_call?.tool_call_id || message.msg_id || message.id) === confirmation.call_id;
    }
    return false;
  });
  if (existing?.type === 'permission' && !shouldApplyPermissionConfirmation(existing.content, confirmation)) {
    return list;
  }
  if (existing?.type === 'acp_permission') {
    return list.map((message) =>
      message === existing ? mergeAcpPermissionWithConfirmation(existing, confirmation) : message
    );
  }
  const withoutExisting = removePermissionMessage(list, {
    id: confirmation.id,
    call_id: confirmation.call_id,
  });
  return withoutExisting.concat(buildPendingConfirmationMessage(conversation_id, confirmation));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePendingConfirmationsRecovery(conversation_id: string) {
  const updateMessageList = useUpdateMessageList();

  useEffect(() => {
    if (!conversation_id) return;
    let cancelled = false;
    let syncSequence = 0;

    const upsertConfirmation = (confirmation: IConfirmation<unknown>) => {
      if (!confirmation?.call_id || !confirmation?.id) return;
      updateMessageList((list) => upsertPendingConfirmationMessage(list, conversation_id, confirmation));
    };

    const syncPendingConfirmations = async () => {
      const sequence = ++syncSequence;
      try {
        const confirmations = await ipcBridge.conversation.confirmation.list.invoke({ conversation_id });
        if (cancelled || sequence !== syncSequence) return;
        updateMessageList((list) => {
          let next = list;
          for (const confirmation of confirmations ?? []) {
            if (!confirmation?.call_id || !confirmation?.id) continue;
            next = upsertPendingConfirmationMessage(next, conversation_id, confirmation);
          }
          return next;
        });
      } catch (error) {
        if (cancelled || sequence !== syncSequence) return;
        console.warn('[pending-confirmations] failed to recover pending confirmations', {
          conversation_id,
          error: errorMessage(error),
        });
      }
    };

    void syncPendingConfirmations();

    // The confirmation channel is a second, durable fast path beside the chat
    // transcript stream. If a renderer listener attaches after the ACP frame or
    // reconnects mid-turn, this event still materializes the actionable card.
    const offAdd = ipcBridge.conversation.confirmation.add.on((confirmation) => {
      if (confirmation.conversation_id !== conversation_id) return;
      upsertConfirmation(confirmation);
    });

    const offUpdate = ipcBridge.conversation.confirmation.update.on((confirmation) => {
      if (confirmation.conversation_id !== conversation_id) return;
      upsertConfirmation(confirmation);
    });

    const offRemove = ipcBridge.conversation.confirmation.remove.on((event) => {
      if (event.conversation_id !== conversation_id) return;
      updateMessageList((list) => removePermissionMessage(list, { id: event.id, call_id: event.id }));
    });

    // A missed confirmation.add during a transport gap must not require a chat
    // switch or app restart. Re-read the authoritative pending list whenever the
    // realtime layer reports lag/reconnect.
    const offResync = ipcBridge.conversation.realtimeResyncRequired.on(() => {
      void syncPendingConfirmations();
    });
    const offConnected = ipcBridge.conversation.realtimeConnected.on(({ reconnected }) => {
      if (reconnected) void syncPendingConfirmations();
    });

    return () => {
      cancelled = true;
      syncSequence += 1;
      offAdd();
      offUpdate();
      offRemove();
      offResync();
      offConnected();
    };
  }, [conversation_id, updateMessageList]);
}
