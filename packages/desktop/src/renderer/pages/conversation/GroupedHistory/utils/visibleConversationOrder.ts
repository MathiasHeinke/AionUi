import type { GroupedHistoryResult } from '../types';
import { getConversationFolderExpansionKey } from './groupingHelpers';

type VisibleConversationOrderInput = GroupedHistoryResult & {
  expandedWorkspaces: string[];
  siderCollapsed: boolean;
};

export const buildVisibleConversationIds = ({
  pinnedConversations,
  folderGroups,
  timelineSections,
  expandedWorkspaces,
  siderCollapsed,
}: VisibleConversationOrderInput): string[] => {
  const expandedWorkspaceSet = new Set(expandedWorkspaces);
  const visibleConversationIds: string[] = [];

  pinnedConversations.forEach((conversation) => {
    visibleConversationIds.push(conversation.id);
  });

  folderGroups.forEach((folder) => {
    const folderKey = getConversationFolderExpansionKey(folder.id);
    if (!siderCollapsed && !expandedWorkspaceSet.has(folderKey)) {
      return;
    }

    folder.conversations.forEach((conversation) => {
      visibleConversationIds.push(conversation.id);
    });
  });

  timelineSections.forEach((section) => {
    section.items.forEach((item) => {
      if (item.type === 'conversation' && item.conversation) {
        visibleConversationIds.push(item.conversation.id);
        return;
      }

      if (item.type === 'workspace' && item.workspaceGroup) {
        if (!siderCollapsed && !expandedWorkspaceSet.has(item.workspaceGroup.workspace)) {
          return;
        }

        item.workspaceGroup.conversations.forEach((conversation) => {
          visibleConversationIds.push(conversation.id);
        });
      }
    });
  });

  return visibleConversationIds;
};
