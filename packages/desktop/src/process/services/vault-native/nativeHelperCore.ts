import { spawn, spawnSync } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMMAND_EVE_PYTHON_SIGNING_AUTHORITY,
  COMMAND_EVE_PYTHON_SIGNING_IDENTIFIER,
  COMMAND_EVE_PYTHON_SIGNING_TEAM,
  resolveCommandEvePackagedArtifactPythonSite,
  type CommandEvePythonCodeSignature,
} from '@/process/commandEve/presentationPythonRuntimeCore';
import type { VaultNativeOperation, VaultNativeRequest, VaultNativeResult, VaultNativeTestHelper } from './types';

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_RECORD_BYTES * 2;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HELPER_TIMEOUT_MS = 5_000;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;

let testHelper: VaultNativeTestHelper | undefined;

export function __setVaultNativeHelperForTests(helper: VaultNativeTestHelper | undefined): void {
  testHelper = helper;
}

type HelperResolution = Readonly<{
  required: boolean;
  pythonExecutable?: string;
  pythonHome?: string;
  appPath?: string;
  expected?: Readonly<{
    mode: number;
    size: number;
    sha256: string;
    codeSignature?: CommandEvePythonCodeSignature;
  }>;
  test?: VaultNativeTestHelper;
}>;

type PreparedInterpreter = Readonly<{
  executable: string;
  assertCurrent: (recheckRuntimeAuthority?: boolean) => boolean;
  cleanup: () => void;
}>;

