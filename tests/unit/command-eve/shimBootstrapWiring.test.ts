/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE PRODUCTION BOOTSTRAP WIRING — every site, not just the one we noticed.
 *
 * WHY THIS FILE EXISTS. `inferenceSelectionBackendRoute.test.ts` proved the
 * resolver's internals and the `index.ts` call that BUILDS it. It did not prove
 * that the built resolver is ever INSTALLED into the shim the product actually
 * starts. Deleting the `eveRouting:` line at the normal startup site left the
 * whole suite green — a test adjacent to the thing that matters, which is the
 * seventh instance of that shape on this ticket.
 *
 * So this treats the CLASS: it enumerates EVERY `startCommandEveOllamaOpenAiShim`
 * call in index.ts and requires all of them to install the resolver, with the
 * count pinned so a NEW unwired site fails too.
 *
 * SOURCE PROBE, DELIBERATELY. `index.ts` is the Electron main entry; importing it
 * pulls in `electron` and cannot run under vitest. The probe reads the real file
 * — not a copy, not a re-implementation — and is paired with a LIVE consequence
 * control below so it cannot pass on the mere presence of a symbol.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@process/commandEve/ollamaOpenAiShim';

const INDEX_TS = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf-8');

/** Strip line/block comments so a commented-out call never counts as wiring. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every `startCommandEveOllamaOpenAiShim({ ... })` call site with its option
 * block and the ~200 chars before it (enough to see a lazy `||` guard).
 */
function shimStartCallSites(): Array<{ options: string; preceding: string; index: number }> {
  const src = stripComments(INDEX_TS);
  const sites: Array<{ options: string; preceding: string; index: number }> = [];
  const marker = 'startCommandEveOllamaOpenAiShim({';
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    // Walk braces to the matching close so nested objects are captured whole.
    let depth = 0;
    let end = at + marker.length - 1;
    for (let i = end; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    sites.push({
      options: src.slice(at, end + 1),
      preceding: src.slice(Math.max(0, at - 200), at),
      index: at,
    });
    from = end + 1;
  }
  return sites;
}

describe('production bootstrap wiring — the EVE routing resolver is INSTALLED, not just built', () => {
  it('finds every shim start site in index.ts, and the count is PINNED', () => {
    const sites = shimStartCallSites();
    // THREE, and the count is asserted so a fourth site cannot appear unwired.
    // Two are lazy fallbacks inside IPC providers (guarded by an existing-URL
    // check); one is the normal startup bootstrap. All three can be the first to
    // start the shim, so all three must install the resolver.
    expect(sites.length, 'shim start sites in index.ts').toBe(3);
  });

  it('EVERY shim start site installs buildCommandEveShimRoutingResolver()', () => {
    const sites = shimStartCallSites();
    const unwired = sites
      .map((s, i) => ({ i, ok: /eveRouting:\s*buildCommandEveShimRoutingResolver\(\)/.test(s.options) }))
      .filter((s) => !s.ok)
      .map((s) => `site #${s.i}`);
    expect(unwired, 'shim start sites missing eveRouting').toEqual([]);
  });

  it('the NORMAL STARTUP BOOTSTRAP (the unguarded one) installs it', () => {
    // The two IPC-provider sites are lazy: `commandEveOllamaShimUrl || (await
    // start...)`. The bootstrap is the one with NO such guard — it is the call the
    // product takes on every launch, and it is the site whose deletion left the
    // suite green.
    const bootstraps = shimStartCallSites().filter((s) => !/commandEveOllamaShimUrl\s*\|\|/.test(s.preceding));
    expect(bootstraps.length, 'exactly one unguarded startup bootstrap').toBe(1);
    expect(bootstraps[0].options).toMatch(/eveRouting:\s*buildCommandEveShimRoutingResolver\(\)/);
  });

  it('the resolver factory it installs is the one that owns the lane-state read', () => {
    // Ties this file to the OTHER half of the proof: the factory must still route
    // through resolveEveCloudRouteFromBackend, which owns the reader and the clamp.
    const src = stripComments(INDEX_TS);
    const factory = src.slice(
      src.indexOf('function buildCommandEveShimRoutingResolver'),
      src.indexOf('function buildCommandEveManagedLocalOpenAiRoutingResolver')
    );
    expect(factory).toMatch(/return resolveEveCloudRouteFromBackend\(\{/);
    expect(factory).not.toMatch(/readLaneState/);
  });
});

/**
 * POSITIVE CONSEQUENCE CONTROL.
 *
 * The probe above proves the option is PRESENT. These prove the option is what
 * makes EVE routing exist at all — so "present" is not a cosmetic assertion.
 *
 * The shim defaults `eveRouting` to a resolver that yields nothing
 * (ollamaOpenAiShim.ts: `shimOptions.eveRouting || (() => undefined)`), so a shim
 * started WITHOUT the option cannot reach the EVE lane no matter what the picker
 * says. Deleting the wiring at the bootstrap therefore does not merely remove a
 * line — it silently returns every seat to the local lane.
 */
describe('consequence control — installing eveRouting is what creates the EVE lane', () => {
  afterEach(async () => {
    await stopCommandEveOllamaOpenAiShimForTest();
  });

  // The shim's OWN local auth gate sits ahead of the lane; without this both
  // requests 401 there and the control would compare two identical refusals.
  const SHIM_TOKEN = 'shim-token-for-bootstrap-wiring-test';

  const chat = (url: string) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SHIM_TOKEN}` },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
    });

  it('WITH an active EVE route the request enters the EVE lane (and fails on the missing bearer)', async () => {
    const url = await startCommandEveOllamaOpenAiShim({
      port: 0,
      authToken: SHIM_TOKEN,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: async () => ({
        active: true,
        tier: 'standard',
        functionUrl: 'https://example.supabase.co/functions/v1/eve-inference',
        license: undefined,
      }),
    });

    const res = await chat(url);
    // 401 with the EVE-specific bearer refusal: it got INTO the cloud lane. That
    // response is unreachable without the resolver.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toMatch(/CEVE license bearer/i);
  });

  it('WITHOUT eveRouting the SAME request never reaches the EVE lane', async () => {
    const url = await startCommandEveOllamaOpenAiShim({
      port: 0,
      authToken: SHIM_TOKEN,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      // eveRouting deliberately omitted — this is the post-deletion state.
    });

    const res = await chat(url);
    expect(res.status).not.toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/CEVE license bearer/i);
  });
});
