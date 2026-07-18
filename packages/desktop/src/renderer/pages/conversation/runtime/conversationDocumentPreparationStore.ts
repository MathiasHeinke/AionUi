import { useCallback, useSyncExternalStore } from 'react';

type Listener = () => void;

const preparingConversations = new Set<string>();
const listeners = new Set<Listener>();

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
