/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-624 — the Honcho DERIVER cloud lane on the shim (`POST /honcho/deriver`).
 * This is the SERVER-SIDE enforcement of the two invariants honchoRuntimeConfigCore
 * only NAMES:
 *   MONEY  — the deriver ALWAYS rides the FREE 'standard' tier, picker-independent:
 *            an operator sitting on eve-max (paid) can not make EVE's memory
 *            derivation bill a paid tier.
 *   EGRESS — the deriver text runs through the SAME S11/S13 egress redaction as
 *            chat before any byte reaches the eve-inference function.
 * Plus: fail-closed (503) when no free-lane route/license, and byte-additivity
 * (the lane is inert until Honcho is provisioned).
 */

import http, { type IncomingMessage, type ServerResponse } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

/** Synthetic CEVE wire string — NOT a real license. */
const FAKE_LICENSE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';

type EveFnSeen = { body?: Record<string, unknown>; authHeader?: string | null; path?: string; hits: number };

let eveFnServer: http.Server | undefined;
let shimServerUrl = '';

function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

/** A fake eve-inference function that records what the deriver forwarded to it. */
async function startFakeEveFunction(seen: EveFnSeen): Promise<string> {
  eveFnServer = http.createServer((request, response) => {
    void (async () => {
      seen.hits += 1;
      seen.path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      seen.authHeader = request.headers.authorization ?? null;
      seen.body = await readRequestBody(request);
      writeJson(response, 200, {
        choices: [{ message: { role: 'assistant', content: 'deriver-ok' }, finish_reason: 'stop' }],
      });
    })().catch((error) => writeJson(response, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve, reject) => {
    eveFnServer?.once('error', reject);
    eveFnServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = eveFnServer.address();
  if (!address || typeof address === 'string') throw new Error('fake eve fn did not expose a port');
  return `http://127.0.0.1:${address.port}`;
}

function deriverPost(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${shimServerUrl}/honcho/deriver/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  if (eveFnServer) {
    await new Promise<void>((resolve, reject) => eveFnServer?.close((e) => (e ? reject(e) : resolve())));
    eveFnServer = undefined;
  }
  if (shimServerUrl) {
    await stopCommandEveOllamaOpenAiShimForTest();
    shimServerUrl = '';
  }
});

describe('Honcho deriver cloud lane (COMPA-624)', () => {
  it('routes the deriver to the eve-inference function at the FREE standard tier with the bearer in the header only', async () => {
    const seen: EveFnSeen = { hits: 0 };
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1', // never reached
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({
      model: 'gemma4:e4b',
      messages: [{ role: 'user', content: 'derive the user model' }],
      stream: false,
    });
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };

    expect(response.status).toBe(200);
    expect(json.choices?.[0]?.message?.content).toBe('deriver-ok');
    expect(seen.hits).toBe(1);
    expect(seen.body?.tier).toBe('standard');
    expect(seen.authHeader).toBe(`Bearer ${FAKE_LICENSE}`);
    // The license never rides the body; the local model ref is not smuggled.
    expect(seen.body?.license).toBeUndefined();
    expect(seen.body).not.toHaveProperty('model');
  });

  it('MONEY: forces the FREE standard tier even when the chat picker is eve-max (paid) — picker-independent', async () => {
    const seen: EveFnSeen = { hits: 0 };
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      // The operator's CHAT picker is eve-max (paid). The deriver MUST ignore it.
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'max' }),
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({
      model: 'x',
      messages: [{ role: 'user', content: 'derive' }],
      stream: false,
    });

    expect(response.status).toBe(200);
    // The single most important assertion of the whole lane: NOT 'max'.
    expect(seen.body?.tier).toBe('standard');
  });

  it('MONEY: a deriver route that tries to smuggle a paid tier is ignored (tier is forced server-side)', async () => {
    const seen: EveFnSeen = { hits: 0 };
    const fnUrl = await startFakeEveFunction(seen);
    // The route type has no `tier` field; a hostile resolver casts one in anyway.
    const spoofRoute = { active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'max' } as unknown as {
      active: boolean;
      functionUrl?: string;
      license?: string;
    };
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      honchoDeriverRoute: () => spoofRoute,
    });

    await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });
    expect(seen.body?.tier).toBe('standard');
  });

  it('EGRESS: redacts a secret in the deriver text before the function is called (S11/S13 runs on this lane)', async () => {
    const seen: EveFnSeen = { hits: 0 };
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({
      model: 'x',
      messages: [{ role: 'user', content: 'API key: sk-abcdefghijklmnopqrstuvwxyz123456' }],
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    const forwarded = JSON.stringify(seen.body);
    expect(forwarded).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(forwarded).toContain('[REDACTED_SECRET]');
  });

  it('is picker-independent on the OTHER side too: reaches the cloud fn even when the chat picker is LOCAL', async () => {
    const seen: EveFnSeen = { hits: 0 };
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1', // a local chat would try (and fail) here
      eveRouting: () => ({ active: false }), // operator's chat is on the LOCAL lane
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });
    expect(response.status).toBe(200);
    expect(seen.hits).toBe(1); // the deriver reached the cloud fn, not the dead local upstream
  });

  it('FAIL-CLOSED: 503 when the deriver route is absent (default inert lane)', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl: 'http://127.0.0.1:1' });
    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }] });
    expect(response.status).toBe(503);
  });

  it('FAIL-CLOSED: 503 when active but the license is missing (never egress half-configured)', async () => {
    const seen: EveFnSeen = { hits: 0 };
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: '' }),
    });
    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }] });
    expect(response.status).toBe(503);
    expect(seen.hits).toBe(0); // nothing was forwarded to the function
  });

  it('FAIL-CLOSED: 503 when the route is inactive (active:false)', async () => {
    const seen: EveFnSeen = { hits: 0 };
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      honchoDeriverRoute: () => ({ active: false, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });
    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }] });
    expect(response.status).toBe(503);
    expect(seen.hits).toBe(0);
  });
});
