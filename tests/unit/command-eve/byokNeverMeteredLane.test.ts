/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BYOK NEVER TOUCHES THE METERED LANE — PROVEN BY WHAT HAPPENS, NOT BY WHERE THE
 * CODE LIVES.
 *
 * THE ASYMMETRY THIS CLOSES. The private local lane carries a dozen committed
 * proofs that it reaches no paid endpoint and moves no credit. BYOK — the other
 * lane whose turns are funded by the operator rather than by us — carried ZERO.
 * What existed instead was an argument from topology: "every debit lives inside a
 * licence-gated function, therefore a non-EVE lane cannot reach the ledger." That
 * argument was made about this estate, in an audit that returned PASS, and it was
 * WRONG — the Honcho deriver walked straight into one of those licence-gated
 * functions on a seat whose picker was local. A claim about the SHAPE of the code
 * is not a claim about the REQUESTS it makes.
 *
 * SO EVERY ASSERTION BELOW READS AN EVENT:
 *   - a `fetch` recorder captures EVERY outbound URL the shim actually requests,
 *     and reaching either metered host THROWS rather than merely being noted, so an
 *     accidental egress can not be quietly counted and passed over;
 *   - the fake endpoint appends a DEBIT ROW per call, exactly as the real function
 *     reserves-calls-debits, and "no debit was written" is read off the rows;
 *   - a fake local upstream records the turn, so the negative above means "served
 *     elsewhere" rather than "dropped on the floor" — a refusal that serves nobody
 *     would satisfy a no-egress assertion just as well, and must not.
 *
 * WHAT IS DELIBERATELY NOT CHANGED HERE: `shouldDisableModelByok` keeps returning
 * true for a trialing entitlement. The founder contract excludes BYOK from the
 * trial; that lock is CORRECT and is pinned below rather than relaxed. The missing
 * property was never "BYOK should be available" — it was "when BYOK is entitled and
 * selected, prove it costs us nothing".
 *
 * NAMING: `.test.ts` — the vitest `node` project takes `tests/unit/**\/*.test.ts`
 * and excludes `*.dom.test.*`. No DOM is involved: a shim, two http servers and a
 * pure core.
 */

import http, { type IncomingMessage } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONLY mocked thing: the backend settings transport the lane-state read rides.
const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import {
  connectedSelectionValue,
  EVE_DEFAULT_INFERENCE_SELECTION,
  EVE_INFERENCE_FUNCTION_URL,
  isConnectedSelection,
  isEveInferenceSelection,
  localTierValue,
  repairInferenceSelection,
  shouldDisableModelByok,
} from '@/common/config/eveInferenceCore';
import { EVE_MULTIMODAL_FUNCTION_URL } from '@/common/config/eveMultimodalGatewayCore';
import { resolveEveCloudRouteFromBackend } from '@process/commandEve/inferenceSelectionBackendRead';
import { __resetActiveSeatForTests } from '@process/commandEve/seatContextCore';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';

const SELECTION_KEY = 'commandEve.inferenceSelection';
const FAKE_LICENSE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';
const SHIM_AUTH_TOKEN = ensureCommandEveShimAuthToken();

/** A BYOK/connected selection exactly as a routed provider adapter would commit it. */
const BYOK_SELECTION = connectedSelectionValue('openrouter:my-own-key-model');

/** The two hosts a turn may NEVER reach on this lane. */
const METERED_HOSTS = [new URL(EVE_INFERENCE_FUNCTION_URL).host, new URL(EVE_MULTIMODAL_FUNCTION_URL).host];

/** The settings bag the renderer persists for the active (legacy) seat. */
const settingsBag = (selection: string): Record<string, unknown> => ({
  [seatScopedKey(SELECTION_KEY, null)]: selection,
});

type LocalSeen = { hits: number; bodies: Array<Record<string, unknown>> };
type MeteredSeen = { hits: number; debits: Array<{ tier: unknown }> };

