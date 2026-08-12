/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import {
  COMMAND_EVE_MANAGED_VISUAL_TURN_VERSION,
  commandEveManagedVisualTurnMarker,
  extractCommandEveManagedVisualTurnToken,
  type CommandEveManagedVisualTurnAuthorizationRequest,
  type CommandEveManagedVisualTurnAuthorizationResult,
  type CommandEveManagedVisualTurnTier,
} from '@/common/config/eveManagedVisualTurnCore';

const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const MAX_AUTHORIZATIONS = 64;
const MAX_REQUESTS_PER_AUTHORIZATION = 16;

type AuthorizationRecord = {
  seatId: string;
  seatContextRevision: number;
  flowId: string;
  receiptId: string;
  tier: CommandEveManagedVisualTurnTier;
  expiresAtMs: number;
  boundSessionId?: string;
  lastMessageDigests?: string[];
  requestCount: number;
};

export type CommandEveManagedVisualAuthorizationFailureReason =
  | 'AUTHORIZATION_EXPIRED'
  | 'AUTHORIZATION_SEAT_MISMATCH'
  | 'AUTHORIZATION_UNKNOWN'
  | 'AUTHORIZATION_REPLAY'
  | 'AUTHORIZATION_SESSION_REQUIRED'
  | 'AUTHORIZATION_SESSION_MISMATCH'
  | 'AUTHORIZATION_CONTINUATION_INVALID'
  | 'AUTHORIZATION_CHAIN_LIMIT';

export type CommandEveManagedVisualTurnResolution =
  | { status: 'absent' }
  | {
      status: 'authorized';
      tier: CommandEveManagedVisualTurnTier;
      visualPolicyClaim: {
        seatId: string;
        seatContextRevision: number;
        flowId: string;
        receiptId: string;
      };
    }
  | {
      status: 'invalid';
      reason_code: CommandEveManagedVisualAuthorizationFailureReason;
    };

const authorizations = new Map<string, AuthorizationRecord>();

function pruneAuthorizations(nowMs: number): void {
  for (const [token, record] of authorizations) {
    if (record.expiresAtMs <= nowMs) authorizations.delete(token);
  }
  while (authorizations.size >= MAX_AUTHORIZATIONS) {
    const oldest = authorizations.keys().next().value;
    if (typeof oldest !== 'string') break;
    authorizations.delete(oldest);
  }
}

function messageContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const value = (part as Record<string, unknown>).text;
      return typeof value === 'string' ? value : '';
    })
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function latestUserTurn(body: Record<string, unknown>):
  | {
      index: number;
      messages: Record<string, unknown>[];
      text?: string;
    }
  | undefined {
  if (!Array.isArray(body.messages)) return undefined;
  const messages = body.messages.map((message) =>
    message && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>) : {}
  );
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    // Stop at the latest user turn even when it has no text. Looking farther
    // back would replay a one-turn authorization from an older visual request.
    return { index, messages, text: messageContentText(record.content) };
  }
  return undefined;
}

