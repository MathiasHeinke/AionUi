import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import type {
  RegisteredAgentProcessIdentityProbe,
  RegisteredAgentProcessIdentityProbeProvider,
  RegisteredAgentProcessIdentityProbeResult,
  RegisteredAgentProcessV2,
} from '@aionui/web-host';
import {
  openVerifiedCommandEveObservationPythonSession,
  runVerifiedCommandEvePythonSource,
} from '@/process/services/vault-native';

const PROCESS_IDENTITY_SENTINEL = 'COMMAND_EVE_PROCESS_IDENTITY_V1';
const PROCESS_IDENTITY_MAX_OUTPUT = 256 * 1024;
const PROCESS_IDENTITY_MAX_BATCH = 512;
const WINDOWS_PROCESS_IDENTITY_SENTINEL = 'COMMAND_EVE_WINDOWS_PROCESS_IDENTITY_V1';

const DARWIN_PROCESS_IDENTITY_SOURCE = String.raw`
import ctypes, errno, json, os, sys

PROC_PIDTBSDINFO = 3
PROC_PIDPATHINFO_MAXSIZE = 4096
MAX_BATCH = ${PROCESS_IDENTITY_MAX_BATCH}

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]

request = json.loads(sys.stdin.buffer.read(65537))
pids = request.get("pids") if isinstance(request, dict) and set(request.keys()) == {"pids"} else None
if (
    not isinstance(pids, list)
    or len(pids) > MAX_BATCH
    or any(not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 for pid in pids)
    or len(set(pids)) != len(pids)
):
    raise RuntimeError("request_invalid")

libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
libproc.proc_pidinfo.restype = ctypes.c_int
libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
libproc.proc_pidpath.restype = ctypes.c_int

results = []
for pid in pids:
    info = ProcBsdInfo()
    ctypes.set_errno(0)
    count = libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
    if count != ctypes.sizeof(info):
        results.append({"state": "absent" if ctypes.get_errno() == errno.ESRCH else "unknown"})
        continue
    path_buffer = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
    ctypes.set_errno(0)
    path_length = libproc.proc_pidpath(pid, path_buffer, PROC_PIDPATHINFO_MAXSIZE)
    if path_length <= 0:
        results.append({"state": "unknown"})
        continue
    results.append({
        "state": "observed",
        "pid": int(info.pbi_pid),
        "process_group_id": int(info.pbi_pgid),
        "start_time_value": str(int(info.pbi_start_tvsec) * 1000000 + int(info.pbi_start_tvusec)),
        "parent_pid": int(info.pbi_ppid),
        "executable_path": os.path.realpath(path_buffer.value.decode("utf-8", "strict")),
    })

sys.stdout.write(json.dumps({"sentinel": "${PROCESS_IDENTITY_SENTINEL}", "results": results}, separators=(",", ":")))
`;

export type ObservedDarwinProcessIdentity = Readonly<{
  pid: number;
  process_group_id: number;
  start_time_value: string;
  parent_pid: number;
  executable_path: string;
}>;

export type ObservedLinuxProcessIdentity = ObservedDarwinProcessIdentity;
export type ObservedWindowsProcessIdentity = Readonly<{
  pid: number;
  start_time_value: string;
  executable_path: string;
}>;

export type CommandEveDarwinProcessIdentityProbe = Readonly<
  { state: 'absent' | 'unknown' } | { state: 'observed'; observed: ObservedDarwinProcessIdentity }
>;

export type CommandEveLinuxProcessIdentityProbe = Readonly<
  { state: 'absent' | 'unknown' } | { state: 'observed'; observed: ObservedLinuxProcessIdentity }
>;

export type LinuxProcessIdentityReader = Readonly<{
  readText: (filePath: string) => Promise<string>;
  readLink: (filePath: string) => Promise<string>;
}>;

const linuxReader: LinuxProcessIdentityReader = {
  readText: (filePath) => readFile(filePath, 'utf8'),
  readLink: (filePath) => readlink(filePath),
};

export function compareCommandEveRegisteredProcessIdentity(
  entry: RegisteredAgentProcessV2,
  observed: ObservedDarwinProcessIdentity
): RegisteredAgentProcessIdentityProbeResult {
  if (entry.process_identity.platform !== 'darwin' || entry.process_identity.start_time.kind !== 'unix_epoch_us') {
    return 'unknown';
  }
  return compareBirthAndGroup(entry, observed);
}

