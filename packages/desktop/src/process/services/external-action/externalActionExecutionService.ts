/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import {
  EVE_EXTERNAL_ACTION_CHALLENGE_KINDS,
  EVE_EXTERNAL_ACTION_EXECUTION_VERSION,
  EVE_EXTERNAL_ACTION_NEEDS_USER_INSTRUCTION_CODES,
  EVE_EXTERNAL_ACTION_PROVIDER_LABEL_CODES,
  EVE_EXTERNAL_ACTION_REASON_CODES,
  isEveSanitizedOpaqueRef,
  validateEveExternalActionSanitizedResult,
  validateEveExternalActionProposal,
  validateEveExternalActionResumeRequest,
  type EveExternalActionChallenge,
  type EveExternalActionChallengeKind,
  type EveExternalActionAuthMode,
  type EveExternalAdapterDomain,
  type EveExternalActionEventReceiptV0,
  type EveExternalActionExecutionResult,
  type EveExternalActionNeedsUserInstructionCode,
  type EveExternalActionProposal,
  type EveExternalActionProviderMerchantLabelCode,
  type EveExternalActionReasonCode,
  type EveExternalActionReceiptV0,
  type EveExternalActionSanitizedResult,
  type EveExternalActionSlotBinding,
  type EveExternalActionWorkbenchCardV0,
} from '@/common/config/eveExternalActionExecutionCore';
import {
  eveSecretSlotAllowsHandleType,
  isEveOpaqueId,
  isEveSecretFieldSlot,
  isEveSecretHandleType,
  isEveSha256Digest,
  normalizeEveExternalOrigin,
  type EveExternalActionBinding,
  type EveExternalActionKind,
  type EveExternalActionLedgerState,
  type EveExternalActionPolicy,
  type EveExternalActionRiskClass,
  type EveExternalAuthorityDecision,
  type EveSecretFieldSlot,
} from '@/common/config/eveExternalActionPolicyCore';
import { externalActionBrowserPartition } from './browserProfileScope';
import type { ExternalActionBindingResolution } from './bindingResolver';
import type {
  ExternalActionContinuationKind,
  ExternalActionExecutionContractIdentity,
  ExternalActionExecutionContractExpectation,
  ExternalActionStore,
} from './externalActionStore';
import { ExternalSecretUseBroker, type SecretMaterialResolver } from './secretUseBroker';

export type ExternalActionAuthMode = EveExternalActionAuthMode;
export type ExternalActionAuthProbe = 'ready' | 'needs_user' | 'unavailable';
export type ExternalActionChallengeProbe =
  | { status: 'ready' }
  | { status: 'needs_user'; challenge: EveExternalActionChallenge };

export interface ExternalActionAuthorityResolution {
  decision: EveExternalAuthorityDecision;
  authorityGrantId: string;
  riskClass: EveExternalActionRiskClass;
}

export interface ExternalActionAdapterContext {
  binding: EveExternalActionBinding;
  proposal: EveExternalActionProposal;
  authMode: ExternalActionAuthMode;
  /** Opaque receipts proving that Main-owned sinks consumed the exact slots. */
  secretUseRefs?: readonly { slot: EveSecretFieldSlot; deliveryRef: string }[];
  /** Strict payload bytes verified against the proposal digest; Main-only. */
  adapterPayload?: Uint8Array;
  /** Main-owned persistent Electron partition. Cookies never leave it. */
  browserPartition?: string;
}

export type ExternalActionAdapterOutcome =
  | { status: 'allowed'; result?: EveExternalActionSanitizedResult }
  | { status: 'denied'; reasonCode: EveExternalActionReasonCode }
  | { status: 'unknown_outcome'; reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' | 'SANITIZATION_FAILED' }
  | {
      status: 'needs_user';
      reasonCode: string;
      challenge: EveExternalActionChallenge;
      continuation: 'adapter_resume';
      continuationRef: string;
      effectState: 'challenge_pending_no_effect';
    };

export interface ExternalActionAdapterResumeContext extends Omit<ExternalActionAdapterContext, 'credential'> {
  challenge: EveExternalActionChallenge;
  completionAttestationDigest: string;
  completionAttestationPresent: boolean;
}

export const EXTERNAL_ACTION_COMPLETION_ATTESTATION_VERSION =
  'command-eve-external-action-completion-attestation/v0' as const;

export interface ExternalActionCompletionAttestation {
  version: typeof EXTERNAL_ACTION_COMPLETION_ATTESTATION_VERSION;
  attestationRef: string;
  reservationId: string;
  challengeRef: string;
  accountId: string;
  seedId: string;
  conversationId: string;
  conversationSessionId: string;
  completedAt: string;
}

/** Main-only lookup for a bounded, non-secret user-completion attestation. */
export interface ExternalActionCompletionAttestationReadPort {
  read(input: {
    attestationRef: string;
    binding: EveExternalActionBinding;
    conversationContext: ExternalActionConversationContext;
    reservationId: string;
    challengeRef: string;
  }): Promise<unknown>;
}

export const EXTERNAL_ACTION_RECONCILIATION_EVIDENCE_VERSION =
  'command-eve-external-action-reconciliation-evidence/v0' as const;
export const EXTERNAL_ACTION_RECONCILIATION_REQUEST_VERSION =
  'command-eve-external-action-reconciliation-request/v0' as const;

export interface ExternalActionReconciliationEvidence {
  version: typeof EXTERNAL_ACTION_RECONCILIATION_EVIDENCE_VERSION;
  evidenceRef: string;
  reservationId: string;
  reconciliationRef: string;
  decision: 'reconciled_committed' | 'reconciled_no_effect';
  evidenceDigest: string;
  authorityReceiptDigest: string;
  actorRef: string;
  accountId: string;
  seedId: string;
  observedAt: string;
  result?: EveExternalActionSanitizedResult;
}

export interface ExternalActionReconciliationEvidenceReadPort {
  read(input: {
    evidenceRef: string;
    reconciliationRef: string;
    reservationId: string;
    binding: EveExternalActionBinding;
  }): Promise<unknown>;
}

export interface ExternalActionReconciliationRequest {
  version: typeof EXTERNAL_ACTION_RECONCILIATION_REQUEST_VERSION;
  reconciliationRef: string;
  evidenceRef: string;
}

export type ExternalActionRegisteredOperation =
  | {
      actionKind: EveExternalActionKind;
      domain: Exclude<EveExternalAdapterDomain, 'commerce'>;
      action: string;
      counterpartyId: string;
      providerOrigin: string;
    }
  | {
      actionKind: 'purchase';
      domain: 'commerce';
      action: 'purchase';
      counterpartyId: string;
      merchantOrigin: string;
      checkoutOrigin: string;
    };

export interface ExternalActionAdapter {
  readonly id: string;
  readonly providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode;
  /** Main-owned registry rows. Renderer/model input can never create or alter these fields. */
  readonly operations: readonly ExternalActionRegisteredOperation[];
  readonly supports: Readonly<{
    oauth: boolean;
    browserSession: boolean;
    password: boolean;
    otp?: boolean;
    paymentFields?: boolean;
    unauthenticated: boolean;
  }>;
  /**
   * Main-owned, side-effect-free classification. `ordinary` is an explicit
   * adapter attestation; missing, throwing or malformed classifiers require a
   * HumanGate and never inherit a renderer/model classification.
   */
  classifyRisk(context: Omit<ExternalActionAdapterContext, 'authMode'>): EveExternalActionRiskClass;
  /**
   * Required whenever the proposal carries adapter payload bytes. The trusted
   * adapter must reject non-canonical encodings and attest only non-secret UI
   * metadata; Main independently verifies the canonical digest.
   */
  validatePayload?(
    payload: Uint8Array,
    context: ExternalActionAdapterPayloadValidationContext
  ): ExternalActionAdapterPayloadValidation;
  /** Must not begin the governed external effect; crashes remain safely reversible. */
  probeChallenge?(context: Omit<ExternalActionAdapterContext, 'authMode'>): Promise<ExternalActionChallengeProbe>;
  probeOAuth?(context: Omit<ExternalActionAdapterContext, 'authMode'>): Promise<ExternalActionAuthProbe>;
  probeBrowserSession?(
    context: Omit<ExternalActionAdapterContext, 'authMode'> & { browserPartition: string }
  ): Promise<ExternalActionAuthProbe>;
  execute(context: ExternalActionAdapterContext): Promise<ExternalActionAdapterOutcome>;
  /** Continue a provider-owned suspended challenge; never re-run `execute`. */
  resume?(context: ExternalActionAdapterResumeContext): Promise<ExternalActionAdapterOutcome>;
}

export interface ExternalActionExecutionDeps {
  resolveBinding(): ExternalActionBindingResolution;
  resolveConversationContext(): ExternalActionConversationContextResolution;
  resolveAuthority(input: {
    binding: EveExternalActionBinding;
    proposal: EveExternalActionProposal;
    spentTodayMinor: number;
    riskClass: EveExternalActionRiskClass;
  }): Promise<ExternalActionAuthorityResolution>;
  secretResolver: SecretMaterialResolver;
  secretSink?: ExternalActionSecretFieldSinkPort;
  adapterPayloadReader?: ExternalActionAdapterPayloadReadPort;
  completionAttestationReader?: ExternalActionCompletionAttestationReadPort;
  reconciliationEvidenceReader?: ExternalActionReconciliationEvidenceReadPort;
  adapters?: readonly ExternalActionAdapter[];
  now?: () => Date;
  randomUUID?: () => string;
}

/** Main-only immutable payload ingress. Raw bytes never cross IPC or persist in the action ledger. */
export interface ExternalActionAdapterPayloadReadPort {
  read(input: {
    payloadRef: string;
    expectedPayloadDigest: string;
    binding: EveExternalActionBinding;
    conversationId: string;
    conversationSessionId: string;
    adapterId: string;
    actionKind: EveExternalActionKind;
    targetOrigin: string;
    domain: EveExternalAdapterDomain;
    action: string;
    counterpartyId: string;
    origins: readonly string[];
  }): Promise<Uint8Array>;
}

export const EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION =
  'command-eve-external-action-adapter-payload-validation/v0' as const;

export interface ExternalActionAdapterPayloadValidationContext {
  binding: EveExternalActionBinding;
  conversationId: string;
  conversationSessionId: string;
  adapterId: string;
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  domain: EveExternalAdapterDomain;
  action: string;
  counterpartyId: string;
  origins: readonly string[];
  argumentsDigest: string;
  quoteDigest?: string;
  amount: EveExternalActionProposal['action']['amount'];
}

export interface ExternalActionAdapterPayloadValidation {
  version: typeof EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION;
  canonicalPayloadDigest: string;
  authMode: ExternalActionAuthMode;
  domain: EveExternalAdapterDomain;
  action: string;
  counterpartyId: string;
  origins: readonly string[];
  slotManifest: readonly EveExternalActionSlotBinding[];
  /** Required only for commerce purchase payloads. */
  commerce?: {
    productCount: number;
    cartDigest: string;
    quoteDigest: string;
    amount: { currency: string; minorUnits: number };
  };
}

export const EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION =
  'command-eve-external-action-conversation-context/v0' as const;

export interface ExternalActionConversationContext {
  version: typeof EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION;
  conversationId: string;
  conversationSessionId: string;
}

export type ExternalActionConversationContextResolution =
  | { context: ExternalActionConversationContext }
  | { reasonCode: string };

export interface ExternalActionConversationContextReadPort {
  read(): ExternalActionConversationContextResolution;
}

export interface ExternalActionSecretFieldSinkPort {
  inject(input: {
    binding: EveExternalActionBinding;
    conversationId: string;
    conversationSessionId: string;
    reservationId: string;
    claimId: string;
    adapterId: string;
    authMode: ExternalActionAuthMode;
    domain: string;
    action: string;
    origins: readonly string[];
    exactOrigin: string;
    slot: EveSecretFieldSlot;
    executionContractDigest: string;
    browserPartition?: string;
    material: Uint8Array;
  }): Promise<{ status: 'applied'; deliveryRef: string } | { status: 'unknown_outcome'; reasonCode: string }>;
}

const RESULT_REASON_RE = /^[A-Z][A-Z0-9_]{0,95}$/;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const RISK_CLASSES = new Set<EveExternalActionRiskClass>([
  'ordinary',
  'legal_agreement',
  'security_expansion',
  'high_risk_finance',
]);
const PROVIDER_LABEL_CODES = new Set<EveExternalActionProviderMerchantLabelCode>(
  EVE_EXTERNAL_ACTION_PROVIDER_LABEL_CODES
);
const ADAPTER_REASON_CODES = new Set<EveExternalActionReasonCode>(EVE_EXTERNAL_ACTION_REASON_CODES);
const NEEDS_USER_INSTRUCTION_CODES = new Set(EVE_EXTERNAL_ACTION_NEEDS_USER_INSTRUCTION_CODES);

type SelectedAuthResult =
  | {
      status: 'ready';
      authMode: ExternalActionAuthMode;
      handleId?: string;
      browserPartition?: string;
    }
  | {
      status: 'needs_user';
      reasonCode: string;
      authMode: ExternalActionAuthMode;
      resumable: boolean;
      challengeKind?: EveExternalActionChallenge['kind'];
      browserPartition?: string;
    }
  | { status: 'denied'; reasonCode: string; authMode?: ExternalActionAuthMode };

type PreparedExecution = {
  binding: EveExternalActionBinding;
  conversationContext: ExternalActionConversationContext;
  policy: EveExternalActionPolicy;
  adapter: ExternalActionAdapter;
  riskClass: EveExternalActionRiskClass;
  authority: ExternalActionAuthorityResolution;
  auth: Extract<SelectedAuthResult, { status: 'ready' | 'needs_user' }>;
  executionContract: ExternalActionExecutionContractIdentity;
};

export interface ExternalActionOperationDigestPreimage {
  binding: EveExternalActionBinding;
  conversationContext: ExternalActionConversationContext;
  adapterId: string;
  authMode: ExternalActionAuthMode;
  slotManifest: readonly EveExternalActionSlotBinding[];
  action: EveExternalActionProposal['action'];
}

/**
 * Stable semantic replay key. Deliberately excludes request/idempotency,
 * authority/policy revisions, auth mode, handles and adapter implementation so
 * rotating credentials or opening a new renderer session cannot mint a second
 * reservation for the same described external effect.
 */
export interface ExternalActionIntentDigestPreimage {
  installationId: string;
  accountId: string;
  seedId: string;
  domain: string;
  domainAction: string;
  counterpartyId: string;
  origins: readonly string[];
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  argumentsDigest: string;
  quoteDigest: string | null;
  amount: EveExternalActionProposal['action']['amount'];
  adapterPayloadDigest: string | null;
  cartDigest: string | null;
  productCount: number | null;
}

export interface ExternalActionExecutionDigestPreimage {
  operationDigest: string;
  policyRevision: number;
  sessionEpoch: number;
  authorityGrantId: string;
  riskClass: EveExternalActionRiskClass;
  adapterId: string;
  installationId: string;
  accountId: string;
  seedId: string;
  conversationId: string;
  conversationSessionId: string;
  authMode: ExternalActionAuthMode;
  domain: string;
  domainAction: string;
  counterpartyId: string;
  providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode;
  origins: readonly string[];
  slotManifest: readonly EveExternalActionSlotBinding[];
  actionKind: EveExternalActionKind;
  targetOrigin: string;
  argumentsDigest: string;
  quoteDigest: string | null;
  amount: EveExternalActionProposal['action']['amount'];
  oauthHandleId: string | null;
  passwordHandleId: string | null;
  adapterPayloadRef: string | null;
  adapterPayloadDigest: string | null;
  adapterPayloadProductCount: number | null;
  cartDigest: string | null;
  registeredOperation: ExternalActionRegisteredOperation;
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
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

function safeReason(reasonCode: unknown, fallback: string): string {
  return typeof reasonCode === 'string' && RESULT_REASON_RE.test(reasonCode) ? reasonCode : fallback;
}

function result(
  status: EveExternalActionExecutionResult['status'],
  options: Omit<EveExternalActionExecutionResult, 'version' | 'status'> = {}
): EveExternalActionExecutionResult {
  return { version: EVE_EXTERNAL_ACTION_EXECUTION_VERSION, status, ...options };
}

function statusForReason(reasonCode: string): EveExternalActionExecutionResult['status'] {
  if (reasonCode.includes('REVOKED') || reasonCode.includes('KILLED')) return 'revoked';
  if (reasonCode.includes('EXPIRED')) return 'expired';
  return 'denied';
}

function statusForBrokerReason(reasonCode: string): EveExternalActionExecutionResult['status'] {
  if (reasonCode === 'EXTERNAL_SECRET_USE_REPLAY_BLOCKED') return 'unknown_outcome';
  if (reasonCode.includes('REVOKED') || reasonCode.includes('KILLED')) return 'revoked';
  if (reasonCode.includes('EXPIRED')) return 'expired';
  if (
    reasonCode.includes('INVALID') ||
    reasonCode.includes('SCOPE') ||
    reasonCode.includes('CLAIM') ||
    reasonCode.includes('CONTRACT') ||
    reasonCode.includes('BINDING') ||
    reasonCode === 'EXTERNAL_AUTHORITY_BLOCKED' ||
    reasonCode === 'EXTERNAL_AUTHORITY_CHANGED'
  ) {
    return 'denied';
  }
  return 'denied';
}

function terminalStateForStatus(
  status: EveExternalActionExecutionResult['status']
): 'reversed' | 'denied' | 'revoked' | 'expired' {
  if (status === 'revoked') return 'revoked';
  if (status === 'expired') return 'expired';
  if (status === 'denied') return 'denied';
  return 'reversed';
}

function executionStatusForLedgerState(
  state: EveExternalActionLedgerState | undefined
): EveExternalActionExecutionResult['status'] | null {
  if (state === 'allowed') return 'allowed';
  if (state === 'reversed' || state === 'denied') return 'denied';
  if (state === 'revoked') return 'revoked';
  if (state === 'expired') return 'expired';
  if (state === 'unknown' || state === 'claimed' || state === 'resuming') return 'unknown_outcome';
  if (state === 'reconciled_committed' || state === 'reconciled_no_effect') return state;
  if (state === 'suspended') return 'needs_user';
  return null;
}

function isAuthProbe(value: unknown): value is ExternalActionAuthProbe {
  return value === 'ready' || value === 'needs_user' || value === 'unavailable';
}

function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isStrictChallenge(value: unknown): value is EveExternalActionChallenge {
  if (!hasExactKeys(value, ['kind', 'challengeRef', 'origin', 'expiresAt', 'userInstructionCode'])) return false;
  const challenge = value as Record<string, unknown>;
  return (
    EVE_EXTERNAL_ACTION_CHALLENGE_KINDS.includes(challenge.kind as EveExternalActionChallenge['kind']) &&
    isEveSanitizedOpaqueRef(challenge.challengeRef) &&
    normalizeEveExternalOrigin(challenge.origin) === challenge.origin &&
    typeof challenge.expiresAt === 'string' &&
    Number.isFinite(Date.parse(challenge.expiresAt)) &&
    NEEDS_USER_INSTRUCTION_CODES.has(challenge.userInstructionCode as never)
  );
}

function isChallengeProbe(value: unknown): value is ExternalActionChallengeProbe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { status?: unknown; challenge?: unknown };
  if (candidate.status === 'ready') return hasExactKeys(value, ['status']);
  return (
    candidate.status === 'needs_user' &&
    hasExactKeys(value, ['status', 'challenge']) &&
    isStrictChallenge(candidate.challenge)
  );
}

function sameBinding(left: EveExternalActionBinding, right: EveExternalActionBinding): boolean {
  return (
    left.installationId === right.installationId && left.accountId === right.accountId && left.seedId === right.seedId
  );
}

function sameConversation(left: ExternalActionConversationContext, right: ExternalActionConversationContext): boolean {
  return (
    left.version === EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION &&
    right.version === EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION &&
    left.conversationId === right.conversationId &&
    left.conversationSessionId === right.conversationSessionId
  );
}

function normalizeRegisteredOperation(input: unknown): ExternalActionRegisteredOperation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  const commerce = candidate.domain === 'commerce';
  if (
    !hasExactKeys(
      candidate,
      commerce
        ? ['actionKind', 'domain', 'action', 'counterpartyId', 'merchantOrigin', 'checkoutOrigin']
        : ['actionKind', 'domain', 'action', 'counterpartyId', 'providerOrigin']
    ) ||
    !isEveSanitizedOpaqueRef(candidate.counterpartyId)
  ) {
    return null;
  }
  const validDomainAction =
    (candidate.domain === 'generic' && isEveOpaqueId(candidate.action)) ||
    (candidate.domain === 'email_identity' &&
      ['provision', 'link', 'verify', 'send', 'receive', 'revoke'].includes(String(candidate.action))) ||
    (candidate.domain === 'phone_identity' &&
      ['provision', 'link', 'otp_receive', 'otp_use', 'sms_send', 'sms_receive', 'revoke'].includes(
        String(candidate.action)
      )) ||
    (candidate.domain === 'commerce' && candidate.action === 'purchase' && candidate.actionKind === 'purchase');
  if (!validDomainAction) return null;
  if (commerce) {
    const merchantOrigin = normalizeEveExternalOrigin(candidate.merchantOrigin);
    const checkoutOrigin = normalizeEveExternalOrigin(candidate.checkoutOrigin);
    if (!merchantOrigin || !checkoutOrigin || candidate.actionKind !== 'purchase') return null;
    return {
      actionKind: 'purchase',
      domain: 'commerce',
      action: 'purchase',
      counterpartyId: candidate.counterpartyId as string,
      merchantOrigin,
      checkoutOrigin,
    };
  }
  const providerOrigin = normalizeEveExternalOrigin(candidate.providerOrigin);
  if (
    !providerOrigin ||
    !['generic', 'email_identity', 'phone_identity'].includes(String(candidate.domain)) ||
    ![
      'account_create',
      'software_install',
      'purchase',
      'recurring_payment',
      'browser_submit',
      'desktop_action',
      'artifact_modify',
      'communication_send',
    ].includes(String(candidate.actionKind))
  ) {
    return null;
  }
  return {
    actionKind: candidate.actionKind as EveExternalActionKind,
    domain: candidate.domain as Exclude<EveExternalAdapterDomain, 'commerce'>,
    action: candidate.action as string,
    counterpartyId: candidate.counterpartyId as string,
    providerOrigin,
  };
}

