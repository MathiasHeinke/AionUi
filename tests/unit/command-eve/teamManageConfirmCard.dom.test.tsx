/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import TeamManageConfirmCard from '@/renderer/components/team/TeamManageConfirmCard';

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      teamManagePeek: { invoke: vi.fn() },
      teamManageApply: { invoke: vi.fn() },
      teamManageReject: { invoke: vi.fn() },
    },
  },
}));

// Arco's Message uses the React-17 ReactDOM.render API, which is absent in the
// jsdom + React-18 test env (it throws "ReactDOM.render is not a function"). Stub
// just Message; keep Card/Button/Typography real so the render assertions are true.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, Message: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } };
});

const PENDING = {
  intent_id: 'INT-1',
  role_agent_id: 'growth-lead',
  action: 'pause',
  summary: 'Growth Lead (Growth Lead) pausieren (drosseln)',
  reason: 'diese Woche zu teuer',
  expires_ms: Date.now() + 300000,
};

beforeEach(() => {
  vi.mocked(ipcBridge.commandEve.teamManagePeek.invoke).mockResolvedValue({
    success: true,
    data: { ok: true, pending: PENDING },
  } as never);
  vi.mocked(ipcBridge.commandEve.teamManageApply.invoke).mockResolvedValue({
    success: true,
    data: { ok: true },
  } as never);
  vi.mocked(ipcBridge.commandEve.teamManageReject.invoke).mockResolvedValue({
    success: true,
    data: { ok: true },
  } as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TeamManageConfirmCard (SG-1 Design B — B3/B6)', () => {
  it('polls, surfaces the proposal with the honesty text, and applies ONLY on the button (B3/B6)', async () => {
    render(<TeamManageConfirmCard />);

    // The card appears from the mount poll.
    await waitFor(() => expect(screen.getByTestId('team-manage-confirm-card')).toBeTruthy());
    const card = screen.getByTestId('team-manage-confirm-card');
    expect(card.textContent).toMatch(/pausieren/i);
    expect(card.textContent).toMatch(/diese Woche zu teuer/);
    // B6 honesty text present.
    expect(card.textContent).toMatch(/läuft auf dem gemeinsamen Konto/i);

    // Nothing is applied until the button is clicked (B3 — no auto-approve).
    expect(ipcBridge.commandEve.teamManageApply.invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('team-manage-confirm'));
    await waitFor(() =>
      expect(ipcBridge.commandEve.teamManageApply.invoke).toHaveBeenCalledWith({ intent_id: 'INT-1' })
    );
  });

  it('dismiss calls reject and never applies', async () => {
    render(<TeamManageConfirmCard />);
    await waitFor(() => expect(screen.getByTestId('team-manage-confirm-card')).toBeTruthy());

    fireEvent.click(screen.getByTestId('team-manage-dismiss'));
    await waitFor(() =>
      expect(ipcBridge.commandEve.teamManageReject.invoke).toHaveBeenCalledWith({ intent_id: 'INT-1' })
    );
    expect(ipcBridge.commandEve.teamManageApply.invoke).not.toHaveBeenCalled();
  });

  it('renders nothing when there is no pending intent', async () => {
    vi.mocked(ipcBridge.commandEve.teamManagePeek.invoke).mockResolvedValue({
      success: true,
      data: { ok: true, pending: null },
    } as never);
    render(<TeamManageConfirmCard />);
    // Give the mount poll a tick; the card must not appear.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('team-manage-confirm-card')).toBeNull();
  });
});