const HELPER_SOURCE = String.raw`
import base64, hashlib, json, os, stat, sys, time, uuid

MAX_REQUEST_BYTES = ${MAX_REQUEST_BYTES}
MAX_RECORD_BYTES = ${MAX_RECORD_BYTES}
MAX_LIST_ENTRIES = 512
MAX_LIST_BYTES = 8 * 1024 * 1024
JOURNAL_VERSION = "command-eve-vault-transaction/v1"
JOURNAL_SUFFIX = ".command-eve-transaction.json"

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")))

def safe_record_stat(value, expected_uid):
    return stat.S_ISREG(value.st_mode) and value.st_uid == expected_uid and stat.S_IMODE(value.st_mode) == 0o600

def read_record(directory_fd, name, expected_uid, limit=MAX_RECORD_BYTES):
    try:
        record_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    try:
        record_stat = os.fstat(record_fd)
        if not safe_record_stat(record_stat, expected_uid):
            raise RuntimeError("record_identity_unsafe")
        chunks = []
        total = 0
        while True:
            chunk = os.read(record_fd, min(65536, limit + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise RuntimeError("record_size_exceeded")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(record_fd)

def write_atomic(directory_fd, name, payload, expected_uid):
    if len(payload) > MAX_RECORD_BYTES:
        raise RuntimeError("record_size_exceeded")
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

def write_record(directory_fd, name, payload, expected_uid):
    try:
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if not safe_record_stat(current, expected_uid):
            raise RuntimeError("record_identity_unsafe")
    except FileNotFoundError:
        pass
    write_atomic(directory_fd, name, payload, expected_uid)
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

def digest(payload):
    return None if payload is None else hashlib.sha256(payload).hexdigest()

def state_matches(payload, exists, expected_digest):
    return (payload is not None) == exists and (not exists or digest(payload) == expected_digest)

def journal_name(name):
    return "." + name + JOURNAL_SUFFIX

def read_journal(directory_fd, name, expected_uid):
    payload = read_record(directory_fd, journal_name(name), expected_uid)
    if payload is None:
        return None
    try:
        value = json.loads(payload)
    except Exception as error:
        raise RuntimeError("transaction_journal_invalid") from error
    if (
        value.get("version") != JOURNAL_VERSION
        or value.get("file_name") != name
        or not isinstance(value.get("transaction_id"), str)
    ):
        raise RuntimeError("transaction_journal_invalid")
    return value

def write_journal(directory_fd, name, value, expected_uid):
    payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    write_atomic(directory_fd, journal_name(name), payload, expected_uid)

def remove_journal(directory_fd, name):
    try:
        os.unlink(journal_name(name), dir_fd=directory_fd)
        os.fsync(directory_fd)
    except FileNotFoundError:
        pass

def classify_journal(directory_fd, name, expected_uid, transaction_id=None, cleanup=False):
    journal = read_journal(directory_fd, name, expected_uid)
    current = read_record(directory_fd, name, expected_uid)
    if journal is None:
        return None
    if transaction_id is not None and journal["transaction_id"] != transaction_id:
        return "ambiguous"
    if state_matches(current, bool(journal.get("intended_exists")), journal.get("intended_sha256")):
        state = "committed"
    elif state_matches(current, bool(journal.get("prior_exists")), journal.get("prior_sha256")):
        state = "not_committed"
    else:
        state = "ambiguous"
    if cleanup and state != "ambiguous":
        remove_journal(directory_fd, name)
    return state

def require_no_journal(directory_fd, name, expected_uid):
    if read_journal(directory_fd, name, expected_uid) is not None:
        raise RuntimeError("mutation_recovery_required")

request_bytes = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
if len(request_bytes) > MAX_REQUEST_BYTES:
    raise RuntimeError("request_size_exceeded")
request = json.loads(request_bytes)
directory = request["directory"]
expected = request["directory_identity"]
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
directory_fd = os.open(directory, flags)
foreign_dir = None
held_dir = None
result = None
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
            foreign_payload = base64.b64decode(request.get("foreign_bytes_base64", "Zm9yZWlnbg=="), validate=True)
            foreign_fd = os.open(os.path.join(directory, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(foreign_fd, foreign_payload)
            finally:
                os.close(foreign_fd)

    if operation == "recover":
        transaction_id = request["transaction_id"]
        state = classify_journal(directory_fd, name, expected["uid"], transaction_id, cleanup=True)
        if state is None:
            # Only the exact transaction journal proves that this transaction
            # crossed the publication point. Identical pre-existing bytes are
            # not authority to retroactively claim a commit.
            state = "not_committed"
        result = {"ok": state == "committed", "mutation_state": state, "transaction_id": transaction_id}
    elif operation in ("read", "snapshot"):
        require_no_journal(directory_fd, name, expected["uid"])
        payload = read_record(directory_fd, name, expected["uid"])
        result = {"ok": True, "exists": payload is not None}
        if payload is not None:
            result["bytes_base64"] = base64.b64encode(payload).decode("ascii")
    elif operation in ("write", "restore", "delete"):
        transaction_id = request["transaction_id"]
        require_no_journal(directory_fd, name, expected["uid"])
        prior = read_record(directory_fd, name, expected["uid"])
        intended = None if operation == "delete" else base64.b64decode(request["bytes_base64"], validate=True)
        if intended is not None and len(intended) > MAX_RECORD_BYTES:
            raise RuntimeError("record_size_exceeded")
        journal = {
            "version": JOURNAL_VERSION,
            "transaction_id": transaction_id,
            "file_name": name,
            "operation": operation,
            "prior_exists": prior is not None,
            "prior_sha256": digest(prior),
            "intended_exists": intended is not None,
            "intended_sha256": digest(intended),
            "phase": "prepared",
        }
        write_journal(directory_fd, name, journal, expected["uid"])
        if intended is None:
            delete_record(directory_fd, name, expected["uid"])
        else:
            write_record(directory_fd, name, intended, expected["uid"])
        journal["phase"] = "committed"
        write_journal(directory_fd, name, journal, expected["uid"])
        if request.get("corrupt_record_after_commit"):
            write_record(directory_fd, name, b"ambiguous-external-state", expected["uid"])
        if request.get("exit_after_commit_before_stdout"):
            os._exit(91)
        sleep_ms = int(request.get("sleep_after_commit_ms") or 0)
        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000)
        result = {"ok": True, "mutation_state": "committed", "transaction_id": transaction_id}
    elif operation == "list":
        entries = []
        total = 0
        directory_entries = sorted(os.listdir(directory_fd))
        if any(entry.startswith(".") and entry.endswith(JOURNAL_SUFFIX) for entry in directory_entries):
            raise RuntimeError("mutation_recovery_required")
        for entry in directory_entries:
            if not entry.endswith(".enc"):
                continue
            if len(entries) >= MAX_LIST_ENTRIES:
                raise RuntimeError("list_entry_limit_exceeded")
            payload = read_record(directory_fd, entry, expected["uid"])
            if payload is not None:
                total += len(payload)
                if total > MAX_LIST_BYTES:
                    raise RuntimeError("list_size_exceeded")
                entries.append({"name": entry, "bytes_base64": base64.b64encode(payload).decode("ascii")})
        result = {"ok": True, "entries": entries}
    else:
        raise RuntimeError("operation_invalid")
finally:
    if held_dir is not None:
        try:
            os.rename(directory, foreign_dir)
            os.rename(held_dir, directory)
        except Exception:
            # Test-only swap hook: never claim success if the canonical name
            # cannot be restored to the still-open original directory.
            result = {"ok": False, "reason": "swap_restore_failed"}
    os.close(directory_fd)

if foreign_dir is not None and result is not None:
    result["foreign_dir"] = foreign_dir
if request.get("corrupt_stdout_after_commit"):
    sys.stdout.write("{invalid")
else:
    emit(result)
`;

