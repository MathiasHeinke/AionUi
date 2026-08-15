/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential-Vault RECORD store (S5 phase 1, arch §2/§11).
 *
 * A vault is a directory of `.enc` records, ONE per connector. Each record
 * mirrors `SessionRecord` from `accountSessionAtRest.ts` 1:1: a plaintext-JSON
 * WRAPPER (metadata + env-var NAME → keychain-ref map) whose secret payloads are
 * ALREADY opaque `keychain:v1:` refs. The wrapper carries NO secret — only ref
 * strings + metadata — so writing it plaintext-JSON is consistent with
 * accountSession (where only `session_ref` is ciphertext). Scoping is the file
 * POSITION (founder/ vs seats/<id>/vault/), not the ref content — see
 * vaultDirCore.
 *
 * STRUCTURAL fail-closed invariants (arch §11.2/§11.3, not verhandelbar):
 *   1. Every `env_refs` VALUE must be a keychain ref (`isKeychainRef`). A record
 *      with ANY non-ref env value is REJECTED on WRITE and, defensively, on READ
 *      (a hand-edited-in plaintext value can never be handed to an MCP server).
 *   2. `vetted: true` requires a non-empty `human_gate_receipt`. The receipt is
 *      a STRUCTURAL precondition of vetted — a vetted record without evidence is
 *      REJECTED on WRITE (vetted can never become true without a receipt).
 *   3. Wrong version / malformed JSON / bad shape on READ → `null` (fail-closed).
 *
 * PURE fs (atomic 0600 write, 0700 dir via ensureVaultDir). No Electron, no
 * network — unit-testable in plain node/vitest. Reason-coded result objects
 * mirror keychain.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isKeychainRef } from '@/common/config/keychain';
import { resolveCanonicalConnectorId } from './connectorIdCore';

export const VAULT_CONNECTOR_RECORD_VERSION = 'command-eve-vault-connector/v1';

/** Record file extension (one `.enc` per connector). */
const RECORD_EXT = '.enc';

/**
 * A single connector's vault record (arch §2). The WRAPPER is plaintext JSON; the
 * SECRETS are the `env_refs` VALUES, which are `keychain:v1:` refs (never
 * plaintext). `scope` is redundant with the file position but stored for
 * self-description / audit.
 */
export interface VaultConnectorRecord {
  version: typeof VAULT_CONNECTOR_RECORD_VERSION;
  /** Manifest connector id, e.g. 'linear-project-management'. */
  connector_id: string;
  scope: 'founder' | 'seat';
  /** Present iff scope==='seat' (the sanitized seat id). */
  seat_id?: string;
  /**
   * env-var NAME -> `keychain:v1:` ref. Keys mirror the manifest's
   * `mcp_invocation.env_refs`. VALUES MUST be keychain refs — NEVER plaintext.
   * The MCP server receives these decrypted at bootstrap only (resolveEnvFromVault).
   */
  env_refs: Record<string, string>;
  /** true ONLY after preflight ready + HumanGate approve (arch §5). */
  vetted: boolean;
  /** receipt id/path proving the approval (evidence, not claim; arch §11.3). */
  human_gate_receipt: string;
  /** ISO — when the HumanGate approval happened. */
  approved_at: string;
  /** ISO — when this record was persisted. */
  stored_at: string;
}

// ---------------------------------------------------------------------------
// fs idiom (mirrors accountSessionAtRest.writeJsonAtomic600)
// ---------------------------------------------------------------------------

/** Atomic 0600 write via a same-dir temp + rename. Dir ensured 0700 first. */
function writeJsonAtomic600(file: string, data: unknown): void {
  writeBytesAtomic600(file, Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'));
}

function writeBytesAtomic600(file: string, data: Buffer): void {
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempFile, data, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, file);
  } finally {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // A successful rename makes the temp path absent. Cleanup failure on an
      // already-published destination must not turn a truthful restore into a
      // false failure; a remaining temp is ignored by every vault reader.
    }
  }
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

type CanonicalVaultDirResult = Readonly<
  | { ok: true; dir: string; exists: boolean }
  | { ok: false; reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' | 'VAULT_DIR_CREATE_FAILED' }
>;

type VaultRecordFileResult = Readonly<
  | { ok: true; connectorId: string; vaultDir: string; file: string; parentExists: boolean }
  | {
      ok: false;
      reason_code: 'VAULT_RECORD_CONNECTOR_ID_INVALID' | 'VAULT_DIR_ANCESTRY_UNSAFE' | 'VAULT_DIR_CREATE_FAILED';
    }
>;

function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * Resolve the platform's first path component (`/var` -> `/private/var` on
 * macOS), then lstat every lower component. This permits only the OS-level root
 * alias while refusing a symlink anywhere inside the app-owned vault ancestry.
 */