export function compareCommandEveLinuxRegisteredProcessIdentity(
  entry: RegisteredAgentProcessV2,
  observed: ObservedLinuxProcessIdentity
): RegisteredAgentProcessIdentityProbeResult {
  if (entry.process_identity.platform !== 'linux' || entry.process_identity.start_time.kind !== 'linux_boot_ticks') {
    return 'unknown';
  }
  return compareBirthAndGroup(entry, observed);
}

export function compareCommandEveWindowsRegisteredProcessIdentity(
  entry: RegisteredAgentProcessV2,
  observed: ObservedWindowsProcessIdentity
): RegisteredAgentProcessIdentityProbeResult {
  if (
    entry.process_identity.platform !== 'win32' ||
    entry.process_identity.start_time.kind !== 'windows_filetime_100ns'
  ) {
    return 'unknown';
  }
  return observed.pid === entry.pid && observed.start_time_value === entry.process_identity.start_time.value
    ? 'match'
    : 'mismatch';
}

function compareBirthAndGroup(
  entry: RegisteredAgentProcessV2,
  observed: ObservedDarwinProcessIdentity
): RegisteredAgentProcessIdentityProbeResult {
  if (entry.process_group_id === undefined || entry.process_group_id <= 1) return 'unknown';
  if (
    observed.pid !== entry.pid ||
    observed.start_time_value !== entry.process_identity.start_time.value ||
    observed.process_group_id !== entry.process_group_id
  ) {
    return 'mismatch';
  }
  // executable_path may change through execve and parent_pid may change after
  // legitimate reparenting. Exact birth + current PGID are signal authority;
  // path/parent remain closed registration provenance and diagnostics.
  return 'match';
}

export type CommandEveRegisteredProcessIdentityProbeProviderOptions = Readonly<{
  isPackaged?: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}>;

export function createCommandEveRegisteredProcessIdentityProbeProvider(
  options: CommandEveRegisteredProcessIdentityProbeProviderOptions = {}
): RegisteredAgentProcessIdentityProbeProvider {
  const platform = options.platform ?? process.platform;
  return {
    open: async () => {
      if (platform === 'darwin') {
        const verifiedPython = openVerifiedCommandEveObservationPythonSession();
        return {
          probeMany: async (entries) => {
            if (!verifiedPython) return entries.map(() => 'unknown' as const);
            const supported = entries
              .map((entry, index) => ({ entry, index }))
              .filter(({ entry }) => entry.process_identity.platform === 'darwin');
            if (supported.length === 0) return entries.map(() => 'unknown' as const);
            const result = await verifiedPython.run(
              DARWIN_PROCESS_IDENTITY_SOURCE,
              JSON.stringify({ pids: supported.map(({ entry }) => entry.pid) }),
              { timeoutMs: 2_000, maxBuffer: PROCESS_IDENTITY_MAX_OUTPUT }
            );
            const parsed = result.ok ? parseDarwinBatch(result.stdout, supported.length) : undefined;
            const outcomes = entries.map(() => 'unknown' as RegisteredAgentProcessIdentityProbeResult);
            if (!parsed) return outcomes;
            supported.forEach(({ entry, index }, supportedIndex) => {
              const observed = parsed[supportedIndex];
              outcomes[index] =
                observed.state === 'observed'
                  ? compareCommandEveRegisteredProcessIdentity(entry, observed.observed)
                  : observed.state;
            });
            return outcomes;
          },
          close: () => verifiedPython?.close(),
        };
      }
      if (platform === 'linux') {
        return {
          probeMany: (entries) =>
            Promise.all(
              entries.map(async (entry) => {
                if (entry.process_identity.platform !== 'linux') return 'unknown';
                const observed = await probeCommandEveLinuxProcessIdentity(entry.pid);
                return observed.state === 'observed'
                  ? compareCommandEveLinuxRegisteredProcessIdentity(entry, observed.observed)
                  : observed.state;
              })
            ),
          close: () => undefined,
        };
      }
      if (platform === 'win32') {
        return {
          probeMany: async (entries) => {
            const supported = entries
              .map((entry, index) => ({ entry, index }))
              .filter(({ entry }) => entry.process_identity.platform === 'win32');
            const outcomes = entries.map(() => 'unknown' as RegisteredAgentProcessIdentityProbeResult);
            if (supported.length === 0) return outcomes;
            const nativeProbe = resolveCommandEvePackagedWindowsProcessIdentityProbe({
              ...options,
              platform,
            });
            if (!nativeProbe) return outcomes;
            const observed = await probeCommandEveWindowsProcessIdentities(
              supported.map(({ entry }) => entry.pid),
              nativeProbe
            );
            if (!observed) return outcomes;
            supported.forEach(({ entry, index }, supportedIndex) => {
              const result = observed[supportedIndex];
              outcomes[index] =
                result.state === 'observed'
                  ? compareCommandEveWindowsRegisteredProcessIdentity(entry, result.observed)
                  : result.state;
            });
            return outcomes;
          },
          close: () => undefined,
        };
      }
      return {
        probeMany: async (entries) => entries.map(() => 'unknown' as const),
        close: () => undefined,
      };
    },
  };
}

