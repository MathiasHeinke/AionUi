import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import {
  buildAutoTitleFromContent,
  deriveAutoTitleExchangeFromMessages,
  deriveAutoTitleFromMessages,
  prepareCloudAutoTitleText,
} from '@/renderer/utils/chat/autoTitle';
import { emitter } from '@/renderer/utils/emitter';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

// Per-conversation guard: the model title upgrade schedules AT MOST ONCE per
// conversation. `checkAndUpdateTitle` fires on every send, so this set prevents
// a second cloud/local call and title overwrite on later turns.
const modelTitleAttempted = new Set<string>();

const FIRST_EXCHANGE_POLL_INTERVAL_MS = 10_000;
const FIRST_EXCHANGE_MAX_WAIT_MS = 30 * 60_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const useAutoTitle = () => {
  const { t, i18n } = useTranslation();

  /**
   * Upgrade the (already-set) truncated title to a short model-summarized one.
   * It waits for the first user->EVE exchange, tries the server-side app-billed
   * cloud title lane, and only swaps the title in if the conversation is STILL
   * showing the auto-derived `expectedTitle`. Any failure leaves the truncated
   * title in place. It intentionally never falls back to local Gemma: title
   * generation must not start a hidden local inference job while the main chat run
   * is already competing for CPU/RAM.
   */
  const upgradeTitleWithModel = useCallback(
    async (conversation_id: string, fallbackContent: string, expectedTitle: string) => {
      try {
        const startedAt = Date.now();
        let text = '';
        while (Date.now() - startedAt < FIRST_EXCHANGE_MAX_WAIT_MS) {
          const messagesResult = await ipcBridge.database.getConversationMessages.invoke({
            conversation_id,
            limit: 200,
          });
          const exchange = deriveAutoTitleExchangeFromMessages(messagesResult.items, fallbackContent);
          if (exchange?.text) {
            text = exchange.text;
            break;
          }
          await delay(FIRST_EXCHANGE_POLL_INTERVAL_MS);
        }
        if (!text) return;

        const beforeCall = await getConversationOrNull(conversation_id);
        if (!beforeCall || beforeCall.name !== expectedTitle) return;

        // German task -> German title, otherwise English. resolveLocaleKey never
        // yields de-DE, so detect German off the raw i18n language tag.
        const locale = (i18n.language || '').toLowerCase().startsWith('de') ? 'de-DE' : 'en-US';
        const cloudText = prepareCloudAutoTitleText(text);
        const cloud = cloudText
          ? await ipcBridge.commandEve.generateCloudTitle.invoke({ text: cloudText, locale })
          : undefined;
        const generated = cloud?.data?.ok ? cloud.data.title?.trim() : undefined;
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
        console.warn('Auto-title generation skipped:', error);
      }
    },
    [i18n.language]
  );

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
      // 1) Instant fallback: set the truncated heuristic title (for a
      //    default-named new conversation). No-ops if the conversation already
      //    carries the user's first message as its name.
      const syncedTitle = await syncTitleFromHistory(conversation_id, messageContent);

      // 2) Background upgrade: wait for the first user->EVE exchange, then replace
      //    whatever auto title is now showing with a short model summary. Runs on
      //    the FIRST message of a new conversation. The upgrade ONLY overwrites if
      //    the name is STILL the captured auto baseline, so a manual rename made
      //    meanwhile is never clobbered. Fully non-blocking; the chat/response is
      //    already in flight.
      try {
        // Once per conversation only (first message). checkAndUpdateTitle fires on
        // every send; this guard stops a re-generate on later turns.
        if (modelTitleAttempted.has(conversation_id)) return;
        let expectedTitle = syncedTitle?.trim() || '';
        if (!expectedTitle) {
          const current = await getConversationOrNull(conversation_id);
          const currentName = current?.name?.trim();
          const heuristicTitle = buildAutoTitleFromContent(messageContent)?.trim();
          expectedTitle = currentName && heuristicTitle && currentName === heuristicTitle ? currentName : '';
        }
        if (!expectedTitle) return;
        modelTitleAttempted.add(conversation_id);
        void upgradeTitleWithModel(conversation_id, messageContent, expectedTitle);
      } catch (error) {
        console.warn('Auto-title upgrade scheduling skipped:', error);
      }
    },
    [syncTitleFromHistory, upgradeTitleWithModel]
  );

  return {
    checkAndUpdateTitle,
    syncTitleFromHistory,
  };
};
