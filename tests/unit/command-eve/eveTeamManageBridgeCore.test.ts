/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTeamManageForTest,
  applyConsumedIntent,
  buildProposeResponse,
  clearPendingIntent,
  consumeIntent,
  createIntent,
  peekIntent,
  peekIntentForSeat,
  validateProposal,
} from '../../../packages/desktop/src/process/commandEve/eveTeamManageBridgeCore';
import { EVE_TEAM_ROSTER } from '../../../packages/desktop/src/common/config/eveTeamRoster';
import type { EveTeamWorkerStatusMap } from '../../../packages/desktop/src/common/config/eveTeamControlsCore';

const allActive = (): EveTeamWorkerStatusMap =>
  Object.fromEntries(EVE_TEAM_ROSTER.map((r) => [r.agent_id, 'active'])) as EveTeamWorkerStatusMap;
const allOffExcept = (activeId: string): EveTeamWorkerStatusMap =>
  Object.fromEntries(
    EVE_TEAM_ROSTER.map((r) => [r.agent_id, r.agent_id === activeId ? 'active' : 'off'])
  ) as EveTeamWorkerStatusMap;

describe('eveTeamManageBridgeCore — validateProposal (B2/B8)', () => {
  beforeEach(() => __resetTeamManageForTest());

  it('accepts a valid status proposal on a healthy team', () => {
    const v = validateProposal(
      { role_agent_id: 'growth-lead', action: 'pause', reason: 'zu teuer diese Woche' },
      allActive()
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.role_agent_id).toBe('growth-lead');
      expect(v.action).toBe('pause');
      expect(v.reason).toContain('teuer');
    }
  });

  it('B8 — rejects any out-of-scope mutation key (cli_path/tier/free/assignment/kind)', () => {
    for (const key of ['cli_path', 'tier', 'free', 'assignment', 'kind']) {
      const v = validateProposal({ role_agent_id: 'growth-lead', action: 'pause', [key]: 'x' }, allActive());
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reject_code).toBe('scope-violation');
    }
  });

  it('rejects an unknown role and an unknown action', () => {
    const badRole = validateProposal({ role_agent_id: 'ceo-of-everything', action: 'pause' }, allActive());
    expect(badRole.ok).toBe(false);
    if (!badRole.ok) expect(badRole.reject_code).toBe('unknown-role');

    const badAction = validateProposal({ role_agent_id: 'growth-lead', action: 'delete' }, allActive());
    expect(badAction.ok).toBe(false);
    if (!badAction.ok) expect(badAction.reject_code).toBe('unknown-action');
  });

  it('B2 — rejects a company-emptying pause at PROPOSE (would-empty-company)', () => {
    const v = validateProposal({ role_agent_id: 'growth-lead', action: 'pause' }, allOffExcept('growth-lead'));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reject_code).toBe('would-empty-company');
  });

  it('an activating action (resume) is never company-emptying', () => {
    const v = validateProposal({ role_agent_id: 'growth-lead', action: 'resume' }, allOffExcept('seo-lead'));
    expect(v.ok).toBe(true);
  });
});

describe('eveTeamManageBridgeCore — intent lifecycle (B4/seat-partition)', () => {
  beforeEach(() => __resetTeamManageForTest());

  it('stores at most ONE pending intent — a new proposal supersedes the old', () => {
    const a = createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 1000, randomId: () => 'A' });
    const b = createIntent('seo-lead', 'pause', 'seat-1', 'skill', '', { now: 1001, randomId: () => 'B' });
    expect(peekIntent(1002)?.intent_id).toBe('B');
    // The old intent can no longer be consumed.
    expect(consumeIntent(a.intent_id, 'seat-1', 1002).ok).toBe(false);
    expect(consumeIntent(b.intent_id, 'seat-1', 1002).ok).toBe(true);
  });

  it('B4 — an expired intent neither peeks nor consumes (expired receipt path)', () => {
    createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 0, ttlMs: 100, randomId: () => 'X' });
    expect(peekIntent(50)?.intent_id).toBe('X');
    expect(peekIntent(150)).toBeNull();
    const c = consumeIntent('X', 'seat-1', 150);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe('expired');
  });

  it('seat-partition — an intent cannot be consumed on a different seat', () => {
    createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 0, randomId: () => 'S' });
    const wrong = consumeIntent('S', '99999999-2222-3333-4444-555555555555', 100);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe('wrong-seat');
    // Still consumable on the right seat.
    expect(consumeIntent('S', 'seat-1', 100).ok).toBe(true);
  });

  it('consume is single-use (removes the intent) and rejects a wrong intent_id', () => {
    createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 0, randomId: () => 'ONE' });
    expect(consumeIntent('WRONG', 'seat-1', 10).ok).toBe(false);
    expect(consumeIntent('ONE', 'seat-1', 10).ok).toBe(true);
    // A second consume finds nothing.
    const again = consumeIntent('ONE', 'seat-1', 10);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('not-found');
  });

  it('clearPendingIntent drops the pending intent (seat-switch hook)', () => {
    createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 0, randomId: () => 'Z' });
    clearPendingIntent();
    expect(peekIntent(1)).toBeNull();
  });
});

