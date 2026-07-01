/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * guided_auth_setup — the REAL handler for the (previously dead) connector action
 * (S5 phase 2, arch §6). API-KEY PATH ONLY.
 *
 * OAuth is DEFERRED (arch §6.3): the aioncore OAuth-token sink is invisible from
 * the sandbox repo, so OAuth capture needs an S4 follow-up probe before it can be
 * built. API-key connectors (Notion-token first, arch correction §9) are fully
 * controllable in-repo and go FIRST.
 *
 * FLOW (arch §6, fail-closed FIRST):
 *   1. KEYCHAIN-GATE (FIRST, fail-closed): `isKeychainAvailable()===false` →
 *      REFUSE with `SECURE_STORAGE_UNAVAILABLE`. NEVER a plaintext fallback, NEVER
 *      a record written (the imageGenApiKeyAtRest pattern). The UI shows "secure
 *      storage unavailable".
 *   2. PREFLIGHT-GATE: the connector must carry an `mcp_invocation` (arch §6.1) —
 *      we must know WHICH env-var NAMES the server needs before we can map them.
 *   3. HUMANGATE-GATE: a non-empty `human_gate_receipt` is REQUIRED for vetted
 *      (arch §11.3 — vetted can never be true without evidence). No receipt →
 *      REJECT before any encrypt.
 *   4. ENCRYPT: each supplied API-key value is IMMEDIATELY `encryptSecret`'d; the
 *      plaintext never leaves this handler, never reaches renderer state /
 *      configService / chat / logs (arch §11.6 + `secret_handling:'never_in_chat'`).
 *   5. PERSIST: write a `VaultConnectorRecord` (`vetted:true`) to the scope's vault
 *      dir (founder default, or seat when the operator chose "only this client").
 *   6. The caller then RECONCILEs (bridge wiring) so the card flips to `connected`.
 *
 * PURE + INJECTABLE (keychain encrypt + isAvailable + a record writer are deps),
 * so this unit-tests in plain node/vitest. Reason-coded results mirror keychain.ts.
 */

import {
  encryptSecret as realEncryptSecret,
  isKeychainAvailable as realIsKeychainAvailable,
  type EncryptSecretResult,
} from '@/common/config/keychain';
import type { CommandEveConnectorMcpInvocation } from './connectorCatalogCore';
import {
  VAULT_CONNECTOR_RECORD_VERSION,
  writeVaultRecord as realWriteVaultRecord,
  type VaultConnectorRecord,
  type WriteVaultRecordResult,
} from './vaultRecordCore';
import { founderVaultDir as realFounderVaultDir, seatVaultDir as realSeatVaultDir } from './vaultDirCore';

/** The scope the operator chose at setup (arch §6.4). */
export type GuidedAuthScope = 'founder' | 'seat';

/** Input to a guided API-key setup (all plaintext values are consumed + destroyed here). */
export interface GuidedAuthSetupInput {
  connector_id: string;
  /** The connector's manifest invocation (must be present — arch §6.1). */
  mcp_invocation: CommandEveConnectorMcpInvocation | undefined;
  /**
   * env-var NAME → PLAINTEXT api-key value. Keys MUST cover exactly the
   * invocation's env_refs (each declared env-var must be supplied, no extras).
   */
  secrets: Record<string, string>;
  scope: GuidedAuthScope;
  /** Present iff scope==='seat' (sanitized by the caller / seatVaultDir guard). */
  seat_id?: string;
  /** Proof of the HumanGate approval (arch §11.3). Non-empty is REQUIRED for vetted. */
  human_gate_receipt: string;
  /** userData root (founder vault). */
  userDataPath: string;
  /** configRoot the seat vault lives under (hermesRoot). Required iff scope==='seat'. */
  configRoot?: string;
}

export interface GuidedAuthSetupResult {
  ok: boolean;
  reason_code?: string;
  /** The persisted record's file path (success only). */
  path?: string;
  /** The connector id (echoed for the caller's reconcile). */
  connector_id?: string;
}

/** Injectable seams (default = the real keychain + vault cores). */
export interface GuidedAuthSetupDeps {
  isKeychainAvailable?: () => boolean;
  encryptSecret?: (plain: string) => EncryptSecretResult;
  writeVaultRecord?: (vaultDir: string, record: VaultConnectorRecord) => WriteVaultRecordResult;
  founderVaultDir?: (userDataPath: string) => string;
  seatVaultDir?: (configRoot: string, seatId?: string | null) => string;
  now?: () => Date;
}

/**
 * Run the API-key guided setup, fail-closed at every gate. Returns a reason-coded
 * result; a `path` only on success. NO plaintext is ever returned, logged, or
 * persisted — the record stores ONLY keychain refs.
 */
