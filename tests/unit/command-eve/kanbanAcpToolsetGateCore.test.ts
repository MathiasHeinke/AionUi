/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-626 — the Kanban-ACP toolset gate. Pins the default-deny surface (nothing
 * exposed without ready+seat+board), the proposal-only write policy (writes are always
 * Confirm-Card-gated, never direct), and the structural invariant that the raw in-process
 * wheel "kanban" toolset + dispatch markers never leak into the ACP agent's toolsets.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveKanbanAcpToolsetGate,
  findRawKanbanLeaks,
  KANBAN_WHEEL_WRITE_TOOLS,
  KANBAN_WHEEL_TOOLSET_KEY,
} from '@/process/commandEve/kanbanAcpToolsetGateCore';

describe('kanban-acp gate — default-deny visibility', () => {
  it('exposes nothing when the preflight is not ready', () => {
    const g = resolveKanbanAcpToolsetGate({ preflightReady: false, activeSeatId: 's', boardSlug: 'b' });
    expect(g.visible).toBe(false);
    expect(g.readTools).toEqual([]);
    expect(g.writeTools).toEqual([]);
  });

  it('exposes nothing without an active seat or board', () => {
    expect(resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: '', boardSlug: 'b' }).visible).toBe(false);
    expect(resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: 's', boardSlug: '  ' }).visible).toBe(false);
    expect(resolveKanbanAcpToolsetGate(undefined as never).visible).toBe(false);
  });

  it('exposes read + proposal-only write tools when ready+seat+board', () => {
    const g = resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: 's', boardSlug: 'marketing' });
    expect(g.visible).toBe(true);
    expect(g.readTools).toContain('kanban.board.read');
    // Writes are ONLY offered as plans + a confirm step — never a direct mutation tool.
    expect(g.writeTools).toContain('kanban.card.create.plan');
    expect(g.writeTools).toContain('kanban.write.confirm');
    expect(g.writeTools.every((t) => t.endsWith('.plan') || t === 'kanban.write.confirm')).toBe(true);
  });
});

describe('kanban-acp gate — fixed non-negotiable policy', () => {
  it('always requires a confirm card and forbids dispatch/spawn/delete', () => {
    for (const input of [
      { preflightReady: true, activeSeatId: 's', boardSlug: 'b' },
      { preflightReady: false },
    ]) {
      const p = resolveKanbanAcpToolsetGate(input).policy;
      expect(p.writeRequiresConfirmCard).toBe(true);
      expect(p.autoDispatchAllowed).toBe(false);
      expect(p.workerSpawnAllowed).toBe(false);
      expect(p.deleteAllowed).toBe(false);
    }
  });

  it('always lists the raw wheel WRITE tools as blocked (never handed to the agent)', () => {
    const g = resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: 's', boardSlug: 'b' });
    for (const t of KANBAN_WHEEL_WRITE_TOOLS) expect(g.blockedTools).toContain(t);
  });
});

describe('kanban-acp gate — raw-toolset leak detector (structural invariant)', () => {
  it('flags the raw wheel "kanban" toolset key in the ACP platform toolsets', () => {
    expect(findRawKanbanLeaks(['hermes-acp', KANBAN_WHEEL_TOOLSET_KEY])).toContain('kanban');
  });

  it('flags a raw wheel write tool or a dispatch marker', () => {
    expect(findRawKanbanLeaks(['kanban_create'])).toEqual(['kanban_create']);
    expect(findRawKanbanLeaks(['HERMES_KANBAN_TASK'])).toEqual(['HERMES_KANBAN_TASK']);
  });

  it('returns empty for a clean ACP toolset list and for a non-array', () => {
    expect(findRawKanbanLeaks(['hermes-acp', 'hermes-cli'])).toEqual([]);
    expect(findRawKanbanLeaks(undefined)).toEqual([]);
    expect(findRawKanbanLeaks('kanban' as never)).toEqual([]);
  });
});
