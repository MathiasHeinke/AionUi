/**
 * MAT-1749 — the PAID-SEAM OPERATION ALLOWLIST, proven BEHAVIOURALLY.
 *
 * A real user sent ONE Standard message and was debited TWICE: the chat turn, then
 * Hermes' auxiliary `title_generation` riding the same authenticated loopback shim
 * onto the same metered cloud lane. The shim authenticated WHO was calling and never
 * asked WHAT FOR.
 *
 * WHY THESE TESTS LOOK THE WAY THEY DO. A flag assertion ("the guard returned
 * false") cannot tell you whether money moved. So the metered provider is a REAL
 * loopback server here, and EVERY request that reaches it is recorded as a DEBIT —
 * because that is exactly what the eve-inference function does when it is called.
 * The money claims below are therefore statements about observed traffic, not about
 * internal booleans: `debits: 0` means the metered host was never asked.
 */
import http, { type IncomingMessage, type ServerResponse } from 'http';
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
  resolveCommandEvePaidSeam,
} from '@/process/commandEve/paidOperationRegistryCore';

const SHIM_AUTH_TOKEN = ensureCommandEveShimAuthToken();
const SHIM_JSON_HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${SHIM_AUTH_TOKEN}`,
};

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

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server exposed no port');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * THE METERED HOST. Stands in for the eve-inference Edge Function — the thing that
 * charges the customer. It cannot be reached without spending, so every request it
 * receives is appended to `debits`. A test that expects no spend asserts this array
 * is empty; nothing else is accepted as proof.
 */
type MeteredHost = {
  url: string;
  debits: Array<{ tier: unknown; body: Record<string, unknown> }>;
  close: () => Promise<void>;
};

async function startMeteredHost(): Promise<MeteredHost> {
  const debits: Array<{ tier: unknown; body: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      debits.push({ tier: body.tier, body });
      writeJson(response, 200, {
        choices: [{ message: { role: 'assistant', content: 'paid-cloud-answer' }, finish_reason: 'stop' }],
      });
    })().catch(() => writeJson(response, 500, { error: 'metered host failed' }));
  });
  const url = await listen(server);
  return {
    url,
    debits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The FREE lane: a local Ollama that costs nothing and never leaves the machine. */
type LocalHost = {
  url: string;
  calls: Array<Record<string, unknown>>;
  close: () => Promise<void>;
};

async function startLocalOllama(content = 'Local Title About Invoices'): Promise<LocalHost> {
  const calls: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      calls.push(body);
      writeJson(response, 200, { message: { content }, done_reason: 'stop' });
    })().catch(() => writeJson(response, 500, { error: 'local host failed' }));
  });
  const url = await listen(server);
  return {
    url,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let metered: MeteredHost | undefined;
let local: LocalHost | undefined;

afterEach(async () => {
  await stopCommandEveOllamaOpenAiShimForTest();
  await metered?.close();
  await local?.close();
  metered = undefined;
  local = undefined;
});

/** Start the shim with the METERED cloud lane ACTIVE — the paid path under test. */
async function startShimOnPaidLane(): Promise<string> {
  metered = await startMeteredHost();
  local = await startLocalOllama();
  return startCommandEveOllamaOpenAiShim({
    port: 0,
    ollamaBaseUrl: local.url,
    eveRouting: () => ({ active: true, functionUrl: metered!.url, license: 'ceve-test-license', tier: 'standard' }),
  });
}

async function postChat(shimUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${shimUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: SHIM_JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

const USER_TURN = [{ role: 'user', content: 'Fasse meine offenen Rechnungen zusammen.' }];

describe('MAT-1749 registry — membership is the only way to the paid lane', () => {
  it('registers exactly the two founder-approved payable operations', () => {
    // Pinned deliberately. Widening this list is a money decision, so it must be a
    // conscious edit that breaks a test, never a quiet import side effect.
    expect(commandEvePaidOperations()).toEqual(['user_chat_turn', 'honcho_deriver']);
    expect(commandEveRegisteredOperations()).toEqual([
      'user_chat_turn',
      'honcho_deriver',
      'title_generation',
      'context_compression',
      'compression',
      'web_extract',
      'vision',
      'mcp',
      'approval',
      'tts_audio_tags',
      'monitor',
      'call',
      'eve_auxiliary',
    ]);
    // The registered set grew when the auxiliaries were classified explicitly. The
    // PAYABLE set did not, and that is the only line here that can cost anyone money.
    expect(commandEvePaidOperations()).toHaveLength(2);
  });

  it('refuses an ABSENT declaration and only an absent one', () => {
    // Absent is the single case that does NOT degrade to local. It most likely means
    // the user's own paid turn with a broken producer, and a paying customer silently
    // receiving free-model answers is worse than a loud 403.
    expect(resolveCommandEvePaidSeam(undefined)).toMatchObject({ disposition: 'refused', reason: 'absent' });
    expect(resolveCommandEvePaidSeam('   ')).toMatchObject({ disposition: 'refused', reason: 'absent' });
    expect(resolveCommandEvePaidSeam(42)).toMatchObject({ disposition: 'refused', reason: 'absent' });
    expect(resolveCommandEvePaidSeam({ operation: 'user_chat_turn' })).toMatchObject({
      disposition: 'refused',
      reason: 'absent',
    });
    expect(resolveCommandEvePaidSeam('title_generation')).toMatchObject({ disposition: 'local_only' });
    expect(resolveCommandEvePaidSeam('user_chat_turn')).toMatchObject({ disposition: 'paid' });
  });

  it('sends a NAMED but unregistered operation local — it may run, it may not spend', () => {
    // The ruling: this registry governs SPENDING, not whether a feature may run. A
    // task a FUTURE Hermes introduces lands here, and must degrade rather than break.
    for (const operation of ['some_future_hermes_auxiliary', 'summarise_inbox', 'whatever_ships_next']) {
      expect(resolveCommandEvePaidSeam(operation), `${operation} must run locally, not be refused`).toMatchObject({
        disposition: 'local_only',
        reason: 'unregistered',
      });
    }
  });

  it('classifies every reachable Hermes 0.17 auxiliary explicitly, and none of them as payable', () => {
    // The set is no longer implicit. Each of these is a REGISTERED local_only entry,
    // so it resolves without an `unregistered` reason — the classification is on the
    // record rather than falling through a default.
    for (const task of COMMAND_EVE_HERMES_AUXILIARY_TASKS) {
      const decision = resolveCommandEvePaidSeam(task);
      expect(decision.disposition, `${task} must be local_only`).toBe('local_only');
      expect(decision.reason, `${task} must be classified, not defaulted`).toBeUndefined();
      expect(commandEvePaidOperations(), `${task} must never be payable`).not.toContain(task);
    }
  });

  it('gives a task-LESS Hermes auxiliary a name so it degrades instead of being refused', () => {
    // FACT(whl agent/plugin_llm.py:949-950) call_llm(task=None, ...) and
    // FACT(whl trajectory_compressor.py:649-655) omit the task entirely. Without
    // eve_auxiliary they would arrive ABSENT and be refused — a hard break on real
    // paths — and ABSENT would stop meaning "the user's own turn lost its producer".
    expect(resolveCommandEvePaidSeam('eve_auxiliary')).toMatchObject({ disposition: 'local_only' });
    expect(resolveCommandEvePaidSeam('eve_auxiliary').reason).toBeUndefined();
    expect(commandEvePaidOperations()).not.toContain('eve_auxiliary');
  });

  it('lands BOTH compaction names on the free lane, whichever one arrives', () => {
    // The desktop's compression patch declares `context_compression`; Hermes' native
    // task is `compression` (FACT whl agent/context_compressor.py:1500). That patch
    // installs on a best-effort import and returns silently when it fails, so both
    // names must be non-billable — otherwise the safe behaviour would depend on
    // whether a silent ImportError happened.
    expect(resolveCommandEvePaidSeam('context_compression')).toMatchObject({ disposition: 'local_only' });
    expect(resolveCommandEvePaidSeam('compression')).toMatchObject({ disposition: 'local_only' });
    // Registered, so neither is reported as an unknown operation.
    expect(resolveCommandEvePaidSeam('compression').reason).toBeUndefined();
    expect(commandEvePaidOperations()).not.toContain('compression');
    expect(commandEvePaidOperations()).not.toContain('context_compression');
  });

  it('lets the shim mint the deriver rung but never lets a caller claim it', () => {
    // Registered AND payable, yet unclaimable from a request body: otherwise any
    // component holding the loopback nonce could buy itself the right to spend by
    // typing the deriver's name.
    expect(resolveCommandEvePaidSeam('honcho_deriver', 'shim')).toMatchObject({ disposition: 'paid' });
    expect(resolveCommandEvePaidSeam('honcho_deriver', 'client')).toMatchObject({
      disposition: 'refused',
      reason: 'not_client_declarable',
    });
  });
});

describe('MAT-1749 S1/S5 — title_generation costs the customer nothing', () => {
  it('S1: an unregistered title turn on the PAID path makes NO metered call and NO debit', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: [{ role: 'user', content: 'Generate a short title for this conversation.' }],
      eve_operation: 'title_generation',
    });

    // THE MONEY CLAIM: the metered host was never asked, so nothing could be billed.
    expect(metered!.debits).toHaveLength(0);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-operation')).toBe('local_only:title_generation');
    expect(response.headers.get('x-command-eve-inference-lane')).toBe('ollama_local');
  });

  it('S5: the same turn still produces a title, on the FREE local lane', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: [{ role: 'user', content: 'Generate a short title for this conversation.' }],
      eve_operation: 'title_generation',
    });
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };

    // A title is produced — the feature still works, it simply stopped costing money.
    expect(payload.choices[0].message.content).toBe('Local Title About Invoices');
    expect(local!.calls).toHaveLength(1);
    expect(metered!.debits).toHaveLength(0);
  });

  it('never leaks the operation declaration to the LOCAL provider', async () => {
    const shimUrl = await startShimOnPaidLane();
    await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
      eve_operation: 'title_generation',
    });
    expect(local!.calls).toHaveLength(1);
    expect(local!.calls[0]).not.toHaveProperty('eve_operation');
  });

  it('never leaks the operation declaration to the METERED provider', async () => {
    // This assertion used to live inside a test named "to ANY provider" that only
    // ever inspected the LOCAL body — a test named for a property it did not
    // measure, which is the defect class this whole ticket keeps turning up. The
    // metered body is the one that leaves the machine, so it is the one to check.
    const shimUrl = await startShimOnPaidLane();
    await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
      eve_operation: 'user_chat_turn',
    });

    expect(metered!.debits).toHaveLength(1);
    const outbound = metered!.debits[0].body;
    expect(outbound, 'the routing signal reached the paid provider').not.toHaveProperty('eve_operation');
    // The outbound body is an allowlist, so prove the shape is the intended one and
    // not merely missing this one key.
    expect(outbound).toHaveProperty('messages');
    expect(outbound).toHaveProperty('tier');
    expect(outbound).not.toHaveProperty('model');
  });
});

describe('MAT-1749 S3 — nothing unapproved spends: absent refuses, unknown goes local', () => {
  it('S3: an ABSENT declaration on the paid path REFUSES instead of defaulting through', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
    });

    expect(response.status).toBe(403);
    expect(metered!.debits).toHaveLength(0);
    expect(response.headers.get('x-command-eve-operation')).toBe('refused:absent');
    expect((await response.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'eve_operation_absent' },
    });
  });

  it('runs an operation nobody registered LOCALLY — no metered call, no debit, still works', async () => {
    // INVERTED DELIBERATELY (CEO ruling). This used to assert 403. Refusing a named
    // auxiliary saved money it was never going to spend and broke a working feature
    // to do it. It now runs on the free lane instead: the customer is not billed AND
    // the feature survives.
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
      eve_operation: 'some_future_hermes_auxiliary',
    });
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };

    // THE MONEY CLAIM: the metered host was never asked, so nothing could be billed.
    expect(metered!.debits).toHaveLength(0);
    // AND THE FUNCTION CLAIM: it still produced an answer, from the free lane.
    expect(response.status).toBe(200);
    expect(payload.choices[0].message.content).toBe('Local Title About Invoices');
    expect(local!.calls).toHaveLength(1);
    expect(response.headers.get('x-command-eve-operation')).toBe(
      'local_only:unregistered:some_future_hermes_auxiliary'
    );
    expect(response.headers.get('x-command-eve-inference-lane')).toBe('ollama_local');
  });

  // The real Hermes auxiliaries that genuinely reached the PAID lane before this fix
  // (FACT whl tools/web_tools.py:517, tools/vision_tools.py:968, tools/mcp_tool.py:1154,
  // tools/approval.py:1116, tools/tts_tool.py:1151). Each must now answer from the
  // free lane and bill nothing — running degraded beats not running at all.
  it.each(['web_extract', 'vision', 'mcp', 'approval', 'tts_audio_tags'])(
    'runs the real Hermes auxiliary %s locally rather than breaking it',
    async (operation) => {
      const shimUrl = await startShimOnPaidLane();

      const response = await postChat(shimUrl, {
        model: 'custom:command-eve-gemma-64k:latest',
        messages: USER_TURN,
        eve_operation: operation,
      });

      expect(response.status, `${operation} must still function`).toBe(200);
      expect(metered!.debits, `${operation} must not debit`).toHaveLength(0);
      expect(local!.calls, `${operation} must reach the free lane`).toHaveLength(1);
    }
  );

  it('refuses a caller that claims the deriver rung on the general lane', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
      eve_operation: 'honcho_deriver',
    });

    expect(response.status).toBe(403);
    expect(metered!.debits).toHaveLength(0);
    expect(response.headers.get('x-command-eve-operation')).toBe('refused:not_client_declarable');
  });
});

describe('MAT-1749 S4 — the positive controls: what must still work, still works', () => {
  it('S4a: the user OWN chat turn reaches the paid lane and debits EXACTLY once', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
      eve_operation: 'user_chat_turn',
    });
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }> };

    expect(response.status).toBe(200);
    // EXACTLY once — the guard must not have turned one debit into zero or two.
    expect(metered!.debits).toHaveLength(1);
    expect(metered!.debits[0].tier).toBe('standard');
    expect(payload.choices[0].message.content).toBe('paid-cloud-answer');
    expect(response.headers.get('x-command-eve-inference-lane')).toBe('eve_cloud');
    expect(local!.calls).toHaveLength(0);
  });

  it('S4b: the Honcho deriver keeps working on its OWN path and still bills as designed', async () => {
    metered = await startMeteredHost();
    local = await startLocalOllama();
    const shimUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: local.url,
      eveRouting: () => ({ active: true, functionUrl: metered!.url, license: 'ceve-test-license', tier: 'standard' }),
      honchoDeriverRoute: () => ({ active: true, functionUrl: metered!.url, license: 'ceve-test-license' }),
    });

    const response = await fetch(`${shimUrl}/honcho/deriver/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        model: 'custom:command-eve-gemma-64k:latest',
        messages: [{ role: 'user', content: 'Derive a user model fact.' }],
      }),
    });

    expect(response.status).toBe(200);
    // The deriver is a metered rung BY CONTRACT — it must keep spending, on the
    // cheapest entry tier, without any body declaration.
    expect(metered!.debits).toHaveLength(1);
    expect(metered!.debits[0].tier).toBe('standard');
  });

  it('S4c: MAX turns are unaffected — the tier the user picked is the tier that travels', async () => {
    metered = await startMeteredHost();
    local = await startLocalOllama();
    const shimUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: local.url,
      eveRouting: () => ({ active: true, functionUrl: metered!.url, license: 'ceve-test-license', tier: 'max' }),
    });

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
      eve_operation: 'user_chat_turn',
    });

    expect(response.status).toBe(200);
    expect(metered!.debits).toHaveLength(1);
    expect(metered!.debits[0].tier).toBe('max');
  });
});