export function runGuidedApiKeySetup(input: GuidedAuthSetupInput, deps: GuidedAuthSetupDeps = {}): GuidedAuthSetupResult {
  const isKeychainAvailable = deps.isKeychainAvailable ?? realIsKeychainAvailable;
  const encryptSecret = deps.encryptSecret ?? realEncryptSecret;
  const writeVaultRecord = deps.writeVaultRecord ?? realWriteVaultRecord;
  const founderVaultDir = deps.founderVaultDir ?? realFounderVaultDir;
  const seatVaultDir = deps.seatVaultDir ?? realSeatVaultDir;
  const now = deps.now ?? (() => new Date());

  // 1. KEYCHAIN-GATE FIRST (fail-closed). No secure storage → REFUSE, write nothing.
  if (isKeychainAvailable() !== true) {
    return { ok: false, reason_code: 'SECURE_STORAGE_UNAVAILABLE', connector_id: input.connector_id };
  }

  // Basic shape guards.
  const connectorId = typeof input.connector_id === 'string' ? input.connector_id.trim() : '';
  if (!connectorId) {
    return { ok: false, reason_code: 'GUIDED_AUTH_CONNECTOR_ID_MISSING' };
  }

  // 2. PREFLIGHT-GATE: need the manifest invocation (which env NAMES the server wants).
  const invocation = input.mcp_invocation;
  if (!invocation || invocation.transport !== 'stdio' || !Array.isArray(invocation.env_refs)) {
    return { ok: false, reason_code: 'GUIDED_AUTH_NO_MCP_INVOCATION', connector_id: connectorId };
  }
  const requiredEnvNames = invocation.env_refs.filter((n) => typeof n === 'string' && n.length > 0);
  if (requiredEnvNames.length === 0) {
    return { ok: false, reason_code: 'GUIDED_AUTH_NO_ENV_REFS', connector_id: connectorId };
  }

  // 3. HUMANGATE-GATE: a non-empty receipt is REQUIRED for a vetted record. Reject
  // BEFORE encrypting so a vetted record can NEVER be built without evidence.
  const receipt = typeof input.human_gate_receipt === 'string' ? input.human_gate_receipt.trim() : '';
  if (!receipt) {
    return { ok: false, reason_code: 'GUIDED_AUTH_HUMANGATE_RECEIPT_REQUIRED', connector_id: connectorId };
  }

  // Scope resolution + the target vault dir.
  if (input.scope !== 'founder' && input.scope !== 'seat') {
    return { ok: false, reason_code: 'GUIDED_AUTH_SCOPE_INVALID', connector_id: connectorId };
  }
  let vaultDir: string;
  if (input.scope === 'founder') {
    vaultDir = founderVaultDir(input.userDataPath);
  } else {
    if (typeof input.configRoot !== 'string' || !input.configRoot) {
      return { ok: false, reason_code: 'GUIDED_AUTH_SEAT_CONFIG_ROOT_REQUIRED', connector_id: connectorId };
    }
    if (typeof input.seat_id !== 'string' || !input.seat_id.trim()) {
      return { ok: false, reason_code: 'GUIDED_AUTH_SEAT_ID_REQUIRED', connector_id: connectorId };
    }
    try {
      // seatVaultDir THROWS for an unsanitizable seat id (path-traversal guard).
      vaultDir = seatVaultDir(input.configRoot, input.seat_id);
    } catch {
      return { ok: false, reason_code: 'GUIDED_AUTH_SEAT_ID_UNSAFE', connector_id: connectorId };
    }
  }

  // 4. ENCRYPT each required env value IMMEDIATELY. Every declared env-var must be
  // supplied; an extra/missing value is a REJECT (no partial connector). The
  // plaintext is read once here and dropped — it is never returned or logged.
  const suppliedNames = Object.keys(input.secrets ?? {});
  const requiredSet = new Set(requiredEnvNames);
  if (suppliedNames.length !== requiredEnvNames.length || !suppliedNames.every((n) => requiredSet.has(n))) {
    return { ok: false, reason_code: 'GUIDED_AUTH_ENV_MISMATCH', connector_id: connectorId };
  }
  const envRefs: Record<string, string> = {};
  for (const name of requiredEnvNames) {
    const plain = input.secrets[name];
    if (typeof plain !== 'string' || plain.length === 0) {
      return { ok: false, reason_code: 'GUIDED_AUTH_EMPTY_SECRET', connector_id: connectorId };
    }
    const enc = encryptSecret(plain);
    if (!enc.ok || !enc.ref) {
      // A mid-flight keychain failure — fail-closed, write NOTHING (no partial record).
      return { ok: false, reason_code: enc.reason_code ?? 'GUIDED_AUTH_ENCRYPT_FAILED', connector_id: connectorId };
    }
    envRefs[name] = enc.ref;
  }

  // 5. PERSIST the vault record (vetted:true, receipt attached). writeVaultRecord
  // re-validates the fail-closed invariants (every env value a keychain ref +
  // vetted-requires-receipt) before touching disk.
  const nowIso = now().toISOString();
  const record: VaultConnectorRecord = {
    version: VAULT_CONNECTOR_RECORD_VERSION,
    connector_id: connectorId,
    scope: input.scope,
    ...(input.scope === 'seat' ? { seat_id: input.seat_id } : {}),
    env_refs: envRefs,
    vetted: true,
    human_gate_receipt: receipt,
    approved_at: nowIso,
    stored_at: nowIso,
  };
  const write = writeVaultRecord(vaultDir, record);
  if (!write.ok) {
    return { ok: false, reason_code: write.reason_code ?? 'GUIDED_AUTH_WRITE_FAILED', connector_id: connectorId };
  }
  return { ok: true, path: write.path, connector_id: connectorId };
}