let localServer: http.Server | undefined;
let shimServerUrl = '';
let requestedUrls: string[] = [];
let realFetch: typeof globalThis.fetch;

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (c) => {
      raw += c;
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

/** A fake local upstream — the lane a BYOK/local turn is ALLOWED to reach. */
async function startFakeLocalUpstream(seen: LocalSeen): Promise<string> {
  localServer = http.createServer((request, response) => {
    void (async () => {
      seen.hits += 1;
      seen.bodies.push(await readBody(request));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local-ok' }, finish_reason: 'stop' }] })
      );
    })().catch(() => {
      response.writeHead(500);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    localServer?.once('error', reject);
    localServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = localServer.address();
  if (!address || typeof address === 'string') throw new Error('fake local upstream did not expose a port');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Record every outbound URL, and make a metered host a HARD failure at the moment
 * it is requested. A recorder that only counts would let the request happen.
 */
function installFetchRecorder(metered: MeteredSeen): void {
  realFetch = globalThis.fetch;
  requestedUrls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requestedUrls.push(url);
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = '';
    }
    if (METERED_HOSTS.includes(host)) {
      metered.hits += 1;
      metered.debits.push({ tier: (init?.body as string | undefined) ?? null });
      throw new Error(`a BYOK turn reached a METERED endpoint: ${url}`);
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
}

function chatPost(body: Record<string, unknown>): Promise<Response> {
  // Deliberately the RECORDED fetch is bypassed for the test's own request by
  // going through the saved original: the recorder is about what the SHIM does.
  return realFetch(`${shimServerUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SHIM_AUTH_TOKEN}` },
    body: JSON.stringify(body),
  });
}

/** The production seam: only the settings transport underneath it is a fake. */
const resolveRouteFromBackend = () =>
  resolveEveCloudRouteFromBackend({ readLicense: () => FAKE_LICENSE, functionUrl: EVE_INFERENCE_FUNCTION_URL });

beforeEach(() => {
  httpRequestMock.mockReset();
  __resetActiveSeatForTests();
});

afterEach(async () => {
  if (shimServerUrl) {
    await stopCommandEveOllamaOpenAiShimForTest();
    shimServerUrl = '';
  }
  if (localServer) {
    await new Promise<void>((resolve, reject) => localServer?.close((e) => (e ? reject(e) : resolve())));
    localServer = undefined;
  }
  if (realFetch) globalThis.fetch = realFetch;
  __resetActiveSeatForTests();
});

describe('BYOK — an entitled, SELECTED own-key lane never reaches a metered endpoint', () => {
  it('the real routing chain answers INACTIVE: no function url, no licence, nothing to egress with', async () => {
    httpRequestMock.mockResolvedValue(settingsBag(BYOK_SELECTION));

    const route = await resolveRouteFromBackend();

    expect(route?.active).toBe(false);
    // Not merely "inactive": the route carries no credential and no destination, so
    // there is nothing an accidental caller could use even if it ignored the flag.
    expect(route?.functionUrl).toBeUndefined();
    expect(route?.license).toBeUndefined();
    expect(route?.tier).toBeUndefined();
  });

  it('a BYOK chat turn is SERVED — and neither metered host is contacted, and no debit is written', async () => {
    const metered: MeteredSeen = { hits: 0, debits: [] };
    const local: LocalSeen = { hits: 0, bodies: [] };
    installFetchRecorder(metered);
    const upstream = await startFakeLocalUpstream(local);
    httpRequestMock.mockResolvedValue(settingsBag(BYOK_SELECTION));

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: upstream,
      // THE PRODUCTION RESOLVER, not a stand-in for it.
      eveRouting: () => resolveRouteFromBackend(),
    });

    const response = await chatPost({
      model: 'gemma4:e4b',
      messages: [{ role: 'user', content: 'write the invoice' }],
      stream: false,
    });

    // SERVED: the turn was answered, somewhere that is not ours to bill.
    expect(response.status).toBe(200);
    expect(local.hits).toBe(1);
    // NOT METERED: no request to either paid host, and no debit row.
    expect(metered.hits).toBe(0);
    expect(metered.debits).toEqual([]);
    expect(requestedUrls.some((u) => u.startsWith(EVE_INFERENCE_FUNCTION_URL))).toBe(false);
    expect(requestedUrls.some((u) => u.startsWith(EVE_MULTIMODAL_FUNCTION_URL))).toBe(false);
    // And the lane header the receipt reads was never stamped as the cloud lane.
    expect(response.headers.get('x-command-eve-inference-lane')).not.toBe('eve_cloud');
  });

  it('a BYOK turn CARRYING AN IMAGE reaches neither the inference nor the multimodal function', async () => {
    // The multimodal gateway is the second metered host, and an image turn is the
    // shape that could plausibly reach it. Asserted on the SAME recorder, so the
    // claim is about requests made, not about which module owns the URL constant.
    const metered: MeteredSeen = { hits: 0, debits: [] };
    const local: LocalSeen = { hits: 0, bodies: [] };
    installFetchRecorder(metered);
    const upstream = await startFakeLocalUpstream(local);
    httpRequestMock.mockResolvedValue(settingsBag(BYOK_SELECTION));

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: upstream,
      eveRouting: () => resolveRouteFromBackend(),
    });

    const response = await chatPost({
      model: 'gemma4:e4b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is on this receipt?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
      stream: false,
    });

    expect(response.status).toBe(200);
    expect(metered.hits).toBe(0);
    expect(metered.debits).toEqual([]);
    for (const host of METERED_HOSTS) {
      expect(
        requestedUrls.filter((u) => {
          try {
            return new URL(u).host === host;
          } catch {
            return false;
          }
        }),
        `a BYOK image turn reached ${host}`
      ).toEqual([]);
    }
  });

  it('CONTROL: the same harness DOES reach the metered host on an EVE selection — the recorder is real', async () => {
    // Without this row every assertion above would pass just as happily against a
    // recorder that never observes anything, or a shim that answers nothing.
    const metered: MeteredSeen = { hits: 0, debits: [] };
    const local: LocalSeen = { hits: 0, bodies: [] };
    installFetchRecorder(metered);
    const upstream = await startFakeLocalUpstream(local);
    httpRequestMock.mockResolvedValue(settingsBag(EVE_DEFAULT_INFERENCE_SELECTION));

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: upstream,
      eveRouting: () => resolveRouteFromBackend(),
    });

    const response = await chatPost({
      model: 'gemma4:e4b',
      messages: [{ role: 'user', content: 'write the invoice' }],
      stream: false,
      // MAT-1749: a real user turn DECLARES itself at the paid seam — the provider
      // profile stamps this on every main-agent call to the loopback shim. The
      // control has to model the turn the product actually sends, or it would
      // silently start measuring the operation allowlist instead of the recorder.
      eve_operation: 'user_chat_turn',
    });

    // The recorder REFUSES the egress (that is its job), so the turn fails — but it
    // was attempted, which is the fact this control exists to establish.
    expect(metered.hits).toBe(1);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(local.hits).toBe(0);
  });
});

