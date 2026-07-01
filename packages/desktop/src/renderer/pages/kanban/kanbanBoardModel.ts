/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S7-VIEW — pure, side-effect-free mapping layer for the per-seat Kanban board
 * page. Everything here is presentation logic over the EXISTING native-Hermes
 * kanban bridge payload (`command-eve-kanban-marketing-board/v0`). It is split
 * out from the React page so the payload→columns/cards projection, the empty
 * state, and the lane-advance rule are unit-testable without a DOM.
 *
 * The board itself lives under HERMES_HOME/kanban/boards/{slug}/kanban.db, which
 * is PHYSICALLY per-seat (HERMES_HOME is per-seat). The renderer therefore keys
 * the whole page host on the active seat id so a seat switch remounts and
 * re-reads under the new seat's board — see index.tsx.
 */

// The five ordered native marketing lanes the board bridge exposes today. Kept
// in advancement order so "move to next lane" is a deterministic single step.
export const KANBAN_LANE_ORDER = ['research', 'draft', 'assetGeneration', 'review', 'readyToApprove'] as const;

export type KanbanLaneKey = (typeof KANBAN_LANE_ORDER)[number];

export type KanbanCardAction = 'comment' | 'block' | 'unblock' | 'complete';

// Structural subset of the bridge card we render. The bridge returns more
// fields; we only depend on these, so the projection stays resilient to
// additive backend growth.
export interface IKanbanBoardCard {
  card_id: string;
  card_title: string;
  card_status: string;
  card_assignee: string;
  lane_key: KanbanLaneKey;
  created_at: number;
  updated_at: number | null;
  linked_audit_event_id: string | null;
}

export interface IKanbanBoardColumn {
  key: KanbanLaneKey;
  cards: IKanbanBoardCard[];
}

// Structural subset of `command-eve-kanban-marketing-board/v0` model.board +
// model.columns + model.summary that the page reads.
export interface IKanbanBoardModel {
  board: {
    slug: string;
    db_path: string;
    db_exists: boolean;
    table_count: number;
  };
  summary: {
    total_cards: number;
  };
  columns: Array<{ key: KanbanLaneKey; cards: IKanbanBoardCard[] }>;
  warnings?: string[];
}

// Structural subset of the bridge result envelope.
export interface IKanbanBoardResult {
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  model?: IKanbanBoardModel;
}

export type KanbanBoardViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reasonCode: string; message: string }
  // The board slug has no physical DB yet in this seat. EVE can create one from
  // chat; the renderer must NOT auto-create it (honest empty state).
  | { kind: 'noBoard'; reasonCode: string }
  | { kind: 'ready'; model: IKanbanBoardModel; columns: IKanbanBoardColumn[]; totalCards: number };

/**
 * Project a bridge result (or the absence of one) into the single view state the
 * page renders. Pure — no bridge calls, no DOM, no time.
 *
 * - null result while a request is in flight -> loading.
 * - failed status -> unavailable (surface reason_code + message honestly).
 * - ready but the board DB does not exist yet -> noBoard (honest empty state;
 *   the seat has no board — EVE can create one, the renderer never does).
 * - ready with a model -> ready, columns ordered by KANBAN_LANE_ORDER, cards
 *   ordered newest-first within a lane.
 */
export function projectKanbanBoardView(result: IKanbanBoardResult | null, loading: boolean): KanbanBoardViewState {
  if (loading && !result) return { kind: 'loading' };
  if (!result) return { kind: 'loading' };

  if (result.status === 'failed' || (!result.model && !result.ok)) {
    return {
      kind: 'unavailable',
      reasonCode: result.reason_code || 'KANBAN_BOARD_UNAVAILABLE',
      message: result.message || '',
    };
  }

  const model = result.model;
  if (!model) {
    return { kind: 'unavailable', reasonCode: result.reason_code || 'KANBAN_BOARD_UNAVAILABLE', message: result.message || '' };
  }

  // A board slug can resolve to a directory with no kanban.db yet (seat never
  // asked EVE to create a board). db_exists is the authoritative signal.
  if (!model.board.db_exists) {
    return { kind: 'noBoard', reasonCode: result.reason_code || 'KANBAN_BOARD_NOT_CREATED' };
  }

  const columns = buildOrderedColumns(model);
  const totalCards = columns.reduce((sum, column) => sum + column.cards.length, 0);
  return { kind: 'ready', model, columns, totalCards };
}

/**
 * Build the ordered column list from a board model. Always returns exactly the
 * KANBAN_LANE_ORDER lanes (so an empty lane still renders its column), folding
 * any cards the bridge reported under each lane and sorting cards newest-first.
 */
export function buildOrderedColumns(model: IKanbanBoardModel): IKanbanBoardColumn[] {
  const cardsByLane = new Map<KanbanLaneKey, IKanbanBoardCard[]>();
  for (const lane of KANBAN_LANE_ORDER) cardsByLane.set(lane, []);
  for (const column of model.columns ?? []) {
    const bucket = cardsByLane.get(column.key);
    if (!bucket) continue; // ignore unknown lanes defensively
    for (const card of column.cards ?? []) bucket.push(card);
  }
  return KANBAN_LANE_ORDER.map((lane) => ({
    key: lane,
    cards: (cardsByLane.get(lane) ?? [])
      .slice()
      .sort((left, right) => (right.updated_at || right.created_at) - (left.updated_at || left.created_at)),
  }));
}

/** The lane a card advances to on "move next", or null when it is in the last lane. */
export function nextKanbanLane(lane: KanbanLaneKey): KanbanLaneKey | null {
  const index = KANBAN_LANE_ORDER.indexOf(lane);
  if (index < 0 || index >= KANBAN_LANE_ORDER.length - 1) return null;
  return KANBAN_LANE_ORDER[index + 1];
}

/** Stable per-intent idempotency token so a card create dedupes on retry. */
export function generateKanbanClientToken(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `cmd-eve-kanban-${cryptoApi.randomUUID()}`;
  }
  return `cmd-eve-kanban-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
