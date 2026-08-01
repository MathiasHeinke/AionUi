/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — `POST /eve/artifact/call`, driven over REAL HTTP.
 *
 * This file exists because the previous suite had none. Every test drove
 * `artifactCapabilityCallHandler` directly, which means the bearer comparison,
 * the 404-inert posture and the body bound were never executed by a test at all:
 * the gate had full coverage of everything behind it and none of itself.
 *
 * So every case below goes through `fetch` against a listening server, exactly
 * as the MCP child does:
 *
 *   - VALID bearer          -> the handler is reached
 *   - WRONG bearer          -> 404, handler never reached
 *   - MISSING bearer        -> 404, handler never reached
 *   - LENGTH-MISMATCHED     -> 404 (a truncated or extended token must not pass;
 *                              the compare hashes both sides first precisely so
 *                              length is not a side channel)
 *   - UNPROVISIONED seat    -> 404, so the route is inert rather than open
 *   - oversized body        -> 413, and the handler is never reached
 *
 * "Handler never reached" is asserted rather than inferred, because a 404 that
 * happened AFTER the handler ran would look identical from the outside and would
 * mean the spending path had already executed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

const BEARER = 'a'.repeat(64);
const HANDLE = `evecap_${'b'.repeat(64)}`;

afterEach(async () => {
  await stopCommandEveOllamaOpenAiShimForTest();
});

type Call = { body: unknown };

async function startWith(bearer: string) {
  const calls: Call[] = [];
  const url = await startCommandEveOllamaOpenAiShim({
    port: 0,
    artifactCapabilityBearer: () => bearer,
    artifactCapabilityCall: async (body: unknown) => {
      calls.push({ body });
      return { status: 200, payload: { ok: true, artifact_id: 'video-1' } };
    },
  });
  return { url, calls };
}

function post(url: string, init: { authorization?: string; body?: string } = {}) {
  return fetch(`${url}/eve/artifact/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.authorization === undefined ? {} : { authorization: init.authorization }),
    },
    body: init.body ?? JSON.stringify({ operation: 'artifact_get', handle: HANDLE }),
  });
}

describe('the loopback bearer gate, over real HTTP', () => {
  it('reaches the handler on the EXACT bearer — the positive control for every 404 below', async () => {
    const { url, calls } = await startWith(BEARER);
    const res = await post(url, { authorization: `Bearer ${BEARER}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, artifact_id: 'video-1' });
    expect(calls).toHaveLength(1);
    expect((calls[0].body as Record<string, unknown>).handle).toBe(HANDLE);
  });

  it('is 404 on a WRONG bearer of the same length, and never reaches the handler', async () => {
    const { url, calls } = await startWith(BEARER);
    const res = await post(url, { authorization: `Bearer ${'c'.repeat(64)}` });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('is 404 on a MISSING Authorization header', async () => {
    const { url, calls } = await startWith(BEARER);
    const res = await post(url);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('is 404 on an EMPTY bearer value', async () => {
    const { url, calls } = await startWith(BEARER);
    const res = await post(url, { authorization: 'Bearer ' });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('is 404 on a LENGTH-MISMATCHED bearer — truncated and extended alike', async () => {
    const { url, calls } = await startWith(BEARER);
    const truncated = await post(url, { authorization: `Bearer ${BEARER.slice(0, 32)}` });
    const extended = await post(url, { authorization: `Bearer ${BEARER}extra` });
    expect(truncated.status).toBe(404);
    expect(extended.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('accepts the raw token without the "Bearer " prefix, and still rejects a wrong one', async () => {
    // The prefix is optional in this route's parser. That is a real behaviour,
    // so it gets a real test — including the negative half, so the test is about
    // the comparison and not about the parser being permissive.
    const { url, calls } = await startWith(BEARER);
    expect((await post(url, { authorization: BEARER })).status).toBe(200);
    expect((await post(url, { authorization: 'd'.repeat(64) })).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('is 404-INERT when main never provisioned a bearer', async () => {
    // An unprovisioned seat must look like a seat that has no such route at all,
    // not like a seat with an open one.
    const { url, calls } = await startWith('');
    const res = await post(url, { authorization: `Bearer ${BEARER}` });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('the loopback body bound, over real HTTP', () => {
  it('refuses an oversized body with 413 and never reaches the handler', async () => {
    const { url, calls } = await startWith(BEARER);
    // 100 KB against a 64 KB ceiling. This route only ever carries two 70-odd
    // character credentials and a 2000-character instruction.
    const oversized = JSON.stringify({ operation: 'artifact_get', handle: HANDLE, pad: 'x'.repeat(100_000) });
    const res = await post(url, { authorization: `Bearer ${BEARER}`, body: oversized });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('accepts a body just under the ceiling — the control that proves the bound is a bound and not a wall', async () => {
    const { url, calls } = await startWith(BEARER);
    const nearLimit = JSON.stringify({ operation: 'artifact_get', handle: HANDLE, pad: 'x'.repeat(40_000) });
    const res = await post(url, { authorization: `Bearer ${BEARER}`, body: nearLimit });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('answers malformed JSON with 400, distinctly from the 413', async () => {
    const { url, calls } = await startWith(BEARER);
    const res = await post(url, { authorization: `Bearer ${BEARER}`, body: '{ not json' });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects the route on a method other than POST', async () => {
    const { url } = await startWith(BEARER);
    const res = await fetch(`${url}/eve/artifact/call`, {
      method: 'GET',
      headers: { authorization: `Bearer ${BEARER}` },
    });
    expect(res.status).toBe(404);
  });
});