function resolveCanonicalVaultDir(vaultDir: string, create: boolean): CanonicalVaultDirResult {
  const absolute = path.resolve(vaultDir);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  if (segments.length === 0) return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };

  let anchor = path.join(parsed.root, segments[0]);
  try {
    const anchorStat = fs.lstatSync(anchor);
    if (anchorStat.isSymbolicLink()) anchor = fs.realpathSync.native(anchor);
    else if (!anchorStat.isDirectory()) return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  } catch {
    return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  }

  let current = anchor;
  let exists = true;
  for (const segment of segments.slice(1)) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) {
      exists = false;
      if (!create) continue;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        const created = fs.lstatSync(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
        }
        exists = true;
      } catch {
        return { ok: false, reason_code: 'VAULT_DIR_CREATE_FAILED' };
      }
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
    }
    if (!exists) return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  }

  if (exists) {
    try {
      if (fs.realpathSync.native(current) !== current) {
        return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
      }
    } catch {
      return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
    }
  }
  return { ok: true, dir: current, exists };
}

function resolveVaultRecordFile(vaultDir: string, connectorId: unknown, createParent: boolean): VaultRecordFileResult {
  const canonicalId = resolveCanonicalConnectorId(connectorId);
  if (!canonicalId.ok) return { ok: false, reason_code: 'VAULT_RECORD_CONNECTOR_ID_INVALID' };
  const parent = resolveCanonicalVaultDir(vaultDir, createParent);
  if (!parent.ok) return parent;
  const fileName = `${canonicalId.connectorId}${RECORD_EXT}`;
  const file = path.join(parent.dir, fileName);
  if (path.dirname(file) !== parent.dir || path.relative(parent.dir, file) !== fileName) {
    return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  }
  return {
    ok: true,
    connectorId: canonicalId.connectorId,
    vaultDir: parent.dir,
    file,
    parentExists: parent.exists,
  };
}

// ---------------------------------------------------------------------------
// Validation (structural, fail-closed)
// ---------------------------------------------------------------------------

/**
 * True iff `env_refs` is a plain object whose EVERY value is a keychain ref.
 * A record with any non-ref value is structurally invalid (arch §11.2).
 */
function envRefsAreAllKeychainRefs(envRefs: unknown): envRefs is Record<string, string> {
  if (typeof envRefs !== 'object' || envRefs === null || Array.isArray(envRefs)) return false;
  const entries = Object.entries(envRefs as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key.length === 0) return false;
    if (typeof value !== 'string' || !isKeychainRef(value)) return false;
  }
  return true;
}

/**
 * Validate a candidate record against the fail-closed contract. Returns a
 * reason-coded result; `record` present only when valid. Used by BOTH write
 * (reject a bad input before it hits disk) and read (reject a tampered file).
 */
export interface ValidateRecordResult {
  ok: boolean;
  record?: VaultConnectorRecord;
  reason_code?: string;
}

