/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Pure Command EVE C0 containment for renderer permission cards. */

export type PermissionOptionLike = {
  id: string;
  kind?: string;
  label: string;
  params?: Record<string, string>;
};

export type PermissionOptionView = PermissionOptionLike & {
  exactSessionIntent: boolean;
};

export type PermissionAuthorityMetadata = {
  protocol_version: number;
  operation_id: string;
  operation_digest: string;
  confirmation_version: number;
  policy_revision: number;
  session_epoch: number;
  created_at_ms: number;
  expires_at_ms: number;
  lifecycle: string;
  classification: string;
  required_authority?: string;
  runtime_receipt_digest: string;
};

const INACTIVE_PERMISSION_STATUSES = new Set([
  'expired',
  'cancelled',
  'canceled',
  'superseded',
  'allowed',
  'denied',
  'rejected',
  'resolved',
  'completed',
]);

const EXACT_SESSION_ALLOW_MARKERS = new Set([
  'allow_session',
  'allow_for_session',
  'allow_current_session',
  'proceed_session',
  'session_allow',
]);

const UNKNOWN_CLASSIFICATION_MARKERS = new Set([
  '',
  'unknown',
  'unclassified',
  'unverified',
  'missing',
  'not_classified',
  'not_verified',
]);

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parse only the safe, server-authored metadata envelope. Unknown shapes do not gain authority. */
export function parsePermissionAuthorityMetadata(value: unknown): PermissionAuthorityMetadata | null {
  const record = objectRecord(value);
  if (!record) return null;
  const protocolVersion = safeInteger(record.protocol_version);
  const confirmationVersion = safeInteger(record.confirmation_version);
  const policyRevision = safeInteger(record.policy_revision);
  const sessionEpoch = safeInteger(record.session_epoch);
  const createdAt = safeInteger(record.created_at_ms);
  const expiresAt = safeInteger(record.expires_at_ms);
  const requiredStrings = [
    record.operation_id,
    record.operation_digest,
    record.lifecycle,
    record.classification,
    record.runtime_receipt_digest,
  ];
  if (
    protocolVersion === null ||
    confirmationVersion === null ||
    policyRevision === null ||
    sessionEpoch === null ||
    createdAt === null ||
    expiresAt === null ||
    requiredStrings.some((field) => typeof field !== 'string' || field.length === 0)
  ) {
    return null;
  }
  const requiredAuthority = record.required_authority;
  if (requiredAuthority !== undefined && requiredAuthority !== null && typeof requiredAuthority !== 'string') {
    return null;
  }
  return {
    protocol_version: protocolVersion,
    operation_id: record.operation_id as string,
    operation_digest: record.operation_digest as string,
    confirmation_version: confirmationVersion,
    policy_revision: policyRevision,
    session_epoch: sessionEpoch,
    created_at_ms: createdAt,
    expires_at_ms: expiresAt,
    lifecycle: record.lifecycle as string,
    classification: record.classification as string,
    ...(typeof requiredAuthority === 'string' ? { required_authority: requiredAuthority } : {}),
    runtime_receipt_digest: record.runtime_receipt_digest as string,
  };
}

export function permissionAuthorityFromConfirmation(value: unknown): PermissionAuthorityMetadata | null {
  const confirmation = objectRecord(value);
  return parsePermissionAuthorityMetadata(confirmation?.authority);
}

/**
 * Lifecycle updates may retain a confirmation_version, so equal versions are
 * accepted. Older versions and unversioned frames cannot replace an already
 * authoritative projection.
 */
export function shouldApplyPermissionConfirmation(existing: unknown, incoming: unknown): boolean {
  const current = permissionAuthorityFromConfirmation(existing);
  const next = permissionAuthorityFromConfirmation(incoming);
  if (!current) return true;
  if (!next) return false;
  if (
    next.runtime_receipt_digest !== current.runtime_receipt_digest ||
    next.operation_id !== current.operation_id ||
    next.operation_digest !== current.operation_digest
  ) {
    return next.created_at_ms > current.created_at_ms;
  }
  if (next.session_epoch !== current.session_epoch) return next.session_epoch > current.session_epoch;
  return next.confirmation_version >= current.confirmation_version;
}

function optionTokens(option: PermissionOptionLike): string[] {
  return [option.id, option.kind, option.label].map(normalizeToken);
}

function hasMarker(tokens: ReadonlyArray<string>, markers: ReadonlySet<string>): boolean {
  return tokens.some((token) => markers.has(token));
}

/** Keep visible historical cards, but never let a terminal EVE card submit again. */
export function isPermissionCardInactive(status: unknown): boolean {
  return INACTIVE_PERMISSION_STATUSES.has(normalizeToken(status));
}

/** Missing/unknown server classification is deliberately shown as unverified. */
export function isPermissionClassificationUnverified(classification: unknown): boolean {
  return UNKNOWN_CLASSIFICATION_MARKERS.has(normalizeToken(classification));
}

/**
 * Preserve the native ACP option set. Command EVE only annotates the explicit
 * session choice so the renderer can describe its scope accurately.
 */
export function normalizePermissionOptions(
  options: ReadonlyArray<PermissionOptionLike>,
  isCommandEve: boolean
): PermissionOptionView[] {
  if (!isCommandEve) {
    return options.map((option) => ({ ...option, exactSessionIntent: false }));
  }

  return options.flatMap<PermissionOptionView>((option): PermissionOptionView[] => {
    const tokens = optionTokens(option);
    const exactSessionIntent = hasMarker(tokens, EXACT_SESSION_ALLOW_MARKERS);
    return [{ ...option, exactSessionIntent }];
  });
}

/** Treat an explicit unsuccessful authority response as failure even on HTTP 200. */
export function isExplicitPermissionFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (record.success === false || record.allowed === false || record.applied === false) return true;
  const data = record.data;
  if (!data || typeof data !== 'object') return false;
  const dataRecord = data as Record<string, unknown>;
  return dataRecord.success === false || dataRecord.allowed === false || dataRecord.applied === false;
}