function strictPackagedMac(): boolean {
  const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };
  return process.platform === 'darwin' && Boolean(process.versions.electron) && electronProcess.defaultApp !== true;
}

function readVerifiedCodeSignature(filePath: string): CommandEvePythonCodeSignature | undefined {
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=4', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (verified.error || verified.status !== 0) return undefined;
  const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (inspected.error || inspected.status !== 0) return undefined;
  const details = `${inspected.stderr || ''}\n${inspected.stdout || ''}`;
  const value = (name: string): string => {
    const line = details.split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : '';
  };
  const signature = {
    authority: value('Authority'),
    teamId: value('TeamIdentifier'),
    identifier: value('Identifier'),
    cdhash: value('CDHash').toLowerCase(),
    hardenedRuntime: /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/i.test(details),
  };
  return signature.authority === COMMAND_EVE_PYTHON_SIGNING_AUTHORITY &&
    signature.teamId === COMMAND_EVE_PYTHON_SIGNING_TEAM &&
    signature.identifier === COMMAND_EVE_PYTHON_SIGNING_IDENTIFIER &&
    /^[a-f0-9]{40}$/.test(signature.cdhash) &&
    signature.hardenedRuntime
    ? ({ ...signature, hardenedRuntime: true } as CommandEvePythonCodeSignature)
    : undefined;
}

function verifyPackagedAppSeal(appPath: string): boolean {
  try {
    const identity = fs.lstatSync(appPath);
    if (!identity.isDirectory() || identity.isSymbolicLink() || !appPath.endsWith('.app')) return false;
    const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (verified.error || verified.status !== 0) return false;
    const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (inspected.error || inspected.status !== 0) return false;
    const details = `${inspected.stderr || ''}\n${inspected.stdout || ''}`;
    return (
      details.split(/\r?\n/).some((line) => line.trim() === `Authority=${COMMAND_EVE_PYTHON_SIGNING_AUTHORITY}`) &&
      details.split(/\r?\n/).some((line) => line.trim() === `TeamIdentifier=${COMMAND_EVE_PYTHON_SIGNING_TEAM}`)
    );
  } catch {
    return false;
  }
}

function runtimeAuthorityIsCurrent(resolution: HelperResolution, interpreterPath: string): boolean {
  if (resolution.appPath) {
    const verifySeal = resolution.test?.verifyAppSeal ?? verifyPackagedAppSeal;
    if (!verifySeal(resolution.appPath)) return false;
  }
  if (resolution.expected?.codeSignature) {
    const readSignature = resolution.test?.readCodeSignature ?? readVerifiedCodeSignature;
    if (!codeSignaturesEqual(readSignature(interpreterPath), resolution.expected.codeSignature)) return false;
  }
  return true;
}

function interpreterSignatureIsCurrent(resolution: HelperResolution, interpreterPath: string): boolean {
  if (!resolution.expected?.codeSignature) return true;
  const readSignature = resolution.test?.readCodeSignature ?? readVerifiedCodeSignature;
  return codeSignaturesEqual(readSignature(interpreterPath), resolution.expected.codeSignature);
}

function codeSignaturesEqual(
  left: CommandEvePythonCodeSignature | undefined,
  right: CommandEvePythonCodeSignature | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.authority === right.authority &&
    left.teamId === right.teamId &&
    left.identifier === right.identifier &&
    left.cdhash === right.cdhash &&
    left.hardenedRuntime === true &&
    right.hardenedRuntime === true
  );
}