function requestSessionId(body: Record<string, unknown>): string | undefined {
  const value = body.session_id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function messageDigests(messages: Record<string, unknown>[]): string[] {
  return messages.map((message) => crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex'));
}

function extendsAuthorizedMessageChain(previous: string[], current: string[]): boolean {
  return current.length > previous.length && previous.every((digest, index) => current[index] === digest);
}

function validToolContinuation(messages: Record<string, unknown>[], userIndex: number): boolean {
  let cursor = userIndex + 1;
  if (cursor >= messages.length) return false;

  while (cursor < messages.length) {
    const assistant = messages[cursor];
    if (assistant?.role !== 'assistant' || !Array.isArray(assistant.tool_calls) || assistant.tool_calls.length === 0) {
      return false;
    }
    const expectedIds = new Set<string>();
    for (const value of assistant.tool_calls) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const id = (value as Record<string, unknown>).id;
      if (typeof id !== 'string' || !id || expectedIds.has(id)) return false;
      expectedIds.add(id);
    }

    cursor += 1;
    const resolvedIds = new Set<string>();
    while (cursor < messages.length && messages[cursor]?.role === 'tool') {
      const toolCallId = messages[cursor].tool_call_id;
      if (typeof toolCallId !== 'string' || !expectedIds.has(toolCallId) || resolvedIds.has(toolCallId)) return false;
      resolvedIds.add(toolCallId);
      cursor += 1;
    }
    if (resolvedIds.size !== expectedIds.size) return false;
  }
  return true;
}

export function authorizeCommandEveManagedVisualTurn(input: {
  request?: CommandEveManagedVisualTurnAuthorizationRequest;
  seatId: string;
  seatContextRevision: number;
  verifiedReceipt?: {
    seatId: string;
    seatContextRevision: number;
    flowId: string;
    receiptId: string;
  };
  hasPaidSeat: boolean;
  hasLicenseWire: boolean;
  retireVerifiedReceipt: () => boolean;
  nowMs?: number;
  randomToken?: () => string;
}): CommandEveManagedVisualTurnAuthorizationResult {
  const request = input.request;
  const failure = (reasonCode: string, message: string): CommandEveManagedVisualTurnAuthorizationResult => ({
    version: COMMAND_EVE_MANAGED_VISUAL_TURN_VERSION,
    ok: false,
    reason_code: reasonCode,
    message,
  });

  const verifiedReceipt = input.verifiedReceipt;
  if (
    !request?.flowId ||
    !request.visualPolicyReceipt ||
    !verifiedReceipt ||
    verifiedReceipt.flowId !== request.flowId ||
    verifiedReceipt.receiptId !== request.visualPolicyReceipt.receiptId ||
    verifiedReceipt.seatId !== input.seatId ||
    verifiedReceipt.seatContextRevision !== input.seatContextRevision
  ) {
    return failure(
      'EVE_MANAGED_VISUAL_POLICY_RECEIPT_REQUIRED',
      'Managed visual analysis requires a fresh seat-bound visual-policy receipt.'
    );
  }
  if (!Number.isInteger(request.sourceCount) || request.sourceCount < 1 || request.sourceCount > 6) {
    return failure('EVE_MANAGED_VISUAL_BAD_SOURCE_COUNT', 'Select between one and six visual files per turn.');
  }
  if (!input.hasLicenseWire) {
    return failure('EVE_MANAGED_VISUAL_NO_BEARER', 'Managed visual analysis requires an active Command EVE license.');
  }
  if (!input.seatId.trim()) {
    return failure('EVE_MANAGED_VISUAL_NO_SEAT', 'Managed visual analysis could not resolve the active seat.');
  }

  const tier: CommandEveManagedVisualTurnTier = input.hasPaidSeat ? request.preferredTier || 'high' : 'standard';
  const nowMs = input.nowMs ?? Date.now();
  pruneAuthorizations(nowMs);
  const token = input.randomToken?.() ?? crypto.randomBytes(32).toString('base64url');
  let marker: string;
  try {
    marker = commandEveManagedVisualTurnMarker(token);
  } catch {
    return failure('EVE_MANAGED_VISUAL_TOKEN_INVALID', 'Managed visual analysis could not create an authorization.');
  }
  if (!input.retireVerifiedReceipt()) {
    return failure(
      'EVE_MANAGED_VISUAL_POLICY_RECEIPT_REQUIRED',
      'Managed visual analysis requires a fresh seat-bound visual-policy receipt.'
    );
  }
  const expiresAtMs = nowMs + AUTHORIZATION_TTL_MS;
  authorizations.set(token, {
    seatId: input.seatId,
    seatContextRevision: input.seatContextRevision,
    flowId: verifiedReceipt.flowId,
    receiptId: verifiedReceipt.receiptId,
    tier,
    expiresAtMs,
    requestCount: 0,
  });
  return {
    version: COMMAND_EVE_MANAGED_VISUAL_TURN_VERSION,
    ok: true,
    marker,
    tier,
    expires_at: new Date(expiresAtMs).toISOString(),
  };
}

export function resolveCommandEveManagedVisualTurn(
  body: Record<string, unknown> | undefined,
  seatId: string,
  seatContextRevision: number,
  nowMs = Date.now()
): CommandEveManagedVisualTurnResolution {
  const latestTurn = body ? latestUserTurn(body) : undefined;
  const token = extractCommandEveManagedVisualTurnToken(latestTurn?.text);
  if (!token) return { status: 'absent' };
  const record = authorizations.get(token);
  if (!record) return { status: 'invalid', reason_code: 'AUTHORIZATION_UNKNOWN' };
  if (record.expiresAtMs <= nowMs) {
    authorizations.delete(token);
    return { status: 'invalid', reason_code: 'AUTHORIZATION_EXPIRED' };
  }
  if (record.seatId !== seatId || record.seatContextRevision !== seatContextRevision) {
    return { status: 'invalid', reason_code: 'AUTHORIZATION_SEAT_MISMATCH' };
  }
  if (!body || !latestTurn) return { status: 'invalid', reason_code: 'AUTHORIZATION_CONTINUATION_INVALID' };

  const sessionId = requestSessionId(body);
  if (!sessionId) return { status: 'invalid', reason_code: 'AUTHORIZATION_SESSION_REQUIRED' };
  // Hermes may compact older conversation history between tool rounds. Bind
  // only the marked visual turn and its appended tool chain; that preserves
  // native compaction while preventing forks or rewrites of the authorized turn.
  const currentMessageDigests = messageDigests(latestTurn.messages.slice(latestTurn.index));

  if (record.requestCount === 0) {
    if (latestTurn.index !== latestTurn.messages.length - 1) {
      return { status: 'invalid', reason_code: 'AUTHORIZATION_CONTINUATION_INVALID' };
    }
    record.boundSessionId = sessionId;
  } else {
    if (!record.boundSessionId || record.boundSessionId !== sessionId) {
      return { status: 'invalid', reason_code: 'AUTHORIZATION_SESSION_MISMATCH' };
    }
    const previousMessageDigests = record.lastMessageDigests;
    if (!previousMessageDigests) {
      return { status: 'invalid', reason_code: 'AUTHORIZATION_CONTINUATION_INVALID' };
    }
    if (
      currentMessageDigests.length === previousMessageDigests.length &&
      previousMessageDigests.every((digest, index) => currentMessageDigests[index] === digest)
    ) {
      return { status: 'invalid', reason_code: 'AUTHORIZATION_REPLAY' };
    }
    if (!extendsAuthorizedMessageChain(previousMessageDigests, currentMessageDigests)) {
      return { status: 'invalid', reason_code: 'AUTHORIZATION_CONTINUATION_INVALID' };
    }
    if (!validToolContinuation(latestTurn.messages, latestTurn.index)) {
      return { status: 'invalid', reason_code: 'AUTHORIZATION_CONTINUATION_INVALID' };
    }
  }

  if (record.requestCount >= MAX_REQUESTS_PER_AUTHORIZATION) {
    return { status: 'invalid', reason_code: 'AUTHORIZATION_CHAIN_LIMIT' };
  }
  // A visual user turn may require several native Hermes requests (for example
  // one tool call plus its result continuation). Bind those requests to one ACP
  // session and authorize each exact message chain once. Identical retries and
  // cross-session replays remain fail-closed before any provider egress.
  record.lastMessageDigests = currentMessageDigests;
  record.requestCount += 1;
  return {
    status: 'authorized',
    tier: record.tier,
    visualPolicyClaim: {
      seatId: record.seatId,
      seatContextRevision: record.seatContextRevision,
      flowId: record.flowId,
      receiptId: record.receiptId,
    },
  };
}

export function clearCommandEveManagedVisualTurnAuthorizationsForTests(): void {
  authorizations.clear();
}
