import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandEvePromptProof,
  buildEveCloudRoute,
  commandEveCacheScope,
  commandEveOllamaUsageReceipt,
  commandEveOllamaPsHasModel,
  COMMAND_EVE_LOCAL_MODEL_KEEP_ALIVE,
  ensureCommandEveShimAuthToken,
  getCommandEveOllamaOpenAiShimBaseUrl,
  isCommandEveWarmupRequest,
  localOpenAiPayload,
  recoverQuotaExhaustedBody,
  resolveCommandEveShimContextPolicy,
  resolveCommandEveShimListenPort,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
  warmCommandEveEveLane,
  warmCommandEveLocalModel,
  type CommandEveBoundUpstreamOutcomeReceipt,
} from '@/process/commandEve/ollamaOpenAiShim';
import { commandEveManagedVisualTurnMarker } from '@/common/config/eveManagedVisualTurnCore';
import {
  CommandEveManagedVisualAuthorizationError,
  CommandEveShimPublicError,
} from '@/process/commandEve/shimPublicError';

describe('resolveCommandEveShimListenPort', () => {
  it('keeps production pinned while isolating explicit E2E launches', () => {
    expect(resolveCommandEveShimListenPort(undefined, {})).toBe(25811);
    expect(resolveCommandEveShimListenPort(undefined, { AIONUI_E2E_TEST: '1' })).toBe(0);
    expect(resolveCommandEveShimListenPort(31000, { AIONUI_E2E_TEST: '1' })).toBe(31000);
  });
});

describe('recoverQuotaExhaustedBody — 402 credit-wall contract (MAT-1773)', () => {
  it('passes a top-level quota_exhausted contract through verbatim', () => {
    const body = {
      error: 'quota_exhausted',
      credits_needed: 41,
      packs: [{ id: 'pack-25', price_eur_cents: 2500, total_credits: 25000 }],
    };
    expect(JSON.parse(recoverQuotaExhaustedBody(JSON.stringify(body)) as string)).toEqual(body);
  });

  it('flattens the wallet-style {error:{error:…}} wrapper to the top-level contract the renderer expects', () => {
    const contract = { error: 'quota_exhausted', credits_needed: 41, packs: [] };
    // Shape 2: upstream answers `{ error: { error:'quota_exhausted', … } }`.
    const wrapped = JSON.stringify({ error: contract });
    const out = recoverQuotaExhaustedBody(wrapped);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(contract);
  });

  it('recovers the contract when it is embedded in an OpenAI-style error.message string', () => {
    const contract = { error: 'quota_exhausted', credits_needed: 41, packs: [] };
    const wrapped = JSON.stringify({
      error: { message: `HTTP 402: ${JSON.stringify(contract)}` },
    });
    const out = recoverQuotaExhaustedBody(wrapped);
    expect(out).not.toBeNull();
    expect(JSON.parse(out as string)).toEqual(contract);
  });

  it('returns null for a non-quota body — the caller must use the warm wall, never the raw provider text', () => {
    expect(recoverQuotaExhaustedBody(JSON.stringify({ error: { message: 'server exploded' } }))).toBeNull();
    expect(recoverQuotaExhaustedBody('not json at all')).toBeNull();
  });

  it('never leaks the upstream provider name even on a malformed body', () => {
    const sneaky = JSON.stringify({
      error: { message: 'openrouter.ai quota exhausted — our internal account is empty' },
    });
    const out = recoverQuotaExhaustedBody(sneaky);
    // Either a clean contract or null — never the raw message that names the provider.
    if (out !== null) {
      expect(out).not.toContain('openrouter');
    }
  });
});