function resolveHelper(): HelperResolution {
  if (strictPackagedMac()) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const site = resolveCommandEvePackagedArtifactPythonSite(resourcesPath);
    if (!site.ok || !site.packagedInterpreter || !site.resourcesRoot) return { required: true };
    const expectedPath = path.join(site.resourcesRoot, 'python', 'bin', 'python3.12');
    if (site.packagedInterpreter.path !== expectedPath) return { required: true };
    return {
      required: true,
      pythonExecutable: expectedPath,
      pythonHome: path.join(site.resourcesRoot, 'python'),
      appPath: path.dirname(path.dirname(site.resourcesRoot)),
      expected: {
        mode: site.packagedInterpreter.mode,
        size: site.packagedInterpreter.size,
        sha256: site.packagedInterpreter.sha256,
        codeSignature: site.packagedInterpreter.codeSignature,
      },
    };
  }
  if (testHelper) {
    return {
      required: true,
      pythonExecutable: testHelper.pythonExecutable,
      pythonHome: path.dirname(path.dirname(testHelper.pythonExecutable)),
      ...(testHelper.appPath ? { appPath: testHelper.appPath } : {}),
      ...(testHelper.expectedInterpreter ? { expected: testHelper.expectedInterpreter } : {}),
      test: testHelper,
    };
  }
  return { required: false };
}

export function vaultNativeHelperIsRequired(): boolean {
  return resolveHelper().required;
}

function sha256Descriptor(descriptor: number): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function copyDescriptor(source: number, destination: number, expectedSize: number): void {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedSize) {
    const bytesRead = fs.readSync(source, buffer, 0, Math.min(buffer.length, expectedSize - position), position);
    if (bytesRead <= 0) throw new Error('native_helper_source_truncated');
    let written = 0;
    while (written < bytesRead) {
      const bytesWritten = fs.writeSync(destination, buffer, written, bytesRead - written, position + written);
      if (bytesWritten <= 0) throw new Error('native_helper_private_copy_incomplete');
      written += bytesWritten;
    }
    position += bytesRead;
  }
}

