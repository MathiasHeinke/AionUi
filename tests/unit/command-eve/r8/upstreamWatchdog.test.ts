import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
  type CommandEveUpstreamOutcomeReceipt,
} from '@/process/commandEve/ollamaOpenAiShim';
import { expectR8Signal, startR8LoopbackFixture, type R8LoopbackFixture } from './streamFixtures';

const SHIM_AUTH_TOKEN = ensureCommandEveShimAuthToken();
const SHIM_HEADERS = {
  'content-type': 'application/json',
  authorization: `Bearer ${SHIM_AUTH_TOKEN}`,
};
const TEST_PROMPT = 'R8_PRIVATE_PROMPT_SENTINEL';

let shimUrl = '';
let fixture: R8LoopbackFixture | undefined;
let receiptDir = '';

function requestBody(stream = true): string {
  return JSON.stringify({
    model: 'custom:command-eve-r8-fixture',
    messages: [
      { role: 'system', content: '# EVE Operating Rule\nYou are EVE.' },
      { role: 'user', content: TEST_PROMPT },
    ],
    stream,
  });
}

async function startShim(
  upstreamBaseUrl: string,
  receipts: CommandEveUpstreamOutcomeReceipt[],
  timeouts: { firstByteMs?: number; idleMs?: number } = {},
  managedOpenAi = false,
  deriveOutcomePath = false
): Promise<string> {
  receiptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-r8-'));
  shimUrl = await startCommandEveOllamaOpenAiShim({
    port: 0,
    authToken: SHIM_AUTH_TOKEN,
    ollamaBaseUrl: upstreamBaseUrl,
    upstreamFirstByteTimeoutMs: timeouts.firstByteMs ?? 300,
    upstreamIdleTimeoutMs: timeouts.idleMs ?? 80,
    ...(deriveOutcomePath
      ? { egressReceiptPath: path.join(receiptDir, 'last-egress-boundary-receipt.json') }
      : { upstreamOutcomeReceiptPath: path.join(receiptDir, 'last-upstream-outcome-receipt.json') }),
    upstreamOutcomeReporter: (receipt) => receipts.push(receipt),
    ...(managedOpenAi
      ? {
          localOpenAiRouting: () => ({
            active: true,
            baseUrl: upstreamBaseUrl,
            model: 'command-eve-r8-managed-fixture',
            apiKey: 'fixture-token',
          }),
        }
      : {}),
  });
  return shimUrl;
}

function persistedReceipt(): CommandEveUpstreamOutcomeReceipt {
  return JSON.parse(
    fs.readFileSync(path.join(receiptDir, 'last-upstream-outcome-receipt.json'), 'utf8')
  ) as CommandEveUpstreamOutcomeReceipt;
}

afterEach(async () => {
  if (shimUrl) await stopCommandEveOllamaOpenAiShimForTest();
  shimUrl = '';
  if (fixture) await fixture.close();
  fixture = undefined;
  if (receiptDir) fs.rmSync(receiptDir, { recursive: true, force: true });
  receiptDir = '';
});

