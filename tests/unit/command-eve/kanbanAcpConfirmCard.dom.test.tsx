/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-626 K11 — the kanban confirm card. Proves the button-only governance gate: the
 * card surfaces a pending proposal with the honesty text, applies ONLY on the button
 * click (carrying the mutation_hash), dismiss calls reject and never applies, and nothing
 * renders without a pending intent.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import KanbanAcpConfirmCard from '@/renderer/components/team/KanbanAcpConfirmCard';

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      kanbanAcpPeek: { invoke: vi.fn() },
      kanbanAcpApply: { invoke: vi.fn() },
      kanbanAcpReject: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, Message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } };
});

const PENDING = {
  intent_id: 'k_abc',
  op: 'create',
  action: '',
  summary: 'Neue Karte anlegen: „Launchpage"',
  reason: 'Kunde will bis Freitag',
  mutation_hash: 'k_deadbeef',
  expires_ms: Date.now() + 300000,
};

beforeEach(() => {
  vi.mocked(ipcBridge.commandEve.kanbanAcpPeek.invoke).mockResolvedValue({
    success: true,
    data: { ok: true, pending: PENDING },
  } as never);
  vi.mocked(ipcBridge.commandEve.kanbanAcpApply.invoke).mockResolvedValue({
    success: true,
    data: { ok: true },
  } as never);
  vi.mocked(ipcBridge.commandEve.kanbanAcpReject.invoke).mockResolvedValue({
    success: true,
    data: { ok: true },
  } as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KanbanAcpConfirmCard (COMPA-626 K11)', () => {
  it('surfaces the proposal + honesty text and applies ONLY on the button, carrying the mutation_hash', async () => {
    render(<KanbanAcpConfirmCard />);
    await waitFor(() => expect(screen.getByTestId('kanban-acp-confirm-card')).toBeTruthy());
    const card = screen.getByTestId('kanban-acp-confirm-card');
    expect(card.textContent).toMatch(/Launchpage/);
    expect(card.textContent).toMatch(/Kunde will bis Freitag/);
    // Honesty text: EVE only proposes.
    expect(card.textContent).toMatch(/erst geschrieben, wenn du auf/i);

    // Nothing applied until the button is clicked (no auto-approve, YOLO-exempt).
    expect(ipcBridge.commandEve.kanbanAcpApply.invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('kanban-acp-confirm'));
    await waitFor(() =>
      expect(ipcBridge.commandEve.kanbanAcpApply.invoke).toHaveBeenCalledWith({
        intent_id: 'k_abc',
        mutation_hash: 'k_deadbeef',
      })
    );
  });

  it('dismiss calls reject and never applies', async () => {
    render(<KanbanAcpConfirmCard />);
    await waitFor(() => expect(screen.getByTestId('kanban-acp-confirm-card')).toBeTruthy());
    fireEvent.click(screen.getByTestId('kanban-acp-dismiss'));
    await waitFor(() =>
      expect(ipcBridge.commandEve.kanbanAcpReject.invoke).toHaveBeenCalledWith({ intent_id: 'k_abc' })
    );
    expect(ipcBridge.commandEve.kanbanAcpApply.invoke).not.toHaveBeenCalled();
  });

  it('renders nothing when there is no pending intent', async () => {
    vi.mocked(ipcBridge.commandEve.kanbanAcpPeek.invoke).mockResolvedValue({
      success: true,
      data: { ok: true, pending: null },
    } as never);
    render(<KanbanAcpConfirmCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('kanban-acp-confirm-card')).toBeNull();
  });
});