function prepareInterpreter(resolution: HelperResolution): PreparedInterpreter | undefined {
  const candidate = resolution.pythonExecutable;
  if (!candidate) return undefined;
  let sourceDescriptor: number | undefined;
  let privateWriteDescriptor: number | undefined;
  let privateDescriptor: number | undefined;
  let temporaryDirectory = '';
  let executable = '';
  let prepared = false;
  try {
    if (resolution.appPath && !runtimeAuthorityIsCurrent(resolution, candidate)) return undefined;
    const visibleBefore = fs.lstatSync(candidate);
    if (!visibleBefore.isFile() || visibleBefore.isSymbolicLink() || (visibleBefore.mode & 0o111) === 0)
      return undefined;
    if (fs.realpathSync.native(candidate) !== candidate) return undefined;
    sourceDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(sourceDescriptor);
    if (
      !opened.isFile() ||
      opened.dev !== visibleBefore.dev ||
      opened.ino !== visibleBefore.ino ||
      opened.size !== visibleBefore.size
    ) {
      return undefined;
    }
    const sha256 = sha256Descriptor(sourceDescriptor);
    if (
      resolution.expected &&
      (opened.size !== resolution.expected.size ||
        (opened.mode & 0o777) !== resolution.expected.mode ||
        sha256 !== resolution.expected.sha256)
    ) {
      return undefined;
    }

    resolution.test?.beforeInterpreterLink?.();
    const visibleAfterAdmission = fs.lstatSync(candidate);
    if (
      !visibleAfterAdmission.isFile() ||
      visibleAfterAdmission.isSymbolicLink() ||
      visibleAfterAdmission.dev !== opened.dev ||
      visibleAfterAdmission.ino !== opened.ino ||
      visibleAfterAdmission.size !== opened.size ||
      (visibleAfterAdmission.mode & 0o777) !== (opened.mode & 0o777)
    ) {
      return undefined;
    }
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-vault-python-'));
    fs.chmodSync(temporaryDirectory, 0o700);
    const temporaryStat = fs.lstatSync(temporaryDirectory);
    if (
      !temporaryStat.isDirectory() ||
      temporaryStat.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((process.getuid?.() !== undefined && temporaryStat.uid !== process.getuid?.()) ||
          (temporaryStat.mode & 0o777) !== 0o700))
    ) {
      return undefined;
    }
    executable = path.join(temporaryDirectory, 'python3.12');
    privateWriteDescriptor = fs.openSync(
      executable,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o700
    );
    copyDescriptor(sourceDescriptor, privateWriteDescriptor, opened.size);
    fs.fchmodSync(privateWriteDescriptor, 0o500);
    fs.fsyncSync(privateWriteDescriptor);
    fs.closeSync(privateWriteDescriptor);
    privateWriteDescriptor = undefined;
    privateDescriptor = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const privateOpened = fs.fstatSync(privateDescriptor);
    const linked = fs.lstatSync(executable);
    if (
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      !privateOpened.isFile() ||
      linked.dev !== privateOpened.dev ||
      linked.ino !== privateOpened.ino ||
      linked.size !== opened.size ||
      privateOpened.size !== opened.size ||
      (linked.mode & 0o777) !== 0o500 ||
      (privateOpened.mode & 0o777) !== 0o500 ||
      sha256Descriptor(privateDescriptor) !== sha256
    ) {
      return undefined;
    }
    // macOS rejects executing an inherited /dev/fd descriptor (EACCES), so
    // detach from the mutable Resources inode with a byte copy instead. The
    // random owner-only directory and 0500 file are re-proven against the held
    // private descriptor immediately before spawn.
    fs.chmodSync(temporaryDirectory, 0o500);
    const assertCurrent = (recheckRuntimeAuthority = true): boolean => {
      try {
        if (privateDescriptor === undefined) return false;
        const directory = fs.lstatSync(temporaryDirectory);
        const visible = fs.lstatSync(executable);
        const held = fs.fstatSync(privateDescriptor);
        return (
          directory.isDirectory() &&
          !directory.isSymbolicLink() &&
          (directory.mode & 0o777) === 0o500 &&
          (process.platform === 'win32' || process.getuid?.() === undefined || directory.uid === process.getuid?.()) &&
          visible.isFile() &&
          !visible.isSymbolicLink() &&
          held.isFile() &&
          visible.dev === held.dev &&
          visible.ino === held.ino &&
          visible.size === opened.size &&
          held.size === opened.size &&
          (visible.mode & 0o777) === 0o500 &&
          (held.mode & 0o777) === 0o500 &&
          sha256Descriptor(privateDescriptor) === sha256 &&
          (!recheckRuntimeAuthority || runtimeAuthorityIsCurrent(resolution, executable))
        );
      } catch {
        return false;
      }
    };
    if (!assertCurrent(false) || !interpreterSignatureIsCurrent(resolution, executable)) return undefined;
    prepared = true;
    return {
      executable,
      assertCurrent,
      cleanup: () => {
        try {
          if (privateDescriptor !== undefined) {
            fs.closeSync(privateDescriptor);
            privateDescriptor = undefined;
          }
          fs.chmodSync(temporaryDirectory, 0o700);
          if (fs.existsSync(executable)) {
            fs.chmodSync(executable, 0o700);
            fs.unlinkSync(executable);
          }
        } finally {
          fs.rmdirSync(temporaryDirectory);
        }
      },
    };
  } catch {
    return undefined;
  } finally {
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    if (privateWriteDescriptor !== undefined) fs.closeSync(privateWriteDescriptor);
    if (!prepared && temporaryDirectory) {
      try {
        if (privateDescriptor !== undefined) fs.closeSync(privateDescriptor);
        fs.chmodSync(temporaryDirectory, 0o700);
        if (executable && fs.existsSync(executable)) {
          fs.chmodSync(executable, 0o700);
          fs.unlinkSync(executable);
        }
        fs.rmdirSync(temporaryDirectory);
      } catch {
        // A failed identity handoff remains authoritative.
      }
    }
  }
}

type VerifiedPythonResult = Readonly<{ ok: true; stdout: string } | { ok: false; reason: string }>;

export type VerifiedCommandEveObservationPythonSession = Readonly<{
  run: (
    source: string,
    input: string,
    options?: Readonly<{ timeoutMs?: number; maxBuffer?: number }>
  ) => Promise<VerifiedPythonResult>;
  close: () => void;
}>;

function verifiedPythonFailureReason(
  child: Readonly<{ status?: number | null; signal?: NodeJS.Signals | null }>
): string {
  if (child.signal) return `native_helper_signal_${child.signal}`;
  return `native_helper_exit_${String(child.status ?? 'unknown')}`;
}

