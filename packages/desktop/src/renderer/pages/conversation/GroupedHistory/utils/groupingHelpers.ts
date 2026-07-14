/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { getActivityTime } from '@/renderer/utils/chat/timeline';
import { getWorkspaceDisplayName } from '@/renderer/utils/workspace/workspace';
import { getWorkspaceUpdateTime } from '@/renderer/utils/workspace/workspaceHistory';
import { getWorkspaceCustomName } from '@/renderer/utils/workspace/workspaceName';

import type { ConversationFolderGroup, GroupedHistoryResult, TimelineItem, TimelineSection } from '../types';
import { getConversationSortOrder } from './sortOrderHelpers';

export type ConversationFolderTarget = {
  id: string;
  name: string;
};

type ConversationFolderExtra = {
  group_id?: string | null;
  group_name?: string | null;
};

export const isConversationPinned = (conversation: TChatConversation): boolean => {
  const extra = conversation.extra as { pinned?: boolean } | undefined;
  return Boolean(extra?.pinned);
};

// 1.7.4a — archive is a REVERSIBLE soft-hide (vs the irreversible hard delete):
// an archived conversation leaves the main list but is fully restorable from the
// Archive section. Per-client work is never silently lost.
export const isConversationArchived = (conversation: TChatConversation): boolean => {
  const extra = conversation.extra as { archived?: boolean } | undefined;
  return Boolean(extra?.archived);
};

export const getConversationArchivedAt = (conversation: TChatConversation): number => {
  const extra = conversation.extra as { archived_at?: number } | undefined;
  return typeof extra?.archived_at === 'number' ? extra.archived_at : 0;
};

export const isCronJobConversation = (conversation: TChatConversation): boolean => {
  const extra = conversation.extra as { cron_job_id?: string } | undefined;
  return Boolean(extra?.cron_job_id);
};

export const getConversationPinnedAt = (conversation: TChatConversation): number => {
  const extra = conversation.extra as { pinned_at?: number } | undefined;
  if (typeof extra?.pinned_at === 'number') {
    return extra.pinned_at;
  }
  return 0;
};

const normalizeFolderText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const getConversationFolderId = (conversation: TChatConversation): string | null => {
  const extra = conversation.extra as ConversationFolderExtra | undefined;
  return normalizeFolderText(extra?.group_id);
};

export const getConversationFolderName = (conversation: TChatConversation): string | null => {
  const extra = conversation.extra as ConversationFolderExtra | undefined;
  return normalizeFolderText(extra?.group_name);
};

export const getConversationFolderExpansionKey = (folderId: string): string => `folder:${folderId}`;

export const createConversationFolderId = (name: string, now = Date.now()): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `folder-${slug || 'folder'}-${now.toString(36)}`;
};

export const buildConversationFolderExtra = (
  target: ConversationFolderTarget | null
): Partial<TChatConversation['extra']> & ConversationFolderExtra => ({
  group_id: target?.id ?? null,
  group_name: target?.name ?? null,
});

export const groupConversationsByWorkspace = (
  conversations: TChatConversation[],
  t: (key: string) => string
): TimelineSection[] => {
  const allWorkspaceGroups = new Map<string, TChatConversation[]>();
  const withoutWorkspaceConvs: TChatConversation[] = [];

  conversations.forEach((conv) => {
    const workspace = conv.extra?.workspace;
    const custom_workspace = conv.extra?.custom_workspace;

    if (custom_workspace && workspace) {
      if (!allWorkspaceGroups.has(workspace)) {
        allWorkspaceGroups.set(workspace, []);
      }
      allWorkspaceGroups.get(workspace)!.push(conv);
    } else {
      withoutWorkspaceConvs.push(conv);
    }
  });

  const items: TimelineItem[] = [];

  allWorkspaceGroups.forEach((convList, workspace) => {
    const sortedConvs = [...convList].toSorted((a, b) => getActivityTime(b) - getActivityTime(a));
    const latestConversationTime = getActivityTime(sortedConvs[0]);
    const updateTime = getWorkspaceUpdateTime(workspace);
    const time = Math.max(updateTime, latestConversationTime);
    items.push({
      type: 'workspace',
      time,
      workspaceGroup: {
        workspace,
        // This grouping path only sees custom (user-chosen) workspaces —
        // non-custom conversations end up in `withoutWorkspaceConvs` above
        // and never reach this helper. Passing `false` is therefore correct
        // without consulting `extra.is_temporary_workspace` per-row.
        // A user-set project rename (workspaceName override) wins over the
        // path-derived label; clearing the override restores the default.
        display_name: getWorkspaceCustomName(workspace) ?? getWorkspaceDisplayName(workspace, false, t),
        conversations: sortedConvs,
      },
    });
  });

  withoutWorkspaceConvs.forEach((conv) => {
    items.push({
      type: 'conversation',
      time: getActivityTime(conv),
      conversation: conv,
    });
  });

  items.sort((a, b) => b.time - a.time);

  if (items.length === 0) return [];

  return [
    {
      timeline: t('conversation.history.recents'),
      items,
    },
  ];
};

