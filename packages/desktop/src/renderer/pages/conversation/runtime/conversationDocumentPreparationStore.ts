import { useCallback, useSyncExternalStore } from 'react';
import { configService } from '@/common/config/configService';

type Listener = () => void;

const preparingConversations = new Set<string>();
const listeners = new Set<Listener>();

configService.onSeatRebind?.(() => {
  if (preparingConversations.size === 0) return;
  preparingConversations.clear();
  notify();
});

const notify = (): void => listeners.forEach((listener) => listener());

export const markConversationDocumentPreparationStarted = (conversation_id: string): void => {
  if (!conversation_id || preparingConversations.has(conversation_id)) return;
  preparingConversations.add(conversation_id);
  notify();
};

export const markConversationDocumentPreparationSettled = (conversation_id: string): void => {
  if (!preparingConversations.delete(conversation_id)) return;
  notify();
};

/**
 * Non-React subscription seam for other renderer stores (the conversation-list
 * sync store mirrors this into its per-row "working" truth so the pre-stream
 * preparation phase — "EVE bereitet den Auftrag vor" — is visible in the
 * session list too, not only inside the open chat).
 */
export const subscribeConversationDocumentPreparation = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getDocumentPreparationConversationIds = (): string[] => {
  return Array.from(preparingConversations);
};

export const useConversationDocumentPreparation = (conversation_id: string): boolean => {
  const subscribe = useCallback((listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  const getSnapshot = useCallback(() => preparingConversations.has(conversation_id), [conversation_id]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export const resetConversationDocumentPreparationStoreForTest = (): void => {
  preparingConversations.clear();
  listeners.clear();
};
