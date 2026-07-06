/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import {
  buildConversationFolderExtra,
  buildGroupedHistory,
  createConversationFolderId,
  getConversationFolderExpansionKey,
  getConversationFolderId,
} from '@renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';
import { buildVisibleConversationIds } from '@renderer/pages/conversation/GroupedHistory/utils/visibleConversationOrder';

const t = (key: string) => key;

const makeConv = (id: string, modified_at: number, extra: Record<string, unknown> = {}): TChatConversation =>
  ({
    id,
    name: `Chat ${id}`,
    created_at: modified_at - 1,
    modified_at,
    extra,
  }) as unknown as TChatConversation;

const idsIn = (convs: TChatConversation[]) => convs.map((c) => c.id);

const allTimelineIds = (result: ReturnType<typeof buildGroupedHistory>) =>
  result.timelineSections.flatMap((section) =>
    section.items.flatMap((item) =>
      item.type === 'workspace' ? item.workspaceGroup!.conversations.map((conversation) => conversation.id) : [item.conversation!.id]
    )
  );

describe('conversation folders (1.7.4b)', () => {
  it('groups user-folder conversations outside the normal timeline', () => {
    const result = buildGroupedHistory(
      [
        makeConv('normal', 10),
        makeConv('folder-old', 20, { group_id: 'clients', group_name: 'Clients' }),
        makeConv('folder-new', 40, { group_id: 'clients', group_name: 'Clients' }),
      ],
      t
    );

    expect(result.folderGroups).toHaveLength(1);
    expect(result.folderGroups[0].id).toBe('clients');
    expect(result.folderGroups[0].display_name).toBe('Clients');
    expect(idsIn(result.folderGroups[0].conversations)).toEqual(['folder-new', 'folder-old']);
    expect(allTimelineIds(result)).toEqual(['normal']);
  });

  it('orders folder groups by latest activity and keeps pinned/archive precedence', () => {
    const result = buildGroupedHistory(
      [
        makeConv('low', 10, { group_id: 'low', group_name: 'Low' }),
        makeConv('high', 90, { group_id: 'high', group_name: 'High' }),
        makeConv('pinned', 100, { group_id: 'high', group_name: 'High', pinned: true, pinned_at: 1 }),
        makeConv('archived', 110, { group_id: 'high', group_name: 'High', archived: true, archived_at: 2 }),
      ],
      t
    );

    expect(result.folderGroups.map((group) => group.id)).toEqual(['high', 'low']);
    expect(idsIn(result.folderGroups[0].conversations)).toEqual(['high']);
    expect(idsIn(result.pinnedConversations)).toEqual(['pinned']);
    expect(idsIn(result.archivedConversations)).toEqual(['archived']);
  });

  it('builds reversible folder extra and stable expansion keys', () => {
    const target = { id: 'clients', name: 'Clients' };
    expect(buildConversationFolderExtra(target)).toEqual({ group_id: 'clients', group_name: 'Clients' });
    expect(buildConversationFolderExtra(null)).toEqual({ group_id: undefined, group_name: undefined });
    expect(getConversationFolderId(makeConv('x', 1, buildConversationFolderExtra(target)))).toBe('clients');
    expect(getConversationFolderExpansionKey('clients')).toBe('folder:clients');
    expect(createConversationFolderId('Client Work', 123456789)).toBe('folder-client-work-21i3v9');
  });

  it('includes expanded folders in visible conversation order', () => {
    const result = buildGroupedHistory(
      [makeConv('folder-chat', 40, { group_id: 'clients', group_name: 'Clients' }), makeConv('normal', 10)],
      t
    );

    expect(
      buildVisibleConversationIds({
        ...result,
        expandedWorkspaces: ['folder:clients'],
        siderCollapsed: false,
      })
    ).toEqual(['folder-chat', 'normal']);

    expect(
      buildVisibleConversationIds({
        ...result,
        expandedWorkspaces: [],
        siderCollapsed: false,
      })
    ).toEqual(['normal']);
  });
});
