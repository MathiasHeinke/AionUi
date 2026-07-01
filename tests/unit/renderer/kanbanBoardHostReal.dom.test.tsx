/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * REAL KanbanBoardHost / KanbanBoardPage seam tests (test-honesty mirror (d) + H2
 * board-slug unify + H1 renderer write-lock). These drive the ACTUAL default-
 * exported KanbanBoardHost — not a hand-written structural mirror — so the load-
 * bearing wiring (key={useActiveSeatId()}, boardSlug='default', locked=switching)
 * is exercised end-to-end against the real component.
 *
 * Proves:
 *  (d) the REAL KanbanBoardHost REMOUNTS its page (re-fires the mount-once board
 *      read) when the active seat id changes, and does NOT on a stable id;
 *  H2  the page reads/writes the 'default' board slug — the SAME board EVE's native
 *      Hermes tools author (HERMES_HOME/kanban.db) — not the disconnected
 *      'marketing' board;
 *  H1  while useSeatAccess().switching is true, the create button is disabled.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// STABLE t + i18n identity across renders so the page's `refresh` useCallback (deps
// [t]) keeps a stable identity — otherwise a fresh t each render would re-fire the
// mount-once effect and mask/confuse the remount assertion (a test artifact).
const stableT = (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k;
const stableI18n = { language: 'de' };
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT, i18n: stableI18n }),
}));

// The board read runs through this provider mock — capture the boardSlug it asks for.
const boardInvoke = vi.fn();
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      invoke: (req?: unknown) => {
        if (channel === 'command-eve.kanban-marketing-board') return boardInvoke(req);
        return Promise.resolve({ success: true, data: null });
      },
    }),
  },
}));

vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

// Drive the two seat hooks the host + page consume.
let activeSeatId = 'seat-a';
const useActiveSeatIdMock = vi.fn(() => activeSeatId);
vi.mock('@renderer/hooks/useActiveSeatId', () => ({ useActiveSeatId: () => useActiveSeatIdMock() }));

let switching = false;
vi.mock('@renderer/hooks/useSeatAccess', () => ({
  useSeatAccess: () => ({
    loading: false,
    access: { role: 'admin', canSwitch: true, pinnedSeatId: 'seat-a', activeSeatId, seats: [] },
    switching,
    lastSwitchError: null,
    switchErrorNonce: 0,
    refresh: vi.fn(),
    switchTo: vi.fn(),
  }),
}));

import KanbanBoardHost from '@renderer/pages/kanban/index';

const boardEnvelope = (slug: string) => ({
  success: true,
  data: {
    version: 'command-eve-kanban-marketing-board/v0',
    ok: true,
    status: 'ready',
    model: {
      board: { slug, db_path: `/seat/home/kanban.db`, db_exists: true, table_count: 3 },
      summary: { total_cards: 0 },
      columns: [],
    },
    source: { generated_by: 'command-eve-kanban-marketing-board-core', hermes_home: '/seat/home' },
  },
});

beforeEach(() => {
  activeSeatId = 'seat-a';
  switching = false;
  useActiveSeatIdMock.mockClear();
  boardInvoke.mockReset().mockImplementation((req: { boardSlug?: string }) => Promise.resolve(boardEnvelope(req?.boardSlug ?? 'default')));
});
afterEach(() => vi.clearAllMocks());

describe('H2 — the REAL page reads the DEFAULT board (the board EVE writes)', () => {
  it('the board read asks for boardSlug="default", not "marketing"', async () => {
    render(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalled());
    const firstCall = boardInvoke.mock.calls[0][0] as { boardSlug?: string };
    expect(firstCall.boardSlug).toBe('default');
    // And it is NEVER the disconnected 'marketing' board.
    for (const c of boardInvoke.mock.calls) {
      expect((c[0] as { boardSlug?: string }).boardSlug).not.toBe('marketing');
    }
  });
});

describe('test-honesty mirror (d) — the REAL KanbanBoardHost remounts on seat switch', () => {
  it('re-fires the mount-once board read when the active seat id changes, not on a stable id', async () => {
    const { rerender } = render(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(1));

    // Stable seat id → a plain re-render does NOT remount → no extra read.
    rerender(<KanbanBoardHost />);
    await Promise.resolve();
    expect(boardInvoke).toHaveBeenCalledTimes(1);

    // Seat switch → the host key (useActiveSeatId) changes → REMOUNT → fresh read.
    activeSeatId = 'seat-b';
    rerender(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(2));

    // Switch back → remount again (fresh read for seat-a, no stale leak).
    activeSeatId = 'seat-a';
    rerender(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(3));
  });
});

describe('H1 renderer half — create button disabled while switching', () => {
  it('the "Neue Aufgabe" button is disabled when useSeatAccess().switching is true', async () => {
    switching = true;
    render(<KanbanBoardHost />);
    await waitFor(() => expect(screen.getByTestId('kanban-card-create-open')).toBeTruthy());
    expect((screen.getByTestId('kanban-card-create-open') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the create button is enabled when not switching (board ready)', async () => {
    switching = false;
    render(<KanbanBoardHost />);
    // Wait for the board read to resolve into a READY view (board-slug tag renders).
    await waitFor(() => expect(screen.getByTestId('kanban-board-slug')).toBeTruthy());
    expect((screen.getByTestId('kanban-card-create-open') as HTMLButtonElement).disabled).toBe(false);
  });
});
