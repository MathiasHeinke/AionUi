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
export type EveExternalActionLedgerState =
  | 'reserved'
  | 'claimed'
  | 'suspended'
  | 'resuming'
  | 'allowed'
  | 'reversed'
  | 'denied'
  | 'revoked'
  | 'expired'
  | 'unknown'
  | 'reconciled_committed'
  | 'reconciled_no_effect';
export type EveExternalExecutionStatus =
  | 'allowed'
  | 'needs_user'
  | 'denied'
  | 'revoked'
  | 'expired'
  | 'unknown_outcome'
  | 'reconciled_committed'
  | 'reconciled_no_effect';
export type EveSecretHandleType =
  | 'identity_email'
  | 'identity_phone'
  | 'payment_profile'
  | 'service_credential'
  | 'account_credential'
  | 'oauth_token'
  | 'otp_code';
export type EveSecretHandleSource = 'eve_keychain' | 'hermes_onepassword' | 'hermes_bitwarden' | 'hermes_command';

export const EVE_SECRET_FIELD_SLOTS = [
  'email_address',
  'phone_number',
  'account_username',
  'account_password',
  'oauth_token',
  'otp_code',
  'payment_pan',
  'payment_expiry',
  'payment_cvc',
  'billing_profile',
  'shipping_profile',
] as const;
export type EveSecretFieldSlot = (typeof EVE_SECRET_FIELD_SLOTS)[number];

export const EVE_SECRET_HANDLE_TYPES: readonly EveSecretHandleType[] = [
  'identity_email',
  'identity_phone',
  'payment_profile',
  'service_credential',
  'account_credential',
  'oauth_token',
  'otp_code',
] as const;

export const EVE_SECRET_HANDLE_SOURCES: readonly EveSecretHandleSource[] = [
  'eve_keychain',
  'hermes_onepassword',
  'hermes_bitwarden',
  'hermes_command',
] as const;

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
  allowedOrigins: readonly string[];
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
  allowedOrigins: readonly string[];
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
  allowedOrigins: readonly string[];
  allowedActionKinds: readonly EveExternalActionKind[];
  expiresAt: string | null;
  killSwitch: boolean;
  revoked: boolean;
  reasonCode?: string;
}

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HTTPS_DEFAULT_PORT = '443';
const MAX_POLICY_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const POLICY_MUTATION_KEYS = [
  'currency',
  'perActionLimitMinor',
  'dailyLimitMinor',
  'monthlyLimitMinor',
  'allowedOrigins',
  'allowedActionKinds',
  'expiresAt',
] as const;

export function isEveOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_RE.test(value);
}

export function isEveSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

export function isEveExternalActionKind(value: unknown): value is EveExternalActionKind {
  return EVE_EXTERNAL_ACTION_KINDS.includes(value as EveExternalActionKind);
}

export function isEveSecretHandleType(value: unknown): value is EveSecretHandleType {
  return EVE_SECRET_HANDLE_TYPES.includes(value as EveSecretHandleType);
}

export function isEveSecretHandleSource(value: unknown): value is EveSecretHandleSource {
  return EVE_SECRET_HANDLE_SOURCES.includes(value as EveSecretHandleSource);
}

export function isEveSecretFieldSlot(value: unknown): value is EveSecretFieldSlot {
  return EVE_SECRET_FIELD_SLOTS.includes(value as EveSecretFieldSlot);
}

export function eveSecretSlotAllowsHandleType(slot: EveSecretFieldSlot, type: EveSecretHandleType): boolean {
  switch (slot) {
    case 'email_address':
      return type === 'identity_email';
    case 'phone_number':
      return type === 'identity_phone';
    case 'account_username':
    case 'account_password':
      return type === 'account_credential';
    case 'oauth_token':
      return type === 'oauth_token';
    case 'otp_code':
      return type === 'otp_code';
    case 'payment_pan':
    case 'payment_expiry':
    case 'payment_cvc':
    case 'billing_profile':
    case 'shipping_profile':
      return type === 'payment_profile';
  }
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

/**
 * Exact external origin fence. The first product slice is HTTPS-only: a
 * browser/API action that needs another scheme must land as an explicitly
 * reviewed adapter extension instead of widening this parser. Paths, queries,
 * fragments, credentials and wildcard hosts are rejected.
 */
export function normalizeEveExternalOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    normalizeEveExternalDomain(parsed.hostname) === null
  ) {
    return null;
  }
  const port = parsed.port === HTTPS_DEFAULT_PORT ? '' : parsed.port;
  return `https://${parsed.hostname.toLowerCase()}${port ? `:${port}` : ''}`;
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
  if (
    !POLICY_MUTATION_KEYS.every((key) => Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !POLICY_MUTATION_KEYS.includes(key as (typeof POLICY_MUTATION_KEYS)[number]))
  ) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_FIELDS_INVALID' };
  }
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
  if (!Array.isArray(record.allowedOrigins) || !Array.isArray(record.allowedActionKinds)) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_SCOPE_INVALID' };
  }
  const origins: string[] = [];
  for (const raw of record.allowedOrigins) {
    const origin = normalizeEveExternalOrigin(raw);
    if (!origin) return { ok: false, reasonCode: 'EXTERNAL_POLICY_ORIGIN_INVALID' };
    if (!origins.includes(origin)) origins.push(origin);
  }
  const actionKinds: EveExternalActionKind[] = [];
  for (const raw of record.allowedActionKinds) {
    if (!isEveExternalActionKind(raw)) return { ok: false, reasonCode: 'EXTERNAL_POLICY_ACTION_KIND_INVALID' };
    if (!actionKinds.includes(raw)) actionKinds.push(raw);
  }
  if (origins.length === 0 || actionKinds.length === 0) {
    return { ok: false, reasonCode: 'EXTERNAL_POLICY_SCOPE_EMPTY' };
  }

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
      allowedOrigins: origins.toSorted(),
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
    allowedOrigins: [],
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
    allowedOrigins: policy.allowedOrigins,
    allowedActionKinds: policy.allowedActionKinds,
    expiresAt: policy.expiresAt,
    killSwitch: policy.killSwitch,
    revoked: typeof policy.revokedAt === 'string',
  };
}
