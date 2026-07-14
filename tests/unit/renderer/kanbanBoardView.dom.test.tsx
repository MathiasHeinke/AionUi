/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S7-VIEW DOM tests:
 *   1. KanbanColumnView renders each mapped card and its per-card controls,
 *      and shows the honest empty-column message when a lane has no cards.
 *   2. The seat-remount keying MIRROR: a host that keys its child by the active
 *      seat id (exactly the KanbanBoardHost pattern) REMOUNTS the child — and
 *      thus re-fires a mount-once effect — when the seat id changes, and does
 *      NOT remount when the id is stable (single-seat / legacy no-op).
 *
 * t() echoes the key so labels/testids are assertable (project convention).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
    i18n: { language: 'de' },
  }),
}));

import { KanbanColumnView } from '@renderer/pages/kanban/index';
import type { IKanbanBoardCard, IKanbanBoardColumn, KanbanLaneKey } from '@renderer/pages/kanban/kanbanBoardModel';

const makeCard = (
  id: string,
  lane: KanbanLaneKey,
  status = 'todo',
  overrides: Partial<IKanbanBoardCard> = {}
): IKanbanBoardCard => ({
  card_id: id,
  card_title: `Card ${id}`,
  card_status: status,
  card_assignee: 'eve',
  lane_key: lane,
  created_at: 1,
  updated_at: null,
  linked_audit_event_id: null,
  ...overrides,
});

