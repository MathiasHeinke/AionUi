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
import { spawnSync } from 'node:child_process';
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
// Anchored filesystem access
// ---------------------------------------------------------------------------

type CanonicalVaultDirResult = Readonly<
  | { ok: true; dir: string; exists: boolean }
  | {
      ok: false;
      reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' | 'VAULT_DIR_CREATE_FAILED' | 'VAULT_DIR_IDENTITY_UNSAFE';
    }
>;

type VaultRecordFileResult = Readonly<
  | {
      ok: true;
      connectorId: string;
      vaultDir: string;
      fileName: string;
      file: string;
      parentExists: boolean;
    }
  | {
      ok: false;
      reason_code:
        | 'VAULT_RECORD_CONNECTOR_ID_INVALID'
        | 'VAULT_DIR_ANCESTRY_UNSAFE'
        | 'VAULT_DIR_CREATE_FAILED'
        | 'VAULT_DIR_IDENTITY_UNSAFE';
    }
>;

type VaultDirectoryIdentity = Readonly<{
  dev: number;
  ino: number;
  uid: number;
  mode: number;
}>;

type VaultDirectoryAnchor = Readonly<{
  dir: string;
  fd?: number;
  identity: VaultDirectoryIdentity;
}>;

type VaultDirectoryAnchorResult = Readonly<
  { ok: true; anchor: VaultDirectoryAnchor } | { ok: false; reason_code: 'VAULT_DIR_IDENTITY_UNSAFE' }
>;

export type VaultRecordFsOperation = 'snapshot' | 'read' | 'write' | 'restore' | 'delete' | 'list';

let vaultRecordFsBarrierForTests: ((operation: VaultRecordFsOperation, canonicalVaultDir: string) => void) | undefined;
let vaultRecordNativeHelperForTests:
  | Readonly<{ pythonExecutable: string; swapAwayThenBack?: VaultRecordFsOperation }>
  | undefined;

/** Test-only deterministic race barrier. Production never installs this hook. */
export function __setVaultRecordFsBarrierForTests(
  barrier: ((operation: VaultRecordFsOperation, canonicalVaultDir: string) => void) | undefined
): void {
  vaultRecordFsBarrierForTests = barrier;
}

/** Test-only: use a real Python openat helper and optionally force a swap-back race inside it. */
export function __setVaultRecordNativeHelperForTests(
  helper: Readonly<{ pythonExecutable: string; swapAwayThenBack?: VaultRecordFsOperation }> | undefined
): void {
  vaultRecordNativeHelperForTests = helper;
}

type VaultNativeHelperResolution = Readonly<{
  required: boolean;
  pythonExecutable?: string;
  swapAwayThenBack?: VaultRecordFsOperation;
}>;

type VaultNativeHelperResult = Readonly<{
  ok: boolean;
  exists?: boolean;
  bytes_base64?: string;
  entries?: Array<{ name: string; bytes_base64: string }>;
  foreign_dir?: string;
  reason?: string;
}>;

