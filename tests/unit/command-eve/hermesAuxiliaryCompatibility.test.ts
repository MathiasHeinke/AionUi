/**
 * MAT-1749 — Hermes auxiliary compatibility, and the terminality of a refusal.
 *
 * Two properties that are cheap to lose silently:
 *
 *  1. The classification of Hermes' auxiliary tasks is derived from ONE bundled
 *     wheel. A Hermes bump can add a task, and an unclassified task is exactly how
 *     an unrequested charge got to a customer in the first place. The wheel is
 *     pinned by sha256 so a bump cannot land without this decision being re-made.
 *
 *  2. A refusal must be TERMINAL. Hermes' auxiliary client retries on the next
 *     provider in its auto chain for payment, auth and rate-limit failures — which
 *     can mean OpenRouter, Nous Portal or Anthropic. If our refusal looked like one
 *     of those, refusing a request would push it OFF-DEVICE. That is worse than the
 *     bug this ticket fixes: a money defect would become a privacy defect.
 */
import crypto from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
} from '@/process/commandEve/ollamaOpenAiShim';
import {
  COMMAND_EVE_HERMES_AUXILIARY_TASKS,
  commandEvePaidOperations,
  commandEveRegisteredOperations,
} from '@/process/commandEve/paidOperationRegistryCore';

const WHEEL_PATH = fileURLToPath(
  new URL('../../../resources/bundled-hermes/hermes_agent-0.17.0-py3-none-any.whl', import.meta.url)
);

/**
 * The exact wheel this classification was read from.
 *
 * Bumping Hermes changes this digest and reddens the test BY DESIGN. The correct
 * response is to re-enumerate `task=` call sites in the new wheel, classify anything
 * new, and update this constant — never to relax the assertion.
 */
const PINNED_WHEEL_SHA256 = 'a0a5427f6025474288af4399fa277e871813d6b409ad253fd5154bb30d7e62d9';

describe('MAT-1749 — the auxiliary classification is pinned to the wheel it came from', () => {
  it('still ships the exact Hermes wheel the classification was derived from', () => {
    expect(fs.existsSync(WHEEL_PATH), 'the pinned Hermes wheel is missing or was renamed').toBe(true);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(WHEEL_PATH)).digest('hex');
    expect(
      digest,
      'the bundled Hermes wheel changed — re-enumerate its call_llm task= call sites and classify anything new before updating this pin'
    ).toBe(PINNED_WHEEL_SHA256);
  });

  it('classifies every enumerated auxiliary, and makes none of them payable', () => {
    const registered = commandEveRegisteredOperations();
    const paid = commandEvePaidOperations();

    expect(COMMAND_EVE_HERMES_AUXILIARY_TASKS).toHaveLength(9);
    for (const task of COMMAND_EVE_HERMES_AUXILIARY_TASKS) {
      expect(registered, `${task} is reachable in the bundled wheel but is not classified`).toContain(task);
      expect(paid, `${task} must never be payable — no hidden auxiliary charges`).not.toContain(task);
    }

    // The payable set is the whole product rule in one line.
    expect(paid).toEqual(['user_chat_turn', 'honcho_deriver']);
  });

  it('keeps the task-less auxiliary escape hatch classified too', () => {
    // Hermes calls call_llm with no task at all in places (plugin_llm, the trajectory
    // compressor). They declare `eve_auxiliary` instead, which must stay non-payable.
    expect(commandEveRegisteredOperations()).toContain('eve_auxiliary');
    expect(commandEvePaidOperations()).not.toContain('eve_auxiliary');
  });
});

/**
 * Hermes' provider-fallback triggers, transcribed from the pinned wheel.
 *
 * HONEST ABOUT WHAT THIS IS: a transcription, not the executed Python. vitest cannot
 * run the wheel's interpreter, so these predicates mirror the source and the wheel is
 * sha-pinned above so the mirror cannot drift without a test failing first.
 *
 *   _is_payment_error    FACT(whl agent/auxiliary_client.py:2365-2373) — status in
 *                        {402, 404, 429, None} AND a billing keyword in the message.
 *   _is_auth_error       FACT(whl agent/auxiliary_client.py:2499-2513) — status 401,
 *                        or 403 ONLY when the message contains "bad-credentials".
 *   _is_rate_limit_error FACT(whl agent/auxiliary_client.py:2413-2428) — status 429,
 *                        or a RateLimitError instance.
 */
