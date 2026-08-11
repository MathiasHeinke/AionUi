/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider-neutral constraints for externally visible actions.
 *
 * This is deliberately NOT a permission engine. The existing EVE/AionCore
 * authority must already have returned `allow`; these constraints can only
 * narrow that decision by account, seed, scope, expiry, budget and revocation.
 * Renderer requests never carry account, seed, installation, revision or epoch
 * authority. Main constructs those fields from trusted local state.
 */

export const EVE_EXTERNAL_ACTION_POLICY_VERSION = 'command-eve-external-action-policy/v0' as const;

export const EVE_EXTERNAL_ACTION_KINDS = [
  'account_create',
  'software_install',
  'purchase',
  'recurring_payment',
  'browser_submit',
  'desktop_action',
  'artifact_modify',
  'communication_send',
] as const;

export type EveExternalActionKind = (typeof EVE_EXTERNAL_ACTION_KINDS)[number];
export type EveExternalActionRiskClass = 'ordinary' | 'legal_agreement' | 'security_expansion' | 'high_risk_finance';
export type EveExternalAuthorityDecision = 'allow' | 'ask' | 'block';
export type EveExternalActionLedgerState = 'reserved' | 'claimed' | 'allowed' | 'reversed' | 'unknown';
export type EveSecretHandleType =
  | 'identity_email'
  | 'identity_phone'
  | 'payment_profile'
  | 'service_credential'
  | 'account_credential';
export type EveSecretHandleSource = 'eve_keychain' | 'hermes_secret_source';

export interface EveExternalActionBinding {
  installationId: string;
  accountId: string;
  seedId: string;
}

export interface EveExternalActionPolicy {
  version: typeof EVE_EXTERNAL_ACTION_POLICY_VERSION;
  binding: EveExternalActionBinding;
  revision: number;
  sessionEpoch: number;
  currency: string;
  timezone: string;
  perActionLimitMinor: number;
  dailyLimitMinor: number;
  monthlyLimitMinor: number;
  allowedDomains: readonly string[];
  allowedActionKinds: readonly EveExternalActionKind[];
  expiresAt: string;
  killSwitch: boolean;
  revokedAt?: string;
  updatedAt: string;
}

/** Renderer-editable values only. Binding and authority fields are absent by construction. */
export interface EveExternalActionPolicyMutation {
  currency: string;
  perActionLimitMinor: number;
  dailyLimitMinor: number;
  monthlyLimitMinor: number;
  allowedDomains: readonly string[];
  allowedActionKinds: readonly EveExternalActionKind[];
  expiresAt: string;
}

export interface EveExternalActionPolicyView {
  version: typeof EVE_EXTERNAL_ACTION_POLICY_VERSION;
  configured: boolean;
  revision: number;
  sessionEpoch: number;
  currency: string;
  perActionLimitMinor: number;
  dailyLimitMinor: number;
  monthlyLimitMinor: number;
  allowedDomains: readonly string[];
  allowedActionKinds: readonly EveExternalActionKind[];
  expiresAt: string | null;
  killSwitch: boolean;
  revoked: boolean;
  reasonCode?: string;
}

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_POLICY_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;

export function isEveOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_RE.test(value);
}

export function isEveSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

export function isEveExternalActionKind(value: unknown): value is EveExternalActionKind {
  return EVE_EXTERNAL_ACTION_KINDS.includes(value as EveExternalActionKind);
}

export function normalizeEveExternalDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || domain.includes('://') || domain.includes('/') || domain.includes('*')) {
    return null;
  }
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_RE.test(label))) return null;
  return domain;
}

export type EveExternalPolicyValidationResult =
  | { ok: true; value: EveExternalActionPolicyMutation }
  | { ok: false; reasonCode: string };

