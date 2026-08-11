/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  bindTypedUIEnvelopeToArtifact,
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_MIME_TYPE,
  TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
  TYPED_UI_SCHEMA_VERSION,
} from '@/common/typedUI';
import type { TMessage } from '@/common/chat/chatLib';
import {
  ensureCommandEveShimAuthToken,
  startCommandEveOllamaOpenAiShim,
  stopCommandEveOllamaOpenAiShimForTest,
  type CommandEveOllamaShimOptions,
} from '@/process/commandEve/ollamaOpenAiShim';
import { attestDurableTypedUIArtifact } from '@/process/commandEve/typedUIArtifactAttestationMain';
import { authorizeTypedUIAction, finalizeTypedUIAction } from '@/process/commandEve/typedUIActionReceiptCore';
import {
  appendMainOwnedTypedUIProviderCompletionReceipt,
  hashTypedUIEnvelope,
  resolveMainOwnedTypedUIProviderCompletionReceipt,
  type MainOwnedTypedUIProviderCompletionInput,
} from '@/process/commandEve/typedUIProvenanceAttestationCore';
import {
  createTypedUIActionHandlers,
  TYPED_UI_INTERNAL_ACTION_ID,
  type TypedUIActionHost,
} from '@/renderer/pages/conversation/Messages/components/TypedGenerativeUI';
import { createStateStore } from '@json-render/core';
import fs from 'node:fs';
import http, { type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedUIFixture } from './fixtures';

const SHIM_AUTH_TOKEN = ensureCommandEveShimAuthToken();
const CALL_ID = 'call-production-route-1';
const SESSION_ID = 'session-production-route-1';
const SEAT = { seatId: 'seat-production-route-1', seatContextRevision: 41 } as const;
const RAW_CONTENT_SHA256 = hashTypedUIEnvelope(typedUIFixture());

type Lane = 'eve_cloud' | 'managed_local' | 'connected' | 'ollama_local';
type Wire = 'openai' | 'ollama';
type Scenario = {
  label: string;
  lane: Lane;
  wire: Wire;
  provider: string;
  model: string;
};
type UpstreamReply = {
  status?: number;
  contentType?: string;
  body: string;
};

const SCENARIOS: Scenario[] = [
  { label: 'EVE cloud', lane: 'eve_cloud', wire: 'openai', provider: 'EVE Inference', model: 'standard' },
  {
    label: 'managed local OpenAI',
    lane: 'managed_local',
    wire: 'openai',
    provider: 'provider-free-managed-local',
    model: 'managed-model',
  },
  {
    label: 'connected OpenAI',
    lane: 'connected',
    wire: 'openai',
    provider: 'provider-free-connected',
    model: 'connected-model',
  },
  {
    label: 'native Ollama',
    lane: 'ollama_local',
    wire: 'ollama',
    provider: 'ollama',
    model: 'command-eve-local-model',
  },
];

let upstreamServer: http.Server | undefined;
let shimUrl = '';
const temporaryDirectories: string[] = [];

function openAIToolCall() {
  return {
    id: CALL_ID,
    type: 'function',
    function: {
      name: 'eve_typed_ui_publish',
      arguments: JSON.stringify({ envelope: typedUIFixture() }),
    },
  };
}

function ollamaToolCall() {
  return {
    function: { name: 'eve_typed_ui_publish', arguments: { envelope: typedUIFixture() } },
  };
}

function openAICompletion(): Record<string, unknown> {
  return {
    id: 'completion-production-route-1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [openAIToolCall()] },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

function ollamaCompletion(): Record<string, unknown> {
  return {
    model: 'local-model',
    message: { role: 'assistant', content: '', tool_calls: [ollamaToolCall()] },
    done: true,
    done_reason: 'stop',
  };
}

function openAIStream(includeDone: boolean): string {
  const call = openAIToolCall();
  const callEvent = {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, ...call }] },
        finish_reason: null,
      },
    ],
  };
  const terminalEvent = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
  return [
    `data: ${JSON.stringify(callEvent)}\n\n`,
    `data: ${JSON.stringify(terminalEvent)}\n\n`,
    ...(includeDone ? ['data: [DONE]\n\n'] : []),
  ].join('');
}

