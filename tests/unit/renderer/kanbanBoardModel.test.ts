/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S7-VIEW — unit tests for the pure Kanban board mapping layer:
 *   - bridge payload → ordered columns/cards
 *   - the view-state projection (loading / unavailable / noBoard / ready)
 *   - the empty-state (no board DB) path
 *   - the lane-advance rule
 * No DOM required — this is the mapping seam behind the /kanban page.
 */

import { describe, expect, it } from 'vitest';
import {
  buildOrderedColumns,
  KANBAN_LANE_ORDER,
  nextKanbanLane,
  projectKanbanBoardView,
  type IKanbanBoardCard,
  type IKanbanBoardModel,
  type IKanbanBoardResult,
  type KanbanLaneKey,
} from '@renderer/pages/kanban/kanbanBoardModel';

const makeCard = (id: string, lane: KanbanLaneKey, overrides: Partial<IKanbanBoardCard> = {}): IKanbanBoardCard => ({
  card_id: id,
  card_title: `Card ${id}`,
  card_status: 'todo',
  card_assignee: 'eve',
  lane_key: lane,
  created_at: 100,
  updated_at: null,
  linked_audit_event_id: null,
  ...overrides,
});

const makeModel = (
  columns: Array<{ key: KanbanLaneKey; cards: IKanbanBoardCard[] }>,
  boardOverrides: Partial<IKanbanBoardModel['board']> = {}
): IKanbanBoardModel => ({
  board: { slug: 'marketing', db_path: '/x/kanban/boards/marketing/kanban.db', db_exists: true, table_count: 5, ...boardOverrides },
  summary: { total_cards: columns.reduce((n, c) => n + c.cards.length, 0) },
  columns,
  warnings: [],
});

const readyResult = (model: IKanbanBoardModel): IKanbanBoardResult => ({ ok: true, status: 'ready', model });

describe('buildOrderedColumns', () => {
  it('always returns exactly the five lanes in canonical order, even when empty', () => {
    const columns = buildOrderedColumns(makeModel([]));
    expect(columns.map((c) => c.key)).toEqual([...KANBAN_LANE_ORDER]);
    for (const column of columns) expect(column.cards).toEqual([]);
  });

  it('folds bridge cards into their lane and keeps unknown lanes out', () => {
    const model = makeModel([
      { key: 'research', cards: [makeCard('a', 'research')] },
      { key: 'draft', cards: [makeCard('b', 'draft'), makeCard('c', 'draft')] },
      // Unknown lane must be ignored defensively.
      { key: 'ghost' as KanbanLaneKey, cards: [makeCard('z', 'research')] },
    ]);
    const columns = buildOrderedColumns(model);
    const byKey = Object.fromEntries(columns.map((c) => [c.key, c.cards.map((card) => card.card_id)]));
    expect(byKey.research).toEqual(['a']);
    expect(byKey.draft).toEqual(['b', 'c']);
    expect(byKey.assetGeneration).toEqual([]);
    // 'z' from the ghost lane never leaks into a real lane.
    expect(columns.flatMap((c) => c.cards.map((card) => card.card_id))).not.toContain('z');
  });

  it('orders cards within a lane newest-first (updated_at over created_at)', () => {
    const model = makeModel([
      {
        key: 'research',
        cards: [
          makeCard('old', 'research', { created_at: 10, updated_at: null }),
          makeCard('newest', 'research', { created_at: 5, updated_at: 999 }),
          makeCard('mid', 'research', { created_at: 50, updated_at: null }),
        ],
      },
    ]);
    const research = buildOrderedColumns(model).find((c) => c.key === 'research');
    expect(research?.cards.map((c) => c.card_id)).toEqual(['newest', 'mid', 'old']);
  });
});

describe('projectKanbanBoardView', () => {
  it('is loading while no result has arrived', () => {
    expect(projectKanbanBoardView(null, true).kind).toBe('loading');
    expect(projectKanbanBoardView(null, false).kind).toBe('loading');
  });

  it('is unavailable on a failed bridge result and surfaces the reason honestly', () => {
    const view = projectKanbanBoardView(
      { ok: false, status: 'failed', reason_code: 'KANBAN_MARKETING_BOARD_UNAVAILABLE', message: 'preflight blocked' },
      false
    );
    expect(view).toEqual({
      kind: 'unavailable',
      reasonCode: 'KANBAN_MARKETING_BOARD_UNAVAILABLE',
      message: 'preflight blocked',
    });
  });

  it('is the honest empty state (noBoard) when the board DB does not exist yet', () => {
    const model = makeModel([], { db_exists: false });
    const view = projectKanbanBoardView(readyResult(model), false);
    expect(view.kind).toBe('noBoard');
  });

  it('is ready with ordered columns and a correct total when the board exists', () => {
    const model = makeModel([
      { key: 'research', cards: [makeCard('a', 'research')] },
      { key: 'review', cards: [makeCard('b', 'review')] },
    ]);
    const view = projectKanbanBoardView(readyResult(model), false);
    expect(view.kind).toBe('ready');
    if (view.kind !== 'ready') throw new Error('expected ready');
    expect(view.totalCards).toBe(2);
    expect(view.columns.map((c) => c.key)).toEqual([...KANBAN_LANE_ORDER]);
  });
});

describe('nextKanbanLane', () => {
  it('advances one lane at a time and stops at the last lane', () => {
    expect(nextKanbanLane('research')).toBe('draft');
    expect(nextKanbanLane('draft')).toBe('assetGeneration');
    expect(nextKanbanLane('review')).toBe('readyToApprove');
    expect(nextKanbanLane('readyToApprove')).toBeNull();
  });
});
