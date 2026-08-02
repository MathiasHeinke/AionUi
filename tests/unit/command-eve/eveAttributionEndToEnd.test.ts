/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SG-1 A1/A5 — END-TO-END attribution through the REAL chain (review fix #9): the
 * production shim resolver `resolveDispatchAgentId` (not a mock) resolving a REAL
 * minted lease token carried on the X-EVE-Dispatch header, seat-partitioned. This
 * is the wiring index.ts now injects at all three shim start sites.
 *
 * ONE shim + ONE fake fn-server for the whole file (started in beforeAll, mutable
 * seat/header per test) — deliberately light so it does not add process/server
 * churn that could time out other CPU-heavy tests under full parallel suite load.
 */

import http, { type IncomingMessage, type ServerResponse } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';
import {
  __resetEveAgentTaskRegistryForTest,
  mintLeaseToken,
  resolveDispatchAgentId,
} from '@/process/commandEve/eveAgentTaskRegistry';

const FAKE_LICENSE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';
const SHIM_AUTH_TOKEN = ensureCommandEveShimAuthToken();
let eveFnServer: http.Server | undefined;
let fnUrl = '';
let shimUrl = '';
let currentSeat = 'seat-1';
const seen: { body?: Record<string, unknown> } = {};

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (c) => (raw += c));
    request.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    request.on('error', reject);
  });
}

beforeAll(async () => {
  eveFnServer = http.createServer((request, response: ServerResponse) => {
    void (async () => {
      seen.body = await readBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })
      );
    })().catch(() => {
      response.writeHead(500);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    eveFnServer?.once('error', reject);
    eveFnServer?.listen(0, '127.0.0.1', resolve);
  });
  const a = eveFnServer.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  fnUrl = `http://127.0.0.1:${a.port}`;
  shimUrl = await startCommandEveOllamaOpenAiShim({
    port: 0,
    ollamaBaseUrl: 'http://127.0.0.1:1',
    eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    activeSeatId: () => currentSeat,
    attributionAgentId: (token, seat) => resolveDispatchAgentId(token, seat), // the REAL resolver
  });
});

afterAll(async () => {
  if (shimUrl) await stopCommandEveOllamaOpenAiShimForTest();
  if (eveFnServer) await new Promise<void>((resolve, reject) => eveFnServer?.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  __resetEveAgentTaskRegistryForTest();
  seen.body = undefined;
});

async function send(header: string | undefined): Promise<Record<string, unknown>> {
  await fetch(`${shimUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SHIM_AUTH_TOKEN}`,
      ...(header ? { 'x-eve-dispatch': header } : {}),
    },
    body: JSON.stringify({
      eve_operation: 'user_chat_turn',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }),
  });
  return seen.body ?? {};
}

describe('A1/A5 end-to-end — real registry + shim + seat-partition', () => {
  it('a REAL minted lease token on the header attributes to its role', async () => {
    currentSeat = 'seat-1';
    const lease = mintLeaseToken('growth-lead', 'seat-1');
    expect(lease).not.toBeNull();
    expect((await send(lease!.token)).agent_id).toBe('growth-lead');
  });

  it('SEAT-PARTITION end-to-end: the same token on a DIFFERENT active seat → eve (agent_id omitted)', async () => {
    const lease = mintLeaseToken('growth-lead', 'seat-1');
    currentSeat = '99999999-2222-3333-4444-555555555555';
    expect(await send(lease!.token)).not.toHaveProperty('agent_id');
  });

  it('an unknown token → eve (agent_id omitted)', async () => {
    currentSeat = 'seat-1';
    mintLeaseToken('growth-lead', 'seat-1');
    expect(await send('never-minted-token')).not.toHaveProperty('agent_id');
  });

  it('no header at all → eve (the 1.7.0 steady state)', async () => {
    currentSeat = 'seat-1';
    mintLeaseToken('growth-lead', 'seat-1');
    expect(await send(undefined)).not.toHaveProperty('agent_id');
  });
});