const VAULT_NATIVE_HELPER_SOURCE = String.raw`
import base64, json, os, stat, sys, uuid

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))

def safe_record_stat(value, expected_uid):
    return stat.S_ISREG(value.st_mode) and value.st_uid == expected_uid and stat.S_IMODE(value.st_mode) == 0o600

def read_record(directory_fd, name, expected_uid):
    try:
        record_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    try:
        record_stat = os.fstat(record_fd)
        if not safe_record_stat(record_stat, expected_uid):
            raise RuntimeError("record_identity_unsafe")
        chunks = []
        while True:
            chunk = os.read(record_fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(record_fd)

def write_record(directory_fd, name, payload, expected_uid):
    try:
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not safe_record_stat(current, expected_uid):
            raise RuntimeError("record_identity_unsafe")
    except FileNotFoundError:
        pass
    temp_name = "." + name + "." + uuid.uuid4().hex + ".tmp"
    temp_fd = None
    try:
        temp_fd = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory_fd,
        )
        offset = 0
        while offset < len(payload):
            offset += os.write(temp_fd, payload[offset:])
        os.fchmod(temp_fd, 0o600)
        os.fsync(temp_fd)
        os.rename(temp_name, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        try:
            os.unlink(temp_name, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
    if read_record(directory_fd, name, expected_uid) != payload:
        raise RuntimeError("published_bytes_mismatch")

def delete_record(directory_fd, name, expected_uid):
    try:
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not safe_record_stat(current, expected_uid):
        raise RuntimeError("record_identity_unsafe")
    record_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    try:
        opened = os.fstat(record_fd)
        if opened.st_dev != current.st_dev or opened.st_ino != current.st_ino:
            raise RuntimeError("record_identity_changed")
    finally:
        os.close(record_fd)
    os.unlink(name, dir_fd=directory_fd)
    os.fsync(directory_fd)

request = json.loads(sys.stdin.buffer.read())
directory = request["directory"]
expected = request["directory_identity"]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
directory_fd = os.open(directory, flags)
foreign_dir = None
held_dir = None
try:
    directory_stat = os.fstat(directory_fd)
    if (
        not stat.S_ISDIR(directory_stat.st_mode)
        or directory_stat.st_dev != expected["dev"]
        or directory_stat.st_ino != expected["ino"]
        or directory_stat.st_uid != expected["uid"]
        or stat.S_IMODE(directory_stat.st_mode) != expected["mode"]
    ):
        raise RuntimeError("directory_identity_changed")

    name = request.get("file_name")
    operation = request["operation"]
    if request.get("swap_away_then_back"):
        suffix = uuid.uuid4().hex
        held_dir = directory + ".held-" + suffix
        foreign_dir = directory + ".foreign-" + suffix
        os.rename(directory, held_dir)
        os.mkdir(directory, 0o700)
        if name:
            foreign_payload = base64.b64decode(request.get("foreign_bytes_base64", "Zm9yZWlnbg=="))
            foreign_fd = os.open(os.path.join(directory, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(foreign_fd, foreign_payload)
            finally:
                os.close(foreign_fd)

    if operation in ("read", "snapshot"):
        payload = read_record(directory_fd, name, expected["uid"])
        result = {"ok": True, "exists": payload is not None}
        if payload is not None:
            result["bytes_base64"] = base64.b64encode(payload).decode("ascii")
    elif operation in ("write", "restore"):
        write_record(directory_fd, name, base64.b64decode(request["bytes_base64"]), expected["uid"])
        result = {"ok": True}
    elif operation == "delete":
        delete_record(directory_fd, name, expected["uid"])
        result = {"ok": True}
    elif operation == "list":
        entries = []
        for entry in os.listdir(directory_fd):
            if not entry.endswith(".enc"):
                continue
            payload = read_record(directory_fd, entry, expected["uid"])
            if payload is not None:
                entries.append({"name": entry, "bytes_base64": base64.b64encode(payload).decode("ascii")})
        result = {"ok": True, "entries": entries}
    else:
        raise RuntimeError("operation_invalid")
finally:
    if held_dir is not None:
        os.rename(directory, foreign_dir)
        os.rename(held_dir, directory)
    os.close(directory_fd)

if foreign_dir is not None:
    result["foreign_dir"] = foreign_dir
emit(result)
`;