export function resolveCommandEvePackagedWindowsProcessIdentityProbe(
  options: CommandEveRegisteredProcessIdentityProbeProviderOptions
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || options.isPackaged !== true || !options.resourcesPath) return undefined;
  const arch = options.arch ?? process.arch;
  if (!['x64', 'arm64'].includes(arch)) return undefined;
  try {
    const resourcesRoot = path.resolve(options.resourcesPath);
    const bundledRoot = path.join(resourcesRoot, 'bundled-aioncore');
    const runtimeRoot = path.join(bundledRoot, `win32-${arch}`);
    const manifestPath = path.join(runtimeRoot, 'manifest.json');
    const binaryPath = path.join(runtimeRoot, 'aioncore.exe');
    const directories = [resourcesRoot, bundledRoot, runtimeRoot];
    if (
      directories.some((directory) => {
        const identity = lstatSync(directory);
        return !identity.isDirectory() || identity.isSymbolicLink();
      })
    ) {
      return undefined;
    }
    for (const filePath of [manifestPath, binaryPath]) {
      const identity = lstatSync(filePath);
      if (!identity.isFile() || identity.isSymbolicLink()) return undefined;
    }
    const canonicalRoot = realpathSync.native(resourcesRoot);
    const canonicalBinary = realpathSync.native(binaryPath);
    const expectedCanonicalBinary = path.join(canonicalRoot, 'bundled-aioncore', `win32-${arch}`, 'aioncore.exe');
    const normalize = (value: string): string => path.normalize(value).replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (normalize(canonicalRoot) !== normalize(resourcesRoot)) return undefined;
    if (normalize(canonicalBinary) !== normalize(expectedCanonicalBinary)) return undefined;
    return canonicalBinary;
  } catch {
    return undefined;
  }
}

type CommandEveWindowsProcessIdentityProbe = Readonly<
  { state: 'absent' | 'unknown' } | { state: 'observed'; observed: ObservedWindowsProcessIdentity }
>;

export async function probeCommandEveWindowsProcessIdentities(
  pids: readonly number[],
  nativeProbe: string
): Promise<readonly CommandEveWindowsProcessIdentityProbe[] | undefined> {
  if (
    pids.length > PROCESS_IDENTITY_MAX_BATCH ||
    pids.some((pid) => !Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) ||
    new Set(pids).size !== pids.length
  ) {
    return undefined;
  }
  if (!nativeProbe) return undefined;
  const output = await new Promise<{ stdout: string; ok: boolean }>((resolve) => {
    let settled = false;
    let stdout = '';
    let timeout: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ stdout, ok });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(nativeProbe, ['process-identity-probe'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      finish(false);
      return;
    }
    timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 2_000);
    timeout.unref?.();
    child.once('error', () => finish(false));
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > PROCESS_IDENTITY_MAX_OUTPUT) {
        child.kill();
        finish(false);
      }
    });
    child.once('exit', (code) => finish(code === 0));
    child.stdin?.end(JSON.stringify({ pids }));
  });
  return output.ok ? parseWindowsBatch(output.stdout, pids.length) : undefined;
}

export function parseWindowsBatch(
  stdout: string,
  expectedCount: number
): readonly CommandEveWindowsProcessIdentityProbe[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ['results', 'sentinel']) ||
      parsed.sentinel !== WINDOWS_PROCESS_IDENTITY_SENTINEL ||
      !Array.isArray(parsed.results) ||
      parsed.results.length !== expectedCount
    ) {
      return undefined;
    }
    const results = parsed.results.map((value): CommandEveWindowsProcessIdentityProbe | undefined => {
      if (!isRecord(value)) return undefined;
      if (value.state === 'absent' || value.state === 'unknown') {
        return hasExactKeys(value, ['state']) ? { state: value.state } : undefined;
      }
      if (
        value.state !== 'observed' ||
        !hasExactKeys(value, ['executable_path', 'pid', 'start_time_value', 'state']) ||
        !isPositiveU32(value.pid) ||
        typeof value.start_time_value !== 'string' ||
        !/^[0-9]+$/.test(value.start_time_value) ||
        typeof value.executable_path !== 'string' ||
        !path.win32.isAbsolute(value.executable_path)
      ) {
        return undefined;
      }
      return {
        state: 'observed',
        observed: {
          pid: value.pid,
          start_time_value: value.start_time_value,
          executable_path: value.executable_path,
        },
      };
    });
    return results.every(Boolean) ? (results as CommandEveWindowsProcessIdentityProbe[]) : undefined;
  } catch {
    return undefined;
  }
}

