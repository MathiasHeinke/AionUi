import type {
  RegisteredAgentProcessIdentityProbe,
  RegisteredAgentProcessIdentityProbeResult,
  RegisteredAgentProcessV2,
} from '@aionui/web-host';
import { runVerifiedCommandEvePythonSource } from '@/process/services/vault-native';

const PROCESS_IDENTITY_SENTINEL = 'COMMAND_EVE_PROCESS_IDENTITY_V1';
const PROCESS_IDENTITY_MAX_OUTPUT = 16 * 1024;

const DARWIN_PROCESS_IDENTITY_SOURCE = String.raw`
import ctypes, errno, json, os, sys

PROC_PIDTBSDINFO = 3
PROC_PIDPATHINFO_MAXSIZE = 4096

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

request = json.loads(sys.stdin.buffer.read(4097))
if set(request.keys()) != {"pid"} or not isinstance(request["pid"], int) or request["pid"] <= 0:
    raise RuntimeError("request_invalid")
pid = request["pid"]
libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
libproc.proc_pidinfo.restype = ctypes.c_int
libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
libproc.proc_pidpath.restype = ctypes.c_int

info = ProcBsdInfo()
ctypes.set_errno(0)
read = libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
if read != ctypes.sizeof(info):
    code = ctypes.get_errno()
    if code == errno.ESRCH:
        result = {"sentinel": "${PROCESS_IDENTITY_SENTINEL}", "state": "absent"}
    else:
        result = {"sentinel": "${PROCESS_IDENTITY_SENTINEL}", "state": "unknown"}
else:
    path_buffer = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
    ctypes.set_errno(0)
    path_length = libproc.proc_pidpath(pid, path_buffer, PROC_PIDPATHINFO_MAXSIZE)
    if path_length <= 0:
        result = {"sentinel": "${PROCESS_IDENTITY_SENTINEL}", "state": "unknown"}
    else:
        executable_path = os.path.realpath(path_buffer.value.decode("utf-8", "strict"))
        result = {
            "sentinel": "${PROCESS_IDENTITY_SENTINEL}",
            "state": "observed",
            "pid": int(info.pbi_pid),
            "process_group_id": int(info.pbi_pgid),
            "start_time_value": str(int(info.pbi_start_tvsec) * 1000000 + int(info.pbi_start_tvusec)),
            "parent_pid": int(info.pbi_ppid),
            "executable_path": executable_path,
        }
sys.stdout.write(json.dumps(result, separators=(",", ":")))
`;

export type ObservedDarwinProcessIdentity = Readonly<{
  pid: number;
  process_group_id: number;
  start_time_value: string;
  parent_pid: number;
  executable_path: string;
}>;

export type CommandEveDarwinProcessIdentityProbe = Readonly<
  { state: 'absent' | 'unknown' } | { state: 'observed'; observed: ObservedDarwinProcessIdentity }
>;

export function compareCommandEveRegisteredProcessIdentity(
  entry: RegisteredAgentProcessV2,
  observed: ObservedDarwinProcessIdentity
): RegisteredAgentProcessIdentityProbeResult {
  if (entry.process_identity.platform !== 'darwin' || entry.process_identity.start_time.kind !== 'unix_epoch_us') {
    return 'unknown';
  }
  if (entry.process_group_id === undefined || entry.process_group_id <= 1) return 'unknown';
  if (
    observed.pid !== entry.pid ||
    observed.start_time_value !== entry.process_identity.start_time.value ||
    observed.process_group_id !== entry.process_group_id
  ) {
    return 'mismatch';
  }
  // executable_path may change through an in-place execve and parent_pid may
  // change through legitimate reparenting after AionCore exits. Exact birth +
  // current PGID are the durable signal authority; path/parent remain closed
  // registration provenance and probe diagnostics, not lifetime invariants.
  return 'match';
}

export function createCommandEveRegisteredProcessIdentityProbe(): RegisteredAgentProcessIdentityProbe {
  return async (entry) => {
    if (process.platform !== 'darwin') return 'unknown';
    const parsed = probeCommandEveDarwinProcessIdentity(entry.pid);
    if (!parsed || parsed.state === 'unknown') return 'unknown';
    if (parsed.state === 'absent') return 'absent';
    if (!('observed' in parsed)) return 'unknown';
    return compareCommandEveRegisteredProcessIdentity(entry, parsed.observed);
  };
}

export function probeCommandEveDarwinProcessIdentity(pid: number): CommandEveDarwinProcessIdentityProbe | undefined {
  const result = runVerifiedCommandEvePythonSource(DARWIN_PROCESS_IDENTITY_SOURCE, JSON.stringify({ pid }), {
    timeoutMs: 2_000,
    maxBuffer: PROCESS_IDENTITY_MAX_OUTPUT,
  });
  return result.ok ? parseProbe(result.stdout) : undefined;
}

function parseProbe(stdout: string): CommandEveDarwinProcessIdentityProbe | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || parsed.sentinel !== PROCESS_IDENTITY_SENTINEL) return undefined;
    if (parsed.state === 'absent' || parsed.state === 'unknown') {
      return Object.keys(parsed).every((key) => ['sentinel', 'state'].includes(key))
        ? { state: parsed.state }
        : undefined;
    }
    if (
      parsed.state !== 'observed' ||
      !hasExactKeys(parsed, [
        'executable_path',
        'parent_pid',
        'pid',
        'process_group_id',
        'sentinel',
        'start_time_value',
        'state',
      ]) ||
      !isPositiveU32(parsed.pid) ||
      !isPositiveU32(parsed.process_group_id) ||
      !isPositiveU32(parsed.parent_pid) ||
      typeof parsed.executable_path !== 'string' ||
      parsed.executable_path.length === 0 ||
      typeof parsed.start_time_value !== 'string' ||
      !/^[0-9]+$/.test(parsed.start_time_value)
    ) {
      return undefined;
    }
    return {
      state: 'observed',
      observed: {
        pid: parsed.pid,
        process_group_id: parsed.process_group_id,
        start_time_value: parsed.start_time_value,
        parent_pid: parsed.parent_pid,
        executable_path: parsed.executable_path,
      },
    };
  } catch {
    return undefined;
  }
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