const HERMES_BILLING_KEYWORDS = [
  'credits',
  'insufficient funds',
  'can only afford',
  'billing',
  'payment required',
  'out of funds',
  'run out of funds',
  'balance_depleted',
  'no usable credits',
  'model_not_supported_on_free_tier',
  'not available on the free tier',
];

function hermesWouldRetryOnAnotherProvider(status: number, message: string): boolean {
  const lower = message.toLowerCase();
  const paymentError = [402, 404, 429].includes(status) && HERMES_BILLING_KEYWORDS.some((kw) => lower.includes(kw));
  const authError = status === 401 || (status === 403 && lower.includes('bad-credentials'));
  const rateLimitError = status === 429;
  return paymentError || authError || rateLimitError;
}

const SHIM_JSON_HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${ensureCommandEveShimAuthToken()}`,
};

let meteredServer: http.Server | undefined;
let meteredHits = 0;

afterEach(async () => {
  await stopCommandEveOllamaOpenAiShimForTest();
  await new Promise<void>((resolve) => (meteredServer ? meteredServer.close(() => resolve()) : resolve()));
  meteredServer = undefined;
  meteredHits = 0;
});

async function startShimWithMeteredLane(): Promise<string> {
  meteredHits = 0;
  meteredServer = http.createServer((_request: IncomingMessage, response: ServerResponse) => {
    meteredHits += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'paid' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>((resolve, reject) => {
    meteredServer?.once('error', reject);
    meteredServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = meteredServer.address();
  if (!address || typeof address === 'string') throw new Error('metered host exposed no port');
  const functionUrl = `http://127.0.0.1:${address.port}`;

  return startCommandEveOllamaOpenAiShim({
    port: 0,
    ollamaBaseUrl: 'http://127.0.0.1:1', // deliberately dead: refusals must not need it
    eveRouting: () => ({ active: true, functionUrl, license: 'ceve-test-license', tier: 'standard' }),
  });
}

describe('MAT-1749 — a refusal is TERMINAL and cannot push the turn off-device', () => {
  it.each([
    ['an absent declaration', {}],
    ['a caller claiming the deriver rung', { eve_operation: 'honcho_deriver' }],
  ])('%s is refused in a way Hermes will not retry elsewhere', async (_label, extra) => {
    const shimUrl = await startShimWithMeteredLane();

    const response = await fetch(`${shimUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        model: 'custom:command-eve-gemma-64k:latest',
        messages: [{ role: 'user', content: 'Fasse meine offenen Rechnungen zusammen.' }],
        ...(extra as Record<string, unknown>),
      }),
    });
    const payload = (await response.json()) as { error?: { message?: string; code?: string } };
    const message = payload.error?.message ?? '';

    expect(response.status).toBe(403);
    expect(meteredHits).toBe(0);

    // THE CLAIM: this exact (status, message) pair matches none of Hermes' triggers,
    // so the auxiliary client raises instead of re-running the turn on OpenRouter,
    // Nous Portal or Anthropic. A refusal that leaked off-device would be worse than
    // the overcharge this ticket exists to fix.
    expect(
      hermesWouldRetryOnAnotherProvider(response.status, message),
      `refusal "${message}" would trigger Hermes provider fallback`
    ).toBe(false);

    // The specific ways it could go wrong, named so a future edit cannot reintroduce
    // them by accident: never 401/402/429, and never billing-flavoured wording.
    expect([401, 402, 404, 429]).not.toContain(response.status);
    expect(message.toLowerCase()).not.toContain('bad-credentials');
    for (const keyword of HERMES_BILLING_KEYWORDS) {
      expect(message.toLowerCase(), `refusal message must not contain the billing keyword "${keyword}"`).not.toContain(
        keyword
      );
    }
  });
});