export function createCommandEveRegisteredProcessIdentityProbe(): RegisteredAgentProcessIdentityProbe {
  const provider = createCommandEveRegisteredProcessIdentityProbeProvider();
  return async (entry) => {
    const session = await provider.open();
    try {
      const [result] = await session.probeMany([entry]);
      return result ?? 'unknown';
    } finally {
      await session.close();
    }
  };
}

export function probeCommandEveDarwinProcessIdentity(pid: number): CommandEveDarwinProcessIdentityProbe | undefined {
  const result = runVerifiedCommandEvePythonSource(DARWIN_PROCESS_IDENTITY_SOURCE, JSON.stringify({ pids: [pid] }), {
    timeoutMs: 2_000,
    maxBuffer: PROCESS_IDENTITY_MAX_OUTPUT,
  });
  return result.ok ? parseDarwinBatch(result.stdout, 1)?.[0] : undefined;
}

export async function probeCommandEveLinuxProcessIdentity(
  pid: number,
  reader: LinuxProcessIdentityReader = linuxReader
): Promise<CommandEveLinuxProcessIdentityProbe> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) return { state: 'unknown' };
  try {
    const [statText, bootIdText, executablePath] = await Promise.all([
      reader.readText(`/proc/${pid}/stat`),
      reader.readText('/proc/sys/kernel/random/boot_id'),
      reader.readLink(`/proc/${pid}/exe`),
    ]);
    const closing = statText.lastIndexOf(') ');
    const opening = statText.indexOf(' (');
    if (opening <= 0 || closing <= opening) return { state: 'unknown' };
    const observedPid = Number(statText.slice(0, opening));
    const fields = statText
      .slice(closing + 2)
      .trim()
      .split(/\s+/);
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startTicks = fields[19];
    const bootId = bootIdText.trim().toLowerCase();
    if (
      !isPositiveU32(observedPid) ||
      !isPositiveU32(parentPid) ||
      !isPositiveU32(processGroupId) ||
      !startTicks ||
      !/^[0-9]+$/.test(startTicks) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId) ||
      !executablePath
    ) {
      return { state: 'unknown' };
    }
    return {
      state: 'observed',
      observed: {
        pid: observedPid,
        process_group_id: processGroupId,
        start_time_value: `${bootId}:${startTicks}`,
        parent_pid: parentPid,
        executable_path: executablePath,
      },
    };
  } catch (error) {
    return isNotFound(error) ? { state: 'absent' } : { state: 'unknown' };
  }
}

function parseDarwinBatch(
  stdout: string,
  expectedCount: number
): readonly CommandEveDarwinProcessIdentityProbe[] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ['results', 'sentinel']) ||
      parsed.sentinel !== PROCESS_IDENTITY_SENTINEL ||
      !Array.isArray(parsed.results) ||
      parsed.results.length !== expectedCount
    ) {
      return undefined;
    }
    const results = parsed.results.map(parseDarwinResult);
    return results.every(Boolean) ? (results as CommandEveDarwinProcessIdentityProbe[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseDarwinResult(value: unknown): CommandEveDarwinProcessIdentityProbe | undefined {
  if (!isRecord(value)) return undefined;
  if (value.state === 'absent' || value.state === 'unknown') {
    return hasExactKeys(value, ['state']) ? { state: value.state } : undefined;
  }
  if (
    value.state !== 'observed' ||
    !hasExactKeys(value, ['executable_path', 'parent_pid', 'pid', 'process_group_id', 'start_time_value', 'state']) ||
    !isPositiveU32(value.pid) ||
    !isPositiveU32(value.process_group_id) ||
    !isPositiveU32(value.parent_pid) ||
    typeof value.executable_path !== 'string' ||
    value.executable_path.length === 0 ||
    typeof value.start_time_value !== 'string' ||
    !/^[0-9]+$/.test(value.start_time_value)
  ) {
    return undefined;
  }
  return {
    state: 'observed',
    observed: {
      pid: value.pid,
      process_group_id: value.process_group_id,
      start_time_value: value.start_time_value,
      parent_pid: value.parent_pid,
      executable_path: value.executable_path,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...expected].toSorted());
}

function isPositiveU32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
