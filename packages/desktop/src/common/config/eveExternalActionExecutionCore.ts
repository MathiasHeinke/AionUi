/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isEveExternalActionKind,
  isEveOpaqueId,
  isEveSha256Digest,
  normalizeEveExternalOrigin,
  type EveExternalActionKind,
  type EveExternalExecutionStatus,
} from './eveExternalActionPolicyCore';

export const EVE_EXTERNAL_ACTION_PROPOSAL_VERSION = 'command-eve-external-action-proposal/v1' as const;
export const EVE_EXTERNAL_ACTION_EXECUTION_VERSION = 'command-eve-external-action-execution/v1' as const;

export interface EveExternalActionProposal {
  version: typeof EVE_EXTERNAL_ACTION_PROPOSAL_VERSION;
  clientRequestId: string;
  idempotencyKey: string;
  action: {
    kind: EveExternalActionKind;
    targetOrigin: string;
    argumentsDigest: string;
    quoteDigest?: string;
    amount: { currency: string; minorUnits: number };
  };
  oauthHandleId?: string;
  passwordHandleId?: string;
}

export interface EveExternalActionExecutionResult {
  version: typeof EVE_EXTERNAL_ACTION_EXECUTION_VERSION;
  status: EveExternalExecutionStatus;
  reasonCode?: string;
  reservationId?: string;
  replay?: boolean;
  authMode?: 'oauth' | 'browser_session' | 'password' | 'none';
}

export type EveExternalActionProposalValidation =
  | { ok: true; value: EveExternalActionProposal }
  | { ok: false; reasonCode: string };

const MONEY_ACTIONS = new Set<EveExternalActionKind>(['purchase', 'recurring_payment']);

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

/** Strict parser for the only renderer/model-visible execution request. */
export function validateEveExternalActionProposal(input: unknown): EveExternalActionProposalValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_INVALID' };
  }
  const record = input as Record<string, unknown>;
  if (
    !exactKeys(
      record,
      ['version', 'clientRequestId', 'idempotencyKey', 'action'],
      ['oauthHandleId', 'passwordHandleId']
    )
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_FIELDS_INVALID' };
  }
  if (
    record.version !== EVE_EXTERNAL_ACTION_PROPOSAL_VERSION ||
    !isEveOpaqueId(record.clientRequestId) ||
    !isEveOpaqueId(record.idempotencyKey)
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_ID_INVALID' };
  }
  if (!record.action || typeof record.action !== 'object' || Array.isArray(record.action)) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_ACTION_INVALID' };
  }
  const action = record.action as Record<string, unknown>;
  if (!exactKeys(action, ['kind', 'targetOrigin', 'argumentsDigest', 'amount'], ['quoteDigest'])) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_ACTION_FIELDS_INVALID' };
  }
  const kind = action.kind;
  const targetOrigin = normalizeEveExternalOrigin(action.targetOrigin);
  if (!isEveExternalActionKind(kind) || !targetOrigin || !isEveSha256Digest(action.argumentsDigest)) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_ACTION_INVALID' };
  }
  if (!action.amount || typeof action.amount !== 'object' || Array.isArray(action.amount)) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_AMOUNT_INVALID' };
  }
  const amount = action.amount as Record<string, unknown>;
  if (!exactKeys(amount, ['currency', 'minorUnits'])) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_AMOUNT_INVALID' };
  }
  if (
    typeof amount.currency !== 'string' ||
    !/^(?:[A-Z]{3}|NONE)$/.test(amount.currency) ||
    !Number.isSafeInteger(amount.minorUnits) ||
    (amount.minorUnits as number) < 0
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_AMOUNT_INVALID' };
  }
  const money = MONEY_ACTIONS.has(kind);
  if (
    (money &&
      ((amount.minorUnits as number) <= 0 ||
        !/^[A-Z]{3}$/.test(amount.currency) ||
        !isEveSha256Digest(action.quoteDigest))) ||
    (!money && (amount.minorUnits !== 0 || amount.currency !== 'NONE' || action.quoteDigest !== undefined))
  ) {
    return { ok: false, reasonCode: money ? 'EXTERNAL_PROPOSAL_QUOTE_REQUIRED' : 'EXTERNAL_PROPOSAL_AMOUNT_FORBIDDEN' };
  }
  for (const key of ['oauthHandleId', 'passwordHandleId'] as const) {
    const value = record[key];
    if (value !== undefined && !isEveOpaqueId(value)) {
      return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_HANDLE_INVALID' };
    }
  }
  return {
    ok: true,
    value: {
      version: EVE_EXTERNAL_ACTION_PROPOSAL_VERSION,
      clientRequestId: record.clientRequestId as string,
      idempotencyKey: record.idempotencyKey as string,
      action: {
        kind,
        targetOrigin,
        argumentsDigest: action.argumentsDigest as string,
        ...(action.quoteDigest ? { quoteDigest: action.quoteDigest as string } : {}),
        amount: { currency: amount.currency, minorUnits: amount.minorUnits as number },
      },
      ...(record.oauthHandleId ? { oauthHandleId: record.oauthHandleId as string } : {}),
      ...(record.passwordHandleId ? { passwordHandleId: record.passwordHandleId as string } : {}),
    },
  };
}
