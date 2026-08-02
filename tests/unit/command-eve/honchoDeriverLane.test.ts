/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-624 — the Honcho DERIVER cloud lane on the shim (`POST /honcho/deriver`).
 * This is the SERVER-SIDE enforcement of the two invariants honchoRuntimeConfigCore
 * only NAMES:
 *   MONEY  — the deriver ALWAYS rides the METERED ENTRY rung 'standard',
 *            picker-independent: an operator sitting on eve-max can not make EVE's
 *            memory derivation bill a FRONTIER tier. The cap is on what a background
 *            task may SPEND — never a claim that it spends nothing. 'standard'
 *            declares consumesCredits: true and its turns are debited like any other.
 *   EGRESS — the deriver text runs through the SAME S11/S13 egress redaction as
 *            chat before any byte reaches the eve-inference function.
 * Plus: fail-closed (503) when no cloud route/license, and byte-additivity
 * (the lane is inert until Honcho is provisioned).
 */

import http, { type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

/** Synthetic CEVE wire string — NOT a real license. */
const FAKE_LICENSE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';
const SHIM_AUTH_TOKEN = ensureCommandEveShimAuthToken();

type EveFnSeen = {
  body?: Record<string, unknown>;
  authHeader?: string | null;
  path?: string;
  hits: number;
  /**
   * THE DEBIT LEDGER, OBSERVED RATHER THAN INFERRED.
   *
   * An audit passed this area from TOPOLOGY — "all debits live in licence-gated
   * functions, therefore the local lane cannot touch the ledger" — and was wrong,
   * because the deriver reached one of those functions on a seat whose picker was
   * local. So this harness does not reason about where debits live: the fake
   * eve-inference function APPENDS A ROW every time it is called, exactly as the
   * real one reserves-calls-debits, and the assertions read the rows. "No debit was
   * written" is then a fact about what happened, not a claim about the code's shape.
   */
  debits: Array<{ tier: unknown }>;
};

/** A fresh recorder: zero hits, empty ledger. */
const newSeen = (): EveFnSeen => ({ hits: 0, debits: [] });

/**
 * The operator's CHAT picker sitting on the METERED EVE cloud lane — the ONLY state
 * in which EVE's background memory derivation is allowed to spend. The deriver never
 * reads this route's url/licence (it forces its own), only its `active` fact, so the
 * url here is deliberately a dead port.
 */
const chatLaneMeteredCloud = () => ({
  active: true,
  functionUrl: 'http://127.0.0.1:1',
  license: FAKE_LICENSE,
  tier: 'standard',
});

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
      // A call to this endpoint IS a metered turn: it reserves, calls and debits.
      seen.debits.push({ tier: seen.body?.tier });
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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SHIM_AUTH_TOKEN}` },
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
  it('routes the deriver to the eve-inference function at the METERED standard rung with the bearer in the header only', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1', // never reached
      eveRouting: chatLaneMeteredCloud,
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

  it('MONEY: forces the METERED standard rung even when the chat picker is eve-max (paid) — the cap is one-way', async () => {
    const seen = newSeen();
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
    const seen = newSeen();
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
      eveRouting: chatLaneMeteredCloud,
      honchoDeriverRoute: () => spoofRoute,
    });

    await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });
    expect(seen.body?.tier).toBe('standard');
  });

  it('EGRESS: redacts a secret in the deriver text before the function is called (S11/S13 runs on this lane)', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: chatLaneMeteredCloud,
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

  it('EGRESS: holds the S3 secret floor even on the legacy seat with redaction OFF (Codex #1 — never auto-sends secrets)', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      egressRedactionMode: () => 'off', // operator turned the filter OFF
      activeSeatId: () => 'seat-1', // the founder's OWN legacy seat — the chat lane WOULD waive S3 here
      eveRouting: chatLaneMeteredCloud,
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({
      model: 'x',
      messages: [{ role: 'user', content: 'API key: sk-abcdefghijklmnopqrstuvwxyz123456' }],
      stream: false,
    });

    // The deriver is automatic background reasoning, so the S3 floor is NOT waived:
    // the secret is redacted before the function is called even here.
    expect(response.status).toBe(200);
    const forwarded = JSON.stringify(seen.body);
    expect(forwarded).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(forwarded).toContain('[REDACTED_SECRET]');
  });

  it('EGRESS: ALLOWLISTS the outbound body — tools/tool_choice/parallel_tool_calls/response_format never forwarded (Codex #2 + re-audit)', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: chatLaneMeteredCloud,
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({
      model: 'x',
      messages: [{ role: 'user', content: 'derive' }],
      tools: [
        {
          type: 'function',
          function: { name: 'crm', description: 'Kunde max@example.de IBAN DE89370400440532013000' },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      // an un-scanned passthrough field that could smuggle text past the messages-only egress scan
      response_format: {
        type: 'json_schema',
        json_schema: { name: 's', description: 'secret sk-abcdefghijklmnopqrstuvwxyz123456' },
      },
      stream: false,
    });

    expect(response.status).toBe(200);
    // Only the allowlisted fields survive.
    expect(seen.body).not.toHaveProperty('tools');
    expect(seen.body).not.toHaveProperty('tool_choice');
    expect(seen.body).not.toHaveProperty('parallel_tool_calls');
    expect(seen.body).not.toHaveProperty('response_format');
    const forwarded = JSON.stringify(seen.body);
    expect(forwarded).not.toContain('max@example.de');
    expect(forwarded).not.toContain('DE89370400440532013000');
    expect(forwarded).not.toContain('abcdefghijklmnopqrstuvwxyz'); // the response_format secret never egresses
  });

  // ── THE INVERTED PIN — LOCAL IS COST-FREE END TO END, MEMORY INCLUDED ────────
  //
  // THE ROW THAT USED TO STAND HERE:
  //
  //   it('is picker-independent on the OTHER side too: reaches the cloud fn even
  //       when the chat picker is LOCAL', …)
  //     expect(response.status).toBe(200);
  //     expect(seen.hits).toBe(1); // the deriver reached the cloud fn, …
  //
  // It is kept, verbatim, above — because it is the only committed record of what
  // this lane USED to do, and deleting the record would leave the fix looking like a
  // feature rather than a correction. It PASSED, and the property its own words
  // describe was the defect: an operator who had picked the lane that spends nothing
  // still had EVE's background memory reasoning drawing METERED cloud turns, with no
  // surface anywhere that could stop it (`deriverMode` is not user-selectable).
  //
  // Inverted, the same construction is the guard. Nothing else about the harness
  // changed: same fake function, same route, same request.
  it('LOCAL chat picker: the cloud fn is NEVER reached and NO debit is written', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1', // a local chat would try (and fail) here
      eveRouting: () => ({ active: false }), // operator's chat is on the LOCAL lane
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });

    // BEHAVIOURAL, not structural. Not "a flag is set", not "the debit code is behind
    // a licence gate" — the metered endpoint recorded NOTHING, so nothing was
    // reserved, called or debited.
    expect(seen.hits).toBe(0);
    expect(seen.debits).toEqual([]);
    expect(response.status).toBe(503);
  });

  it('BYOK chat picker: the same refusal — an own-key seat is not quietly metered by its memory', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      // A connected/BYOK selection is not an EVE selection, so the routing resolver
      // answers exactly this — the same shape the local lane produces.
      eveRouting: () => ({ active: false }),
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });

    expect(seen.hits).toBe(0);
    expect(seen.debits).toEqual([]);
    expect(response.status).toBe(503);
  });

  it('R4 HOLD: a chat-lane resolver that THROWS never becomes permission to spend', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      // The unknown-entitlement hold: the chat resolver refuses to answer at all.
      eveRouting: () => {
        throw new Error('entitlement authority is unknown');
      },
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });

    expect(seen.hits).toBe(0);
    expect(seen.debits).toEqual([]);
    expect(response.status).toBe(503);
  });

  it('NO PICKER WIRED AT ALL is not permission either — default-deny in every direction', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      // No eveRouting: the shim default answers `undefined`. "We could not ask"
      // must not read as "go ahead" — that is how a hole gets a different name.
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });

    expect(seen.hits).toBe(0);
    expect(seen.debits).toEqual([]);
    expect(response.status).toBe(503);
  });

  it('POSITIVE CONTROL: a METERED chat picker still derives — exactly one turn, exactly one debit', async () => {
    // Without this row the four refusals above would pass just as happily against a
    // handler that answered 503 unconditionally, i.e. against a broken feature.
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: chatLaneMeteredCloud,
      honchoDeriverRoute: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }], stream: false });

    expect(response.status).toBe(200);
    expect(seen.hits).toBe(1);
    // And the one debit is the ENTRY rung, never the operator's chat tier.
    expect(seen.debits).toEqual([{ tier: 'standard' }]);
  });

  it('FAIL-CLOSED: 503 when the deriver route is absent (default inert lane)', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl: 'http://127.0.0.1:1' });
    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }] });
    expect(response.status).toBe(503);
  });

  it('FAIL-CLOSED: 503 when active but the license is missing (never egress half-configured)', async () => {
    const seen = newSeen();
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
    const seen = newSeen();
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

  // ── THE RETIRED FREE-CLOUD-LANE CONTRACT MAY NOT COME BACK ────────────────────
  //
  // Until 1.820.2 this handler was documented AND SPOKE as "the FREE cloud lane": the
  // JSDoc called it that, the branch was headed "FREE-TIER FORCED", the fail-closed
  // comment spoke of a missing "free-lane route", and the 503 an operator actually SEES
  // read "no free-tier route or license". The routing was never wrong; the name was.
  // 'standard' declares consumesCredits: true — the deriver's turns reserve, call and
  // debit exactly like a chat turn, so calling this lane free described a lane that has
  // not existed since the free lane was abolished server-side.
  //
  // Two assertions, because only one of them protects the USER:
  //   (a) the 503 BODY may not call the missing route free. That string is rendered.
  //   (b) the SOURCE of the deriver lane may not, in code or comment, describe this
  //       path as free. A comment is where the last one hid, and a comment is what the
  //       next person writing this handler reads. Comments are therefore IN scope here
  //       — the opposite choice from the web-copy gate, and for the opposite reason:
  //       there, a tombstone must be allowed; here, the file IS the doctrine.
  //
  // The scan deliberately excludes this test file (it must contain the words to test
  // for them) and is anchored to the handler + its route registration.
  it('the 503 body never calls the missing cloud route "free"', async () => {
    const seen = newSeen();
    const fnUrl = await startFakeEveFunction(seen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      honchoDeriverRoute: () => ({ active: false, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });
    const response = await deriverPost({ model: 'x', messages: [{ role: 'user', content: 'derive' }] });
    expect(response.status).toBe(503);
    const json = (await response.json()) as { error?: { message?: string } };
    const message = json.error?.message ?? '';
    expect(message.length).toBeGreaterThan(0);
    for (const promise of [/\bfree\b/i, /free-?tier/i, /free-?lane/i, /gratis/i, /kostenlos/i, /umsonst/i]) {
      expect(message, `the 503 must not describe the cloud route as free: ${promise}`).not.toMatch(promise);
    }
  });

  it('the deriver lane SOURCE never describes the metered cloud rung as a free lane', () => {
    const source = readFileSync(
      new URL('../../../packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts', import.meta.url),
      'utf8'
    );
    // Anchor on the handler so a rename that moves it out of this file reds here.
    expect(source).toContain('async function handleHonchoDeriverCompletions(');
    expect(source).toContain('/honcho/deriver/v1/chat/completions');

    // A FREE-word joined to this lane's vocabulary, on ONE line. Line-scoped so an
    // unrelated 'free' elsewhere in a 2,500-line file cannot be blamed on the deriver.
    const LANE = /(deriver|honcho|cloud[- ]?lane|cloud[- ]?flash|standard\/flash|wire tier|forced tier)/i;
    const FREE = /(\bfree\b|free-?tier|free-?lane|gratis|kostenlos|umsonst)/i;
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => LANE.test(line) && FREE.test(line))
      // 'parse free text' is about UNSTRUCTURED OUTPUT, not price. Exempted by exact
      // phrase, not by the word, so 'free tier' can never ride in on it.
      .filter(({ line }) => !/parse free text/i.test(line));

    expect(
      offenders.map(({ n, line }) => `${n}: ${line.trim()}`),
      'the deriver lane calls the metered cloud rung free again — it reserves, calls and debits like any other turn'
    ).toEqual([]);
  });
});
