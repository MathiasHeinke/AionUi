/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { TYPED_UI_PUBLISH_TOOL_NAME, validateTypedUIEnvelope, type TypedUIEnvelope } from '@/common/typedUI';
import crypto from 'node:crypto';
import {
  hashTypedUIEnvelope,
  TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
  type MainOwnedTypedUIProviderCompletionInput,
} from './typedUIProvenanceAttestationCore';

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 640 * 1024;
const MAX_TOOL_CALLS = 50;
const ALLOWED_FINISH_REASONS = new Set(['stop', 'tool_calls']);

type RecordValue = Record<string, unknown>;

export type CapturedTypedUIPublishCall = {
  toolCallId: string;
  envelope: TypedUIEnvelope;
  rawContentSha256: string;
};

export type TypedUIPublishExtractionResult =
  | { ok: true; calls: CapturedTypedUIPublishCall[] }
  | { ok: false; reason: string };

export type TypedUIProviderCompletionContext = {
  sessionId: unknown;
  provider: string;
  model: string;
  providerRequestId: string;
  route: string;
  seatId: string;
  seatContextRevision: number;
  terminal: MainOwnedTypedUIProviderCompletionInput['route_receipt']['terminal'];
  report: (input: MainOwnedTypedUIProviderCompletionInput) => void;
  now?: () => Date;
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(
    (key) => allowed.has(key) && !['__proto__', 'prototype', 'constructor'].includes(key)
  );
}

function parseArguments(value: unknown, allowObject: boolean): TypedUIPublishExtractionResult {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_ARGUMENT_BYTES) return { ok: false, reason: 'arguments_too_large' };
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return { ok: false, reason: 'arguments_invalid_json' };
    }
  } else if (!allowObject) {
    return { ok: false, reason: 'arguments_not_string' };
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ['envelope'])) return { ok: false, reason: 'arguments_invalid_shape' };
  const validation = validateTypedUIEnvelope(parsed.envelope);
  if (!validation.ok) return { ok: false, reason: 'envelope_invalid' };
  return {
    ok: true,
    calls: [
      {
        toolCallId: '',
        envelope: validation.value,
        rawContentSha256: hashTypedUIEnvelope(validation.value),
      },
    ],
  };
}

function parseToolCalls(value: unknown, allowObjectArguments: boolean): TypedUIPublishExtractionResult {
  if (value === undefined) return { ok: true, calls: [] };
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) return { ok: false, reason: 'tool_calls_invalid' };
  const calls: CapturedTypedUIPublishCall[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.function)) return { ok: false, reason: 'tool_call_invalid' };
    const name = item.function.name;
    if (name !== TYPED_UI_PUBLISH_TOOL_NAME) continue;
    const toolCallId = item.id;
    if (typeof toolCallId !== 'string' || !toolCallId) return { ok: false, reason: 'tool_call_id_missing' };
    if (seen.has(toolCallId)) return { ok: false, reason: 'tool_call_id_duplicate' };
    const parsed = parseArguments(item.function.arguments, allowObjectArguments);
    if (!parsed.ok) return parsed;
    seen.add(toolCallId);
    calls.push({ ...parsed.calls[0], toolCallId });
  }
  return { ok: true, calls };
}

export function extractOpenAICompletedTypedUIPublishCalls(value: unknown): TypedUIPublishExtractionResult {
  if (!isRecord(value) || !Array.isArray(value.choices)) return { ok: false, reason: 'response_invalid' };
  const choice = value.choices.find((candidate) => isRecord(candidate) && candidate.index === 0);
  if (!isRecord(choice) || !ALLOWED_FINISH_REASONS.has(String(choice.finish_reason))) {
    return { ok: false, reason: 'response_not_terminal' };
  }
  if (!isRecord(choice.message)) return { ok: false, reason: 'message_invalid' };
  return parseToolCalls(choice.message.tool_calls, false);
}

type StreamToolCall = { id: string; name: string; arguments: string };

function appendFragment(current: string, fragment: unknown): string | undefined {
  if (fragment === undefined) return current;
  if (typeof fragment !== 'string') return undefined;
  return `${current}${fragment}`;
}