function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function canonicalizeExistingOrMissingDirectory(candidate: string): string | undefined {
  const missing: string[] = [];
  let current = path.resolve(candidate);
  while (!lstatIfPresent(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    missing.unshift(path.basename(current));
    current = parent;
  }
  try {
    const canonicalExisting = fs.realpathSync.native(current);
    if (!fs.lstatSync(canonicalExisting).isDirectory()) return undefined;
    return path.join(canonicalExisting, ...missing);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalize the parent first so the intentional macOS/user-data alias may
 * live above the app-owned vault. The vault directory itself must always be a
 * real 0700 directory; symlinks at that boundary remain forbidden.
 */
function resolveCanonicalVaultDir(vaultDir: string, create: boolean): CanonicalVaultDirResult {
  const absolute = path.resolve(vaultDir);
  const parentInput = path.dirname(absolute);
  if (create) {
    try {
      fs.mkdirSync(parentInput, { mode: 0o700, recursive: true });
    } catch {
      return { ok: false, reason_code: 'VAULT_DIR_CREATE_FAILED' };
    }
  }
  const canonicalParent = canonicalizeExistingOrMissingDirectory(parentInput);
  if (!canonicalParent) return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  const dir = path.join(canonicalParent, path.basename(absolute));
  let stat = lstatIfPresent(dir);
  if (!stat && create) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      stat = fs.lstatSync(dir);
    } catch {
      return { ok: false, reason_code: 'VAULT_DIR_CREATE_FAILED' };
    }
  }
  if (!stat) return { ok: true, dir, exists: false };
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  }
  try {
    if (fs.realpathSync.native(dir) !== dir) return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  } catch {
    return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  }
  return { ok: true, dir, exists: true };
}

function resolveVaultRecordFile(vaultDir: string, connectorId: unknown, createParent: boolean): VaultRecordFileResult {
  const canonicalId = resolveCanonicalConnectorId(connectorId);
  if (!canonicalId.ok) return { ok: false, reason_code: 'VAULT_RECORD_CONNECTOR_ID_INVALID' };
  const parent = resolveCanonicalVaultDir(vaultDir, createParent);
  if ('reason_code' in parent) return { ok: false, reason_code: parent.reason_code };
  const fileName = `${canonicalId.connectorId}${RECORD_EXT}`;
  const file = path.join(parent.dir, fileName);
  if (path.dirname(file) !== parent.dir || path.relative(parent.dir, file) !== fileName) {
    return { ok: false, reason_code: 'VAULT_DIR_ANCESTRY_UNSAFE' };
  }
  return {
    ok: true,
    connectorId: canonicalId.connectorId,
    vaultDir: parent.dir,
    fileName,
    file,
    parentExists: parent.exists,
  };
}

function identityFromStats(stat: fs.Stats): VaultDirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
}

function resolveVaultNativeHelper(): VaultNativeHelperResolution {
  if (vaultRecordNativeHelperForTests) {
    return {
      required: true,
      pythonExecutable: vaultRecordNativeHelperForTests.pythonExecutable,
      swapAwayThenBack: vaultRecordNativeHelperForTests.swapAwayThenBack,
    };
  }
  const electronProcess = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
  const strictPackagedMac =
    process.platform === 'darwin' && Boolean(process.versions.electron) && electronProcess.defaultApp !== true;
  if (!strictPackagedMac) return { required: false };
  const resourcesPath = electronProcess.resourcesPath;
  if (!resourcesPath) return { required: true };
  const candidate = path.join(resourcesPath, 'python', 'bin', 'python3.12');
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) return { required: true };
    if (fs.realpathSync.native(candidate) !== candidate) return { required: true };
    return { required: true, pythonExecutable: candidate };
  } catch {
    return { required: true };
  }
}

function runVaultNativeHelper(
  operation: VaultRecordFsOperation,
  resolved: Extract<VaultRecordFileResult, { ok: true }> | undefined,
  vaultDir: string,
  data?: Buffer
): VaultNativeHelperResult | undefined {
  const helper = resolveVaultNativeHelper();
  if (!helper.required) return undefined;
  if (!helper.pythonExecutable) return { ok: false, reason: 'native_helper_unavailable' };
  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.lstatSync(vaultDir);
  } catch {
    return { ok: false, reason: 'directory_identity_unavailable' };
  }
  if (!vaultDirectoryStatsAreSafe(directoryStat)) return { ok: false, reason: 'directory_identity_unsafe' };
  const identity = identityFromStats(directoryStat);
  vaultRecordFsBarrierForTests?.(operation, vaultDir);
  const request = {
    operation,
    directory: vaultDir,
    directory_identity: identity,
    ...(resolved ? { file_name: resolved.fileName } : {}),
    ...(data ? { bytes_base64: data.toString('base64') } : {}),
    ...(helper.swapAwayThenBack === operation
      ? { swap_away_then_back: true, foreign_bytes_base64: Buffer.from('foreign-unchanged').toString('base64') }
      : {}),
  };
  const child = spawnSync(helper.pythonExecutable, ['-I', '-S', '-c', VAULT_NATIVE_HELPER_SOURCE], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  if (child.status !== 0 || child.error || !child.stdout) {
    return { ok: false, reason: child.error?.message ?? 'native_helper_failed' };
  }
  try {
    const parsed = JSON.parse(child.stdout) as VaultNativeHelperResult;
    return parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean'
      ? parsed
      : { ok: false, reason: 'native_helper_result_invalid' };
  } catch {
    return { ok: false, reason: 'native_helper_result_invalid' };
  }
}

