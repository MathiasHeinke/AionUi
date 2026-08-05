/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import { scrubModelIdentifiers } from '@/common/config/modelIdentifierScrub';
import { parseError, uuid } from '@/common/utils';
import { CLOUD_MODEL_IDENTIFIERS } from '@/renderer/utils/model/modelContextLimits';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getConversationRuntimeWorkspaceErrorMessage } from '../../utils/conversationCreateError';
import { buildSendFailureError } from './buildSendFailureError';

type UseAcpInitialMessageParams = {
  conversation_id: string;
  sendInitialMessage: (input: string, files: string[], videoSelection?: InitialVideoSelection) => Promise<boolean>;
  resetState: () => void;
  addOrUpdateMessage: (message: TMessage, prepend?: boolean) => void;
};

/** The picker's selection, carried from the start-chat surface (MAT-1773 P3). */
export type InitialVideoSelection = {
  modelId: string;
  resolution: string | null;
  durationSeconds: number;
};

/** Defensive read of the carried selection — sessionStorage is not trusted. */
const parseInitialVideoSelection = (value: unknown): InitialVideoSelection | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== 'string' || record.modelId.trim().length === 0) return undefined;
  if (
    typeof record.durationSeconds !== 'number' ||
    !Number.isFinite(record.durationSeconds) ||
    record.durationSeconds <= 0
  ) {
    return undefined;
  }
  return {
    modelId: record.modelId,
    resolution: typeof record.resolution === 'string' && record.resolution ? record.resolution : null,
    durationSeconds: record.durationSeconds,
  };
};

/**
 * Side-effect-only hook that checks sessionStorage for an initial message
 * and sends it when the ACP conversation first mounts.
 */
export const useAcpInitialMessage = ({
  conversation_id,
  sendInitialMessage,
  resetState,
  addOrUpdateMessage,
}: UseAcpInitialMessageParams): void => {
  const { t } = useTranslation();

  useEffect(() => {
    const storageKey = `acp_initial_message_${conversation_id}`;
    const storedMessage = sessionStorage.getItem(storageKey);

    if (!storedMessage) return;

    // Clear immediately to prevent duplicate sends (e.g., if component remounts while sendMessage is pending)
    sessionStorage.removeItem(storageKey);

    const submitStoredMessage = async () => {
      try {
        const initialMessage = JSON.parse(storedMessage) as {
          input?: unknown;
          files?: unknown;
          videoSelection?: unknown;
        };
        const input = typeof initialMessage.input === 'string' ? initialMessage.input : '';
        const files = Array.isArray(initialMessage.files)
          ? initialMessage.files.filter((file): file is string => typeof file === 'string')
          : [];
        const videoSelection = parseInitialVideoSelection(initialMessage.videoSelection);

        // The fresh-chat handoff must use the exact same preparation, cost-wall,
        // queue, runtime, and recovery path as an in-chat send.
        await sendInitialMessage(input, files, videoSelection);
      } catch (error) {
        // SCRUBBED (MAT-1749) AT THE BINDING: this sentence is rendered into the
        // chat as a `tips` message and handed to `buildSendFailureError`, and it
        // originates upstream, so it can carry a provider/model id. The console
        // lines below keep the RAW `error` object for debugging — that is the
        // debugging half and must not be confused with the user-facing one.
        const errorMessageText = scrubModelIdentifiers(
          getConversationRuntimeWorkspaceErrorMessage(error, t) || parseError(error) || t('common.unknownError'),
          CLOUD_MODEL_IDENTIFIERS
        );
        console.error('[useAcpInitialMessage] Error sending initial message:', error);
        console.error('[useAcpInitialMessage] Error details:', {
          name: (error as Error)?.name,
          message: errorMessageText,
          conversation_id,
        });

        const errorMessage: TMessage = {
          id: uuid(),
          msg_id: uuid(),
          conversation_id: conversation_id,
          type: 'tips',
          position: 'center',
          content: {
            content: errorMessageText,
            type: 'error',
            error: buildSendFailureError(error, errorMessageText),
          },
          created_at: Date.now() + 2,
        };
        addOrUpdateMessage(errorMessage, true);
        resetState();
      }
    };

    submitStoredMessage().catch((error) => {
      console.error('Failed to send initial message:', error);
    });
  }, [addOrUpdateMessage, conversation_id, resetState, sendInitialMessage, t]);
};
