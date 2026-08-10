/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-626 — the Kanban-ACP propose/confirm store. Mirrors the team_manage gates:
 * validate (visible + known op + allowed action + no scope-escape), single-pending TTL,
 * seat-partition on consume, and a mutation-hash tamper guard so the confirmed change is
 * exactly the proposed one. No kanban.db write lives in this module.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  validateKanbanProposal,
  buildKanbanProposeResponse,
  peekKanbanIntentForSeat,
  consumeKanbanIntent,
  kanbanMutationHash,
  clearKanbanPendingIntent,
  __resetKanbanAcpForTest,
} from '@/process/commandEve/kanbanAcpConfirmStore';

const NOW = Date.parse('2026-07-05T12:00:00.000Z');
const VIS = { visible: true, boardSlug: 'marketing' };

afterEach(() => __resetKanbanAcpForTest());

describe('kanban confirm store — validation scope-lock', () => {
  it('rejects when the surface is not visible', () => {
    expect(validateKanbanProposal({ op: 'create', title: 'x' }, { visible: false, boardSlug: 'm' }).reject_code).toBe(
      'not-visible'
    );
  });

  it('rejects a scope-escape key (delete/dispatch/spawn/assign/swarm/decompose)', () => {
    for (const key of ['delete', 'dispatch', 'spawn', 'assign', 'swarm', 'decompose', 'worker', 'heartbeat']) {
      expect(validateKanbanProposal({ op: 'action', action: 'comment', [key]: true }, VIS).reject_code).toBe(
        'scope-violation'
      );
    }
  });

  it('rejects an unknown op and an unknown card action', () => {
    expect(validateKanbanProposal({ op: 'nuke' }, VIS).reject_code).toBe('unknown-op');
    expect(validateKanbanProposal({ op: 'action', action: 'reassign' }, VIS).reject_code).toBe('unknown-action');
  });

  it('accepts create / move / action(comment|block|unblock|complete) and returns a hash', () => {
    expect(validateKanbanProposal({ op: 'create', title: 'Launchpage' }, VIS).ok).toBe(true);
    expect(validateKanbanProposal({ op: 'move', card: 'c1', to: 'done' }, VIS).ok).toBe(true);
    for (const action of ['comment', 'block', 'unblock', 'complete']) {
      const v = validateKanbanProposal({ op: 'action', action, card: 'c1' }, VIS);
      expect(v.ok).toBe(true);
      expect(typeof v.mutation_hash).toBe('string');
      expect(v.mutation_hash!.length).toBeGreaterThan(0);
    }
  });
});

