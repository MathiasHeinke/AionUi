/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.7.4a — soft-archive is the REVERSIBLE alternative to the irreversible hard
 * delete. These tests pin the safety-critical behaviour: an archived conversation
 * leaves the main list (pinned + timeline) entirely but is preserved in the
 * Archive section, newest-archived first, so per-client work is never lost.
 */

import { describe, expect, it } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import {
  buildGroupedHistory,
  isConversationArchived,
} from '@renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';

const t = (key: string) => key;

const makeConv = (id: string, extra: Record<string, unknown> = {}): TChatConversation =>
  ({ id, name: `Chat ${id}`, createdAt: 1000, updatedAt: 1000, extra }) as unknown as TChatConversation;

const idsIn = (convs: TChatConversation[]) => convs.map((c) => c.id);

const allTimelineIds = (result: ReturnType<typeof buildGroupedHistory>) =>
  result.timelineSections.flatMap((s) =>
    s.items.flatMap((item) =>
      item.type === 'workspace' ? item.workspaceGroup!.conversations.map((c) => c.id) : [item.conversation!.id]
    )
  );

describe('isConversationArchived', () => {
  it('is true only when extra.archived is set', () => {
    expect(isConversationArchived(makeConv('a', { archived: true }))).toBe(true);
    expect(isConversationArchived(makeConv('b', { archived: false }))).toBe(false);
    expect(isConversationArchived(makeConv('c'))).toBe(false);
  });
});

describe('buildGroupedHistory — archive filtering (1.7.4a)', () => {
  it('removes an archived conversation from pinned + timeline and puts it in archivedConversations', () => {
    const result = buildGroupedHistory([makeConv('normal'), makeConv('arch', { archived: true, archived_at: 5 })], t);
    expect(idsIn(result.archivedConversations)).toEqual(['arch']);
    expect(idsIn(result.pinnedConversations)).not.toContain('arch');
    expect(allTimelineIds(result)).not.toContain('arch');
    // The normal one still shows in the timeline.
    expect(allTimelineIds(result)).toContain('normal');
  });

  it('archive wins over pin — an archived+pinned conversation goes to Archive, not Pinned', () => {
    const result = buildGroupedHistory([makeConv('p', { pinned: true, archived: true, archived_at: 1 })], t);
    expect(idsIn(result.pinnedConversations)).toEqual([]);
    expect(idsIn(result.archivedConversations)).toEqual(['p']);
  });

  it('orders the Archive section newest-archived first (archived_at desc)', () => {
    const result = buildGroupedHistory(
      [
        makeConv('old', { archived: true, archived_at: 10 }),
        makeConv('new', { archived: true, archived_at: 99 }),
        makeConv('mid', { archived: true, archived_at: 50 }),
      ],
      t
    );
    expect(idsIn(result.archivedConversations)).toEqual(['new', 'mid', 'old']);
  });

  it('never surfaces a team conversation, archived or not', () => {
    const result = buildGroupedHistory(
      [makeConv('team', { team_id: 'x', archived: true, archived_at: 1 }), makeConv('team2', { teamId: 'y' })],
      t
    );
    expect(idsIn(result.archivedConversations)).toEqual([]);
    expect(allTimelineIds(result)).not.toContain('team2');
  });
});