describe('Command EVE R8 upstream watchdog', () => {
  it('aborts a stalled mid-stream response and accepts the next prompt on the same shim', async () => {
    let markClosed: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    let upstreamRequests = 0;
    fixture = await startR8LoopbackFixture((_request, response) => {
      upstreamRequests += 1;
      if (upstreamRequests > 1) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: { content: 'recovered' }, done_reason: 'stop' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify({ message: { content: 'partial' }, done: false })}\n`);
      response.once('close', () => markClosed?.());
    });
    const receipts: CommandEveUpstreamOutcomeReceipt[] = [];
    const url = await startShim(fixture.baseUrl, receipts, { idleMs: 60 });

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(),
    });
    const streamed = await response.text();

    expect(response.status).toBe(200);
    expect(streamed).toContain('partial');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: 'idle_timeout', response_started: true });
    await expectR8Signal(upstreamClosed, 'mid-stream upstream close');
    expect(persistedReceipt()).toEqual(receipts[0]);

    const recovery = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(false),
    });
    expect(recovery.status).toBe(200);
    await expect(recovery.json()).resolves.toMatchObject({ choices: [{ message: { content: 'recovered' } }] });
    expect(receipts.map((receipt) => receipt.outcome)).toEqual(['idle_timeout', 'completed']);
    expect(persistedReceipt()).toEqual(receipts[1]);
  });

  it('keeps a reasoning-only progress stream alive beyond several idle windows', async () => {
    fixture = await startR8LoopbackFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let step = 0;
      const progress = setInterval(() => {
        step += 1;
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning: `reasoning-${step}` }, finish_reason: null }] })}\n\n`
        );
        if (step < 10) return;
        clearInterval(progress);
        response.end('data: [DONE]\n\n');
      }, 20);
      response.once('close', () => clearInterval(progress));
    });
    const receipts: CommandEveUpstreamOutcomeReceipt[] = [];
    const url = await startShim(fixture.baseUrl, receipts, { idleMs: 70 }, true);

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(),
    });
    const streamed = await response.text();

    expect(response.status).toBe(200);
    expect(streamed).toContain('reasoning-10');
    expect(streamed).toContain('[DONE]');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: 'completed', response_started: true });
  });

  it('records client cancellation separately and proves the upstream socket closes', async () => {
    let markSeen: (() => void) | undefined;
    let markClosed: (() => void) | undefined;
    const upstreamSeen = new Promise<void>((resolve) => {
      markSeen = resolve;
    });
    const upstreamClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    fixture = await startR8LoopbackFixture((_request, response) => {
      markSeen?.();
      response.once('close', () => markClosed?.());
    });
    const receipts: CommandEveUpstreamOutcomeReceipt[] = [];
    const url = await startShim(fixture.baseUrl, receipts, { firstByteMs: 1_000 });
    const controller = new AbortController();
    const pending = fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(false),
      signal: controller.signal,
    });

    await expectR8Signal(upstreamSeen, 'upstream request');
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expectR8Signal(upstreamClosed, 'cancelled upstream close');

    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe('client_closed');
  });

  it('records first-byte timeout and unreachable upstream as distinct outcomes', async () => {
    fixture = await startR8LoopbackFixture(() => undefined);
    const timeoutReceipts: CommandEveUpstreamOutcomeReceipt[] = [];
    let url = await startShim(fixture.baseUrl, timeoutReceipts, { firstByteMs: 50 });

    let response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(false),
    });
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: { type: 'first_byte_timeout' } });
    expect(timeoutReceipts.map((receipt) => receipt.outcome)).toEqual(['first_byte_timeout']);

    await stopCommandEveOllamaOpenAiShimForTest();
    shimUrl = '';
    await fixture.close();
    fixture = undefined;
    fs.rmSync(receiptDir, { recursive: true, force: true });
    receiptDir = '';

    const errorReceipts: CommandEveUpstreamOutcomeReceipt[] = [];
    url = await startShim('http://127.0.0.1:1', errorReceipts);
    response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(false),
    });

    expect(response.status).toBe(502);
    expect(errorReceipts.map((receipt) => receipt.outcome)).toEqual(['upstream_error']);
  });

  it('keeps every outcome receipt content-free and transport-scoped', async () => {
    fixture = await startR8LoopbackFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: { content: TEST_PROMPT }, done_reason: 'stop' }));
    });
    const receipts: CommandEveUpstreamOutcomeReceipt[] = [];
    const url = await startShim(fixture.baseUrl, receipts, {}, false, true);

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(false),
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(Object.keys(receipts[0]).toSorted()).toEqual([
      'boundary',
      'first_body_chunk_at',
      'headers_received_at',
      'observed_at',
      'outcome',
      'request_id',
      'response_started',
      'started_at',
      'version',
    ]);
    expect(JSON.stringify(receipts[0])).not.toContain(TEST_PROMPT);
    expect(JSON.stringify(receipts[0])).not.toMatch(/credit|billing|reservation/i);
    expect(receipts[0].boundary).toBe('desktop_upstream_transport');
    expect(receipts[0].version).toBe('command-eve-upstream-outcome/v2');
    expect(receipts[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipts[0].headers_received_at).toBeTruthy();
    expect(receipts[0].first_body_chunk_at).toBeTruthy();
    expect(persistedReceipt()).toEqual(receipts[0]);
    const history = fs
      .readFileSync(path.join(receiptDir, 'upstream-outcome-history.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as CommandEveUpstreamOutcomeReceipt);
    expect(history).toEqual(receipts);
    expect(JSON.stringify(history)).not.toContain(TEST_PROMPT);
  });

  it('does not mistake HTTP headers for the first model body byte', async () => {
    fixture = await startR8LoopbackFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      setTimeout(() => response.end(), 150);
    });
    const receipts: CommandEveUpstreamOutcomeReceipt[] = [];
    const url = await startShim(fixture.baseUrl, receipts, { firstByteMs: 40, idleMs: 500 }, true);

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: SHIM_HEADERS,
      body: requestBody(),
    });
    await response.text();

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      version: 'command-eve-upstream-outcome/v2',
      outcome: 'first_byte_timeout',
      response_started: true,
      first_body_chunk_at: null,
    });
    expect(receipts[0].headers_received_at).toBeTruthy();
  });
});