function resolveRegisteredAdapterOperation(
  adapters: readonly ExternalActionAdapter[],
  proposal: EveExternalActionProposal
):
  | { ok: true; adapter: ExternalActionAdapter; operation: ExternalActionRegisteredOperation }
  | { ok: false; reasonCode: string } {
  const matches: Array<{ adapter: ExternalActionAdapter; operation: ExternalActionRegisteredOperation }> = [];
  for (const adapter of adapters) {
    if (
      !isEveOpaqueId(adapter.id) ||
      !PROVIDER_LABEL_CODES.has(adapter.providerOrMerchantLabelCode) ||
      !Array.isArray(adapter.operations) ||
      adapter.operations.length === 0 ||
      adapter.operations.length > 64
    ) {
      continue;
    }
    const operations = adapter.operations.map(normalizeRegisteredOperation);
    if (operations.some((operation) => !operation)) continue;
    for (const operation of operations as ExternalActionRegisteredOperation[]) {
      const targetOrigin = operation.domain === 'commerce' ? operation.checkoutOrigin : operation.providerOrigin;
      if (operation.actionKind === proposal.action.kind && targetOrigin === proposal.action.targetOrigin) {
        matches.push({ adapter, operation });
      }
    }
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      reasonCode: matches.length === 0 ? 'EXTERNAL_ADAPTER_UNAVAILABLE' : 'EXTERNAL_ADAPTER_AMBIGUOUS',
    };
  }
  return { ok: true, ...matches[0]! };
}

function slotPolicy(
  domain: ExternalActionExecutionContractIdentity['domain'],
  action: string,
  authMode: ExternalActionAuthMode
): { required: readonly EveSecretFieldSlot[]; optional: readonly EveSecretFieldSlot[] } | null {
  if (domain === 'generic') {
    if (authMode === 'oauth') return { required: ['oauth_token'], optional: [] };
    if (authMode === 'password') return { required: ['account_password'], optional: ['account_username'] };
    if (authMode === 'otp') return { required: ['otp_code'], optional: [] };
    if (authMode === 'payment_fields') {
      return {
        required: ['payment_pan', 'payment_expiry', 'payment_cvc'],
        optional: ['billing_profile', 'shipping_profile'],
      };
    }
    if (authMode === 'session' || authMode === 'none') return { required: [], optional: [] };
    return null;
  }
  if (domain === 'commerce' && action === 'purchase') {
    if (authMode === 'oauth') {
      return { required: ['oauth_token'], optional: ['billing_profile', 'shipping_profile'] };
    }
    if (authMode === 'payment_fields') {
      return {
        required: ['payment_pan', 'payment_expiry', 'payment_cvc'],
        optional: ['billing_profile', 'shipping_profile'],
      };
    }
    return null;
  }
  if (domain === 'email_identity') {
    if (['provision', 'link', 'verify'].includes(action) && authMode === 'oauth') {
      return { required: ['oauth_token'], optional: [] };
    }
    if (action === 'provision' && authMode === 'password') {
      return { required: ['email_address', 'account_password'], optional: [] };
    }
    if (action === 'link' && authMode === 'password') {
      return { required: ['account_username', 'account_password'], optional: [] };
    }
    if (action === 'verify' && authMode === 'otp') return { required: ['otp_code'], optional: [] };
    if (['send', 'receive', 'revoke'].includes(action)) {
      if (authMode === 'session') return { required: [], optional: [] };
      if (authMode === 'oauth') return { required: ['oauth_token'], optional: [] };
      if (authMode === 'password') {
        return { required: ['account_username', 'account_password'], optional: [] };
      }
    }
    return null;
  }
  if (domain === 'phone_identity') {
    if (['provision', 'link'].includes(action)) {
      if (authMode === 'oauth') return { required: ['oauth_token'], optional: [] };
      if (authMode === 'password') return { required: ['phone_number', 'account_password'], optional: [] };
    }
    if (action === 'otp_receive') {
      if (authMode === 'session') return { required: [], optional: [] };
      if (authMode === 'oauth') return { required: ['oauth_token'], optional: [] };
    }
    if (action === 'otp_use' && authMode === 'otp') return { required: ['otp_code'], optional: [] };
    if (['sms_send', 'sms_receive', 'revoke'].includes(action)) {
      if (authMode === 'session') return { required: [], optional: [] };
      if (authMode === 'oauth') return { required: ['oauth_token'], optional: [] };
    }
  }
  return null;
}

function selectedSlotManifest(
  manifest: readonly EveExternalActionSlotBinding[],
  authMode: ExternalActionAuthMode,
  domain: ExternalActionExecutionContractIdentity['domain'],
  action: string
): readonly EveExternalActionSlotBinding[] | null {
  const policy = slotPolicy(domain, action, authMode);
  if (!policy) return null;
  const allowed = new Set<EveSecretFieldSlot>([...policy.required, ...policy.optional]);
  const selected = manifest.filter((entry) => allowed.has(entry.slot));
  if (selected.length !== manifest.length) return null;
  if (policy.required.some((slot) => !selected.some((entry) => entry.slot === slot))) return null;
  if (selected.some((entry, index) => index > 0 && selected[index - 1]!.slot.localeCompare(entry.slot) >= 0)) {
    return null;
  }
  return selected;
}