function parseOpenAISseTranscript(text: string): TypedUIPublishExtractionResult {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const events = normalized.split('\n\n');
  const tools = new Map<number, StreamToolCall>();
  let sawDone = false;
  let sawTerminal = false;
  let finishReason = '';
  for (const event of events) {
    if (!event.trim()) continue;
    const dataLines = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (sawDone) return { ok: false, reason: 'sse_data_after_done' };
    if (data === '[DONE]') {
      if (!sawTerminal) return { ok: false, reason: 'sse_done_before_terminal' };
      sawDone = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return { ok: false, reason: 'sse_event_invalid_json' };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return { ok: false, reason: 'sse_event_invalid' };
    const choice = parsed.choices.find((candidate) => isRecord(candidate) && candidate.index === 0);
    if (!isRecord(choice)) continue;
    if (sawTerminal) return { ok: false, reason: 'sse_data_after_terminal' };
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      const next = String(choice.finish_reason);
      if (finishReason && finishReason !== next) return { ok: false, reason: 'sse_finish_conflict' };
      finishReason = next;
      sawTerminal = true;
    }
    if (!isRecord(choice.delta) || choice.delta.tool_calls === undefined) continue;
    if (!Array.isArray(choice.delta.tool_calls) || choice.delta.tool_calls.length > MAX_TOOL_CALLS) {
      return { ok: false, reason: 'sse_tool_calls_invalid' };
    }
    for (const fragment of choice.delta.tool_calls) {
      if (!isRecord(fragment) || !Number.isSafeInteger(fragment.index)) {
        return { ok: false, reason: 'sse_tool_index_invalid' };
      }
      const index = Number(fragment.index);
      if (index < 0 || index >= MAX_TOOL_CALLS) return { ok: false, reason: 'sse_tool_index_invalid' };
      const current = tools.get(index) || { id: '', name: '', arguments: '' };
      const id = appendFragment(current.id, fragment.id);
      const fn = fragment.function;
      if (fn !== undefined && !isRecord(fn)) return { ok: false, reason: 'sse_function_invalid' };
      const name = appendFragment(current.name, isRecord(fn) ? fn.name : undefined);
      const args = appendFragment(current.arguments, isRecord(fn) ? fn.arguments : undefined);
      if (id === undefined || name === undefined || args === undefined) {
        return { ok: false, reason: 'sse_fragment_invalid' };
      }
      if (Buffer.byteLength(args, 'utf8') > MAX_ARGUMENT_BYTES) {
        return { ok: false, reason: 'arguments_too_large' };
      }
      tools.set(index, { id, name, arguments: args });
    }
  }
  if (!sawDone || !ALLOWED_FINISH_REASONS.has(finishReason)) return { ok: false, reason: 'sse_not_terminal' };
  return parseToolCalls(
    [...tools.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([, call]) => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })),
    false
  );
}

class BoundedUtf8Capture {
  private readonly decoder = new TextDecoder();
  private text = '';
  private bytes = 0;
  private overflowed = false;

  push(value: Uint8Array): void {
    this.bytes += value.byteLength;
    if (this.bytes > MAX_CAPTURE_BYTES) {
      this.overflowed = true;
      return;
    }
    this.text += this.decoder.decode(value, { stream: true });
  }

  finish(): string | undefined {
    if (this.overflowed) return undefined;
    this.text += this.decoder.decode();
    return this.text;
  }
}

export class OpenAITypedUIPublishSseCapture {
  private readonly capture = new BoundedUtf8Capture();

  push(value: Uint8Array): void {
    this.capture.push(value);
  }

  finish(): TypedUIPublishExtractionResult {
    const text = this.capture.finish();
    return text === undefined ? { ok: false, reason: 'stream_too_large' } : parseOpenAISseTranscript(text);
  }
}

export function extractOllamaCompletedTypedUIPublishCalls(value: unknown): TypedUIPublishExtractionResult {
  if (!isRecord(value) || value.done !== true || value.done_reason === 'length' || !isRecord(value.message)) {
    return { ok: false, reason: 'response_not_terminal' };
  }
  return parseToolCalls(value.message.tool_calls, true);
}

export class OllamaTypedUIPublishJsonlCapture {
  private readonly capture = new BoundedUtf8Capture();

  push(value: Uint8Array): void {
    this.capture.push(value);
  }

  finish(): TypedUIPublishExtractionResult {
    const text = this.capture.finish();
    if (text === undefined) return { ok: false, reason: 'stream_too_large' };
    const calls: unknown[] = [];
    let terminal: RecordValue | undefined;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (terminal) return { ok: false, reason: 'jsonl_data_after_terminal' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        return { ok: false, reason: 'jsonl_invalid' };
      }
      if (!isRecord(parsed)) return { ok: false, reason: 'jsonl_invalid' };
      if (isRecord(parsed.message) && Array.isArray(parsed.message.tool_calls))
        calls.push(...parsed.message.tool_calls);
      if (parsed.done === true) terminal = parsed;
    }
    if (!terminal || terminal.done_reason === 'length') return { ok: false, reason: 'jsonl_not_terminal' };
    return parseToolCalls(calls, true);
  }
}

export function reportCapturedTypedUIProviderCompletions(
  extraction: TypedUIPublishExtractionResult,
  context: TypedUIProviderCompletionContext
): number {
  if (
    !extraction.ok ||
    extraction.calls.length === 0 ||
    !context.seatId ||
    !Number.isSafeInteger(context.seatContextRevision) ||
    context.seatContextRevision < 0
  ) {
    return 0;
  }
  let recorded = 0;
  for (const call of extraction.calls) {
    try {
      context.report({
        version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
        session_id: typeof context.sessionId === 'string' ? context.sessionId : '',
        provider: context.provider,
        model: context.model,
        provider_request_id: context.providerRequestId,
        tool_call_id: call.toolCallId,
        raw_content_sha256: call.rawContentSha256,
        route_receipt: {
          receipt_id: `tuiroute-${crypto.randomUUID()}`,
          route: context.route,
          status: 'completed',
          terminal: context.terminal,
          http_status: 200,
        },
        seat_id: context.seatId,
        seat_context_revision: context.seatContextRevision,
        completed_at: (context.now || (() => new Date()))().toISOString(),
      });
      recorded += 1;
    } catch {
      // Receipt persistence is fail-closed for Typed UI but must not corrupt an
      // otherwise valid chat completion. No model/provider content is logged.
    }
  }
  return recorded;
}

export function newTypedUIProviderRequestId(): string {
  return `tuirequest-${crypto.randomUUID()}`;
}