function runPreparedPythonAsync(
  prepared: PreparedInterpreter,
  resolution: HelperResolution,
  source: string,
  input: string,
  options: Readonly<{ timeoutMs: number; maxBuffer: number }>
): Promise<VerifiedPythonResult> {
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
    return Promise.resolve({ ok: false, reason: 'native_helper_request_too_large' });
  }
  if (!prepared.assertCurrent(false)) {
    return Promise.resolve({ ok: false, reason: 'native_helper_identity_unproven' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stdoutBytes = 0;
    let child: ReturnType<typeof spawn>;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: VerifiedPythonResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(prepared.executable, ['-B', '-s', '-S', '-c', source], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          PATH: '/usr/bin:/bin',
          ...(resolution.pythonHome ? { PYTHONHOME: resolution.pythonHome } : {}),
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
      });
    } catch {
      return finish({ ok: false, reason: 'native_helper_spawn_failed' });
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'native_helper_timeout' });
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > options.maxBuffer) {
        child.kill('SIGKILL');
        finish({ ok: false, reason: 'native_helper_output_too_large' });
        return;
      }
      stdout += chunk;
    });
    child.once('error', () => finish({ ok: false, reason: 'native_helper_spawn_failed' }));
    child.once('close', (status, signal) => {
      finish(
        status === 0 && stdout
          ? { ok: true, stdout }
          : { ok: false, reason: verifiedPythonFailureReason({ status, signal }) }
      );
    });
    // This session is restricted to non-secret process-identity observations.
    // Reuse the one full signed-runtime admission from open while still
    // rehashing/reproving the private interpreter before every bounded probe.
    if (!prepared.assertCurrent(false)) {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'native_helper_identity_unproven' });
      return;
    }
    child.stdin?.end(input);
  });
}

