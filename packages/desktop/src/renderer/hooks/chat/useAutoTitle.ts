import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { deriveAutoTitleFromMessages } from '@/renderer/utils/chat/autoTitle';
import { emitter } from '@/renderer/utils/emitter';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

/**
 * TITLES ARE DERIVED LOCALLY. There was a server-side "app-billed" cloud title
 * lane here that summarized the first exchange with a model. It was retired: it
 * was an UNMETERED cloud call — gated only on a licence signature, so a
 * cancelled or revoked tenant could draw it — made on the first exchange of
 * EVERY new conversation. R2 admits no free lane, and the title is derivable
 * from the already-metered conversation, so the lane was removed rather than
 * metered. The truncated local title below was already the fallback on every
 * cloud failure, so this is exactly what users saw whenever that lane was down.
 *
 * It deliberately does NOT fall back to local Gemma either: a title must not
 * start a hidden local inference job while the main chat run is already
 * competing for CPU and RAM.
 */
export const useAutoTitle = () => {
  const { t } = useTranslation();

  const syncTitleFromHistory = useCallback(
    async (conversation_id: string, fallbackContent?: string): Promise<string | null> => {
      const defaultTitle = t('conversation.welcome.newConversation');
      try {
        const conversation = await getConversationOrNull(conversation_id);
        if (!conversation || conversation.name !== defaultTitle) {
          return null;
        }

        const messagesResult = await ipcBridge.database.getConversationMessages.invoke({
          conversation_id: conversation_id,
          limit: 200,
        });
        const newTitle = deriveAutoTitleFromMessages(messagesResult.items, fallbackContent);
        if (!newTitle) {
          return null;
        }

        const success = await ipcBridge.conversation.update.invoke({
          id: conversation_id,
          updates: { name: newTitle },
        });
        if (!success) {
          return null;
        }

        emitter.emit('chat.history.refresh');
        return newTitle;
      } catch (error) {
        console.error('Failed to auto-update conversation title:', error);
        return null;
      }
    },
    [t]
  );

  const checkAndUpdateTitle = useCallback(
    async (conversation_id: string, messageContent: string) => {
      // Set the truncated heuristic title for a default-named new conversation.
      // No-ops if the conversation already carries the user's first message as
      // its name. There is no second pass: the model-summary upgrade that used
      // to run here drew an unmetered cloud lane and was retired with it.
      await syncTitleFromHistory(conversation_id, messageContent);
    },
    [syncTitleFromHistory]
  );

  return {
    checkAndUpdateTitle,
    syncTitleFromHistory,
  };
};