describe('MAT-1749 — the free lanes stay free and stay permissive', () => {
  it('LOCAL/BYOK: no cloud route means no declaration is required and nothing egresses', async () => {
    metered = await startMeteredHost();
    local = await startLocalOllama('Local answer');
    const shimUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: local.url,
      // The operator sits on a private lane: eveRouting answers "not active".
      eveRouting: () => ({ active: false }),
    });

    // Deliberately NO eve_operation: the local lane must not start demanding one.
    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
    });

    expect(response.status).toBe(200);
    expect(metered!.debits).toHaveLength(0);
    expect(local!.calls).toHaveLength(1);
    expect(response.headers.get('x-command-eve-inference-lane')).toBe('ollama_local');
  });

  it('a zero-cost seat cannot have background memory spend on it', async () => {
    metered = await startMeteredHost();
    local = await startLocalOllama();
    const shimUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: local.url,
      eveRouting: () => ({ active: false }),
      honchoDeriverRoute: () => ({ active: true, functionUrl: metered!.url, license: 'ceve-test-license' }),
    });

    const response = await fetch(`${shimUrl}/honcho/deriver/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'derive' }] }),
    });

    expect(response.status).toBe(503);
    expect(metered!.debits).toHaveLength(0);
  });
});

describe('MAT-1749 — the guard sits in front of the money and stays there', () => {
  /**
   * A STRUCTURAL PIN, AND IT SAYS SO — but it is no longer what proves this seam.
   *
   * It used to be the only guard here, because the router refused before the egress
   * function ran: no reachable request could arrive unpayable, so no behavioural
   * test could redden when the guard was neutralised. Sol defeated exactly that on
   * e40c3396 — literal deletion reddened this pin, `false && …` did not.
   *
   * The payability decision now lives ONLY in the egress function, so the
   * behavioural tests below observe a real debit the moment it is neutralised by any
   * means. This pin stays as a cheap ordering assertion — the decision must precede
   * the fetch — not as the proof.
   */
  it('consults the registry BEFORE the metered fetch, in the only function that egresses', async () => {
    const fs = await import('fs');
    const url = await import('url');
    const shimPath = url.fileURLToPath(
      new URL('../../../packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts', import.meta.url)
    );
    const source = fs.readFileSync(shimPath, 'utf8');

    const startIndex = source.indexOf('async function handleEveCloudCompletions(');
    expect(startIndex).toBeGreaterThan(-1);
    const bodyAfterStart = source.slice(startIndex + 1);
    const nextFunctionOffset = bodyAfterStart.indexOf('\nasync function ');
    const body = nextFunctionOffset === -1 ? bodyAfterStart : bodyAfterStart.slice(0, nextFunctionOffset);

    const guardOffset = body.indexOf('resolveCommandEvePaidSeam(operation, operationSource)');
    const egressOffset = body.indexOf('await fetch(functionUrl');

    expect(guardOffset, 'the paid-operation assertion is missing from the egress function').toBeGreaterThan(-1);
    expect(egressOffset, 'the metered fetch was not found — this pin needs updating').toBeGreaterThan(-1);
    expect(guardOffset, 'the registry must be consulted BEFORE the metered request').toBeLessThan(egressOffset);
  });

  /**
   * THE ANTI-NEUTRALISATION TESTS. These are the ones that matter.
   *
   * The property: if the payability decision at the final egress is defeated by ANY
   * means — `false &&`, inverting the comparison, short-circuiting it, stubbing the
   * predicate to a constant — a request that may not spend reaches the metered
   * recorder, and the recorder counts every request it receives as a debit. There is
   * no flag to read and no source string to match; the assertion is on observed
   * traffic, which no rewrite of the condition can fake.
   *
   * Verified against two different neutralisation shapes, because one shape proves
   * one shape.
   */
  it('an ABSENT operation cannot reach the metered host, however the guard is written', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
    });

    expect(metered!.debits, 'an undeclared turn reached the metered host').toHaveLength(0);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-command-eve-operation')).toBe('refused:absent');
    // It must not even claim the cloud lane on the way out.
    expect(response.headers.get('x-command-eve-inference-lane')).toBeNull();
  });

  it('a caller-claimed structural rung cannot reach the metered host either', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await postChat(shimUrl, {
      model: 'custom:command-eve-gemma-64k:latest',
      messages: USER_TURN,
      eve_operation: 'honcho_deriver',
    });

    expect(metered!.debits, 'a borrowed deriver rung reached the metered host').toHaveLength(0);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-command-eve-operation')).toBe('refused:not_client_declarable');
    expect(response.headers.get('x-command-eve-inference-lane')).toBeNull();
  });
});

describe('MAT-1749 — the seam does not weaken the checks already guarding it', () => {
  it('still refuses an unauthenticated caller before the operation is even considered', async () => {
    const shimUrl = await startShimOnPaidLane();

    const response = await fetch(`${shimUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-nonce' },
      body: JSON.stringify({
        model: 'custom:command-eve-gemma-64k:latest',
        messages: USER_TURN,
        // A perfectly valid declaration must not buy a way past the bearer check.
        eve_operation: 'user_chat_turn',
      }),
    });

    expect(response.status).toBe(401);
    expect(metered!.debits).toHaveLength(0);
  });
});
