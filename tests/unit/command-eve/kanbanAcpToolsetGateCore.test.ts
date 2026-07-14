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
  KANBAN_LEAK_SCAN_TRUNCATED,
} from '@/process/commandEve/kanbanAcpToolsetGateCore';
import {
  COMMAND_EVE_ACP_PLATFORM_TOOLSETS,
  COMMAND_EVE_CLI_PLATFORM_TOOLSETS,
} from '@/process/commandEve/runtimeBootstrapCore';

describe('kanban-acp gate — default-deny visibility', () => {
  it('exposes nothing when the preflight is not ready', () => {
    const g = resolveKanbanAcpToolsetGate({ preflightReady: false, activeSeatId: 's', boardSlug: 'b' });
    expect(g.visible).toBe(false);
    expect(g.readTools).toEqual([]);
    expect(g.writeTools).toEqual([]);
  });

  it('exposes nothing without an active seat or board', () => {
    expect(resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: '', boardSlug: 'b' }).visible).toBe(false);
    expect(resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: 's', boardSlug: '  ' }).visible).toBe(
      false
    );
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
    for (const input of [{ preflightReady: true, activeSeatId: 's', boardSlug: 'b' }, { preflightReady: false }]) {
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

describe('kanban-acp gate — hardening (Codex re-audit holes)', () => {
  it('returns a FRESH policy each call — mutating one can never poison the next', () => {
    const g1 = resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: 's', boardSlug: 'b' });
    try {
      (g1.policy as { writeRequiresConfirmCard: boolean }).writeRequiresConfirmCard = false;
    } catch {
      /* frozen — throwing on mutation is fine */
    }
    const g2 = resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: 's', boardSlug: 'b' });
    expect(g2.policy.writeRequiresConfirmCard).toBe(true);
  });

  it('fails CLOSED (not visible) on a hostile throwing getter', () => {
    const bad: Record<string, unknown> = { preflightReady: true, boardSlug: 'b' };
    Object.defineProperty(bad, 'activeSeatId', {
      get() {
        throw new Error('boom');
      },
    });
    expect(resolveKanbanAcpToolsetGate(bad as never).visible).toBe(false);
  });

  it('leak detector catches case variants, nested arrays, object values, and broadened markers', () => {
    expect(findRawKanbanLeaks(['Kanban'])).toContain('Kanban');
    expect(findRawKanbanLeaks(['KANBAN_CREATE'])).toContain('KANBAN_CREATE');
    expect(findRawKanbanLeaks([['kanban_create']])).toContain('kanban_create');
    expect(findRawKanbanLeaks([{ toolsets: ['kanban'] }])).toContain('kanban');
    expect(findRawKanbanLeaks([{ name: 'kanban_create' }])).toContain('kanban_create');
    expect(findRawKanbanLeaks(['dispatch_in_gateway']).length).toBeGreaterThan(0);
    expect(findRawKanbanLeaks(['kanban.auto_decompose']).length).toBeGreaterThan(0);
    expect(findRawKanbanLeaks(['auto_decompose']).length).toBeGreaterThan(0);
    expect(findRawKanbanLeaks(['HERMES_KANBAN_TASK']).length).toBeGreaterThan(0);
  });

  it('does NOT flag the desktop-mediated read tool or a clean acp toolset', () => {
    expect(findRawKanbanLeaks(['kanban.board.read', 'hermes-acp'])).toEqual([]);
    expect(findRawKanbanLeaks(['kanban_show', 'kanban_list'])).toEqual([]);
  });

  it('a throwing getter mid-object does not hide a sibling leak after it', () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, 'a', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    obj.b = 'kanban_create';
    expect(findRawKanbanLeaks([obj])).toContain('kanban_create');
  });

  it('a huge input is node-budget bounded (finds a front leak, returns without hanging)', () => {
    const huge = Array.from({ length: 1_000_000 }, () => 0);
    huge[3] = 'kanban_create';
    expect(findRawKanbanLeaks(huge)).toContain('kanban_create');
  });

  it('a scan that exhausts the node budget fails CLOSED (truncation sentinel, never silently clean)', () => {
    const huge = Array.from({ length: 1_000_000 }, () => 'x'); // all benign but far past the budget
    const leaks = findRawKanbanLeaks(huge);
    expect(leaks).toContain(KANBAN_LEAK_SCAN_TRUNCATED);
    expect(leaks.length).toBeGreaterThan(0); // NOT reported as clean
  });

  it('never throws on a hostile top-level Proxy length trap — returns the sentinel', () => {
    const evil = new Proxy([], {
      get(_t, prop) {
        if (prop === 'length') throw new Error('boom');
        return undefined;
      },
    });
    let result: string[] = [];
    expect(() => {
      result = findRawKanbanLeaks(evil);
    }).not.toThrow();
    expect(result).toContain(KANBAN_LEAK_SCAN_TRUNCATED);
  });

  it('the exported marker constants are frozen (cannot be poisoned at runtime)', () => {
    expect(Object.isFrozen(KANBAN_WHEEL_WRITE_TOOLS)).toBe(true);
  });

  it('catches swarm / decompose dispatch markers in every form (bare, dotted, underscored)', () => {
    for (const m of [
      'swarm',
      'decompose',
      'kanban.swarm',
      'kanban.decompose',
      'kanban_swarm',
      'kanban_decompose',
      'auto_decompose',
    ]) {
      expect(findRawKanbanLeaks([m]).length).toBeGreaterThan(0);
    }
  });

  it('a leak nested past the depth limit fails CLOSED (sentinel, not silent clean)', () => {
    let deep: unknown = 'kanban_create';
    for (let i = 0; i < 8; i += 1) deep = [deep];
    expect(findRawKanbanLeaks(deep)).toContain(KANBAN_LEAK_SCAN_TRUNCATED);
  });
});

describe('kanban-acp gate — the emitted config carries NO raw kanban leak (regression guard)', () => {
  it('the ACP platform toolsets the desktop emits have no raw kanban toolset / write tool / dispatch marker', () => {
    // This is the REAL consumer of findRawKanbanLeaks: if a future edit adds 'kanban'
    // (or a raw write tool / dispatch marker) to the ACP agent's toolsets, this fails.
    expect(findRawKanbanLeaks([...COMMAND_EVE_ACP_PLATFORM_TOOLSETS])).toEqual([]);
  });

  it('the CLI platform toolsets are likewise clean', () => {
    expect(findRawKanbanLeaks([...COMMAND_EVE_CLI_PLATFORM_TOOLSETS])).toEqual([]);
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

  it('returns empty for a clean toolset list / clean non-array / undefined', () => {
    expect(findRawKanbanLeaks(['hermes-acp', 'hermes-cli'])).toEqual([]);
    expect(findRawKanbanLeaks(undefined)).toEqual([]);
    expect(findRawKanbanLeaks('hermes-acp' as never)).toEqual([]);
    expect(findRawKanbanLeaks(42 as never)).toEqual([]);
  });

  it('still catches a leak passed as a bare non-array value (fail-closed)', () => {
    expect(findRawKanbanLeaks('kanban' as never)).toEqual(['kanban']);
  });
});
