/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import {
  EVE_EXTERNAL_ACTION_POLICY_VERSION,
  isEveExternalActionKind,
  isEveOpaqueId,
  isEveSha256Digest,
  normalizeEveExternalDomain,
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
} from '@/common/config/eveExternalActionPolicyCore';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';

const SCHEMA_VERSION = 'command-eve-external-action-ledger/v0';
const ACTIVE_BUDGET_STATES: readonly EveExternalActionLedgerState[] = ['reserved', 'claimed', 'allowed', 'unknown'];
const SOURCE_REF_PREFIXES = ['keychain:v1:', 'secret-source:v1:'] as const;
const MONEY_ACTIONS = new Set<EveExternalActionKind>(['purchase', 'recurring_payment']);
const DOMAIN_ACTIONS = new Set<EveExternalActionKind>([
  'account_create',
  'software_install',
  'purchase',
  'recurring_payment',
  'browser_submit',
]);

export interface ExternalActionStoreDeps {
  now?: () => Date;
  randomUUID?: () => string;
}

export interface ExternalActionReserveInput {
  binding: EveExternalActionBinding;
  policyRevision: number;
  sessionEpoch: number;
  authorityDecision: EveExternalAuthorityDecision;
  authorityGrantId: string;
  classificationDigest: string;
  riskClass: EveExternalActionRiskClass;
  actionKind: EveExternalActionKind;
  domain?: string;
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
}

export interface ExternalActionLedgerRecord {
  reservationId: string;
  state: EveExternalActionLedgerState;
  binding: EveExternalActionBinding;
  intentId: string;
  requestId: string;
  operationDigest: string;
  idempotencyKeyDigest: string;
  executionContractDigest: string;
  quoteDigest?: string;
  policyRevision: number;
  sessionEpoch: number;
  amountMinor: number;
  currency: string;
  claimId?: string;
  secretUseConsumed: boolean;
}

export interface ExternalSecretHandleInput {
  binding: EveExternalActionBinding;
  handleId: string;
  type: EveSecretHandleType;
  source: EveSecretHandleSource;
  sourceRef: string;
  actionKinds: readonly EveExternalActionKind[];
  domains: readonly string[];
  expiresAt: string;
}

export interface ExternalSecretHandleRecord extends ExternalSecretHandleInput {
  revokedAt?: string;
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
  intent_id: string;
  request_id: string;
  operation_digest: string;
  idempotency_key_digest: string;
  execution_contract_digest: string;
  quote_digest: string | null;
  policy_revision: number;
  session_epoch: number;
  amount_minor: number;
  currency: string;
  claim_id: string | null;
  secret_use_consumed: number;
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

function bindingArgs(binding: EveExternalActionBinding): readonly string[] {
  return [binding.installationId, binding.accountId, binding.seedId];
}

function validBinding(binding: EveExternalActionBinding): boolean {
  return isEveOpaqueId(binding.installationId) && isEveOpaqueId(binding.accountId) && isEveOpaqueId(binding.seedId);
}

function parseStringArray(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

function policyFromRow(row: PolicyRow | undefined): EveExternalActionPolicy | null {
  if (!row) return null;
  const allowedDomains = parseStringArray(row.allowed_domains_json);
  const rawKinds = parseStringArray(row.allowed_action_kinds_json);
  if (!allowedDomains || !rawKinds || !rawKinds.every(isEveExternalActionKind)) return null;
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
    allowedDomains,
    allowedActionKinds: rawKinds as EveExternalActionKind[],
    expiresAt: row.expires_at,
    killSwitch: row.kill_switch === 1,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    updatedAt: row.updated_at,
  };
}

function ledgerFromRow(row: LedgerRow | undefined): ExternalActionLedgerRecord | null {
  if (!row) return null;
  return {
    reservationId: row.reservation_id,
    state: row.state,
    binding: {
      installationId: row.installation_id,
      accountId: row.account_id,
      seedId: row.seed_id,
    },
    intentId: row.intent_id,
    requestId: row.request_id,
    operationDigest: row.operation_digest,
    idempotencyKeyDigest: row.idempotency_key_digest,
    executionContractDigest: row.execution_contract_digest,
    ...(row.quote_digest ? { quoteDigest: row.quote_digest } : {}),
    policyRevision: row.policy_revision,
    sessionEpoch: row.session_epoch,
    amountMinor: row.amount_minor,
    currency: row.currency,
    ...(row.claim_id ? { claimId: row.claim_id } : {}),
    secretUseConsumed: row.secret_use_consumed === 1,
  };
}

function zonedPeriodKeys(now: Date, timezone: string): { dayId: string; monthId: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (!values.year || !values.month || !values.day) return null;
    return { dayId: `${values.year}-${values.month}-${values.day}`, monthId: `${values.year}-${values.month}` };
  } catch {
    return null;
  }
}