describe('eveTeamManageBridgeCore — apply (delegates to the pure reducer)', () => {
  beforeEach(() => __resetTeamManageForTest());

  it('applyConsumedIntent pauses the role in the fresh map', () => {
    const intent = createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 0, randomId: () => 'AP' });
    const { next, applied } = applyConsumedIntent(intent, allActive());
    expect(applied).toBe(true);
    expect((next as Record<string, string>)['growth-lead']).toBe('paused');
  });
});

describe('eveTeamManageBridgeCore — buildProposeResponse + peekIntentForSeat (async lane)', () => {
  beforeEach(() => __resetTeamManageForTest());

  it('a valid proposal → proposed + intent_id + a stored pending intent', () => {
    const r = buildProposeResponse({ role_agent_id: 'growth-lead', action: 'pause', reason: 'test' }, allActive(), {
      seatId: 'seat-1',
      now: 1000,
      randomId: () => 'INT-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent_id).toBe('INT-1');
      expect(r.status).toBe('proposed');
      expect(r.summary).toContain('pausieren');
    }
    // The pending intent is now visible to a same-seat peek…
    expect(peekIntentForSeat('seat-1', 1001)?.intent_id).toBe('INT-1');
    // …but NOT to another seat (seat-partition).
    expect(peekIntentForSeat('99999999-2222-3333-4444-555555555555', 1001)).toBeNull();
  });

  it('a scope-violating proposal → rejected + NO pending intent stored', () => {
    const r = buildProposeResponse({ role_agent_id: 'growth-lead', action: 'pause', cli_path: '/x' }, allActive(), {
      seatId: 'seat-1',
      now: 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reject_code).toBe('scope-violation');
    expect(peekIntentForSeat('seat-1', 1001)).toBeNull();
  });

  it('a would-empty proposal → rejected + NO pending intent', () => {
    const r = buildProposeResponse({ role_agent_id: 'growth-lead', action: 'pause' }, allOffExcept('growth-lead'), {
      seatId: 'seat-1',
      now: 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reject_code).toBe('would-empty-company');
    expect(peekIntentForSeat('seat-1', 1001)).toBeNull();
  });

  it('peekIntentForSeat hides an expired intent (B4)', () => {
    buildProposeResponse({ role_agent_id: 'growth-lead', action: 'pause' }, allActive(), {
      seatId: 'seat-1',
      now: 0,
      ttlMs: 100,
      randomId: () => 'INT-TTL',
    });
    expect(peekIntentForSeat('seat-1', 50)?.intent_id).toBe('INT-TTL');
    expect(peekIntentForSeat('seat-1', 150)).toBeNull();
  });
});

describe('eveTeamManageBridgeCore — B1 structural (no write path)', () => {
  it('the core module imports NO settings-writer (structurally "nie still")', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'packages/desktop/src/process/commandEve/eveTeamManageBridgeCore.ts'),
      'utf8'
    );
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    // No configService, no HTTP PUT, no setPersisted — the write lives ONLY in the
    // confirm IPC handler, never in the propose core.
    expect(code).not.toMatch(/configService|setPersisted|httpRequest|api\/settings\/client|fetch\(/);
  });
});

describe('collision-free intent id (final-audit confirm-integrity fix)', () => {
  beforeEach(() => __resetTeamManageForTest());

  it('two proposals in the SAME millisecond get DIFFERENT intent ids (no default `intent-${now}` collision)', () => {
    const a = createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 1700000000000 });
    const b = createIntent('seo-lead', 'pause', 'seat-1', 'skill', '', { now: 1700000000000 });
    expect(a.intent_id).not.toBe(b.intent_id);
  });

  it('confirming a SUPERSEDED (stale) proposal is refused wrong-intent; only the live one applies', () => {
    const p1 = createIntent('growth-lead', 'pause', 'seat-1', 'skill', '', { now: 1700000000000 });
    const p2 = createIntent('seo-lead', 'pause', 'seat-1', 'skill', '', { now: 1700000000000 });
    // The operator confirms the STALE P1 card → refused (the pending is P2 now).
    const stale = consumeIntent(p1.intent_id, 'seat-1', 1700000000001);
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe('wrong-intent');
    // The live P2 confirm succeeds and yields P2's actual change (never P1's).
    const live = consumeIntent(p2.intent_id, 'seat-1', 1700000000001);
    expect(live.ok).toBe(true);
    expect(live.intent?.role_agent_id).toBe('seo-lead');
  });
});