describe('BYOK — the trial lock STAYS, and the selection is never repaired onto the metered lane', () => {
  it('a trialing seat keeps BYOK LOCKED — the founder contract excludes it from the trial', () => {
    // Pinned rather than relaxed. Whatever else changes here, this must not.
    const trialing = { trial_ends_at: '2099-01-01T00:00:00.000Z' };
    expect(shouldDisableModelByok(trialing, true)).toBe(true);
    expect(shouldDisableModelByok(trialing, false)).toBe(true);
  });

  it('REPAIR: a persisted BYOK selection survives verbatim — it is NEVER rewritten to the metered default', () => {
    // THE LATENT MONEY HOLE. `repairInferenceSelection` treats "carries neither
    // prefix" as corrupt and rewrites it to the metered default. A connected value
    // carried neither, so an own-key selection would have been silently converted
    // into a billed turn. Dead code today — no production caller supplies connected
    // groups — which is exactly when a money hole is cheapest to close.
    const repaired = repairInferenceSelection(BYOK_SELECTION);
    expect(repaired.selection).toBe(BYOK_SELECTION);
    expect(repaired.repaired).toBe(false);
    expect(repaired.selection).not.toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(isEveInferenceSelection(repaired.selection)).toBe(false);
  });

  it('an UNKNOWN connected id is honoured too — the connected surface may grow without being billed', () => {
    const exotic = connectedSelectionValue('a-provider-nobody-has-shipped-yet:some-model');
    const repaired = repairInferenceSelection(exotic);
    expect(repaired.selection).toBe(exotic);
    expect(repaired.repaired).toBe(false);
  });

  it('the corrupt case still repairs — the exemption is for BYOK, not for everything unparseable', () => {
    // The paired positive: without it, the two rows above would pass against a
    // `repairInferenceSelection` that had simply stopped repairing anything.
    const corrupt = repairInferenceSelection('not-a-lane-at-all');
    expect(corrupt.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(corrupt.repaired).toBe(true);
  });

  it('the three lanes are distinguishable — a BYOK value is neither EVE nor local', () => {
    expect(isConnectedSelection(BYOK_SELECTION)).toBe(true);
    expect(isEveInferenceSelection(BYOK_SELECTION)).toBe(false);
    expect(isConnectedSelection(localTierValue('local-high'))).toBe(false);
    expect(isConnectedSelection(EVE_DEFAULT_INFERENCE_SELECTION)).toBe(false);
  });
});
