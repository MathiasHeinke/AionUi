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

const makeCard = (id: string, lane: KanbanLaneKey, status = 'todo'): IKanbanBoardCard => ({
  card_id: id,
  card_title: `Card ${id}`,
  card_status: status,
  card_assignee: 'eve',
  lane_key: lane,
  created_at: 1,
  updated_at: null,
  linked_audit_event_id: null,
});

describe('KanbanColumnView (payload → cards)', () => {
  it('renders one card node per mapped card with move + action controls', () => {
    const column: IKanbanBoardColumn = { key: 'research', cards: [makeCard('a', 'research'), makeCard('b', 'research')] };
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