function ollamaStream(includeTerminal: boolean): string {
  return [
    JSON.stringify({ message: { role: 'assistant', content: '' }, done: false }),
    ...(includeTerminal
      ? [
          JSON.stringify({
            message: { role: 'assistant', content: '', tool_calls: [ollamaToolCall()] },
            done: true,
            done_reason: 'stop',
          }),
        ]
      : []),
  ].join('\n');
}

function successfulReply(scenario: Scenario, stream: boolean): UpstreamReply {
  if (!stream) {
    return {
      contentType: 'application/json',
      body: JSON.stringify(scenario.wire === 'openai' ? openAICompletion() : ollamaCompletion()),
    };
  }
  return scenario.wire === 'openai'
    ? { contentType: 'text/event-stream', body: openAIStream(true) }
    : { contentType: 'application/x-ndjson', body: ollamaStream(true) };
}

function truncatedReply(scenario: Scenario): UpstreamReply {
  return scenario.wire === 'openai'
    ? { contentType: 'text/event-stream', body: openAIStream(false) }
    : { contentType: 'application/x-ndjson', body: ollamaStream(false) };
}

function nonOkReply(scenario: Scenario): UpstreamReply {
  return {
    status: 500,
    contentType: 'application/json',
    // Deliberately looks like a valid completion. Status remains authoritative.
    body: JSON.stringify(scenario.wire === 'openai' ? openAICompletion() : ollamaCompletion()),
  };
}

function typedToolRequest(stream: boolean): Record<string, unknown> {
  return {
    eve_operation: 'user_chat_turn',
    session_id: SESSION_ID,
    model: 'command-eve-local-model',
    messages: [{ role: 'user', content: 'Render the typed status card.' }],
    stream,
    tools: [
      {
        type: 'function',
        function: {
          name: 'eve_typed_ui_publish',
          description: 'Publish one declarative Typed UI envelope.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['envelope'],
            properties: { envelope: { type: 'object' } },
          },
        },
      },
    ],
  };
}

function ledgerPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-production-route-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'audit', 'provider-completions.jsonl');
}

async function startUpstream(reply: UpstreamReply): Promise<string> {
  upstreamServer = http.createServer((request, response) => {
    request.resume();
    writeReply(response, reply);
  });
  await new Promise<void>((resolve, reject) => {
    upstreamServer?.once('error', reject);
    upstreamServer?.listen(0, '127.0.0.1', resolve);
  });
  const address = upstreamServer.address();
  if (!address || typeof address === 'string') throw new Error('provider-free upstream did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function writeReply(response: ServerResponse, reply: UpstreamReply): void {
  response.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json' });
  response.end(reply.body);
}

async function startShim(
  options: CommandEveOllamaShimOptions,
  completionLedgerPath: string,
  observed: MainOwnedTypedUIProviderCompletionInput[],
  seatReads: { count: number }
): Promise<void> {
  shimUrl = await startCommandEveOllamaOpenAiShim({
    port: 0,
    authToken: SHIM_AUTH_TOKEN,
    activeSeatContext: () => {
      seatReads.count += 1;
      return SEAT;
    },
    typedUIProviderCompletion: (receipt) => {
      observed.push(receipt);
      appendMainOwnedTypedUIProviderCompletionReceipt(completionLedgerPath, receipt);
    },
    ...options,
  });
}

async function configureScenario(
  scenario: Scenario,
  reply: UpstreamReply,
  completionLedgerPath: string,
  observed: MainOwnedTypedUIProviderCompletionInput[],
  seatReads: { count: number }
): Promise<void> {
  if (scenario.lane === 'connected') {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://provider-free.invalid/')) {
        return new Response(reply.body, {
          status: reply.status ?? 200,
          headers: { 'content-type': reply.contentType ?? 'application/json' },
        });
      }
      return nativeFetch(input, init);
    });
    await startShim(
      {
        ollamaBaseUrl: 'http://127.0.0.1:1',
        eveRouting: () => ({ active: false }),
        connectedProviderRouting: () => ({
          active: true,
          baseUrl: 'https://provider-free.invalid/v1',
          apiKey: 'provider-free-connected-key',
          model: scenario.model,
          providerName: scenario.provider,
        }),
      },
      completionLedgerPath,
      observed,
      seatReads
    );
    return;
  }

  const baseUrl = await startUpstream(reply);
  const common: CommandEveOllamaShimOptions = { ollamaBaseUrl: 'http://127.0.0.1:1' };
  if (scenario.lane === 'eve_cloud') {
    await startShim(
      {
        ...common,
        eveRouting: () => ({
          active: true,
          functionUrl: baseUrl,
          license: 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY',
          tier: scenario.model,
        }),
      },
      completionLedgerPath,
      observed,
      seatReads
    );
    return;
  }
  if (scenario.lane === 'managed_local') {
    await startShim(
      {
        ...common,
        eveRouting: () => ({ active: false }),
        localOpenAiRouting: () => ({
          active: true,
          baseUrl: `${baseUrl}/v1`,
          apiKey: 'provider-free-local-key',
          model: scenario.model,
          providerName: scenario.provider,
        }),
      },
      completionLedgerPath,
      observed,
      seatReads
    );
    return;
  }
  await startShim(
    {
      ollamaBaseUrl: baseUrl,
      eveRouting: () => ({ active: false }),
      localOpenAiRouting: () => ({ active: false }),
      connectedProviderRouting: () => ({ active: false }),
    },
    completionLedgerPath,
    observed,
    seatReads
  );
}