function validMinorUnits(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Strictly normalize the renderer-editable policy payload. No fallback widens scope. */
export function validateEveExternalActionPolicyMutation(
  input: unknown,
  now: Date = new Date()
): EveExternalPolicyValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_INVALID' };
  }
  const record = input as Record<string, unknown>;
  if (typeof record.currency !== 'string' || !/^[A-Z]{3}$/.test(record.currency)) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_CURRENCY_INVALID' };
  }
  if (
    !validMinorUnits(record.perActionLimitMinor) ||
    !validMinorUnits(record.dailyLimitMinor) ||
    !validMinorUnits(record.monthlyLimitMinor)
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_BUDGET_INVALID' };
  }
  if (
    (record.dailyLimitMinor as number) < (record.perActionLimitMinor as number) ||
    (record.monthlyLimitMinor as number) < (record.dailyLimitMinor as number)
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_BUDGET_ORDER_INVALID' };
  }
  if (!Array.isArray(record.allowedDomains) || !Array.isArray(record.allowedActionKinds)) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_SCOPE_INVALID' };
  }
  const domains: string[] = [];
  for (const raw of record.allowedDomains) {
    const domain = normalizeEveExternalDomain(raw);
    if (!domain) return { ok: false, reasonCode: 'EXTERNAL_POLICY_DOMAIN_INVALID' };
    if (!domains.includes(domain)) domains.push(domain);
  }
  const actionKinds: EveExternalActionKind[] = [];
  for (const raw of record.allowedActionKinds) {
    if (!isEveExternalActionKind(raw)) return { ok: false, reasonCode: 'EXTERNAL_POLICY_ACTION_KIND_INVALID' };
    if (!actionKinds.includes(raw)) actionKinds.push(raw);
  }
  if (actionKinds.length === 0) return { ok: false, reasonCode: 'EXTERNAL_POLICY_SCOPE_EMPTY' };

  if (typeof record.expiresAt !== 'string') return { ok: false, reasonCode: 'EXTERNAL_POLICY_EXPIRY_INVALID' };
  const expiresMs = Date.parse(record.expiresAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs || expiresMs - nowMs > MAX_POLICY_LIFETIME_MS) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_EXPIRY_INVALID' };
  }

  return {
    ok: true,
    value: {
      currency: record.currency,
      perActionLimitMinor: record.perActionLimitMinor as number,
      dailyLimitMinor: record.dailyLimitMinor as number,
      monthlyLimitMinor: record.monthlyLimitMinor as number,
      allowedDomains: domains.toSorted(),
      allowedActionKinds: actionKinds,
      expiresAt: new Date(expiresMs).toISOString(),
    },
  };
}

export function failClosedEveExternalActionPolicyView(reasonCode?: string): EveExternalActionPolicyView {
  return {
    version: EVE_EXTERNAL_ACTION_POLICY_VERSION,
    configured: false,
    revision: 0,
    sessionEpoch: 0,
    currency: 'EUR',
    perActionLimitMinor: 0,
    dailyLimitMinor: 0,
    monthlyLimitMinor: 0,
    allowedDomains: [],
    allowedActionKinds: [],
    expiresAt: null,
    killSwitch: true,
    revoked: false,
    ...(reasonCode ? { reasonCode } : {}),
  };
}

export function toEveExternalActionPolicyView(policy: EveExternalActionPolicy): EveExternalActionPolicyView {
  return {
    version: EVE_EXTERNAL_ACTION_POLICY_VERSION,
    configured: true,
    revision: policy.revision,
    sessionEpoch: policy.sessionEpoch,
    currency: policy.currency,
    perActionLimitMinor: policy.perActionLimitMinor,
    dailyLimitMinor: policy.dailyLimitMinor,
    monthlyLimitMinor: policy.monthlyLimitMinor,
    allowedDomains: policy.allowedDomains,
    allowedActionKinds: policy.allowedActionKinds,
    expiresAt: policy.expiresAt,
    killSwitch: policy.killSwitch,
    revoked: typeof policy.revokedAt === 'string',
  };
}
