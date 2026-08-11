/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import {
  EVE_EXTERNAL_ACTION_EXECUTION_VERSION,
  validateEveExternalActionProposal,
  type EveExternalActionExecutionResult,
  type EveExternalActionProposal,
} from '@/common/config/eveExternalActionExecutionCore';
import {
  isEveOpaqueId,
  type EveExternalActionBinding,
  type EveExternalActionKind,
  type EveExternalActionRiskClass,
  type EveExternalAuthorityDecision,
} from '@/common/config/eveExternalActionPolicyCore';
import { externalActionBrowserPartition } from './browserProfileScope';
import type { ExternalActionBindingResolution } from './bindingResolver';
import type { ExternalActionStore } from './externalActionStore';
import { ExternalSecretUseBroker, type SecretMaterialResolver } from './secretUseBroker';

export type ExternalActionAuthMode = 'oauth' | 'browser_session' | 'password' | 'none';
export type ExternalActionAuthProbe = 'ready' | 'needs_user' | 'unavailable';

export interface ExternalActionAuthorityResolution {
  decision: EveExternalAuthorityDecision;
  authorityGrantId: string;
  riskClass: EveExternalActionRiskClass;
}

export interface ExternalActionAdapterContext {
  binding: EveExternalActionBinding;
  proposal: EveExternalActionProposal;
  authMode: ExternalActionAuthMode;
  /** Present only inside Main for the duration of this call. */
  credential?: Uint8Array;
  /** Main-owned persistent Electron partition. Cookies never leave it. */
  browserPartition?: string;
}

export interface ExternalActionAdapterOutcome {
  status: 'allowed' | 'needs_user' | 'denied' | 'unknown_outcome';
  reasonCode?: string;
}

export interface ExternalActionAdapter {
  readonly id: string;
  readonly actionKinds: readonly EveExternalActionKind[];
  readonly targetOrigins: readonly string[];
  readonly supports: Readonly<{
    oauth: boolean;
    browserSession: boolean;
    password: boolean;
    unauthenticated: boolean;
  }>;
  probeOAuth?(context: Omit<ExternalActionAdapterContext, 'authMode' | 'credential'>): Promise<ExternalActionAuthProbe>;
  probeBrowserSession?(
    context: Omit<ExternalActionAdapterContext, 'authMode' | 'credential'> & { browserPartition: string }
  ): Promise<ExternalActionAuthProbe>;
  execute(context: ExternalActionAdapterContext): Promise<ExternalActionAdapterOutcome>;
}

export interface ExternalActionExecutionDeps {
  resolveBinding(): ExternalActionBindingResolution;
  resolveAuthority(input: {
    binding: EveExternalActionBinding;
    proposal: EveExternalActionProposal;
    spentTodayMinor: number;
  }): Promise<ExternalActionAuthorityResolution>;
  secretResolver: SecretMaterialResolver;
  adapters?: readonly ExternalActionAdapter[];
  now?: () => Date;
  randomUUID?: () => string;
}

const RESULT_REASON_RE = /^[A-Z][A-Z0-9_]{0,95}$/;
const CLAIM_TTL_MS = 10 * 60 * 1000;

function sha256(value: string): string {
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
  return 'needs_user';
}

function isAuthProbe(value: unknown): value is ExternalActionAuthProbe {
  return value === 'ready' || value === 'needs_user' || value === 'unavailable';
}

function sameBinding(left: EveExternalActionBinding, right: EveExternalActionBinding): boolean {
  return (
    left.installationId === right.installationId && left.accountId === right.accountId && left.seedId === right.seedId
  );
}

