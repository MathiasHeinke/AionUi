/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import type { EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';

const TOKEN_PREFIX = 'policy-context:v1:';

function payload(binding: EveExternalActionBinding, revision: number, sessionEpoch: number): string {
  return JSON.stringify([binding.installationId, binding.accountId, binding.seedId, revision, sessionEpoch]);
}

/**
 * Main-only stale-context fence. This opaque HMAC is not authority: it merely
 * proves that a renderer mutation was composed from the currently displayed
 * account/Seed/revision. Main still derives and enforces the actual binding.
 */
export function signExternalActionPolicyContext(
  key: Uint8Array,
  binding: EveExternalActionBinding,
  revision: number,
  sessionEpoch: number
): string {
  if (
    key.byteLength < 32 ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(sessionEpoch) ||
    sessionEpoch < 0
  ) {
    throw new Error('EXTERNAL_POLICY_CONTEXT_INPUT_INVALID');
  }
  const digest = crypto
    .createHmac('sha256', key)
    .update(payload(binding, revision, sessionEpoch))
    .digest('hex');
  return `${TOKEN_PREFIX}${digest}`;
}

export function verifyExternalActionPolicyContext(
  key: Uint8Array,
  token: unknown,
  binding: EveExternalActionBinding,
  revision: number,
  sessionEpoch: number
): boolean {
  if (typeof token !== 'string' || !/^policy-context:v1:[a-f0-9]{64}$/.test(token)) return false;
  const expected = signExternalActionPolicyContext(key, binding, revision, sessionEpoch);
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
