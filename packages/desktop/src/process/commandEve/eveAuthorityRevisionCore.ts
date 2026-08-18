/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import type { EveAuthorityRuntime } from '@/common/config/eveAuthorityRuntimeCore';

/**
 * A stable fingerprint of the exact authority projection and its mutation
 * epoch that authorized a native Hermes approval. Hermes persists "always" by
 * a caller-provided rule key; folding this revision into that key makes
 * same-rung grant changes, opaque-UI changes, seal changes, seat/context
 * changes, and revoke/restore cycles invalidate the old grant without taking
 * once/session/always convenience away while nothing changed.
 */
export function deriveEveAuthorityRevision(input: {
  runtime: EveAuthorityRuntime;
  seatId: string;
  seatContextRevision: number;
  authorityMutationEpoch: number;
}): string {
  const { authority_revision: _incomingRevision, ...projection } = input.runtime;
  const canonical = JSON.stringify([
    projection,
    {
      seatId: input.seatId,
      seatContextRevision: input.seatContextRevision,
      authorityMutationEpoch: input.authorityMutationEpoch,
    },
  ]);
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}