describe('Command EVE context and cache policy', () => {
  it('raises cloud Hermes turns to 256K but keeps local turns on their hardware cap', async () => {
    await expect(
      resolveCommandEveShimContextPolicy('custom:command-eve-gemma-64k:latest', {
        numCtx: 65_536,
        eveRouting: async () => ({ active: true, tier: 'max' }),
      })
    ).resolves.toMatchObject({
      lane: 'cloud',
      hard_limit_tokens: 262_144,
      compression_threshold: 0.75,
      compression_threshold_tokens: 196_608,
    });

    await expect(
      resolveCommandEveShimContextPolicy('custom:command-eve-gemma-64k:latest', {
        numCtx: 65_536,
        eveRouting: async () => ({ active: false }),
      })
    ).resolves.toMatchObject({
      lane: 'local',
      hard_limit_tokens: 65_536,
      compression_threshold_tokens: 49_152,
    });

    await expect(
      resolveCommandEveShimContextPolicy('custom:command-eve-bonsai-27b-q2', {
        numCtx: 32_768,
        eveRouting: async () => ({ active: false }),
      })
    ).resolves.toMatchObject({
      lane: 'local',
      hard_limit_tokens: 65_536,
      compression_threshold_tokens: 49_152,
    });
  });

  it('hashes Hermes session ids into stable seat-partitioned opaque cache scopes', () => {
    const first = commandEveCacheScope('hermes-session-1', 'seat-1');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(commandEveCacheScope('hermes-session-1', 'seat-1'));
    expect(first).not.toBe(commandEveCacheScope('hermes-session-2', 'seat-1'));
    expect(first).not.toBe(commandEveCacheScope('hermes-session-1', 'seat-2'));
    expect(first).not.toContain('hermes-session-1');
    expect(commandEveCacheScope('hermes-session-1', '')).toBeUndefined();
    expect(commandEveCacheScope('hermes-session-1', ' seat-2 ')).toBeUndefined();
    expect(commandEveCacheScope('hermes-session-1', '../seat-1')).toBeUndefined();
  });

  it('preserves Ollama prompt-input semantics without inventing evaluated or reuse buckets', () => {
    expect(commandEveOllamaUsageReceipt({ prompt_eval_count: 480, eval_count: 20 })).toEqual({
      prompt_tokens: 480,
      completion_tokens: 20,
      total_tokens: 500,
      prompt_eval_count: 480,
      eval_count: 20,
      prompt_reuse_status: 'unavailable',
    });
  });

  it('ignores unsupported prompt_reused_count instead of double-counting prompt input', () => {
    expect(commandEveOllamaUsageReceipt({ prompt_eval_count: 300, prompt_reused_count: 200, eval_count: 10 })).toEqual({
      prompt_tokens: 300,
      completion_tokens: 10,
      total_tokens: 310,
      prompt_eval_count: 300,
      eval_count: 10,
      prompt_reuse_status: 'unavailable',
    });
  });

  it('fails closed for absent or invalid local usage counters', () => {
    expect(commandEveOllamaUsageReceipt(undefined)).toBeUndefined();
    expect(commandEveOllamaUsageReceipt({ prompt_eval_count: -1, eval_count: Number.NaN })).toBeUndefined();
  });

  /**
   * The turn/call identity below is supplied BY THIS TEST, not by Hermes. It
   * covers the shim's reader only; nothing in the product sends these headers.
   * See tests/unit/command-eve/commandEveProviderCallWire.test.ts for the wire
   * itself, and do not read a green run here as evidence that the TTFT formal
   * gate can observe a real turn.
   */
  it('binds exact local response usage to the final provider payload and a SUPPLIED turn/call identity', async () => {
    const receipts: CommandEveBoundUpstreamOutcomeReceipt[] = [];
    const ollamaBaseUrl = await startFakeOllamaWarmupServer({
      model: 'command-eve-gemma4-e4b-64k:latest',
      responseUsage: { prompt_eval_count: 300, prompt_reused_count: 200, eval_count: 10 },
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      upstreamOutcomeReporter: (receipt) => {
        if (receipt.version === 'command-eve-upstream-outcome/v3') receipts.push(receipt);
      },
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...SHIM_JSON_HEADERS,
        'x-command-eve-turn-id': 'turn-local-1',
        'x-command-eve-call-index': '1',
      },
      body: JSON.stringify({
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'provider-free local receipt probe' }],
        stream: false,
      }),
    });
    const payload = (await response.json()) as { usage?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.usage).toMatchObject({
      prompt_tokens: 300,
      prompt_eval_count: 300,
      prompt_reuse_status: 'unavailable',
      total_tokens: 310,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].provider_call).toMatchObject({
      turn_id: 'turn-local-1',
      call_index: 1,
      request_id: 'turn-local-1:api:1',
      content_included: false,
      attempt_count: 1,
      response_usage: {
        input_tokens: 300,
        prompt_eval_count: 300,
        prompt_reuse_status: 'unavailable',
        prompt_reused_tokens: null,
        prompt_tokens: 300,
      },
    });
    expect(receipts[0].provider_call.final_request_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipts[0].provider_call.response_usage_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not mint an exact receipt from malformed SUPPLIED turn/call headers', async () => {
    let exactReceiptObserved = false;
    const ollamaBaseUrl = await startFakeOllamaWarmupServer({
      model: 'command-eve-gemma4-e4b-64k:latest',
      responseUsage: { prompt_eval_count: 3, eval_count: 1 },
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      upstreamOutcomeReporter: (receipt) => {
        exactReceiptObserved ||= receipt.version === 'command-eve-upstream-outcome/v3';
      },
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...SHIM_JSON_HEADERS,
        'x-command-eve-turn-id': 'turn-local-1',
        'x-command-eve-call-index': '0',
      },
      body: JSON.stringify({
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'provider-free malformed identity probe' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(exactReceiptObserved).toBe(false);
  });
});

describe('Colibrì OpenAI request profile', () => {
  it('forwards only fields supported by the pinned Colibrì adapter', () => {
    const tools = [{ type: 'function', function: { name: 'status', parameters: { type: 'object' } } }];
    const payload = localOpenAiPayload(
      {
        messages: [{ role: 'user', content: 'Check status.' }],
        stream: true,
        max_tokens: 12_000,
        reasoning_effort: 'max',
        temperature: 0.4,
        top_p: 0.9,
        tools,
        tool_choice: 'required',
        top_k: 20,
        min_p: 0.1,
        seed: 42,
        stop: ['END'],
        parallel_tool_calls: true,
        response_format: { type: 'json_object' },
        stream_options: { include_usage: true },
      },
      { active: true, model: 'command-eve-colibri-glm-5-2-uncensored', payloadProfile: 'colibri' }
    );
    expect(payload).toMatchObject({
      model: 'command-eve-colibri-glm-5-2-uncensored',
      stream: true,
      max_completion_tokens: 12_000,
      reasoning_effort: 'xhigh',
      enable_thinking: true,
      temperature: 0.4,
      top_p: 0.9,
      tools,
      tool_choice: 'required',
    });
    for (const forbidden of [
      'top_k',
      'min_p',
      'seed',
      'stop',
      'parallel_tool_calls',
      'response_format',
      'stream_options',
    ]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });
});

/** Synthetic CEVE wire string — NOT a real license. */
const FAKE_LICENSE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';
const SHIM_AUTH_TOKEN = ensureCommandEveShimAuthToken();
const SHIM_JSON_HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${SHIM_AUTH_TOKEN}`,
};

let eveFnServer: http.Server | undefined;

type EveFnSeen = { body?: Record<string, unknown>; authHeader?: string | null; path?: string; attempts?: number };

/** A fake eve-inference function (returns an OpenAI-compatible completion). */
async function startFakeEveFunction(
  seen: EveFnSeen,
  opts?: { status?: number; responseBody?: unknown }
): Promise<string> {
  eveFnServer = http.createServer((request, response) => {
    void (async () => {
      seen.attempts = (seen.attempts ?? 0) + 1;
      seen.path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      seen.authHeader = request.headers.authorization ?? null;
      seen.body = await readRequestBody(request);
      writeJson(
        response,
        opts?.status ?? 200,
        opts?.responseBody ?? {
          choices: [{ message: { role: 'assistant', content: 'eve-cloud-ok' }, finish_reason: 'stop' }],
        }
      );
    })().catch((error) => {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    eveFnServer?.once('error', reject);
    eveFnServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = eveFnServer.address();
  if (!address || typeof address === 'string') throw new Error('fake eve fn did not expose a port');
  // Loopback http is an allowed EVE function URL (same trust model as the
  // local-runtime loopback key), so the fake function is reachable in tests.
  return `http://127.0.0.1:${address.port}`;
}

function runManagedVisualRefusalHarness(
  args: string[]
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['tests/fixtures/command-eve/managed_visual_refusal_retry_harness.py', ...args], {
      cwd: path.resolve(__dirname, '../../..'),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

let testServer: http.Server | undefined;
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

async function startFakeOpenAiServer(
  onBody: (body: Record<string, unknown>, path: string, authorization?: string) => void
): Promise<string> {
  testServer = http.createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      const body = await readRequestBody(request);
      onBody(body, path, request.headers.authorization);
      writeJson(response, 200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      });
    })().catch((error) => {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    testServer?.once('error', reject);
    testServer?.listen(0, '127.0.0.1', resolve);
  });

  const address = testServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake server did not expose a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startFakeOllamaWarmupServer(options: {
  model: string;
  initiallyResident?: boolean;
  becomeResidentAfterChat?: boolean;
  malformedPs?: boolean;
  onChat?: (body: Record<string, unknown>) => void;
  responseUsage?: { prompt_eval_count: number; eval_count: number; prompt_reused_count?: number };
}): Promise<string> {
  let resident = options.initiallyResident ?? false;
  testServer = http.createServer((request, response) => {
    void (async () => {
      const requestPath = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && requestPath === '/api/ps') {
        writeJson(
          response,
          200,
          options.malformedPs
            ? { models: 'not-an-array' }
            : { models: resident ? [{ name: options.model, model: options.model }] : [] }
        );
        return;
      }
      if (request.method === 'POST' && requestPath === '/api/chat') {
        const body = await readRequestBody(request);
        options.onChat?.(body);
        if (options.becomeResidentAfterChat ?? true) resident = true;
        writeJson(response, 200, {
          model: options.model,
          message: { role: 'assistant', content: 'ok' },
          done: true,
          done_reason: 'stop',
          ...options.responseUsage,
        });
        return;
      }
      writeJson(response, 404, { error: 'not found' });
    })().catch((error) => {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    testServer?.once('error', reject);
    testServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = testServer.address();
  if (!address || typeof address === 'string') throw new Error('fake Ollama did not expose a port');
  return `http://127.0.0.1:${address.port}`;
}

async function startHangingOllamaServer(
  onRequest: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
  testServer = http.createServer((request, response) => {
    request.resume();
    onRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    testServer?.once('error', reject);
    testServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = testServer.address();
  if (!address || typeof address === 'string') throw new Error('hanging server did not expose a port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (testServer) {
    await new Promise<void>((resolve, reject) => {
      testServer?.close((error) => (error ? reject(error) : resolve()));
    });
    testServer = undefined;
  }
  if (eveFnServer) {
    await new Promise<void>((resolve, reject) => {
      eveFnServer?.close((error) => (error ? reject(error) : resolve()));
    });
    eveFnServer = undefined;
  }
  if (!shimServerUrl) return;
  await stopCommandEveOllamaOpenAiShimForTest();
  shimServerUrl = '';
});

describe('Command EVE Ollama OpenAI shim warm-up', () => {
  it('matches only the exact normalized model in Ollama residency truth', () => {
    const model = 'command-eve-gemma4-e4b-64k:latest';
    expect(commandEveOllamaPsHasModel({ models: [{ name: model }] }, `custom:${model}`)).toBe(true);
    expect(commandEveOllamaPsHasModel({ models: [{ model: 'command-eve-gemma4-e4b-64k' }] }, model)).toBe(true);
    expect(commandEveOllamaPsHasModel({ models: [{ name: `${model}-other` }] }, model)).toBe(false);
    expect(commandEveOllamaPsHasModel({ models: 'invalid' }, model)).toBe(false);
    expect(commandEveOllamaPsHasModel(null, model)).toBe(false);
  });

  it('reports the actual ephemeral OpenAI base URL selected by the active shim', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl: 'http://127.0.0.1:1' });
    expect(getCommandEveOllamaOpenAiShimBaseUrl()).toBe(`${shimServerUrl}/v1`);
  });

  it('coalesces concurrent first-start calls into one loopback server', async () => {
    const starts = [
      startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl: 'http://127.0.0.1:1' }),
      startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl: 'http://127.0.0.1:1' }),
    ];

    const [firstUrl, secondUrl] = await Promise.all(starts);
    shimServerUrl = firstUrl;

    expect(secondUrl).toBe(firstUrl);
    await expect(fetch(`${firstUrl}/health`).then((response) => response.json())).resolves.toEqual({ ok: true });
  });

  it('detects EVE persona markers without storing prompt text', () => {
    const proof = buildCommandEvePromptProof({
      model: 'custom:command-eve-gemma4-e4b-64k:latest',
      messages: [
        {
          role: 'system',
          content: '# EVE Operating Rule\n\nYou are EVE, Command EVE Chief of Staff.',
        },
        { role: 'user', content: 'moin eve' },
      ],
    });

    expect(proof.ok).toBe(true);
    expect(proof.marker).toBe('eve_operating_rule');
    expect(proof.message_count).toBe(2);
    expect(proof.system_message_count).toBe(1);
    expect(proof.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(proof)).not.toContain('moin eve');
  });

  it('classifies the startup ping as warm-up so it does not overwrite prompt proof', () => {
    expect(
      isCommandEveWarmupRequest({
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      })
    ).toBe(true);
  });

  it('skips the synthetic ping when the exact local model is already resident', async () => {
    let chatCalls = 0;
    const model = 'command-eve-gemma4-e4b-64k:latest';
    const ollamaBaseUrl = await startFakeOllamaWarmupServer({
      model,
      initiallyResident: true,
      onChat: () => {
        chatCalls += 1;
      },
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl });

    const result = await warmCommandEveLocalModel({
      baseUrl: shimServerUrl,
      ollamaBaseUrl,
      model: `custom:${model}`,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(chatCalls).toBe(0);
  });

  it('does not treat an unrelated Ollama resident model as managed-local residency truth', async () => {
    let managedProviderCalls = 0;
    const model = 'command-eve-gemma4-e4b-64k:latest';
    const ollamaBaseUrl = await startFakeOllamaWarmupServer({
      model,
      initiallyResident: true,
    });
    const managedProviderBaseUrl = await startFakeOpenAiServer(() => {
      managedProviderCalls += 1;
    });

    const result = await warmCommandEveLocalModel({
      baseUrl: managedProviderBaseUrl,
      ollamaBaseUrl,
      provider: 'bonsai-prism',
      model: `custom:${model}`,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(managedProviderCalls).toBe(1);
  });

  it('pre-warms an absent model and retains it for a bounded window', async () => {
    let seenBody: Record<string, unknown> | undefined;
    const model = 'command-eve-gemma4-e4b-64k:latest';
    const ollamaBaseUrl = await startFakeOllamaWarmupServer({
      model: 'command-eve-gemma4-e4b-64k',
      onChat: (body) => {
        seenBody = body;
      },
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl });

    const result = await warmCommandEveLocalModel({
      baseUrl: shimServerUrl,
      ollamaBaseUrl,
      model: `custom:${model}`,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe(`custom:${model}`);
    expect(seenBody?.model).toBe('command-eve-gemma4-e4b-64k');
    expect(seenBody?.stream).toBe(false);
    expect(seenBody?.keep_alive).toBe(COMMAND_EVE_LOCAL_MODEL_KEEP_ALIVE);
  });

  it('accepts a successful native warmup even when the residency inventory lags behind', async () => {
    const model = 'command-eve-gemma4-e4b-64k:latest';
    const ollamaBaseUrl = await startFakeOllamaWarmupServer({
      model,
      becomeResidentAfterChat: false,
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl });

    const result = await warmCommandEveLocalModel({
      baseUrl: shimServerUrl,
      ollamaBaseUrl,
      model,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
  });

  it('refuses to warm non-loopback providers', async () => {
    const result = await warmCommandEveLocalModel({
      baseUrl: 'https://api.example.com/v1',
      model: 'external-model',
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('local-only');
  });

  it('refuses a non-loopback residency probe even when the shim URL is local', async () => {
    const result = await warmCommandEveLocalModel({
      baseUrl: 'http://127.0.0.1:25811',
      ollamaBaseUrl: 'https://api.example.com',
      model: 'external-model',
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('residency probe is local-only');
  });

  it('rejects unauthenticated inference without touching the upstream model', async () => {
    let upstreamHits = 0;
    const baseUrl = await startFakeOpenAiServer(() => {
      upstreamHits += 1;
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl: baseUrl });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'spend credits' }],
      }),
    });

    expect(response.status).toBe(401);
    expect(upstreamHits).toBe(0);
  });

  it('serves the live context policy only to authenticated Hermes requests', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      authToken: SHIM_AUTH_TOKEN,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: async () => ({ active: true, tier: 'high' }),
    });

    const unauthenticated = await fetch(
      `${shimServerUrl}/v1/command-eve/context-policy?model=custom%3Acommand-eve-gemma-64k%3Alatest`
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(
      `${shimServerUrl}/v1/command-eve/context-policy?model=custom%3Acommand-eve-gemma-64k%3Alatest`,
      { headers: { authorization: `Bearer ${SHIM_AUTH_TOKEN}` } }
    );
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toMatchObject({
      version: 'command-eve-context-policy/v1',
      lane: 'cloud',
      hard_limit_tokens: 262_144,
      compression_threshold_tokens: 196_608,
    });
  });

  it('returns a bounded first-byte timeout and closes the stalled upstream request', async () => {
    let closeUpstream: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
      closeUpstream = resolve;
    });
    const baseUrl = await startHangingOllamaServer((_request, response) =>
      response.once('close', () => closeUpstream?.())
    );
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: baseUrl,
      upstreamFirstByteTimeoutMs: 40,
      upstreamIdleTimeoutMs: 40,
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'wait' }],
        stream: false,
      }),
    });
    const payload = (await response.json()) as { error?: { type?: string } };

    expect(response.status).toBe(504);
    expect(payload.error?.type).toBe('first_byte_timeout');
    await expect(
      Promise.race([
        upstreamClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('upstream remained open')), 1_000)),
      ])
    ).resolves.toBeUndefined();
  });

  it('propagates client cancellation to the upstream request', async () => {
    let markSeen: (() => void) | undefined;
    let markClosed: (() => void) | undefined;
    const upstreamSeen = new Promise<void>((resolve) => {
      markSeen = resolve;
    });
    const upstreamClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const baseUrl = await startHangingOllamaServer((_request, response) => {
      markSeen?.();
      response.once('close', () => markClosed?.());
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({ port: 0, ollamaBaseUrl: baseUrl });
    const controller = new AbortController();
    const pending = fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      signal: controller.signal,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'cancel' }],
        stream: false,
      }),
    });

    await upstreamSeen;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(
      Promise.race([
        upstreamClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('upstream remained open')), 1_000)),
      ])
    ).resolves.toBeUndefined();
  });

  it('redacts sensitive data before the fake Ollama upstream sees it (never blocks/hangs)', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const baseUrl = await startFakeOpenAiServer((bodySeen) => {
      upstreamBody = bodySeen;
    });

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: baseUrl,
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'Hier ist ein API key: sk-abcdefghijklmnopqrstuvwxyz123456' }],
        stream: false,
      }),
    });

    // The turn PROCEEDS (no 451, no hang) but the secret is stripped before the upstream sees it.
    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    expect(upstreamBody).toBeDefined();
    const forwarded = JSON.stringify(upstreamBody);
    expect(forwarded).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(forwarded).toContain('[REDACTED_SECRET]');
  });

  it('strips native image_url parts before the local Ollama lane sees them', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const baseUrl = await startFakeOpenAiServer((bodySeen) => {
      upstreamBody = bodySeen;
    });

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: baseUrl,
      eveRouting: () => buildEveCloudRoute({ isEveSelection: false }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is on this screenshot?\n\n[Image attached at: /Users/mathias/private.png]' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET_IMAGE_BYTES' } },
            ],
          },
        ],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    const forwarded = JSON.stringify(upstreamBody?.messages);
    expect(forwarded).toContain('what is on this screenshot?');
    expect(forwarded).toContain('Image attachment omitted');
    expect(forwarded).not.toContain('image_url');
    expect(forwarded).not.toContain('SECRET_IMAGE_BYTES');
    expect(forwarded).not.toContain('/Users/mathias/private.png');
  });

  it('converts a vetted embedded image for the local MiniCPM vision lane without exposing its source path', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let cloudRouteReads = 0;
    const baseUrl = await startFakeOpenAiServer((bodySeen) => {
      upstreamBody = bodySeen;
    });
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: baseUrl,
      eveRouting: () => {
        cloudRouteReads += 1;
        return buildEveCloudRoute({ isEveSelection: true, tier: 'max' });
      },
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'minicpm-v:8b',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is on this screenshot?\n\n[Image attached at: /Users/mathias/private.png]' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${onePixelPng}` } },
            ],
          },
        ],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(cloudRouteReads).toBe(0);
    const forwarded = JSON.stringify(upstreamBody?.messages);
    expect(forwarded).toContain('what is on this screenshot?');
    expect(forwarded).toContain(onePixelPng);
    expect(forwarded).toContain('"images"');
    expect(forwarded).not.toContain('image_url');
    expect(forwarded).not.toContain('data:image');
    expect(forwarded).not.toContain('/Users/mathias/private.png');
  });

  it('rejects URL-backed or malformed images instead of fetching or silently dropping them in local vision', async () => {
    let upstreamHits = 0;
    const baseUrl = await startFakeOpenAiServer(() => {
      upstreamHits += 1;
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: baseUrl,
      eveRouting: () => buildEveCloudRoute({ isEveSelection: false }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'minicpm-v:8b',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'analyze this' },
              { type: 'image_url', image_url: { url: 'https://example.invalid/private.png' } },
            ],
          },
        ],
        stream: false,
      }),
    });

    expect(response.status).toBe(400);
    expect(upstreamHits).toBe(0);
  });

  it('branches to a managed local OpenAI provider before the Ollama-native conversion', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    let upstreamAuthorization: string | undefined;
    const providerUrl = await startFakeOpenAiServer((bodySeen, _path, authorization) => {
      upstreamBody = bodySeen;
      upstreamAuthorization = authorization;
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      localOpenAiRouting: () => ({
        active: true,
        baseUrl: `${providerUrl}/v1`,
        model: 'command-eve-bonsai-27b-q2',
        apiKey: 'test-only-local-key',
        providerName: 'bonsai-pilot-test',
      }),
    });
    const tools = [
      {
        type: 'function',
        function: { name: 'read_status', description: 'Read status', parameters: { type: 'object', properties: {} } },
      },
    ];

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'Use the status tool.' }],
        stream: false,
        max_tokens: 4096,
        reasoning_effort: 'medium',
        tools,
        tool_choice: 'auto',
        think: false,
        options: { num_ctx: 65_536 },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-inference-lane')).toBe('managed_local');
    expect(upstreamAuthorization).toBe('Bearer test-only-local-key');
    expect(upstreamBody?.model).toBe('command-eve-bonsai-27b-q2');
    expect(upstreamBody?.max_tokens).toBe(4096);
    expect(upstreamBody?.thinking_budget_tokens).toBe(2048);
    expect(upstreamBody?.reasoning_control).toBe(true);
    expect(upstreamBody?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(upstreamBody).not.toHaveProperty('reasoning_effort');
    expect(upstreamBody?.tools).toEqual(tools);
    expect(upstreamBody?.tool_choice).toBe('auto');
    expect(upstreamBody).not.toHaveProperty('think');
    expect(upstreamBody).not.toHaveProperty('options');
  });

  it('fails closed instead of forwarding a managed local route to localhost aliases or remote hosts', async () => {
    let upstreamHits = 0;
    const providerUrl = await startFakeOpenAiServer(() => {
      upstreamHits += 1;
    });
    const providerPort = new URL(providerUrl).port;
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      localOpenAiRouting: () => ({
        active: true,
        baseUrl: `http://localhost:${providerPort}/v1`,
        model: 'command-eve-bonsai-27b-q2',
        apiKey: 'test-only-local-key',
      }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(503);
    expect(upstreamHits).toBe(0);
  });

  it('reserves final-answer tokens even when maximum local reasoning is requested', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const providerUrl = await startFakeOpenAiServer((bodySeen) => {
      upstreamBody = bodySeen;
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      localOpenAiRouting: () => ({
        active: true,
        baseUrl: `${providerUrl}/v1`,
        model: 'command-eve-bonsai-27b-q2',
        apiKey: 'test-only-local-key',
      }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'local',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        max_tokens: 128,
        reasoning_effort: 'max',
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamBody?.thinking_budget_tokens).toBe(64);
    expect(upstreamBody?.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});

describe('buildEveCloudRoute (pure)', () => {
  it('returns inactive for a local selection', () => {
    expect(buildEveCloudRoute({ isEveSelection: false })).toEqual({ active: false });
  });

  it('returns an active route carrying the function URL, license and tier for an EVE selection', () => {
    const route = buildEveCloudRoute({
      isEveSelection: true,
      tier: 'standard',
      functionUrl: 'https://example.test/functions/v1/eve-inference',
      license: FAKE_LICENSE,
    });
    expect(route.active).toBe(true);
    expect(route.functionUrl).toBe('https://example.test/functions/v1/eve-inference');
    expect(route.license).toBe(FAKE_LICENSE);
    expect(route.tier).toBe('standard');
  });
});

describe('Command EVE shim — EVE cloud routing', () => {
  it('passes the original body to one-turn routing but strips its opaque authorization marker before egress', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    const marker = commandEveManagedVisualTurnMarker('V'.repeat(43));
    let resolverSawMarker = false;

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: (body) => {
        resolverSawMarker = JSON.stringify(body?.messages).includes(marker);
        return { active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'high' };
      },
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: `${marker}\nAnalyze the four-slide deck.` }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(resolverSawMarker).toBe(true);
    expect(fnSeen.body?.tier).toBe('high');
    expect(JSON.stringify(fnSeen.body?.messages)).not.toContain(marker);
    expect(JSON.stringify(fnSeen.body?.messages)).toContain('Analyze the four-slide deck.');
  });

  it('routes and strips a managed visual authorization carried in structured text content', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    const marker = commandEveManagedVisualTurnMarker('W'.repeat(43));
    let resolverSawMarker = false;

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: (body) => {
        resolverSawMarker = JSON.stringify(body?.messages).includes(marker);
        return { active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'high' };
      },
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `${marker}\nAnalyze the four-slide deck.` }],
          },
        ],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(resolverSawMarker).toBe(true);
    expect(fnSeen.body?.tier).toBe('high');
    expect(JSON.stringify(fnSeen.body?.messages)).not.toContain(marker);
    expect(JSON.stringify(fnSeen.body?.messages)).toContain('Analyze the four-slide deck.');
  });

  it('routes a final managed-visual policy revocation through the generic 422 receipt boundary before egress', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    const marker = commandEveManagedVisualTurnMarker('R'.repeat(43));
    let finalPolicyChecks = 0;
    const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-managed-visual-policy-stale-'));
    const receiptPath = path.join(receiptRoot, 'last-egress-boundary-receipt.json');

    try {
      shimServerUrl = await startCommandEveOllamaOpenAiShim({
        port: 0,
        ollamaBaseUrl,
        egressReceiptPath: receiptPath,
        eveRouting: () => ({
          active: true,
          functionUrl: fnUrl,
          license: FAKE_LICENSE,
          tier: 'high',
          authorizeManagedVisualEgress: () => {
            finalPolicyChecks += 1;
            return false;
          },
        }),
      });

      const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: SHIM_JSON_HEADERS,
        body: JSON.stringify({
          eve_operation: 'user_chat_turn',
          model: 'custom:command-eve-gemma4-e4b-64k:latest',
          messages: [{ role: 'user', content: `${marker}\nAnalyze the selected image.` }],
          stream: false,
        }),
      });

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body).toEqual({
        error: {
          code: 'EVE_MANAGED_VISUAL_AUTHORIZATION_INVALID',
          message: 'Managed visual authorization cannot be verified. Reattach the files and retry.',
          type: 'command_eve_managed_visual_authorization_error',
        },
      });
      expect(JSON.stringify(body)).not.toContain('POLICY_STALE');
      const correlationId = response.headers.get('x-command-eve-error-correlation');
      expect(correlationId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(finalPolicyChecks).toBe(1);
      // The fake eve-inference endpoint is the egress/billing probe. Policy
      // revalidation fails before it is contacted.
      expect(fnSeen.attempts ?? 0).toBe(0);
      const failureReceipt = JSON.parse(
        fs.readFileSync(path.join(receiptRoot, 'last-managed-visual-authorization-failure.json'), 'utf8')
      );
      expect(failureReceipt).toMatchObject({
        status_code: 422,
        error_code: 'EVE_MANAGED_VISUAL_AUTHORIZATION_INVALID',
        authorization_reason_code: 'POLICY_STALE',
        request_correlation_id: correlationId,
      });
      expect(fs.statSync(path.join(receiptRoot, 'last-managed-visual-authorization-failure.json')).mode & 0o777).toBe(
        0o600
      );
    } finally {
      fs.rmSync(receiptRoot, { recursive: true, force: true });
    }
  });

  it('keeps an unexpected final managed-visual policy callback fault generic 500 without a stale receipt or egress', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    const marker = commandEveManagedVisualTurnMarker('E'.repeat(43));
    const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-managed-visual-policy-error-'));
    const receiptPath = path.join(receiptRoot, 'last-egress-boundary-receipt.json');

    try {
      shimServerUrl = await startCommandEveOllamaOpenAiShim({
        port: 0,
        ollamaBaseUrl,
        egressReceiptPath: receiptPath,
        eveRouting: () => ({
          active: true,
          functionUrl: fnUrl,
          license: FAKE_LICENSE,
          tier: 'high',
          authorizeManagedVisualEgress: async () => {
            throw new Error('policy callback secret must remain private');
          },
        }),
      });

      const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: SHIM_JSON_HEADERS,
        body: JSON.stringify({
          eve_operation: 'user_chat_turn',
          model: 'custom:command-eve-gemma4-e4b-64k:latest',
          messages: [{ role: 'user', content: `${marker}\nAnalyze the selected image.` }],
          stream: false,
        }),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: { message: 'Command EVE shim internal error.' } });
      expect(fnSeen.attempts ?? 0).toBe(0);
      expect(fs.existsSync(path.join(receiptRoot, 'last-managed-visual-authorization-failure.json'))).toBe(false);
    } finally {
      fs.rmSync(receiptRoot, { recursive: true, force: true });
    }
  });

  it('routes an EVE-tier chat to the eve-inference function with bearer + tier, not to Ollama', async () => {
    let ollamaSeen = false;
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {
      ollamaSeen = true;
    });
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'plan my week' }],
        stream: false,
        session_id: 'hermes-session-private-1',
      }),
    });
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };

    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-inference-lane')).toBe('eve_cloud');
    expect(json.choices?.[0]?.message?.content).toBe('eve-cloud-ok');
    // The function — not Ollama — saw the request.
    expect(ollamaSeen).toBe(false);
    // The license rode ONLY in the Authorization header.
    expect(fnSeen.authHeader).toBe(`Bearer ${FAKE_LICENSE}`);
    // The tier is forwarded in the body; the local model ref is NOT smuggled.
    expect(fnSeen.body?.tier).toBe('standard');
    expect(fnSeen.body?.messages).toEqual([{ role: 'user', content: 'plan my week' }]);
    expect(fnSeen.body?.license).toBeUndefined();
    expect(fnSeen.body).not.toHaveProperty('model');
    expect(fnSeen.body?.session_id).toBeUndefined();
    expect(fnSeen.body?.cache_scope).toBe(commandEveCacheScope('hermes-session-private-1', 'seat-1'));
  });

  it.each([
    {
      status: 402,
      responseBody: {
        error: {
          error: 'quota_exhausted',
          credits_needed: 41,
          packs: [],
        },
      },
    },
    {
      status: 500,
      responseBody: { error: { type: 'upstream_failure', message: 'Synthetic upstream failure.' } },
    },
  ])(
    'omits output-token limits and makes one paid-upstream attempt for HTTP $status',
    async ({ status, responseBody }) => {
      const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
      const fnSeen: EveFnSeen = {};
      const fnUrl = await startFakeEveFunction(fnSeen, { status, responseBody });

      shimServerUrl = await startCommandEveOllamaOpenAiShim({
        port: 0,
        ollamaBaseUrl,
        eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'max' }),
      });

      const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: SHIM_JSON_HEADERS,
        body: JSON.stringify({
          eve_operation: 'user_chat_turn',
          model: 'custom:command-eve-gemma4-e4b-64k:latest',
          messages: [{ role: 'user', content: 'Synthetic provenance turn.' }],
          stream: false,
          max_tokens: 65_536,
          max_completion_tokens: 65_535,
        }),
      });

      expect(response.status).toBe(status);
      if (status === 402) {
        // The 402 credit-wall is handed back WARM and structured (the renderer
        // shows the "credits aufgebraucht" wall), not the raw provider text.
        const json = await response.json();
        // Top-level Lane-1 contract: `error` is the string discriminator.
        expect(json.error).toBe('quota_exhausted');
        expect(JSON.stringify(json)).not.toContain('Synthetic');
      } else {
        expect(await response.json()).toEqual(responseBody);
      }
      expect(fnSeen.attempts).toBe(1);
      expect(fnSeen.body).not.toHaveProperty('max_tokens');
      expect(fnSeen.body).not.toHaveProperty('max_completion_tokens');
    }
  );

  it('gives the exact Hermes 0.20/OpenAI client one non-retryable attempt at the actual 422 shim boundary', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    let resolverCalls = 0;
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => {
        resolverCalls += 1;
        throw new CommandEveManagedVisualAuthorizationError('AUTHORIZATION_REPLAY');
      },
    });

    const result = await runManagedVisualRefusalHarness([
      path.resolve('resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl'),
      `${shimServerUrl}/v1`,
      SHIM_AUTH_TOKEN,
    ]);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exact_wheel_primary_client_factory_executed: true,
      openai_sdk_version: '2.24.0',
      sdk_default_retries_409: true,
      sdk_default_retries_422: false,
      sdk_default_retries_500: true,
      openai_sdk_max_retries: 0,
      http_status: 422,
      target: 'actual_loopback_shim',
    });
    // `eveRouting` runs before marker stripping, paid-operation selection and
    // fetch. One call proves the exact SDK did not retry the actual shim 422.
    expect(resolverCalls).toBe(1);
    expect(fnSeen.attempts ?? 0).toBe(0);
  });

  it('gives the exact Hermes 0.20/OpenAI client one actual-shim attempt when final managed-visual policy revalidation refuses', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    let shimRequests = 0;
    let finalPolicyChecks = 0;
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => {
        shimRequests += 1;
        return {
          active: true,
          functionUrl: fnUrl,
          license: FAKE_LICENSE,
          tier: 'high',
          authorizeManagedVisualEgress: () => {
            finalPolicyChecks += 1;
            return false;
          },
        };
      },
    });

    const result = await runManagedVisualRefusalHarness([
      path.resolve('resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl'),
      `${shimServerUrl}/v1`,
      SHIM_AUTH_TOKEN,
    ]);
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exact_wheel_primary_client_factory_executed: true,
      openai_sdk_version: '2.24.0',
      sdk_default_retries_409: true,
      sdk_default_retries_422: false,
      sdk_default_retries_500: true,
      openai_sdk_max_retries: 0,
      http_status: 422,
      target: 'actual_loopback_shim',
    });
    // Both callbacks run once per inbound shim request. This is the actual
    // post-route policy path, not the earlier resolver-marker refusal seam.
    expect(shimRequests).toBe(1);
    expect(finalPolicyChecks).toBe(1);
    expect(fnSeen.attempts ?? 0).toBe(0);
  });

  it('gives the exact Hermes 0.20/OpenAI client one actual-shim attempt for an unexpected final policy callback fault', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-managed-visual-policy-client-error-'));
    const receiptPath = path.join(receiptRoot, 'last-egress-boundary-receipt.json');
    let shimRequests = 0;
    let finalPolicyChecks = 0;

    try {
      shimServerUrl = await startCommandEveOllamaOpenAiShim({
        port: 0,
        ollamaBaseUrl: 'http://127.0.0.1:1',
        egressReceiptPath: receiptPath,
        eveRouting: () => {
          shimRequests += 1;
          return {
            active: true,
            functionUrl: fnUrl,
            license: FAKE_LICENSE,
            tier: 'high',
            authorizeManagedVisualEgress: async () => {
              finalPolicyChecks += 1;
              throw new Error('policy callback secret must remain private');
            },
          };
        },
      });

      const result = await runManagedVisualRefusalHarness([
        path.resolve('resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl'),
        `${shimServerUrl}/v1`,
        SHIM_AUTH_TOKEN,
        '500',
      ]);
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        exact_wheel_primary_client_factory_executed: true,
        openai_sdk_version: '2.24.0',
        sdk_default_retries_500: true,
        openai_sdk_max_retries: 0,
        http_status: 500,
        target: 'actual_loopback_shim',
      });
      // The SDK itself would retry a 500 by default, so this asserts the exact
      // bundled Hermes client factory's `max_retries: 0` contract at the shim.
      expect(shimRequests).toBe(1);
      expect(finalPolicyChecks).toBe(1);
      expect(fnSeen.attempts ?? 0).toBe(0);
      expect(fs.existsSync(path.join(receiptRoot, 'last-managed-visual-authorization-failure.json'))).toBe(false);
    } finally {
      fs.rmSync(receiptRoot, { recursive: true, force: true });
    }
  });

  it('strips native image_url parts before the EVE cloud lane sees them', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is on this screenshot?\n\n[Image attached at: /Users/mathias/private.png]' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET_IMAGE_BYTES' } },
            ],
          },
        ],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    const forwarded = JSON.stringify(fnSeen.body?.messages);
    expect(forwarded).toContain('what is on this screenshot?');
    expect(forwarded).toContain('Image attachment omitted');
    expect(forwarded).not.toContain('image_url');
    expect(forwarded).not.toContain('SECRET_IMAGE_BYTES');
    expect(forwarded).not.toContain('/Users/mathias/private.png');
  });

  it('rewrites a 429 fair-use cap into a friendly German message that promises nothing free', async () => {
    // UX: the raw upstream 429 surfaced in chat as a terse "rate_limit" error.
    // The shim must rewrite it to a warm, operator-facing line (named cause +
    // way forward) while staying OpenAI-error-shaped so the chat renders it.
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen, { status: 429 });

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'plan my week' }],
        stream: false,
      }),
    });
    const json = (await response.json()) as { error?: { message?: string; type?: string } };

    expect(response.status).toBe(429);
    expect(json.error?.type).toBe('eve_daily_cap');
    // INVERTED TWICE, AND THE SECOND TIME IS THE POINT.
    // v1 required /Tageskontingent/ and /Morgen/ — it asserted as a CONTRACT the exact
    // free-quota promise the product does not keep. v2 replaced that with a FAIR-USE
    // DAILY CAP and required /Tageslimit/ + /Fair-Use/ — truthful about price, still
    // false about mechanism: the only per-user daily cap in the system sat behind an
    // `if (deps.usage)` guard the production entrypoint never satisfied, so it had
    // never once fired and could not have produced this 429. It has since been deleted.
    //
    // A 429 arriving here is UPSTREAM rate limiting — about request RATE over minutes.
    // So the copy may not name a DAY, may not promise a RESET, and may not promise
    // anything free; and it must still say that requests run on credits, because that
    // is the one thing about this lane that is true and was once denied.
    expect(json.error?.message).toMatch(/Credits/);
    for (const lie of [
      /kostenlos/i,
      /gratis/i,
      /Tageskontingent/i,
      /Tageslimit/i,
      /frei\b/i,
      /\bmorgen\b/i,
      /pro Tag/i,
      /für heute/i,
    ]) {
      expect(json.error?.message, `429 copy must not claim: ${lie}`).not.toMatch(lie);
    }
  });

  it('forwards the function-calling fields (tools/tool_choice) on the EVE cloud lane — the tool-use tripwire', async () => {
    // REGRESSION GUARD: the cloud outboundBody once dropped `tools`, so the model
    // received ZERO tools and could never call one (tool_turns=0) — EVE went
    // "deaf" (narrated <bash>…</bash> as text instead of acting). If a refactor
    // re-strips tools on this lane, this test must fail.
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const tools = [
      {
        type: 'function',
        function: { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: {} } },
      },
    ];
    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'read the config' }],
        stream: false,
        tools,
        tool_choice: 'auto',
      }),
    });

    expect(response.status).toBe(200);
    // The tools array + tool_choice MUST reach the eve-inference function.
    expect(fnSeen.body?.tools).toEqual(tools);
    expect(fnSeen.body?.tool_choice).toBe('auto');
  });

  it('injects the bounded worker profile on the Maximum wire tier', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'max' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'audit and repair this complex project' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    const messages = fnSeen.body?.messages as Array<{ role?: string; content?: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('EVE Maximum execution profile');
    expect(messages[0].content).toContain('delegate_task');
    expect(messages[0].content).toContain('worker slots');
    expect(messages[0].content).toContain('Existing human gates remain binding');
    expect(messages[1]).toEqual({ role: 'user', content: 'audit and repair this complex project' });
  });

  it('refuses a server-rejected wire tier BEFORE any upstream request', async () => {
    // The real no-request proxy for "no debit": a tier the Edge Function refuses
    // must be stopped locally, so nothing is ever sent and nothing can be
    // metered. Asserting a core predicate would not have shown this — only
    // counting the calls that were never made does.
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'ultra' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hallo' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(500);
    // The evidence is that the fake Edge Function never saw a body: the request
    // was refused locally, so nothing travelled and nothing could be metered.
    expect(fnSeen.body).toBeUndefined();
  });

  it('omits tools on a tool-less EVE cloud turn (byte-clean, no empty array)', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(fnSeen.body).not.toHaveProperty('tools');
    expect(fnSeen.body).not.toHaveProperty('tool_choice');
    expect(fnSeen.body).not.toHaveProperty('keep_alive');
  });

  it('keeps a local-selection chat on Ollama (EVE route inactive)', async () => {
    let ollamaSeen = false;
    let ollamaBody: Record<string, unknown> | undefined;
    const ollamaBaseUrl = await startFakeOpenAiServer((body) => {
      ollamaSeen = true;
      ollamaBody = body;
    });
    const fnSeen: EveFnSeen = {};
    await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => buildEveCloudRoute({ isEveSelection: false }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'local hello' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-inference-lane')).toBe('ollama_local');
    expect(ollamaSeen).toBe(true);
    expect(ollamaBody?.model).toBe('command-eve-gemma4-e4b-64k');
    expect(ollamaBody?.keep_alive).toBe(COMMAND_EVE_LOCAL_MODEL_KEEP_ALIVE);
    // The EVE function was never touched.
    expect(fnSeen.body).toBeUndefined();
  });

  it('converts OpenAI tool history to Ollama native arguments and tool names', async () => {
    let ollamaBody: Record<string, unknown> | undefined;
    const ollamaBaseUrl = await startFakeOpenAiServer((body) => {
      ollamaBody = body;
    });
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => buildEveCloudRoute({ isEveSelection: false }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [
          { role: 'user', content: 'Lies die Datei.' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_read_1',
                type: 'function',
                function: { name: 'Read', arguments: '{"path":"/tmp/example.txt"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_read_1', content: 'Inhalt' },
        ],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(ollamaBody?.messages).toEqual([
      { role: 'user', content: 'Lies die Datei.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_read_1',
            function: { name: 'Read', arguments: { path: '/tmp/example.txt' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', tool_name: 'Read', content: 'Inhalt' },
    ]);
  });

  it('redacts sensitive data on the EVE lane before the function is called (never blocks/hangs)', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1', // never reached
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'API key: sk-abcdefghijklmnopqrstuvwxyz123456' }],
        stream: false,
      }),
    });

    // The turn PROCEEDS to the cloud function (no 451, no hang), but the secret is redacted
    // out of the forwarded payload — the function still never sees the raw secret.
    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    expect(fnSeen.body).toBeDefined();
    const forwarded = JSON.stringify(fnSeen.body);
    expect(forwarded).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(forwarded).toContain('[REDACTED_SECRET]');
  });

  it('redacts PII the model echoed into a tool-call argument (not just .content)', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [
          { role: 'user', content: 'Leg den Kontakt an.' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'crm_create', arguments: '{"phone":"+49 30 12345678"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        ],
        stream: false,
      }),
    });

    // The phone was ONLY in the tool-call argument — it must still be detected + redacted.
    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    const forwarded = JSON.stringify(fnSeen.body);
    expect(forwarded).not.toContain('12345678');
    expect(forwarded).toContain('[REDACTED_PHONE]');
  });

  it('fail-closes with 401 when an EVE route is active but the license is missing', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: '', tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(401);
    // No unauthenticated request was made.
    expect(fnSeen.body).toBeUndefined();
  });

  it('fail-closes with 500 when picker state is unreadable instead of falling through to local', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () =>
        // Mirrors production (readInferenceSelectionFromBackendStrict): the
        // deliberate fail-closed lane guard is a CommandEveShimPublicError so
        // its authored message may surface to the client.
        Promise.reject(
          new CommandEveShimPublicError('Command EVE cloud route unavailable: inference selection could not be read.')
        ),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Command EVE cloud route unavailable: inference selection could not be read.' },
    });
  });

  it.each([
    'AUTHORIZATION_UNKNOWN',
    'AUTHORIZATION_REPLAY',
    'AUTHORIZATION_EXPIRED',
    'AUTHORIZATION_SEAT_MISMATCH',
    'AUTHORIZATION_SESSION_REQUIRED',
    'AUTHORIZATION_SESSION_MISMATCH',
    'AUTHORIZATION_CONTINUATION_INVALID',
    'AUTHORIZATION_CHAIN_LIMIT',
    'POLICY_STALE',
  ] as const)(
    'returns a typed non-retryable 422 before egress for deterministic managed-visual %s',
    async (reasonCode) => {
      const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-managed-visual-refusal-'));
      const receiptPath = path.join(receiptRoot, 'last-egress-boundary-receipt.json');
      const fnSeen: EveFnSeen = {};
      const fnUrl = await startFakeEveFunction(fnSeen);

      try {
        shimServerUrl = await startCommandEveOllamaOpenAiShim({
          port: 0,
          ollamaBaseUrl: 'http://127.0.0.1:1',
          egressReceiptPath: receiptPath,
          eveRouting: () => Promise.reject(new CommandEveManagedVisualAuthorizationError(reasonCode)),
        });

        const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: SHIM_JSON_HEADERS,
          body: JSON.stringify({
            eve_operation: 'user_chat_turn',
            model: 'custom:command-eve-gemma4-e4b-64k:latest',
            messages: [{ role: 'user', content: 'private prompt must not enter the refusal receipt' }],
            stream: false,
          }),
        });

        expect(response.status).toBe(422);
        const body = await response.json();
        expect(body).toEqual({
          error: {
            message: 'Managed visual authorization cannot be verified. Reattach the files and retry.',
            type: 'command_eve_managed_visual_authorization_error',
            code: 'EVE_MANAGED_VISUAL_AUTHORIZATION_INVALID',
          },
        });
        expect(JSON.stringify(body)).not.toContain(reasonCode);
        const correlationId = response.headers.get('x-command-eve-error-correlation');
        expect(correlationId).toMatch(/^[0-9a-f-]{36}$/i);
        // The fake eve-inference endpoint is the sole egress probe. A refusal
        // happens before the paid/provider seam, so it sees zero requests.
        expect(fnSeen.attempts ?? 0).toBe(0);

        const failureReceipt = JSON.parse(
          fs.readFileSync(path.join(receiptRoot, 'last-managed-visual-authorization-failure.json'), 'utf8')
        );
        expect(failureReceipt).toEqual({
          version: 'command-eve-managed-visual-authorization-failure/v1',
          boundary: 'desktop_managed_visual_authorization',
          observed_at: expect.any(String),
          status_code: 422,
          error_code: 'EVE_MANAGED_VISUAL_AUTHORIZATION_INVALID',
          authorization_reason_code: reasonCode,
          request_correlation_id: correlationId,
        });
        expect(JSON.stringify(failureReceipt)).not.toContain('private prompt');
        expect(JSON.stringify(failureReceipt)).not.toContain(FAKE_LICENSE);
        expect(fs.statSync(path.join(receiptRoot, 'last-managed-visual-authorization-failure.json')).mode & 0o777).toBe(
          0o600
        );
      } finally {
        fs.rmSync(receiptRoot, { recursive: true, force: true });
      }
    }
  );

  it('never echoes arbitrary throw messages to the client (F-14)', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => Promise.reject(new Error('bearer sk-secret-leak must never surface')),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body?.error?.message).toBe('Command EVE shim internal error.');
    expect(JSON.stringify(body)).not.toContain('sk-secret-leak');
  });

  it('rejects a non-loopback ollamaBaseUrl at shim start (F-04)', async () => {
    await expect(
      startCommandEveOllamaOpenAiShim({
        port: 0,
        ollamaBaseUrl: 'https://ollama.example.invalid:11434',
      })
    ).rejects.toThrow(/loopback/);
  });

  it('accepts an explicit loopback ollamaBaseUrl at shim start (F-04)', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
    });
    expect(shimServerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
  });

  it('rejects a cleartext-remote function URL (fail closed, 500)', async () => {
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => ({
        active: true,
        functionUrl: 'http://evil.example.com/eve-inference',
        license: FAKE_LICENSE,
        tier: 'standard',
      }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(500);
  });

  it('forwards the EVE Maximum wire tier VERBATIM (max → Kimi K2.6), never silently downgraded to Flash', async () => {
    // HONEST TIER ROUTING (1.2.19) — the money-path tripwire. The deployed
    // eve-inference routes max → moonshotai/kimi-k2.6; the desktop must POST tier:'max'
    // when the user picked EVE Max. The OLD shim fell back to 'standard' on any
    // empty tier, which is why OpenRouter logs showed 100% Flash. This asserts a
    // max route POSTs tier:'max' (Kimi K2.6 lane), not 'standard' (Flash).
    let ollamaSeen = false;
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {
      ollamaSeen = true;
    });
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'max' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hardest task' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(ollamaSeen).toBe(false);
    // The POSTed tier is the picker's max, not a downgraded standard.
    expect(fnSeen.body?.tier).toBe('max');
  });

  it('forwards the EVE High wire tier VERBATIM (high → DeepSeek V4 Pro)', async () => {
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {});
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'high' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'think harder' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(fnSeen.body?.tier).toBe('high');
  });

  it('FAILS LOUD (500) when an active EVE route carries a missing/unknown tier — never silently meters Flash', async () => {
    // The old `: 'standard'` fallback would have made this turn bill DeepSeek V4
    // Flash. The hardened shim refuses an active EVE route whose tier is not a
    // known registry tier, so a broken selection→tier chain surfaces instead of
    // quietly mis-billing the cheapest model.
    let ollamaSeen = false;
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {
      ollamaSeen = true;
    });
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      // Active EVE route, but the tier is absent (the resolver could not map the
      // selection) — the bug condition that previously degraded to Flash.
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(500);
    // NO request was metered: neither the function (Flash) nor local Ollama saw it.
    expect(fnSeen.body).toBeUndefined();
    expect(ollamaSeen).toBe(false);
  });

  it('keeps the warm-up ping on the local lane even when an EVE route is active', async () => {
    let ollamaSeen = false;
    const ollamaBaseUrl = await startFakeOpenAiServer(() => {
      ollamaSeen = true;
    });
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    // Warm-up exercises the bundled local model, never the cloud function.
    expect(ollamaSeen).toBe(true);
    expect(fnSeen.body).toBeUndefined();
  });
});