export function validateVaultRecord(value: unknown): ValidateRecordResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason_code: 'VAULT_RECORD_NOT_OBJECT' };
  }
  const r = value as Record<string, unknown>;

  if (r.version !== VAULT_CONNECTOR_RECORD_VERSION) {
    return { ok: false, reason_code: 'VAULT_RECORD_VERSION_MISMATCH' };
  }
  const connectorId = resolveCanonicalConnectorId(r.connector_id);
  if (!connectorId.ok) {
    return { ok: false, reason_code: 'VAULT_RECORD_CONNECTOR_ID_INVALID' };
  }
  if (r.scope !== 'founder' && r.scope !== 'seat') {
    return { ok: false, reason_code: 'VAULT_RECORD_SCOPE_INVALID' };
  }
  if (r.scope === 'seat' && (typeof r.seat_id !== 'string' || r.seat_id.trim().length === 0)) {
    return { ok: false, reason_code: 'VAULT_RECORD_SEAT_ID_REQUIRED' };
  }
  if (r.scope === 'founder' && r.seat_id !== undefined && typeof r.seat_id !== 'string') {
    return { ok: false, reason_code: 'VAULT_RECORD_SEAT_ID_INVALID' };
  }
  if (typeof r.vetted !== 'boolean') {
    return { ok: false, reason_code: 'VAULT_RECORD_VETTED_INVALID' };
  }
  if (typeof r.human_gate_receipt !== 'string') {
    return { ok: false, reason_code: 'VAULT_RECORD_RECEIPT_INVALID' };
  }
  if (typeof r.approved_at !== 'string' || typeof r.stored_at !== 'string') {
    return { ok: false, reason_code: 'VAULT_RECORD_TIMESTAMP_INVALID' };
  }
  // STRUCTURAL invariant 1: every env-ref value must be a keychain ref.
  if (!envRefsAreAllKeychainRefs(r.env_refs)) {
    return { ok: false, reason_code: 'VAULT_RECORD_ENV_REF_NOT_KEYCHAIN' };
  }
  // STRUCTURAL invariant 2: vetted:true requires a non-empty receipt.
  if (r.vetted === true && r.human_gate_receipt.trim().length === 0) {
    return { ok: false, reason_code: 'VAULT_RECORD_VETTED_WITHOUT_RECEIPT' };
  }

  return {
    ok: true,
    record: {
      version: VAULT_CONNECTOR_RECORD_VERSION,
      connector_id: connectorId.connectorId,
      scope: r.scope,
      ...(typeof r.seat_id === 'string' ? { seat_id: r.seat_id } : {}),
      env_refs: r.env_refs as Record<string, string>,
      vetted: r.vetted,
      human_gate_receipt: r.human_gate_receipt,
      approved_at: r.approved_at,
      stored_at: r.stored_at,
    },
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path of a connector's record file: <vaultDir>/<connector_id>.enc. */
export function vaultRecordPath(vaultDir: string, connectorId: string): string {
  const resolved = resolveVaultRecordFile(vaultDir, connectorId, false);
  if (!resolved.ok) throw new Error(resolved.reason_code);
  return resolved.file;
}

// ---------------------------------------------------------------------------
// Write / read / list / delete
// ---------------------------------------------------------------------------

export interface WriteVaultRecordResult {
  ok: boolean;
  path?: string;
  reason_code?: string;
}

/**
 * Opaque byte snapshot used only to make a connector authority mutation
 * reversible. The snapshot intentionally does not parse the prior record: a
 * malformed/tampered record is fail-closed for runtime use but still belongs to
 * the operator and must be restored byte-for-byte if a later approval fails.
 */
export type VaultRecordFileSnapshot = Readonly<
  | { exists: false }
  | {
      exists: true;
      bytes: Buffer;
    }
>;

export type ReadVaultRecordFileSnapshotResult = Readonly<{
  ok: boolean;
  snapshot?: VaultRecordFileSnapshot;
  reason_code?: string;
}>;

export function readVaultRecordFileSnapshot(vaultDir: string, connectorId: string): ReadVaultRecordFileSnapshotResult {
  const resolved = resolveVaultRecordFile(vaultDir, connectorId, false);
  if (!resolved.ok) return resolved;
  if (!resolved.parentExists) return { ok: true, snapshot: { exists: false } };
  try {
    const stat = fs.lstatSync(resolved.file, { throwIfNoEntry: false });
    if (!stat) return { ok: true, snapshot: { exists: false } };
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, reason_code: 'VAULT_RECORD_SNAPSHOT_NOT_REGULAR' };
    }
    return { ok: true, snapshot: { exists: true, bytes: fs.readFileSync(resolved.file) } };
  } catch {
    return { ok: false, reason_code: 'VAULT_RECORD_SNAPSHOT_READ_FAILED' };
  }
}

export function restoreVaultRecordFileSnapshot(
  vaultDir: string,
  connectorId: string,
  snapshot: VaultRecordFileSnapshot
): boolean {
  try {
    if (!snapshot.exists) return deleteVaultRecord(vaultDir, connectorId);
    const resolved = resolveVaultRecordFile(vaultDir, connectorId, true);
    if (!resolved.ok) return false;
    const endpoint = fs.lstatSync(resolved.file, { throwIfNoEntry: false });
    if (endpoint && (!endpoint.isFile() || endpoint.isSymbolicLink())) return false;
    writeBytesAtomic600(resolved.file, snapshot.bytes);
    const published = fs.lstatSync(resolved.file);
    return published.isFile() && !published.isSymbolicLink() && fs.readFileSync(resolved.file).equals(snapshot.bytes);
  } catch {
    return false;
  }
}