describe('kanban confirm store — mutation hash (tamper guard)', () => {
  it('is stable for the same logical payload (key order independent) and differs for a changed one', () => {
    const a = kanbanMutationHash('create', '', 'm', { title: 'x', lane: 'todo' });
    const b = kanbanMutationHash('create', '', 'm', { lane: 'todo', title: 'x' });
    const c = kanbanMutationHash('create', '', 'm', { title: 'y', lane: 'todo' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('does NOT collide on the titles that broke the old 32-bit hash (sha256 now)', () => {
    // Codex re-audit: the prior polynomial hash mapped 'anaaaaaa' and 'c0aaaaaa' to the
    // same value, so a swapped payload passed the tamper check. sha256 must separate them.
    const a = kanbanMutationHash('create', '', 'm', { title: 'anaaaaaa' });
    const b = kanbanMutationHash('create', '', 'm', { title: 'c0aaaaaa' });
    expect(a).not.toBe(b);
  });
});

describe('kanban confirm store — propose → peek → confirm flow', () => {
  const propose = (payload: unknown, seatId = 'seat-a', now = NOW) =>
    buildKanbanProposeResponse(payload, {
      visible: true,
      boardSlug: 'marketing',
      seatId,
      now,
      randomId: () => 'kintent-1',
    });

  it('proposes (no write), the renderer peeks it for the same seat, confirm with the right hash applies once', () => {
    const r = propose({ op: 'create', title: 'Landingpage' });
    expect(r.status).toBe('proposed');
    const seen = peekKanbanIntentForSeat('seat-a', NOW + 1000);
    expect(seen?.intent_id).toBe('kintent-1');
    const hash = seen!.mutation_hash;
    const ok = consumeKanbanIntent('kintent-1', 'seat-a', hash, NOW + 2000);
    expect(ok.ok).toBe(true);
    // consumed → gone (never double-applied)
    expect(consumeKanbanIntent('kintent-1', 'seat-a', hash, NOW + 3000).reason).toBe('not-found');
  });

  it('refuses confirm on the wrong seat (seat-partition)', () => {
    propose({ op: 'create', title: 'x' }, 'seat-a');
    expect(peekKanbanIntentForSeat('seat-b', NOW + 1000)).toBeNull();
    const hash = peekKanbanIntentForSeat('seat-a', NOW + 1000)!.mutation_hash;
    expect(consumeKanbanIntent('kintent-1', 'seat-b', hash, NOW + 1000).reason).toBe('wrong-seat');
  });

  it('refuses a TAMPERED confirm (hash of a different change)', () => {
    propose({ op: 'create', title: 'real' });
    const bogus = kanbanMutationHash('create', '', 'marketing', { title: 'swapped' });
    expect(consumeKanbanIntent('kintent-1', 'seat-a', bogus, NOW + 1000).reason).toBe('tampered');
  });

  it('refuses an expired confirm and a wrong intent id', () => {
    propose({ op: 'create', title: 'x' }, 'seat-a', NOW);
    const hash = peekKanbanIntentForSeat('seat-a', NOW + 1000)!.mutation_hash;
    expect(consumeKanbanIntent('kintent-1', 'seat-a', hash, NOW + 10 * 60 * 1000).reason).toBe('expired');
    propose({ op: 'create', title: 'y' });
    const h2 = peekKanbanIntentForSeat('seat-a', NOW + 1000)!.mutation_hash;
    expect(consumeKanbanIntent('other-id', 'seat-a', h2, NOW + 1000).reason).toBe('wrong-intent');
  });

  it('keeps at most one pending intent (a new proposal supersedes the old)', () => {
    buildKanbanProposeResponse(
      { op: 'create', title: 'first' },
      { visible: true, boardSlug: 'marketing', seatId: 'seat-a', now: NOW, randomId: () => 'k1' }
    );
    buildKanbanProposeResponse(
      { op: 'create', title: 'second' },
      { visible: true, boardSlug: 'marketing', seatId: 'seat-a', now: NOW, randomId: () => 'k2' }
    );
    const live = peekKanbanIntentForSeat('seat-a', NOW + 1000);
    expect(live?.intent_id).toBe('k2');
    // the superseded k1 can no longer be confirmed
    expect(consumeKanbanIntent('k1', 'seat-a', live!.mutation_hash, NOW + 1000).reason).toBe('wrong-intent');
  });

  it('reuses an identical live proposal instead of replacing the intent', () => {
    const first = buildKanbanProposeResponse(
      { op: 'create', title: 'same', reason: 'wait for approval' },
      { visible: true, boardSlug: 'default', seatId: 'seat-a', now: NOW, randomId: () => 'k1' }
    );
    const second = buildKanbanProposeResponse(
      { op: 'create', title: 'same', reason: 'wait for approval' },
      { visible: true, boardSlug: 'default', seatId: 'seat-a', now: NOW + 1000, randomId: () => 'k2' }
    );

    expect(first).toMatchObject({ intent_id: 'k1', reused: false });
    expect(second).toMatchObject({ intent_id: 'k1', reused: true });
    expect(peekKanbanIntentForSeat('seat-a', NOW + 2000)?.intent_id).toBe('k1');
  });

  it('clearKanbanPendingIntent removes the pending intent (seat switch)', () => {
    propose({ op: 'create', title: 'x' });
    clearKanbanPendingIntent();
    expect(peekKanbanIntentForSeat('seat-a', NOW + 1000)).toBeNull();
  });
});