describe('Command EVE shim — PER-SEAT PII/DSGVO egress switch (S11)', () => {
  const PHONE = '+49 30 12345678';

  it('mode OFF → forwards the payload UNREDACTED to the cloud function + receipt header disabled_by_operator', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1', // never reached
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
      // Operator turned the filter OFF for this seat.
      egressRedactionMode: () => 'off',
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: `Ruf ${PHONE} an.` }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    // NOT redacted: the boundary was forced to 'allow', so the raw phone reaches the fn.
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('allow');
    // Honest evidence, never silent: the receipt header records the operator waiver.
    expect(response.headers.get('x-command-eve-egress-redaction')).toBe('disabled_by_operator');
    const forwarded = JSON.stringify(fnSeen.body);
    expect(forwarded).toContain('12345678');
    expect(forwarded).not.toContain('[REDACTED_PHONE]');
  });

  it('mode OFF → the written egress receipt carries redaction: disabled_by_operator (audit evidence)', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-egress-receipt-'));
    const receiptPath = path.join(receiptDir, 'egress-boundary-receipt.json');

    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      egressReceiptPath: receiptPath,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
      egressRedactionMode: () => 'off',
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: `IBAN DE89 3704 0044 0532 0130 00` }],
        stream: false,
      }),
    });

    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as { redaction?: string; decision?: string };
    expect(receipt.redaction).toBe('disabled_by_operator');
    fs.rmSync(receiptDir, { recursive: true, force: true });
  });

  it('mode OFF + S3 (IBAN) on a CLIENT seat → STILL redacted at the seam (hard floor) while a co-occurring phone (S1) is waived', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-egress-s3floor-'));
    const receiptPath = path.join(receiptDir, 'egress-boundary-receipt.json');

    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      egressReceiptPath: receiptPath,
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
      egressRedactionMode: () => 'off',
      // S13: on a real CLIENT seat (uuid, never legacy) the S3 hard floor is NOT
      // waivable — the Auftragsverarbeiter protection of the client's secrets holds
      // even with the toggle off.
      activeSeatId: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: `IBAN DE89 3704 0044 0532 0130 00 und ruf ${PHONE} an.` }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    // The toggle was OFF, yet the S3 IBAN is redacted → decision is redact, not allow.
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    // The off-badge still fires (operator disabled the filter) — honest evidence.
    expect(response.headers.get('x-command-eve-egress-redaction')).toBe('disabled_by_operator');

    const forwarded = JSON.stringify(fnSeen.body);
    // S3 hard floor: the IBAN NEVER reaches the cloud, even with the filter off.
    expect(forwarded).toContain('[REDACTED_IBAN]');
    expect(forwarded).not.toContain('0532');
    // S1 waived: the phone passes through unredacted (operator responsibility).
    expect(forwarded).toContain('12345678');
    expect(forwarded).not.toContain('[REDACTED_PHONE]');

    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
      redaction?: string;
      decision?: string;
      sensitivity_class?: string;
      s3_hard_floor_enforced?: boolean;
      operator_waived_s1?: boolean;
    };
    expect(receipt.decision).toBe('redact');
    expect(receipt.sensitivity_class).toBe('S3');
    expect(receipt.s3_hard_floor_enforced).toBe(true);
    expect(receipt.operator_waived_s1).toBe(true);
    expect(receipt.redaction).toBe('disabled_by_operator');
    fs.rmSync(receiptDir, { recursive: true, force: true });
  });

  it("S13 mode OFF + S3 (IBAN) on the FOUNDER/legacy seat → off means truly OFF (the founder's OWN secret passes)", async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
      egressRedactionMode: () => 'off',
      // The founder's OWN legacy seat — off waives even the S3 floor for the founder's
      // own data (they consciously posted their own key with the filter off).
      activeSeatId: () => 'seat-1',
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: 'IBAN DE89 3704 0044 0532 0130 00 zum Testen.' }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    // OFF on the founder's own seat = nothing redacted, not even the S3 IBAN.
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('allow');
    const forwarded = JSON.stringify(fnSeen.body);
    expect(forwarded).toContain('0532'); // the IBAN reaches the cloud, unredacted
    expect(forwarded).not.toContain('[REDACTED_IBAN]');
  });

  it('mode ON → redacts as before (the fail-safe default is preserved)', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
      egressRedactionMode: () => 'on',
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: `Ruf ${PHONE} an.` }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    expect(response.headers.get('x-command-eve-egress-redaction')).toBeNull();
    const forwarded = JSON.stringify(fnSeen.body);
    expect(forwarded).not.toContain('12345678');
    expect(forwarded).toContain('[REDACTED_PHONE]');
  });

  it('mode UNDEFINED (resolver omitted) → redacts (fail-safe default resolver returns on)', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    // No egressRedactionMode option at all — must behave exactly as before S11 (redact).
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: FAKE_LICENSE, tier: 'standard' }),
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: `Ruf ${PHONE} an.` }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    const forwarded = JSON.stringify(fnSeen.body);
    expect(forwarded).not.toContain('12345678');
  });

  it('the LOCAL lane always redacts regardless of the mode (never egresses; toggle only gates cloud)', async () => {
    let ollamaBody: Record<string, unknown> | undefined;
    const ollamaBaseUrl = await startFakeOpenAiServer((bodySeen) => {
      ollamaBody = bodySeen;
    });

    // Local selection (EVE route inactive) + mode OFF: the local lane MUST still
    // redact (it does not egress, so the operator's cloud-lane waiver never
    // reaches it — the local path never calls the mode resolver).
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl,
      eveRouting: () => buildEveCloudRoute({ isEveSelection: false }),
      egressRedactionMode: () => 'off',
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'custom:command-eve-gemma4-e4b-64k:latest',
        messages: [{ role: 'user', content: `Ruf ${PHONE} an.` }],
        stream: false,
      }),
    });

    expect(response.status).toBe(200);
    // The local lane redacted (unchanged behavior), NOT gated by the cloud toggle.
    expect(response.headers.get('x-command-eve-egress-decision')).toBe('redact');
    const forwarded = JSON.stringify(ollamaBody);
    expect(forwarded).not.toContain('12345678');
  });
});