/**
 * Persist a vault record, atomic 0600, at `<vaultDir>/<connector_id>.enc`.
 *
 * FAIL-CLOSED: the record is validated (structural invariants incl. every env
 * value a keychain ref + vetted-requires-receipt) BEFORE any write. An invalid
 * record is REJECTED and NO file is written (not even a temp file). This is the
 * enforcement point for arch §11.2/§11.3 on the write side.
 */
export function writeVaultRecord(vaultDir: string, record: VaultConnectorRecord): WriteVaultRecordResult {
  const validated = validateVaultRecord(record);
  if (!validated.ok || !validated.record) {
    return { ok: false, reason_code: validated.reason_code ?? 'VAULT_RECORD_INVALID' };
  }
  const resolved = resolveVaultRecordFile(vaultDir, validated.record.connector_id, true);
  if (!resolved.ok) return { ok: false, reason_code: resolved.reason_code };
  try {
    const endpoint = fs.lstatSync(resolved.file, { throwIfNoEntry: false });
    if (endpoint && (!endpoint.isFile() || endpoint.isSymbolicLink())) {
      return { ok: false, reason_code: 'VAULT_RECORD_WRITE_FAILED' };
    }
    writeJsonAtomic600(resolved.file, validated.record);
    const published = fs.lstatSync(resolved.file);
    if (!published.isFile() || published.isSymbolicLink()) {
      return { ok: false, reason_code: 'VAULT_RECORD_WRITE_FAILED' };
    }
  } catch {
    return { ok: false, reason_code: 'VAULT_RECORD_WRITE_FAILED' };
  }
  return { ok: true, path: resolved.file };
}

/**
 * Read + validate a connector's record. FAIL-CLOSED: a missing file, wrong
 * version, malformed JSON, or ANY non-keychain-ref env value returns `null`
 * (arch §11.2). A record whose file was hand-edited to smuggle a plaintext env
 * value is rejected here even though write also rejects it — read is the second
 * line of defense.
 */
export function readVaultRecord(vaultDir: string, connectorId: string): VaultConnectorRecord | null {
  const resolved = resolveVaultRecordFile(vaultDir, connectorId, false);
  if (!resolved.ok || !resolved.parentExists) return null;
  const endpoint = lstatIfPresent(resolved.file);
  if (!endpoint?.isFile() || endpoint.isSymbolicLink()) return null;
  const raw = readJsonFile<unknown>(resolved.file);
  if (raw === null) return null;
  const validated = validateVaultRecord(raw);
  return validated.ok && validated.record && validated.record.connector_id === resolved.connectorId
    ? validated.record
    : null;
}

/**
 * List every VALID record in a vault dir. Non-`.enc` files are skipped; a file
 * that fails validation (wrong version / non-ref env value / bad shape) is
 * silently dropped (fail-closed — a tampered file never surfaces as a record).
 * A non-existent dir yields `[]`. Never throws.
 */
export function listVaultRecords(vaultDir: string): VaultConnectorRecord[] {
  const parent = resolveCanonicalVaultDir(vaultDir, false);
  if (!parent.ok || !parent.exists) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(parent.dir);
  } catch {
    return [];
  }
  const out: VaultConnectorRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(RECORD_EXT)) continue;
    const connectorId = entry.slice(0, -RECORD_EXT.length);
    if (!resolveCanonicalConnectorId(connectorId).ok) continue;
    const record = readVaultRecord(parent.dir, connectorId);
    if (record) out.push(record);
  }
  return out;
}

/** Delete a connector's record (revoke). Idempotent; never throws. */
export function deleteVaultRecord(vaultDir: string, connectorId: string): boolean {
  try {
    const resolved = resolveVaultRecordFile(vaultDir, connectorId, false);
    if (!resolved.ok) return false;
    if (!resolved.parentExists) return true;
    const endpoint = fs.lstatSync(resolved.file, { throwIfNoEntry: false });
    if (!endpoint) return true;
    if (!endpoint.isFile() || endpoint.isSymbolicLink()) return false;
    fs.rmSync(resolved.file, { force: true });
    return fs.lstatSync(resolved.file, { throwIfNoEntry: false }) === undefined;
  } catch {
    // ignore — delete must never throw
    return false;
  }
}
