/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isEveExternalActionKind,
  eveSecretSlotAllowsHandleType,
  isEveOpaqueId,
  isEveSecretFieldSlot,
  isEveSecretHandleType,
  isEveSha256Digest,
  normalizeEveExternalOrigin,
  type EveExternalActionKind,
  type EveExternalExecutionStatus,
  type EveSecretFieldSlot,
  type EveSecretHandleType,
} from './eveExternalActionPolicyCore';

export const EVE_EXTERNAL_ACTION_PROPOSAL_VERSION = 'command-eve-external-action-proposal/v1' as const;
export const EVE_EXTERNAL_ACTION_EXECUTION_VERSION = 'command-eve-external-action-execution/v1' as const;
export const EVE_EXTERNAL_ACTION_RESUME_VERSION = 'command-eve-external-action-resume/v1' as const;
export const EVE_EXTERNAL_ACTION_RECEIPT_VERSION = 'command-eve-agent-external-action-receipt/v0' as const;
export const EVE_EXTERNAL_ACTION_EVENT_RECEIPT_VERSION = 'command-eve-agent-external-action-event-receipt/v0' as const;
export const EVE_EXTERNAL_ACTION_WORKBENCH_VERSION = 'command-eve-external-action-workbench-card/v0' as const;

export const EVE_EXTERNAL_ACTION_CHALLENGE_KINDS = [
  'oauth_consent',
  '3ds',
  'mfa',
  'passkey',
  'captcha',
  'provider_risk_review',
] as const;
export type EveExternalActionChallengeKind = (typeof EVE_EXTERNAL_ACTION_CHALLENGE_KINDS)[number];

export const EVE_EXTERNAL_ACTION_REASON_CODES = [
  'AUTHORITY_DENIED',
  'BINDING_MISMATCH',
  'CLAIM_MISMATCH',
  'CONTRACT_CHANGED',
  'EXPIRED',
  'ORIGIN_MISMATCH',
  'POLICY_DENIED',
  'REVOKED',
  'SANITIZATION_FAILED',
  'UNKNOWN_EXTERNAL_EFFECT',
  'USER_CANCELLED',
] as const;
export type EveExternalActionReasonCode = (typeof EVE_EXTERNAL_ACTION_REASON_CODES)[number];

export const EVE_EXTERNAL_ACTION_NEEDS_USER_INSTRUCTION_CODES = [
  'COMPLETE_OAUTH_CONSENT',
  'COMPLETE_3DS',
  'COMPLETE_MFA',
  'COMPLETE_PASSKEY',
  'COMPLETE_CAPTCHA',
  'CONTACT_PROVIDER_FOR_REVIEW',
] as const;
export type EveExternalActionNeedsUserInstructionCode =
  (typeof EVE_EXTERNAL_ACTION_NEEDS_USER_INSTRUCTION_CODES)[number];

export interface EveExternalActionChallenge {
  kind: EveExternalActionChallengeKind;
  challengeRef: string;
  origin: string;
  expiresAt: string;
  userInstructionCode: EveExternalActionNeedsUserInstructionCode;
}

export type EveExternalAdapterDomain = 'generic' | 'email_identity' | 'phone_identity' | 'commerce';
export type EveExternalActionAuthMode = 'oauth' | 'password' | 'otp' | 'payment_fields' | 'session' | 'none';
export const EVE_EXTERNAL_ACTION_PROVIDER_LABEL_CODES = [
  'external_provider',
  'external_email_provider',
  'external_phone_provider',
  'external_merchant',
  'fixture_mail',
  'fixture_sms',
  'fixture_merchant',
  'fixture_oauth',
  'fixture_3ds',
] as const;
export type EveExternalActionProviderMerchantLabelCode =
  (typeof EVE_EXTERNAL_ACTION_PROVIDER_LABEL_CODES)[number];
export type EveExternalActionOrigins =
  | readonly [providerOrigin: string]
  | readonly [merchantOrigin: string, checkoutOrigin: string];

export interface EveExternalActionSlotBinding {
  slot: EveSecretFieldSlot;
  handleId: string;
  handleType: EveSecretHandleType;
}

