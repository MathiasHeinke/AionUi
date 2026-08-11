/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { ExternalActionStore } from './externalActionStore';

const DATABASE_FILE = 'external-action-ledger.sqlite3';
const stores = new Map<string, ExternalActionStore>();

export function externalActionDatabasePath(userDataPath: string): string {
  return path.join(path.resolve(userDataPath), 'command-eve-runtime', DATABASE_FILE);
}

/** Open one Main-process store per app-data root. No renderer-facing database handle exists. */
export function getExternalActionStore(userDataPath: string): ExternalActionStore {
  const databasePath = externalActionDatabasePath(userDataPath);
  const existing = stores.get(databasePath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const store = new ExternalActionStore(new BetterSqlite3Driver(databasePath));
  try {
    fs.chmodSync(databasePath, 0o600);
  } catch {
    // The database contains no plaintext credential material. Failure to set
    // mode still surfaces through platform packaging/security review.
  }
  stores.set(databasePath, store);
  return store;
}

export function closeExternalActionStoresForTests(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}

export { ExternalActionStore } from './externalActionStore';
export { ExternalSecretUseBroker } from './secretUseBroker';
export { ExternalActionExecutionService } from './externalActionExecutionService';
export { externalActionBrowserPartition } from './browserProfileScope';
export { NativeSecretMaterialResolver, registerHermesSecretSourceReadPort } from './nativeSecretMaterialResolver';
export { resolveExternalActionBinding } from './bindingResolver';
export { signExternalActionPolicyContext, verifyExternalActionPolicyContext } from './policyContextToken';
export type { ExternalActionBindingResolution, ExternalActionBindingResolverDeps } from './bindingResolver';
export type {
  ExternalActionClaimInput,
  ExternalActionClaimResult,
  ExternalActionChallengeRecord,
  ExternalActionChallengeResumeInput,
  ExternalActionChallengeSnapshot,
  ExternalActionChallengeSuspendInput,
  ExternalActionChallengeSuspendResult,
  ExternalActionContinuationKind,
  ExternalActionExecutionContractExpectation,
  ExternalActionExecutionContractIdentity,
  ExternalActionLedgerRecord,
  ExternalActionReservationResult,
  ExternalActionReserveInput,
  ExternalActionStoreDeps,
  ExternalActionTerminalInput,
  ExternalActionReconciliationDecision,
  ExternalActionVerifiedReconciliationInput,
  ExternalSecretHandleInput,
  ExternalSecretHandleAccess,
  ExternalSecretHandleRecord,
  ExternalSecretPermitDigestPreimage,
  ExternalSecretShareGrantInput,
  ExternalSecretSlotPermitInput,
} from './externalActionStore';
export type {
  ExternalActionAdapter,
  ExternalActionAdapterPayloadReadPort,
  ExternalActionAdapterContext,
  ExternalActionAdapterOutcome,
  ExternalActionAdapterResumeContext,
  ExternalActionAuthorityResolution,
  ExternalActionCompletionAttestation,
  ExternalActionCompletionAttestationReadPort,
  ExternalActionConversationContext,
  ExternalActionConversationContextReadPort,
  ExternalActionConversationContextResolution,
  ExternalActionReconciliationEvidence,
  ExternalActionReconciliationEvidenceReadPort,
  ExternalActionReconciliationRequest,
  ExternalActionExecutionDeps,
  ExternalActionSecretFieldSinkPort,
  ExternalActionAuthMode,
  ExternalActionAuthProbe,
} from './externalActionExecutionService';
export type { HermesSecretSourceReadPort, HermesSecretSourceReadRequest } from './nativeSecretMaterialResolver';
export type {
  ExternalSecretUseRequest,
  ExternalSecretUseResult,
  SecretMaterialInjector,
  SecretMaterialResolver,
} from './secretUseBroker';
