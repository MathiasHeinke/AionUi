/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { useSessionDigestRelay } from '@/renderer/pages/conversation/GroupedHistory/hooks/useSessionDigestRelay';
import type { GroupedHistoryResult } from '@/renderer/pages/conversation/GroupedHistory/types';
import { buildGroupedHistory } from '@/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';

export type ConversationHistoryContextValue = ReturnType<typeof useConversationListSync> & {
  groupedHistory: GroupedHistoryResult;
};

const ConversationHistoryContext = createContext<ConversationHistoryContextValue | null>(null);

export const ConversationHistoryProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const conversationListSync = useConversationListSync();
  // v1.4 T5: mount the L3 session-digest relay ONCE beside the list-sync store. It
  // listens to the same turn.completed stream but only debounces per conversation and
  // hands { conversation_id } to the main-side digest writer over IPC — a separate
  // lifecycle from the sidebar store, so it is a sibling hook, not nested in it.
  useSessionDigestRelay();

  const groupedHistory = useMemo(() => {
    return buildGroupedHistory(conversationListSync.conversations, t);
  }, [conversationListSync.conversations, t]);

  const value = useMemo<ConversationHistoryContextValue>(() => {
    return {
      ...conversationListSync,
      groupedHistory,
    };
  }, [conversationListSync, groupedHistory]);

  return <ConversationHistoryContext.Provider value={value}>{children}</ConversationHistoryContext.Provider>;
};

export const useConversationHistoryContext = (): ConversationHistoryContextValue => {
  const context = useContext(ConversationHistoryContext);

  if (!context) {
    throw new Error('useConversationHistoryContext must be used within ConversationHistoryProvider');
  }

  return context;
};