describe('warmCommandEveEveLane — EVE cloud preflight', () => {
  /**
   * MAT-1749 CHANGED THIS CONTRACT ON PURPOSE — a product decision, not a test
   * repair. This preflight used to send a real 1-token turn to the metered
   * eve-inference function at app start, its payload shaped (in its own comment) so
   * the request "is NOT classified as a local warm-up and is routed through the EVE
   * cloud lane instead". Every launch on a cloud tier therefore bought a warm lane
   * with the customer's credits for something nobody asked for.
   *
   * It now issues NO REQUEST. Leaving the shim to refuse it was rejected: a refusal
   * is still an authenticated request and still warned on every start, which teaches
   * operators to ignore warnings.
   *
   * The seat loses a latency optimisation; it does not lose money. Edge warming can
   * return against a dedicated NON-METERED health endpoint — and that is the change
   * that should replace the early return, not a quiet re-registration.
   */
  it('issues NO request at all — nothing to the shim, nothing to a provider, nothing to bill', async () => {
    let shimHits = 0;
    // This server stands in for the loopback shim. Relying on the shim to REFUSE was
    // not enough: a refusal is still an authenticated request, and it still produced
    // a console warning on every cloud-tier launch. The claim now is stronger and
    // simpler — nothing is sent, so this recorder must never observe anything.
    const shimStandIn = await startFakeOpenAiServer(() => {
      shimHits += 1;
    });

    const result = await warmCommandEveEveLane({ baseUrl: shimStandIn, tier: 'standard', timeoutMs: 5_000 });

    expect(shimHits).toBe(0);
    // A first-class SKIP, not a failure: there is no status because nothing answered.
    expect(result.skipped).toBe(true);
    expect(result.status).toBeUndefined();
    expect(result.tier).toBe('standard');
  });

  it('skips without throwing, whatever the license or route state is', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1', // never reached
      eveRouting: () => ({ active: true, functionUrl: fnUrl, license: '', tier: 'standard' }),
    });

    const result = await warmCommandEveEveLane({ baseUrl: shimServerUrl, tier: 'standard', timeoutMs: 5_000 });

    // Startup must survive this quietly. The licence no longer matters because the
    // question is never asked.
    expect(result.skipped).toBe(true);
    expect(fnSeen.body).toBeUndefined();
  });

  it('refuses to preflight a non-loopback base URL (no direct cloud egress)', async () => {
    const result = await warmCommandEveEveLane({ baseUrl: 'https://api.example.com/v1', timeoutMs: 1_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('loopback');
  });
});