export function openVerifiedCommandEveObservationPythonSession():
  | VerifiedCommandEveObservationPythonSession
  | undefined {
  const resolution = resolveHelper();
  if (!resolution.required || !resolution.pythonExecutable) return undefined;
  const prepared = prepareInterpreter(resolution);
  if (!prepared) return undefined;
  let closed = false;
  return {
    run: async (source, input, options = {}) => {
      if (closed) return { ok: false, reason: 'native_helper_session_closed' };
      return runPreparedPythonAsync(prepared, resolution, source, input, {
        timeoutMs: options.timeoutMs ?? resolution.test?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? MAX_RESPONSE_BYTES,
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      prepared.cleanup();
    },
  };
}

function invokeVerifiedPython(
  resolution: HelperResolution,
  source: string,
  input: string,
  options: Readonly<{ timeoutMs: number; maxBuffer: number }>
): VerifiedPythonResult {
  const prepared = prepareInterpreter(resolution);
  if (!prepared) return { ok: false, reason: 'native_helper_identity_unproven' };
  try {
    if (!prepared.assertCurrent()) return { ok: false, reason: 'native_helper_identity_unproven' };
    // `-I` implies `-E` and would ignore the exact PYTHONHOME needed after the
    // verified executable is copied into a private launch directory.
    // `-s -S` plus the closed environment below disables user/global site
    // loading without discarding that explicit signed-runtime binding.
    const child = spawnSync(prepared.executable, ['-B', '-s', '-S', '-c', source], {
      input,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: {
        PATH: '/usr/bin:/bin',
        ...(resolution.pythonHome ? { PYTHONHOME: resolution.pythonHome } : {}),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    if (child.status !== 0 || child.error || !child.stdout)
      return { ok: false, reason: child.error ? 'native_helper_spawn_failed' : verifiedPythonFailureReason(child) };
    return { ok: true, stdout: child.stdout };
  } finally {
    prepared.cleanup();
  }
}

export function runVerifiedCommandEvePythonSource(
  source: string,
  input: string,
  options: Readonly<{ timeoutMs?: number; maxBuffer?: number }> = {}
): VerifiedPythonResult {
  const resolution = resolveHelper();
  if (!resolution.required || !resolution.pythonExecutable) {
    return { ok: false, reason: 'native_helper_unavailable' };
  }
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
    return { ok: false, reason: 'native_helper_request_too_large' };
  }
  return invokeVerifiedPython(resolution, source, input, {
    timeoutMs: options.timeoutMs ?? resolution.test?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? MAX_RESPONSE_BYTES,
  });
}

function invokeHelper(resolution: HelperResolution, request: Record<string, unknown>): VaultNativeResult {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) return { ok: false, reason: 'native_helper_request_too_large' };
  const invoked = invokeVerifiedPython(resolution, HELPER_SOURCE, input, {
    timeoutMs: resolution.test?.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
    maxBuffer: MAX_RESPONSE_BYTES,
  });
  if (!invoked.ok) return invoked;
  try {
    const parsed = JSON.parse(invoked.stdout) as VaultNativeResult;
    return parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean'
      ? parsed
      : { ok: false, reason: 'native_helper_result_invalid' };
  } catch {
    return { ok: false, reason: 'native_helper_result_invalid' };
  }
}

function intendedState(
  operation: VaultNativeOperation,
  data: Buffer | undefined
): {
  intended_exists: boolean;
  intended_sha256: string | null;
} {
  if (operation === 'delete') return { intended_exists: false, intended_sha256: null };
  const payload = data ?? Buffer.alloc(0);
  return {
    intended_exists: true,
    intended_sha256: crypto.createHash('sha256').update(payload).digest('hex'),
  };
}

export function runVaultNativeHelper(request: VaultNativeRequest): VaultNativeResult | undefined {
  const resolution = resolveHelper();
  if (!resolution.required) return undefined;
  if (!resolution.pythonExecutable) return { ok: false, reason: 'native_helper_unavailable' };
  if (request.data && request.data.length > MAX_RECORD_BYTES) return { ok: false, reason: 'record_size_exceeded' };

  const base = {
    operation: request.operation,
    directory: request.directory,
    directory_identity: request.directoryIdentity,
    ...(request.fileName ? { file_name: request.fileName } : {}),
    ...(request.data ? { bytes_base64: request.data.toString('base64') } : {}),
    ...(resolution.test?.swapAwayThenBack === request.operation
      ? { swap_away_then_back: true, foreign_bytes_base64: Buffer.from('foreign-unchanged').toString('base64') }
      : {}),
  };
  if (!['write', 'restore', 'delete'].includes(request.operation)) return invokeHelper(resolution, base);

  if (!request.fileName) return { ok: false, reason: 'native_helper_file_missing' };
  const transactionId = randomUUID().replaceAll('-', '');
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) return { ok: false, reason: 'native_helper_transaction_invalid' };
  const expected = intendedState(request.operation, request.data);
  const attempted = invokeHelper(resolution, {
    ...base,
    transaction_id: transactionId,
    ...(resolution.test?.exitAfterCommitBeforeStdout === request.operation
      ? { exit_after_commit_before_stdout: true }
      : {}),
    ...(resolution.test?.corruptStdoutAfterCommit === request.operation ? { corrupt_stdout_after_commit: true } : {}),
    ...(resolution.test?.corruptRecordAfterCommit === request.operation ? { corrupt_record_after_commit: true } : {}),
    ...(resolution.test?.sleepAfterCommitMs && resolution.test.sleepAfterCommitMs > 0
      ? { sleep_after_commit_ms: resolution.test.sleepAfterCommitMs }
      : {}),
  });

  if (resolution.test?.recoveryUnavailableAfterCommit === request.operation) {
    return {
      ok: false,
      mutation_state: 'ambiguous',
      transaction_id: transactionId,
      reason: 'mutation_ambiguous__recovery_unavailable',
    };
  }

  // Interpreter/request admission fails before the helper receives stdin, so
  // no journal or authority mutation can exist and recovery must not execute a
  // now-replaced helper path merely to rediscover that fact.
  if (
    attempted.reason === 'native_helper_identity_unproven' ||
    attempted.reason === 'native_helper_request_too_large'
  ) {
    return {
      ok: false,
      mutation_state: 'not_committed',
      transaction_id: transactionId,
      reason: attempted.reason,
    };
  }

  const recovered = invokeHelper(resolution, {
    operation: 'recover',
    directory: request.directory,
    directory_identity: request.directoryIdentity,
    file_name: request.fileName,
    transaction_id: transactionId,
    ...expected,
  });
  if (recovered.mutation_state === 'committed') {
    return { ...attempted, ok: true, mutation_state: 'committed', transaction_id: transactionId };
  }
  if (recovered.mutation_state === 'not_committed') {
    return {
      ok: false,
      mutation_state: 'not_committed',
      transaction_id: transactionId,
      reason: 'mutation_not_committed',
    };
  }
  const diagnostic = [attempted.reason, recovered.reason].filter(Boolean).join('__recovery__');
  return {
    ok: false,
    mutation_state: 'ambiguous',
    transaction_id: transactionId,
    reason: `mutation_ambiguous${diagnostic ? `__${diagnostic}` : ''}`,
  };
}
