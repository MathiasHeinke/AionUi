/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SG-1 Design B — the shim `POST /eve/team/propose` route: bearer auth + ISO-6
 * inertness (empty expected bearer ⇒ 404, route invisible) + thin forwarding to the
 * injected main handler. ONE shim for the whole file (the shim is a singleton);
 * the expected bearer is a mutable so we can flip provisioned ⇄ client-seat.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

const BEARER = 'boot-bearer-secret-xyz';
let shimUrl = '';
let currentBearer = BEARER; // '' simulates an unprovisioned (client) seat — ISO-6
const propose = vi.fn(async (proposal: unknown) => ({ status: 202, payload: { ok: true, echo: proposal } }));

async function post(headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`${shimUrl}/eve/team/propose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  shimUrl = await startCommandEveOllamaOpenAiShim({
    port: 0,
    ollamaBaseUrl: 'http://127.0.0.1:1',
    teamManageBearer: () => currentBearer,
    teamManagePropose: propose,
  });
});
afterAll(async () => {
  if (shimUrl) await stopCommandEveOllamaOpenAiShimForTest();
  shimUrl = '';
});
beforeEach(() => {
  propose.mockClear();
  currentBearer = BEARER;
});

describe('Design B — POST /eve/team/propose (provisioned operator seat)', () => {
  it('rejects (404, inert) a request with NO bearer', async () => {
    const r = await post({}, { role_agent_id: 'growth-lead', action: 'pause' });
    expect(r.status).toBe(404);
    expect(propose).not.toHaveBeenCalled();
  });

  it('rejects (404) a WRONG bearer', async () => {
    const r = await post({ authorization: 'Bearer nope' }, { role_agent_id: 'growth-lead', action: 'pause' });
    expect(r.status).toBe(404);
    expect(propose).not.toHaveBeenCalled();
  });

  it('forwards to the handler on the correct bearer and returns its status/payload', async () => {
    const r = await post({ authorization: `Bearer ${BEARER}` }, { role_agent_id: 'growth-lead', action: 'pause' });
    expect(r.status).toBe(202);
    const json = (await r.json()) as { ok: boolean; echo: { role_agent_id: string } };
    expect(json.ok).toBe(true);
    expect(json.echo.role_agent_id).toBe('growth-lead');
    expect(propose).toHaveBeenCalledOnce();
  });

  it('is case-insensitive on the Bearer scheme keyword', async () => {
    const r = await post({ authorization: `bearer ${BEARER}` }, { role_agent_id: 'seo-lead', action: 'resume' });
    expect(r.status).toBe(202);
    expect(propose).toHaveBeenCalledOnce();
  });
});

describe('Design B — ISO-6: an unprovisioned (client) seat has NO route', () => {
  it('a proposal even WITH a bearer is 404 when the expected bearer is empty', async () => {
    currentBearer = ''; // client seat — team_manage not provisioned
    const r = await post({ authorization: `Bearer ${BEARER}` }, { role_agent_id: 'growth-lead', action: 'pause' });
    expect(r.status).toBe(404);
    expect(propose).not.toHaveBeenCalled();
  });
});