describe('Command EVE shim — per-seat usage attribution (A3)', () => {
  const eveRoute = (fnUrl: string) => ({
    active: true,
    functionUrl: fnUrl,
    license: FAKE_LICENSE,
    tier: 'standard' as const,
  });

  it('spreads the OPAQUE active-seat id into the cloud body as seat_id (a real UUID seat)', async () => {
    const seatUuid = '11111111-2222-3333-4444-555555555555';
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => eveRoute(fnUrl),
      activeSeatId: () => seatUuid,
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        session_id: 'same-local-session',
      }),
    });

    expect(fnSeen.body?.seat_id).toBe(seatUuid);
    expect(fnSeen.body?.cache_scope).toBe(commandEveCacheScope('same-local-session', seatUuid));
    expect(fnSeen.body?.cache_scope).not.toBe(commandEveCacheScope('same-local-session', 'seat-1'));
  });

  it('sends the legacy "seat-1" by default (resolver omitted ⇒ byte-stable attribution)', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    // No activeSeatId option at all — the default resolver returns 'seat-1'.
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => eveRoute(fnUrl),
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(fnSeen.body?.seat_id).toBe('seat-1');
  });

  it('omits seat_id entirely when the resolver returns an empty id (old-app-safe NULL, not "")', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => eveRoute(fnUrl),
      activeSeatId: () => '',
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        session_id: 'same-local-session',
      }),
    });

    expect(fnSeen.body).not.toHaveProperty('seat_id');
    expect(fnSeen.body).not.toHaveProperty('cache_scope');
  });

  it('sends ONLY the opaque id — the display LABEL never rides the body (H3)', async () => {
    const seatUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const secretLabel = 'Klinik Salem';
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);

    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => eveRoute(fnUrl),
      // The resolver hands the shim the id ONLY — never the label.
      activeSeatId: () => seatUuid,
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });

    expect(fnSeen.body?.seat_id).toBe(seatUuid);
    // The whole body, serialized, must not contain the seat's human name.
    expect(JSON.stringify(fnSeen.body)).not.toContain(secretLabel);
  });
});