function validSourceRef(source: EveSecretHandleSource, sourceRef: unknown): sourceRef is string {
  if (typeof sourceRef !== 'string' || sourceRef.length > 8192) return false;
  if (source === 'eve_keychain') return sourceRef.startsWith(SOURCE_REF_PREFIXES[0]);
  return sourceRef.startsWith(SOURCE_REF_PREFIXES[1]);
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
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
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
        state TEXT NOT NULL CHECK (state IN ('reserved', 'claimed', 'allowed', 'reversed', 'unknown')),
        installation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seed_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        idempotency_key_digest TEXT NOT NULL,
        execution_contract_digest TEXT NOT NULL,
        quote_digest TEXT,
        authority_grant_id TEXT NOT NULL,
        classification_digest TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        session_epoch INTEGER NOT NULL,
        action_kind TEXT NOT NULL,
        domain TEXT,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        day_id TEXT NOT NULL,
        month_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_id TEXT UNIQUE,
        claim_digest TEXT,
        terminal_at TEXT,
        outcome_digest TEXT,
        secret_use_consumed INTEGER NOT NULL DEFAULT 0 CHECK (secret_use_consumed IN (0, 1)),
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
  }

  private ensureInstallationId(): string {
    const row = this.db.prepare('SELECT installation_id FROM external_action_meta WHERE singleton = 1').get() as
      | { installation_id?: unknown }
      | undefined;
    if (isEveOpaqueId(row?.installation_id)) return row.installation_id;
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
    this.db
      .prepare(
        `UPDATE external_action_reservations
         SET state = 'unknown', terminal_at = ?, outcome_digest = ?
         WHERE state = 'claimed'`
      )
      .run(nowIso, 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
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
          JSON.stringify(validation.value.allowedDomains),
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
    const reversed = this.db
      .prepare(
        `UPDATE external_action_reservations
         SET state = 'reversed', terminal_at = ?, outcome_digest = ?
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND state = 'reserved'`
      )
      .run(
        nowIso,
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        ...bindingArgs(binding)
      ).changes;
    const unknown = this.db
      .prepare(
        `UPDATE external_action_reservations
         SET state = 'unknown', terminal_at = ?, outcome_digest = ?
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND state = 'claimed'`
      )
      .run(
        nowIso,
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        ...bindingArgs(binding)
      ).changes;
    if (reversed > 0 || unknown > 0)
      this.audit(binding, 'ledger.invalidated', undefined, { reason, reversed, unknown });
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
    const domain = input.domain ? normalizeEveExternalDomain(input.domain) : null;
    if (DOMAIN_ACTIONS.has(input.actionKind)) {
      if (!domain || !policy.allowedDomains.includes(domain)) {
        return { ok: false, reasonCode: 'EXTERNAL_DOMAIN_BLOCKED' };
      }
    } else if (input.domain && !domain) {
      return { ok: false, reasonCode: 'EXTERNAL_DOMAIN_INVALID' };
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
        const dayTotal = this.budgetTotal(input.binding, input.currency, 'day_id', periods.dayId);
        if (dayTotal + input.amountMinor > policy.dailyLimitMinor) {
          return { ok: false, reasonCode: 'EXTERNAL_BUDGET_DAILY_EXCEEDED' };
        }
        const monthTotal = this.budgetTotal(input.binding, input.currency, 'month_id', periods.monthId);
        if (monthTotal + input.amountMinor > policy.monthlyLimitMinor) {
          return { ok: false, reasonCode: 'EXTERNAL_BUDGET_MONTHLY_EXCEEDED' };
        }
      }
      const reservationId = `reservation:${this.randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO external_action_reservations (
             reservation_id, state, installation_id, account_id, seed_id,
             intent_id, request_id, operation_digest, idempotency_key_digest,
             execution_contract_digest, quote_digest, authority_grant_id, classification_digest,
             policy_revision, session_epoch, action_kind, domain, amount_minor, currency,
             day_id, month_id, expires_at, created_at
           ) VALUES (?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reservationId,
          ...bindingArgs(input.binding),
          input.intentId,
          input.requestId,
          input.operationDigest,
          input.idempotencyKeyDigest,
          input.executionContractDigest,
          input.quoteDigest ?? null,
          input.authorityGrantId,
          input.classificationDigest,
          input.policyRevision,
          input.sessionEpoch,
          input.actionKind,
          domain,
          input.amountMinor,
          input.currency,
          periods.dayId,
          periods.monthId,
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
    if (
      !isEveOpaqueId(input.authorityGrantId) ||
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
    if (MONEY_ACTIONS.has(input.actionKind) && !isEveSha256Digest(input.quoteDigest)) {
      return 'EXTERNAL_QUOTE_REQUIRED';
    }
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < 0 ||
      !/^(?:[A-Z]{3}|NONE)$/.test(input.currency)
    ) {
      return 'EXTERNAL_AMOUNT_INVALID';
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
      record.requestId === input.requestId &&
      record.operationDigest === input.operationDigest &&
      record.idempotencyKeyDigest === input.idempotencyKeyDigest &&
      record.executionContractDigest === input.executionContractDigest &&
      record.quoteDigest === input.quoteDigest &&
      record.amountMinor === input.amountMinor &&
      record.currency === input.currency;
    return exact
      ? { ok: true, state: record.state, reservationId: record.reservationId, replay: true }
      : { ok: false, state: record.state, reservationId: record.reservationId, reasonCode: 'EXTERNAL_REPLAY_CONFLICT' };
  }

  private budgetTotal(
    binding: EveExternalActionBinding,
    currency: string,
    periodColumn: 'day_id' | 'month_id',
    period: string
  ): number {
    const states = ACTIVE_BUDGET_STATES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS total
         FROM external_action_reservations
         WHERE installation_id = ? AND account_id = ? AND seed_id = ? AND currency = ?
           AND ${periodColumn} = ? AND state IN (${states})`
      )
      .get(...bindingArgs(binding), currency, period, ...ACTIVE_BUDGET_STATES) as { total?: unknown } | undefined;
    return typeof row?.total === 'number' && Number.isSafeInteger(row.total) ? row.total : 0;
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
      if (!policy || policy.killSwitch || policy.revokedAt || Date.parse(policy.expiresAt) <= this.now().getTime()) {
        return { ok: false, execute: false, reasonCode: 'EXTERNAL_POLICY_NOT_ACTIVE' };
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
    if (!validBinding(input.binding) || !isEveSha256Digest(input.outcomeDigest)) {
      return { ok: false, reasonCode: 'EXTERNAL_OUTCOME_INVALID' };
    }
    const transaction = this.db.transaction((): ExternalActionReservationResult => {
      const changed = this.db
        .prepare(
          `UPDATE external_action_reservations
           SET state = ?, terminal_at = ?, outcome_digest = ?
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND claim_id = ? AND state = 'claimed'`
        )
        .run(
          state,
          this.now().toISOString(),
          input.outcomeDigest,
          input.reservationId,
          ...bindingArgs(input.binding),
          input.claimId
        ).changes;
      if (changed === 1) {
        this.audit(input.binding, eventType, input.reservationId, { outcome_digest: input.outcomeDigest });
        return { ok: true, state, reservationId: input.reservationId };
      }
      const existing = this.getReservation(input.binding, input.reservationId);
      return existing
        ? { ok: true, state: existing.state, reservationId: existing.reservationId, replay: true }
        : { ok: false, reasonCode: 'EXTERNAL_RESERVATION_NOT_FOUND' };
    });
    try {
      return transaction();
    } catch {
      return { ok: false, reasonCode: 'EXTERNAL_OUTCOME_PERSIST_FAILED' };
    }
  }

  reverse(input: ExternalActionTerminalInput): ExternalActionReservationResult {
    if (!validBinding(input.binding) || !isEveSha256Digest(input.outcomeDigest)) {
      return { ok: false, reasonCode: 'EXTERNAL_REVERSAL_INVALID' };
    }
    const transaction = this.db.transaction((): ExternalActionReservationResult => {
      const changed = this.db
        .prepare(
          `UPDATE external_action_reservations
           SET state = 'reversed', terminal_at = ?, outcome_digest = ?
           WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
             AND (claim_id = ? OR (claim_id IS NULL AND ? = ''))
             AND state IN ('reserved', 'claimed', 'allowed', 'unknown')`
        )
        .run(
          this.now().toISOString(),
          input.outcomeDigest,
          input.reservationId,
          ...bindingArgs(input.binding),
          input.claimId,
          input.claimId
        ).changes;
      if (changed === 1) {
        this.audit(input.binding, 'ledger.reversed', input.reservationId, { outcome_digest: input.outcomeDigest });
        return { ok: true, state: 'reversed', reservationId: input.reservationId };
      }
      const existing = this.getReservation(input.binding, input.reservationId);
      return existing
        ? { ok: true, state: existing.state, reservationId: existing.reservationId, replay: true }
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

  registerSecretHandle(input: ExternalSecretHandleInput): { ok: true } | { ok: false; reasonCode: string } {
    if (
      !validBinding(input.binding) ||
      input.binding.installationId !== this.installationId ||
      !isEveOpaqueId(input.handleId) ||
      !validSourceRef(input.source, input.sourceRef) ||
      !input.actionKinds.every(isEveExternalActionKind)
    ) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_INVALID' };
    }
    const domains: string[] = [];
    for (const raw of input.domains) {
      const domain = normalizeEveExternalDomain(raw);
      if (!domain) return { ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_DOMAIN_INVALID' };
      if (!domains.includes(domain)) domains.push(domain);
    }
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
          JSON.stringify(domains.toSorted()),
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
    const domains = parseStringArray(row.domains_json);
    if (!actionKinds || !actionKinds.every(isEveExternalActionKind) || !domains) return null;
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
      domains,
      expiresAt: row.expires_at,
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    };
  }

  consumeSecretUsePermit(
    binding: EveExternalActionBinding,
    reservationId: string,
    claimId: string
  ): { ok: true } | { ok: false; reasonCode: string } {
    if (!validBinding(binding) || !isEveOpaqueId(reservationId) || !isEveOpaqueId(claimId)) {
      return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_INVALID' };
    }
    const changed = this.db
      .prepare(
        `UPDATE external_action_reservations SET secret_use_consumed = 1
         WHERE reservation_id = ? AND installation_id = ? AND account_id = ? AND seed_id = ?
           AND claim_id = ? AND state = 'claimed' AND secret_use_consumed = 0`
      )
      .run(reservationId, ...bindingArgs(binding), claimId).changes;
    if (changed !== 1) return { ok: false, reasonCode: 'EXTERNAL_SECRET_USE_REPLAY_BLOCKED' };
    this.audit(binding, 'secret_handle.use_consumed', reservationId, { claim_id: claimId });
    return { ok: true };
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
