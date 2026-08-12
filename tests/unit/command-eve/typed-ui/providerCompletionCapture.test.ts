/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  extractOllamaCompletedTypedUIPublishCalls,
  extractOpenAICompletedTypedUIPublishCalls,
  OpenAITypedUIPublishSseCapture,
  reportCapturedTypedUIProviderCompletions,
} from '@/process/commandEve/typedUIProviderCompletionCapture';
import type { MainOwnedTypedUIProviderCompletionInput } from '@/process/commandEve/typedUIProvenanceAttestationCore';
import { describe, expect, it, vi } from 'vitest';
import { typedUIFixture } from './fixtures';

const args = () => JSON.stringify({ envelope: typedUIFixture() });
const call = (id = 'call-typed-1', argumentsValue: unknown = args()) => ({
  id,
  type: 'function',
  function: { name: 'eve_typed_ui_publish', arguments: argumentsValue },
});

function openAIResponse(toolCalls: unknown[], finishReason = 'tool_calls') {
  return {
    id: 'response-1',
    choices: [
      { index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: finishReason },
    ],
  };
}

function sseTranscript(includeDone = true): string {
  const argumentsJson = args();
  const split = Math.floor(argumentsJson.length / 2);
  const events = [
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-',
                function: { name: 'eve_typed_', arguments: argumentsJson.slice(0, split) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'stream-1',
                function: { name: 'ui_publish', arguments: argumentsJson.slice(split) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ].map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`);
  return `${events.join('')}${includeDone ? 'data: [DONE]\r\n\r\n' : ''}`;
}

function pushOneByteAtATime(target: { push(value: Uint8Array): void }, text: string) {
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) target.push(Uint8Array.of(byte));
}

describe('Typed UI provider-terminal capture', () => {
  it('extracts exact OpenAI JSON calls and keeps parallel calls independently keyed', () => {
    const result = extractOpenAICompletedTypedUIPublishCalls(openAIResponse([call('call-a'), call('call-b')]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.calls.map((item) => item.toolCallId)).toEqual(['call-a', 'call-b']);
    expect(new Set(result.calls.map((item) => item.rawContentSha256)).size).toBe(1);
  });

  it('ignores unknown tools and rejects duplicate IDs, malformed arguments, and non-terminal responses', () => {
    const unknown = { id: 'call-other', function: { name: 'read_file', arguments: '{}' } };
    expect(extractOpenAICompletedTypedUIPublishCalls(openAIResponse([unknown]))).toEqual({ ok: true, calls: [] });
    expect(extractOpenAICompletedTypedUIPublishCalls(openAIResponse([call('dup'), call('dup')]))).toMatchObject({
      ok: false,
      reason: 'tool_call_id_duplicate',
    });
    expect(extractOpenAICompletedTypedUIPublishCalls(openAIResponse([call('bad', '{')]))).toMatchObject({
      ok: false,
      reason: 'arguments_invalid_json',
    });
    expect(extractOpenAICompletedTypedUIPublishCalls(openAIResponse([call()], 'length'))).toMatchObject({
      ok: false,
      reason: 'response_not_terminal',
    });
  });

  it('reassembles UTF-8/SSE data across arbitrary byte boundaries and requires terminal DONE', () => {
    const capture = new OpenAITypedUIPublishSseCapture();
    pushOneByteAtATime(capture, sseTranscript());
    const result = capture.finish();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.calls[0].toolCallId).toBe('call-stream-1');

    const truncated = new OpenAITypedUIPublishSseCapture();
    pushOneByteAtATime(truncated, sseTranscript(false));
    expect(truncated.finish()).toMatchObject({ ok: false, reason: 'sse_not_terminal' });
  });

  it('rejects SSE data after a terminal finish or DONE marker', () => {
    const afterFinish = new OpenAITypedUIPublishSseCapture();
    const transcript = sseTranscript(false);
    const terminalOffset = transcript.lastIndexOf('data: ');
    const beforeTerminal = transcript.slice(0, terminalOffset);
    const terminal = transcript.slice(terminalOffset);
    pushOneByteAtATime(afterFinish, `${beforeTerminal}${terminal}${beforeTerminal}data: [DONE]\n\n`);
    expect(afterFinish.finish()).toMatchObject({ ok: false, reason: 'sse_data_after_terminal' });

    const afterDone = new OpenAITypedUIPublishSseCapture();
    pushOneByteAtATime(afterDone, `${sseTranscript()}data: ${JSON.stringify({ choices: [] })}\n\n`);
    expect(afterDone.finish()).toMatchObject({ ok: false, reason: 'sse_data_after_done' });
  });

  it('accepts Ollama object/string arguments only with a stable ID and terminal done', () => {
    expect(
      extractOllamaCompletedTypedUIPublishCalls({
        done: true,
        done_reason: 'stop',
        message: { tool_calls: [call('ollama-object', { envelope: typedUIFixture() })] },
      })
    ).toMatchObject({ ok: true, calls: [{ toolCallId: 'ollama-object' }] });
    expect(
      extractOllamaCompletedTypedUIPublishCalls({
        done: true,
        done_reason: 'stop',
        message: { tool_calls: [{ function: { name: 'eve_typed_ui_publish', arguments: args() } }] },
      })
    ).toMatchObject({ ok: false, reason: 'tool_call_id_missing' });
  });

  it('reports one immutable Main input per call and swallows persistence failure without mock success', () => {
    const report = vi.fn<(input: MainOwnedTypedUIProviderCompletionInput) => void>();
    const extraction = extractOpenAICompletedTypedUIPublishCalls(openAIResponse([call()]));
    expect(
      reportCapturedTypedUIProviderCompletions(extraction, {
        sessionId: 'session-1',
        provider: 'actual-provider',
        model: 'actual-model',
        providerRequestId: 'provider-request-1',
        route: 'connected',
        seatId: 'seat-1',
        seatContextRevision: 9,
        terminal: 'openai_json',
        report,
        now: () => new Date('2026-08-11T12:00:00.000Z'),
      })
    ).toBe(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        provider: 'actual-provider',
        model: 'actual-model',
        tool_call_id: 'call-typed-1',
        seat_context_revision: 9,
        route_receipt: expect.objectContaining({ status: 'completed', terminal: 'openai_json', http_status: 200 }),
      })
    );

    const failing = vi.fn(() => {
      throw new Error('disk unavailable');
    });
    expect(
      reportCapturedTypedUIProviderCompletions(extraction, {
        sessionId: 'session-1',
        provider: 'actual-provider',
        model: 'actual-model',
        providerRequestId: 'provider-request-1',
        route: 'connected',
        seatId: 'seat-1',
        seatContextRevision: 9,
        terminal: 'openai_json',
        report: failing,
      })
    ).toBe(0);
  });

  it('refuses to report without a valid immutable seat snapshot', () => {
    const report = vi.fn<(input: MainOwnedTypedUIProviderCompletionInput) => void>();
    const extraction = extractOpenAICompletedTypedUIPublishCalls(openAIResponse([call()]));
    expect(
      reportCapturedTypedUIProviderCompletions(extraction, {
        sessionId: 'session-1',
        provider: 'actual-provider',
        model: 'actual-model',
        providerRequestId: 'provider-request-1',
        route: 'connected',
        seatId: '',
        seatContextRevision: -1,
        terminal: 'openai_json',
        report,
      })
    ).toBe(0);
    expect(report).not.toHaveBeenCalled();
  });
});