describe('Command EVE shim — A1 attribution spoof-close (SG-1)', () => {
  const eveRoute = (fnUrl: string) => ({
    active: true as const,
    functionUrl: fnUrl,
    license: FAKE_LICENSE,
    tier: 'standard' as const,
  });

  it('IGNORES a client-sent body.agent_id — no header ⇒ never forwards agent_id (steady state)', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => eveRoute(fnUrl),
      // No attributionAgentId resolver ⇒ default 'eve' (1.7.0 steady state).
    });

    const response = await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_JSON_HEADERS,
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        // SPOOF ATTEMPT: a client stuffs a roster id into the body.
        agent_id: 'growth-lead',
      }),
    });

    expect(response.status).toBe(200);
    // The spoofed body.agent_id is dropped: attribution resolved to 'eve', which
    // the outbound path never forwards. The ledger cannot be spoofed via the body.
    expect(fnSeen.body).not.toHaveProperty('agent_id');
  });

  it('derives agent_id ONLY from the X-EVE-Dispatch header token — body.agent_id is ignored even when a valid token is present', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => eveRoute(fnUrl),
      // Stand-in for the registry: the token 'valid-tok' resolves to growth-lead.
      attributionAgentId: (token) => (token === 'valid-tok' ? 'growth-lead' : 'eve'),
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...SHIM_JSON_HEADERS, 'x-eve-dispatch': 'valid-tok' },
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        // A DIFFERENT spoofed id in the body must be ignored.
        agent_id: 'seo-lead',
      }),
    });

    // The TOKEN's role wins; the body's spoof is ignored.
    expect(fnSeen.body?.agent_id).toBe('growth-lead');
  });

  it('an unknown/absent token ⇒ agent_id omitted even if the body claims a role', async () => {
    const fnSeen: EveFnSeen = {};
    const fnUrl = await startFakeEveFunction(fnSeen);
    shimServerUrl = await startCommandEveOllamaOpenAiShim({
      port: 0,
      ollamaBaseUrl: 'http://127.0.0.1:1',
      eveRouting: () => eveRoute(fnUrl),
      attributionAgentId: (token) => (token === 'valid-tok' ? 'growth-lead' : 'eve'),
    });

    await fetch(`${shimServerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...SHIM_JSON_HEADERS, 'x-eve-dispatch': 'bogus-token' },
      body: JSON.stringify({
        eve_operation: 'user_chat_turn',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        agent_id: 'growth-lead',
      }),
    });

    expect(fnSeen.body).not.toHaveProperty('agent_id');
  });
});