function identitiesMatch(left: VaultDirectoryIdentity, right: VaultDirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

function vaultDirectoryStatsAreSafe(stat: fs.Stats): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (process.platform === 'win32') return true;
  const expectedUid = process.getuid?.();
  return (expectedUid === undefined || stat.uid === expectedUid) && (stat.mode & 0o777) === 0o700;
}

function openVaultDirectoryAnchor(canonicalVaultDir: string): VaultDirectoryAnchorResult {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(canonicalVaultDir);
    if (!vaultDirectoryStatsAreSafe(before)) return { ok: false, reason_code: 'VAULT_DIR_IDENTITY_UNSAFE' };
    if (process.platform !== 'win32') {
      fd = fs.openSync(canonicalVaultDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (
        !vaultDirectoryStatsAreSafe(opened) ||
        !identitiesMatch(identityFromStats(before), identityFromStats(opened))
      ) {
        fs.closeSync(fd);
        return { ok: false, reason_code: 'VAULT_DIR_IDENTITY_UNSAFE' };
      }
    }
    return { ok: true, anchor: { dir: canonicalVaultDir, fd, identity: identityFromStats(before) } };
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original open failure remains authoritative.
      }
    }
    return { ok: false, reason_code: 'VAULT_DIR_IDENTITY_UNSAFE' };
  }
}

function closeVaultDirectoryAnchor(anchor: VaultDirectoryAnchor): void {
  if (anchor.fd === undefined) return;
  fs.closeSync(anchor.fd);
}

