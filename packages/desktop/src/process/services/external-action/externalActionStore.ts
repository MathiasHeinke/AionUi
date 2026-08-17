/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import {
  EVE_EXTERNAL_ACTION_CHALLENGE_KINDS,
  EVE_EXTERNAL_ACTION_EVENT_RECEIPT_VERSION,
  EVE_EXTERNAL_ACTION_NEEDS_USER_INSTRUCTION_CODES,
  EVE_EXTERNAL_ACTION_PROVIDER_LABEL_CODES,
  EVE_EXTERNAL_ACTION_REASON_CODES,
  EVE_EXTERNAL_ACTION_RECEIPT_VERSION,
  isEveSanitizedOpaqueRef,
  validateEveExternalActionSanitizedResult,
  validateEveExternalActionProposal,
  type EveExternalAdapterDomain,
  type EveExternalActionAuthMode,
  type EveExternalActionChallenge,
  type EveExternalActionEventReceiptV0,
  type EveExternalActionOrigins,
  type EveExternalActionProviderMerchantLabelCode,
  type EveExternalActionProposal,
  type EveExternalActionReasonCode,
  type EveExternalActionReceiptV0,
  type EveExternalActionSanitizedResult,
  type EveExternalActionSlotBinding,
} from '@/common/config/eveExternalActionExecutionCore';
import {
  EVE_EXTERNAL_ACTION_POLICY_VERSION,
  eveSecretSlotAllowsHandleType,
  isEveExternalActionKind,
  isEveOpaqueId,
  isEveSecretHandleSource,
  isEveSecretHandleType,
  isEveSecretFieldSlot,
  isEveSha256Digest,
  normalizeEveExternalOrigin,
  validateEveExternalActionPolicyMutation,
  type EveExternalActionBinding,
  type EveExternalActionKind,
  type EveExternalActionLedgerState,
  type EveExternalActionPolicy,
  type EveExternalActionPolicyMutation,
  type EveExternalActionRiskClass,
  type EveExternalAuthorityDecision,
  type EveSecretHandleSource,
  type EveSecretHandleType,
  type EveSecretFieldSlot,
} from '@/common/config/eveExternalActionPolicyCore';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';

const SCHEMA_VERSION = 'command-eve-external-action-ledger/v6';
const ACTIVE_BUDGET_STATES = new Set<EveExternalActionLedgerState>([
  'reserved',
  'claimed',
  'suspended',
  'resuming',
  'allowed',
  'unknown',
  'reconciled_committed',
]);
const LEDGER_STATES = new Set<EveExternalActionLedgerState>([
  'reserved',
  'claimed',
  'suspended',
  'resuming',
  'allowed',
  'denied',
  'revoked',
  'expired',
  'reversed',
  'unknown',
  'reconciled_committed',
  'reconciled_no_effect',
]);
const KEYCHAIN_REF_PREFIX = 'keychain:v1:';
const SECRET_SOURCE_REF_PREFIX = 'secret-source:v1:';
const MONEY_ACTIONS = new Set<EveExternalActionKind>(['purchase', 'recurring_payment']);
const AUTH_MODES = new Set<EveExternalActionAuthMode>([
  'oauth',
  'password',
  'otp',
  'payment_fields',
  'session',
  'none',
]);
const PROVIDER_LABEL_CODES = new Set<EveExternalActionProviderMerchantLabelCode>(
  EVE_EXTERNAL_ACTION_PROVIDER_LABEL_CODES
);

export interface ExternalActionStoreDeps {
  now?: () => Date;
  randomUUID?: () => string;
}

export interface ExternalActionReserveInput {
  binding: EveExternalActionBinding;
  conversationId: string;
  conversationSessionId: string;
  adapterId: string;
  authMode: EveExternalActionAuthMode;
  adapterDomain: EveExternalAdapterDomain;
  adapterAction: string;
  counterpartyId: string;
  providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode;
  adapterOrigins: EveExternalActionOrigins;
  slotManifest: readonly EveExternalActionSlotBinding[];
  adapterPayloadRef?: string;
  adapterPayloadDigest?: string;
  adapterPayloadProductCount?: number;
  cartDigest?: string;
  policyRevision: number;
  sessionEpoch: number;
  authorityDecision: EveExternalAuthorityDecision;
  authorityGrantId: string;
  authorityReceiptDigest: string;
  classificationDigest: string;
  riskClass: EveExternalActionRiskClass;
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  intentId: string;
  requestId: string;
  operationDigest: string;
  idempotencyKeyDigest: string;
  executionContractDigest: string;
  quoteDigest?: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
}

export interface ExternalActionReservationResult {
  ok: boolean;
  state?: EveExternalActionLedgerState;
  reservationId?: string;
  reasonCode?: string;
  replay?: boolean;
  receipt?: EveExternalActionReceiptV0;
}

export interface ExternalActionClaimInput {
  binding: EveExternalActionBinding;
  reservationId: string;
  claimId: string;
  claimDigest: string;
  policyRevision: number;
  sessionEpoch: number;
}

export interface ExternalActionClaimResult extends ExternalActionReservationResult {
  execute: boolean;
}

export interface ExternalActionTerminalInput {
  binding: EveExternalActionBinding;
  reservationId: string;
  claimId: string;
  outcomeDigest: string;
  authMode: EveExternalActionAuthMode;
  reasonCode?: EveExternalActionReasonCode;
  result?: EveExternalActionSanitizedResult;
  terminalState?: 'reversed' | 'denied' | 'revoked' | 'expired';
}

export type ExternalActionReconciliationDecision = 'reconciled_committed' | 'reconciled_no_effect';

/** Fully verified Main-only reconciliation input. No renderer IPC exposes it. */
export interface ExternalActionVerifiedReconciliationInput {
  binding: EveExternalActionBinding;
  reservationId: string;
  reconciliationRef: string;
  decision: ExternalActionReconciliationDecision;
  evidenceDigest: string;
  authorityReceiptDigest: string;
  actorRef: string;
  result?: EveExternalActionSanitizedResult;
}

/**
 * Main-computed immutable fields that must still match the durable reservation
 * immediately before an adapter or credential injection can run.
 */
export interface ExternalActionExecutionContractIdentity {
  installationId: string;
  accountId: string;
  seedId: string;
  conversationId: string;
  conversationSessionId: string;
  adapterId: string;
  authMode: EveExternalActionAuthMode;
  domain: EveExternalAdapterDomain;
  domainAction: string;
  counterpartyId: string;
  providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode;
  /** Main-selected OAuth/OIDC link origin; never an action/secret-use origin. */
  authOrigin?: string;
  /** Ordered, max-two canonical origins from the immutable adapter registration. */
  authOrigins?: readonly string[];
  /** Digest of the immutable registered authorization-origin allowlist. */
  authOriginsDigest?: string;
  adapterPayloadRef?: string;
  adapterPayloadDigest?: string;
  adapterPayloadProductCount?: number;
  cartDigest?: string;
  providerOrigin?: string;
  merchantOrigin?: string;
  checkoutOrigin?: string;
  slotManifest: readonly EveExternalActionSlotBinding[];
  intentId: string;
  requestId: string;
  operationDigest: string;
  idempotencyKeyDigest: string;
  executionContractDigest: string;
  authorityGrantId: string;
  authorityReceiptDigest: string;
  classificationDigest: string;
  policyRevision: number;
  sessionEpoch: number;
  quoteDigest?: string;
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  amountMinor: number;
  currency: string;
}

export interface ExternalActionExecutionContractExpectation extends ExternalActionExecutionContractIdentity {
  reservationId: string;
  claimId: string;
  claimDigest: string;
  expectationDigest: string;
}

/**
 * Claim binding preimages. The digest field is never part of its own
 * preimage; recomputation over the persisted reservation row is the only
 * accepted proof at the store boundary.
 */
export interface ExternalActionClaimDigestPreimage {
  executionContractDigest: string;
  reservationId: string;
  claimId: string;
}

export interface ExternalActionExpectationDigestPreimage extends ExternalActionClaimDigestPreimage {
  claimDigest: string;
}

export type ExternalActionContinuationKind = 'pre_execute_probe' | 'adapter_resume';

export interface ExternalActionChallengeSnapshot {
  version: 'command-eve-external-action-challenge-snapshot/v1';
  adapterId: string;
  authMode: EveExternalActionAuthMode;
  continuation: ExternalActionContinuationKind;
  continuationRef: string;
  proposal: EveExternalActionProposal;
  challenge: EveExternalActionChallenge;
  sequence: number;
}

export interface ExternalActionChallengeSuspendInput {
  binding: EveExternalActionBinding;
  reservationId: string;
  claimId: string;
  executionContract: ExternalActionExecutionContractExpectation;
  challenge: EveExternalActionChallenge;
  proposal: EveExternalActionProposal;
  adapterId: string;
  authMode: EveExternalActionAuthMode;
  continuation: ExternalActionContinuationKind;
  continuationRef: string;
  resumeRef: string;
}

export interface ExternalActionChallengeResumeInput {
  binding: EveExternalActionBinding;
  conversationId: string;
  conversationSessionId: string;
  resumeTokenDigest: string;
  completionAttestationDigest: string;
}

export interface ExternalActionChallengeRecord {
  reservationId: string;
  claimId: string;
  executionContract: ExternalActionExecutionContractExpectation;
  snapshot: ExternalActionChallengeSnapshot;
  eventReceipt: EveExternalActionEventReceiptV0;
}

export interface ExternalActionChallengeSuspendResult extends ExternalActionChallengeRecord {
  resumeToken: string;
}

export interface ExternalActionLedgerRecord {
  reservationId: string;
  state: EveExternalActionLedgerState;
  binding: EveExternalActionBinding;
  conversationId: string;
  conversationSessionId: string;
  adapterId: string;
  authMode: EveExternalActionAuthMode;
  adapterDomain: EveExternalAdapterDomain;
  adapterAction: string;
  counterpartyId: string;
  providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode;
  adapterOrigins: EveExternalActionOrigins;
  slotManifest: readonly EveExternalActionSlotBinding[];
  adapterPayloadRef?: string;
  adapterPayloadDigest?: string;
  adapterPayloadProductCount?: number;
  cartDigest?: string;
  intentId: string;
  requestId: string;
  operationDigest: string;
  idempotencyKeyDigest: string;
  executionContractDigest: string;
  authorityGrantId: string;
  authorityReceiptDigest: string;
  classificationDigest: string;
  quoteDigest?: string;
  policyRevision: number;
  sessionEpoch: number;
  amountMinor: number;
  currency: string;
  claimId?: string;
  claimDigest?: string;
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  timezone: string;
  dayId: string;
  monthId: string;
  dayStartAt: string;
  dayEndAt: string;
  monthStartAt: string;
  monthEndAt: string;
  createdAt: string;
  expiresAt: string;
}

export interface ExternalSecretHandleInput {
  binding: EveExternalActionBinding;
  handleId: string;
  type: EveSecretHandleType;
  source: EveSecretHandleSource;
  sourceRef: string;
  actionKinds: readonly EveExternalActionKind[];
  targetOrigins: readonly string[];
  expiresAt: string;
}

export interface ExternalSecretHandleRecord extends ExternalSecretHandleInput {
  revokedAt?: string;
}

export interface ExternalSecretHandleAccess extends ExternalSecretHandleRecord {
  accessGrantId?: string;
}

export interface ExternalSecretShareGrantInput {
  ownerBinding: EveExternalActionBinding;
  granteeBinding: EveExternalActionBinding;
  grantId: string;
  handleId: string;
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  expiresAt: string;
}

export interface ExternalSecretSlotPermitInput {
  binding: EveExternalActionBinding;
  reservationId: string;
  claimId: string;
  slot: EveSecretFieldSlot;
  handleId: string;
  expectedHandleType: EveSecretHandleType;
  executionContract: ExternalActionExecutionContractExpectation;
}

export interface ExternalSecretPermitDigestPreimage {
  binding: EveExternalActionBinding;
  reservationId: string;
  claimId: string;
  adapterId: string;
  slot: EveSecretFieldSlot;
  handleId: string;
  handleType: EveSecretHandleType;
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  ordinal: number;
  expiresAt: string;
  executionContractDigest: string;
}

type PolicyRow = {
  installation_id: string;
  account_id: string;
  seed_id: string;
  revision: number;
  session_epoch: number;
  currency: string;
  timezone: string;
  per_action_limit_minor: number;
  daily_limit_minor: number;
  monthly_limit_minor: number;
  allowed_domains_json: string;
  allowed_action_kinds_json: string;
  expires_at: string;
  kill_switch: number;
  revoked_at: string | null;
  updated_at: string;
};

type LedgerRow = {
  reservation_id: string;
  state: EveExternalActionLedgerState;
  installation_id: string;
  account_id: string;
  seed_id: string;
  conversation_id: string;
  conversation_session_id: string;
  adapter_id: string;
  auth_mode: EveExternalActionAuthMode;
  adapter_domain: EveExternalAdapterDomain;
  adapter_action: string;
  counterparty_id: string;
  provider_label_code: EveExternalActionProviderMerchantLabelCode;
  adapter_origins_json: string;
  slot_manifest_json: string;
  adapter_payload_ref: string | null;
  adapter_payload_digest: string | null;
  adapter_payload_product_count: number | null;
  cart_digest: string | null;
  intent_id: string;
  request_id: string;
  operation_digest: string;
  idempotency_key_digest: string;
  execution_contract_digest: string;
  quote_digest: string | null;
  authority_grant_id: string;
  authority_receipt_digest: string;
  classification_digest: string;
  policy_revision: number;
  session_epoch: number;
  amount_minor: number;
  currency: string;
  claim_id: string | null;
  claim_digest: string | null;
  action_kind: EveExternalActionKind;
  domain: string;
  timezone: string;
  day_id: string;
  month_id: string;
  day_start_at: string;
  day_end_at: string;
  month_start_at: string;
  month_end_at: string;
  created_at: string;
  expires_at: string;
};

type SecretHandleRow = {
  installation_id: string;
  account_id: string;
  seed_id: string;
  handle_id: string;
  type: EveSecretHandleType;
  source: EveSecretHandleSource;
  source_ref: string;
  action_kinds_json: string;
  domains_json: string;
  expires_at: string;
  revoked_at: string | null;
};

type SecretShareGrantRow = {
  grant_id: string;
  owner_installation_id: string;
  owner_account_id: string;
  owner_seed_id: string;
  grantee_installation_id: string;
  grantee_account_id: string;
  grantee_seed_id: string;
  handle_id: string;
  action_kind: EveExternalActionKind;
  target_origin: string;
  expires_at: string;
  revoked_at: string | null;
};

type ChallengeRow = {
  reservation_id: string;
  installation_id: string;
  account_id: string;
  seed_id: string;
  resume_ref: string;
  event_ref: string;
  resume_token_digest: string;
  snapshot_json: string;
  snapshot_digest: string;
  challenge_sequence: number;
  status: 'pending' | 'consumed' | 'invalidated';
  completion_attestation_digest: string | null;
  created_at: string;
  consumed_at: string | null;
  event_json: string;
  event_digest: string;
};

type ReceiptRow = {
  receipt_ref: string;
  reservation_id: string;
  operation_ref: string;
  outcome: EveExternalActionReceiptV0['outcome'];
  auth_mode: EveExternalActionAuthMode;
  account_ref: string;
  seed_ref: string;
  policy_revision: number;
  domain: EveExternalAdapterDomain;
  action: string;
  provider_or_merchant_id: string;
  origins_json: string;
  amount_currency: string | null;
  amount_minor: number | null;
  result_json: string | null;
  result_digest: string | null;
  reason_code: string | null;
  occurred_at: string;
  retry_allowed: number;
  reconciliation_ref: string | null;
  prior_receipt_ref: string | null;
  evidence_digest: string | null;
  authority_receipt_digest: string;
  reconciliation_authority_receipt_digest: string | null;
  actor_ref: string | null;
};

