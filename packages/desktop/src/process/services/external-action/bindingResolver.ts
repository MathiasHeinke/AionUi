/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isEveOpaqueId, type EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';
import { readAccountSession } from '@process/commandEve/accountSessionAtRest';
import { getActiveSeatId, isLegacySeatId, sanitizeSeatId } from '@process/commandEve/seatContextCore';
import type { ExternalActionStore } from './externalActionStore';

export interface ExternalActionBindingResolverDeps {
  readAccountId?: (userDataPath: string) => string | null;
  getActiveSeedId?: () => string;
}

export type ExternalActionBindingResolution =
  | { ok: true; binding: EveExternalActionBinding }
  | { ok: false; reasonCode: string };

function defaultReadAccountId(userDataPath: string): string | null {
  const session = readAccountSession(userDataPath);
  // Deliberately select only the stable account id. Tokens, email and profile
  // data are discarded inside Main and never enter policy, ledger, IPC or logs.
  return session.ok && isEveOpaqueId(session.session?.user.id) ? session.session.user.id : null;
}

/** Build installation/account/seed scope exclusively from trusted Main state. */
export function resolveExternalActionBinding(
  store: ExternalActionStore,
  userDataPath: string,
  deps: ExternalActionBindingResolverDeps = {}
): ExternalActionBindingResolution {
  const accountId = (deps.readAccountId ?? defaultReadAccountId)(userDataPath);
  if (!isEveOpaqueId(accountId)) return { ok: false, reasonCode: 'EXTERNAL_POLICY_ACCOUNT_UNAVAILABLE' };
  const rawSeedId = (deps.getActiveSeedId ?? getActiveSeatId)();
  const seedId = sanitizeSeatId(rawSeedId);
  if (!seedId || isLegacySeatId(seedId)) return { ok: false, reasonCode: 'EXTERNAL_POLICY_SEED_UNAVAILABLE' };
  return {
    ok: true,
    binding: { installationId: store.getInstallationId(), accountId, seedId },
  };
}