function vaultDirectoryAnchorIsCurrent(anchor: VaultDirectoryAnchor): boolean {
  try {
    const current = fs.lstatSync(anchor.dir);
    if (!vaultDirectoryStatsAreSafe(current)) return false;
    if (!identitiesMatch(anchor.identity, identityFromStats(current))) return false;
    if (fs.realpathSync.native(anchor.dir) !== anchor.dir) return false;
    if (anchor.fd !== undefined) {
      const held = fs.fstatSync(anchor.fd);
      if (!vaultDirectoryStatsAreSafe(held) || !identitiesMatch(anchor.identity, identityFromStats(held))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertVaultDirectoryAnchorCurrent(anchor: VaultDirectoryAnchor): void {
  if (!vaultDirectoryAnchorIsCurrent(anchor)) throw new Error('VAULT_DIR_IDENTITY_UNSAFE');
}

function crossVaultRecordFsBarrier(operation: VaultRecordFsOperation, anchor: VaultDirectoryAnchor): void {
  vaultRecordFsBarrierForTests?.(operation, anchor.dir);
  assertVaultDirectoryAnchorCurrent(anchor);
}

function recordPathAtAnchor(anchor: VaultDirectoryAnchor, fileName: string): string {
  const file = path.join(anchor.dir, fileName);
  if (path.dirname(file) !== anchor.dir || path.relative(anchor.dir, file) !== fileName) {
    throw new Error('VAULT_DIR_ANCESTRY_UNSAFE');
  }
  return file;
}

function readAnchoredRecordBytes(anchor: VaultDirectoryAnchor, fileName: string): Buffer | undefined {
  assertVaultDirectoryAnchorCurrent(anchor);
  const file = recordPathAtAnchor(anchor, fileName);
  let fd: number | undefined;
  try {
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const opened = fs.fstatSync(fd);
    const visible = fs.lstatSync(file);
    if (
      !opened.isFile() ||
      visible.isSymbolicLink() ||
      !visible.isFile() ||
      opened.dev !== visible.dev ||
      opened.ino !== visible.ino
    ) {
      throw new Error('VAULT_RECORD_NOT_REGULAR');
    }
    assertVaultDirectoryAnchorCurrent(anchor);
    const bytes = fs.readFileSync(fd);
    assertVaultDirectoryAnchorCurrent(anchor);
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeAnchoredRecordBytes(anchor: VaultDirectoryAnchor, fileName: string, data: Buffer): void {
  assertVaultDirectoryAnchorCurrent(anchor);
  const file = recordPathAtAnchor(anchor, fileName);
  const existing = fs.lstatSync(file, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('VAULT_RECORD_NOT_REGULAR');
  const tempName = `.${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tempFile = recordPathAtAnchor(anchor, tempName);
  let tempFd: number | undefined;
  try {
    tempFd = fs.openSync(
      tempFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    const tempStat = fs.fstatSync(tempFd);
    if (!tempStat.isFile() || tempStat.dev !== anchor.identity.dev) throw new Error('VAULT_RECORD_WRITE_FAILED');
    fs.fchmodSync(tempFd, 0o600);
    fs.writeFileSync(tempFd, data);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    assertVaultDirectoryAnchorCurrent(anchor);
    const beforePublish = fs.lstatSync(file, { throwIfNoEntry: false });
    if (beforePublish && (!beforePublish.isFile() || beforePublish.isSymbolicLink())) {
      throw new Error('VAULT_RECORD_NOT_REGULAR');
    }
    fs.renameSync(tempFile, file);
    if (anchor.fd !== undefined) fs.fsyncSync(anchor.fd);
    assertVaultDirectoryAnchorCurrent(anchor);
    const published = readAnchoredRecordBytes(anchor, fileName);
    const publishedStat = fs.lstatSync(file);
    if (!published?.equals(data) || (process.platform !== 'win32' && (publishedStat.mode & 0o777) !== 0o600)) {
      throw new Error('VAULT_RECORD_WRITE_FAILED');
    }
  } finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    // Never resolve a cleanup path through a swapped parent. A stranded temp in
    // the held original directory is safer than deleting an identically named
    // file from an attacker-substituted directory.
    if (vaultDirectoryAnchorIsCurrent(anchor)) {
      const tempStat = fs.lstatSync(tempFile, { throwIfNoEntry: false });
      if (tempStat?.isFile() && !tempStat.isSymbolicLink()) fs.unlinkSync(tempFile);
    }
  }
}

function deleteAnchoredRecord(anchor: VaultDirectoryAnchor, fileName: string): boolean {
  assertVaultDirectoryAnchorCurrent(anchor);
  const file = recordPathAtAnchor(anchor, fileName);
  const visible = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!visible) return true;
  if (!visible.isFile() || visible.isSymbolicLink()) return false;

  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== visible.dev || opened.ino !== visible.ino) return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  assertVaultDirectoryAnchorCurrent(anchor);
  const immediatelyBeforeDelete = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    !immediatelyBeforeDelete ||
    !immediatelyBeforeDelete.isFile() ||
    immediatelyBeforeDelete.isSymbolicLink() ||
    immediatelyBeforeDelete.dev !== visible.dev ||
    immediatelyBeforeDelete.ino !== visible.ino
  ) {
    return false;
  }
  fs.unlinkSync(file);
  assertVaultDirectoryAnchorCurrent(anchor);
  return fs.lstatSync(file, { throwIfNoEntry: false }) === undefined;
}

function endpointIsUnsafeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  return error.message === 'VAULT_RECORD_NOT_REGULAR' || code === 'ELOOP' || code === 'EMLINK';
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
  if ('reason_code' in resolved) throw new Error(resolved.reason_code);
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
  if ('reason_code' in resolved) return resolved;
  if (!resolved.parentExists) return { ok: true, snapshot: { exists: false } };
  const native = runVaultNativeHelper('snapshot', resolved, resolved.vaultDir);
  if (native) {
    if (!native.ok) return { ok: false, reason_code: 'VAULT_RECORD_SNAPSHOT_READ_FAILED' };
    if (!native.exists) return { ok: true, snapshot: { exists: false } };
    if (typeof native.bytes_base64 !== 'string') {
      return { ok: false, reason_code: 'VAULT_RECORD_SNAPSHOT_READ_FAILED' };
    }
    return { ok: true, snapshot: { exists: true, bytes: Buffer.from(native.bytes_base64, 'base64') } };
  }
  const opened = openVaultDirectoryAnchor(resolved.vaultDir);
  if ('reason_code' in opened) return opened;
  try {
    crossVaultRecordFsBarrier('snapshot', opened.anchor);
    const bytes = readAnchoredRecordBytes(opened.anchor, resolved.fileName);
    return bytes ? { ok: true, snapshot: { exists: true, bytes } } : { ok: true, snapshot: { exists: false } };
  } catch (error) {
    if (endpointIsUnsafeError(error)) return { ok: false, reason_code: 'VAULT_RECORD_SNAPSHOT_NOT_REGULAR' };
    return { ok: false, reason_code: 'VAULT_RECORD_SNAPSHOT_READ_FAILED' };
  } finally {
    closeVaultDirectoryAnchor(opened.anchor);
  }
}

export function restoreVaultRecordFileSnapshot(
  vaultDir: string,
  connectorId: string,
  snapshot: VaultRecordFileSnapshot
): boolean {
  const resolved = resolveVaultRecordFile(vaultDir, connectorId, snapshot.exists);
  if ('reason_code' in resolved) return false;
  if (!resolved.parentExists) return !snapshot.exists;
  const native = runVaultNativeHelper(
    snapshot.exists ? 'restore' : 'delete',
    resolved,
    resolved.vaultDir,
    snapshot.exists ? snapshot.bytes : undefined
  );
  if (native) return native.ok;
  const opened = openVaultDirectoryAnchor(resolved.vaultDir);
  if ('reason_code' in opened) return false;
  try {
    crossVaultRecordFsBarrier('restore', opened.anchor);
    if (!snapshot.exists) return deleteAnchoredRecord(opened.anchor, resolved.fileName);
    writeAnchoredRecordBytes(opened.anchor, resolved.fileName, snapshot.bytes);
    return true;
  } catch {
    return false;
  } finally {
    closeVaultDirectoryAnchor(opened.anchor);
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
  if ('reason_code' in resolved) return { ok: false, reason_code: resolved.reason_code };
  const bytes = Buffer.from(`${JSON.stringify(validated.record, null, 2)}\n`, 'utf8');
  const native = runVaultNativeHelper('write', resolved, resolved.vaultDir, bytes);
  if (native) {
    return native.ok ? { ok: true, path: resolved.file } : { ok: false, reason_code: 'VAULT_RECORD_WRITE_FAILED' };
  }
  const opened = openVaultDirectoryAnchor(resolved.vaultDir);
  if ('reason_code' in opened) return { ok: false, reason_code: opened.reason_code };
  try {
    crossVaultRecordFsBarrier('write', opened.anchor);
    writeAnchoredRecordBytes(opened.anchor, resolved.fileName, bytes);
  } catch {
    return { ok: false, reason_code: 'VAULT_RECORD_WRITE_FAILED' };
  } finally {
    closeVaultDirectoryAnchor(opened.anchor);
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
  if ('reason_code' in resolved || !resolved.parentExists) return null;
  const native = runVaultNativeHelper('read', resolved, resolved.vaultDir);
  if (native) {
    if (!native.ok || !native.exists || typeof native.bytes_base64 !== 'string') return null;
    try {
      const validated = validateVaultRecord(JSON.parse(Buffer.from(native.bytes_base64, 'base64').toString('utf8')));
      return validated.ok && validated.record?.connector_id === resolved.connectorId ? validated.record : null;
    } catch {
      return null;
    }
  }
  const opened = openVaultDirectoryAnchor(resolved.vaultDir);
  if ('reason_code' in opened) return null;
  try {
    crossVaultRecordFsBarrier('read', opened.anchor);
    const bytes = readAnchoredRecordBytes(opened.anchor, resolved.fileName);
    if (!bytes) return null;
    const validated = validateVaultRecord(JSON.parse(bytes.toString('utf8')) as unknown);
    return validated.ok && validated.record && validated.record.connector_id === resolved.connectorId
      ? validated.record
      : null;
  } catch {
    return null;
  } finally {
    closeVaultDirectoryAnchor(opened.anchor);
  }
}

/**
 * List every VALID record in a vault dir. Non-`.enc` files are skipped; a file
 * that fails validation (wrong version / non-ref env value / bad shape) is
 * silently dropped (fail-closed — a tampered file never surfaces as a record).
 * A non-existent dir yields `[]`. Never throws.
 */
export function listVaultRecords(vaultDir: string): VaultConnectorRecord[] {
  const parent = resolveCanonicalVaultDir(vaultDir, false);
  if ('reason_code' in parent || !parent.exists) return [];
  const native = runVaultNativeHelper('list', undefined, parent.dir);
  if (native) {
    if (!native.ok || !Array.isArray(native.entries)) return [];
    const out: VaultConnectorRecord[] = [];
    for (const entry of native.entries) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.bytes_base64 !== 'string') continue;
      const connectorId = entry.name.endsWith(RECORD_EXT) ? entry.name.slice(0, -RECORD_EXT.length) : '';
      const canonicalId = resolveCanonicalConnectorId(connectorId);
      if (!canonicalId.ok || `${canonicalId.connectorId}${RECORD_EXT}` !== entry.name) continue;
      try {
        const validated = validateVaultRecord(JSON.parse(Buffer.from(entry.bytes_base64, 'base64').toString('utf8')));
        if (validated.ok && validated.record?.connector_id === canonicalId.connectorId) out.push(validated.record);
      } catch {
        // Invalid/tampered entries are intentionally omitted.
      }
    }
    return out;
  }
  const opened = openVaultDirectoryAnchor(parent.dir);
  if ('reason_code' in opened) return [];
  try {
    crossVaultRecordFsBarrier('list', opened.anchor);
    const entries = fs.readdirSync(parent.dir);
    assertVaultDirectoryAnchorCurrent(opened.anchor);
    const out: VaultConnectorRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(RECORD_EXT)) continue;
      const connectorId = entry.slice(0, -RECORD_EXT.length);
      const canonicalId = resolveCanonicalConnectorId(connectorId);
      if (!canonicalId.ok) continue;
      try {
        const bytes = readAnchoredRecordBytes(opened.anchor, `${canonicalId.connectorId}${RECORD_EXT}`);
        if (!bytes) continue;
        const validated = validateVaultRecord(JSON.parse(bytes.toString('utf8')) as unknown);
        if (validated.ok && validated.record?.connector_id === canonicalId.connectorId) out.push(validated.record);
      } catch {
        // Invalid/tampered entries are intentionally omitted.
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    closeVaultDirectoryAnchor(opened.anchor);
  }
}

/** Delete a connector's record (revoke). Idempotent; never throws. */
export function deleteVaultRecord(vaultDir: string, connectorId: string): boolean {
  const resolved = resolveVaultRecordFile(vaultDir, connectorId, false);
  if ('reason_code' in resolved) return false;
  if (!resolved.parentExists) return true;
  const native = runVaultNativeHelper('delete', resolved, resolved.vaultDir);
  if (native) return native.ok;
  const opened = openVaultDirectoryAnchor(resolved.vaultDir);
  if ('reason_code' in opened) return false;
  try {
    crossVaultRecordFsBarrier('delete', opened.anchor);
    return deleteAnchoredRecord(opened.anchor, resolved.fileName);
  } catch {
    // ignore — delete must never throw
    return false;
  } finally {
    closeVaultDirectoryAnchor(opened.anchor);
  }
}
