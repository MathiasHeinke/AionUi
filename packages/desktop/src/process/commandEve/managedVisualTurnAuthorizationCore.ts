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

type AuthorizationRecord = {
  seatId: string;
  seatContextRevision: number;
  flowId: string;
  receiptId: string;
  tier: CommandEveManagedVisualTurnTier;
  expiresAtMs: number;
};

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
      reason_code: 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_SEAT_MISMATCH' | 'AUTHORIZATION_UNKNOWN';
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

function latestUserText(body: Record<string, unknown>): string | undefined {
  if (!Array.isArray(body.messages)) return undefined;
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'user') continue;
    // Stop at the latest user turn even when it has no text. Looking farther
    // back would replay a one-turn authorization from an older visual request.
    return messageContentText(record.content);
  }
  return undefined;
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
  const token = extractCommandEveManagedVisualTurnToken(body ? latestUserText(body) : undefined);
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
  // One consent marker authorizes exactly one upstream request. Delete before
  // returning so retries/replays cannot silently spend again; a failed request
  // must obtain a fresh, user-visible authorization.
  authorizations.delete(token);
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
