/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Real default-exported native Kanban host wiring and seat-remount proof. */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const stableT = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT, i18n: { language: 'de' } }),
}));

const boardInvoke = vi.fn();
const computerStatusInvoke = vi.fn();
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      invoke: (request?: unknown) => {
        if (channel === 'command-eve.native-kanban-board') return boardInvoke(request);
        if (channel === 'command-eve.computer-use-status') return computerStatusInvoke(request);
        return Promise.resolve({ success: true, data: { ok: true, state: 'ready' } });
      },
    }),
  },
}));

vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

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

const statuses = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'];
const boardEnvelope = (task?: Record<string, unknown>) => ({
  success: true,
  data: {
    version: 'command-eve-native-kanban/v1',
    ok: true,
    state: 'ready',
    board: {
      slug: 'default',
      name: 'Command EVE',
      description: 'Native Hermes board',
      project_id: null,
      columns: statuses.map((name) => ({ name, tasks: task?.status === name ? [task] : [] })),
      latest_event_id: 0,
      task_count: 0,
    },
    source: {
      adapter: 'hermes-plugin-api',
      hermes_version: '0.20.0',
      board_slug: 'default',
      home_scope_id: 'seat-home-proof',
      seat_scope: 'active-hermes-home',
    },
  },
});

const computerEnvelope = () => ({
  success: true,
  data: {
    version: 'command-eve-computer-use/v1',
    ok: true,
    state: 'needs_install',
    platform: 'darwin',
    platform_supported: true,
    installed: false,
    ready: null,
    can_install: true,
    can_grant: true,
    can_revoke_automatically: false,
    accessibility: null,
    screen_recording: null,
    screen_recording_capturable: null,
    checks: [],
    provenance: {
      resolution: 'missing',
      executable_name: null,
      executable_sha256: null,
      expected_executable_sha256: 'eae725a09e0cdbda4bb37058a0393b86f7c97b5dda3769a10b1d79269ba8b334',
      checksum_verified: false,
      driver_version: null,
      expected_version: '0.12.6',
      release_tag: 'cua-driver-rs-v0.12.6',
      expected_identity: 'com.trycua.driver',
      expected_team_identifier: 'YCK386LBJ7',
      installer_source: 'hermes-0.20-upstream-pinned',
      identity: null,
      team_identifier: null,
      signature_valid: null,
    },
  },
});

beforeEach(() => {
  activeSeatId = 'seat-a';
  switching = false;
  useActiveSeatIdMock.mockClear();
  boardInvoke.mockReset().mockResolvedValue(boardEnvelope());
  computerStatusInvoke.mockReset().mockResolvedValue(computerEnvelope());
});

afterEach(() => vi.clearAllMocks());

describe('native Hermes board host', () => {
  it('reads the adapter-owned default board without a renderer-selected DB or slug', async () => {
    render(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(1));
    expect(boardInvoke.mock.calls[0][0]).toBeUndefined();
    expect(await screen.findByText('kanban.native.board: Command EVE')).toBeTruthy();
    expect(screen.getByText('Hermes 0.20.0')).toBeTruthy();
    expect(screen.getByTestId('native-computer-use-panel')).toBeTruthy();
  });

  it('refreshes the board after a governed ACP Kanban write applies', async () => {
    render(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new CustomEvent('command-eve:kanban-acp-applied')));
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(2));
  });

  it('links a worker card to its durable run and session records', async () => {
    boardInvoke.mockResolvedValue(
      boardEnvelope({
        id: 't_worker',
        title: 'Durable worker',
        body: null,
        status: 'running',
        priority: 0,
        assignee: 'worker-real',
        tenant: null,
        created_at: 1,
        updated_at: null,
        current_run_id: 'run-real',
        session_id: 'session-real',
        project_id: null,
        goal_mode: false,
        latest_summary: null,
        link_counts: { parents: 0, children: 0 },
        progress: null,
      })
    );
    render(<KanbanBoardHost />);

    const card = await screen.findByTestId('native-kanban-task-t_worker');
    expect(card.getAttribute('data-record-kind')).toBe('worker');
    expect(screen.getByTitle('run-real')).toBeTruthy();
    expect(screen.getByTitle('session-real')).toBeTruthy();
  });

  it('remounts and re-reads on a seat switch, but not on a stable seat', async () => {
    const { rerender } = render(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(1));

    rerender(<KanbanBoardHost />);
    await Promise.resolve();
    expect(boardInvoke).toHaveBeenCalledTimes(1);

    activeSeatId = 'seat-b';
    rerender(<KanbanBoardHost />);
    await waitFor(() => expect(boardInvoke).toHaveBeenCalledTimes(2));
  });

  it('disables local board creation during the main-process seat-switch fence', async () => {
    switching = true;
    render(<KanbanBoardHost />);
    const button = (await screen.findByTestId('native-kanban-create')) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
