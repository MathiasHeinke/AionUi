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

const DURABLE_ALLOW_MARKERS = new Set(['allow_always', 'always_allow', 'proceed_always', 'allow_permanently']);

const DURABLE_DENY_MARKERS = new Set([
  'deny_always',
  'reject_always',
  'always_deny',
  'always_reject',
  'proceed_never',
  'never_allow',
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
 * Filter only Command EVE options. Native ACP backends receive their original
 * option set unchanged. A session option remains an intent; AionCore binds it
 * to the exact operation and forwards only the one-shot backend option.
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
    if (exactSessionIntent) return [{ ...option, exactSessionIntent: true }];
    if (hasMarker(tokens, DURABLE_ALLOW_MARKERS) || hasMarker(tokens, DURABLE_DENY_MARKERS)) return [];
    return [{ ...option, exactSessionIntent: false }];
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