const splitConversationsByUserFolder = (
  conversations: TChatConversation[],
  t: (key: string) => string
): { folderGroups: ConversationFolderGroup[]; ungroupedConversations: TChatConversation[] } => {
  const folderMap = new Map<string, TChatConversation[]>();
  const ungroupedConversations: TChatConversation[] = [];

  conversations.forEach((conversation) => {
    const folderId = getConversationFolderId(conversation);
    if (!folderId) {
      ungroupedConversations.push(conversation);
      return;
    }

    if (!folderMap.has(folderId)) {
      folderMap.set(folderId, []);
    }
    folderMap.get(folderId)!.push(conversation);
  });

  const folderGroups = [...folderMap.entries()]
    .map(([folderId, folderConversations]) => {
      const sortedConversations = [...folderConversations].toSorted((a, b) => getActivityTime(b) - getActivityTime(a));
      const displayName =
        sortedConversations.map(getConversationFolderName).find((name): name is string => Boolean(name)) ??
        t('conversation.history.untitledFolder');

      return {
        id: folderId,
        display_name: displayName,
        conversations: sortedConversations,
        time: getActivityTime(sortedConversations[0]),
      };
    })
    .toSorted((a, b) => b.time - a.time);

  return { folderGroups, ungroupedConversations };
};

/** Check whether a conversation belongs to a team (should be hidden from sidebar). */
const isTeamConversation = (conversation: TChatConversation): boolean => {
  const extra = conversation.extra as { team_id?: string; teamId?: string } | undefined;
  return Boolean(extra?.team_id || extra?.teamId);
};

export const buildGroupedHistory = (
  conversations: TChatConversation[],
  t: (key: string) => string
): GroupedHistoryResult => {
  // Filter out team-owned conversations; they are only visible via the Teams panel.
  // Archived conversations (1.7.4a) leave the main list entirely and live only in
  // the collapsible Archive section — so pinned/timeline never show an archived row.
  const visibleConversations = conversations.filter(
    (conv) => !isTeamConversation(conv) && !isConversationArchived(conv)
  );

  const archivedConversations = conversations
    .filter((conversation) => !isTeamConversation(conversation) && isConversationArchived(conversation))
    .toSorted((a, b) => getConversationArchivedAt(b) - getConversationArchivedAt(a));

  const pinnedConversations = visibleConversations
    .filter((conversation) => isConversationPinned(conversation))
    .toSorted((a, b) => {
      const orderA = getConversationSortOrder(a);
      const orderB = getConversationSortOrder(b);
      if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
      if (orderA !== undefined) return -1;
      if (orderB !== undefined) return 1;
      return getConversationPinnedAt(b) - getConversationPinnedAt(a);
    });

  const normalConversations = visibleConversations.filter(
    (conversation) => !isConversationPinned(conversation) && !isCronJobConversation(conversation)
  );
  const { folderGroups, ungroupedConversations } = splitConversationsByUserFolder(normalConversations, t);

  return {
    pinnedConversations,
    folderGroups,
    archivedConversations,
    timelineSections: groupConversationsByWorkspace(ungroupedConversations, t),
  };
};
