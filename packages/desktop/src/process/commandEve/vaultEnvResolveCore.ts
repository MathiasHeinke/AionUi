/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential-Vault ENV RESOLVER + vetted-store reader (S5 phase 1, arch §5/§11).
 *
 * `resolveEnvFromVault` decrypts a record's `env_refs` map into an IN-MEMORY
 * plaintext env map for a single MCP-server spawn. ALL-OR-NOTHING (arch §5/§11.2):
 * if ANY single ref fails to decrypt, the WHOLE resolve fails — NEVER a partial
 * env map, NEVER a half-configured MCP server, NEVER an empty/plaintext value
 * leaking in. Plaintext values live ONLY in the returned object (in-memory) and
 * are NEVER logged (only ref-name receipts, arch §11.6).
 *
 * `readVettedConnectorsForSeat` is the vetted-store read side (arch §1
 * resolution rule): the UNION of founder-vault records + the ACTIVE seat's own
 * seat-vault records, `vetted===true` only. Founder connectors appear in EVERY
 * seat; a seat's connectors appear ONLY in that seat — the isolation is a file
 * POSITION (`seatVaultDir(seatId)` reads only that seat's dir), not a filter.
 *
 * PURE + injectable (decryptSecret is a dep). No Electron, no network —
 * unit-testable in plain node/vitest.
 */

import { decryptSecret as realDecryptSecret } from '@/common/config/keychain';
import { founderVaultDir, seatVaultDir } from './vaultDirCore';
import { listVaultRecords, type VaultConnectorRecord } from './vaultRecordCore';

/** Injectable decrypt seam (defaults to the real keychain decrypt). */
export interface ResolveEnvDeps {
  decryptSecret?: (ref: string) => { ok: boolean; value?: string; reason_code?: string };
}

export type ResolveEnvResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; reason_code: string; env_name?: string };

/**
 * Decrypt EVERY `env_refs` value of a record into an in-memory plaintext env map.
 *
 * FAIL-CLOSED (all-or-nothing, arch §5/§11.2): the first ref that fails to
 * decrypt aborts the whole resolve — the caller gets `{ ok:false }` and NO env
 * map. A resolved value that is somehow empty is also treated as a failure (an
 * MCP server must never be handed an empty credential). The returned plaintext
 * lives only in memory for the spawn; it is never persisted or logged.
 */
export function resolveEnvFromVault(record: VaultConnectorRecord, deps: ResolveEnvDeps = {}): ResolveEnvResult {
  const decryptSecret = deps.decryptSecret ?? realDecryptSecret;
  const env: Record<string, string> = {};
  for (const [envName, ref] of Object.entries(record.env_refs)) {
    const dec = decryptSecret(ref);
    if (!dec.ok || typeof dec.value !== 'string' || dec.value.length === 0) {
      // ALL-OR-NOTHING: abort the whole connector, drop any partial map.
      return {
        ok: false,
        reason_code: dec.reason_code ?? 'VAULT_ENV_DECRYPT_FAILED',
        env_name: envName,
      };
    }
    env[envName] = dec.value;
  }
  return { ok: true, env };
}

/**
 * The vetted-store read side (arch §1 resolution rule):
 *   vettedConnectorsForSeat(X) = founderVault.vetted ∪ seatVault(X).vetted
 *
 * - Founder records come from `founderVaultDir(userDataPath)` and appear in
 *   EVERY seat.
 * - Seat records come from `seatVaultDir(configRoot, seatId)` — ONLY the
 *   sanitized seat's own dir. Seat-A records can NEVER appear in seat-B's union
 *   because `seatVaultDir(B)` reads a different directory (isolation is a
 *   position, not a filter). An unsanitizable seatId makes `seatVaultDir` THROW
 *   (path-traversal guard) BEFORE any read — propagated fail-closed.
 * - Only `vetted===true` records are returned.
 *
 * De-dupe rule: if BOTH founder and the seat vetted the SAME connector_id, the
 * SEAT record wins (client-specific credential overrides the founder default for
 * that seat) — consistent with the tree logic (nearer scope wins).
 *
 * PURE — no fs beyond `listVaultRecords` (which never throws / returns [] for a
 * missing dir).
 */
export function readVettedConnectorsForSeat(
  userDataPath: string,
  configRoot: string,
  seatId?: string | null
): VaultConnectorRecord[] {
  const founder = listVaultRecords(founderVaultDir(userDataPath)).filter((r) => r.vetted === true);
  // seatVaultDir THROWS for an unsanitizable id — fail-closed before any read.
  const seat = listVaultRecords(seatVaultDir(configRoot, seatId)).filter((r) => r.vetted === true);

  const byId = new Map<string, VaultConnectorRecord>();
  for (const r of founder) byId.set(r.connector_id, r);
  // Seat records override founder on id collision (nearer scope wins).
  for (const r of seat) byId.set(r.connector_id, r);
  return Array.from(byId.values());
}