function bindingArgs(binding: EveExternalActionBinding): readonly string[] {
  return [binding.installationId, binding.accountId, binding.seedId];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function hasExactRecordKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/** Closed persisted vocabularies. Internal diagnostics never cross this line. */
const TERMINAL_REASON_CODES: ReadonlySet<string> = new Set(EVE_EXTERNAL_ACTION_REASON_CODES);
const NEEDS_USER_INSTRUCTION_CODE_SET: ReadonlySet<string> = new Set(EVE_EXTERNAL_ACTION_NEEDS_USER_INSTRUCTION_CODES);

export function externalActionClaimDigest(preimage: ExternalActionClaimDigestPreimage): string {
  return sha256(canonical(preimage));
}

export function externalActionExpectationDigest(preimage: ExternalActionExpectationDigestPreimage): string {
  return sha256(canonical(preimage));
}

/**
 * Maps internal diagnostics onto the closed persisted reason set. Live results
 * and ledger writes always agree; internal detail survives only inside the
 * outcome digest, never in SQLite, receipts, event receipts or renderer DTOs.
 */
export function externalActionTerminalReason(internal: string): EveExternalActionReasonCode {
  if (TERMINAL_REASON_CODES.has(internal)) {
    return internal as EveExternalActionReasonCode;
  }
  if (internal.includes('REVOK') || internal.includes('KILL')) return 'REVOKED';
  if (internal.includes('EXPIR')) return 'EXPIRED';
  if (internal.includes('BINDING') || internal.includes('CONVERSATION') || internal.includes('SEAT')) {
    return 'BINDING_MISMATCH';
  }
  if (internal.includes('CLAIM') || internal.includes('REPLAY')) return 'CLAIM_MISMATCH';
  if (internal.includes('ORIGIN')) return 'ORIGIN_MISMATCH';
  if (internal.includes('CONTRACT') || internal.includes('PAYLOAD') || internal.includes('RECHECK')) {
    return 'CONTRACT_CHANGED';
  }
  if (
    internal.includes('AUTHORITY') ||
    internal.includes('CLASSIFICATION') ||
    internal.includes('RISK') ||
    internal.includes('GRANT')
  ) {
    return 'AUTHORITY_DENIED';
  }
  if (internal.includes('USER')) return 'USER_CANCELLED';
  return 'POLICY_DENIED';
}

function receiptOutcomeForLedgerState(
  state: EveExternalActionLedgerState
): EveExternalActionReceiptV0['outcome'] | null {
  switch (state) {
    case 'allowed':
      return 'committed';
    case 'reversed':
      return 'reversed';
    case 'denied':
    case 'revoked':
    case 'expired':
      return state;
    case 'unknown':
      return 'unknown_outcome';
    case 'reconciled_committed':
    case 'reconciled_no_effect':
      return state;
    default:
      return null;
  }
}

function validBinding(binding: EveExternalActionBinding): boolean {
  return isEveOpaqueId(binding.installationId) && isEveOpaqueId(binding.accountId) && isEveOpaqueId(binding.seedId);
}

function parseStringArray(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function parseExactOrigins(value: unknown): EveExternalActionOrigins | null {
  const parsed = parseStringArray(value);
  if (
    !parsed ||
    (parsed.length !== 1 && parsed.length !== 2) ||
    !parsed.every((origin) => normalizeEveExternalOrigin(origin) === origin)
  ) {
    return null;
  }
  return parsed as unknown as EveExternalActionOrigins;
}

function parseSlotManifest(value: unknown): EveExternalActionSlotBinding[] | null {
  if (typeof value !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || canonical(parsed) !== value) return null;
  const manifest: EveExternalActionSlotBinding[] = [];
  for (const raw of parsed) {
    if (
      !hasExactRecordKeys(raw, ['slot', 'handleId', 'handleType']) ||
      !isEveSecretFieldSlot(raw.slot) ||
      !isEveOpaqueId(raw.handleId) ||
      !isEveSecretHandleType(raw.handleType) ||
      !eveSecretSlotAllowsHandleType(raw.slot, raw.handleType) ||
      manifest.some((entry) => entry.slot === raw.slot)
    ) {
      return null;
    }
    manifest.push({ slot: raw.slot, handleId: raw.handleId, handleType: raw.handleType });
  }
  return manifest.every((entry, index) => index === 0 || manifest[index - 1]!.slot.localeCompare(entry.slot) < 0)
    ? manifest
    : null;
}

function executionOrigins(identity: ExternalActionExecutionContractIdentity): EveExternalActionOrigins | null {
  if (identity.domain === 'commerce') {
    const merchantOrigin = normalizeEveExternalOrigin(identity.merchantOrigin);
    const checkoutOrigin = normalizeEveExternalOrigin(identity.checkoutOrigin);
    return merchantOrigin && checkoutOrigin ? [merchantOrigin, checkoutOrigin] : null;
  }
  const providerOrigin = normalizeEveExternalOrigin(identity.providerOrigin);
  return providerOrigin ? [providerOrigin] : null;
}

function challengeOriginForExecution(
  identity: ExternalActionExecutionContractIdentity,
  kind: EveExternalActionChallenge['kind']
): string {
  return kind === 'oauth_consent' && identity.authOrigin ? identity.authOrigin : identity.targetOrigin;
}

function policyFromRow(row: PolicyRow | undefined): EveExternalActionPolicy | null {
  if (!row) return null;
  const allowedOrigins = parseStringArray(row.allowed_domains_json);
  const rawKinds = parseStringArray(row.allowed_action_kinds_json);
  if (
    !validBinding({ installationId: row.installation_id, accountId: row.account_id, seedId: row.seed_id }) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !Number.isSafeInteger(row.session_epoch) ||
    row.session_epoch < 1 ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !Number.isSafeInteger(row.per_action_limit_minor) ||
    !Number.isSafeInteger(row.daily_limit_minor) ||
    !Number.isSafeInteger(row.monthly_limit_minor) ||
    row.per_action_limit_minor < 0 ||
    row.daily_limit_minor < row.per_action_limit_minor ||
    row.monthly_limit_minor < row.daily_limit_minor ||
    typeof row.timezone !== 'string' ||
    !zonedPeriodKeys(new Date(), row.timezone) ||
    typeof row.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(row.expires_at)) ||
    (row.kill_switch !== 0 && row.kill_switch !== 1) ||
    (row.revoked_at !== null && (typeof row.revoked_at !== 'string' || !Number.isFinite(Date.parse(row.revoked_at)))) ||
    typeof row.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(row.updated_at)) ||
    !allowedOrigins ||
    allowedOrigins.length === 0 ||
    !allowedOrigins.every((origin) => normalizeEveExternalOrigin(origin) === origin) ||
    !rawKinds ||
    rawKinds.length === 0 ||
    !rawKinds.every(isEveExternalActionKind)
  )
    return null;
  return {
    version: EVE_EXTERNAL_ACTION_POLICY_VERSION,
    binding: {
      installationId: row.installation_id,
      accountId: row.account_id,
      seedId: row.seed_id,
    },
    revision: row.revision,
    sessionEpoch: row.session_epoch,
    currency: row.currency,
    timezone: row.timezone,
    perActionLimitMinor: row.per_action_limit_minor,
    dailyLimitMinor: row.daily_limit_minor,
    monthlyLimitMinor: row.monthly_limit_minor,
    allowedOrigins,
    allowedActionKinds: rawKinds as EveExternalActionKind[],
    expiresAt: row.expires_at,
    killSwitch: row.kill_switch === 1,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    updatedAt: row.updated_at,
  };
}

function ledgerFromRow(row: LedgerRow | undefined): ExternalActionLedgerRecord | null {
  if (!row) return null;
  const adapterOrigins = parseExactOrigins(row.adapter_origins_json);
  const slotManifest = parseSlotManifest(row.slot_manifest_json);
  if (
    !validBinding({ installationId: row.installation_id, accountId: row.account_id, seedId: row.seed_id }) ||
    !isEveOpaqueId(row.reservation_id) ||
    !LEDGER_STATES.has(row.state) ||
    !isEveOpaqueId(row.conversation_id) ||
    !isEveOpaqueId(row.conversation_session_id) ||
    !isEveOpaqueId(row.adapter_id) ||
    !AUTH_MODES.has(row.auth_mode) ||
    !['generic', 'email_identity', 'phone_identity', 'commerce'].includes(row.adapter_domain) ||
    !isEveOpaqueId(row.adapter_action) ||
    !isEveSanitizedOpaqueRef(row.counterparty_id) ||
    !PROVIDER_LABEL_CODES.has(row.provider_label_code) ||
    !adapterOrigins ||
    !slotManifest ||
    (row.adapter_domain === 'commerce') !== (adapterOrigins.length === 2) ||
    (row.adapter_payload_ref !== null && row.adapter_payload_digest === null) ||
    (row.adapter_payload_ref !== null && !isEveOpaqueId(row.adapter_payload_ref)) ||
    (row.adapter_payload_digest !== null && !isEveSha256Digest(row.adapter_payload_digest)) ||
    (row.adapter_domain === 'commerce' &&
      (row.adapter_payload_digest === null ||
        !Number.isSafeInteger(row.adapter_payload_product_count) ||
        (row.adapter_payload_product_count ?? 0) < 1 ||
        (row.adapter_payload_product_count ?? 0) > 100)) ||
    (row.adapter_domain !== 'commerce' && row.adapter_payload_product_count !== null) ||
    (row.adapter_domain === 'commerce' && !isEveSha256Digest(row.cart_digest)) ||
    (row.adapter_domain !== 'commerce' && row.cart_digest !== null) ||
    !isEveOpaqueId(row.intent_id) ||
    !isEveOpaqueId(row.request_id) ||
    !isEveSha256Digest(row.operation_digest) ||
    !isEveSha256Digest(row.idempotency_key_digest) ||
    !isEveSha256Digest(row.execution_contract_digest) ||
    (row.quote_digest !== null && !isEveSha256Digest(row.quote_digest)) ||
    !isEveOpaqueId(row.authority_grant_id) ||
    !isEveSha256Digest(row.authority_receipt_digest) ||
    !isEveSha256Digest(row.classification_digest) ||
    !Number.isSafeInteger(row.policy_revision) ||
    row.policy_revision < 1 ||
    !Number.isSafeInteger(row.session_epoch) ||
    row.session_epoch < 1 ||
    !Number.isSafeInteger(row.amount_minor) ||
    row.amount_minor < 0 ||
    typeof row.currency !== 'string' ||
    !/^(?:[A-Z]{3}|NONE)$/.test(row.currency) ||
    !isEveExternalActionKind(row.action_kind) ||
    typeof row.domain !== 'string' ||
    normalizeEveExternalOrigin(row.domain) !== row.domain ||
    typeof row.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(row.expires_at)) ||
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    typeof row.timezone !== 'string' ||
    !zonedPeriodKeys(new Date(row.created_at), row.timezone) ||
    typeof row.day_start_at !== 'string' ||
    !Number.isFinite(Date.parse(row.day_start_at)) ||
    typeof row.day_end_at !== 'string' ||
    !Number.isFinite(Date.parse(row.day_end_at)) ||
    typeof row.month_start_at !== 'string' ||
    !Number.isFinite(Date.parse(row.month_start_at)) ||
    typeof row.month_end_at !== 'string' ||
    !Number.isFinite(Date.parse(row.month_end_at)) ||
    typeof row.day_id !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.day_id) ||
    typeof row.month_id !== 'string' ||
    !/^\d{4}-\d{2}$/.test(row.month_id) ||
    (row.claim_id !== null && !isEveOpaqueId(row.claim_id)) ||
    (row.claim_digest !== null && !isEveSha256Digest(row.claim_digest)) ||
    (row.claim_id === null) !== (row.claim_digest === null) ||
    ([
      'claimed',
      'suspended',
      'resuming',
      'allowed',
      'unknown',
      'reconciled_committed',
      'reconciled_no_effect',
    ].includes(row.state) &&
      (row.claim_id === null || row.claim_digest === null))
  )
    return null;
  return {
    reservationId: row.reservation_id,
    state: row.state,
    binding: {
      installationId: row.installation_id,
      accountId: row.account_id,
      seedId: row.seed_id,
    },
    conversationId: row.conversation_id,
    conversationSessionId: row.conversation_session_id,
    adapterId: row.adapter_id,
    authMode: row.auth_mode,
    adapterDomain: row.adapter_domain,
    adapterAction: row.adapter_action,
    counterpartyId: row.counterparty_id,
    providerOrMerchantLabelCode: row.provider_label_code,
    adapterOrigins,
    slotManifest,
    ...(row.adapter_payload_ref ? { adapterPayloadRef: row.adapter_payload_ref } : {}),
    ...(row.adapter_payload_digest ? { adapterPayloadDigest: row.adapter_payload_digest } : {}),
    ...(row.adapter_payload_product_count !== null
      ? { adapterPayloadProductCount: row.adapter_payload_product_count }
      : {}),
    ...(row.cart_digest ? { cartDigest: row.cart_digest } : {}),
    intentId: row.intent_id,
    requestId: row.request_id,
    operationDigest: row.operation_digest,
    idempotencyKeyDigest: row.idempotency_key_digest,
    executionContractDigest: row.execution_contract_digest,
    authorityGrantId: row.authority_grant_id,
    authorityReceiptDigest: row.authority_receipt_digest,
    classificationDigest: row.classification_digest,
    ...(row.quote_digest ? { quoteDigest: row.quote_digest } : {}),
    policyRevision: row.policy_revision,
    sessionEpoch: row.session_epoch,
    amountMinor: row.amount_minor,
    currency: row.currency,
    ...(row.claim_id ? { claimId: row.claim_id } : {}),
    ...(row.claim_digest ? { claimDigest: row.claim_digest } : {}),
    actionKind: row.action_kind,
    targetOrigin: row.domain,
    timezone: row.timezone,
    dayId: row.day_id,
    monthId: row.month_id,
    dayStartAt: row.day_start_at,
    dayEndAt: row.day_end_at,
    monthStartAt: row.month_start_at,
    monthEndAt: row.month_end_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function receiptFromRow(row: ReceiptRow | undefined): EveExternalActionReceiptV0 | null {
  if (!row) return null;
  const origins = parseExactOrigins(row.origins_json);
  const hasAmount = row.amount_currency !== null || row.amount_minor !== null;
  const reconciled = row.outcome === 'reconciled_committed' || row.outcome === 'reconciled_no_effect';
  const unknown = row.outcome === 'unknown_outcome';
  let result: EveExternalActionSanitizedResult | null = null;
  if (row.result_json !== null) {
    try {
      const parsed: unknown = JSON.parse(row.result_json);
      if (canonical(parsed) !== row.result_json || sha256(row.result_json) !== row.result_digest) return null;
      result = validateEveExternalActionSanitizedResult(parsed, {
        domain: row.domain,
        action: row.action,
        ...(hasAmount
          ? { amount: { currency: row.amount_currency as string, minorUnits: row.amount_minor as number } }
          : {}),
      });
    } catch {
      return null;
    }
  } else if (row.result_digest !== null) {
    return null;
  }
  const committed = row.outcome === 'committed' || row.outcome === 'reconciled_committed';
  const failed = ['reversed', 'denied', 'revoked', 'expired', 'unknown_outcome'].includes(row.outcome);
  if (
    !isEveOpaqueId(row.receipt_ref) ||
    !isEveOpaqueId(row.reservation_id) ||
    !isEveOpaqueId(row.operation_ref) ||
    ![
      'committed',
      'reversed',
      'denied',
      'revoked',
      'expired',
      'unknown_outcome',
      'reconciled_committed',
      'reconciled_no_effect',
    ].includes(row.outcome) ||
    !AUTH_MODES.has(row.auth_mode) ||
    !isEveOpaqueId(row.account_ref) ||
    !isEveOpaqueId(row.seed_ref) ||
    !isEveSha256Digest(row.authority_receipt_digest) ||
    !Number.isSafeInteger(row.policy_revision) ||
    row.policy_revision < 1 ||
    !['generic', 'email_identity', 'phone_identity', 'commerce'].includes(row.domain) ||
    !isEveOpaqueId(row.action) ||
    !isEveSanitizedOpaqueRef(row.provider_or_merchant_id) ||
    !origins ||
    (row.domain === 'commerce') !== (origins.length === 2) ||
    (hasAmount &&
      (typeof row.amount_currency !== 'string' ||
        !/^[A-Z]{3}$/.test(row.amount_currency) ||
        !Number.isSafeInteger(row.amount_minor) ||
        (row.amount_minor as number) <= 0)) ||
    typeof row.occurred_at !== 'string' ||
    !Number.isFinite(Date.parse(row.occurred_at)) ||
    row.retry_allowed !== 0 ||
    committed !== Boolean(result) ||
    failed !== (row.reason_code !== null) ||
    (row.reason_code !== null && !TERMINAL_REASON_CODES.has(row.reason_code)) ||
    (unknown && !['UNKNOWN_EXTERNAL_EFFECT', 'SANITIZATION_FAILED'].includes(row.reason_code ?? '')) ||
    (unknown || reconciled) !== (row.reconciliation_ref !== null) ||
    (row.reconciliation_ref !== null && !isEveOpaqueId(row.reconciliation_ref)) ||
    reconciled !== (row.prior_receipt_ref !== null) ||
    (row.prior_receipt_ref !== null && !isEveOpaqueId(row.prior_receipt_ref)) ||
    reconciled !== (row.evidence_digest !== null) ||
    (row.evidence_digest !== null && !isEveSha256Digest(row.evidence_digest)) ||
    reconciled !== (row.reconciliation_authority_receipt_digest !== null) ||
    (row.reconciliation_authority_receipt_digest !== null &&
      !isEveSha256Digest(row.reconciliation_authority_receipt_digest)) ||
    reconciled !== (row.actor_ref !== null) ||
    (row.actor_ref !== null && !isEveOpaqueId(row.actor_ref))
  ) {
    return null;
  }
  return {
    version: EVE_EXTERNAL_ACTION_RECEIPT_VERSION,
    receiptRef: row.receipt_ref,
    operationRef: row.operation_ref,
    reservationRef: row.reservation_id,
    outcome: row.outcome,
    authMode: row.auth_mode,
    accountRef: row.account_ref,
    seedRef: row.seed_ref,
    authorityReceiptDigest: row.authority_receipt_digest,
    policyRevision: row.policy_revision,
    domain: row.domain,
    action: row.action,
    providerOrMerchantId: row.provider_or_merchant_id,
    origins,
    ...(hasAmount
      ? { amount: { currency: row.amount_currency as string, minorUnits: row.amount_minor as number } }
      : {}),
    ...(result ? { result } : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    ...(row.reconciliation_ref ? { reconciliationRef: row.reconciliation_ref } : {}),
    ...(row.prior_receipt_ref ? { priorReceiptRef: row.prior_receipt_ref } : {}),
    ...(row.evidence_digest ? { evidenceDigest: row.evidence_digest } : {}),
    ...(row.actor_ref ? { actorRef: row.actor_ref } : {}),
    occurredAt: row.occurred_at,
    retryAllowed: false,
  } as unknown as EveExternalActionReceiptV0;
}

function eventReceiptFromRow(row: ChallengeRow | undefined): EveExternalActionEventReceiptV0 | null {
  if (!row || !isEveSha256Digest(row.event_digest)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.event_json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || canonical(parsed) !== row.event_json)
    return null;
  if (sha256(row.event_json) !== row.event_digest) return null;
  const candidate = parsed as Record<string, unknown>;
  const required = [
    'version',
    'event',
    'eventRef',
    'operationRef',
    'reservationRef',
    'authMode',
    'accountRef',
    'seedRef',
    'domain',
    'action',
    'origins',
    'challengeKind',
    'challengeRef',
    'instructionCode',
    'challengeOrigin',
    'resumeRef',
    'expiresAt',
    'occurredAt',
  ];
  const origins = parseExactOrigins(JSON.stringify(candidate.origins));
  if (
    !required.every((key) => Object.hasOwn(candidate, key)) ||
    Object.keys(candidate).some((key) => !required.includes(key)) ||
    candidate.version !== EVE_EXTERNAL_ACTION_EVENT_RECEIPT_VERSION ||
    candidate.event !== 'needs_user' ||
    candidate.eventRef !== row.event_ref ||
    candidate.resumeRef !== row.resume_ref ||
    candidate.reservationRef !== row.reservation_id ||
    !isEveOpaqueId(candidate.eventRef) ||
    !isEveOpaqueId(candidate.operationRef) ||
    !isEveOpaqueId(candidate.reservationRef) ||
    !AUTH_MODES.has(candidate.authMode as EveExternalActionAuthMode) ||
    !isEveOpaqueId(candidate.accountRef) ||
    !isEveOpaqueId(candidate.seedRef) ||
    !['generic', 'email_identity', 'phone_identity', 'commerce'].includes(String(candidate.domain)) ||
    !isEveOpaqueId(candidate.action) ||
    !origins ||
    (candidate.domain === 'commerce') !== (origins.length === 2) ||
    !EVE_EXTERNAL_ACTION_CHALLENGE_KINDS.includes(candidate.challengeKind as EveExternalActionChallenge['kind']) ||
    !isEveSanitizedOpaqueRef(candidate.challengeRef) ||
    typeof candidate.instructionCode !== 'string' ||
    !NEEDS_USER_INSTRUCTION_CODE_SET.has(candidate.instructionCode) ||
    normalizeEveExternalOrigin(candidate.challengeOrigin) !== candidate.challengeOrigin ||
    !isEveSanitizedOpaqueRef(candidate.resumeRef) ||
    typeof candidate.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    typeof candidate.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.occurredAt))
  ) {
    return null;
  }
  return {
    ...(candidate as unknown as EveExternalActionEventReceiptV0),
    origins,
  } as unknown as EveExternalActionEventReceiptV0;
}

