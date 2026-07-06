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
  projectKanbanCardDetail,
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

describe('projectKanbanCardDetail (Class-2 read-only card detail)', () => {
  it('projects a slim card: provenance from owner+created, no draft, unknown governance, no ladder', () => {
    const detail = projectKanbanCardDetail(makeCard('a', 'research', { card_assignee: 'eve', created_at: 100, updated_at: null }));
    expect(detail.provenance.assignee).toBe('eve');
    expect(detail.provenance.createdAt).toBe(100);
    expect(detail.provenance.updatedAt).toBeNull();
    expect(detail.provenance.draftSource).toBeNull();
    expect(detail.provenance.linkedRunId).toBeNull();
    // No generated draft on a slim card.
    expect(detail.draft).toBeNull();
    // No rich governance field on a slim card -> honest 'unknown', no audit events.
    expect(detail.audit.governanceState).toBe('unknown');
    expect(detail.audit.hasAnyAuditEvent).toBe(false);
    // No ladder projection on a slim card.
    expect(detail.ladder).toBeNull();
  });

  it('surfaces the generated draft (the quality signal) with source, timestamp and text', () => {
    const detail = projectKanbanCardDetail(
      makeCard('b', 'draft', {
        generated_draft_status: 'generated',
        generated_draft_source: 'eve-inference',
        generated_draft_text: 'Erster Entwurf des Posts.',
        generated_draft_at: 4242,
      })
    );
    expect(detail.draft).not.toBeNull();
    expect(detail.draft?.source).toBe('eve-inference');
    expect(detail.draft?.at).toBe(4242);
    expect(detail.draft?.text).toBe('Erster Entwurf des Posts.');
    // The draft source also enriches provenance.
    expect(detail.provenance.draftSource).toBe('eve-inference');
  });

  it('normalizes empty/whitespace-only rich fields to null (never a blank ghost row)', () => {
    const detail = projectKanbanCardDetail(
      makeCard('c', 'draft', {
        generated_draft_status: null,
        generated_draft_source: '   ',
        generated_draft_text: '',
        linked_run_id: '',
        linked_audit_event_id: '   ',
      })
    );
    expect(detail.draft).toBeNull(); // no status, no source, no text -> no draft section
    expect(detail.provenance.draftSource).toBeNull();
    expect(detail.provenance.linkedRunId).toBeNull();
    expect(detail.audit.linkedAuditEventId).toBeNull();
    expect(detail.audit.hasAnyAuditEvent).toBe(false);
  });

  it('surfaces the governance + audit-event trail when the card carries proof', () => {
    const detail = projectKanbanCardDetail(
      makeCard('d', 'review', {
        governance_state: 'proof_write_recorded',
        linked_audit_event_id: 'evt-linked',
        generated_draft_audit_event_id: 'evt-draft',
        controller_review_status: 'pending',
        controller_review_audit_event_id: 'evt-review',
        controller_decision_status: 'approved',
        controller_decision_audit_event_id: 'evt-decision',
      })
    );
    expect(detail.audit.governanceState).toBe('proof_write_recorded');
    expect(detail.audit.linkedAuditEventId).toBe('evt-linked');
    expect(detail.audit.draftAuditEventId).toBe('evt-draft');
    expect(detail.audit.controllerReviewStatus).toBe('pending');
    expect(detail.audit.controllerReviewAuditEventId).toBe('evt-review');
    expect(detail.audit.controllerDecisionStatus).toBe('approved');
    expect(detail.audit.controllerDecisionAuditEventId).toBe('evt-decision');
    expect(detail.audit.hasAnyAuditEvent).toBe(true);
  });

  it('projects the ladder, keeping only recorded rungs and the highest stage', () => {
    const detail = projectKanbanCardDetail(
      makeCard('e', 'readyToApprove', {
        ladder: {
          highest_recorded_stage: 'observed_run',
          executor_promoted: false,
          rungs: [
            { stage: 'output_approved', recorded: true, status: null, audit_event_id: 'evt-1', recorded_at: 10 },
            { stage: 'dispatch_requested', recorded: true, status: null, audit_event_id: 'evt-2', recorded_at: 20 },
            { stage: 'observed_run', recorded: true, status: 'ok', audit_event_id: 'evt-3', recorded_at: 30 },
            // Not recorded yet -> must NOT appear in recordedStages.
            { stage: 'start_gate', recorded: false, status: null, audit_event_id: null, recorded_at: null },
          ],
        },
      })
    );
    expect(detail.ladder).not.toBeNull();
    expect(detail.ladder?.highestStage).toBe('observed_run');
    expect(detail.ladder?.executorPromoted).toBe(false);
    expect(detail.ladder?.recordedStages).toEqual(['output_approved', 'dispatch_requested', 'observed_run']);
  });

  it('treats an all-unrecorded ladder as no ladder (honest empty progress)', () => {
    const detail = projectKanbanCardDetail(
      makeCard('f', 'research', {
        ladder: {
          highest_recorded_stage: null,
          executor_promoted: false,
          rungs: [{ stage: 'output_approved', recorded: false, status: null, audit_event_id: null, recorded_at: null }],
        },
      })
    );
    expect(detail.ladder).toBeNull();
  });
});