function validateAdapterPayloadValidation(
  value: unknown,
  expected: ExternalActionAdapterPayloadValidationContext & {
    payloadDigest: string;
  }
): ExternalActionAdapterPayloadValidation | null {
  if (
    !hasExactKeys(
      value,
      [
        'version',
        'canonicalPayloadDigest',
        'authMode',
        'domain',
        'action',
        'counterpartyId',
        'origins',
        'slotManifest',
      ],
      ['commerce']
    )
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const commerce = expected.domain === 'commerce';
  if (
    candidate.version !== EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION ||
    candidate.canonicalPayloadDigest !== expected.payloadDigest ||
    !['oauth', 'password', 'otp', 'payment_fields', 'session', 'none'].includes(String(candidate.authMode)) ||
    candidate.domain !== expected.domain ||
    candidate.action !== expected.action ||
    candidate.counterpartyId !== expected.counterpartyId ||
    canonical(candidate.origins) !== canonical(expected.origins) ||
    commerce !== Object.hasOwn(candidate, 'commerce')
  ) {
    return null;
  }
  if (!Array.isArray(candidate.slotManifest) || candidate.slotManifest.length > 16) return null;
  const slots: EveExternalActionSlotBinding[] = [];
  for (const raw of candidate.slotManifest) {
    if (!hasExactKeys(raw, ['slot', 'handleId', 'handleType'])) return null;
    const slot = raw as Record<string, unknown>;
    if (
      !isEveSecretFieldSlot(slot.slot) ||
      !isEveOpaqueId(slot.handleId) ||
      !isEveSecretHandleType(slot.handleType) ||
      !eveSecretSlotAllowsHandleType(slot.slot, slot.handleType) ||
      slots.some((existing) => existing.slot === slot.slot)
    ) {
      return null;
    }
    slots.push({
      slot: slot.slot,
      handleId: slot.handleId as string,
      handleType: slot.handleType,
    });
  }
  const normalizedSlots = selectedSlotManifest(slots, candidate.authMode as ExternalActionAuthMode, expected.domain, expected.action);
  if (!normalizedSlots || canonical(normalizedSlots) !== canonical(slots)) return null;
  let commerceContract: ExternalActionAdapterPayloadValidation['commerce'];
  if (commerce) {
    if (!candidate.commerce || typeof candidate.commerce !== 'object' || Array.isArray(candidate.commerce)) return null;
    const raw = candidate.commerce as Record<string, unknown>;
    if (!hasExactKeys(raw, ['productCount', 'cartDigest', 'quoteDigest', 'amount'])) return null;
    if (!raw.amount || typeof raw.amount !== 'object' || Array.isArray(raw.amount)) return null;
    const amount = raw.amount as Record<string, unknown>;
    if (
      !hasExactKeys(amount, ['currency', 'minorUnits']) ||
      !Number.isSafeInteger(raw.productCount) ||
      (raw.productCount as number) < 1 ||
      (raw.productCount as number) > 100 ||
      !isEveSha256Digest(raw.cartDigest) ||
      raw.cartDigest !== expected.argumentsDigest ||
      !isEveSha256Digest(raw.quoteDigest) ||
      raw.quoteDigest !== expected.quoteDigest ||
      amount.currency !== expected.amount.currency ||
      amount.minorUnits !== expected.amount.minorUnits
    ) {
      return null;
    }
    commerceContract = {
      productCount: raw.productCount as number,
      cartDigest: raw.cartDigest,
      quoteDigest: raw.quoteDigest,
      amount: expected.amount,
    };
  }
  return {
    version: EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION,
    canonicalPayloadDigest: expected.payloadDigest,
    authMode: candidate.authMode as ExternalActionAuthMode,
    domain: expected.domain,
    action: expected.action,
    counterpartyId: expected.counterpartyId,
    origins: expected.origins,
    slotManifest: normalizedSlots,
    ...(commerceContract ? { commerce: commerceContract } : {}),
  };
}

function classifyTrustedRisk(
  adapter: ExternalActionAdapter,
  binding: EveExternalActionBinding,
  proposal: EveExternalActionProposal
): EveExternalActionRiskClass | null {
  try {
    const riskClass = adapter.classifyRisk({ binding, proposal });
    return RISK_CLASSES.has(riskClass) ? riskClass : null;
  } catch {
    return null;
  }
}

/**
 * Internal diagnostic strings (payload/adapter plumbing failures) never reach
 * the persisted outcome. The contract-closed set is all the store, receipts
 * and workbench cards may ever see.
 */
function unknownOutcomeReason(internal: string): 'UNKNOWN_EXTERNAL_EFFECT' | 'SANITIZATION_FAILED' {
  return internal.includes('SANITIZATION') ? 'SANITIZATION_FAILED' : 'UNKNOWN_EXTERNAL_EFFECT';
}

/** Main-owned challenges carry only the closed user-instruction enum. */
function instructionForChallengeKind(
  kind: EveExternalActionChallengeKind
): EveExternalActionNeedsUserInstructionCode {
  switch (kind) {
    case 'oauth_consent':
      return 'COMPLETE_OAUTH_CONSENT';
    case '3ds':
      return 'COMPLETE_3DS';
    case 'mfa':
      return 'COMPLETE_MFA';
    case 'passkey':
      return 'COMPLETE_PASSKEY';
    case 'captcha':
      return 'COMPLETE_CAPTCHA';
    default:
      return 'CONTACT_PROVIDER_FOR_REVIEW';
  }
}

function adapterOutcome(
  value: unknown,
  expected: Pick<ExternalActionExecutionContractIdentity, 'domain' | 'domainAction' | 'amountMinor' | 'currency'>
): ExternalActionAdapterOutcome {
  if (!value || typeof value !== 'object')
    return { status: 'unknown_outcome', reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' };
  const candidate = value as Partial<ExternalActionAdapterOutcome>;
  if (!['allowed', 'needs_user', 'denied', 'unknown_outcome'].includes(String(candidate.status))) {
    return { status: 'unknown_outcome', reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' };
  }
  if (candidate.status === 'needs_user') {
    const challenge = (candidate as { challenge?: unknown }).challenge;
    if (
      !hasExactKeys(value, ['status', 'reasonCode', 'challenge', 'continuation', 'continuationRef', 'effectState']) ||
      (candidate as { continuation?: unknown }).continuation !== 'adapter_resume' ||
      (candidate as { effectState?: unknown }).effectState !== 'challenge_pending_no_effect' ||
      !isEveSanitizedOpaqueRef((candidate as { continuationRef?: unknown }).continuationRef) ||
      !isStrictChallenge(challenge) ||
      !NEEDS_USER_INSTRUCTION_CODES.has(candidate.reasonCode as never) ||
      candidate.reasonCode !== challenge.userInstructionCode
    ) {
      return { status: 'unknown_outcome', reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' };
    }
    return {
      status: 'needs_user',
      continuation: 'adapter_resume',
      continuationRef: (candidate as { continuationRef: string }).continuationRef,
      effectState: 'challenge_pending_no_effect',
      challenge,
      reasonCode: candidate.reasonCode,
    };
  }
  if (candidate.status === 'allowed') {
    const rawResult = (candidate as { result?: unknown }).result;
    const parsedResult = rawResult
      ? validateEveExternalActionSanitizedResult(rawResult, {
          domain: expected.domain,
          action: expected.domainAction,
          ...(expected.amountMinor > 0
            ? { amount: { currency: expected.currency, minorUnits: expected.amountMinor } }
            : {}),
        })
      : null;
    if (
      !hasExactKeys(value, ['status'], ['result']) ||
      (expected.domain !== 'generic' && !parsedResult) ||
      (rawResult !== undefined && !parsedResult)
    ) {
      return { status: 'unknown_outcome', reasonCode: 'SANITIZATION_FAILED' };
    }
    return { status: 'allowed', ...(parsedResult ? { result: parsedResult } : {}) };
  }
  if (
    !hasExactKeys(value, ['status', 'reasonCode']) ||
    !ADAPTER_REASON_CODES.has(candidate.reasonCode as EveExternalActionReasonCode) ||
    (candidate.status === 'unknown_outcome' &&
      !['UNKNOWN_EXTERNAL_EFFECT', 'SANITIZATION_FAILED'].includes(candidate.reasonCode as string))
  ) {
    return { status: 'unknown_outcome', reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' };
  }
  return {
    ...(candidate.status === 'denied'
      ? { status: 'denied' as const, reasonCode: candidate.reasonCode as EveExternalActionReasonCode }
      : {
          status: 'unknown_outcome' as const,
          reasonCode: candidate.reasonCode as 'UNKNOWN_EXTERNAL_EFFECT' | 'SANITIZATION_FAILED',
        }),
  };
}

function workbenchCard(input: {
  status: EveExternalActionExecutionResult['status'];
  conversationId: string;
  proposal: EveExternalActionProposal;
  executionContract: ExternalActionExecutionContractIdentity;
  reservationId: string;
  eventReceipt?: EveExternalActionEventReceiptV0;
  receipt?: EveExternalActionReceiptV0;
}): EveExternalActionWorkbenchCardV0 | null {
  const needsUserState = input.status === 'needs_user';
  if ((needsUserState && (!input.eventReceipt || input.receipt)) || (!needsUserState && !input.receipt)) return null;
  const productCount = input.executionContract.adapterPayloadProductCount;
  if (
    input.executionContract.domain === 'commerce' &&
    (!Number.isSafeInteger(productCount) || (productCount ?? 0) < 1 || (productCount ?? 0) > 100)
  ) {
    return null;
  }
  const receipt = input.receipt;
  const eventReceipt = input.eventReceipt;
  const status = needsUserState ? 'needs_user' : receipt!.outcome;
  const card = {
    version: 'command-eve-external-action-workbench-card/v0',
    conversationId: input.conversationId,
    operationRef: eventReceipt?.operationRef ?? receipt!.operationRef,
    authMode: eventReceipt?.authMode ?? receipt!.authMode,
    providerOrMerchantLabelCode: input.executionContract.providerOrMerchantLabelCode,
    occurredAt: eventReceipt?.occurredAt ?? receipt!.occurredAt,
    status,
    domain: input.executionContract.domain,
    action: input.executionContract.domainAction,
    origins:
      input.executionContract.domain === 'commerce'
        ? [input.executionContract.merchantOrigin!, input.executionContract.checkoutOrigin!]
        : [input.executionContract.providerOrigin!],
    ...(input.executionContract.domain === 'commerce'
      ? { commerce: { amount: input.proposal.action.amount, productCount: productCount! } }
      : {}),
    ...(eventReceipt
      ? {
          needsUser: {
            kind: eventReceipt.challengeKind,
            challengeRef: eventReceipt.challengeRef,
            instructionCode: eventReceipt.instructionCode,
            expiresAt: eventReceipt.expiresAt,
            resumeRef: eventReceipt.resumeRef,
            eventReceiptRef: eventReceipt.eventRef,
          },
          affordances: ['resume', 'revoke', 'stop'] as const,
        }
      : {
          receiptRef: receipt!.receiptRef,
          ...(receipt!.reconciliationRef ? { reconciliationRef: receipt!.reconciliationRef } : {}),
          affordances: status === 'unknown_outcome' ? (['reconcile'] as const) : ([] as const),
        }),
  };
  return card as unknown as EveExternalActionWorkbenchCardV0;
}

function validateCompletionAttestation(
  value: unknown,
  expected: {
    attestationRef: string;
    binding: EveExternalActionBinding;
    conversationContext: ExternalActionConversationContext;
    reservationId: string;
    challenge: EveExternalActionChallenge;
    nowMs: number;
  }
): ExternalActionCompletionAttestation | null {
  if (
    !hasExactKeys(value, [
      'version',
      'attestationRef',
      'reservationId',
      'challengeRef',
      'accountId',
      'seedId',
      'conversationId',
      'conversationSessionId',
      'completedAt',
    ])
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const completedAtMs = typeof candidate.completedAt === 'string' ? Date.parse(candidate.completedAt) : Number.NaN;
  if (
    candidate.version !== EXTERNAL_ACTION_COMPLETION_ATTESTATION_VERSION ||
    candidate.attestationRef !== expected.attestationRef ||
    candidate.reservationId !== expected.reservationId ||
    candidate.challengeRef !== expected.challenge.challengeRef ||
    candidate.accountId !== expected.binding.accountId ||
    candidate.seedId !== expected.binding.seedId ||
    candidate.conversationId !== expected.conversationContext.conversationId ||
    candidate.conversationSessionId !== expected.conversationContext.conversationSessionId ||
    !Number.isFinite(completedAtMs) ||
    completedAtMs > expected.nowMs ||
    completedAtMs > Date.parse(expected.challenge.expiresAt)
  ) {
    return null;
  }
  return candidate as unknown as ExternalActionCompletionAttestation;
}

function validateReconciliationEvidence(
  value: unknown,
  expected: {
    evidenceRef: string;
    reconciliationRef: string;
    reservationId: string;
    binding: EveExternalActionBinding;
    domain: ExternalActionExecutionContractIdentity['domain'];
    action: string;
    amount?: { currency: string; minorUnits: number };
    nowMs: number;
  }
): ExternalActionReconciliationEvidence | null {
  if (
    !hasExactKeys(
      value,
      [
        'version',
        'evidenceRef',
        'reservationId',
        'reconciliationRef',
        'decision',
        'evidenceDigest',
        'authorityReceiptDigest',
        'actorRef',
        'accountId',
        'seedId',
        'observedAt',
      ],
      ['result']
    )
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const observedAtMs = typeof candidate.observedAt === 'string' ? Date.parse(candidate.observedAt) : Number.NaN;
  if (
    candidate.version !== EXTERNAL_ACTION_RECONCILIATION_EVIDENCE_VERSION ||
    candidate.evidenceRef !== expected.evidenceRef ||
    candidate.reconciliationRef !== expected.reconciliationRef ||
    candidate.reservationId !== expected.reservationId ||
    candidate.accountId !== expected.binding.accountId ||
    candidate.seedId !== expected.binding.seedId ||
    !['reconciled_committed', 'reconciled_no_effect'].includes(String(candidate.decision)) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(candidate.evidenceDigest)) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(candidate.authorityReceiptDigest)) ||
    !isEveOpaqueId(candidate.actorRef) ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs > expected.nowMs
  ) {
    return null;
  }
  const parsedResult = Object.hasOwn(candidate, 'result')
    ? validateEveExternalActionSanitizedResult(candidate.result, {
        domain: expected.domain,
        action: expected.action,
        ...(expected.amount ? { amount: expected.amount } : {}),
      })
    : null;
  if (
    (candidate.decision === 'reconciled_committed' && !parsedResult) ||
    (candidate.decision === 'reconciled_no_effect' && Object.hasOwn(candidate, 'result'))
  ) {
    return null;
  }
  return {
    ...(candidate as unknown as ExternalActionReconciliationEvidence),
    ...(parsedResult ? { result: parsedResult } : {}),
  };
}

function workbenchCardFromReceipt(
  receipt: EveExternalActionReceiptV0,
  conversationId: string,
  providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode,
  productCount?: number
): EveExternalActionWorkbenchCardV0 | null {
  if (
    receipt.domain === 'commerce' &&
    (!receipt.amount || !Number.isSafeInteger(productCount) || (productCount ?? 0) < 1 || (productCount ?? 0) > 100)
  ) {
    return null;
  }
  const card = {
    version: 'command-eve-external-action-workbench-card/v0',
    conversationId,
    operationRef: receipt.operationRef,
    authMode: receipt.authMode,
    providerOrMerchantLabelCode,
    occurredAt: receipt.occurredAt,
    status: receipt.outcome,
    domain: receipt.domain,
    action: receipt.action,
    origins: receipt.origins,
    ...(receipt.domain === 'commerce' && receipt.amount
      ? { commerce: { amount: receipt.amount, productCount: productCount! } }
      : {}),
    receiptRef: receipt.receiptRef,
    ...(receipt.reconciliationRef ? { reconciliationRef: receipt.reconciliationRef } : {}),
    affordances: receipt.outcome === 'unknown_outcome' ? (['reconcile'] as const) : ([] as const),
  };
  return card as EveExternalActionWorkbenchCardV0;
}

type AdapterPayloadReadInput = ExternalActionAdapterPayloadValidationContext & {
  adapter: ExternalActionAdapter;
  payloadRef: string;
  payloadDigest: string;
};

type AdapterPayloadReadResult =
  | {
      ok: true;
      payload: Uint8Array;
      validation: ExternalActionAdapterPayloadValidation;
    }
  | { ok: false; reasonCode: string };

/**
 * Main-owned orchestrator. IPC supplies only the strict proposal; binding,
 * authority, classification, policy, clock, digests, reservation and claim are
 * reconstructed here for every attempt.
 */
export class ExternalActionExecutionService {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly adapters: readonly ExternalActionAdapter[];
  private readonly broker: ExternalSecretUseBroker;
  private readonly resumeTokens = new Map<string, string>();

  constructor(
    private readonly store: ExternalActionStore,
    private readonly deps: ExternalActionExecutionDeps
  ) {
    this.now = deps.now ?? (() => new Date());
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    this.adapters = deps.adapters ?? [];
    this.broker = new ExternalSecretUseBroker(store, this.now);
  }

  private async readValidatedAdapterPayload(input: AdapterPayloadReadInput): Promise<AdapterPayloadReadResult> {
    if (!this.deps.adapterPayloadReader || !input.adapter.validatePayload) {
      return { ok: false, reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_UNAVAILABLE' };
    }
    let payload: Uint8Array | undefined;
    let validatorPayload: Uint8Array | undefined;
    try {
      const readerPayload = await this.deps.adapterPayloadReader.read({
        payloadRef: input.payloadRef,
        expectedPayloadDigest: input.payloadDigest,
        binding: input.binding,
        conversationId: input.conversationId,
        conversationSessionId: input.conversationSessionId,
        adapterId: input.adapterId,
        actionKind: input.actionKind,
        targetOrigin: input.targetOrigin,
        domain: input.domain,
        action: input.action,
        counterpartyId: input.counterpartyId,
        origins: input.origins,
      });
      if (
        !(readerPayload instanceof Uint8Array) ||
        readerPayload.byteLength === 0 ||
        readerPayload.byteLength > 1024 * 1024 ||
        sha256Bytes(readerPayload) !== input.payloadDigest
      ) {
        readerPayload?.fill(0);
        return { ok: false, reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_MISMATCH' };
      }
      // Own the bytes after the reader returns. Neither a retaining reader nor
      // a normalizing validator can mutate the bytes later passed to execute.
      payload = Uint8Array.from(readerPayload);
      readerPayload.fill(0);
      validatorPayload = Uint8Array.from(payload);
      const validation = validateAdapterPayloadValidation(input.adapter.validatePayload(validatorPayload, input), {
        ...input,
        payloadDigest: input.payloadDigest,
      });
      validatorPayload.fill(0);
      validatorPayload = undefined;
      if (!validation) {
        payload.fill(0);
        return { ok: false, reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_SCHEMA_INVALID' };
      }
      return { ok: true, payload, validation };
    } catch {
      validatorPayload?.fill(0);
      payload?.fill(0);
      return { ok: false, reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_READ_FAILED' };
    }
  }

  private async prepareExecution(
    proposal: EveExternalActionProposal,
    budgetIncludesCurrentReservation: boolean
  ): Promise<{ ok: true; value: PreparedExecution } | { ok: false; outcome: EveExternalActionExecutionResult }> {
    let bindingResult: ExternalActionBindingResolution;
    try {
      bindingResult = this.deps.resolveBinding();
    } catch {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_BINDING_UNAVAILABLE' }) };
    }
    if ('reasonCode' in bindingResult) {
      return {
        ok: false,
        outcome: result('denied', {
          reasonCode: safeReason(bindingResult.reasonCode, 'EXTERNAL_BINDING_UNAVAILABLE'),
        }),
      };
    }
    const binding = bindingResult.binding;
    const conversationResult = this.resolveConversationContext();
    if ('reasonCode' in conversationResult) {
      return { ok: false, outcome: result('denied', { reasonCode: conversationResult.reasonCode }) };
    }
    const conversationContext = conversationResult.context;
    const policy = this.store.getPolicy(binding);
    if (!policy) return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' }) };
    if (policy.revokedAt) return { ok: false, outcome: result('revoked', { reasonCode: 'EXTERNAL_POLICY_REVOKED' }) };
    if (policy.killSwitch) return { ok: false, outcome: result('revoked', { reasonCode: 'EXTERNAL_POLICY_KILLED' }) };
    if (Date.parse(policy.expiresAt) <= this.now().getTime()) {
      return { ok: false, outcome: result('expired', { reasonCode: 'EXTERNAL_POLICY_EXPIRED' }) };
    }

    const stableBinding = this.recheckBinding(binding);
    if ('reasonCode' in stableBinding) return { ok: false, outcome: result('denied', stableBinding) };
    const stableConversation = this.recheckConversation(conversationContext);
    if ('reasonCode' in stableConversation) return { ok: false, outcome: result('denied', stableConversation) };
    const registered = resolveRegisteredAdapterOperation(this.adapters, proposal);
    if ('reasonCode' in registered) {
      return { ok: false, outcome: result('denied', { reasonCode: registered.reasonCode }) };
    }
    const { adapter, operation } = registered;
    const origins: readonly string[] =
      operation.domain === 'commerce'
        ? [operation.merchantOrigin, operation.checkoutOrigin]
        : [operation.providerOrigin];
    if (origins.some((origin) => !policy.allowedOrigins.includes(origin))) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_POLICY_ORIGIN_DENIED' }) };
    }

    const riskClass = classifyTrustedRisk(adapter, binding, proposal);
    if (!riskClass) {
      return {
        ok: false,
        outcome: result('needs_user', { reasonCode: 'EXTERNAL_RISK_CLASSIFICATION_REQUIRED' }),
      };
    }
    if (riskClass !== 'ordinary') {
      return {
        ok: false,
        outcome: result('needs_user', { reasonCode: 'EXTERNAL_ACTION_HUMAN_GATE_REQUIRED' }),
      };
    }

    let authority: ExternalActionAuthorityResolution;
    try {
      const budgetUsed = this.store.getBudgetUsedToday(binding, proposal.action.amount.currency);
      authority = await this.deps.resolveAuthority({
        binding,
        proposal,
        spentTodayMinor: budgetIncludesCurrentReservation
          ? Math.max(0, budgetUsed - proposal.action.amount.minorUnits)
          : budgetUsed,
        riskClass,
      });
    } catch {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_AUTHORITY_UNAVAILABLE' }) };
    }
    const stableAfterAuthority = this.recheckBinding(binding);
    if ('reasonCode' in stableAfterAuthority) {
      return { ok: false, outcome: result('denied', stableAfterAuthority) };
    }
    if (!isEveOpaqueId(authority.authorityGrantId)) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_AUTHORITY_INVALID' }) };
    }
    if (authority.decision === 'ask') {
      return {
        ok: false,
        outcome: result('needs_user', { reasonCode: 'EXTERNAL_AUTHORITY_CONFIRMATION_REQUIRED' }),
      };
    }
    if (authority.decision !== 'allow') {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_AUTHORITY_BLOCKED' }) };
    }
    if (authority.riskClass !== riskClass) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_RISK_CLASSIFICATION_CHANGED' }) };
    }
    const stableConversationAfterAuthority = this.recheckConversation(conversationContext);
    if ('reasonCode' in stableConversationAfterAuthority) {
      return { ok: false, outcome: result('denied', stableConversationAfterAuthority) };
    }

    if (proposal.action.adapterPayloadRef && !adapter.validatePayload) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_SCHEMA_REQUIRED' }) };
    }
    if (proposal.action.adapterPayloadRef && (proposal.oauthHandleId || proposal.passwordHandleId)) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_PAYLOAD_HANDLE_INGRESS_AMBIGUOUS' }) };
    }
    let payloadValidation: ExternalActionAdapterPayloadValidation | undefined;
    if (proposal.action.adapterPayloadRef && proposal.action.adapterPayloadDigest) {
      const read = await this.readValidatedAdapterPayload({
        adapter,
        payloadRef: proposal.action.adapterPayloadRef,
        payloadDigest: proposal.action.adapterPayloadDigest,
        binding,
        conversationId: conversationContext.conversationId,
        conversationSessionId: conversationContext.conversationSessionId,
        adapterId: adapter.id,
        actionKind: proposal.action.kind,
        targetOrigin: proposal.action.targetOrigin,
        domain: operation.domain,
        action: operation.action,
        counterpartyId: operation.counterpartyId,
        origins,
        argumentsDigest: proposal.action.argumentsDigest,
        ...(proposal.action.quoteDigest ? { quoteDigest: proposal.action.quoteDigest } : {}),
        amount: proposal.action.amount,
      });
      if ('reasonCode' in read) {
        return { ok: false, outcome: result('denied', { reasonCode: read.reasonCode }) };
      }
      payloadValidation = read.validation;
      read.payload.fill(0);
    }
    if (operation.domain !== 'generic' && !payloadValidation) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_REQUIRED' }) };
    }
    if (operation.domain === 'commerce' && !payloadValidation?.commerce) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_COMMERCE_PAYLOAD_REQUIRED' }) };
    }

    let auth: SelectedAuthResult;
    try {
      auth = await this.selectAuth(adapter, binding, proposal, payloadValidation?.slotManifest ?? []);
    } catch {
      return { ok: false, outcome: result('needs_user', { reasonCode: 'EXTERNAL_AUTH_PROBE_UNAVAILABLE' }) };
    }
    if (auth.status === 'denied') {
      return { ok: false, outcome: result('denied', { reasonCode: auth.reasonCode }) };
    }
    if (auth.status === 'needs_user' && !auth.resumable) {
      return {
        ok: false,
        outcome: result('needs_user', { reasonCode: auth.reasonCode, authMode: auth.authMode }),
      };
    }
    if (payloadValidation && payloadValidation.authMode !== auth.authMode) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_AUTH_SLOT_CONTRACT_STALE' }) };
    }
    const fallbackSlots = [
      ...(auth.authMode === 'oauth' && proposal.oauthHandleId
        ? [{ slot: 'oauth_token' as const, handleId: proposal.oauthHandleId, handleType: 'oauth_token' as const }]
        : []),
      ...(auth.authMode === 'password' && proposal.passwordHandleId
        ? [
            {
              slot: 'account_password' as const,
              handleId: proposal.passwordHandleId,
              handleType: 'account_credential' as const,
            },
          ]
        : []),
    ].toSorted((left, right) => left.slot.localeCompare(right.slot));
    const candidateSlots = payloadValidation?.slotManifest ?? fallbackSlots;
    const slotManifest = selectedSlotManifest(
      candidateSlots,
      auth.authMode,
      operation.domain,
      operation.action
    );
    if (!slotManifest) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_AUTH_SLOT_CONTRACT_INVALID' }) };
    }
    if (auth.status === 'ready' && auth.handleId && !slotManifest.some((entry) => entry.handleId === auth.handleId)) {
      return { ok: false, outcome: result('denied', { reasonCode: 'EXTERNAL_AUTH_SLOT_CONTRACT_STALE' }) };
    }
    const classificationDigest = sha256(canonical({ actionKind: proposal.action.kind, riskClass }));
    const authorityReceiptDigest = sha256(
      canonical({
        authorityGrantId: authority.authorityGrantId,
        classificationDigest,
        policyRevision: policy.revision,
        sessionEpoch: policy.sessionEpoch,
      })
    );
    const operationPreimage: ExternalActionOperationDigestPreimage = {
      binding,
      conversationContext,
      adapterId: adapter.id,
      authMode: auth.authMode,
      slotManifest,
      action: proposal.action,
    };
    const operationDigest = sha256(canonical(operationPreimage));
    const intentPreimage: ExternalActionIntentDigestPreimage = {
      installationId: binding.installationId,
      accountId: binding.accountId,
      seedId: binding.seedId,
      domain: operation.domain,
      domainAction: operation.action,
      counterpartyId: operation.counterpartyId,
      origins,
      actionKind: proposal.action.kind,
      targetOrigin: proposal.action.targetOrigin,
      argumentsDigest: proposal.action.argumentsDigest,
      quoteDigest: proposal.action.quoteDigest ?? null,
      amount: proposal.action.amount,
      adapterPayloadDigest: proposal.action.adapterPayloadDigest ?? null,
      cartDigest: payloadValidation?.commerce?.cartDigest ?? null,
      productCount: payloadValidation?.commerce?.productCount ?? null,
    };
    const intentDigest = sha256(canonical(intentPreimage));
    const executionPreimage: ExternalActionExecutionDigestPreimage = {
      operationDigest,
      policyRevision: policy.revision,
      sessionEpoch: policy.sessionEpoch,
      authorityGrantId: authority.authorityGrantId,
      riskClass,
      adapterId: adapter.id,
      installationId: binding.installationId,
      accountId: binding.accountId,
      seedId: binding.seedId,
      conversationId: conversationContext.conversationId,
      conversationSessionId: conversationContext.conversationSessionId,
      authMode: auth.authMode,
      domain: operation.domain,
      domainAction: operation.action,
      counterpartyId: operation.counterpartyId,
      providerOrMerchantLabelCode: adapter.providerOrMerchantLabelCode,
      origins,
      slotManifest,
      actionKind: proposal.action.kind,
      targetOrigin: proposal.action.targetOrigin,
      argumentsDigest: proposal.action.argumentsDigest,
      quoteDigest: proposal.action.quoteDigest ?? null,
      amount: proposal.action.amount,
      oauthHandleId: proposal.oauthHandleId ?? null,
      passwordHandleId: proposal.passwordHandleId ?? null,
      adapterPayloadRef: proposal.action.adapterPayloadRef ?? null,
      adapterPayloadDigest: proposal.action.adapterPayloadDigest ?? null,
      adapterPayloadProductCount: payloadValidation?.commerce?.productCount ?? null,
      cartDigest: payloadValidation?.commerce?.cartDigest ?? null,
      registeredOperation: operation,
    };
    const executionContractDigest = sha256(canonical(executionPreimage));
    const executionContract: ExternalActionExecutionContractIdentity = {
      installationId: binding.installationId,
      accountId: binding.accountId,
      seedId: binding.seedId,
      conversationId: conversationContext.conversationId,
      conversationSessionId: conversationContext.conversationSessionId,
      adapterId: adapter.id,
      authMode: auth.authMode,
      domain: operation.domain,
      domainAction: operation.action,
      counterpartyId: operation.counterpartyId,
      providerOrMerchantLabelCode: adapter.providerOrMerchantLabelCode,
      ...(proposal.action.adapterPayloadRef
        ? {
            adapterPayloadRef: proposal.action.adapterPayloadRef,
            adapterPayloadDigest: proposal.action.adapterPayloadDigest!,
            ...(payloadValidation?.commerce
              ? {
                  adapterPayloadProductCount: payloadValidation.commerce.productCount,
                  cartDigest: payloadValidation.commerce.cartDigest,
                }
              : {}),
          }
        : {}),
      ...(operation.domain === 'commerce'
        ? { merchantOrigin: operation.merchantOrigin, checkoutOrigin: operation.checkoutOrigin }
        : { providerOrigin: operation.providerOrigin }),
      slotManifest,
      intentId: `intent:${intentDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`,
      requestId: `request:${sha256(proposal.clientRequestId).slice('sha256:'.length, 'sha256:'.length + 48)}`,
      operationDigest,
      idempotencyKeyDigest: sha256(proposal.idempotencyKey),
      executionContractDigest,
      authorityGrantId: authority.authorityGrantId,
      authorityReceiptDigest,
      classificationDigest,
      policyRevision: policy.revision,
      sessionEpoch: policy.sessionEpoch,
      ...(proposal.action.quoteDigest ? { quoteDigest: proposal.action.quoteDigest } : {}),
      actionKind: proposal.action.kind,
      targetOrigin: proposal.action.targetOrigin,
      amountMinor: proposal.action.amount.minorUnits,
      currency: proposal.action.amount.currency,
    };
    return {
      ok: true,
      value: { binding, conversationContext, policy, adapter, riskClass, authority, auth, executionContract },
    };
  }

  async execute(untrusted: unknown): Promise<EveExternalActionExecutionResult> {
    const parsed = validateEveExternalActionProposal(untrusted);
    if ('reasonCode' in parsed) return result('denied', { reasonCode: parsed.reasonCode });
    const proposal = parsed.value;
    const prepared = await this.prepareExecution(proposal, false);
    if ('outcome' in prepared) return prepared.outcome;
    const { binding, conversationContext, policy, adapter, riskClass, authority, auth, executionContract } =
      prepared.value;
    const expiryMs = Math.min(Date.parse(policy.expiresAt), this.now().getTime() + CLAIM_TTL_MS);
    const reserved = this.store.reserve({
      binding,
      conversationId: conversationContext.conversationId,
      conversationSessionId: conversationContext.conversationSessionId,
      adapterId: adapter.id,
      authMode: executionContract.authMode,
      adapterDomain: executionContract.domain,
      adapterAction: executionContract.domainAction,
      counterpartyId: executionContract.counterpartyId,
      providerOrMerchantLabelCode: executionContract.providerOrMerchantLabelCode,
      adapterOrigins:
        executionContract.domain === 'commerce'
          ? [executionContract.merchantOrigin!, executionContract.checkoutOrigin!]
          : [executionContract.providerOrigin!],
      slotManifest: executionContract.slotManifest,
      ...(executionContract.adapterPayloadRef
        ? {
            adapterPayloadRef: executionContract.adapterPayloadRef,
            adapterPayloadDigest: executionContract.adapterPayloadDigest!,
            ...(executionContract.adapterPayloadProductCount !== undefined
              ? { adapterPayloadProductCount: executionContract.adapterPayloadProductCount }
              : {}),
            ...(executionContract.cartDigest ? { cartDigest: executionContract.cartDigest } : {}),
          }
        : {}),
      policyRevision: policy.revision,
      sessionEpoch: policy.sessionEpoch,
      authorityDecision: authority.decision,
      authorityGrantId: authority.authorityGrantId,
      authorityReceiptDigest: executionContract.authorityReceiptDigest,
      classificationDigest: executionContract.classificationDigest,
      riskClass,
      actionKind: proposal.action.kind,
      targetOrigin: proposal.action.targetOrigin,
      intentId: executionContract.intentId,
      requestId: executionContract.requestId,
      operationDigest: executionContract.operationDigest,
      idempotencyKeyDigest: executionContract.idempotencyKeyDigest,
      executionContractDigest: executionContract.executionContractDigest,
      ...(proposal.action.quoteDigest ? { quoteDigest: proposal.action.quoteDigest } : {}),
      amountMinor: proposal.action.amount.minorUnits,
      currency: proposal.action.amount.currency,
      expiresAt: new Date(expiryMs).toISOString(),
    });
    if (!reserved.ok || !reserved.reservationId) {
      const reasonCode = reserved.reasonCode ?? 'EXTERNAL_LEDGER_RESERVE_FAILED';
      return result(statusForReason(reasonCode), {
        reasonCode,
        ...(reserved.reservationId ? { reservationId: reserved.reservationId } : {}),
      });
    }
    if (reserved.replay && reserved.state !== 'reserved') {
      if (reserved.state === 'allowed')
        return result('allowed', {
          reservationId: reserved.reservationId,
          replay: true,
          ...this.presentation({
            status: 'allowed',
            binding,
            proposal,
            executionContract,
            reservationId: reserved.reservationId,
          }),
        });
      if (reserved.state === 'suspended') {
        const challenge = this.store.getPendingChallenge(binding, reserved.reservationId);
        return result('needs_user', {
          reasonCode: challenge?.snapshot.challenge.userInstructionCode ?? 'EXTERNAL_CHALLENGE_PENDING',
          reservationId: reserved.reservationId,
          replay: true,
          ...(challenge ? { eventReceipt: challenge.eventReceipt, authMode: challenge.snapshot.authMode } : {}),
          ...this.presentation({
            status: 'needs_user',
            binding,
            proposal,
            executionContract,
            reservationId: reserved.reservationId,
            ...(challenge ? { eventReceipt: challenge.eventReceipt } : {}),
          }),
        });
      }
      if (reserved.state === 'unknown' || reserved.state === 'claimed' || reserved.state === 'resuming') {
        return result('unknown_outcome', {
          reasonCode: 'EXTERNAL_REPLAY_OUTCOME_UNKNOWN',
          reservationId: reserved.reservationId,
          replay: true,
          retryAllowed: false,
          ...this.presentation({
            status: 'unknown_outcome',
            binding,
            proposal,
            executionContract,
            reservationId: reserved.reservationId,
          }),
        });
      }
      if (reserved.state === 'reconciled_committed' || reserved.state === 'reconciled_no_effect') {
        const receipt = this.store.getReceipt(binding, reserved.reservationId);
        return receipt
          ? result(reserved.state, {
              reservationId: reserved.reservationId,
              replay: true,
              retryAllowed: false,
              receipt,
              ...this.workbenchProjectionFromReceipt(
                receipt,
                {
                  version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
                  conversationId: executionContract.conversationId,
                  conversationSessionId: executionContract.conversationSessionId,
                },
                executionContract.providerOrMerchantLabelCode,
                executionContract.adapterPayloadProductCount
              ),
            })
          : result('unknown_outcome', {
              reasonCode: 'EXTERNAL_RECONCILIATION_RECEIPT_MISSING',
              reservationId: reserved.reservationId,
              replay: true,
              retryAllowed: false,
            });
      }
      if (['reversed', 'denied', 'revoked', 'expired'].includes(reserved.state)) {
        const receipt = this.store.getReceipt(binding, reserved.reservationId);
        const status = reserved.state === 'revoked' ? 'revoked' : reserved.state === 'expired' ? 'expired' : 'denied';
        return receipt
          ? result(status, {
              reasonCode: receipt.reasonCode ?? 'EXTERNAL_REPLAY_NOT_EXECUTABLE',
              reservationId: reserved.reservationId,
              replay: true,
              receipt,
              ...this.workbenchProjectionFromReceipt(
                receipt,
                {
                  version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
                  conversationId: executionContract.conversationId,
                  conversationSessionId: executionContract.conversationSessionId,
                },
                executionContract.providerOrMerchantLabelCode,
                executionContract.adapterPayloadProductCount
              ),
            })
          : result('unknown_outcome', {
              reasonCode: 'EXTERNAL_TERMINAL_RECEIPT_MISSING',
              reservationId: reserved.reservationId,
              replay: true,
              retryAllowed: false,
            });
      }
      return result('denied', {
        reasonCode: 'EXTERNAL_REPLAY_NOT_EXECUTABLE',
        reservationId: reserved.reservationId,
        replay: true,
        ...this.presentation({
          status: 'denied',
          binding,
          proposal,
          executionContract,
          reservationId: reserved.reservationId,
        }),
      });
    }

    const claimId = `claim:${this.randomUUID()}`;
    const claimDigest = sha256(
      canonical({ executionContractDigest: executionContract.executionContractDigest, claimId })
    );
    const claimed = this.store.claim({
      binding,
      reservationId: reserved.reservationId,
      claimId,
      claimDigest,
      policyRevision: policy.revision,
      sessionEpoch: policy.sessionEpoch,
    });
    if (!claimed.execute) {
      const reasonCode = claimed.reasonCode ?? 'EXTERNAL_CLAIM_NOT_EXECUTABLE';
      return result(
        claimed.state === 'unknown' || claimed.state === 'claimed' ? 'unknown_outcome' : statusForReason(reasonCode),
        {
          reasonCode,
          reservationId: reserved.reservationId,
          replay: claimed.replay,
          ...(claimed.state === 'unknown' || claimed.state === 'claimed' || claimed.state === 'resuming'
            ? { retryAllowed: false as const }
            : {}),
        }
      );
    }

    const claimedContract: ExternalActionExecutionContractExpectation = {
      ...executionContract,
      reservationId: reserved.reservationId,
      claimId,
      claimDigest,
    };

    return this.continueClaimed({
      binding,
      policy,
      adapter,
      riskClass,
      authority,
      auth,
      proposal,
      reservationId: reserved.reservationId,
      claimId,
      executionContract: claimedContract,
    });
  }

  async resume(untrusted: unknown): Promise<EveExternalActionExecutionResult> {
    const parsed = validateEveExternalActionResumeRequest(untrusted);
    if ('reasonCode' in parsed) return result('denied', { reasonCode: parsed.reasonCode });
    let bindingResult: ExternalActionBindingResolution;
    try {
      bindingResult = this.deps.resolveBinding();
    } catch {
      return result('denied', { reasonCode: 'EXTERNAL_BINDING_UNAVAILABLE' });
    }
    if ('reasonCode' in bindingResult) {
      return result('denied', {
        reasonCode: safeReason(bindingResult.reasonCode, 'EXTERNAL_BINDING_UNAVAILABLE'),
      });
    }
    const conversationResult = this.resolveConversationContext();
    if ('reasonCode' in conversationResult) return result('denied', { reasonCode: conversationResult.reasonCode });
    const conversationContext = conversationResult.context;
    const resumeToken = this.resumeTokens.get(parsed.value.resumeRef);
    if (!resumeToken) return result('denied', { reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
    const resumeTokenDigest = sha256(resumeToken);
    const pending = this.store.getPendingChallengeByTokenDigest(bindingResult.binding, resumeTokenDigest);
    if (
      !pending ||
      pending.eventReceipt.resumeRef !== parsed.value.resumeRef ||
      pending.executionContract.conversationId !== conversationContext.conversationId ||
      pending.executionContract.conversationSessionId !== conversationContext.conversationSessionId
    ) {
      return result('denied', { reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
    }
    const prepared = await this.prepareExecution(pending.snapshot.proposal, true);
    if ('outcome' in prepared) return prepared.outcome;
    const { binding, policy, adapter, riskClass, authority, auth, executionContract } = prepared.value;
    const {
      claimDigest: _persistedClaimDigest,
      reservationId: _persistedReservationId,
      claimId: _persistedClaimId,
      ...pendingExecutionIdentity
    } = pending.executionContract;
    if (
      !sameBinding(binding, bindingResult.binding) ||
      adapter.id !== pending.snapshot.adapterId ||
      canonical(executionContract) !== canonical(pendingExecutionIdentity)
    ) {
      return result('denied', { reasonCode: 'EXTERNAL_RESUME_CONTRACT_STALE' });
    }
    if (pending.snapshot.continuation === 'adapter_resume' && !adapter.resume) {
      return result('needs_user', {
        reasonCode: 'EXTERNAL_ADAPTER_RESUME_UNAVAILABLE',
        reservationId: pending.reservationId,
      });
    }
    let completionAttestation: ExternalActionCompletionAttestation | null = null;
    if (parsed.value.completionAttestationRef) {
      if (!this.deps.completionAttestationReader) {
        return result('denied', {
          reasonCode: 'EXTERNAL_COMPLETION_ATTESTATION_UNAVAILABLE',
          reservationId: pending.reservationId,
        });
      }
      let rawAttestation: unknown;
      try {
        rawAttestation = await this.deps.completionAttestationReader.read({
          attestationRef: parsed.value.completionAttestationRef,
          binding,
          conversationContext,
          reservationId: pending.reservationId,
          challengeRef: pending.snapshot.challenge.challengeRef,
        });
      } catch {
        rawAttestation = null;
      }
      completionAttestation = validateCompletionAttestation(rawAttestation, {
        attestationRef: parsed.value.completionAttestationRef,
        binding,
        conversationContext,
        reservationId: pending.reservationId,
        challenge: pending.snapshot.challenge,
        nowMs: this.now().getTime(),
      });
      if (!completionAttestation) {
        return result('denied', {
          reasonCode: 'EXTERNAL_COMPLETION_ATTESTATION_INVALID',
          reservationId: pending.reservationId,
        });
      }
    }
    const completionAttestationDigest = sha256(
      canonical({
        version: 'command-eve-external-action-completion-attestation-digest/v0',
        binding,
        conversationContext,
        reservationId: pending.reservationId,
        claimId: pending.claimId,
        challengeRef: pending.snapshot.challenge.challengeRef,
        eventRef: pending.eventReceipt.eventRef,
        resumeRef: parsed.value.resumeRef,
        completionAttestation,
      })
    );
    const resumed = this.store.resumeChallenge({
      binding,
      conversationId: conversationContext.conversationId,
      conversationSessionId: conversationContext.conversationSessionId,
      resumeTokenDigest,
      completionAttestationDigest,
    });
    if ('reasonCode' in resumed) {
      if (resumed.reasonCode.includes('NOT_ACTIVE') || resumed.reasonCode.includes('EXPIRED')) {
        this.resumeTokens.delete(parsed.value.resumeRef);
      }
      return result(statusForReason(resumed.reasonCode), {
        reasonCode: resumed.reasonCode,
        reservationId: pending.reservationId,
      });
    }
    this.resumeTokens.delete(parsed.value.resumeRef);
    return this.continueClaimed({
      binding,
      policy,
      adapter,
      riskClass,
      authority,
      auth,
      proposal: resumed.record.snapshot.proposal,
      reservationId: resumed.record.reservationId,
      claimId: resumed.record.claimId,
      executionContract: resumed.record.executionContract,
      resume: {
        continuation: resumed.record.snapshot.continuation,
        challenge: resumed.record.snapshot.challenge,
        completionAttestationDigest,
        completionAttestationPresent: completionAttestation !== null,
        authMode: resumed.record.snapshot.authMode,
      },
    });
  }

  /**
   * Main-only evidence reconciliation. It never re-enters an adapter and has
   * no renderer IPC; the caller supplies opaque refs and a registered trusted
   * reader supplies the immutable evidence and authority receipt digests.
   */
  async reconcileFromMain(untrusted: unknown): Promise<EveExternalActionExecutionResult> {
    if (!hasExactKeys(untrusted, ['version', 'reconciliationRef', 'evidenceRef'])) {
      return result('denied', { reasonCode: 'EXTERNAL_RECONCILIATION_REQUEST_INVALID' });
    }
    const request = untrusted as Record<string, unknown>;
    if (
      request.version !== EXTERNAL_ACTION_RECONCILIATION_REQUEST_VERSION ||
      !isEveOpaqueId(request.reconciliationRef) ||
      !isEveOpaqueId(request.evidenceRef)
    ) {
      return result('denied', { reasonCode: 'EXTERNAL_RECONCILIATION_REQUEST_INVALID' });
    }
    let bindingResult: ExternalActionBindingResolution;
    try {
      bindingResult = this.deps.resolveBinding();
    } catch {
      return result('denied', { reasonCode: 'EXTERNAL_BINDING_UNAVAILABLE' });
    }
    if ('reasonCode' in bindingResult) {
      return result('denied', { reasonCode: safeReason(bindingResult.reasonCode, 'EXTERNAL_BINDING_UNAVAILABLE') });
    }
    const binding = bindingResult.binding;
    const unknown = this.store.findUnknownByReconciliationRef(binding, request.reconciliationRef);
    if (!unknown) return result('denied', { reasonCode: 'EXTERNAL_RECONCILIATION_NOT_ACTIVE' });
    if (!this.deps.reconciliationEvidenceReader) {
      return result('unknown_outcome', {
        reasonCode: 'EXTERNAL_RECONCILIATION_EVIDENCE_UNAVAILABLE',
        reservationId: unknown.reservation.reservationId,
        retryAllowed: false,
        receipt: unknown.receipt,
        ...this.workbenchProjectionFromReceipt(
          unknown.receipt,
          {
            version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
            conversationId: unknown.reservation.conversationId,
            conversationSessionId: unknown.reservation.conversationSessionId,
          },
          unknown.reservation.providerOrMerchantLabelCode,
          unknown.reservation.adapterPayloadProductCount
        ),
      });
    }
    let rawEvidence: unknown;
    try {
      rawEvidence = await this.deps.reconciliationEvidenceReader.read({
        evidenceRef: request.evidenceRef,
        reconciliationRef: request.reconciliationRef,
        reservationId: unknown.reservation.reservationId,
        binding,
      });
    } catch {
      rawEvidence = null;
    }
    const evidence = validateReconciliationEvidence(rawEvidence, {
      evidenceRef: request.evidenceRef,
      reconciliationRef: request.reconciliationRef,
      reservationId: unknown.reservation.reservationId,
      binding,
      domain: unknown.reservation.adapterDomain,
      action: unknown.reservation.adapterAction,
      ...(unknown.reservation.amountMinor > 0
        ? { amount: { currency: unknown.reservation.currency, minorUnits: unknown.reservation.amountMinor } }
        : {}),
      nowMs: this.now().getTime(),
    });
    if (!evidence) {
      return result('unknown_outcome', {
        reasonCode: 'EXTERNAL_RECONCILIATION_EVIDENCE_INVALID',
        reservationId: unknown.reservation.reservationId,
        retryAllowed: false,
        receipt: unknown.receipt,
        ...this.workbenchProjectionFromReceipt(
          unknown.receipt,
          {
            version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
            conversationId: unknown.reservation.conversationId,
            conversationSessionId: unknown.reservation.conversationSessionId,
          },
          unknown.reservation.providerOrMerchantLabelCode,
          unknown.reservation.adapterPayloadProductCount
        ),
      });
    }
    const reconciled = this.store.reconcileUnknown({
      binding,
      reservationId: unknown.reservation.reservationId,
      reconciliationRef: request.reconciliationRef,
      decision: evidence.decision,
      evidenceDigest: evidence.evidenceDigest,
      authorityReceiptDigest: evidence.authorityReceiptDigest,
      actorRef: evidence.actorRef,
      ...(evidence.result ? { result: evidence.result } : {}),
    });
    if (!reconciled.ok || !reconciled.receipt || reconciled.state !== evidence.decision) {
      return result('unknown_outcome', {
        reasonCode: reconciled.reasonCode ?? 'EXTERNAL_RECONCILIATION_PERSIST_FAILED',
        reservationId: unknown.reservation.reservationId,
        retryAllowed: false,
        receipt: unknown.receipt,
        ...this.workbenchProjectionFromReceipt(
          unknown.receipt,
          {
            version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
            conversationId: unknown.reservation.conversationId,
            conversationSessionId: unknown.reservation.conversationSessionId,
          },
          unknown.reservation.providerOrMerchantLabelCode,
          unknown.reservation.adapterPayloadProductCount
        ),
      });
    }
    return result(evidence.decision, {
      reservationId: unknown.reservation.reservationId,
      retryAllowed: false,
      receipt: reconciled.receipt,
      ...this.workbenchProjectionFromReceipt(
        reconciled.receipt,
        {
          version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
          conversationId: unknown.reservation.conversationId,
          conversationSessionId: unknown.reservation.conversationSessionId,
        },
        unknown.reservation.providerOrMerchantLabelCode,
        unknown.reservation.adapterPayloadProductCount
      ),
    });
  }

  private async continueClaimed(input: {
    binding: EveExternalActionBinding;
    policy: EveExternalActionPolicy;
    adapter: ExternalActionAdapter;
    riskClass: EveExternalActionRiskClass;
    authority: ExternalActionAuthorityResolution;
    auth: Extract<SelectedAuthResult, { status: 'ready' | 'needs_user' }>;
    proposal: EveExternalActionProposal;
    reservationId: string;
    claimId: string;
    executionContract: ExternalActionExecutionContractExpectation;
    resume?: {
      continuation: ExternalActionContinuationKind;
      challenge: EveExternalActionChallenge;
      completionAttestationDigest: string;
      completionAttestationPresent: boolean;
      authMode: ExternalActionAuthMode;
    };
  }): Promise<EveExternalActionExecutionResult> {
    const { binding, adapter, proposal, reservationId, claimId, executionContract, auth } = input;
    if (input.resume?.continuation === 'adapter_resume') {
      const preflight = await this.recheckTrustedExecution(
        binding,
        proposal,
        adapter,
        input.authority.authorityGrantId,
        input.riskClass,
        {
          version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
          conversationId: executionContract.conversationId,
          conversationSessionId: executionContract.conversationSessionId,
        }
      );
      if ('reasonCode' in preflight) {
        this.store.markUnknown({
          binding,
          reservationId,
          claimId,
          authMode: executionContract.authMode,
          reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
          outcomeDigest: sha256(preflight.reasonCode),
        });
        return result('unknown_outcome', {
          reasonCode: preflight.reasonCode,
          reservationId,
          authMode: input.resume.authMode,
          retryAllowed: false,
          ...this.presentation({ status: 'unknown_outcome', binding, proposal, executionContract, reservationId }),
        });
      }
      const claim = this.store.recheckClaimForExecution(binding, reservationId, claimId, executionContract);
      if ('reasonCode' in claim || !adapter.resume) {
        const reasonCode = 'reasonCode' in claim ? claim.reasonCode : 'EXTERNAL_ADAPTER_RESUME_UNAVAILABLE';
        this.store.markUnknown({
          binding,
          reservationId,
          claimId,
          authMode: executionContract.authMode,
          reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
          outcomeDigest: sha256(reasonCode),
        });
        return result('unknown_outcome', {
          reasonCode,
          reservationId,
          authMode: input.resume.authMode,
          retryAllowed: false,
          ...this.presentation({ status: 'unknown_outcome', binding, proposal, executionContract, reservationId }),
        });
      }
      const activated = this.store.activateResumedClaim(binding, reservationId, claimId, executionContract);
      if ('reasonCode' in activated) {
        this.store.markUnknown({
          binding,
          reservationId,
          claimId,
          authMode: executionContract.authMode,
          reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
          outcomeDigest: sha256(activated.reasonCode),
        });
        return result('unknown_outcome', {
          reasonCode: activated.reasonCode,
          reservationId,
          authMode: input.resume.authMode,
          retryAllowed: false,
          ...this.presentation({ status: 'unknown_outcome', binding, proposal, executionContract, reservationId }),
        });
      }
      const dispatched = await this.invokeWithVerifiedPayload(
        {
          binding,
          proposal,
          adapter,
          authorityGrantId: input.authority.authorityGrantId,
          riskClass: input.riskClass,
          reservationId,
          claimId,
          executionContract,
          effectful: true,
        },
        (adapterPayload) =>
          adapter.resume!({
            binding,
            proposal,
            authMode: input.resume!.authMode,
            ...(auth.status === 'ready' && auth.browserPartition ? { browserPartition: auth.browserPartition } : {}),
            ...(adapterPayload ? { adapterPayload } : {}),
            challenge: input.resume!.challenge,
            completionAttestationDigest: input.resume!.completionAttestationDigest,
            completionAttestationPresent: input.resume!.completionAttestationPresent,
          })
      );
      if ('reasonCode' in dispatched) {
        if (dispatched.beforeEffect) {
          const status = statusForBrokerReason(dispatched.reasonCode);
          this.store.reverse({
            binding,
            reservationId,
            claimId,
            authMode: executionContract.authMode,
            terminalState: terminalStateForStatus(status),
            reasonCode: dispatched.reasonCode,
            outcomeDigest: sha256(dispatched.reasonCode),
          });
          return result(status, {
            reasonCode: dispatched.reasonCode,
            reservationId,
            authMode: executionContract.authMode,
            ...this.presentation({ status, binding, proposal, executionContract, reservationId }),
          });
        }
        return this.persistAdapterOutcome(
          input,
          { status: 'unknown_outcome', reasonCode: unknownOutcomeReason(dispatched.reasonCode) },
          executionContract.authMode,
          true
        );
      }
      const terminal = adapterOutcome(dispatched.value, executionContract);
      return this.persistAdapterOutcome(input, terminal, input.resume.authMode, true);
    }

    if (adapter.probeChallenge) {
      const probed = await this.invokeWithVerifiedPayload(
        {
          binding,
          proposal,
          adapter,
          authorityGrantId: input.authority.authorityGrantId,
          riskClass: input.riskClass,
          reservationId,
          claimId,
          executionContract,
          effectful: false,
        },
        (adapterPayload) =>
          adapter.probeChallenge!({ binding, proposal, ...(adapterPayload ? { adapterPayload } : {}) })
      );
      if (!probed.ok || !isChallengeProbe(probed.value)) {
        this.store.reverse({
          binding,
          reservationId,
          claimId,
          authMode: executionContract.authMode,
          terminalState: 'denied',
          reasonCode: 'EXTERNAL_CHALLENGE_PROBE_INVALID',
          outcomeDigest: sha256('EXTERNAL_CHALLENGE_PROBE_INVALID'),
        });
        return result('denied', {
          reasonCode: 'EXTERNAL_CHALLENGE_PROBE_INVALID',
          reservationId,
          ...this.presentation({ status: 'denied', binding, proposal, executionContract, reservationId }),
        });
      }
      const probe = probed.value;
      if (probe.status === 'needs_user') {
        return this.suspendChallenge(
          input,
          probe.challenge,
          executionContract.authMode,
          'pre_execute_probe',
          `continuation:${sha256(canonical(probe.challenge)).slice('sha256:'.length, 'sha256:'.length + 48)}`,
          false
        );
      }
    }

    if (auth.status === 'needs_user') {
      const challenge = this.authChallenge(input, auth.authMode, auth.reasonCode, auth.challengeKind);
      if (challenge) {
        return this.suspendChallenge(
          input,
          challenge,
          auth.authMode,
          'pre_execute_probe',
          `continuation:${sha256(canonical({ authMode: auth.authMode, challenge })).slice(
            'sha256:'.length,
            'sha256:'.length + 48
          )}`,
          false
        );
      }
      this.store.reverse({
        binding,
        reservationId,
        claimId,
        authMode: executionContract.authMode,
        terminalState: 'denied',
        reasonCode: auth.reasonCode,
        outcomeDigest: sha256(auth.reasonCode),
      });
      return result('denied', {
        reasonCode: auth.reasonCode,
        reservationId,
        authMode: auth.authMode,
        ...this.presentation({ status: 'denied', binding, proposal, executionContract, reservationId }),
      });
    }

    let outcome: ExternalActionAdapterOutcome | undefined;
    const authSlot = auth.handleId ? (auth.authMode === 'oauth' ? 'oauth_token' : 'account_password') : undefined;
    const authSlotBinding = authSlot
      ? executionContract.slotManifest.find((entry) => entry.slot === authSlot)
      : undefined;
    if (
      auth.handleId &&
      (!authSlotBinding ||
        authSlotBinding.handleId !== auth.handleId ||
        authSlotBinding.handleType !== (auth.authMode === 'oauth' ? 'oauth_token' : 'account_credential'))
    ) {
      this.store.reverse({
        binding,
        reservationId,
        claimId,
        authMode: executionContract.authMode,
        terminalState: 'denied',
        reasonCode: 'EXTERNAL_AUTH_SLOT_CONTRACT_STALE',
        outcomeDigest: sha256('EXTERNAL_AUTH_SLOT_CONTRACT_STALE'),
      });
      return result('denied', {
        reasonCode: 'EXTERNAL_AUTH_SLOT_CONTRACT_STALE',
        reservationId,
        authMode: auth.authMode,
        ...this.presentation({ status: 'denied', binding, proposal, executionContract, reservationId }),
      });
    }

    const slotsToUse = executionContract.slotManifest;

    if (input.resume) {
      const activated = this.store.activateResumedClaim(binding, reservationId, claimId, executionContract);
      if ('reasonCode' in activated) {
        this.store.markUnknown({
          binding,
          reservationId,
          claimId,
          authMode: executionContract.authMode,
          reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
          outcomeDigest: sha256(activated.reasonCode),
        });
        return result('unknown_outcome', {
          reasonCode: activated.reasonCode,
          reservationId,
          authMode: auth.authMode,
          retryAllowed: false,
          ...this.presentation({ status: 'unknown_outcome', binding, proposal, executionContract, reservationId }),
        });
      }
    }

    for (const slotBinding of slotsToUse) {
      const permit = this.store.registerSecretSlotPermit({
        binding,
        reservationId,
        claimId,
        slot: slotBinding.slot,
        handleId: slotBinding.handleId,
        expectedHandleType: slotBinding.handleType,
        executionContract,
      });
      if ('reasonCode' in permit) {
        const status = statusForBrokerReason(permit.reasonCode);
        this.store.reverse({
          binding,
          reservationId,
          claimId,
          authMode: executionContract.authMode,
          terminalState: terminalStateForStatus(status),
          reasonCode: permit.reasonCode,
          outcomeDigest: sha256(permit.reasonCode),
        });
        return result(statusForBrokerReason(permit.reasonCode), {
          reasonCode: permit.reasonCode,
          reservationId,
          authMode: auth.authMode,
          ...this.presentation({
            status: statusForBrokerReason(permit.reasonCode),
            binding,
            proposal,
            executionContract,
            reservationId,
          }),
        });
      }
    }

    if (slotsToUse.length > 0 && !this.deps.secretSink) {
      const reasonCode = 'EXTERNAL_SECRET_SINK_UNAVAILABLE';
      this.store.reverse({
        binding,
        reservationId,
        claimId,
        authMode: executionContract.authMode,
        terminalState: 'denied',
        reasonCode,
        outcomeDigest: sha256(reasonCode),
      });
      return result('denied', {
        reasonCode,
        reservationId,
        authMode: auth.authMode,
        ...this.presentation({ status: 'denied', binding, proposal, executionContract, reservationId }),
      });
    }
    const dispatched = await this.invokeWithVerifiedPayload(
      {
        binding,
        proposal,
        adapter,
        authorityGrantId: input.authority.authorityGrantId,
        riskClass: input.riskClass,
        reservationId,
        claimId,
        executionContract,
        effectful: true,
      },
      async (adapterPayload) => {
        const secretUseRefs: Array<{ slot: EveSecretFieldSlot; deliveryRef: string }> = [];
        for (const slotBinding of slotsToUse) {
          // Slot permits and globally one-use OTP consumption are order-sensitive
          // durable CAS operations; parallel resolution would violate that contract.
          // eslint-disable-next-line no-await-in-loop
          const brokerResult = await this.broker.use(
            { binding, reservationId, claimId, slot: slotBinding.slot, executionContract },
            this.deps.secretResolver,
            {
              preflight: () =>
                this.recheckTrustedExecution(
                  binding,
                  proposal,
                  adapter,
                  input.authority.authorityGrantId,
                  input.riskClass,
                  {
                    version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
                    conversationId: executionContract.conversationId,
                    conversationSessionId: executionContract.conversationSessionId,
                  }
                ),
              inject: async (material) => {
                const sinkResult = await this.deps.secretSink!.inject({
                  binding,
                  conversationId: executionContract.conversationId,
                  conversationSessionId: executionContract.conversationSessionId,
                  reservationId,
                  claimId,
                  adapterId: adapter.id,
                  authMode: auth.authMode,
                  domain: executionContract.domain,
                  action: executionContract.domainAction,
                  origins:
                    executionContract.domain === 'commerce'
                      ? [executionContract.merchantOrigin!, executionContract.checkoutOrigin!]
                      : [executionContract.providerOrigin!],
                  exactOrigin: executionContract.targetOrigin,
                  slot: slotBinding.slot,
                  executionContractDigest: executionContract.executionContractDigest,
                  ...(auth.browserPartition ? { browserPartition: auth.browserPartition } : {}),
                  material,
                });
                if (
                  !hasExactKeys(sinkResult, ['status', 'deliveryRef']) ||
                  sinkResult.status !== 'applied' ||
                  !isEveOpaqueId(sinkResult.deliveryRef)
                ) {
                  throw new Error('EXTERNAL_SECRET_SINK_UNKNOWN');
                }
                secretUseRefs.push({ slot: slotBinding.slot, deliveryRef: sinkResult.deliveryRef });
              },
            }
          );
          if ('reasonCode' in brokerResult) return { kind: 'broker' as const, brokerResult };
        }
        return {
          kind: 'adapter' as const,
          adapterOutcome: await adapter.execute({
            binding,
            proposal,
            authMode: auth.authMode,
            ...(secretUseRefs.length > 0 ? { secretUseRefs: Object.freeze([...secretUseRefs]) } : {}),
            ...(auth.browserPartition ? { browserPartition: auth.browserPartition } : {}),
            ...(adapterPayload ? { adapterPayload } : {}),
          }),
        };
      }
    );
    if ('reasonCode' in dispatched) {
      if (dispatched.beforeEffect) {
        const status = statusForBrokerReason(dispatched.reasonCode);
        this.store.reverse({
          binding,
          reservationId,
          claimId,
          authMode: executionContract.authMode,
          terminalState: terminalStateForStatus(status),
          reasonCode: dispatched.reasonCode,
          outcomeDigest: sha256(dispatched.reasonCode),
        });
        return result(status, {
          reasonCode: dispatched.reasonCode,
          reservationId,
          authMode: auth.authMode,
          ...this.presentation({ status, binding, proposal, executionContract, reservationId }),
        });
      }
      outcome = { status: 'unknown_outcome', reasonCode: unknownOutcomeReason(dispatched.reasonCode) };
    } else if (dispatched.value.kind === 'broker') {
      const brokerResult = dispatched.value.brokerResult;
      const status =
        brokerResult.status === 'unknown' ? 'unknown_outcome' : statusForBrokerReason(brokerResult.reasonCode);
      return result(status, {
        reasonCode: brokerResult.reasonCode,
        reservationId,
        authMode: auth.authMode,
        ...(status === 'unknown_outcome' ? { retryAllowed: false } : {}),
        ...this.presentation({ status, binding, proposal, executionContract, reservationId }),
      });
    } else {
      outcome = adapterOutcome(dispatched.value.adapterOutcome, executionContract);
    }
    return this.persistAdapterOutcome(
      input,
      outcome ?? { status: 'unknown_outcome', reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' },
      auth.authMode,
      true
    );
  }

  private async invokeWithVerifiedPayload<T>(
    input: {
      binding: EveExternalActionBinding;
      proposal: EveExternalActionProposal;
      adapter: ExternalActionAdapter;
      authorityGrantId: string;
      riskClass: EveExternalActionRiskClass;
      reservationId: string;
      claimId: string;
      executionContract: ExternalActionExecutionContractExpectation;
      effectful: boolean;
    },
    use: (payload: Uint8Array | undefined) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; reasonCode: string; beforeEffect: boolean }> {
    const payloadRef = input.proposal.action.adapterPayloadRef;
    const payloadDigest = input.proposal.action.adapterPayloadDigest;
    let payload: Uint8Array | undefined;
    try {
      if (payloadRef || payloadDigest) {
        if (!payloadRef || !payloadDigest) {
          return { ok: false, reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_UNAVAILABLE', beforeEffect: true };
        }
        const origins =
          input.executionContract.domain === 'commerce'
            ? [input.executionContract.merchantOrigin!, input.executionContract.checkoutOrigin!]
            : [input.executionContract.providerOrigin!];
        const read = await this.readValidatedAdapterPayload({
          adapter: input.adapter,
          payloadRef,
          payloadDigest,
          argumentsDigest: input.proposal.action.argumentsDigest,
          ...(input.proposal.action.quoteDigest ? { quoteDigest: input.proposal.action.quoteDigest } : {}),
          amount: input.proposal.action.amount,
          binding: input.binding,
          conversationId: input.executionContract.conversationId,
          conversationSessionId: input.executionContract.conversationSessionId,
          adapterId: input.adapter.id,
          actionKind: input.proposal.action.kind,
          targetOrigin: input.proposal.action.targetOrigin,
          domain: input.executionContract.domain,
          action: input.executionContract.domainAction,
          counterpartyId: input.executionContract.counterpartyId,
          origins,
        });
        if ('reasonCode' in read) return { ok: false, reasonCode: read.reasonCode, beforeEffect: true };
        payload = read.payload;
        if (
          read.validation.commerce?.productCount !== input.executionContract.adapterPayloadProductCount ||
          read.validation.commerce?.cartDigest !== input.executionContract.cartDigest
        ) {
          return { ok: false, reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_CONTRACT_STALE', beforeEffect: true };
        }
      }
      const trusted = await this.recheckTrustedExecution(
        input.binding,
        input.proposal,
        input.adapter,
        input.authorityGrantId,
        input.riskClass,
        {
          version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
          conversationId: input.executionContract.conversationId,
          conversationSessionId: input.executionContract.conversationSessionId,
        }
      );
      const claim = this.store.recheckClaimForExecution(
        input.binding,
        input.reservationId,
        input.claimId,
        input.executionContract
      );
      if ('reasonCode' in trusted || 'reasonCode' in claim) {
        return {
          ok: false,
          reasonCode:
            'reasonCode' in trusted
              ? trusted.reasonCode
              : 'reasonCode' in claim
                ? claim.reasonCode
                : 'EXTERNAL_EXECUTION_RECHECK_FAILED',
          beforeEffect: true,
        };
      }
      try {
        return { ok: true, value: await use(payload) };
      } catch {
        return {
          ok: false,
          reasonCode: input.effectful ? 'EXTERNAL_ADAPTER_THROW_UNKNOWN' : 'EXTERNAL_ADAPTER_PROBE_INVALID',
          beforeEffect: !input.effectful,
        };
      }
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_READ_FAILED', beforeEffect: true };
    } finally {
      payload?.fill(0);
    }
  }

  private presentation(input: {
    status: EveExternalActionExecutionResult['status'];
    binding: EveExternalActionBinding;
    proposal: EveExternalActionProposal;
    executionContract: ExternalActionExecutionContractIdentity;
    reservationId: string;
    eventReceipt?: EveExternalActionEventReceiptV0;
  }): Pick<EveExternalActionExecutionResult, 'receipt' | 'workbenchCard'> {
    const receipt = this.store.getReceipt(input.binding, input.reservationId) ?? undefined;
    const stableConversation = this.recheckConversation({
      version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
      conversationId: input.executionContract.conversationId,
      conversationSessionId: input.executionContract.conversationSessionId,
    });
    const card =
      'reasonCode' in stableConversation
        ? null
        : workbenchCard({
            ...input,
            conversationId: input.executionContract.conversationId,
            ...(receipt ? { receipt } : {}),
          });
    return {
      ...(receipt ? { receipt } : {}),
      ...(card ? { workbenchCard: card } : {}),
    };
  }

  private workbenchProjectionFromReceipt(
    receipt: EveExternalActionReceiptV0,
    conversationContext: ExternalActionConversationContext,
    providerOrMerchantLabelCode: EveExternalActionProviderMerchantLabelCode,
    productCount?: number
  ): Pick<EveExternalActionExecutionResult, 'workbenchCard'> {
    const stableConversation = this.recheckConversation(conversationContext);
    if ('reasonCode' in stableConversation) return {};
    const card = workbenchCardFromReceipt(
      receipt,
      conversationContext.conversationId,
      providerOrMerchantLabelCode,
      productCount
    );
    return card ? { workbenchCard: card } : {};
  }

  private resultFromPersistedState(
    input: {
      binding: EveExternalActionBinding;
      proposal: EveExternalActionProposal;
      executionContract: ExternalActionExecutionContractIdentity;
      reservationId: string;
    },
    state: EveExternalActionLedgerState | undefined,
    authMode: ExternalActionAuthMode,
    fallbackReasonCode: string
  ): EveExternalActionExecutionResult {
    const status = executionStatusForLedgerState(state);
    if (status === 'needs_user') {
      const challenge = this.store.getPendingChallenge(input.binding, input.reservationId);
      if (challenge) {
        return result('needs_user', {
          reasonCode: challenge.snapshot.challenge.userInstructionCode,
          reservationId: input.reservationId,
          authMode: challenge.snapshot.authMode,
          eventReceipt: challenge.eventReceipt,
          ...this.presentation({
            ...input,
            status: 'needs_user',
            eventReceipt: challenge.eventReceipt,
          }),
        });
      }
    }
    const receipt = this.store.getReceipt(input.binding, input.reservationId);
    if (!status || !receipt) {
      return result('unknown_outcome', {
        reasonCode: fallbackReasonCode,
        reservationId: input.reservationId,
        authMode,
        retryAllowed: false,
      });
    }
    return result(status, {
      ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
      reservationId: input.reservationId,
      authMode: receipt.authMode,
      ...(status === 'unknown_outcome' ? { retryAllowed: false as const } : {}),
      receipt,
      ...this.workbenchProjectionFromReceipt(
        receipt,
        {
          version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
          conversationId: input.executionContract.conversationId,
          conversationSessionId: input.executionContract.conversationSessionId,
        },
        input.executionContract.providerOrMerchantLabelCode,
        input.executionContract.adapterPayloadProductCount
      ),
    });
  }

  private authChallenge(
    input: {
      binding: EveExternalActionBinding;
      policy: EveExternalActionPolicy;
      reservationId: string;
      proposal: EveExternalActionProposal;
    },
    authMode: ExternalActionAuthMode,
    reasonCode: string,
    kind: EveExternalActionChallenge['kind'] = 'provider_risk_review'
  ): EveExternalActionChallenge | null {
    const reservation = this.store.getReservation(input.binding, input.reservationId);
    if (!reservation) return null;
    const expiresAt = new Date(
      Math.min(
        Date.parse(input.policy.expiresAt),
        Date.parse(reservation.expiresAt),
        this.now().getTime() + 5 * 60 * 1000
      )
    ).toISOString();
    if (Date.parse(expiresAt) <= this.now().getTime()) return null;
    return {
      kind,
      challengeRef: `challenge:${sha256(canonical({ reservationId: input.reservationId, authMode, reasonCode })).slice(7, 55)}`,
      origin: input.proposal.action.targetOrigin,
      expiresAt,
      userInstructionCode: instructionForChallengeKind(kind),
    };
  }

  private suspendChallenge(
    input: {
      binding: EveExternalActionBinding;
      adapter: ExternalActionAdapter;
      proposal: EveExternalActionProposal;
      reservationId: string;
      claimId: string;
      executionContract: ExternalActionExecutionContractExpectation;
    },
    challenge: EveExternalActionChallenge,
    authMode: ExternalActionAuthMode,
    continuation: ExternalActionContinuationKind,
    continuationRef: string,
    postAdapterCall: boolean
  ): EveExternalActionExecutionResult {
    const resumeRef = `resume-ref:${this.randomUUID()}`;
    const suspended = this.store.suspendForUser({
      binding: input.binding,
      reservationId: input.reservationId,
      claimId: input.claimId,
      executionContract: input.executionContract,
      challenge,
      proposal: input.proposal,
      adapterId: input.adapter.id,
      authMode,
      continuation,
      continuationRef,
      resumeRef,
    });
    if ('reasonCode' in suspended) {
      if (postAdapterCall) {
        this.store.markUnknown({
          binding: input.binding,
          reservationId: input.reservationId,
          claimId: input.claimId,
          authMode,
          reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
          outcomeDigest: sha256(suspended.reasonCode),
        });
        return result('unknown_outcome', {
          reasonCode: 'EXTERNAL_CHALLENGE_PERSIST_UNKNOWN',
          reservationId: input.reservationId,
          authMode,
          retryAllowed: false,
          ...this.presentation({
            status: 'unknown_outcome',
            binding: input.binding,
            proposal: input.proposal,
            executionContract: input.executionContract,
            reservationId: input.reservationId,
          }),
        });
      }
      this.store.reverse({
        binding: input.binding,
        reservationId: input.reservationId,
        claimId: input.claimId,
        authMode,
        terminalState: 'denied',
        reasonCode: suspended.reasonCode,
        outcomeDigest: sha256(suspended.reasonCode),
      });
      return result('denied', {
        reasonCode: suspended.reasonCode,
        reservationId: input.reservationId,
        authMode,
        ...this.presentation({
          status: 'denied',
          binding: input.binding,
          proposal: input.proposal,
          executionContract: input.executionContract,
          reservationId: input.reservationId,
        }),
      });
    }
    this.resumeTokens.set(resumeRef, suspended.record.resumeToken);
    return result('needs_user', {
      reasonCode: challenge.userInstructionCode,
      reservationId: input.reservationId,
      authMode,
      eventReceipt: suspended.record.eventReceipt,
      ...this.presentation({
        status: 'needs_user',
        binding: input.binding,
        proposal: input.proposal,
        executionContract: input.executionContract,
        reservationId: input.reservationId,
        eventReceipt: suspended.record.eventReceipt,
      }),
    });
  }

  private async persistAdapterOutcome(
    input: {
      binding: EveExternalActionBinding;
      adapter: ExternalActionAdapter;
      proposal: EveExternalActionProposal;
      reservationId: string;
      claimId: string;
      executionContract: ExternalActionExecutionContractExpectation;
      authority: ExternalActionAuthorityResolution;
      riskClass: EveExternalActionRiskClass;
    },
    terminal: ExternalActionAdapterOutcome,
    authMode: ExternalActionAuthMode,
    postAdapterCall: boolean
  ): Promise<EveExternalActionExecutionResult> {
    const postCallTrusted = await this.recheckTrustedExecution(
      input.binding,
      input.proposal,
      input.adapter,
      input.authority.authorityGrantId,
      input.riskClass,
      {
        version: EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION,
        conversationId: input.executionContract.conversationId,
        conversationSessionId: input.executionContract.conversationSessionId,
      }
    );
    const postCallClaim = this.store.recheckClaimForExecution(
      input.binding,
      input.reservationId,
      input.claimId,
      input.executionContract
    );
    if ('reasonCode' in postCallTrusted || 'reasonCode' in postCallClaim) {
      let reasonCode = 'EXTERNAL_POST_CALL_RECHECK_FAILED';
      if ('reasonCode' in postCallTrusted) reasonCode = postCallTrusted.reasonCode;
      else if ('reasonCode' in postCallClaim) reasonCode = postCallClaim.reasonCode;
      const persisted = this.store.markUnknown({
        binding: input.binding,
        reservationId: input.reservationId,
        claimId: input.claimId,
        authMode,
        reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
        outcomeDigest: sha256(reasonCode),
      });
      return this.resultFromPersistedState(input, persisted.state, authMode, 'UNKNOWN_EXTERNAL_EFFECT');
    }
    if (terminal.status === 'needs_user') {
      if (!input.adapter.resume) {
        const persisted = this.store.markUnknown({
          binding: input.binding,
          reservationId: input.reservationId,
          claimId: input.claimId,
          authMode,
          reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
          outcomeDigest: sha256('EXTERNAL_ADAPTER_RESUME_UNAVAILABLE'),
        });
        return this.resultFromPersistedState(input, persisted.state, authMode, 'EXTERNAL_ADAPTER_RESUME_UNAVAILABLE');
      }
      return this.suspendChallenge(
        input,
        terminal.challenge,
        authMode,
        'adapter_resume',
        terminal.continuationRef,
        postAdapterCall
      );
    }
    const outcomeDigest = sha256(canonical(terminal));
    if (terminal.status === 'allowed') {
      const persisted = this.store.markAllowed({
        binding: input.binding,
        reservationId: input.reservationId,
        claimId: input.claimId,
        authMode,
        ...(terminal.result ? { result: terminal.result } : {}),
        outcomeDigest,
      });
      return this.resultFromPersistedState(input, persisted.state, authMode, 'EXTERNAL_TERMINAL_STATE_CONFLICT');
    }
    if (terminal.status === 'unknown_outcome') {
      const persisted = this.store.markUnknown({
        binding: input.binding,
        reservationId: input.reservationId,
        claimId: input.claimId,
        authMode,
        reasonCode: terminal.reasonCode.includes('SANITIZATION') ? 'SANITIZATION_FAILED' : 'UNKNOWN_EXTERNAL_EFFECT',
        outcomeDigest,
      });
      return this.resultFromPersistedState(input, persisted.state, authMode, terminal.reasonCode);
    }
    const persisted = this.store.reverse({
      binding: input.binding,
      reservationId: input.reservationId,
      claimId: input.claimId,
      authMode,
      terminalState: 'denied',
      reasonCode: terminal.reasonCode,
      outcomeDigest,
    });
    return this.resultFromPersistedState(input, persisted.state, authMode, terminal.reasonCode);
  }

  private async selectAuth(
    adapter: ExternalActionAdapter,
    binding: EveExternalActionBinding,
    proposal: EveExternalActionProposal,
    slotManifest: readonly EveExternalActionSlotBinding[]
  ): Promise<SelectedAuthResult> {
    const base = { binding, proposal };
    const oauthHandleId =
      slotManifest.find((entry) => entry.slot === 'oauth_token')?.handleId ?? proposal.oauthHandleId;
    const passwordHandleId =
      slotManifest.find((entry) => entry.slot === 'account_password')?.handleId ?? proposal.passwordHandleId;
    if (adapter.supports.oauth) {
      const probe = adapter.probeOAuth ? await adapter.probeOAuth(base) : 'ready';
      if (!isAuthProbe(probe)) {
        return { status: 'denied', reasonCode: 'EXTERNAL_AUTH_PROBE_INVALID', authMode: 'oauth' };
      }
      if (probe !== 'unavailable') {
        if (probe === 'needs_user') {
          return {
            status: 'needs_user',
            reasonCode: 'EXTERNAL_OAUTH_REQUIRED',
            authMode: 'oauth',
            resumable: Boolean(oauthHandleId),
            challengeKind: 'oauth_consent',
          };
        }
        if (!oauthHandleId) {
          return {
            status: 'needs_user',
            reasonCode: 'EXTERNAL_OAUTH_REQUIRED',
            authMode: 'oauth',
            resumable: false,
          };
        }
        return { status: 'ready', authMode: 'oauth', handleId: oauthHandleId };
      }
    }

    const partition = externalActionBrowserPartition(binding, proposal.action.targetOrigin);
    if (adapter.supports.browserSession && partition) {
      const probe = adapter.probeBrowserSession
        ? await adapter.probeBrowserSession({ ...base, browserPartition: partition })
        : 'needs_user';
      if (!isAuthProbe(probe)) {
        return { status: 'denied', reasonCode: 'EXTERNAL_AUTH_PROBE_INVALID', authMode: 'session' };
      }
      if (probe === 'ready') return { status: 'ready', authMode: 'session', browserPartition: partition };
      if (probe === 'needs_user') {
        return {
          status: 'needs_user',
          reasonCode: 'EXTERNAL_BROWSER_SESSION_NEEDS_USER',
          authMode: 'session',
          resumable: true,
          challengeKind: 'provider_risk_review',
          browserPartition: partition,
        };
      }
    }

    if (adapter.supports.otp && slotManifest.some((entry) => entry.slot === 'otp_code')) {
      return { status: 'ready', authMode: 'otp' };
    }
    if (
      adapter.supports.paymentFields &&
      slotManifest.some((entry) => ['payment_pan', 'payment_expiry', 'payment_cvc'].includes(entry.slot))
    ) {
      return { status: 'ready', authMode: 'payment_fields' };
    }

    // Password material is the final fallback and only becomes reachable after
    // OAuth explicitly reported unavailable and the isolated browser session
    // was unavailable. An expired/revoked OAuth token never silently falls back.
    if (adapter.supports.password) {
      if (!passwordHandleId) {
        return {
          status: 'needs_user',
          reasonCode: 'EXTERNAL_PASSWORD_HANDLE_REQUIRED',
          authMode: 'password',
          resumable: false,
        };
      }
      return { status: 'ready', authMode: 'password', handleId: passwordHandleId };
    }
    if (adapter.supports.unauthenticated) return { status: 'ready', authMode: 'none' };
    return { status: 'denied', reasonCode: 'EXTERNAL_AUTH_METHOD_UNAVAILABLE' };
  }

  private resolveConversationContext(): { context: ExternalActionConversationContext } | { reasonCode: string } {
    let resolution: ExternalActionConversationContextResolution;
    try {
      resolution = this.deps.resolveConversationContext();
    } catch {
      return { reasonCode: 'EXTERNAL_CONVERSATION_CONTEXT_UNAVAILABLE' };
    }
    if ('reasonCode' in resolution) {
      return { reasonCode: safeReason(resolution.reasonCode, 'EXTERNAL_CONVERSATION_CONTEXT_UNAVAILABLE') };
    }
    const context = resolution.context;
    if (
      !hasExactKeys(context, ['version', 'conversationId', 'conversationSessionId']) ||
      context.version !== EXTERNAL_ACTION_CONVERSATION_CONTEXT_VERSION ||
      !isEveOpaqueId(context.conversationId) ||
      !isEveOpaqueId(context.conversationSessionId)
    ) {
      return { reasonCode: 'EXTERNAL_CONVERSATION_CONTEXT_INVALID' };
    }
    return { context };
  }

  private recheckConversation(
    expected: ExternalActionConversationContext
  ): { ok: true } | { ok: false; reasonCode: string } {
    const current = this.resolveConversationContext();
    if ('reasonCode' in current) return { ok: false, reasonCode: current.reasonCode };
    return sameConversation(expected, current.context)
      ? { ok: true }
      : { ok: false, reasonCode: 'EXTERNAL_CONVERSATION_CONTEXT_CHANGED' };
  }

  private recheckBinding(expected: EveExternalActionBinding): { ok: true } | { ok: false; reasonCode: string } {
    let current: ExternalActionBindingResolution;
    try {
      current = this.deps.resolveBinding();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_BINDING_UNAVAILABLE' };
    }
    if ('reasonCode' in current) {
      return { ok: false, reasonCode: safeReason(current.reasonCode, 'EXTERNAL_BINDING_UNAVAILABLE') };
    }
    if (!sameBinding(expected, current.binding)) {
      return { ok: false, reasonCode: 'EXTERNAL_BINDING_CHANGED' };
    }
    return { ok: true };
  }

  private async recheckTrustedExecution(
    binding: EveExternalActionBinding,
    proposal: EveExternalActionProposal,
    adapter: ExternalActionAdapter,
    expectedAuthorityGrantId: string,
    expectedRiskClass: EveExternalActionRiskClass,
    expectedConversation: ExternalActionConversationContext
  ): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
    const stableBinding = this.recheckBinding(binding);
    if (!stableBinding.ok) return stableBinding;
    const stableConversation = this.recheckConversation(expectedConversation);
    if (!stableConversation.ok) return stableConversation;
    const riskClass = classifyTrustedRisk(adapter, binding, proposal);
    if (!riskClass || riskClass !== expectedRiskClass) {
      return { ok: false, reasonCode: 'EXTERNAL_RISK_CLASSIFICATION_CHANGED' };
    }
    if (riskClass !== 'ordinary') {
      return { ok: false, reasonCode: 'EXTERNAL_ACTION_HUMAN_GATE_REQUIRED' };
    }
    let authority: ExternalActionAuthorityResolution;
    try {
      const budgetWithCurrentReservation = this.store.getBudgetUsedToday(binding, proposal.action.amount.currency);
      authority = await this.deps.resolveAuthority({
        binding,
        proposal,
        spentTodayMinor: Math.max(0, budgetWithCurrentReservation - proposal.action.amount.minorUnits),
        riskClass,
      });
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_AUTHORITY_UNAVAILABLE' };
    }
    const stableAfterAuthority = this.recheckBinding(binding);
    if (!stableAfterAuthority.ok) return stableAfterAuthority;
    const stableConversationAfterAuthority = this.recheckConversation(expectedConversation);
    if (!stableConversationAfterAuthority.ok) return stableConversationAfterAuthority;
    if (!isEveOpaqueId(authority.authorityGrantId)) {
      return { ok: false, reasonCode: 'EXTERNAL_AUTHORITY_INVALID' };
    }
    if (authority.authorityGrantId !== expectedAuthorityGrantId) {
      return { ok: false, reasonCode: 'EXTERNAL_AUTHORITY_CHANGED' };
    }
    if (authority.decision === 'ask') {
      return { ok: false, reasonCode: 'EXTERNAL_AUTHORITY_CONFIRMATION_REQUIRED' };
    }
    if (authority.decision !== 'allow') {
      return { ok: false, reasonCode: 'EXTERNAL_AUTHORITY_BLOCKED' };
    }
    if (authority.riskClass !== riskClass) {
      return { ok: false, reasonCode: 'EXTERNAL_RISK_CLASSIFICATION_CHANGED' };
    }
    return { ok: true };
  }
}