async function invokeShim(stream: boolean): Promise<Response> {
  return fetch(`${shimUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SHIM_AUTH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(typedToolRequest(stream)),
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  if (shimUrl) {
    await stopCommandEveOllamaOpenAiShimForTest();
    shimUrl = '';
  }
  if (upstreamServer) {
    await new Promise<void>((resolve, reject) => {
      upstreamServer?.close((error) => (error ? reject(error) : resolve()));
    });
    upstreamServer = undefined;
  }
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('production Typed UI provider completion routes', () => {
  for (const scenario of SCENARIOS) {
    it.each([
      { stream: false, terminal: scenario.wire === 'openai' ? 'openai_json' : 'ollama_json' },
      { stream: true, terminal: scenario.wire === 'openai' ? 'openai_sse' : 'ollama_jsonl' },
    ])(`records one Main-owned receipt after terminal ${scenario.label} ($terminal)`, async ({ stream, terminal }) => {
      const completionLedgerPath = ledgerPath();
      const observed: MainOwnedTypedUIProviderCompletionInput[] = [];
      const seatReads = { count: 0 };
      await configureScenario(scenario, successfulReply(scenario, stream), completionLedgerPath, observed, seatReads);

      const response = await invokeShim(stream);
      expect(response.status).toBe(200);
      const responseBody = await response.text();
      expect(seatReads.count).toBe(1);
      expect(observed).toHaveLength(1);
      const expectedCallId = scenario.wire === 'openai' ? CALL_ID : observed[0].tool_call_id;
      expect(observed[0]).toMatchObject({
        version: 'command-eve.typed-ui-provider-completion/v2',
        session_id: SESSION_ID,
        provider: scenario.provider,
        model: scenario.model,
        tool_call_id: expectedCallId,
        raw_content_sha256: RAW_CONTENT_SHA256,
        seat_id: SEAT.seatId,
        seat_context_revision: SEAT.seatContextRevision,
        route_receipt: {
          route: scenario.lane,
          status: 'completed',
          terminal,
          http_status: 200,
        },
      });
      if (scenario.wire === 'ollama') {
        expect(expectedCallId).toMatch(/^call_[a-f0-9]{48}$/);
        expect(responseBody).toContain(`\"id\":\"${expectedCallId}\"`);
        expect(responseBody).toContain('\"arguments\":\"{\\\"envelope\\\":');
      }
      expect(observed[0].provider_request_id).toMatch(/^tuirequest-[0-9a-f-]{36}$/);

      const resolved = resolveMainOwnedTypedUIProviderCompletionReceipt(completionLedgerPath, {
        toolCallId: expectedCallId,
        rawContentSha256: RAW_CONTENT_SHA256,
        activeSeatId: SEAT.seatId,
        seatContextRevision: SEAT.seatContextRevision,
      });
      expect(resolved).toMatchObject({
        version: 'command-eve.typed-ui-provider-completion/v2',
        raw_content_sha256: RAW_CONTENT_SHA256,
        seat_context_revision: SEAT.seatContextRevision,
      });
      const persisted = fs.readFileSync(completionLedgerPath, 'utf8');
      expect(persisted.trim().split('\n')).toHaveLength(1);
      expect(persisted).not.toContain(SESSION_ID);
      expect(persisted).not.toContain(scenario.provider);
      expect(persisted).not.toContain(scenario.model);
    });

    it(`does not record a non-2xx ${scenario.label} response`, async () => {
      const completionLedgerPath = ledgerPath();
      const observed: MainOwnedTypedUIProviderCompletionInput[] = [];
      await configureScenario(scenario, nonOkReply(scenario), completionLedgerPath, observed, { count: 0 });

      const response = await invokeShim(false);
      expect(response.status).toBe(500);
      await response.text();
      expect(observed).toEqual([]);
      expect(fs.existsSync(completionLedgerPath)).toBe(false);
    });

    it(`does not record a truncated ${scenario.label} stream`, async () => {
      const completionLedgerPath = ledgerPath();
      const observed: MainOwnedTypedUIProviderCompletionInput[] = [];
      await configureScenario(scenario, truncatedReply(scenario), completionLedgerPath, observed, { count: 0 });

      const response = await invokeShim(true);
      expect(response.status).toBe(200);
      await response.text();
      expect(observed).toEqual([]);
      expect(fs.existsSync(completionLedgerPath)).toBe(false);
    });
  }

  it('rejects native Ollama data after the terminal chunk before any publish receipt', async () => {
    const scenario = SCENARIOS.find((candidate) => candidate.wire === 'ollama');
    if (!scenario) throw new Error('native Ollama scenario missing');
    const completionLedgerPath = ledgerPath();
    const observed: MainOwnedTypedUIProviderCompletionInput[] = [];
    // Adversarial shape: the terminal done chunk carries a would-be-valid
    // publish call, then a trailing line arrives (without trailing newline,
    // through the buffered-tail flush). Without the jsonl_data_after_terminal
    // invalidation this stream would produce exactly one completion receipt.
    const body = `${ollamaStream(true)}\n${JSON.stringify({
      done: false,
      message: { role: 'assistant', content: 'trailing' },
    })}`;
    await configureScenario(scenario, { contentType: 'application/x-ndjson', body }, completionLedgerPath, observed, {
      count: 0,
    });

    const response = await invokeShim(true);
    expect(response.status).toBe(200);
    await response.text();
    expect(observed).toEqual([]);
    expect(fs.existsSync(completionLedgerPath)).toBe(false);
  });

  it('binds a real route receipt through the durable message join and Main action broker before any host effect', async () => {
    const scenario = SCENARIOS.find((candidate) => candidate.lane === 'managed_local');
    if (!scenario) throw new Error('managed local scenario missing');
    const completionLedgerPath = ledgerPath();
    const observed: MainOwnedTypedUIProviderCompletionInput[] = [];
    await configureScenario(scenario, successfulReply(scenario, false), completionLedgerPath, observed, { count: 0 });

    const response = await invokeShim(false);
    expect(response.status).toBe(200);
    await response.text();
    expect(observed).toHaveLength(1);

    const rawEnvelope = typedUIFixture();
    const createdAt = Date.parse(observed[0].completed_at);
    const artifact = {
      artifact_id: `tool-artifact-${CALL_ID}`,
      conversation_id: 'conversation-production-pipeline-1',
      source_message_id: 'message-production-pipeline-1',
      created_at: createdAt,
    };
    const envelope = bindTypedUIEnvelopeToArtifact(rawEnvelope, artifact);
    const message: TMessage = {
      id: artifact.source_message_id,
      msg_id: artifact.source_message_id,
      conversation_id: artifact.conversation_id,
      type: 'tool_group',
      created_at: createdAt,
      content: [
        {
          call_id: CALL_ID,
          name: 'eve_typed_ui_publish',
          description: 'Typed UI',
          render_output_as_markdown: false,
          status: 'Success',
          result_display: {
            ok: true,
            artifact_type: 'file',
            mime_type: TYPED_UI_MIME_TYPE,
            schema_version: TYPED_UI_SCHEMA_VERSION,
            catalog_version: TYPED_UI_CATALOG_VERSION,
            content: JSON.stringify(rawEnvelope),
          },
        },
      ],
    } as TMessage;
    const auditDirectory = path.dirname(completionLedgerPath);
    const generationLedgerPath = path.join(auditDirectory, 'typed-ui-generations.jsonl');
    const attestationAuditPath = path.join(auditDirectory, 'typed-ui-attestations.jsonl');
    const attestation = await attestDurableTypedUIArtifact(
      { providerCompletionLedgerPath: completionLedgerPath, generationLedgerPath, attestationAuditPath },
      {
        version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
        envelope,
        artifact,
      },
      { activeSeatId: SEAT.seatId, seatContextRevision: SEAT.seatContextRevision },
      { readMessage: async () => message }
    );
    expect(attestation.status).toBe('verified');

    const actionAuditPath = path.join(auditDirectory, 'typed-ui-actions.jsonl');
    const gateAuditPath = path.join(auditDirectory, 'gate-decisions.jsonl');
    const intentClaimDirectory = path.join(auditDirectory, 'typed-ui-action-intents');
    const events: string[] = [];
    let sequence = 1;
    const actionOptions = {
      attestationAuditPath,
      activeSeatId: SEAT.seatId,
      seatContextRevision: SEAT.seatContextRevision,
      executionMode: 'observed' as const,
      gateAuditPath,
      intentClaimDirectory,
      now: () => new Date(createdAt + 1_000),
      randomUUID: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    };
    const host: TypedUIActionHost = {
      attestProvenance: async () => attestation,
      authorizeAction: async (request) => {
        events.push('authority');
        return authorizeTypedUIAction(actionAuditPath, request, actionOptions);
      },
      finalizeAction: async (request) => {
        events.push('receipt');
        return finalizeTypedUIAction(actionAuditPath, request, actionOptions);
      },
      getActionAvailability: (action) => ({
        available: action !== 'goal_control' && action !== 'worker_control',
        ...(action === 'goal_control' || action === 'worker_control'
          ? { reason: 'durable_transport_unavailable' }
          : {}),
      }),
      openArtifact: async () => {
        events.push('effect');
      },
      openUrl: vi.fn(),
      replyWithState: vi.fn(),
    };
    const handlers = createTypedUIActionHandlers({
      envelope,
      attestation,
      receiptContext: {
        artifactId: artifact.artifact_id,
        conversationId: artifact.conversation_id,
        sourceMessageId: artifact.source_message_id,
      },
      store: createStateStore(envelope.state),
      host,
      onReceipt: vi.fn(),
    });

    await handlers.open_artifact({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun',
      artifact_kind: 'worker',
      artifact_id: 'run-41',
    });
    expect(events).toEqual(['authority', 'effect', 'receipt']);

    await handlers.goal_control({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'pauseGoal',
      goal_id: 'goal-17',
      action: 'pause',
      expected_revision: 3,
      expected_sequence: 9,
    });
    expect(events).toEqual(['authority', 'effect', 'receipt']);
    expect(fs.readFileSync(actionAuditPath, 'utf8')).not.toContain('goal_control');
  });
});