function validExecutionIdentity(value: ExternalActionExecutionContractIdentity, includesClaimDigest = false): boolean {
  if (
    !hasExactRecordKeys(
      value,
      [
        'installationId',
        'accountId',
        'seedId',
        'conversationId',
        'conversationSessionId',
        'adapterId',
        'authMode',
        'domain',
        'domainAction',
        'counterpartyId',
        'providerOrMerchantLabelCode',
        'slotManifest',
        'intentId',
        'requestId',
        'operationDigest',
        'idempotencyKeyDigest',
        'executionContractDigest',
        'authorityGrantId',
        'authorityReceiptDigest',
        'classificationDigest',
        'policyRevision',
        'sessionEpoch',
        'actionKind',
        'targetOrigin',
        'amountMinor',
        'currency',
        ...(includesClaimDigest ? ['reservationId', 'claimId', 'claimDigest', 'expectationDigest'] : []),
      ],
      [
        'providerOrigin',
        'merchantOrigin',
        'checkoutOrigin',
        'authOrigin',
        'authOrigins',
        'authOriginsDigest',
        'adapterPayloadRef',
        'adapterPayloadDigest',
        'adapterPayloadProductCount',
        'cartDigest',
        'quoteDigest',
      ]
    )
  ) {
    return false;
  }
  const origin = normalizeEveExternalOrigin(value.targetOrigin);
  const commerce = value.domain === 'commerce';
  const providerOrigin = value.providerOrigin ? normalizeEveExternalOrigin(value.providerOrigin) : null;
  const merchantOrigin = value.merchantOrigin ? normalizeEveExternalOrigin(value.merchantOrigin) : null;
  const checkoutOrigin = value.checkoutOrigin ? normalizeEveExternalOrigin(value.checkoutOrigin) : null;
  const authOrigin = value.authOrigin ? normalizeEveExternalOrigin(value.authOrigin) : null;
  const authOrigins = value.authOrigins;
  const validDomainAction =
    (value.domain === 'generic' && isEveOpaqueId(value.domainAction)) ||
    (value.domain === 'email_identity' &&
      ['provision', 'link', 'verify', 'send', 'receive', 'revoke'].includes(value.domainAction)) ||
    (value.domain === 'phone_identity' &&
      ['provision', 'link', 'otp_receive', 'otp_use', 'sms_send', 'sms_receive', 'revoke'].includes(
        value.domainAction
      )) ||
    (value.domain === 'commerce' && value.domainAction === 'purchase' && value.actionKind === 'purchase');
  return (
    isEveOpaqueId(value.installationId) &&
    isEveOpaqueId(value.accountId) &&
    isEveOpaqueId(value.seedId) &&
    isEveOpaqueId(value.conversationId) &&
    isEveOpaqueId(value.conversationSessionId) &&
    isEveOpaqueId(value.adapterId) &&
    AUTH_MODES.has(value.authMode) &&
    ['generic', 'email_identity', 'phone_identity', 'commerce'].includes(value.domain) &&
    validDomainAction &&
    isEveSanitizedOpaqueRef(value.counterpartyId) &&
    PROVIDER_LABEL_CODES.has(value.providerOrMerchantLabelCode) &&
    ((value.authOrigin === undefined && value.authOrigins === undefined && value.authOriginsDigest === undefined) ||
      (value.authMode === 'oauth' &&
        authOrigin === value.authOrigin &&
        authOrigin !== origin &&
        Array.isArray(authOrigins) &&
        authOrigins.length >= 1 &&
        authOrigins.length <= 2 &&
        authOrigins.every(
          (candidate, index) =>
            normalizeEveExternalOrigin(candidate) === candidate && authOrigins.indexOf(candidate) === index
        ) &&
        authOrigin === authOrigins[0] &&
        isEveSha256Digest(value.authOriginsDigest) &&
        value.authOriginsDigest === sha256(canonical(authOrigins)))) &&
    // Main normalizes inline ingress to digest-only before reserve. An opaque
    // ref, when present, must still be paired with its canonical digest.
    (value.adapterPayloadRef === undefined ||
      (isEveOpaqueId(value.adapterPayloadRef) && value.adapterPayloadDigest !== undefined)) &&
    (value.adapterPayloadDigest === undefined || isEveSha256Digest(value.adapterPayloadDigest)) &&
    (commerce
      ? value.adapterPayloadDigest !== undefined &&
        Number.isSafeInteger(value.adapterPayloadProductCount) &&
        (value.adapterPayloadProductCount ?? 0) >= 1 &&
        (value.adapterPayloadProductCount ?? 0) <= 100
      : value.adapterPayloadProductCount === undefined) &&
    (commerce ? isEveSha256Digest(value.cartDigest) : value.cartDigest === undefined) &&
    ((!commerce && providerOrigin === origin && !value.merchantOrigin && !value.checkoutOrigin) ||
      (commerce && !value.providerOrigin && merchantOrigin !== null && checkoutOrigin === origin)) &&
    Array.isArray(value.slotManifest) &&
    value.slotManifest.every(
      (entry, index) =>
        hasExactRecordKeys(entry, ['slot', 'handleId', 'handleType']) &&
        isEveSecretFieldSlot(entry.slot) &&
        isEveOpaqueId(entry.handleId) &&
        isEveSecretHandleType(entry.handleType) &&
        eveSecretSlotAllowsHandleType(entry.slot, entry.handleType) &&
        (index === 0 || value.slotManifest[index - 1]!.slot.localeCompare(entry.slot) < 0)
    ) &&
    isEveOpaqueId(value.intentId) &&
    isEveOpaqueId(value.requestId) &&
    isEveSha256Digest(value.operationDigest) &&
    isEveSha256Digest(value.idempotencyKeyDigest) &&
    isEveSha256Digest(value.executionContractDigest) &&
    isEveOpaqueId(value.authorityGrantId) &&
    isEveSha256Digest(value.authorityReceiptDigest) &&
    isEveSha256Digest(value.classificationDigest) &&
    Number.isSafeInteger(value.policyRevision) &&
    value.policyRevision >= 1 &&
    Number.isSafeInteger(value.sessionEpoch) &&
    value.sessionEpoch >= 1 &&
    (value.quoteDigest === undefined || isEveSha256Digest(value.quoteDigest)) &&
    isEveExternalActionKind(value.actionKind) &&
    origin === value.targetOrigin &&
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor >= 0 &&
    /^(?:[A-Z]{3}|NONE)$/.test(value.currency)
  );
}

function validExecutionExpectation(value: ExternalActionExecutionContractExpectation): boolean {
  return (
    validExecutionIdentity(value, true) &&
    isEveOpaqueId(value.reservationId) &&
    isEveOpaqueId(value.claimId) &&
    isEveSha256Digest(value.claimDigest) &&
    isEveSha256Digest(value.expectationDigest)
  );
}

function validChallenge(value: unknown, nowMs: number): value is EveExternalActionChallenge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const required = ['kind', 'challengeRef', 'origin', 'expiresAt', 'userInstructionCode'];
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key))
  ) {
    return false;
  }
  const challenge = value as Partial<EveExternalActionChallenge>;
  const origin = normalizeEveExternalOrigin(challenge.origin);
  return (
    EVE_EXTERNAL_ACTION_CHALLENGE_KINDS.includes(challenge.kind as EveExternalActionChallenge['kind']) &&
    isEveOpaqueId(challenge.challengeRef) &&
    origin === challenge.origin &&
    typeof challenge.expiresAt === 'string' &&
    Number.isFinite(Date.parse(challenge.expiresAt)) &&
    Date.parse(challenge.expiresAt) > nowMs &&
    NEEDS_USER_INSTRUCTION_CODE_SET.has(challenge.userInstructionCode as string)
  );
}

function zonedPeriodKeys(
  now: Date,
  timezone: string
): {
  dayId: string;
  monthId: string;
  dayStartAt: string;
  dayEndAt: string;
  monthStartAt: string;
  monthEndAt: string;
} | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (!values.year || !values.month || !values.day) return null;
    const dayId = `${values.year}-${values.month}-${values.day}`;
    const monthId = `${values.year}-${values.month}`;
    return {
      dayId,
      monthId,
      dayStartAt: zonedMidnightUtc(yearOf(dayId), monthOf(dayId), dayOf(dayId), timezone).toISOString(),
      dayEndAt: zonedMidnightUtc(yearOf(dayId), monthOf(dayId), dayOf(dayId) + 1, timezone).toISOString(),
      monthStartAt: zonedMidnightUtc(yearOf(monthId), monthOf(monthId), 1, timezone).toISOString(),
      monthEndAt: zonedMidnightUtc(yearOf(monthId), monthOf(monthId) + 1, 1, timezone).toISOString(),
    };
  } catch {
    return null;
  }
}

function yearOf(id: string): number {
  return Number(id.split('-')[0]);
}

function monthOf(id: string): number {
  return Number(id.split('-')[1]);
}

function dayOf(id: string): number {
  return Number(id.split('-')[2]);
}

const ZONED_TIME_PARTS: Intl.DateTimeFormatOptions = {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

/**
 * UTC instant of local midnight for the given wall-clock calendar date in a
 * timezone. Uses the offset measured in the zone at the target date and
 * re-probes to converge across DST edges.
 */
function zonedMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let utc = naiveUtc;
  for (let i = 0; i < 3; i++) {
    const probe = new Date(utc);
    const parts = new Intl.DateTimeFormat('en-US', {
      ...ZONED_TIME_PARTS,
      timeZone: timezone,
    }).formatToParts(probe);
    const v = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localWallUtc = Date.UTC(
      Number(v.year),
      Number(v.month) - 1,
      Number(v.day),
      Number(v.hour),
      Number(v.minute),
      Number(v.second)
    );
    const offset = localWallUtc - utc;
    utc = naiveUtc - offset;
  }
  return new Date(utc);
}

/**
 * Ensures a persisted resolution row carries immutable period keys and exact
 * RFC3339 boundaries that agree with the timezone captured at reserve time.
 * A later policy timezone change must never reclassify this historical row.
 */
function zonedPeriodKeysConsistent(row: {
  timezone: string;
  created_at: string;
  day_id: string;
  month_id: string;
  day_start_at: string;
  day_end_at: string;
  month_start_at: string;
  month_end_at: string;
}): boolean {
  const periods = zonedPeriodKeys(new Date(row.created_at), row.timezone);
  return Boolean(
    periods &&
    periods.dayId === row.day_id &&
    periods.monthId === row.month_id &&
    periods.dayStartAt === row.day_start_at &&
    periods.dayEndAt === row.day_end_at &&
    periods.monthStartAt === row.month_start_at &&
    periods.monthEndAt === row.month_end_at
  );
}

