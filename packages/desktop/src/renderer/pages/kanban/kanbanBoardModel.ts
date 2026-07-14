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
  // Class-2 (1.7.3) — additive read-only provenance / quality / audit-trail
  // fields the expandable card detail surfaces. Every one of these is ALREADY
  // present at runtime in the `command-eve-kanban-marketing-board/v0` card the
  // bridge returns (backend `parseMarketingCards`); they were simply not typed
  // in this structural subset. Kept optional so slim/synthetic cards (tests,
  // future defensive payloads) still satisfy the type — the detail projection
  // treats a missing field as "not available", never as a hard error.
  card_priority?: number;
  linked_run_id?: string | null;
  generated_draft_status?: 'generated' | null;
  generated_draft_audit_event_id?: string | null;
  generated_draft_source?: string | null;
  generated_draft_text?: string | null;
  generated_draft_at?: number | null;
  governance_state?: 'read_only' | 'proof_write_recorded' | 'unknown';
  controller_review_status?: 'pending' | null;
  controller_review_audit_event_id?: string | null;
  controller_decision_status?: string | null;
  controller_decision_audit_event_id?: string | null;
  ladder?: IKanbanBoardCardLadder;
}

// Structural subset of the backend ladder projection the bridge returns per card.
export interface IKanbanBoardCardLadder {
  highest_recorded_stage: string | null;
  executor_promoted: boolean;
  rungs: Array<{
    stage: string;
    recorded: boolean;
    status: string | null;
    audit_event_id: string | null;
    recorded_at: number | null;
  }>;
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
    return {
      kind: 'unavailable',
      reasonCode: result.reason_code || 'KANBAN_BOARD_UNAVAILABLE',
      message: result.message || '',
    };
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

// ── Class-2 (1.7.3) — card detail projection ────────────────────────────────
// The expandable card panel shows WHERE a card came from (provenance), WHAT was
// produced (the generated draft = the quality signal), and the AUDIT trail
// (governance state + linked audit-event ids + the marketing ladder). All of it
// is a pure read of fields already on the card — the panel never mutates, never
// dispatches, and touches no governance gate. Timestamp formatting + i18n labels
// live in the component so this projection stays locale-free and unit-testable.

/** Provenance: who owns it, what produced it, and when. */
export interface IKanbanCardProvenance {
  assignee: string | null;
  draftSource: string | null;
  linkedRunId: string | null;
  createdAt: number;
  updatedAt: number | null;
}

/** The generated draft (present only once the executor recorded one) = quality. */
export interface IKanbanCardDraft {
  source: string | null;
  at: number | null;
  text: string | null;
}

/** The audit trail: governance state + every linked audit-event id we hold. */
export interface IKanbanCardAudit {
  governanceState: 'read_only' | 'proof_write_recorded' | 'unknown';
  linkedAuditEventId: string | null;
  draftAuditEventId: string | null;
  controllerReviewStatus: 'pending' | null;
  controllerReviewAuditEventId: string | null;
  controllerDecisionStatus: string | null;
  controllerDecisionAuditEventId: string | null;
  hasAnyAuditEvent: boolean;
}

/** The marketing ladder rungs the A1 backend recorded for this card. */
export interface IKanbanCardLadderView {
  highestStage: string | null;
  executorPromoted: boolean;
  recordedStages: string[];
}

export interface IKanbanCardDetail {
  provenance: IKanbanCardProvenance;
  // null when the executor has not recorded a generated draft yet.
  draft: IKanbanCardDraft | null;
  audit: IKanbanCardAudit;
  // null when the card carries no ladder projection or no rung is recorded yet.
  ladder: IKanbanCardLadderView | null;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Project a board card into its read-only detail view. Pure: no time, no DOM, no
 * bridge. A missing field is "not available" (null), never an error — so a slim
 * or synthetic card projects cleanly with empty sections rather than throwing.
 */
export function projectKanbanCardDetail(card: IKanbanBoardCard): IKanbanCardDetail {
  const draftSource = normalizeText(card.generated_draft_source);
  const draftText = normalizeText(card.generated_draft_text);
  const hasDraft = card.generated_draft_status === 'generated' || draftText !== null || draftSource !== null;

  const linkedAuditEventId = normalizeText(card.linked_audit_event_id);
  const draftAuditEventId = normalizeText(card.generated_draft_audit_event_id);
  const controllerReviewAuditEventId = normalizeText(card.controller_review_audit_event_id);
  const controllerDecisionAuditEventId = normalizeText(card.controller_decision_audit_event_id);

  const ladder = card.ladder;
  // Runtime-defensive (Codex 1.7.3 #4): a slim/malformed payload could carry a
  // non-array `rungs`; treat anything but an array as no rungs so expanding a card
  // never throws. A missing highest_recorded_stage is also tolerated.
  const ladderRungs = Array.isArray(ladder?.rungs) ? ladder.rungs : [];
  const recordedStages = ladderRungs.filter((rung) => rung && rung.recorded).map((rung) => rung.stage);
  const highestStage = typeof ladder?.highest_recorded_stage === 'string' ? ladder.highest_recorded_stage : null;
  const hasLadder = !!ladder && (highestStage !== null || recordedStages.length > 0);

  return {
    provenance: {
      assignee: normalizeText(card.card_assignee),
      draftSource,
      linkedRunId: normalizeText(card.linked_run_id),
      createdAt: card.created_at,
      updatedAt: card.updated_at,
    },
    draft: hasDraft
      ? {
          source: draftSource,
          at: typeof card.generated_draft_at === 'number' ? card.generated_draft_at : null,
          text: draftText,
        }
      : null,
    audit: {
      governanceState: card.governance_state ?? 'unknown',
      linkedAuditEventId,
      draftAuditEventId,
      controllerReviewStatus: card.controller_review_status ?? null,
      controllerReviewAuditEventId,
      controllerDecisionStatus: normalizeText(card.controller_decision_status),
      controllerDecisionAuditEventId,
      hasAnyAuditEvent: !!(
        linkedAuditEventId ||
        draftAuditEventId ||
        controllerReviewAuditEventId ||
        controllerDecisionAuditEventId
      ),
    },
    ladder: hasLadder
      ? {
          highestStage,
          executorPromoted: ladder!.executor_promoted === true,
          recordedStages,
        }
      : null,
  };
}

/** Stable per-intent idempotency token so a card create dedupes on retry. */
export function generateKanbanClientToken(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `cmd-eve-kanban-${cryptoApi.randomUUID()}`;
  }
  return `cmd-eve-kanban-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
