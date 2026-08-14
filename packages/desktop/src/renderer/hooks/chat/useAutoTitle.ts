import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { deriveAutoTitleFromMessages, isGreetingOnlyAutoTitle } from '@/renderer/utils/chat/autoTitle';
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
    async (
      conversation_id: string,
      fallbackContent?: string,
      isCurrent: () => boolean = () => true
    ): Promise<string | null> => {
      const defaultTitle = t('conversation.welcome.newConversation');
      try {
        if (!isCurrent()) return null;
        const conversation = await getConversationOrNull(conversation_id);
        if (!isCurrent()) return null;
        // Preserve every deliberate/manual name. The only non-default names we
        // heal are greeting-only titles created by the older first-line rule.
        if (
          !conversation ||
          (conversation.name !== defaultTitle && !isGreetingOnlyAutoTitle(conversation.name ?? ''))
        ) {
          return null;
        }

        const messagesResult = await ipcBridge.database.getConversationMessages.invoke({
          conversation_id: conversation_id,
          limit: 200,
        });
        if (!isCurrent()) return null;
        const newTitle = deriveAutoTitleFromMessages(messagesResult.items, fallbackContent);
        if (!newTitle) {
          return null;
        }

        const success = await ipcBridge.conversation.update.invoke({
          id: conversation_id,
          updates: { name: newTitle },
        });
        if (!success || !isCurrent()) {
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
    async (conversation_id: string, messageContent: string, isCurrent?: () => boolean) => {
      // Set the bounded local title for a default-named conversation, or heal a
      // greeting-only title written by an older build. There is no model call:
      // the first substantive user turn already contains enough naming truth.
      await syncTitleFromHistory(conversation_id, messageContent, isCurrent);
    },
    [syncTitleFromHistory]
  );

  return {
    checkAndUpdateTitle,
    syncTitleFromHistory,
  };
};