function adapterOutcome(value: unknown): ExternalActionAdapterOutcome {
  if (!value || typeof value !== 'object')
    return { status: 'unknown_outcome', reasonCode: 'EXTERNAL_ADAPTER_RESULT_INVALID' };
  const candidate = value as Partial<ExternalActionAdapterOutcome>;
  if (!['allowed', 'needs_user', 'denied', 'unknown_outcome'].includes(String(candidate.status))) {
    return { status: 'unknown_outcome', reasonCode: 'EXTERNAL_ADAPTER_RESULT_INVALID' };
  }
  return {
    status: candidate.status as ExternalActionAdapterOutcome['status'],
    ...(candidate.reasonCode
      ? { reasonCode: safeReason(candidate.reasonCode, 'EXTERNAL_ADAPTER_REASON_REDACTED') }
      : {}),
  };
}

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

  constructor(
    private readonly store: ExternalActionStore,
    private readonly deps: ExternalActionExecutionDeps
  ) {
    this.now = deps.now ?? (() => new Date());
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    this.adapters = deps.adapters ?? [];
    this.broker = new ExternalSecretUseBroker(store, this.now);
  }

  async execute(untrusted: unknown): Promise<EveExternalActionExecutionResult> {
    const parsed = validateEveExternalActionProposal(untrusted);
    if ('reasonCode' in parsed) return result('denied', { reasonCode: parsed.reasonCode });
    const proposal = parsed.value;
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
    const policy = this.store.getPolicy(binding);
    if (!policy) return result('denied', { reasonCode: 'EXTERNAL_POLICY_NOT_CONFIGURED' });
    if (policy.revokedAt) return result('revoked', { reasonCode: 'EXTERNAL_POLICY_REVOKED' });
    if (policy.killSwitch) return result('revoked', { reasonCode: 'EXTERNAL_POLICY_KILLED' });
    if (Date.parse(policy.expiresAt) <= this.now().getTime()) {
      return result('expired', { reasonCode: 'EXTERNAL_POLICY_EXPIRED' });
    }

    let authority: ExternalActionAuthorityResolution;
    try {
      authority = await this.deps.resolveAuthority({
        binding,
        proposal,
        spentTodayMinor: this.store.getBudgetUsedToday(binding, proposal.action.amount.currency),
      });
    } catch {
      return result('denied', { reasonCode: 'EXTERNAL_AUTHORITY_UNAVAILABLE' });
    }
    if (!isEveOpaqueId(authority.authorityGrantId)) {
      return result('denied', { reasonCode: 'EXTERNAL_AUTHORITY_INVALID' });
    }
    if (authority.decision === 'ask') {
      return result('needs_user', { reasonCode: 'EXTERNAL_AUTHORITY_CONFIRMATION_REQUIRED' });
    }
    if (authority.decision !== 'allow') {
      return result('denied', { reasonCode: 'EXTERNAL_AUTHORITY_BLOCKED' });
    }
    if (authority.riskClass !== 'ordinary') {
      return result('needs_user', { reasonCode: 'EXTERNAL_ACTION_HUMAN_GATE_REQUIRED' });
    }
    const stableBinding = this.recheckBinding(binding);
    if ('reasonCode' in stableBinding) return result('denied', { reasonCode: stableBinding.reasonCode });

    const adapter = this.adapters.find(
      (candidate) =>
        isEveOpaqueId(candidate.id) &&
        candidate.actionKinds.includes(proposal.action.kind) &&
        candidate.targetOrigins.includes(proposal.action.targetOrigin)
    );
    if (!adapter) return result('denied', { reasonCode: 'EXTERNAL_ADAPTER_UNAVAILABLE' });

    // Stable across retries, credentials, seat-policy edits and adapter changes.
    // A repeated purchase therefore needs a genuinely new quote/arguments
    // contract; fresh request ids, handles, grants or tools cannot evade replay.
    const semanticContract = {
      binding,
      action: proposal.action,
    };
    const operationDigest = sha256(canonical(semanticContract));
    const executionContractDigest = sha256(
      canonical({
        operationDigest,
        policyRevision: policy.revision,
        sessionEpoch: policy.sessionEpoch,
        authorityGrantId: authority.authorityGrantId,
        riskClass: authority.riskClass,
        adapterId: adapter.id,
        actionKind: proposal.action.kind,
        targetOrigin: proposal.action.targetOrigin,
        argumentsDigest: proposal.action.argumentsDigest,
        quoteDigest: proposal.action.quoteDigest ?? null,
        amount: proposal.action.amount,
        oauthHandleId: proposal.oauthHandleId ?? null,
        passwordHandleId: proposal.passwordHandleId ?? null,
      })
    );
    const intentId = `intent:${operationDigest.slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const requestId = `request:${sha256(proposal.clientRequestId).slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const classificationDigest = sha256(
      canonical({ actionKind: proposal.action.kind, riskClass: authority.riskClass })
    );
    const idempotencyKeyDigest = sha256(proposal.idempotencyKey);
    const expiryMs = Math.min(Date.parse(policy.expiresAt), this.now().getTime() + CLAIM_TTL_MS);
    const reserved = this.store.reserve({
      binding,
      policyRevision: policy.revision,
      sessionEpoch: policy.sessionEpoch,
      authorityDecision: authority.decision,
      authorityGrantId: authority.authorityGrantId,
      classificationDigest,
      riskClass: authority.riskClass,
      actionKind: proposal.action.kind,
      targetOrigin: proposal.action.targetOrigin,
      intentId,
      requestId,
      operationDigest,
      idempotencyKeyDigest,
      executionContractDigest,
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
        return result('allowed', { reservationId: reserved.reservationId, replay: true });
      if (reserved.state === 'unknown' || reserved.state === 'claimed') {
        return result('unknown_outcome', {
          reasonCode: 'EXTERNAL_REPLAY_OUTCOME_UNKNOWN',
          reservationId: reserved.reservationId,
          replay: true,
        });
      }
      return result('denied', {
        reasonCode: 'EXTERNAL_REPLAY_NOT_EXECUTABLE',
        reservationId: reserved.reservationId,
        replay: true,
      });
    }

    const claimId = `claim:${this.randomUUID()}`;
    const claimed = this.store.claim({
      binding,
      reservationId: reserved.reservationId,
      claimId,
      claimDigest: sha256(canonical({ executionContractDigest, claimId })),
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
        }
      );
    }

    let auth: Awaited<ReturnType<ExternalActionExecutionService['selectAuth']>>;
    try {
      auth = await this.selectAuth(adapter, binding, proposal);
    } catch {
      this.store.reverse({
        binding,
        reservationId: reserved.reservationId,
        claimId,
        outcomeDigest: sha256('EXTERNAL_AUTH_PROBE_UNAVAILABLE'),
      });
      return result('needs_user', {
        reasonCode: 'EXTERNAL_AUTH_PROBE_UNAVAILABLE',
        reservationId: reserved.reservationId,
      });
    }
    if (auth.status !== 'ready') {
      this.store.reverse({
        binding,
        reservationId: reserved.reservationId,
        claimId,
        outcomeDigest: sha256(auth.reasonCode),
      });
      return result(auth.status, {
        reasonCode: auth.reasonCode,
        reservationId: reserved.reservationId,
        ...(auth.authMode ? { authMode: auth.authMode } : {}),
      });
    }

    let outcome: ExternalActionAdapterOutcome | undefined;
    if (auth.handleId) {
      const brokerResult = await this.broker.use(
        {
          binding,
          reservationId: reserved.reservationId,
          claimId,
          handleId: auth.handleId,
          expectedHandleType: auth.authMode === 'oauth' ? 'oauth_token' : 'account_credential',
          actionKind: proposal.action.kind,
          targetOrigin: proposal.action.targetOrigin,
        },
        this.deps.secretResolver,
        {
          preflight: () => this.recheckTrustedExecution(binding, proposal, authority.authorityGrantId),
          inject: async (credential) => {
            outcome = adapterOutcome(
              await adapter.execute({
                binding,
                proposal,
                authMode: auth.authMode,
                credential,
                ...(auth.browserPartition ? { browserPartition: auth.browserPartition } : {}),
              })
            );
          },
        }
      );
      if ('reasonCode' in brokerResult) {
        return result(
          brokerResult.status === 'unknown' ? 'unknown_outcome' : statusForBrokerReason(brokerResult.reasonCode),
          {
            reasonCode: brokerResult.reasonCode,
            reservationId: reserved.reservationId,
            authMode: auth.authMode,
          }
        );
      }
    } else {
      const trustedPreflight = await this.recheckTrustedExecution(binding, proposal, authority.authorityGrantId);
      if ('reasonCode' in trustedPreflight) {
        this.store.reverse({
          binding,
          reservationId: reserved.reservationId,
          claimId,
          outcomeDigest: sha256(trustedPreflight.reasonCode),
        });
        return result(statusForBrokerReason(trustedPreflight.reasonCode), {
          reasonCode: trustedPreflight.reasonCode,
          reservationId: reserved.reservationId,
          authMode: auth.authMode,
        });
      }
      const rechecked = this.store.recheckClaimForExecution(
        binding,
        reserved.reservationId,
        claimId,
        proposal.action.kind,
        proposal.action.targetOrigin
      );
      if ('reasonCode' in rechecked) {
        this.store.reverse({
          binding,
          reservationId: reserved.reservationId,
          claimId,
          outcomeDigest: sha256(rechecked.reasonCode),
        });
        return result(statusForReason(rechecked.reasonCode), {
          reasonCode: rechecked.reasonCode,
          reservationId: reserved.reservationId,
          authMode: auth.authMode,
        });
      }
      try {
        outcome = adapterOutcome(
          await adapter.execute({
            binding,
            proposal,
            authMode: auth.authMode,
            ...(auth.browserPartition ? { browserPartition: auth.browserPartition } : {}),
          })
        );
      } catch {
        outcome = { status: 'unknown_outcome', reasonCode: 'EXTERNAL_ADAPTER_THROW_UNKNOWN' };
      }
    }

    const terminal = outcome ?? { status: 'unknown_outcome', reasonCode: 'EXTERNAL_ADAPTER_OUTCOME_MISSING' };
    const outcomeDigest = sha256(canonical({ status: terminal.status, reasonCode: terminal.reasonCode ?? null }));
    if (terminal.status === 'allowed') {
      const persisted = this.store.markAllowed({
        binding,
        reservationId: reserved.reservationId,
        claimId,
        outcomeDigest,
      });
      if (persisted.state === 'allowed') {
        return result('allowed', { reservationId: reserved.reservationId, authMode: auth.authMode });
      }
      return result('unknown_outcome', {
        reasonCode: 'EXTERNAL_TERMINAL_STATE_CONFLICT',
        reservationId: reserved.reservationId,
        authMode: auth.authMode,
      });
    }
    if (terminal.status === 'unknown_outcome') {
      this.store.markUnknown({ binding, reservationId: reserved.reservationId, claimId, outcomeDigest });
      return result('unknown_outcome', {
        reasonCode: terminal.reasonCode ?? 'EXTERNAL_ADAPTER_OUTCOME_UNKNOWN',
        reservationId: reserved.reservationId,
        authMode: auth.authMode,
      });
    }
    this.store.reverse({ binding, reservationId: reserved.reservationId, claimId, outcomeDigest });
    return result(terminal.status, {
      reasonCode:
        terminal.reasonCode ??
        (terminal.status === 'needs_user' ? 'EXTERNAL_ADAPTER_NEEDS_USER' : 'EXTERNAL_ADAPTER_DENIED'),
      reservationId: reserved.reservationId,
      authMode: auth.authMode,
    });
  }

  private async selectAuth(
    adapter: ExternalActionAdapter,
    binding: EveExternalActionBinding,
    proposal: EveExternalActionProposal
  ): Promise<
    | { status: 'ready'; authMode: ExternalActionAuthMode; handleId?: string; browserPartition?: string }
    | { status: 'needs_user' | 'denied'; reasonCode: string; authMode?: ExternalActionAuthMode }
  > {
    const base = { binding, proposal };
    if (adapter.supports.oauth) {
      const probe = adapter.probeOAuth ? await adapter.probeOAuth(base) : 'ready';
      if (!isAuthProbe(probe)) {
        return { status: 'denied', reasonCode: 'EXTERNAL_AUTH_PROBE_INVALID', authMode: 'oauth' };
      }
      if (probe !== 'unavailable') {
        if (probe === 'needs_user' || !proposal.oauthHandleId) {
          return { status: 'needs_user', reasonCode: 'EXTERNAL_OAUTH_REQUIRED', authMode: 'oauth' };
        }
        return { status: 'ready', authMode: 'oauth', handleId: proposal.oauthHandleId };
      }
    }

    const partition = externalActionBrowserPartition(binding, proposal.action.targetOrigin);
    if (adapter.supports.browserSession && partition) {
      const probe = adapter.probeBrowserSession
        ? await adapter.probeBrowserSession({ ...base, browserPartition: partition })
        : 'needs_user';
      if (!isAuthProbe(probe)) {
        return { status: 'denied', reasonCode: 'EXTERNAL_AUTH_PROBE_INVALID', authMode: 'browser_session' };
      }
      if (probe === 'ready') return { status: 'ready', authMode: 'browser_session', browserPartition: partition };
      if (probe === 'needs_user') {
        return { status: 'needs_user', reasonCode: 'EXTERNAL_BROWSER_SESSION_NEEDS_USER', authMode: 'browser_session' };
      }
    }

    // Password material is the final fallback and only becomes reachable after
    // OAuth explicitly reported unavailable and the isolated browser session
    // was unavailable. An expired/revoked OAuth token never silently falls back.
    if (adapter.supports.password) {
      if (!proposal.passwordHandleId) {
        return { status: 'needs_user', reasonCode: 'EXTERNAL_PASSWORD_HANDLE_REQUIRED', authMode: 'password' };
      }
      return { status: 'ready', authMode: 'password', handleId: proposal.passwordHandleId };
    }
    if (adapter.supports.unauthenticated) return { status: 'ready', authMode: 'none' };
    return { status: 'denied', reasonCode: 'EXTERNAL_AUTH_METHOD_UNAVAILABLE' };
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
    expectedAuthorityGrantId: string
  ): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
    const stableBinding = this.recheckBinding(binding);
    if (!stableBinding.ok) return stableBinding;
    let authority: ExternalActionAuthorityResolution;
    try {
      const budgetWithCurrentReservation = this.store.getBudgetUsedToday(binding, proposal.action.amount.currency);
      authority = await this.deps.resolveAuthority({
        binding,
        proposal,
        spentTodayMinor: Math.max(0, budgetWithCurrentReservation - proposal.action.amount.minorUnits),
      });
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_AUTHORITY_UNAVAILABLE' };
    }
    const stableAfterAuthority = this.recheckBinding(binding);
    if (!stableAfterAuthority.ok) return stableAfterAuthority;
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
    if (authority.riskClass !== 'ordinary') {
      return { ok: false, reasonCode: 'EXTERNAL_ACTION_HUMAN_GATE_REQUIRED' };
    }
    return { ok: true };
  }
}
