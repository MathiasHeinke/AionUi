/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SG-1 Gate A2 — Geld-Invariante: Pricing = f(Wire-Tier), NEVER f(agent_id).
 * See docs/operations/geld-invariante-agent-id.md (Company.OS).
 *
 * Two guards:
 *  (1) BEHAVIORAL — the shim's outbound WIRE TIER (the only pricing signal) is
 *      independent of the resolved agent_id: two calls with the same route tier
 *      but different attributed roles forward the SAME tier.
 *  (2) STRUCTURAL — the attribution modules (registry, launcher-core) carry no
 *      pricing/tier/markup token, so a future edit cannot quietly couple a price
 *      to a role.
 */

import http, { type IncomingMessage, type ServerResponse } from 'http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

const FAKE_LICENSE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';

let eveFnServer: http.Server | undefined;
let shimServerUrl = '';

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

async function startFakeEveFunction(seen: { body?: Record<string, unknown> }): Promise<string> {
  eveFnServer = http.createServer((request, response) => {
    void (async () => {
      seen.body = await readBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    })().catch(() => {
      response.writeHead(500);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    eveFnServer?.once('error', reject);
    eveFnServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = eveFnServer.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
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

describe('A2 Geld-Invariante — pricing tier ⊥ agent_id', () => {
  async function outboundFor(role: string, tier: 'standard' | 'high' | 'max'): Promise<Record<string, unknown>> {
    const seen: { body?: Record<string, unknown> } = {};
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier }),
      // Resolve the header token to the given role (stand-in for the registry).
      attributionAgentId: (token) => (token ? role : 'eve'),
    });
    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-eve-dispatch': 'a-valid-token' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    return seen.body ?? {};
  }

  it('forwards the SAME wire tier regardless of the attributed role', async () => {
    const growth = await outboundFor('growth-lead', 'high');
    expect(growth.tier).toBe('high');
    expect(growth.agent_id).toBe('growth-lead');
    // Teardown between the two runs.
    await stopCommandEveOllamaOpenAiShimForTest();
    shimServerUrl = '';
    if (eveFnServer) {
      await new Promise<void>((resolve, reject) => eveFnServer?.close((e) => (e ? reject(e) : resolve())));
      eveFnServer = undefined;
    }

    const seo = await outboundFor('seo-lead', 'high');
    expect(seo.tier).toBe('high'); // identical tier…
    expect(seo.agent_id).toBe('seo-lead'); // …despite a different role.
    // The pricing signal (tier) did not move with the attribution.
    expect(seo.tier).toBe(growth.tier);
  });
});

describe('A2 structural — attribution modules carry no pricing token', () => {
  const ATTRIBUTION_MODULES = [
    'packages/desktop/src/process/commandEve/eveAgentTaskRegistry.ts',
    'packages/desktop/src/process/commandEve/eveWorkerLauncherCore.ts',
  ];
  // Pricing/markup vocabulary that must never appear in an attribution-only module.
  const PRICING_TOKENS = /TIER_MARKUP|retailCost|markup|eur_cents|eurCents|price|creditUnit|DEFAULT_MARKUP/i;

  for (const rel of ATTRIBUTION_MODULES) {
    it(`${path.basename(rel)} contains no pricing/markup token`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      // Strip line comments so a doctrine reference in prose doesn't trip the gate.
      const code = src
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
        .join('\n');
      expect(PRICING_TOKENS.test(code)).toBe(false);
    });
  }
});
