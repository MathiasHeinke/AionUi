import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { deriveAutoTitleFromMessages } from '@/renderer/utils/chat/autoTitle';
import { emitter } from '@/renderer/utils/emitter';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

// Per-conversation guard: the local-model title upgrade runs AT MOST ONCE per
// conversation (the founder spec: only the first message). `checkAndUpdateTitle`
// fires on every send, so this set prevents a second model call (and a second
// title overwrite) on later turns. Module-scoped so it survives hook re-mounts.
const localTitleAttempted = new Set<string>();

export const useAutoTitle = () => {
  const { t, i18n } = useTranslation();

  /**
   * Upgrade the (already-set) truncated title to a short, LOCAL-model-summarized
   * one — like Claude Code. Best-effort + non-blocking: runs after the instant
   * truncation, uses the bundled ON-DEVICE Gemma lane (free + private; never the
   * cloud/credits lane), and only swaps the title in if the conversation is STILL
   * showing the auto-derived `expectedTitle` (i.e. the user has not manually
   * renamed it meanwhile). Any failure leaves the truncated title in place.
   */
  const upgradeTitleWithLocalModel = useCallback(
    async (conversation_id: string, taskText: string, expectedTitle: string) => {
      try {
        const text = (taskText || '').trim();
        if (!text) return;
        // German task ⇒ German title, otherwise English (the local prompt is
        // bilingual). resolveLocaleKey never yields de-DE, so detect German off
        // the raw i18n language tag.
        const locale = (i18n.language || '').toLowerCase().startsWith('de') ? 'de-DE' : 'en-US';
        const response = await ipcBridge.commandEve.generateLocalTitle.invoke({ text, locale });
        const generated = response?.data?.ok ? response.data.title?.trim() : undefined;
        if (!generated || generated === expectedTitle) return;

        // Re-read: only overwrite when the title is STILL the auto-derived one. If
        // the user renamed it (or another path changed it) in the meantime, respect
        // that and do not clobber it.
        const current = await getConversationOrNull(conversation_id);
        if (!current || current.name !== expectedTitle) return;

        const success = await ipcBridge.conversation.update.invoke({
          id: conversation_id,
          updates: { name: generated },
        });
        if (!success) return;
        emitter.emit('chat.history.refresh');
      } catch (error) {
        // Fail-quiet: keep the truncated fallback title.
        console.warn('Local auto-title generation skipped:', error);
      }
    },
    [i18n.language]
  );

  const syncTitleFromHistory = useCallback(
    async (conversation_id: string, fallbackContent?: string) => {
      const defaultTitle = t('conversation.welcome.newConversation');
      try {
        const conversation = await getConversationOrNull(conversation_id);
        if (!conversation || conversation.name !== defaultTitle) {
          return;
        }

        const messagesResult = await ipcBridge.database.getConversationMessages.invoke({
          conversation_id: conversation_id,
          page: 0,
          page_size: 1000,
        });
        const newTitle = deriveAutoTitleFromMessages(messagesResult.items, fallbackContent);
        if (!newTitle) {
          return;
        }

        const success = await ipcBridge.conversation.update.invoke({
          id: conversation_id,
          updates: { name: newTitle },
        });
        if (!success) {
          return;
        }

        emitter.emit('chat.history.refresh');
      } catch (error) {
        console.error('Failed to auto-update conversation title:', error);
      }
    },
    [t]
  );

  const checkAndUpdateTitle = useCallback(
    async (conversation_id: string, messageContent: string) => {
      // 1) Instant fallback: set the truncated heuristic title (for a
      //    default-named new conversation). No-ops if the conversation already
      //    carries the user's first message as its name.
      await syncTitleFromHistory(conversation_id, messageContent);

      // 2) Background upgrade: replace whatever auto title is now showing with a
      //    short LOCAL-model summary (Claude-Code-style). Runs on the FIRST
      //    message of a new conversation, where the current name is always the
      //    auto title (truncated first message or the localized default) — so we
      //    capture it as the expected baseline. The upgrade then ONLY overwrites
      //    if the name is STILL that exact baseline at completion time, so a
      //    manual rename made meanwhile is never clobbered. Fully non-blocking —
      //    the chat/response is already in flight.
      try {
        // Once per conversation only (first message). checkAndUpdateTitle fires
        // on every send; this guard stops a re-generate on later turns.
        if (localTitleAttempted.has(conversation_id)) return;
        const current = await getConversationOrNull(conversation_id);
        const currentName = current?.name?.trim();
        if (!currentName) return;
        localTitleAttempted.add(conversation_id);
        void upgradeTitleWithLocalModel(conversation_id, messageContent, currentName);
      } catch (error) {
        console.warn('Auto-title upgrade scheduling skipped:', error);
      }
    },
    [syncTitleFromHistory, upgradeTitleWithLocalModel]
  );

  return {
    checkAndUpdateTitle,
    syncTitleFromHistory,
  };
};