describe('KanbanColumnView (payload → cards)', () => {
  it('renders one card node per mapped card with move + action controls', () => {
    const column: IKanbanBoardColumn = {
      key: 'research',
      cards: [makeCard('a', 'research'), makeCard('b', 'research')],
    };
    render(
      <KanbanColumnView
        column={column}
        busyCardId={null}
        onMoveNext={vi.fn()}
        onOpenComment={vi.fn()}
        onApplyAction={vi.fn()}
      />
    );
    expect(screen.getByTestId('kanban-lane-research')).toBeTruthy();
    expect(screen.getByTestId('kanban-card-a')).toBeTruthy();
    expect(screen.getByTestId('kanban-card-b')).toBeTruthy();
    // research is not the last lane → a move-next control exists.
    expect(screen.getByTestId('kanban-card-move-a')).toBeTruthy();
    expect(screen.getByTestId('kanban-card-comment-a')).toBeTruthy();
  });

  it('shows the honest empty-column message when a lane has no cards', () => {
    const column: IKanbanBoardColumn = { key: 'draft', cards: [] };
    render(
      <KanbanColumnView
        column={column}
        busyCardId={null}
        onMoveNext={vi.fn()}
        onOpenComment={vi.fn()}
        onApplyAction={vi.fn()}
      />
    );
    expect(screen.getByTestId('kanban-lane-draft')).toBeTruthy();
    expect(screen.queryByTestId('kanban-card-a')).toBeNull();
    expect(screen.getByText('No cards')).toBeTruthy();
  });

  it('fires the move handler with the next lane on click', () => {
    const onMove = vi.fn();
    const column: IKanbanBoardColumn = { key: 'research', cards: [makeCard('a', 'research')] };
    render(
      <KanbanColumnView
        column={column}
        busyCardId={null}
        onMoveNext={onMove}
        onOpenComment={vi.fn()}
        onApplyAction={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('kanban-card-move-a'));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][1]).toBe('draft');
  });

  it('renders the final-lane marker (no move control) in the last lane', () => {
    const column: IKanbanBoardColumn = { key: 'readyToApprove', cards: [makeCard('z', 'readyToApprove')] };
    render(
      <KanbanColumnView
        column={column}
        busyCardId={null}
        onMoveNext={vi.fn()}
        onOpenComment={vi.fn()}
        onApplyAction={vi.fn()}
      />
    );
    expect(screen.queryByTestId('kanban-card-move-z')).toBeNull();
    expect(screen.getByTestId('kanban-card-final-z')).toBeTruthy();
  });

  // H1 renderer half (belt-and-suspenders): while a seat switch is in flight the
  // page passes locked=true, and EVERY per-card write control must be disabled so
  // the operator cannot fire a write the MAIN process would refuse anyway.
  it('locked=true disables every write control on a card (H1)', () => {
    const onMove = vi.fn();
    const onApply = vi.fn();
    const onComment = vi.fn();
    const column: IKanbanBoardColumn = { key: 'research', cards: [makeCard('a', 'research')] };
    render(
      <KanbanColumnView
        column={column}
        busyCardId={null}
        locked
        onMoveNext={onMove}
        onOpenComment={onComment}
        onApplyAction={onApply}
      />
    );
    for (const testid of [
      'kanban-card-comment-a',
      'kanban-card-block-a',
      'kanban-card-complete-a',
      'kanban-card-move-a',
    ]) {
      expect((screen.getByTestId(testid) as HTMLButtonElement).disabled).toBe(true);
    }
    // A click on a disabled control fires nothing.
    fireEvent.click(screen.getByTestId('kanban-card-move-a'));
    fireEvent.click(screen.getByTestId('kanban-card-complete-a'));
    expect(onMove).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('locked=false (default) leaves the controls enabled (no-op on a single-seat install)', () => {
    const column: IKanbanBoardColumn = { key: 'research', cards: [makeCard('a', 'research')] };
    render(
      <KanbanColumnView
        column={column}
        busyCardId={null}
        onMoveNext={vi.fn()}
        onOpenComment={vi.fn()}
        onApplyAction={vi.fn()}
      />
    );
    expect((screen.getByTestId('kanban-card-move-a') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('kanban-card-comment-a') as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Class-2 (1.7.3): expandable, read-only card detail ───────────────────────
describe('KanbanCardView detail panel (Class-2)', () => {
  const renderCard = (card: IKanbanBoardCard, locked = false) =>
    render(
      <KanbanColumnView
        column={{ key: card.lane_key, cards: [card] }}
        busyCardId={null}
        locked={locked}
        onMoveNext={vi.fn()}
        onOpenComment={vi.fn()}
        onApplyAction={vi.fn()}
      />
    );

  it('is collapsed by default and expands + collapses on toggle', () => {
    renderCard(makeCard('a', 'research'));
    // Collapsed: the toggle is present, the panel is not.
    expect(screen.getByTestId('kanban-card-detail-toggle-a')).toBeTruthy();
    expect(screen.queryByTestId('kanban-card-detail-a')).toBeNull();
    // Expand.
    fireEvent.click(screen.getByTestId('kanban-card-detail-toggle-a'));
    expect(screen.getByTestId('kanban-card-detail-a')).toBeTruthy();
    // Collapse again.
    fireEvent.click(screen.getByTestId('kanban-card-detail-toggle-a'));
    expect(screen.queryByTestId('kanban-card-detail-a')).toBeNull();
  });

  it('surfaces the generated draft text (the quality signal) when expanded', () => {
    renderCard(
      makeCard('b', 'draft', 'todo', {
        generated_draft_status: 'generated',
        generated_draft_source: 'eve-inference',
        generated_draft_text: 'Erster Entwurf des Posts.',
        generated_draft_at: 42,
      })
    );
    fireEvent.click(screen.getByTestId('kanban-card-detail-toggle-b'));
    const draft = screen.getByTestId('kanban-card-detail-draft-b');
    expect(draft.textContent).toContain('Erster Entwurf des Posts.');
  });

  it('shows recorded ladder rungs and hides unrecorded ones when expanded', () => {
    renderCard(
      makeCard('c', 'readyToApprove', 'todo', {
        ladder: {
          highest_recorded_stage: 'observed_run',
          executor_promoted: false,
          rungs: [
            { stage: 'output_approved', recorded: true, status: null, audit_event_id: 'e1', recorded_at: 1 },
            { stage: 'observed_run', recorded: true, status: 'ok', audit_event_id: 'e2', recorded_at: 2 },
            { stage: 'start_gate', recorded: false, status: null, audit_event_id: null, recorded_at: null },
          ],
        },
      })
    );
    fireEvent.click(screen.getByTestId('kanban-card-detail-toggle-c'));
    const ladder = screen.getByTestId('kanban-card-detail-ladder-c');
    expect(ladder.textContent).toContain('output_approved');
    expect(ladder.textContent).toContain('observed_run');
    // Unrecorded rung must not render as a reached stage.
    expect(ladder.textContent).not.toContain('start_gate');
  });

  it('detail remains viewable while locked (read-only view is always safe during a seat switch)', () => {
    renderCard(makeCard('d', 'research'), true);
    // The toggle is NOT a write control — it must stay enabled even when locked.
    const toggle = screen.getByTestId('kanban-card-detail-toggle-d') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByTestId('kanban-card-detail-d')).toBeTruthy();
  });
});

// ── Seat-remount keying MIRROR (local structural mirror — kept as a sanity check) ─
// A host that renders <Body key={activeSeatId} /> so a seat switch remounts the
// body. A mount-once effect (the board read) must fire once per mount, i.e. once
// per DISTINCT seat id, and NOT re-fire on a stable id.

describe('seat-remount keying (structural mirror)', () => {
  const Body: React.FC<{ onMount: () => void }> = ({ onMount }) => {
    React.useEffect(() => {
      onMount();
    }, [onMount]);
    return <div data-testid='kanban-body' />;
  };

  const Host: React.FC<{ seatId: string; onMount: () => void }> = ({ seatId, onMount }) => (
    <Body key={seatId} onMount={onMount} />
  );

  it('remounts the body (re-fires the mount-once read) when the seat id changes', () => {
    const onMount = vi.fn();
    const { rerender } = render(<Host seatId='seat-a' onMount={onMount} />);
    expect(onMount).toHaveBeenCalledTimes(1);
    rerender(<Host seatId='seat-a' onMount={onMount} />);
    expect(onMount).toHaveBeenCalledTimes(1);
    rerender(<Host seatId='seat-b' onMount={onMount} />);
    expect(onMount).toHaveBeenCalledTimes(2);
    rerender(<Host seatId='seat-a' onMount={onMount} />);
    expect(onMount).toHaveBeenCalledTimes(3);
  });
});
