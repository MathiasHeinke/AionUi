/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-626 — the kanban-ACP shim routes. Proves the ROUTE layer: bearer-gated 404-inert
 * behavior (K3), that propose reaches the injected handler only with the right bearer,
 * and that the read route returns the injected digest with NO write side effect (K10).
 * The handlers are injected fakes — the real main-side logic has its own unit tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startCommandEveOllamaOpenAiShim, stopCommandEveOllamaOpenAiShimForTest } from '@/process/commandEve/ollamaOpenAiShim';

const BEARER = 'kanban-boot-bearer-abc123';

afterEach(async () => {
  await stopCommandEveOllamaOpenAiShimForTest();
});

describe('kanban-ACP shim routes — POST /eve/kanban/propose', () => {
  it('is 404-inert when no bearer is provisioned (client seat / unprovisioned)', async () => {
    let handlerCalled = false;
    const url = await startCommandEveOllamaOpenAiShim({
      port: 0,
      kanbanAcpBearer: () => '',
      kanbanAcpPropose: async () => {
        handlerCalled = true;
        return { status: 202, payload: { ok: true } };
      },
    });
    const res = await fetch(`${url}/eve/kanban/propose`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` }, body: '{"op":"create","title":"x"}' });
    expect(res.status).toBe(404);
    expect(handlerCalled).toBe(false); // the handler is never reached without a provisioned bearer
  });

  it('is 404 on a wrong bearer, and reaches the handler (202) only on the exact bearer', async () => {
    const url = await startCommandEveOllamaOpenAiShim({
      port: 0,
      kanbanAcpBearer: () => BEARER,
      kanbanAcpPropose: async () => ({ status: 202, payload: { ok: true, status: 'proposed', intent_id: 'k_abc' } }),
    });
    const wrong = await fetch(`${url}/eve/kanban/propose`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{"op":"create","title":"x"}' });
    expect(wrong.status).toBe(404);
    const ok = await fetch(`${url}/eve/kanban/propose`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` }, body: '{"op":"create","title":"x"}' });
    expect(ok.status).toBe(202);
    expect((await ok.json()).intent_id).toBe('k_abc');
  });
});

describe('kanban-ACP shim routes — GET /eve/kanban/read', () => {
  it('is 404-inert without a bearer', async () => {
    const url = await startCommandEveOllamaOpenAiShim({ port: 0, kanbanAcpBearer: () => '', kanbanAcpRead: () => ({ ok: true, cards: [] }) });
    const res = await fetch(`${url}/eve/kanban/read`, { headers: { authorization: `Bearer ${BEARER}` } });
    expect(res.status).toBe(404);
  });

  it('returns the injected read-only digest on the right bearer (no write side effect)', async () => {
    const url = await startCommandEveOllamaOpenAiShim({
      port: 0,
      kanbanAcpBearer: () => BEARER,
      kanbanAcpRead: () => ({ ok: true, board_slug: 'marketing', lanes: ['research'], cards: [{ card_id: 'c1', title: 'Launch', lane: 'research', status: 'todo' }] }),
    });
    const res = await fetch(`${url}/eve/kanban/read`, { headers: { authorization: `Bearer ${BEARER}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cards[0].card_id).toBe('c1');
    // The read payload carries NO write surface (no intent_id / mutation_hash / confirm).
    const asText = JSON.stringify(body);
    expect(asText).not.toContain('intent_id');
    expect(asText).not.toContain('mutation_hash');
  });
});