function validSourceRef(source: EveSecretHandleSource, sourceRef: unknown): sourceRef is string {
  if (typeof sourceRef !== 'string' || sourceRef.length > 512) return false;
  if (source === 'eve_keychain') {
    if (!sourceRef.startsWith(KEYCHAIN_REF_PREFIX)) return false;
    const encoded = sourceRef.slice(KEYCHAIN_REF_PREFIX.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.byteLength >= 8 && decoded.toString('base64') === encoded;
  }
  const provider = source.slice('hermes_'.length);
  const expected = `${SECRET_SOURCE_REF_PREFIX}${provider}:`;
  const alias = sourceRef.startsWith(expected) ? sourceRef.slice(expected.length) : '';
  return isEveOpaqueId(alias);
}

function handleTypeAllowsSource(type: EveSecretHandleType, source: EveSecretHandleSource): boolean {
  if (source === 'eve_keychain') return true;
  // Hermes 0.19/0.20/current-main SecretSource is startup environment
  // hydration. It is eligible only for service/API material, never identity,
  // payment or password fill.
  return type === 'service_credential' || type === 'oauth_token';
}

/**
 * One local SQLite authority-adjacent store for policy, reservations and opaque
 * secret handles. It never performs an external action and never stores secret
 * material: only ciphertext/reference handles are accepted.
 */
export class ExternalActionStore {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly installationId: string;

  constructor(
    private readonly db: ISqliteDriver,
    deps: ExternalActionStoreDeps = {}
  ) {
    this.now = deps.now ?? (() => new Date());
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    this.initializeSchema();
    this.installationId = this.ensureInstallationId();
    this.recoverClaimedAsUnknown();
  }

  getInstallationId(): string {
    return this.installationId;
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS external_action_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version TEXT NOT NULL,
        installation_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS external_action_policies (
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        session_epoch INTEGER NOT NULL,
        currency TEXT NOT NULL,
        timezone TEXT NOT NULL,
        per_action_limit_minor INTEGER NOT NULL,
        daily_limit_minor INTEGER NOT NULL,
        monthly_limit_minor INTEGER NOT NULL,
        allowed_domains_json TEXT NOT NULL,
        allowed_action_kinds_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
        revoked_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, account_id, seed_id)
      );
      CREATE TABLE IF NOT EXISTS external_action_reservations (
        reservation_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN (
          'reserved', 'claimed', 'suspended', 'resuming', 'allowed', 'reversed', 'denied', 'revoked', 'expired', 'unknown',
          'reconciled_committed', 'reconciled_no_effect'
        )),
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        conversation_session_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        adapter_domain TEXT NOT NULL,
        adapter_action TEXT NOT NULL,
        counterparty_id TEXT NOT NULL,
        provider_label_code TEXT NOT NULL,
        adapter_origins_json TEXT NOT NULL,
        slot_manifest_json TEXT NOT NULL,
        adapter_payload_ref TEXT,
        adapter_payload_digest TEXT,
        adapter_payload_product_count INTEGER CHECK (
          adapter_payload_product_count IS NULL OR
          (adapter_payload_product_count BETWEEN 1 AND 100)
        ),
        cart_digest TEXT,
        intent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        idempotency_key_digest TEXT NOT NULL,
        execution_contract_digest TEXT NOT NULL,
        quote_digest TEXT,
        authority_grant_id TEXT NOT NULL,
        authority_receipt_digest TEXT NOT NULL,
        classification_digest TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        session_epoch INTEGER NOT NULL,
        action_kind TEXT NOT NULL,
        domain TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        timezone TEXT NOT NULL,
        day_id TEXT NOT NULL,
        month_id TEXT NOT NULL,
        day_start_at TEXT NOT NULL,
        day_end_at TEXT NOT NULL,
        month_start_at TEXT NOT NULL,
        month_end_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_id TEXT UNIQUE,
        claim_digest TEXT,
        terminal_at TEXT,
        outcome_digest TEXT,
        UNIQUE (installation_id, account_id, seed_id, intent_id),
        UNIQUE (installation_id, account_id, seed_id, request_id),
        UNIQUE (installation_id, account_id, seed_id, operation_digest),
        UNIQUE (installation_id, account_id, seed_id, idempotency_key_digest)
      );
      CREATE INDEX IF NOT EXISTS external_action_budget_day_idx
        ON external_action_reservations (installation_id, account_id, seed_id, currency, day_id, state);
      CREATE INDEX IF NOT EXISTS external_action_budget_month_idx
        ON external_action_reservations (installation_id, account_id, seed_id, currency, month_id, state);
      CREATE TABLE IF NOT EXISTS external_secret_handles (
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        handle_id TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        action_kinds_json TEXT NOT NULL,
        domains_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, account_id, seed_id, handle_id)
      );
      CREATE TABLE IF NOT EXISTS external_secret_share_grants (
        grant_id TEXT PRIMARY KEY,
        owner_installation_id TEXT NOT NULL,
        owner_account_id TEXT NOT NULL,
        owner_seed_id TEXT NOT NULL,
        grantee_installation_id TEXT NOT NULL,
        grantee_account_id TEXT NOT NULL,
        grantee_seed_id TEXT NOT NULL,
        handle_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        target_origin TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (
          owner_installation_id, owner_account_id, owner_seed_id, handle_id,
          grantee_installation_id, grantee_account_id, grantee_seed_id,
          action_kind, target_origin
        )
      );
      CREATE TABLE IF NOT EXISTS external_action_challenges (
        reservation_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        resume_ref TEXT NOT NULL UNIQUE,
        event_ref TEXT NOT NULL UNIQUE,
        resume_token_digest TEXT NOT NULL UNIQUE,
        snapshot_json TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        challenge_sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'invalidated')),
        completion_attestation_digest TEXT,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS external_action_event_receipts (
        event_ref TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        challenge_sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        UNIQUE (reservation_id, challenge_sequence)
      );
      CREATE TABLE IF NOT EXISTS external_action_secret_slot_permits (
        reservation_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        handle_id TEXT NOT NULL,
        handle_type TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        target_origin TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        expires_at TEXT NOT NULL,
        execution_contract_digest TEXT NOT NULL,
        permit_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'consumed')),
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        PRIMARY KEY (reservation_id, slot)
      );
      CREATE TABLE IF NOT EXISTS external_secret_handle_consumptions (
        owner_installation_id TEXT NOT NULL,
        owner_account_id TEXT NOT NULL,
        owner_seed_id TEXT NOT NULL,
        handle_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        consumed_at TEXT NOT NULL,
        PRIMARY KEY (owner_installation_id, owner_account_id, owner_seed_id, handle_id)
      );
      CREATE TABLE IF NOT EXISTS external_action_receipts (
        receipt_ref TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL,
        operation_ref TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN (
          'committed', 'reversed', 'denied', 'revoked', 'expired', 'unknown_outcome',
          'reconciled_committed', 'reconciled_no_effect'
        )),
        auth_mode TEXT NOT NULL,
        account_ref TEXT NOT NULL,
        seed_ref TEXT NOT NULL,
        authority_receipt_digest TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        domain TEXT NOT NULL,
        action TEXT NOT NULL,
        provider_or_merchant_id TEXT NOT NULL,
        origins_json TEXT NOT NULL,
        amount_currency TEXT,
        amount_minor INTEGER,
        result_json TEXT,
        result_digest TEXT,
        reason_code TEXT,
        occurred_at TEXT NOT NULL,
        retry_allowed INTEGER NOT NULL CHECK (retry_allowed = 0),
        reconciliation_ref TEXT,
        prior_receipt_ref TEXT,
        evidence_digest TEXT,
        reconciliation_authority_receipt_digest TEXT,
        actor_ref TEXT,
        CHECK ((amount_currency IS NULL AND amount_minor IS NULL) OR (amount_currency IS NOT NULL AND amount_minor > 0)),
        UNIQUE (reservation_id, outcome)
      );
      CREATE TABLE IF NOT EXISTS external_action_audit (
        event_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        reservation_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        details_json TEXT NOT NULL
      );
    `);

    // v6 migration: add immutable policy timezone + exact day/month period
    // boundaries so a later policy timezone change cannot reclassify history.
    const cols = this.db.prepare('PRAGMA table_info(external_action_reservations)').all() as unknown as Array<{
      name: string;
    }>;
    const has = (name: string) => cols.some((col) => col.name === name);
    if (!has('timezone')) {
      this.db.exec('ALTER TABLE external_action_reservations ADD COLUMN timezone TEXT');
    }
    if (!has('day_start_at')) {
      this.db.exec('ALTER TABLE external_action_reservations ADD COLUMN day_start_at TEXT');
    }
    if (!has('day_end_at')) {
      this.db.exec('ALTER TABLE external_action_reservations ADD COLUMN day_end_at TEXT');
    }
    if (!has('month_start_at')) {
      this.db.exec('ALTER TABLE external_action_reservations ADD COLUMN month_start_at TEXT');
    }
    if (!has('month_end_at')) {
      this.db.exec('ALTER TABLE external_action_reservations ADD COLUMN month_end_at TEXT');
    }
  }

  private ensureInstallationId(): string {
    const row = this.db
      .prepare('SELECT schema_version, installation_id FROM external_action_meta WHERE singleton = 1')
      .get() as { schema_version?: unknown; installation_id?: unknown } | undefined;
    if (row) {
      if (row.schema_version !== SCHEMA_VERSION || !isEveOpaqueId(row.installation_id)) {
        throw new Error('EXTERNAL_ACTION_SCHEMA_MIGRATION_REQUIRED');
      }
      return row.installation_id;
    }
    const installationId = `install:${this.randomUUID()}`;
    this.db
      .prepare(
        'INSERT OR REPLACE INTO external_action_meta (singleton, schema_version, installation_id) VALUES (1, ?, ?)'
      )
      .run(SCHEMA_VERSION, installationId);
    return installationId;
  }

  private recoverClaimedAsUnknown(): void {
    const nowIso = this.now().toISOString();
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT * FROM external_action_reservations WHERE state IN ('claimed', 'resuming')")
        .all() as LedgerRow[];
      for (const row of rows) {
        const reservation = ledgerFromRow(row);
        if (!reservation) throw new Error('EXTERNAL_ACTION_LEDGER_INVALID');
        this.db
          .prepare(
            `UPDATE external_action_reservations
             SET state = 'unknown', terminal_at = ?, outcome_digest = ?
             WHERE reservation_id = ? AND state IN ('claimed', 'resuming')`
          )
          .run(
            nowIso,
            'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            reservation.reservationId
          );
        this.persistTerminalReceipt({ ...reservation, state: 'unknown' }, nowIso);
      }
    });
    transaction();
  }

  private audit(
    binding: EveExternalActionBinding,
    eventType: string,
    reservationId?: string,
    details: Record<string, unknown> = {}
  ): void {
    this.db
      .prepare(
        `INSERT INTO external_action_audit
          (event_id, installation_id, account_id, seed_id, reservation_id, event_type, occurred_at, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `event:${this.randomUUID()}`,
        ...bindingArgs(binding),
        reservationId ?? null,
        eventType,
        this.now().toISOString(),
        JSON.stringify(details)
      );
  }

  /**
   * Persist the renderer-safe terminal projection in the same SQLite
   * transaction as the ledger transition. All fields are derived from the
   * trusted immutable reservation; adapters never pass arbitrary receipt JSON.
   */
  private persistTerminalReceipt(
    reservation: ExternalActionLedgerRecord,
    occurredAt: string,
    options: {
      reasonCode?: string;
      result?: EveExternalActionSanitizedResult;
      reconciliation?: {
        priorReceiptRef: string;
        evidenceDigest: string;
        authorityReceiptDigest: string;
        actorRef: string;
        reconciliationRef: string;
      };
    } = {}
  ): EveExternalActionReceiptV0 {
    const outcome = receiptOutcomeForLedgerState(reservation.state);
    if (!outcome) throw new Error('EXTERNAL_RECEIPT_STATE_INVALID');
    const reconciled = reservation.state === 'reconciled_committed' || reservation.state === 'reconciled_no_effect';
    if (reconciled !== Boolean(options.reconciliation)) throw new Error('EXTERNAL_RECEIPT_RECONCILIATION_INVALID');
    const committed = reservation.state === 'allowed' || reservation.state === 'reconciled_committed';
    const fallbackResult: EveExternalActionSanitizedResult | undefined =
      committed && reservation.adapterDomain === 'generic'
        ? {
            domain: 'generic',
            action: reservation.adapterAction,
            resultRef: `result:${reservation.executionContractDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`,
          }
        : undefined;
    const result = options.result ?? fallbackResult;
    if (
      committed &&
      !validateEveExternalActionSanitizedResult(result, {
        domain: reservation.adapterDomain,
        action: reservation.adapterAction,
        ...(reservation.amountMinor > 0
          ? { amount: { currency: reservation.currency, minorUnits: reservation.amountMinor } }
          : {}),
      })
    ) {
      throw new Error('EXTERNAL_RECEIPT_RESULT_INVALID');
    }
    if (!committed && result) throw new Error('EXTERNAL_RECEIPT_RESULT_FORBIDDEN');
    const defaultReason: Record<'reversed' | 'denied' | 'revoked' | 'expired' | 'unknown', string> = {
      reversed: 'POLICY_DENIED',
      denied: 'POLICY_DENIED',
      revoked: 'REVOKED',
      expired: 'EXPIRED',
      unknown: 'UNKNOWN_EXTERNAL_EFFECT',
    };
    const reasonCode =
      reservation.state in defaultReason
        ? options.reasonCode && TERMINAL_REASON_CODES.has(options.reasonCode)
          ? options.reasonCode
          : defaultReason[reservation.state as keyof typeof defaultReason]
        : undefined;
    if (reservation.state === 'unknown' && !['UNKNOWN_EXTERNAL_EFFECT', 'SANITIZATION_FAILED'].includes(reasonCode!)) {
      throw new Error('EXTERNAL_RECEIPT_UNKNOWN_REASON_INVALID');
    }
    const accountRef = `account:${sha256(reservation.binding.accountId).slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const seedRef = `seed:${sha256(reservation.binding.seedId).slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const reconciliation = options.reconciliation;
    const receipt = {
      version: EVE_EXTERNAL_ACTION_RECEIPT_VERSION,
      receiptRef: `receipt:${reservation.reservationId}:${outcome}`,
      operationRef: `operation:${reservation.operationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`,
      reservationRef: reservation.reservationId,
      outcome,
      authMode: reservation.authMode,
      accountRef,
      seedRef,
      authorityReceiptDigest: reservation.authorityReceiptDigest,
      policyRevision: reservation.policyRevision,
      domain: reservation.adapterDomain,
      action: reservation.adapterAction,
      providerOrMerchantId: reservation.counterpartyId,
      origins: reservation.adapterOrigins,
      ...(reservation.amountMinor > 0
        ? { amount: { currency: reservation.currency, minorUnits: reservation.amountMinor } }
        : {}),
      ...(result ? { result } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      ...(reservation.state === 'unknown' ? { reconciliationRef: `reconciliation:${reservation.reservationId}` } : {}),
      ...(reconciliation
        ? {
            reconciliationRef: reconciliation.reconciliationRef,
            priorReceiptRef: reconciliation.priorReceiptRef,
            evidenceDigest: reconciliation.evidenceDigest,
            actorRef: reconciliation.actorRef,
          }
        : {}),
      occurredAt,
      retryAllowed: false,
    } as unknown as EveExternalActionReceiptV0;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO external_action_receipts (
           receipt_ref, reservation_id, operation_ref, outcome,
           auth_mode, account_ref, seed_ref, authority_receipt_digest, policy_revision,
           domain, action, provider_or_merchant_id, origins_json, amount_currency, amount_minor,
           result_json, result_digest, reason_code, occurred_at, retry_allowed,
           reconciliation_ref, prior_receipt_ref, evidence_digest, reconciliation_authority_receipt_digest, actor_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.receiptRef,
        receipt.reservationRef,
        receipt.operationRef,
        receipt.outcome,
        receipt.authMode,
        receipt.accountRef,
        receipt.seedRef,
        receipt.authorityReceiptDigest,
        receipt.policyRevision,
        receipt.domain,
        receipt.action,
        receipt.providerOrMerchantId,
        JSON.stringify(receipt.origins),
        receipt.amount?.currency ?? null,
        receipt.amount?.minorUnits ?? null,
        receipt.result ? canonical(receipt.result) : null,
        receipt.result ? sha256(canonical(receipt.result)) : null,
        receipt.reasonCode ?? null,
        receipt.occurredAt,
        receipt.reconciliationRef ?? null,
        receipt.priorReceiptRef ?? null,
        receipt.evidenceDigest ?? null,
        reconciliation?.authorityReceiptDigest ?? null,
        receipt.actorRef ?? null
      );
    const stored = this.db
      .prepare('SELECT * FROM external_action_receipts WHERE reservation_id = ? AND outcome = ?')
      .get(reservation.reservationId, outcome) as ReceiptRow | undefined;
    const parsed = receiptFromRow(stored);
    if (!parsed || canonical(parsed) !== canonical(receipt)) {
      throw new Error('EXTERNAL_RECEIPT_PERSIST_CONFLICT');
    }
    return parsed;
  }

  getPolicy(binding: EveExternalActionBinding): EveExternalActionPolicy | null {
    if (!validBinding(binding) || binding.installationId !== this.installationId) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM external_action_policies
         WHERE installation_id = ? AND account_id = ? AND seed_id = ?`
      )
      .get(...bindingArgs(binding)) as PolicyRow | undefined;
    return policyFromRow(row);
  }

  replacePolicy(
    binding: EveExternalActionBinding,
    mutation: EveExternalActionPolicyMutation,
    timezone: string
  ): { ok: true; policy: EveExternalActionPolicy } | { ok: false; reasonCode: string } {
    if (!validBinding(binding) || binding.installationId !== this.installationId) {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_BINDING_INVALID' };
    }
    if (!zonedPeriodKeys(this.now(), timezone)) return { ok: false, reasonCode: 'EXTERNAL_POLICY_TIMEZONE_INVALID' };
    const validation = validateEveExternalActionPolicyMutation(mutation, this.now());
    if ('reasonCode' in validation) return { ok: false, reasonCode: validation.reasonCode };

    const existing = this.getPolicy(binding);
    // Period boundaries are part of durable budget accounting. Changing them
    // while historical rows still exist could make prior spend disappear.
    if (existing && existing.timezone !== timezone) {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_TIMEZONE_IMMUTABLE' };
    }

    const transaction = this.db.transaction(() => {
      const current = this.getPolicy(binding);
      const revision = (current?.revision ?? 0) + 1;
      const sessionEpoch = (current?.sessionEpoch ?? 0) + 1;
      const updatedAt = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO external_action_policies (
             installation_id, account_id, seed_id, revision, session_epoch, currency, timezone,
             per_action_limit_minor, daily_limit_minor, monthly_limit_minor,
             allowed_domains_json, allowed_action_kinds_json, expires_at, kill_switch, revoked_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
           ON CONFLICT (installation_id, account_id, seed_id) DO UPDATE SET
             revision = excluded.revision,
             session_epoch = excluded.session_epoch,
             currency = excluded.currency,
             timezone = excluded.timezone,
             per_action_limit_minor = excluded.per_action_limit_minor,
             daily_limit_minor = excluded.daily_limit_minor,
             monthly_limit_minor = excluded.monthly_limit_minor,
             allowed_domains_json = excluded.allowed_domains_json,
             allowed_action_kinds_json = excluded.allowed_action_kinds_json,
             expires_at = excluded.expires_at,
             kill_switch = 0,
             revoked_at = NULL,
             updated_at = excluded.updated_at`
        )
        .run(
          ...bindingArgs(binding),
          revision,
          sessionEpoch,
          validation.value.currency,
          timezone,
          validation.value.perActionLimitMinor,
          validation.value.dailyLimitMinor,
          validation.value.monthlyLimitMinor,
          JSON.stringify(validation.value.allowedOrigins),
          JSON.stringify(validation.value.allowedActionKinds),
          validation.value.expiresAt,
          updatedAt
        );
      this.invalidateOutstanding(binding, 'policy_replaced');
      this.audit(binding, 'policy.replaced', undefined, { revision, session_epoch: sessionEpoch });
      const policy = this.getPolicy(binding);
      if (!policy) throw new Error('EXTERNAL_POLICY_PERSIST_FAILED');
      return policy;
    });

    try {
      return { ok: true, policy: transaction() };
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_PERSIST_FAILED' };
    }
  }

  setKillSwitch(
    binding: EveExternalActionBinding,
    enabled: boolean
  ): { ok: true; policy: EveExternalActionPolicy } | { ok: false; reasonCode: string } {
    const current = this.getPolicy(binding);
    if (!current) return { ok: false, reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' };
    if (current.revokedAt && !enabled) return { ok: false, reasonCode: 'EXTERNAL_POLICY_REVOKED' };
    const transaction = this.db.transaction(() => {
      const revision = current.revision + 1;
      const sessionEpoch = current.sessionEpoch + 1;
      this.db
        .prepare(
          `UPDATE external_action_policies
           SET revision = ?, session_epoch = ?, kill_switch = ?, updated_at = ?
           WHERE installation_id = ? AND account_id = ? AND seed_id = ?`
        )
        .run(revision, sessionEpoch, enabled ? 1 : 0, this.now().toISOString(), ...bindingArgs(binding));
      if (enabled) this.invalidateOutstanding(binding, 'kill_switch');
      this.audit(binding, enabled ? 'policy.kill_enabled' : 'policy.kill_disabled', undefined, {
        revision,
        session_epoch: sessionEpoch,
      });
      const policy = this.getPolicy(binding);
      if (!policy) throw new Error('EXTERNAL_POLICY_PERSIST_FAILED');
      return policy;
    });
    try {
      return { ok: true, policy: transaction() };
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_PERSIST_FAILED' };
    }
  }

  revokePolicy(
    binding: EveExternalActionBinding
  ): { ok: true; policy: EveExternalActionPolicy } | { ok: false; reasonCode: string } {
    const current = this.getPolicy(binding);
    if (!current) return { ok: false, reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' };
    const transaction = this.db.transaction(() => {
      const nowIso = this.now().toISOString();
      const revision = current.revision + 1;
      const sessionEpoch = current.sessionEpoch + 1;
      this.db
        .prepare(
          `UPDATE external_action_policies
           SET revision = ?, session_epoch = ?, kill_switch = 1, revoked_at = ?, updated_at = ?
           WHERE installation_id = ? AND account_id = ? AND seed_id = ?`
        )
        .run(revision, sessionEpoch, nowIso, nowIso, ...bindingArgs(binding));
      this.invalidateOutstanding(binding, 'policy_revoked');
      this.db
        .prepare(
          `UPDATE external_secret_handles SET revoked_at = ?
           WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND revoked_at IS NULL`
        )
        .run(nowIso, ...bindingArgs(binding));
      this.db
        .prepare(
          `UPDATE external_secret_share_grants SET revoked_at = ?
           WHERE revoked_at IS NULL AND (
             (owner_installation_id = ? AND owner_account_id = ? AND owner_seed_id = ?) OR
             (grantee_installation_id = ? AND grantee_account_id = ? AND grantee_seed_id = ?)
           )`
        )
        .run(nowIso, ...bindingArgs(binding), ...bindingArgs(binding));
      this.audit(binding, 'policy.revoked', undefined, { revision, session_epoch: sessionEpoch });
      const policy = this.getPolicy(binding);
      if (!policy) throw new Error('EXTERNAL_POLICY_PERSIST_FAILED');
      return policy;
    });
    try {
      return { ok: true, policy: transaction() };
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_PERSIST_FAILED' };
    }
  }

  private invalidateOutstanding(binding: EveExternalActionBinding, reason: string): void {
    const nowIso = this.now().toISOString();
    const safeTerminalState: 'reversed' | 'revoked' =
      reason === 'kill_switch' || reason === 'policy_revoked' ? 'revoked' : 'reversed';
    const outstanding = this.db
      .prepare(
        `SELECT * FROM external_action_reservations
         WHERE installation_id = ? AND account_id = ? AND seed_id = ?
           AND state IN ('reserved', 'claimed', 'suspended', 'resuming')`
      )
      .all(...bindingArgs(binding)) as LedgerRow[];
    const records = outstanding.map(ledgerFromRow);
    if (records.some((record) => !record)) throw new Error('EXTERNAL_ACTION_LEDGER_INVALID');
    const safelyTerminated = this.db
      .prepare(
        `UPDATE external_action_reservations
         SET state = ?, terminal_at = ?, outcome_digest = ?
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND state IN ('reserved', 'suspended')`
      )
      .run(
        safeTerminalState,
        nowIso,
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        ...bindingArgs(binding)
      ).changes;
    const unknown = this.db
      .prepare(
        `UPDATE external_action_reservations
         SET state = 'unknown', terminal_at = ?, outcome_digest = ?
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND state IN ('claimed', 'resuming')`
      )
      .run(
        nowIso,
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        ...bindingArgs(binding)
      ).changes;
    for (const record of records) {
      if (!record) continue;
      this.persistTerminalReceipt(
        {
          ...record,
          state: record.state === 'reserved' || record.state === 'suspended' ? safeTerminalState : 'unknown',
        },
        nowIso
      );
    }
    if (safelyTerminated > 0 || unknown > 0)
      this.audit(binding, 'ledger.invalidated', undefined, {
        reason,
        safe_terminal_state: safeTerminalState,
        safely_terminated: safelyTerminated,
        unknown,
      });
    this.db
      .prepare(
        `UPDATE external_action_challenges SET status = 'invalidated', consumed_at = ?
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND status = 'pending'`
      )
      .run(nowIso, ...bindingArgs(binding));
  }

  reserve(input: ExternalActionReserveInput): ExternalActionReservationResult {
    const invalid = this.validateReserveInput(input);
    if (invalid) return { ok: false, reasonCode: invalid };
    const policy = this.getPolicy(input.binding);
    if (!policy) return { ok: false, reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' };
    const now = this.now();
    const nowMs = now.getTime();
    if (input.authorityDecision !== 'allow') return { ok: false, reasonCode: 'EXTERNAL_AUTHORITY_NOT_ALLOW' };
    if (input.riskClass !== 'ordinary') return { ok: false, reasonCode: 'EXTERNAL_ACTION_HUMAN_GATE_REQUIRED' };
    if (policy.killSwitch) return { ok: false, reasonCode: 'EXTERNAL_POLICY_KILLED' };
    if (policy.revokedAt) return { ok: false, reasonCode: 'EXTERNAL_POLICY_REVOKED' };
    if (Date.parse(policy.expiresAt) <= nowMs) return { ok: false, reasonCode: 'EXTERNAL_POLICY_EXPIRED' };
    if (policy.revision !== input.policyRevision || policy.sessionEpoch !== input.sessionEpoch) {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_STALE' };
    }
    if (!policy.allowedActionKinds.includes(input.actionKind)) {
      return { ok: false, reasonCode: 'EXTERNAL_ACTION_KIND_BLOCKED' };
    }
    const targetOrigin = normalizeEveExternalOrigin(input.targetOrigin);
    if (!targetOrigin) return { ok: false, reasonCode: 'EXTERNAL_ORIGIN_INVALID' };
    if (
      !policy.allowedOrigins.includes(targetOrigin) ||
      input.adapterOrigins.some((adapterOrigin) => !policy.allowedOrigins.includes(adapterOrigin))
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_ORIGIN_BLOCKED' };
    }
    if (MONEY_ACTIONS.has(input.actionKind) && input.amountMinor <= 0) {
      return { ok: false, reasonCode: 'EXTERNAL_AMOUNT_REQUIRED' };
    }
    if (input.amountMinor > 0) {
      if (input.currency !== policy.currency) return { ok: false, reasonCode: 'EXTERNAL_CURRENCY_BLOCKED' };
      if (input.amountMinor > policy.perActionLimitMinor) {
        return { ok: false, reasonCode: 'EXTERNAL_BUDGET_PER_ACTION_EXCEEDED' };
      }
    }
    const reservationExpiry = Date.parse(input.expiresAt);
    if (
      !Number.isFinite(reservationExpiry) ||
      reservationExpiry <= nowMs ||
      reservationExpiry > Date.parse(policy.expiresAt)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_RESERVATION_EXPIRY_INVALID' };
    }
    const periods = zonedPeriodKeys(now, policy.timezone);
    if (!periods) return { ok: false, reasonCode: 'EXTERNAL_POLICY_TIMEZONE_INVALID' };

    const transaction = this.db.transaction((): ExternalActionReservationResult => {
      const replay = this.findReplay(input);
      if (replay) return replay;
      if (input.amountMinor > 0) {
        const dayTotal = this.budgetTotal(input.binding, input.currency, policy.timezone, 'day_id', periods.dayId);
        if (dayTotal === null) return { ok: false, reasonCode: 'EXTERNAL_BUDGET_LEDGER_INVALID' };
        if (dayTotal + input.amountMinor > policy.dailyLimitMinor) {
          return { ok: false, reasonCode: 'EXTERNAL_BUDGET_DAILY_EXCEEDED' };
        }
        const monthTotal = this.budgetTotal(
          input.binding,
          input.currency,
          policy.timezone,
          'month_id',
          periods.monthId
        );
        if (monthTotal === null) return { ok: false, reasonCode: 'EXTERNAL_BUDGET_LEDGER_INVALID' };
        if (monthTotal + input.amountMinor > policy.monthlyLimitMinor) {
          return { ok: false, reasonCode: 'EXTERNAL_BUDGET_MONTHLY_EXCEEDED' };
        }
      }
      const reservationId = `reservation:${this.randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO external_action_reservations (
             reservation_id, state, installation_id, account_id, seed_id,
             conversation_id, conversation_session_id, adapter_id, auth_mode,
             adapter_domain, adapter_action, counterparty_id, provider_label_code,
             adapter_origins_json, slot_manifest_json,
             adapter_payload_ref, adapter_payload_digest, adapter_payload_product_count, cart_digest,
             intent_id, request_id, operation_digest, idempotency_key_digest,
             execution_contract_digest, quote_digest, authority_grant_id, authority_receipt_digest,
             classification_digest,
             policy_revision, session_epoch, action_kind, domain, amount_minor, currency,
             timezone, day_id, month_id, day_start_at, day_end_at, month_start_at, month_end_at, expires_at, created_at
           ) VALUES (?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reservationId,
          ...bindingArgs(input.binding),
          input.conversationId,
          input.conversationSessionId,
          input.adapterId,
          input.authMode,
          input.adapterDomain,
          input.adapterAction,
          input.counterpartyId,
          input.providerOrMerchantLabelCode,
          JSON.stringify(input.adapterOrigins),
          canonical(input.slotManifest),
          input.adapterPayloadRef ?? null,
          input.adapterPayloadDigest ?? null,
          input.adapterPayloadProductCount ?? null,
          input.cartDigest ?? null,
          input.intentId,
          input.requestId,
          input.operationDigest,
          input.idempotencyKeyDigest,
          input.executionContractDigest,
          input.quoteDigest ?? null,
          input.authorityGrantId,
          input.authorityReceiptDigest,
          input.classificationDigest,
          input.policyRevision,
          input.sessionEpoch,
          input.actionKind,
          targetOrigin,
          input.amountMinor,
          input.currency,
          policy.timezone,
          periods.dayId,
          periods.monthId,
          periods.dayStartAt,
          periods.dayEndAt,
          periods.monthStartAt,
          periods.monthEndAt,
          new Date(reservationExpiry).toISOString(),
          now.toISOString()
        );
      this.audit(input.binding, 'ledger.reserved', reservationId, {
        action_kind: input.actionKind,
        amount_minor: input.amountMinor,
        currency: input.currency,
      });
      return { ok: true, state: 'reserved', reservationId };
    });

    try {
      return transaction();
    } catch {
      const replay = this.findReplay(input);
      return replay ?? { ok: false, reasonCode: 'EXTERNAL_LEDGER_RESERVE_FAILED' };
    }
  }

  private validateReserveInput(input: ExternalActionReserveInput): string | null {
    if (!validBinding(input.binding) || input.binding.installationId !== this.installationId) {
      return 'EXTERNAL_BINDING_INVALID';
    }
    if (!Number.isSafeInteger(input.policyRevision) || !Number.isSafeInteger(input.sessionEpoch)) {
      return 'EXTERNAL_POLICY_STALE';
    }
    if (!isEveExternalActionKind(input.actionKind)) return 'EXTERNAL_ACTION_KIND_INVALID';
    if (!normalizeEveExternalOrigin(input.targetOrigin)) return 'EXTERNAL_ORIGIN_INVALID';
    const adapterOrigins = parseExactOrigins(JSON.stringify(input.adapterOrigins));
    const slotManifest = parseSlotManifest(canonical(input.slotManifest));
    if (
      !isEveOpaqueId(input.conversationId) ||
      !isEveOpaqueId(input.conversationSessionId) ||
      !isEveOpaqueId(input.adapterId) ||
      !AUTH_MODES.has(input.authMode) ||
      !['generic', 'email_identity', 'phone_identity', 'commerce'].includes(input.adapterDomain) ||
      !isEveOpaqueId(input.adapterAction) ||
      !isEveSanitizedOpaqueRef(input.counterpartyId) ||
      !PROVIDER_LABEL_CODES.has(input.providerOrMerchantLabelCode) ||
      !adapterOrigins ||
      !slotManifest ||
      (input.adapterDomain === 'commerce') !== (adapterOrigins.length === 2) ||
      adapterOrigins.at(-1) !== input.targetOrigin ||
      (input.adapterPayloadRef !== undefined &&
        (!isEveOpaqueId(input.adapterPayloadRef) || input.adapterPayloadDigest === undefined)) ||
      (input.adapterPayloadDigest !== undefined && !isEveSha256Digest(input.adapterPayloadDigest)) ||
      (input.adapterDomain === 'commerce' &&
        (input.adapterPayloadDigest === undefined ||
          !Number.isSafeInteger(input.adapterPayloadProductCount) ||
          (input.adapterPayloadProductCount ?? 0) < 1 ||
          (input.adapterPayloadProductCount ?? 0) > 100)) ||
      (input.adapterDomain !== 'commerce' && input.adapterPayloadProductCount !== undefined) ||
      (input.adapterDomain === 'commerce' && !isEveSha256Digest(input.cartDigest)) ||
      (input.adapterDomain !== 'commerce' && input.cartDigest !== undefined) ||
      !isEveOpaqueId(input.authorityGrantId) ||
      !isEveSha256Digest(input.authorityReceiptDigest) ||
      !isEveOpaqueId(input.intentId) ||
      !isEveOpaqueId(input.requestId) ||
      !isEveSha256Digest(input.classificationDigest) ||
      !isEveSha256Digest(input.operationDigest) ||
      !isEveSha256Digest(input.idempotencyKeyDigest) ||
      !isEveSha256Digest(input.executionContractDigest) ||
      (input.quoteDigest !== undefined && !isEveSha256Digest(input.quoteDigest))
    ) {
      return 'EXTERNAL_INTENT_INVALID';
    }
    const moneyAction = MONEY_ACTIONS.has(input.actionKind);
    if (moneyAction && !isEveSha256Digest(input.quoteDigest)) return 'EXTERNAL_QUOTE_REQUIRED';
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 0 ||
      !/^(?:[A-Z]{3}|NONE)$/.test(input.currency)
    ) {
      return 'EXTERNAL_AMOUNT_INVALID';
    }
    if (!moneyAction && (input.amountMinor !== 0 || input.currency !== 'NONE' || input.quoteDigest !== undefined)) {
      return 'EXTERNAL_AMOUNT_FORBIDDEN';
    }
    return null;
  }

  private findReplay(input: ExternalActionReserveInput): ExternalActionReservationResult | null {
    const row = this.db
      .prepare(
        `SELECT * FROM external_action_reservations
         WHERE installation_id = ? AND account_id = ? AND seed_id = ?
           AND (intent_id = ? OR request_id = ? OR operation_digest = ? OR idempotency_key_digest = ?)
         LIMIT 1`
      )
      .get(
        ...bindingArgs(input.binding),
        input.intentId,
        input.requestId,
        input.operationDigest,
        input.idempotencyKeyDigest
      ) as LedgerRow | undefined;
    const record = ledgerFromRow(row);
    if (!record) return null;
    const exact =
      record.intentId === input.intentId &&
      record.conversationId === input.conversationId &&
      record.conversationSessionId === input.conversationSessionId &&
      record.adapterId === input.adapterId &&
      record.authMode === input.authMode &&
      record.adapterDomain === input.adapterDomain &&
      record.adapterAction === input.adapterAction &&
      record.counterpartyId === input.counterpartyId &&
      record.providerOrMerchantLabelCode === input.providerOrMerchantLabelCode &&
      canonical(record.adapterOrigins) === canonical(input.adapterOrigins) &&
      canonical(record.slotManifest) === canonical(input.slotManifest) &&
      record.adapterPayloadRef === input.adapterPayloadRef &&
      record.adapterPayloadDigest === input.adapterPayloadDigest &&
      record.adapterPayloadProductCount === input.adapterPayloadProductCount &&
      record.cartDigest === input.cartDigest &&
      record.requestId === input.requestId &&
      record.operationDigest === input.operationDigest &&
      record.idempotencyKeyDigest === input.idempotencyKeyDigest &&
      record.executionContractDigest === input.executionContractDigest &&
      record.authorityGrantId === input.authorityGrantId &&
      record.authorityReceiptDigest === input.authorityReceiptDigest &&
      record.classificationDigest === input.classificationDigest &&
      record.quoteDigest === input.quoteDigest &&
      record.policyRevision === input.policyRevision &&
      record.sessionEpoch === input.sessionEpoch &&
      record.actionKind === input.actionKind &&
      record.targetOrigin === input.targetOrigin &&
      record.amountMinor === input.amountMinor &&
      record.currency === input.currency;
    return exact
      ? { ok: true, state: record.state, reservationId: record.reservationId, replay: true }
      : { ok: false, state: record.state, reservationId: record.reservationId, reasonCode: 'EXTERNAL_REPLAY_CONFLICT' };
  }

  private budgetTotal(
    binding: EveExternalActionBinding,
    currency: string,
    timezone: string,
    periodColumn: 'day_id' | 'month_id',
    period: string
  ): number | null {
    const rows = this.db
      .prepare(
        `SELECT state, amount_minor, day_id, month_id, created_at, timezone,
                day_start_at, day_end_at, month_start_at, month_end_at
         FROM external_action_reservations
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND currency = ?`
      )
      .all(...bindingArgs(binding), currency) as Array<{
      state?: unknown;
      amount_minor?: unknown;
      day_id?: unknown;
      month_id?: unknown;
      created_at?: unknown;
      timezone?: unknown;
      day_start_at?: unknown;
      day_end_at?: unknown;
      month_start_at?: unknown;
      month_end_at?: unknown;
    }>;
    let total = 0;
    for (const row of rows) {
      if (!LEDGER_STATES.has(row.state as EveExternalActionLedgerState)) return null;
      if (!Number.isSafeInteger(row.amount_minor) || (row.amount_minor as number) < 0) return null;
      if (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return null;
      if (typeof row.day_id !== 'string' || typeof row.month_id !== 'string') return null;
      if (
        !zonedPeriodKeysConsistent({
          timezone: row.timezone as string,
          created_at: row.created_at,
          day_id: row.day_id,
          month_id: row.month_id,
          day_start_at: row.day_start_at as string,
          day_end_at: row.day_end_at as string,
          month_start_at: row.month_start_at as string,
          month_end_at: row.month_end_at as string,
        })
      ) {
        return null;
      }
      if (!ACTIVE_BUDGET_STATES.has(row.state as EveExternalActionLedgerState)) continue;
      if (row[periodColumn] !== period) continue;
      total += row.amount_minor as number;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  }

  getBudgetUsedToday(binding: EveExternalActionBinding, currency: string): number {
    const policy = this.getPolicy(binding);
    if (!policy || policy.currency !== currency) return 0;
    const periods = zonedPeriodKeys(this.now(), policy.timezone);
    if (!periods) return 0;
    return this.budgetTotal(binding, currency, policy.timezone, 'day_id', periods.dayId) ?? Number.MAX_SAFE_INTEGER;
  }

  claim(input: ExternalActionClaimInput): ExternalActionClaimResult {
    if (
      !validBinding(input.binding) ||
      input.binding.installationId !== this.installationId ||
      !isEveOpaqueId(input.reservationId) ||
      !isEveOpaqueId(input.claimId) ||
      !isEveSha256Digest(input.claimDigest)
    ) {
      return { ok: false, execute: false, reasonCode: 'EXTERNAL_CLAIM_INVALID' };
    }
    const transaction = this.db.transaction((): ExternalActionClaimResult => {
      const policy = this.getPolicy(input.binding);
      if (!policy) return { ok: false, execute: false, reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' };
      if (policy.revokedAt) return { ok: false, execute: false, reasonCode: 'EXTERNAL_POLICY_REVOKED' };
      if (policy.killSwitch) return { ok: false, execute: false, reasonCode: 'EXTERNAL_POLICY_KILLED' };
      if (Date.parse(policy.expiresAt) <= this.now().getTime()) {
        return { ok: false, execute: false, reasonCode: 'EXTERNAL_POLICY_EXPIRED' };
      }
      if (policy.revision !== input.policyRevision || policy.sessionEpoch !== input.sessionEpoch) {
        return { ok: false, execute: false, reasonCode: 'EXTERNAL_POLICY_STALE' };
      }
      const nowIso = this.now().toISOString();
      const changed = this.db
        .prepare(
          `UPDATE external_action_reservations
           SET state = 'claimed', claim_id = ?, claim_digest = ?, claimed_at = ?
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND state = 'reserved' AND expires_at > ? AND policy_revision = ? AND session_epoch = ?`
        )
        .run(
          input.claimId,
          input.claimDigest,
          nowIso,
          input.reservationId,
          ...bindingArgs(input.binding),
          nowIso,
          input.policyRevision,
          input.sessionEpoch
        ).changes;
      if (changed === 1) {
        this.audit(input.binding, 'ledger.claimed', input.reservationId, { claim_id: input.claimId });
        return { ok: true, execute: true, state: 'claimed', reservationId: input.reservationId };
      }
      const existing = this.getReservation(input.binding, input.reservationId);
      return existing
        ? {
            ok: true,
            execute: false,
            state: existing.state,
            reservationId: existing.reservationId,
            replay: true,
            reasonCode: 'EXTERNAL_CLAIM_ALREADY_CONSUMED',
          }
        : { ok: false, execute: false, reasonCode: 'EXTERNAL_RESERVATION_NOT_FOUND' };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, execute: false, reasonCode: 'EXTERNAL_CLAIM_FAILED' };
    }
  }

  /**
   * Final Main-side fence immediately before an adapter call. It re-reads the
   * current policy and the exact claimed operation in one transaction; durable
   * jobs and stale renderer requests never carry authority across a revoke,
   * expiry, origin change or seat/policy switch.
   */
  private reservationMatchesExecutionIdentity(
    reservation: ExternalActionLedgerRecord,
    policy: EveExternalActionPolicy,
    expected: ExternalActionExecutionContractIdentity
  ): boolean {
    const origin = normalizeEveExternalOrigin(expected.targetOrigin);
    const origins = executionOrigins(expected);
    const periodsConsistent = zonedPeriodKeysConsistent({
      timezone: reservation.timezone,
      created_at: reservation.createdAt,
      day_id: reservation.dayId,
      month_id: reservation.monthId,
      day_start_at: reservation.dayStartAt,
      day_end_at: reservation.dayEndAt,
      month_start_at: reservation.monthStartAt,
      month_end_at: reservation.monthEndAt,
    });
    return Boolean(
      origin &&
      expected.installationId === reservation.binding.installationId &&
      expected.accountId === reservation.binding.accountId &&
      expected.seedId === reservation.binding.seedId &&
      reservation.conversationId === expected.conversationId &&
      reservation.conversationSessionId === expected.conversationSessionId &&
      reservation.adapterId === expected.adapterId &&
      reservation.authMode === expected.authMode &&
      reservation.adapterDomain === expected.domain &&
      reservation.adapterAction === expected.domainAction &&
      reservation.counterpartyId === expected.counterpartyId &&
      reservation.providerOrMerchantLabelCode === expected.providerOrMerchantLabelCode &&
      origins !== null &&
      canonical(reservation.adapterOrigins) === canonical(origins) &&
      canonical(reservation.slotManifest) === canonical(expected.slotManifest) &&
      reservation.adapterPayloadRef === expected.adapterPayloadRef &&
      reservation.adapterPayloadDigest === expected.adapterPayloadDigest &&
      reservation.adapterPayloadProductCount === expected.adapterPayloadProductCount &&
      reservation.cartDigest === expected.cartDigest &&
      reservation.policyRevision === policy.revision &&
      reservation.sessionEpoch === policy.sessionEpoch &&
      reservation.policyRevision === expected.policyRevision &&
      reservation.sessionEpoch === expected.sessionEpoch &&
      reservation.intentId === expected.intentId &&
      reservation.requestId === expected.requestId &&
      reservation.operationDigest === expected.operationDigest &&
      reservation.idempotencyKeyDigest === expected.idempotencyKeyDigest &&
      reservation.executionContractDigest === expected.executionContractDigest &&
      reservation.authorityGrantId === expected.authorityGrantId &&
      reservation.authorityReceiptDigest === expected.authorityReceiptDigest &&
      reservation.classificationDigest === expected.classificationDigest &&
      reservation.quoteDigest === expected.quoteDigest &&
      reservation.actionKind === expected.actionKind &&
      reservation.targetOrigin === origin &&
      reservation.amountMinor === expected.amountMinor &&
      reservation.currency === expected.currency &&
      Date.parse(reservation.expiresAt) > this.now().getTime() &&
      periodsConsistent
    );
  }

  private validateClaimForExecution(
    binding: EveExternalActionBinding,
    reservationId: string,
    claimId: string,
    expected: ExternalActionExecutionContractExpectation
  ): { ok: true } | { ok: false; reasonCode: string } {
    const origin = normalizeEveExternalOrigin(expected.targetOrigin);
    const origins = executionOrigins(expected);
    if (
      !validExecutionExpectation(expected) ||
      !origin ||
      expected.installationId !== binding.installationId ||
      expected.accountId !== binding.accountId ||
      expected.seedId !== binding.seedId ||
      expected.reservationId !== reservationId ||
      expected.claimId !== claimId
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_EXECUTION_CONTRACT_INVALID' };
    }
    const policy = this.getPolicy(binding);
    if (!policy) return { ok: false, reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' };
    if (policy.revokedAt) return { ok: false, reasonCode: 'EXTERNAL_POLICY_REVOKED' };
    if (policy.killSwitch) return { ok: false, reasonCode: 'EXTERNAL_POLICY_KILLED' };
    if (Date.parse(policy.expiresAt) <= this.now().getTime()) {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_EXPIRED' };
    }
    if (
      !policy.allowedActionKinds.includes(expected.actionKind) ||
      !policy.allowedOrigins.includes(origin) ||
      !origins ||
      origins.some((expectedOrigin) => !policy.allowedOrigins.includes(expectedOrigin))
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_POLICY_SCOPE_BLOCKED' };
    }
    const reservation = this.getReservation(binding, reservationId);
    if (!reservation || !['claimed', 'resuming'].includes(reservation.state) || reservation.claimId !== claimId) {
      return { ok: false, reasonCode: 'EXTERNAL_EXECUTION_CLAIM_NOT_ACTIVE' };
    }
    // Recompute the claim-bound digests from the persisted row. Field equality
    // alone proves nothing about digests that were never recomputed.
    const recomputedClaimDigest = externalActionClaimDigest({
      executionContractDigest: reservation.executionContractDigest,
      reservationId: reservation.reservationId,
      claimId,
    });
    const recomputedExpectationDigest = externalActionExpectationDigest({
      executionContractDigest: reservation.executionContractDigest,
      reservationId: reservation.reservationId,
      claimId,
      claimDigest: reservation.claimDigest,
    });
    if (
      reservation.claimDigest !== expected.claimDigest ||
      recomputedClaimDigest !== expected.claimDigest ||
      recomputedExpectationDigest !== expected.expectationDigest ||
      !this.reservationMatchesExecutionIdentity(reservation, policy, expected)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_EXECUTION_CONTRACT_STALE' };
    }
    return { ok: true };
  }

  recheckClaimForExecution(
    binding: EveExternalActionBinding,
    reservationId: string,
    claimId: string,
    expected: ExternalActionExecutionContractExpectation
  ): { ok: true } | { ok: false; reasonCode: string } {
    if (
      !validBinding(binding) ||
      binding.installationId !== this.installationId ||
      !isEveOpaqueId(reservationId) ||
      !isEveOpaqueId(claimId) ||
      !validExecutionExpectation(expected)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_EXECUTION_CLAIM_INVALID' };
    }
    const transaction = this.db.transaction(() =>
      this.validateClaimForExecution(binding, reservationId, claimId, expected)
    );
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_EXECUTION_RECHECK_FAILED' };
    }
  }

  activateResumedClaim(
    binding: EveExternalActionBinding,
    reservationId: string,
    claimId: string,
    expected: ExternalActionExecutionContractExpectation
  ): { ok: true } | { ok: false; reasonCode: string } {
    const transaction = this.db.transaction((): { ok: true } | { ok: false; reasonCode: string } => {
      const preflight = this.validateClaimForExecution(binding, reservationId, claimId, expected);
      if ('reasonCode' in preflight) return preflight;
      const reservation = this.getReservation(binding, reservationId);
      if (reservation?.state === 'claimed') return { ok: true };
      const changed = this.db
        .prepare(
          `UPDATE external_action_reservations SET state = 'claimed'
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND claim_id = ? AND claim_digest = ? AND state = 'resuming'`
        )
        .run(reservationId, ...bindingArgs(binding), claimId, expected.claimDigest).changes;
      return changed === 1 ? { ok: true } : { ok: false, reasonCode: 'EXTERNAL_RESUME_CONTRACT_STALE' };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_RESUME_ACTIVATION_FAILED' };
    }
  }

  suspendForUser(
    input: ExternalActionChallengeSuspendInput
  ): { ok: true; record: ExternalActionChallengeSuspendResult } | { ok: false; reasonCode: string } {
    const now = this.now();
    const parsedProposal = validateEveExternalActionProposal(input.proposal);
    if (
      !validBinding(input.binding) ||
      input.binding.installationId !== this.installationId ||
      !isEveOpaqueId(input.reservationId) ||
      !isEveOpaqueId(input.claimId) ||
      !validExecutionExpectation(input.executionContract) ||
      !validChallenge(input.challenge, now.getTime()) ||
      input.challenge.origin !== challengeOriginForExecution(input.executionContract, input.challenge.kind) ||
      'reasonCode' in parsedProposal ||
      parsedProposal.value.action.adapterPayload !== undefined ||
      !isEveOpaqueId(input.adapterId) ||
      !isEveOpaqueId(input.resumeRef) ||
      !AUTH_MODES.has(input.authMode) ||
      !isEveOpaqueId(input.continuationRef) ||
      !['pre_execute_probe', 'adapter_resume'].includes(input.continuation)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_INVALID' };
    }
    const transaction = this.db.transaction(
      (): { ok: true; record: ExternalActionChallengeSuspendResult } | { ok: false; reasonCode: string } => {
        const preflight = this.validateClaimForExecution(
          input.binding,
          input.reservationId,
          input.claimId,
          input.executionContract
        );
        if ('reasonCode' in preflight) return preflight;
        const policy = this.getPolicy(input.binding);
        const reservation = this.getReservation(input.binding, input.reservationId);
        if (!policy || !reservation) return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_CONTRACT_STALE' };
        if (
          Date.parse(input.challenge.expiresAt) > Date.parse(policy.expiresAt) ||
          Date.parse(input.challenge.expiresAt) > Date.parse(reservation.expiresAt)
        ) {
          return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_EXPIRY_INVALID' };
        }
        const previous = this.db
          .prepare('SELECT challenge_sequence, status FROM external_action_challenges WHERE reservation_id = ?')
          .get(input.reservationId) as { challenge_sequence?: unknown; status?: unknown } | undefined;
        if (
          previous &&
          (!Number.isSafeInteger(previous.challenge_sequence) ||
            (previous.challenge_sequence as number) < 1 ||
            !['consumed', 'invalidated'].includes(String(previous.status)))
        ) {
          return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_CONTRACT_STALE' };
        }
        const sequence = previous ? (previous.challenge_sequence as number) + 1 : 1;
        const snapshot: ExternalActionChallengeSnapshot = {
          version: 'command-eve-external-action-challenge-snapshot/v1',
          adapterId: input.adapterId,
          authMode: input.authMode,
          continuation: input.continuation,
          continuationRef: input.continuationRef,
          proposal: parsedProposal.value,
          challenge: input.challenge,
          sequence,
        };
        const envelope = {
          version: 'command-eve-external-action-challenge-envelope/v1',
          binding: input.binding,
          reservationId: input.reservationId,
          claimId: input.claimId,
          executionContract: input.executionContract,
          snapshot,
        };
        const snapshotJson = canonical(envelope);
        const snapshotDigest = sha256(snapshotJson);
        const resumeToken = `resume:${this.randomUUID()}`;
        const resumeTokenDigest = sha256(resumeToken);
        const origins = executionOrigins(input.executionContract);
        if (!origins) return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_CONTRACT_STALE' };
        const eventReceipt = {
          version: EVE_EXTERNAL_ACTION_EVENT_RECEIPT_VERSION,
          event: 'needs_user',
          eventRef: `event:${this.randomUUID()}`,
          operationRef: `operation:${input.executionContract.operationDigest.slice(
            'sha256:'.length,
            'sha256:'.length + 48
          )}`,
          reservationRef: input.reservationId,
          authMode: input.authMode,
          accountRef: `account:${sha256(input.binding.accountId).slice('sha256:'.length, 'sha256:'.length + 48)}`,
          seedRef: `seed:${sha256(input.binding.seedId).slice('sha256:'.length, 'sha256:'.length + 48)}`,
          domain: input.executionContract.domain,
          action: input.executionContract.domainAction,
          origins,
          challengeKind: input.challenge.kind,
          challengeRef: input.challenge.challengeRef,
          instructionCode: input.challenge.userInstructionCode,
          challengeOrigin: input.challenge.origin,
          resumeRef: input.resumeRef,
          expiresAt: input.challenge.expiresAt,
          occurredAt: now.toISOString(),
        } as unknown as EveExternalActionEventReceiptV0;
        const eventJson = canonical(eventReceipt);
        const eventDigest = sha256(eventJson);
        const changed = this.db
          .prepare(
            `UPDATE external_action_reservations
             SET state = 'suspended'
             WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
               AND state IN ('claimed', 'resuming') AND claim_id = ? AND claim_digest = ?`
          )
          .run(
            input.reservationId,
            ...bindingArgs(input.binding),
            input.claimId,
            input.executionContract.claimDigest
          ).changes;
        if (changed !== 1) return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_CONTRACT_STALE' };
        this.db
          .prepare(
            `INSERT INTO external_action_event_receipts (
               event_ref, reservation_id, challenge_sequence, event_json, event_digest, occurred_at
             ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(eventReceipt.eventRef, input.reservationId, sequence, eventJson, eventDigest, eventReceipt.occurredAt);
        this.db
          .prepare(
            `INSERT INTO external_action_challenges (
               reservation_id, installation_id, account_id, seed_id, resume_ref, event_ref, resume_token_digest,
               snapshot_json, snapshot_digest, challenge_sequence, status,
               completion_attestation_digest, created_at, consumed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)
             ON CONFLICT (reservation_id) DO UPDATE SET
               installation_id = excluded.installation_id,
               account_id = excluded.account_id,
               seed_id = excluded.seed_id,
               resume_ref = excluded.resume_ref,
               event_ref = excluded.event_ref,
               resume_token_digest = excluded.resume_token_digest,
               snapshot_json = excluded.snapshot_json,
               snapshot_digest = excluded.snapshot_digest,
               challenge_sequence = excluded.challenge_sequence,
               status = 'pending',
               completion_attestation_digest = NULL,
               created_at = excluded.created_at,
               consumed_at = NULL`
          )
          .run(
            input.reservationId,
            ...bindingArgs(input.binding),
            input.resumeRef,
            eventReceipt.eventRef,
            resumeTokenDigest,
            snapshotJson,
            snapshotDigest,
            sequence,
            now.toISOString()
          );
        this.audit(input.binding, 'challenge.suspended', input.reservationId, {
          challenge_kind: input.challenge.kind,
          challenge_ref: input.challenge.challengeRef,
          challenge_origin: input.challenge.origin,
          auth_origins_digest: input.executionContract.authOriginsDigest ?? null,
          expires_at: input.challenge.expiresAt,
        });
        return {
          ok: true,
          record: {
            reservationId: input.reservationId,
            claimId: input.claimId,
            executionContract: input.executionContract,
            snapshot,
            eventReceipt,
            resumeToken,
          },
        };
      }
    );
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_PERSIST_FAILED' };
    }
  }

  getPendingChallenge(binding: EveExternalActionBinding, reservationId: string): ExternalActionChallengeRecord | null {
    if (!validBinding(binding) || binding.installationId !== this.installationId || !isEveOpaqueId(reservationId)) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT challenge.*, event.event_json, event.event_digest
         FROM external_action_challenges challenge
         INNER JOIN external_action_event_receipts event ON event.event_ref = challenge.event_ref
         WHERE challenge.reservation_id = ?
           AND challenge.installation_id = ? AND challenge.account_id = ? AND challenge.seed_id = ?
           AND challenge.status = 'pending'
         LIMIT 1`
      )
      .get(reservationId, ...bindingArgs(binding)) as ChallengeRow | undefined;
    return this.challengeFromRow(row);
  }

  getPendingChallengeByTokenDigest(
    binding: EveExternalActionBinding,
    resumeTokenDigest: string
  ): ExternalActionChallengeRecord | null {
    if (
      !validBinding(binding) ||
      binding.installationId !== this.installationId ||
      !isEveSha256Digest(resumeTokenDigest)
    ) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT challenge.*, event.event_json, event.event_digest
         FROM external_action_challenges challenge
         INNER JOIN external_action_event_receipts event ON event.event_ref = challenge.event_ref
         WHERE challenge.resume_token_digest = ?
           AND challenge.installation_id = ? AND challenge.account_id = ? AND challenge.seed_id = ?
           AND challenge.status = 'pending'`
      )
      .get(resumeTokenDigest, ...bindingArgs(binding)) as ChallengeRow | undefined;
    return this.challengeFromRow(row);
  }

  resumeChallenge(
    input: ExternalActionChallengeResumeInput
  ): { ok: true; record: ExternalActionChallengeRecord } | { ok: false; reasonCode: string } {
    if (
      !validBinding(input.binding) ||
      input.binding.installationId !== this.installationId ||
      !isEveOpaqueId(input.conversationId) ||
      !isEveOpaqueId(input.conversationSessionId) ||
      !isEveSha256Digest(input.resumeTokenDigest) ||
      !isEveSha256Digest(input.completionAttestationDigest)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_RESUME_INVALID' };
    }
    const transaction = this.db.transaction(
      (): { ok: true; record: ExternalActionChallengeRecord } | { ok: false; reasonCode: string } => {
        const row = this.db
          .prepare(
            `SELECT challenge.*, event.event_json, event.event_digest
             FROM external_action_challenges challenge
             INNER JOIN external_action_event_receipts event ON event.event_ref = challenge.event_ref
             WHERE challenge.resume_token_digest = ?
               AND challenge.installation_id = ? AND challenge.account_id = ? AND challenge.seed_id = ?
               AND challenge.status = 'pending'`
          )
          .get(input.resumeTokenDigest, ...bindingArgs(input.binding)) as ChallengeRow | undefined;
        const challenge = this.challengeFromRow(row);
        if (!row || !challenge) return { ok: false, reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' };
        const policy = this.getPolicy(input.binding);
        if (!policy) return { ok: false, reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' };
        if (policy.revokedAt) return { ok: false, reasonCode: 'EXTERNAL_POLICY_REVOKED' };
        if (policy.killSwitch) return { ok: false, reasonCode: 'EXTERNAL_POLICY_KILLED' };
        const now = this.now();
        if (
          Date.parse(policy.expiresAt) <= now.getTime() ||
          Date.parse(challenge.snapshot.challenge.expiresAt) <= now.getTime()
        ) {
          const changed = this.db
            .prepare(
              `UPDATE external_action_reservations SET state = 'expired', terminal_at = ?, outcome_digest = ?
               WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
                 AND state = 'suspended'`
            )
            .run(
              now.toISOString(),
              sha256('EXTERNAL_CHALLENGE_EXPIRED'),
              challenge.reservationId,
              ...bindingArgs(input.binding)
            ).changes;
          if (changed === 1) {
            const terminal = this.getReservation(input.binding, challenge.reservationId);
            if (!terminal || terminal.state !== 'expired') throw new Error('EXTERNAL_REVERSAL_PERSIST_FAILED');
            this.persistTerminalReceipt(terminal, now.toISOString(), { reasonCode: 'EXPIRED' });
          }
          this.db
            .prepare(
              `UPDATE external_action_challenges SET status = 'invalidated', consumed_at = ?
               WHERE reservation_id = ? AND status = 'pending'`
            )
            .run(now.toISOString(), challenge.reservationId);
          return { ok: false, reasonCode: 'EXTERNAL_CHALLENGE_EXPIRED' };
        }
        const reservation = this.getReservation(input.binding, challenge.reservationId);
        if (
          !reservation ||
          reservation.state !== 'suspended' ||
          reservation.conversationId !== input.conversationId ||
          reservation.conversationSessionId !== input.conversationSessionId ||
          reservation.claimId !== challenge.claimId ||
          reservation.claimDigest !== challenge.executionContract.claimDigest ||
          challenge.snapshot.challenge.origin !==
            challengeOriginForExecution(challenge.executionContract, challenge.snapshot.challenge.kind) ||
          !this.reservationMatchesExecutionIdentity(reservation, policy, challenge.executionContract)
        ) {
          return { ok: false, reasonCode: 'EXTERNAL_RESUME_CONTRACT_STALE' };
        }
        const challengeChanged = this.db
          .prepare(
            `UPDATE external_action_challenges
             SET status = 'consumed', completion_attestation_digest = ?, consumed_at = ?
             WHERE resume_token_digest = ? AND status = 'pending'`
          )
          .run(input.completionAttestationDigest, now.toISOString(), input.resumeTokenDigest).changes;
        if (challengeChanged !== 1) return { ok: false, reasonCode: 'EXTERNAL_RESUME_ALREADY_CONSUMED' };
        const reservationChanged = this.db
          .prepare(
            `UPDATE external_action_reservations
             SET state = 'resuming', claimed_at = ?
             WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
               AND state = 'suspended' AND claim_id = ? AND claim_digest = ?`
          )
          .run(
            now.toISOString(),
            challenge.reservationId,
            ...bindingArgs(input.binding),
            challenge.claimId,
            challenge.executionContract.claimDigest
          ).changes;
        if (reservationChanged !== 1) throw new Error('EXTERNAL_RESUME_CONTRACT_STALE');
        this.audit(input.binding, 'challenge.resumed', challenge.reservationId, {
          challenge_kind: challenge.snapshot.challenge.kind,
          challenge_ref: challenge.snapshot.challenge.challengeRef,
          sequence: challenge.snapshot.sequence,
        });
        return { ok: true, record: challenge };
      }
    );
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_RESUME_PERSIST_FAILED' };
    }
  }

  private challengeFromRow(row: ChallengeRow | undefined): ExternalActionChallengeRecord | null {
    if (!row) return null;
    const eventReceipt = eventReceiptFromRow(row);
    let envelope: unknown;
    try {
      envelope = JSON.parse(row.snapshot_json);
    } catch {
      return null;
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
    const value = envelope as Record<string, unknown>;
    const binding = value.binding as EveExternalActionBinding | undefined;
    const executionContract = value.executionContract as ExternalActionExecutionContractExpectation | undefined;
    const rawSnapshot = value.snapshot as Partial<ExternalActionChallengeSnapshot> | undefined;
    const parsedProposal = validateEveExternalActionProposal(rawSnapshot?.proposal);
    const snapshot = rawSnapshot
      ? ({
          ...rawSnapshot,
          ...('reasonCode' in parsedProposal ? {} : { proposal: parsedProposal.value }),
        } as ExternalActionChallengeSnapshot)
      : undefined;
    if (
      !isEveOpaqueId(row.reservation_id) ||
      !isEveOpaqueId(row.resume_ref) ||
      !isEveOpaqueId(row.event_ref) ||
      !isEveSha256Digest(row.resume_token_digest) ||
      !isEveSha256Digest(row.snapshot_digest) ||
      canonical(envelope) !== row.snapshot_json ||
      sha256(row.snapshot_json) !== row.snapshot_digest ||
      !hasExactRecordKeys(value, ['version', 'binding', 'reservationId', 'claimId', 'executionContract', 'snapshot']) ||
      value.version !== 'command-eve-external-action-challenge-envelope/v1' ||
      !binding ||
      !hasExactRecordKeys(binding, ['installationId', 'accountId', 'seedId']) ||
      !validBinding(binding) ||
      binding.installationId !== row.installation_id ||
      binding.accountId !== row.account_id ||
      binding.seedId !== row.seed_id ||
      value.reservationId !== row.reservation_id ||
      !isEveOpaqueId(value.claimId) ||
      !executionContract ||
      !validExecutionExpectation(executionContract) ||
      !snapshot ||
      !hasExactRecordKeys(rawSnapshot, [
        'version',
        'adapterId',
        'authMode',
        'continuation',
        'continuationRef',
        'proposal',
        'challenge',
        'sequence',
      ]) ||
      snapshot.version !== 'command-eve-external-action-challenge-snapshot/v1' ||
      !isEveOpaqueId(snapshot.adapterId) ||
      !AUTH_MODES.has(snapshot.authMode) ||
      !['pre_execute_probe', 'adapter_resume'].includes(snapshot.continuation) ||
      !isEveSanitizedOpaqueRef(snapshot.continuationRef) ||
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence !== row.challenge_sequence ||
      'reasonCode' in parsedProposal ||
      !validChallenge(snapshot.challenge, Number.NEGATIVE_INFINITY) ||
      snapshot.challenge.origin !== challengeOriginForExecution(executionContract, snapshot.challenge.kind) ||
      !eventReceipt ||
      eventReceipt.reservationRef !== row.reservation_id ||
      eventReceipt.resumeRef !== row.resume_ref ||
      eventReceipt.authMode !== snapshot.authMode ||
      eventReceipt.accountRef !==
        `account:${sha256(binding.accountId).slice('sha256:'.length, 'sha256:'.length + 48)}` ||
      eventReceipt.seedRef !== `seed:${sha256(binding.seedId).slice('sha256:'.length, 'sha256:'.length + 48)}` ||
      eventReceipt.domain !== executionContract.domain ||
      eventReceipt.action !== executionContract.domainAction ||
      canonical(eventReceipt.origins) !== canonical(executionOrigins(executionContract)) ||
      eventReceipt.challengeKind !== snapshot.challenge.kind ||
      eventReceipt.challengeRef !== snapshot.challenge.challengeRef ||
      eventReceipt.instructionCode !== snapshot.challenge.userInstructionCode ||
      eventReceipt.challengeOrigin !== snapshot.challenge.origin ||
      eventReceipt.expiresAt !== snapshot.challenge.expiresAt ||
      (row.status !== 'pending' && row.status !== 'consumed' && row.status !== 'invalidated') ||
      (row.completion_attestation_digest !== null && !isEveSha256Digest(row.completion_attestation_digest)) ||
      typeof row.created_at !== 'string' ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      (row.consumed_at !== null && !Number.isFinite(Date.parse(row.consumed_at)))
    ) {
      return null;
    }
    return {
      reservationId: row.reservation_id,
      claimId: value.claimId as string,
      executionContract,
      snapshot,
      eventReceipt,
    };
  }

  markAllowed(input: ExternalActionTerminalInput): ExternalActionReservationResult {
    return this.transitionClaimed(input, 'allowed', 'ledger.allowed');
  }

  markUnknown(input: ExternalActionTerminalInput): ExternalActionReservationResult {
    return this.transitionClaimed(input, 'unknown', 'ledger.unknown');
  }

  private transitionClaimed(
    input: ExternalActionTerminalInput,
    state: 'allowed' | 'unknown',
    eventType: string
  ): ExternalActionReservationResult {
    if (!validBinding(input.binding) || !isEveSha256Digest(input.outcomeDigest) || !AUTH_MODES.has(input.authMode)) {
      return { ok: false, reasonCode: 'EXTERNAL_OUTCOME_INVALID' };
    }
    const transaction = this.db.transaction((): ExternalActionReservationResult => {
      const changed = this.db
        .prepare(
          `UPDATE external_action_reservations
           SET state = ?, terminal_at = ?, outcome_digest = ?
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND claim_id = ? AND auth_mode = ? AND state IN ('claimed', 'resuming')`
        )
        .run(
          state,
          this.now().toISOString(),
          input.outcomeDigest,
          input.reservationId,
          ...bindingArgs(input.binding),
          input.claimId,
          input.authMode
        ).changes;
      if (changed === 1) {
        const terminal = this.getReservation(input.binding, input.reservationId);
        if (!terminal || terminal.state !== state) throw new Error('EXTERNAL_OUTCOME_PERSIST_FAILED');
        const receipt = this.persistTerminalReceipt(terminal, this.now().toISOString(), {
          ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
          ...(input.result ? { result: input.result } : {}),
        });
        this.audit(input.binding, eventType, input.reservationId, { outcome_digest: input.outcomeDigest });
        return { ok: true, state, reservationId: input.reservationId, receipt };
      }
      const existing = this.getReservation(input.binding, input.reservationId);
      return existing
        ? {
            ok: true,
            state: existing.state,
            reservationId: existing.reservationId,
            replay: true,
            ...(this.getReceipt(input.binding, input.reservationId)
              ? { receipt: this.getReceipt(input.binding, input.reservationId)! }
              : {}),
          }
        : { ok: false, reasonCode: 'EXTERNAL_RESERVATION_NOT_FOUND' };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_OUTCOME_PERSIST_FAILED' };
    }
  }

  reverse(input: ExternalActionTerminalInput): ExternalActionReservationResult {
    const terminalState = input.terminalState ?? 'reversed';
    if (
      !validBinding(input.binding) ||
      !isEveSha256Digest(input.outcomeDigest) ||
      !AUTH_MODES.has(input.authMode) ||
      !['reversed', 'denied', 'revoked', 'expired'].includes(terminalState)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_REVERSAL_INVALID' };
    }
    const transaction = this.db.transaction((): ExternalActionReservationResult => {
      const changed = this.db
        .prepare(
          `UPDATE external_action_reservations
           SET state = ?, terminal_at = ?, outcome_digest = ?
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND (claim_id = ? OR (claim_id IS NULL AND ? = '')) AND auth_mode = ?
             AND state IN ('reserved', 'claimed', 'suspended', 'resuming')`
        )
        .run(
          terminalState,
          this.now().toISOString(),
          input.outcomeDigest,
          input.reservationId,
          ...bindingArgs(input.binding),
          input.claimId,
          input.claimId,
          input.authMode
        ).changes;
      if (changed === 1) {
        const terminal = this.getReservation(input.binding, input.reservationId);
        if (!terminal || terminal.state !== terminalState) throw new Error('EXTERNAL_REVERSAL_PERSIST_FAILED');
        const receipt = this.persistTerminalReceipt(
          terminal,
          this.now().toISOString(),
          input.reasonCode ? { reasonCode: input.reasonCode } : {}
        );
        this.audit(input.binding, `ledger.${terminalState}`, input.reservationId, {
          outcome_digest: input.outcomeDigest,
        });
        return { ok: true, state: terminalState, reservationId: input.reservationId, receipt };
      }
      const existing = this.getReservation(input.binding, input.reservationId);
      return existing
        ? {
            ok: true,
            state: existing.state,
            reservationId: existing.reservationId,
            replay: true,
            ...(this.getReceipt(input.binding, input.reservationId)
              ? { receipt: this.getReceipt(input.binding, input.reservationId)! }
              : {}),
          }
        : { ok: false, reasonCode: 'EXTERNAL_RESERVATION_NOT_FOUND' };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_REVERSAL_PERSIST_FAILED' };
    }
  }

  getReservation(binding: EveExternalActionBinding, reservationId: string): ExternalActionLedgerRecord | null {
    if (!validBinding(binding) || !isEveOpaqueId(reservationId)) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM external_action_reservations
         WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?`
      )
      .get(reservationId, ...bindingArgs(binding)) as LedgerRow | undefined;
    return ledgerFromRow(row);
  }

  getReceipt(binding: EveExternalActionBinding, reservationId: string): EveExternalActionReceiptV0 | null {
    if (!validBinding(binding) || binding.installationId !== this.installationId || !isEveOpaqueId(reservationId)) {
      return null;
    }
    const reservation = this.getReservation(binding, reservationId);
    const expectedOutcome = reservation ? receiptOutcomeForLedgerState(reservation.state) : null;
    if (!reservation || !expectedOutcome) return null;
    const row = this.db
      .prepare(
        `SELECT receipt.* FROM external_action_receipts receipt
         INNER JOIN external_action_reservations reservation
           ON reservation.reservation_id = receipt.reservation_id
         WHERE receipt.reservation_id = ? AND receipt.outcome = ?
           AND reservation.installation_id = ? AND reservation.account_id = ? AND reservation.seed_id = ?`
      )
      .get(reservationId, expectedOutcome, ...bindingArgs(binding)) as ReceiptRow | undefined;
    const receipt = receiptFromRow(row);
    if (!receipt) return null;
    return receipt.outcome === expectedOutcome &&
      receipt.operationRef ===
        `operation:${reservation.operationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}` &&
      receipt.authMode === reservation.authMode &&
      receipt.accountRef ===
        `account:${sha256(reservation.binding.accountId).slice('sha256:'.length, 'sha256:'.length + 48)}` &&
      receipt.seedRef === `seed:${sha256(reservation.binding.seedId).slice('sha256:'.length, 'sha256:'.length + 48)}` &&
      receipt.authorityReceiptDigest === reservation.authorityReceiptDigest &&
      receipt.policyRevision === reservation.policyRevision &&
      receipt.domain === reservation.adapterDomain &&
      receipt.action === reservation.adapterAction &&
      receipt.providerOrMerchantId === reservation.counterpartyId &&
      canonical(receipt.origins) === canonical(reservation.adapterOrigins) &&
      (reservation.amountMinor > 0
        ? receipt.amount?.currency === reservation.currency && receipt.amount.minorUnits === reservation.amountMinor
        : receipt.amount === undefined)
      ? receipt
      : null;
  }

  findUnknownByReconciliationRef(
    binding: EveExternalActionBinding,
    reconciliationRef: string
  ): { reservation: ExternalActionLedgerRecord; receipt: EveExternalActionReceiptV0 } | null {
    if (!validBinding(binding) || binding.installationId !== this.installationId || !isEveOpaqueId(reconciliationRef)) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT receipt.* FROM external_action_receipts receipt
         INNER JOIN external_action_reservations reservation
           ON reservation.reservation_id = receipt.reservation_id
         WHERE receipt.reconciliation_ref = ? AND receipt.outcome = 'unknown_outcome'
           AND reservation.state = 'unknown'
           AND reservation.installation_id = ? AND reservation.account_id = ? AND reservation.seed_id = ?`
      )
      .get(reconciliationRef, ...bindingArgs(binding)) as ReceiptRow | undefined;
    const receipt = receiptFromRow(row);
    const reservation = receipt ? this.getReservation(binding, receipt.reservationRef) : null;
    if (
      !receipt ||
      !reservation ||
      reservation.state !== 'unknown' ||
      receipt.reconciliationRef !== reconciliationRef ||
      receipt.operationRef !==
        `operation:${reservation.operationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}` ||
      receipt.domain !== reservation.adapterDomain ||
      receipt.action !== reservation.adapterAction ||
      receipt.providerOrMerchantId !== reservation.counterpartyId ||
      canonical(receipt.origins) !== canonical(reservation.adapterOrigins)
    ) {
      return null;
    }
    return { reservation, receipt };
  }

  reconcileUnknown(input: ExternalActionVerifiedReconciliationInput): ExternalActionReservationResult {
    if (
      !validBinding(input.binding) ||
      input.binding.installationId !== this.installationId ||
      !isEveOpaqueId(input.reservationId) ||
      !isEveOpaqueId(input.reconciliationRef) ||
      !['reconciled_committed', 'reconciled_no_effect'].includes(input.decision) ||
      !isEveSha256Digest(input.evidenceDigest) ||
      !isEveSha256Digest(input.authorityReceiptDigest) ||
      !isEveOpaqueId(input.actorRef) ||
      (input.decision === 'reconciled_committed' && !input.result) ||
      (input.decision === 'reconciled_no_effect' && input.result !== undefined)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_RECONCILIATION_INVALID' };
    }
    const transaction = this.db.transaction((): ExternalActionReservationResult => {
      const original = this.findUnknownByReconciliationRef(input.binding, input.reconciliationRef);
      if (!original || original.reservation.reservationId !== input.reservationId) {
        return { ok: false, reasonCode: 'EXTERNAL_RECONCILIATION_NOT_ACTIVE' };
      }
      const nowIso = this.now().toISOString();
      const changed = this.db
        .prepare(
          `UPDATE external_action_reservations SET state = ?, terminal_at = ?, outcome_digest = ?
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND state = 'unknown'`
        )
        .run(input.decision, nowIso, input.evidenceDigest, input.reservationId, ...bindingArgs(input.binding)).changes;
      if (changed !== 1) return { ok: false, reasonCode: 'EXTERNAL_RECONCILIATION_NOT_ACTIVE' };
      const terminal = this.getReservation(input.binding, input.reservationId);
      if (!terminal || terminal.state !== input.decision) throw new Error('EXTERNAL_RECONCILIATION_PERSIST_FAILED');
      const receipt = this.persistTerminalReceipt(terminal, nowIso, {
        ...(input.result ? { result: input.result } : {}),
        reconciliation: {
          reconciliationRef: input.reconciliationRef,
          priorReceiptRef: original.receipt.receiptRef,
          evidenceDigest: input.evidenceDigest,
          authorityReceiptDigest: input.authorityReceiptDigest,
          actorRef: input.actorRef,
        },
      });
      this.audit(input.binding, 'ledger.reconciled', input.reservationId, {
        decision: input.decision,
        evidence_digest: input.evidenceDigest,
        authority_receipt_digest: input.authorityReceiptDigest,
        actor_ref: input.actorRef,
      });
      return { ok: true, state: input.decision, reservationId: input.reservationId, receipt };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_RECONCILIATION_PERSIST_FAILED' };
    }
  }

  registerSecretHandle(input: ExternalSecretHandleInput): { ok: true } | { ok: false; reasonCode: string } {
    if (
      !validBinding(input.binding) ||
      input.binding.installationId !== this.installationId ||
      !isEveOpaqueId(input.handleId) ||
      !isEveSecretHandleType(input.type) ||
      !isEveSecretHandleSource(input.source) ||
      !validSourceRef(input.source, input.sourceRef) ||
      !handleTypeAllowsSource(input.type, input.source) ||
      input.actionKinds.length === 0 ||
      !input.actionKinds.every(isEveExternalActionKind)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_INVALID' };
    }
    const targetOrigins: string[] = [];
    for (const raw of input.targetOrigins) {
      const origin = normalizeEveExternalOrigin(raw);
      if (!origin) return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_ORIGIN_INVALID' };
      if (!targetOrigins.includes(origin)) targetOrigins.push(origin);
    }
    if (targetOrigins.length === 0) return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_SCOPE_EMPTY' };
    const expiresMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= this.now().getTime()) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_EXPIRY_INVALID' };
    }
    try {
      this.db
        .prepare(
          `INSERT INTO external_secret_handles (
             installation_id, account_id, seed_id, handle_id, type, source, source_ref,
             action_kinds_json, domains_json, expires_at, revoked_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT (installation_id, account_id, seed_id, handle_id) DO UPDATE SET
             type = excluded.type,
             source = excluded.source,
             source_ref = excluded.source_ref,
             action_kinds_json = excluded.action_kinds_json,
             domains_json = excluded.domains_json,
             expires_at = excluded.expires_at,
             revoked_at = NULL`
        )
        .run(
          ...bindingArgs(input.binding),
          input.handleId,
          input.type,
          input.source,
          input.sourceRef,
          JSON.stringify([...new Set(input.actionKinds)]),
          JSON.stringify(targetOrigins.toSorted()),
          new Date(expiresMs).toISOString(),
          this.now().toISOString()
        );
      this.audit(input.binding, 'secret_handle.registered', undefined, {
        handle_id: input.handleId,
        source: input.source,
      });
      return { ok: true };
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_PERSIST_FAILED' };
    }
  }

  getSecretHandle(binding: EveExternalActionBinding, handleId: string): ExternalSecretHandleRecord | null {
    if (!validBinding(binding) || !isEveOpaqueId(handleId)) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM external_secret_handles
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND handle_id = ?`
      )
      .get(...bindingArgs(binding), handleId) as SecretHandleRow | undefined;
    if (!row) return null;
    const actionKinds = parseStringArray(row.action_kinds_json);
    const targetOrigins = parseStringArray(row.domains_json);
    if (
      !validBinding({ installationId: row.installation_id, accountId: row.account_id, seedId: row.seed_id }) ||
      !isEveOpaqueId(row.handle_id) ||
      !isEveSecretHandleType(row.type) ||
      !isEveSecretHandleSource(row.source) ||
      !validSourceRef(row.source, row.source_ref) ||
      !handleTypeAllowsSource(row.type, row.source) ||
      !actionKinds ||
      !actionKinds.every(isEveExternalActionKind) ||
      !targetOrigins ||
      targetOrigins.length === 0 ||
      !targetOrigins.every((origin) => normalizeEveExternalOrigin(origin) === origin) ||
      typeof row.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(row.expires_at)) ||
      (row.revoked_at !== null && (typeof row.revoked_at !== 'string' || !Number.isFinite(Date.parse(row.revoked_at))))
    )
      return null;
    return {
      binding: {
        installationId: row.installation_id,
        accountId: row.account_id,
        seedId: row.seed_id,
      },
      handleId: row.handle_id,
      type: row.type,
      source: row.source,
      sourceRef: row.source_ref,
      actionKinds: actionKinds as EveExternalActionKind[],
      targetOrigins,
      expiresAt: row.expires_at,
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    };
  }

  registerSecretShareGrant(input: ExternalSecretShareGrantInput): { ok: true } | { ok: false; reasonCode: string } {
    if (
      !validBinding(input.ownerBinding) ||
      !validBinding(input.granteeBinding) ||
      input.ownerBinding.installationId !== this.installationId ||
      input.granteeBinding.installationId !== this.installationId ||
      !isEveOpaqueId(input.grantId) ||
      !isEveOpaqueId(input.handleId) ||
      !isEveExternalActionKind(input.actionKind)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_GRANT_INVALID' };
    }
    const origin = normalizeEveExternalOrigin(input.targetOrigin);
    const handle = this.getSecretHandle(input.ownerBinding, input.handleId);
    const expiresMs = Date.parse(input.expiresAt);
    if (
      !origin ||
      !handle ||
      handle.revokedAt ||
      handle.type === 'otp_code' ||
      !handle.actionKinds.includes(input.actionKind) ||
      !handle.targetOrigins.includes(origin) ||
      !Number.isFinite(expiresMs) ||
      expiresMs <= this.now().getTime() ||
      expiresMs > Date.parse(handle.expiresAt)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_GRANT_SCOPE_INVALID' };
    }
    try {
      this.db
        .prepare(
          `INSERT INTO external_secret_share_grants (
             grant_id, owner_installation_id, owner_account_id, owner_seed_id,
             grantee_installation_id, grantee_account_id, grantee_seed_id,
             handle_id, action_kind, target_origin, expires_at, revoked_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(
          input.grantId,
          ...bindingArgs(input.ownerBinding),
          ...bindingArgs(input.granteeBinding),
          input.handleId,
          input.actionKind,
          origin,
          new Date(expiresMs).toISOString(),
          this.now().toISOString()
        );
      this.audit(input.ownerBinding, 'secret_grant.registered', undefined, {
        grant_id: input.grantId,
        handle_id: input.handleId,
      });
      return { ok: true };
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_GRANT_PERSIST_FAILED' };
    }
  }

  revokeSecretShareGrant(
    ownerBinding: EveExternalActionBinding,
    grantId: string
  ): { ok: true } | { ok: false; reasonCode: string } {
    if (!validBinding(ownerBinding) || !isEveOpaqueId(grantId)) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_GRANT_INVALID' };
    }
    const changed = this.db
      .prepare(
        `UPDATE external_secret_share_grants SET revoked_at = ?
         WHERE grant_id = ? AND owner_installation_id = ? AND owner_account_id = ? AND owner_seed_id = ?
           AND revoked_at IS NULL`
      )
      .run(this.now().toISOString(), grantId, ...bindingArgs(ownerBinding)).changes;
    if (changed !== 1) return { ok: false, reasonCode: 'EXTERNAL_SECRET_GRANT_NOT_FOUND' };
    this.audit(ownerBinding, 'secret_grant.revoked', undefined, { grant_id: grantId });
    return { ok: true };
  }

  revokeSecretHandle(
    binding: EveExternalActionBinding,
    handleId: string
  ): { ok: true } | { ok: false; reasonCode: string } {
    if (!validBinding(binding) || !isEveOpaqueId(handleId)) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_INVALID' };
    }
    const nowIso = this.now().toISOString();
    const transaction = this.db.transaction((): boolean => {
      const changed = this.db
        .prepare(
          `UPDATE external_secret_handles SET revoked_at = ?
           WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND handle_id = ? AND revoked_at IS NULL`
        )
        .run(nowIso, ...bindingArgs(binding), handleId).changes;
      if (changed !== 1) return false;
      this.db
        .prepare(
          `UPDATE external_secret_share_grants SET revoked_at = ?
           WHERE owner_installation_id = ? AND owner_account_id = ? AND owner_seed_id = ?
             AND handle_id = ? AND revoked_at IS NULL`
        )
        .run(nowIso, ...bindingArgs(binding), handleId);
      return true;
    });
    try {
      if (!transaction()) return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_NOT_FOUND' };
      this.audit(binding, 'secret_handle.revoked', undefined, { handle_id: handleId });
      return { ok: true };
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_REVOKE_FAILED' };
    }
  }

  resolveSecretHandleAccess(
    binding: EveExternalActionBinding,
    handleId: string,
    actionKind: EveExternalActionKind,
    targetOrigin: string
  ): ExternalSecretHandleAccess | null {
    const origin = normalizeEveExternalOrigin(targetOrigin);
    if (!validBinding(binding) || !isEveOpaqueId(handleId) || !isEveExternalActionKind(actionKind) || !origin) {
      return null;
    }
    const own = this.getSecretHandle(binding, handleId);
    if (
      own &&
      !own.revokedAt &&
      Date.parse(own.expiresAt) > this.now().getTime() &&
      own.actionKinds.includes(actionKind) &&
      own.targetOrigins.includes(origin)
    ) {
      return own;
    }
    const grants = this.db
      .prepare(
        `SELECT * FROM external_secret_share_grants
         WHERE grantee_installation_id = ? AND grantee_account_id = ? AND grantee_seed_id = ?
           AND handle_id = ? AND action_kind = ? AND target_origin = ?
           AND revoked_at IS NULL AND expires_at > ?
         LIMIT 2`
      )
      .all(...bindingArgs(binding), handleId, actionKind, origin, this.now().toISOString()) as SecretShareGrantRow[];
    // A caller supplies only an opaque handle id, not an owner/grant selector.
    // Multiple matching owners are therefore ambiguous and must fail closed.
    if (grants.length !== 1) return null;
    const [grant] = grants;
    if (
      !isEveOpaqueId(grant.grant_id) ||
      !validBinding({
        installationId: grant.owner_installation_id,
        accountId: grant.owner_account_id,
        seedId: grant.owner_seed_id,
      }) ||
      !validBinding({
        installationId: grant.grantee_installation_id,
        accountId: grant.grantee_account_id,
        seedId: grant.grantee_seed_id,
      }) ||
      grant.grantee_installation_id !== binding.installationId ||
      grant.grantee_account_id !== binding.accountId ||
      grant.grantee_seed_id !== binding.seedId ||
      !isEveExternalActionKind(grant.action_kind) ||
      grant.action_kind !== actionKind ||
      normalizeEveExternalOrigin(grant.target_origin) !== origin ||
      typeof grant.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(grant.expires_at)) ||
      Date.parse(grant.expires_at) <= this.now().getTime() ||
      grant.revoked_at !== null
    ) {
      return null;
    }
    const ownerBinding: EveExternalActionBinding = {
      installationId: grant.owner_installation_id,
      accountId: grant.owner_account_id,
      seedId: grant.owner_seed_id,
    };
    const shared = this.getSecretHandle(ownerBinding, handleId);
    if (
      !shared ||
      shared.revokedAt ||
      Date.parse(shared.expiresAt) <= this.now().getTime() ||
      !shared.actionKinds.includes(actionKind) ||
      !shared.targetOrigins.includes(origin)
    ) {
      return null;
    }
    return { ...shared, accessGrantId: grant.grant_id };
  }

  registerSecretSlotPermit(input: ExternalSecretSlotPermitInput): { ok: true } | { ok: false; reasonCode: string } {
    const origin = normalizeEveExternalOrigin(input.executionContract.targetOrigin);
    if (
      !validBinding(input.binding) ||
      input.binding.installationId !== this.installationId ||
      !isEveOpaqueId(input.reservationId) ||
      !isEveOpaqueId(input.claimId) ||
      !isEveSecretFieldSlot(input.slot) ||
      !isEveOpaqueId(input.handleId) ||
      !isEveSecretHandleType(input.expectedHandleType) ||
      !eveSecretSlotAllowsHandleType(input.slot, input.expectedHandleType) ||
      !validExecutionExpectation(input.executionContract) ||
      !origin
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_INVALID' };
    }
    const transaction = this.db.transaction((): { ok: true } | { ok: false; reasonCode: string } => {
      const preflight = this.validateClaimForExecution(
        input.binding,
        input.reservationId,
        input.claimId,
        input.executionContract
      );
      if ('reasonCode' in preflight) return preflight;
      const handle = this.resolveSecretHandleAccess(
        input.binding,
        input.handleId,
        input.executionContract.actionKind,
        origin
      );
      if (!handle) return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_NOT_ACTIVE' };
      if (handle.type !== input.expectedHandleType || (handle.type === 'otp_code' && handle.accessGrantId)) {
        return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_TYPE_BLOCKED' };
      }
      const ordinal = input.executionContract.slotManifest.findIndex(
        (entry) =>
          entry.slot === input.slot &&
          entry.handleId === input.handleId &&
          entry.handleType === input.expectedHandleType
      );
      if (ordinal < 0) {
        return { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_NOT_IN_CONTRACT' };
      }
      const reservation = this.getReservation(input.binding, input.reservationId);
      if (!reservation || Date.parse(reservation.expiresAt) <= this.now().getTime()) {
        return { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_CONTRACT_STALE' };
      }
      const permitPreimage: ExternalSecretPermitDigestPreimage = {
        binding: input.binding,
        reservationId: input.reservationId,
        claimId: input.claimId,
        adapterId: input.executionContract.adapterId,
        slot: input.slot,
        handleId: input.handleId,
        handleType: input.expectedHandleType,
        actionKind: input.executionContract.actionKind,
        targetOrigin: origin,
        ordinal,
        expiresAt: reservation.expiresAt,
        executionContractDigest: input.executionContract.executionContractDigest,
      };
      const permitDigest = sha256(canonical(permitPreimage));
      const existing = this.db
        .prepare(
          `SELECT claim_id, adapter_id, handle_id, handle_type, action_kind, target_origin,
                    ordinal, expires_at, execution_contract_digest, permit_digest, status
             FROM external_action_secret_slot_permits WHERE reservation_id = ? AND slot = ?`
        )
        .get(input.reservationId, input.slot) as
        | {
            claim_id?: unknown;
            adapter_id?: unknown;
            handle_id?: unknown;
            handle_type?: unknown;
            action_kind?: unknown;
            target_origin?: unknown;
            ordinal?: unknown;
            expires_at?: unknown;
            execution_contract_digest?: unknown;
            permit_digest?: unknown;
            status?: unknown;
          }
        | undefined;
      if (existing) {
        return existing.claim_id === input.claimId &&
          existing.adapter_id === input.executionContract.adapterId &&
          existing.handle_id === input.handleId &&
          existing.handle_type === input.expectedHandleType &&
          existing.action_kind === input.executionContract.actionKind &&
          existing.target_origin === origin &&
          existing.ordinal === ordinal &&
          existing.expires_at === reservation.expiresAt &&
          existing.execution_contract_digest === input.executionContract.executionContractDigest &&
          existing.permit_digest === permitDigest &&
          existing.status === 'pending'
          ? { ok: true }
          : { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_CONFLICT' };
      }
      this.db
        .prepare(
          `INSERT INTO external_action_secret_slot_permits (
               reservation_id, installation_id, account_id, seed_id, claim_id, adapter_id, slot,
               handle_id, handle_type, action_kind, target_origin, ordinal, expires_at,
               execution_contract_digest, permit_digest, status, created_at, consumed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
        )
        .run(
          input.reservationId,
          ...bindingArgs(input.binding),
          input.claimId,
          input.executionContract.adapterId,
          input.slot,
          input.handleId,
          input.expectedHandleType,
          input.executionContract.actionKind,
          origin,
          ordinal,
          reservation.expiresAt,
          input.executionContract.executionContractDigest,
          permitDigest,
          this.now().toISOString()
        );
      this.audit(input.binding, 'secret_slot.registered', input.reservationId, {
        claim_id: input.claimId,
        slot: input.slot,
        handle_id: input.handleId,
      });
      return { ok: true };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_PERSIST_FAILED' };
    }
  }

  consumeSecretUsePermit(
    binding: EveExternalActionBinding,
    reservationId: string,
    claimId: string,
    slot: EveSecretFieldSlot,
    expectedContract: ExternalActionExecutionContractExpectation
  ): { ok: true; handle: ExternalSecretHandleAccess } | { ok: false; reasonCode: string } {
    const origin = normalizeEveExternalOrigin(expectedContract.targetOrigin);
    const ordinal = expectedContract.slotManifest.findIndex((entry) => entry.slot === slot);
    if (
      !validBinding(binding) ||
      binding.installationId !== this.installationId ||
      !isEveOpaqueId(reservationId) ||
      !isEveOpaqueId(claimId) ||
      !isEveSecretFieldSlot(slot) ||
      !validExecutionExpectation(expectedContract) ||
      !origin ||
      ordinal < 0
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_INVALID' };
    }
    const transaction = this.db.transaction(
      (): { ok: true; handle: ExternalSecretHandleAccess } | { ok: false; reasonCode: string } => {
        const preflight = this.validateClaimForExecution(binding, reservationId, claimId, expectedContract);
        if ('reasonCode' in preflight) return preflight;
        const reservation = this.getReservation(binding, reservationId);
        if (!reservation || Date.parse(reservation.expiresAt) <= this.now().getTime()) {
          return { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_CONTRACT_STALE' };
        }
        const permit = this.db
          .prepare(
            `SELECT adapter_id, handle_id, handle_type, action_kind, target_origin,
                    ordinal, expires_at, execution_contract_digest, permit_digest, status
             FROM external_action_secret_slot_permits
             WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
               AND claim_id = ? AND slot = ?`
          )
          .get(reservationId, ...bindingArgs(binding), claimId, slot) as
          | {
              adapter_id?: unknown;
              handle_id?: unknown;
              handle_type?: unknown;
              action_kind?: unknown;
              target_origin?: unknown;
              ordinal?: unknown;
              expires_at?: unknown;
              execution_contract_digest?: unknown;
              permit_digest?: unknown;
              status?: unknown;
            }
          | undefined;
        if (!permit) return { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_NOT_REGISTERED' };
        if (permit.status === 'consumed') return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_REPLAY_BLOCKED' };
        if (
          !isEveOpaqueId(permit.handle_id) ||
          !isEveSecretHandleType(permit.handle_type) ||
          permit.adapter_id !== expectedContract.adapterId ||
          permit.action_kind !== expectedContract.actionKind ||
          permit.target_origin !== origin ||
          permit.ordinal !== ordinal ||
          permit.expires_at !== reservation.expiresAt ||
          permit.execution_contract_digest !== expectedContract.executionContractDigest ||
          permit.permit_digest !==
            sha256(
              canonical({
                binding,
                reservationId,
                claimId,
                adapterId: expectedContract.adapterId,
                slot,
                handleId: permit.handle_id,
                handleType: permit.handle_type,
                actionKind: expectedContract.actionKind,
                targetOrigin: origin,
                ordinal,
                expiresAt: reservation.expiresAt,
                executionContractDigest: expectedContract.executionContractDigest,
              } satisfies ExternalSecretPermitDigestPreimage)
            ) ||
          permit.status !== 'pending'
        ) {
          return { ok: false, reasonCode: 'EXTERNAL_SECRET_SLOT_CONTRACT_STALE' };
        }
        const handle = this.resolveSecretHandleAccess(binding, permit.handle_id, expectedContract.actionKind, origin);
        if (!handle) return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_NOT_ACTIVE' };
        if (handle.type !== permit.handle_type || (handle.type === 'otp_code' && handle.accessGrantId)) {
          return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_TYPE_BLOCKED' };
        }
        if (handle.type === 'otp_code') {
          const consumedOtp = this.db
            .prepare(
              `INSERT OR IGNORE INTO external_secret_handle_consumptions (
                 owner_installation_id, owner_account_id, owner_seed_id, handle_id,
                 reservation_id, slot, consumed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              ...bindingArgs(handle.binding),
              handle.handleId,
              reservationId,
              slot,
              this.now().toISOString()
            ).changes;
          if (consumedOtp !== 1) return { ok: false, reasonCode: 'EXTERNAL_OTP_ALREADY_CONSUMED' };
        }
        const changed = this.db
          .prepare(
            `UPDATE external_action_secret_slot_permits SET status = 'consumed', consumed_at = ?
             WHERE reservation_id = ? AND slot = ? AND status = 'pending'`
          )
          .run(this.now().toISOString(), reservationId, slot).changes;
        if (changed !== 1) return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_REPLAY_BLOCKED' };
        this.audit(binding, 'secret_slot.consumed', reservationId, {
          claim_id: claimId,
          slot,
          handle_id: handle.handleId,
          ...(handle.accessGrantId ? { access_grant_id: handle.accessGrantId } : {}),
        });
        return { ok: true, handle };
      }
    );
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_PERSIST_FAILED' };
    }
  }

  recheckSecretUseForInjection(
    binding: EveExternalActionBinding,
    reservationId: string,
    claimId: string,
    slot: EveSecretFieldSlot,
    expectedContract: ExternalActionExecutionContractExpectation,
    expectedHandle: ExternalSecretHandleAccess
  ): { ok: true } | { ok: false; reasonCode: string } {
    const origin = normalizeEveExternalOrigin(expectedContract.targetOrigin);
    const ordinal = expectedContract.slotManifest.findIndex((entry) => entry.slot === slot);
    if (
      !validBinding(binding) ||
      binding.installationId !== this.installationId ||
      !isEveOpaqueId(reservationId) ||
      !isEveOpaqueId(claimId) ||
      !isEveSecretFieldSlot(slot) ||
      !isEveOpaqueId(expectedHandle.handleId) ||
      !validExecutionExpectation(expectedContract) ||
      !origin ||
      ordinal < 0
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_INVALID' };
    }
    const transaction = this.db.transaction((): { ok: true } | { ok: false; reasonCode: string } => {
      const preflight = this.validateClaimForExecution(binding, reservationId, claimId, expectedContract);
      if ('reasonCode' in preflight) return preflight;
      const reservation = this.getReservation(binding, reservationId);
      if (!reservation || Date.parse(reservation.expiresAt) <= this.now().getTime()) {
        return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_NOT_CONSUMED' };
      }
      const permit = this.db
        .prepare(
          `SELECT adapter_id, handle_id, handle_type, ordinal, expires_at,
                  status, execution_contract_digest, permit_digest
           FROM external_action_secret_slot_permits
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND claim_id = ? AND slot = ?`
        )
        .get(reservationId, ...bindingArgs(binding), claimId, slot) as
        | {
            adapter_id?: unknown;
            handle_id?: unknown;
            handle_type?: unknown;
            ordinal?: unknown;
            expires_at?: unknown;
            status?: unknown;
            execution_contract_digest?: unknown;
            permit_digest?: unknown;
          }
        | undefined;
      if (
        !permit ||
        permit.status !== 'consumed' ||
        permit.adapter_id !== expectedContract.adapterId ||
        permit.handle_id !== expectedHandle.handleId ||
        permit.handle_type !== expectedHandle.type ||
        permit.ordinal !== ordinal ||
        permit.expires_at !== reservation.expiresAt ||
        permit.execution_contract_digest !== expectedContract.executionContractDigest ||
        permit.permit_digest !==
          sha256(
            canonical({
              binding,
              reservationId,
              claimId,
              adapterId: expectedContract.adapterId,
              slot,
              handleId: expectedHandle.handleId,
              handleType: expectedHandle.type,
              actionKind: expectedContract.actionKind,
              targetOrigin: origin,
              ordinal,
              expiresAt: reservation.expiresAt,
              executionContractDigest: expectedContract.executionContractDigest,
            } satisfies ExternalSecretPermitDigestPreimage)
          )
      ) {
        return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_NOT_CONSUMED' };
      }
      const current = this.resolveSecretHandleAccess(
        binding,
        expectedHandle.handleId,
        expectedContract.actionKind,
        origin
      );
      if (
        !current ||
        current.type !== expectedHandle.type ||
        current.source !== expectedHandle.source ||
        current.sourceRef !== expectedHandle.sourceRef ||
        current.binding.installationId !== expectedHandle.binding.installationId ||
        current.binding.accountId !== expectedHandle.binding.accountId ||
        current.binding.seedId !== expectedHandle.binding.seedId ||
        current.accessGrantId !== expectedHandle.accessGrantId
      ) {
        return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_NOT_ACTIVE' };
      }
      return { ok: true };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_RECHECK_FAILED' };
    }
  }

  readAuditEvents(binding: EveExternalActionBinding): readonly Record<string, unknown>[] {
    if (!validBinding(binding)) return [];
    return this.db
      .prepare(
        `SELECT event_id, reservation_id, event_type, occurred_at, details_json
         FROM external_action_audit
         WHERE installation_id = ? AND account_id = ? AND seed_id = ?
         ORDER BY rowid ASC`
      )
      .all(...bindingArgs(binding)) as Record<string, unknown>[];
  }
}