export interface EveExternalActionProposal {
  version: typeof EVE_EXTERNAL_ACTION_PROPOSAL_VERSION;
  clientRequestId: string;
  idempotencyKey: string;
  action: {
    kind: EveExternalActionKind;
    targetOrigin: string;
    argumentsDigest: string;
    quoteDigest?: string;
    adapterPayloadRef?: string;
    adapterPayloadDigest?: string;
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
  authMode?: EveExternalActionAuthMode;
  eventReceipt?: EveExternalActionEventReceiptV0;
  retryAllowed?: boolean;
  receipt?: EveExternalActionReceiptV0;
  workbenchCard?: EveExternalActionWorkbenchCardV0;
}

interface EveExternalActionEventReceiptBaseV0 {
  version: typeof EVE_EXTERNAL_ACTION_EVENT_RECEIPT_VERSION;
  event: 'needs_user';
  eventRef: string;
  operationRef: string;
  reservationRef: string;
  authMode: EveExternalActionAuthMode;
  accountRef: string;
  seedRef: string;
  challengeKind: EveExternalActionChallengeKind;
  challengeRef: string;
  instructionCode: string;
  challengeOrigin: string;
  resumeRef: string;
  expiresAt: string;
  occurredAt: string;
}

type EveExternalActionEventReceiptDomainV0 =
  | { domain: 'generic'; action: string; origins: readonly [string] }
  | {
      domain: 'email_identity';
      action: 'provision' | 'link' | 'verify' | 'send' | 'receive' | 'revoke';
      origins: readonly [string];
    }
  | {
      domain: 'phone_identity';
      action: 'provision' | 'link' | 'otp_receive' | 'otp_use' | 'sms_send' | 'sms_receive' | 'revoke';
      origins: readonly [string];
    }
  | { domain: 'commerce'; action: 'purchase'; origins: readonly [string, string] };

export type EveExternalActionEventReceiptV0 = EveExternalActionEventReceiptBaseV0 &
  EveExternalActionEventReceiptDomainV0;

export type EveExternalActionSanitizedResult =
  | { domain: 'generic'; action: string; resultRef: string }
  | { domain: 'email_identity'; action: 'provision' | 'link' | 'verify'; identityRef: string }
  | {
      domain: 'email_identity';
      action: 'send';
      messageRef: string;
      providerReceiptDigest: string;
    }
  | {
      domain: 'email_identity';
      action: 'receive';
      messageRefs: readonly string[];
      cursorRef: string;
    }
  | { domain: 'email_identity'; action: 'revoke'; revocationRef: string }
  | { domain: 'phone_identity'; action: 'provision' | 'link'; identityRef: string }
  | { domain: 'phone_identity'; action: 'otp_receive'; otpHandleRef: string }
  | { domain: 'phone_identity'; action: 'otp_use'; challengeReceiptRef: string }
  | {
      domain: 'phone_identity';
      action: 'sms_send';
      messageRef: string;
      providerReceiptDigest: string;
    }
  | {
      domain: 'phone_identity';
      action: 'sms_receive';
      messageRefs: readonly string[];
      cursorRef: string;
    }
  | { domain: 'phone_identity'; action: 'revoke'; revocationRef: string }
  | {
      domain: 'commerce';
      action: 'purchase';
      purchaseRef: string;
      productDigest: string;
      amount: { currency: string; minorUnits: number };
      providerReceiptDigest: string;
    };

function isLuhnCandidate(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Opaque public references may not masquerade as common secret/plaintext shapes. */
export function isEveSanitizedOpaqueRef(input: unknown): input is string {
  if (!isEveOpaqueId(input)) return false;
  const value = input as string;
  const lower = value.toLowerCase();
  return !(
    value.includes('@') ||
    /^\d{6,19}$/.test(value) ||
    /^(?:phone|tel|mobile|card|pan|password|passwd|secret|cookie|bearer|authorization|recovery|otp):/i.test(value) ||
    /(?:^|[._:-])(?:password|passwd|secret|cookie|bearer|authorization|recovery[_-]?code|api[_-]?key|access[_-]?token|refresh[_-]?token)(?:$|[._:-])/i.test(
      value
    ) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
    lower.includes('synthetic-secret') ||
    isLuhnCandidate(value)
  );
}

export function validateEveExternalActionSanitizedResult(
  input: unknown,
  expected?: { domain: EveExternalAdapterDomain; action: string; amount?: { currency: string; minorUnits: number } }
): EveExternalActionSanitizedResult | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const domain = value.domain;
  const action = value.action;
  if (
    !['generic', 'email_identity', 'phone_identity', 'commerce'].includes(String(domain)) ||
    !isEveOpaqueId(action) ||
    (expected && (domain !== expected.domain || action !== expected.action))
  ) {
    return null;
  }
  const opaqueList = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.length <= 100 &&
    candidate.every(isEveSanitizedOpaqueRef) &&
    new Set(candidate).size === candidate.length;
  let valid = false;
  if (domain === 'generic')
    valid = exactKeys(value, ['domain', 'action', 'resultRef']) && isEveSanitizedOpaqueRef(value.resultRef);
  if (domain === 'email_identity' && ['provision', 'link', 'verify'].includes(String(action))) {
    valid = exactKeys(value, ['domain', 'action', 'identityRef']) && isEveSanitizedOpaqueRef(value.identityRef);
  }
  if (domain === 'email_identity' && action === 'send') {
    valid =
      exactKeys(value, ['domain', 'action', 'messageRef', 'providerReceiptDigest']) &&
      isEveSanitizedOpaqueRef(value.messageRef) &&
      isEveSha256Digest(value.providerReceiptDigest);
  }
  if (domain === 'email_identity' && action === 'receive') {
    valid =
      exactKeys(value, ['domain', 'action', 'messageRefs', 'cursorRef']) &&
      opaqueList(value.messageRefs) &&
      isEveSanitizedOpaqueRef(value.cursorRef);
  }
  if (domain === 'email_identity' && action === 'revoke') {
    valid = exactKeys(value, ['domain', 'action', 'revocationRef']) && isEveSanitizedOpaqueRef(value.revocationRef);
  }
  if (domain === 'phone_identity' && ['provision', 'link'].includes(String(action))) {
    valid = exactKeys(value, ['domain', 'action', 'identityRef']) && isEveSanitizedOpaqueRef(value.identityRef);
  }
  if (domain === 'phone_identity' && action === 'otp_receive') {
    valid = exactKeys(value, ['domain', 'action', 'otpHandleRef']) && isEveSanitizedOpaqueRef(value.otpHandleRef);
  }
  if (domain === 'phone_identity' && action === 'otp_use') {
    valid =
      exactKeys(value, ['domain', 'action', 'challengeReceiptRef']) &&
      isEveSanitizedOpaqueRef(value.challengeReceiptRef);
  }
  if (domain === 'phone_identity' && action === 'sms_send') {
    valid =
      exactKeys(value, ['domain', 'action', 'messageRef', 'providerReceiptDigest']) &&
      isEveSanitizedOpaqueRef(value.messageRef) &&
      isEveSha256Digest(value.providerReceiptDigest);
  }
  if (domain === 'phone_identity' && action === 'sms_receive') {
    valid =
      exactKeys(value, ['domain', 'action', 'messageRefs', 'cursorRef']) &&
      opaqueList(value.messageRefs) &&
      isEveSanitizedOpaqueRef(value.cursorRef);
  }
  if (domain === 'phone_identity' && action === 'revoke') {
    valid = exactKeys(value, ['domain', 'action', 'revocationRef']) && isEveSanitizedOpaqueRef(value.revocationRef);
  }
  if (domain === 'commerce' && action === 'purchase') {
    const amount = value.amount as Record<string, unknown> | undefined;
    valid =
      exactKeys(value, ['domain', 'action', 'purchaseRef', 'productDigest', 'amount', 'providerReceiptDigest']) &&
      isEveSanitizedOpaqueRef(value.purchaseRef) &&
      isEveSha256Digest(value.productDigest) &&
      isEveSha256Digest(value.providerReceiptDigest) &&
      Boolean(amount) &&
      exactKeys(amount!, ['currency', 'minorUnits']) &&
      typeof amount!.currency === 'string' &&
      /^[A-Z]{3}$/.test(amount!.currency as string) &&
      Number.isSafeInteger(amount!.minorUnits) &&
      (amount!.minorUnits as number) > 0 &&
      (!expected ||
        (expected.amount?.currency === amount!.currency && expected.amount.minorUnits === amount!.minorUnits));
  }
  return valid ? (input as EveExternalActionSanitizedResult) : null;
}

interface EveExternalActionReceiptBaseV0 {
  version: typeof EVE_EXTERNAL_ACTION_RECEIPT_VERSION;
  receiptRef: string;
  operationRef: string;
  reservationRef: string;
  authMode: EveExternalActionAuthMode;
  accountRef: string;
  seedRef: string;
  authorityReceiptDigest: string;
  policyRevision: number;
  providerOrMerchantId: string;
  occurredAt: string;
  retryAllowed: false;
}

type EveExternalActionReceiptDomainV0 =
  | {
      domain: 'generic';
      action: string;
      origins: readonly [string];
      amount?: { currency: string; minorUnits: number };
    }
  | {
      domain: 'email_identity';
      action: 'provision' | 'link' | 'verify' | 'send' | 'receive' | 'revoke';
      origins: readonly [string];
      amount?: never;
    }
  | {
      domain: 'phone_identity';
      action: 'provision' | 'link' | 'otp_receive' | 'otp_use' | 'sms_send' | 'sms_receive' | 'revoke';
      origins: readonly [string];
      amount?: never;
    }
  | {
      domain: 'commerce';
      action: 'purchase';
      origins: readonly [string, string];
      amount: { currency: string; minorUnits: number };
    };

type EveExternalActionReceiptStateV0 =
  | {
      outcome: 'committed';
      result: EveExternalActionSanitizedResult;
      reasonCode?: never;
      reconciliationRef?: never;
      priorReceiptRef?: never;
      evidenceDigest?: never;
      actorRef?: never;
    }
  | {
      outcome: 'reversed' | 'denied' | 'revoked' | 'expired';
      result?: never;
      reasonCode: EveExternalActionReasonCode;
      reconciliationRef?: never;
      priorReceiptRef?: never;
      evidenceDigest?: never;
      actorRef?: never;
    }
  | {
      outcome: 'unknown_outcome';
      result?: never;
      reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' | 'SANITIZATION_FAILED';
      reconciliationRef: string;
      priorReceiptRef?: never;
      evidenceDigest?: never;
      actorRef?: never;
    }
  | {
      outcome: 'reconciled_committed';
      result: EveExternalActionSanitizedResult;
      reasonCode?: never;
      reconciliationRef: string;
      priorReceiptRef: string;
      evidenceDigest: string;
      actorRef: string;
    }
  | {
      outcome: 'reconciled_no_effect';
      result?: never;
      reasonCode?: never;
      reconciliationRef: string;
      priorReceiptRef: string;
      evidenceDigest: string;
      actorRef: string;
    };

export type EveExternalActionReceiptV0 = EveExternalActionReceiptBaseV0 &
  EveExternalActionReceiptDomainV0 &
  EveExternalActionReceiptStateV0;

interface EveExternalActionWorkbenchCardBaseV0 {
  version: typeof EVE_EXTERNAL_ACTION_WORKBENCH_VERSION;
  conversationId: string;
  operationRef: string;
  authMode: EveExternalActionAuthMode;
  providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode;
  occurredAt: string;
}

type EveExternalActionWorkbenchDomainV0 =
  | { domain: 'generic'; action: string; origins: readonly [string]; commerce?: never }
  | {
      domain: 'email_identity';
      action: 'provision' | 'link' | 'verify' | 'send' | 'receive' | 'revoke';
      origins: readonly [string];
      commerce?: never;
    }
  | {
      domain: 'phone_identity';
      action: 'provision' | 'link' | 'otp_receive' | 'otp_use' | 'sms_send' | 'sms_receive' | 'revoke';
      origins: readonly [string];
      commerce?: never;
    }
  | {
      domain: 'commerce';
      action: 'purchase';
      origins: readonly [string, string];
      commerce: { amount: { currency: string; minorUnits: number }; productCount: number };
    };

type EveExternalActionWorkbenchStateV0 =
  | {
      status: 'pending';
      needsUser?: never;
      receiptRef?: never;
      reconciliationRef?: never;
      affordances: readonly ('revoke' | 'stop')[];
    }
  | {
      status: 'needs_user';
      needsUser: {
        kind: EveExternalActionChallengeKind;
        challengeRef: string;
        instructionCode: EveExternalActionNeedsUserInstructionCode;
        expiresAt: string;
        resumeRef: string;
        eventReceiptRef: string;
      };
      receiptRef?: never;
      reconciliationRef?: never;
      affordances: readonly ('resume' | 'revoke' | 'stop')[];
    }
  | {
      status:
        | 'committed'
        | 'reversed'
        | 'denied'
        | 'revoked'
        | 'expired'
        | 'reconciled_committed'
        | 'reconciled_no_effect';
      needsUser?: never;
      receiptRef: string;
      reconciliationRef?: string;
      affordances: readonly [];
    }
  | {
      status: 'unknown_outcome';
      needsUser?: never;
      receiptRef: string;
      reconciliationRef: string;
      affordances: readonly ['reconcile'];
    };

export type EveExternalActionWorkbenchCardV0 = EveExternalActionWorkbenchCardBaseV0 &
  EveExternalActionWorkbenchDomainV0 &
  EveExternalActionWorkbenchStateV0;

export interface EveExternalActionResumeRequest {
  version: typeof EVE_EXTERNAL_ACTION_RESUME_VERSION;
  resumeRef: string;
  completionAttestationRef?: string;
}

export type EveExternalActionProposalValidation =
  | { ok: true; value: EveExternalActionProposal }
  | { ok: false; reasonCode: string };

export type EveExternalActionResumeValidation =
  | { ok: true; value: EveExternalActionResumeRequest }
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
  if (
    !exactKeys(
      action,
      ['kind', 'targetOrigin', 'argumentsDigest', 'amount'],
      ['quoteDigest', 'adapterPayloadRef', 'adapterPayloadDigest']
    )
  ) {
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
  const hasPayloadRef = action.adapterPayloadRef !== undefined;
  const hasPayloadDigest = action.adapterPayloadDigest !== undefined;
  if (
    hasPayloadRef !== hasPayloadDigest ||
    (hasPayloadRef && (!isEveOpaqueId(action.adapterPayloadRef) || !isEveSha256Digest(action.adapterPayloadDigest)))
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_PROPOSAL_ADAPTER_PAYLOAD_INVALID' };
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
        ...(hasPayloadRef
          ? {
              adapterPayloadRef: action.adapterPayloadRef as string,
              adapterPayloadDigest: action.adapterPayloadDigest as string,
            }
          : {}),
        amount: { currency: amount.currency, minorUnits: amount.minorUnits as number },
      },
      ...(record.oauthHandleId ? { oauthHandleId: record.oauthHandleId as string } : {}),
      ...(record.passwordHandleId ? { passwordHandleId: record.passwordHandleId as string } : {}),
    },
  };
}

export function validateEveExternalActionResumeRequest(input: unknown): EveExternalActionResumeValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reasonCode: 'EXTERNAL_RESUME_INVALID' };
  }
  const record = input as Record<string, unknown>;
  if (!exactKeys(record, ['version', 'resumeRef'], ['completionAttestationRef'])) {
    return { ok: false, reasonCode: 'EXTERNAL_RESUME_FIELDS_INVALID' };
  }
  if (
    record.version !== EVE_EXTERNAL_ACTION_RESUME_VERSION ||
    !isEveOpaqueId(record.resumeRef) ||
    (record.completionAttestationRef !== undefined && !isEveOpaqueId(record.completionAttestationRef))
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_RESUME_INVALID' };
  }
  return {
    ok: true,
    value: {
      version: EVE_EXTERNAL_ACTION_RESUME_VERSION,
      resumeRef: record.resumeRef,
      ...(record.completionAttestationRef
        ? { completionAttestationRef: record.completionAttestationRef as string }
        : {}),
    },
  };
}
