import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export type RegisteredProcessStartTime = Readonly<{
  kind: 'unix_epoch_us' | 'linux_boot_ticks' | 'windows_filetime_100ns';
  value: string;
}>;

export type RegisteredAgentProcessIdentity = Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  start_time: RegisteredProcessStartTime;
  parent_pid: number;
  executable_path: string;
}>;

export type RegisteredAgentProcessV2 = Readonly<{
  pid: number;
  process_group_id?: number;
  conversation_id: string;
  agent_type: string;
  backend?: string;
  command_preview?: string;
  registered_at_ms: number;
  process_identity: RegisteredAgentProcessIdentity;
}>;

export type RegisteredAgentProcessIdentityProbeResult = 'match' | 'absent' | 'mismatch' | 'unknown';
export type RegisteredAgentProcessIdentityProbe = (
  entry: RegisteredAgentProcessV2
) => Promise<RegisteredAgentProcessIdentityProbeResult>;

export type RegisteredAgentProcessIdentityBatchProbe = (
  entries: readonly RegisteredAgentProcessV2[]
) => Promise<readonly RegisteredAgentProcessIdentityProbeResult[]>;

export type RegisteredAgentProcessIdentityProbeSession = Readonly<{
  probeMany: RegisteredAgentProcessIdentityBatchProbe;
  close: () => void | Promise<void>;
}>;

export type RegisteredAgentProcessIdentityProbeProvider = Readonly<{
  open: () => RegisteredAgentProcessIdentityProbeSession | Promise<RegisteredAgentProcessIdentityProbeSession>;
}>;

type CanonicalAgentProcessV2 = Omit<RegisteredAgentProcessV2, 'process_identity'> & {
  process_identity: RegisteredAgentProcessIdentity | null;
};

type ReadRegistryResult = Readonly<{
  version: number;
  processes: unknown[];
  structurallyValid: boolean;
  reason?: string;
}>;

export type AgentProcessCleanupResult = Readonly<{
  survivor_pids: number[];
  registry_unproven: boolean;
  diagnostic_paths?: string[];
}>;

export type AgentProcessCleanupOptions = Readonly<{
  identityProbe?: RegisteredAgentProcessIdentityProbe;
  identityProbeProvider?: RegisteredAgentProcessIdentityProbeProvider;
  termGraceMs?: number;
}>;

export const AGENT_PROCESS_REGISTRY_RELATIVE_PATH = path.join('runtime', 'agent-process-registry.json');
export const AGENT_PROCESS_REGISTRY_EMERGENCY_RELATIVE_DIR = path.join('runtime', 'agent-process-registry-emergency');
export const AGENT_PROCESS_REGISTRY_QUARANTINE_RELATIVE_DIR = path.join('runtime', 'agent-process-registry-quarantine');

const TERM_GRACE_MS = 1_000;
const REGISTRY_VERSION = 2;
const ENTRY_REQUIRED_KEYS = ['agent_type', 'conversation_id', 'pid', 'process_identity', 'registered_at_ms'] as const;
const ENTRY_OPTIONAL_KEYS = ['backend', 'command_preview', 'process_group_id'] as const;
const EMERGENCY_REQUIRED_KEYS = ['process', 'reason', 'version'] as const;

export function resolveAgentProcessRegistryPath(dataDir: string): string {
  return path.join(dataDir, AGENT_PROCESS_REGISTRY_RELATIVE_PATH);
}

export async function cleanupRegisteredAgentProcesses(
  dataDir?: string,
  options: AgentProcessCleanupOptions = {}
): Promise<AgentProcessCleanupResult> {
  if (!dataDir) return { survivor_pids: [], registry_unproven: false };

  const registryPath = resolveAgentProcessRegistryPath(dataDir);
  const quarantineDirectory = path.join(dataDir, AGENT_PROCESS_REGISTRY_QUARANTINE_RELATIVE_DIR);
  const emergencyDirectory = path.join(dataDir, AGENT_PROCESS_REGISTRY_EMERGENCY_RELATIVE_DIR);
  const diagnosticPaths = await listDiagnosticPaths(quarantineDirectory);
  const registry = await readRegistry(registryPath);
  if (!registry.structurallyValid || ![1, REGISTRY_VERSION].includes(registry.version)) {
    const diagnosticPath = await quarantineMalformedRegistry(registryPath, quarantineDirectory, registry.reason);
    if (diagnosticPath) diagnosticPaths.push(diagnosticPath);
    return {
      survivor_pids: numericPids(registry.processes),
      registry_unproven: true,
      diagnostic_paths: [...new Set(diagnosticPaths)].toSorted(),
    };
  }

  const observationMs = Math.max(0, options.termGraceMs ?? TERM_GRACE_MS);
  const primaryProven: RegisteredAgentProcessV2[] = [];
  const primaryUnproven: CanonicalAgentProcessV2[] = [];
  const malformedSurvivors: unknown[] = [];
  let changed = registry.version !== REGISTRY_VERSION;

  const primaryClassifications = await Promise.all(
    registry.processes.map(async (entry) => {
      if (isRegisteredProcessV2(entry)) return { kind: 'proven' as const, entry };
      const absent = await observeUnprovenProcessAbsence(entry, observationMs);
      if (absent) return { kind: 'absent' as const, entry };
      const canonical = normalizeUnprovenRegistryEntry(entry);
      return canonical ? { kind: 'unproven' as const, entry: canonical } : { kind: 'malformed' as const, entry };
    })
  );
  for (const classification of primaryClassifications) {
    if (classification.kind === 'proven') primaryProven.push(classification.entry);
    if (classification.kind === 'unproven') primaryUnproven.push(classification.entry);
    if (classification.kind === 'malformed') malformedSurvivors.push(classification.entry);
    if (classification.kind === 'absent') changed = true;
  }
  if (malformedSurvivors.length > 0) {
    const diagnosticPath = await writeQuarantineEntries(quarantineDirectory, malformedSurvivors);
    diagnosticPaths.push(diagnosticPath);
    changed = true;
  }

  const emergency = await readEmergencyEvidence(emergencyDirectory);
  const emergencyProven = emergency.filter((item) => item.process && isRegisteredProcessV2(item.process));
  const emergencyUnproven = emergency.filter((item) => item.process && !isRegisteredProcessV2(item.process));
  const malformedEmergency = emergency.filter((item) => !item.process);
  diagnosticPaths.push(...malformedEmergency.map((item) => item.path));

  const emergencyUnprovenStates = await Promise.all(
    emergencyUnproven.map(async (item) => ({
      item,
      absent: await observeUnprovenProcessAbsence(item.process, observationMs),
    }))
  );
  await Promise.all(
    emergencyUnprovenStates
      .filter(({ absent }) => absent)
      .map(({ item }) => removeEmergencyEvidence(item.path, emergencyDirectory))
  );

  const provenItems = [
    ...primaryProven.map((entry) => ({ entry, sourcePath: undefined as string | undefined })),
    ...emergencyProven.map((item) => ({ entry: item.process as RegisteredAgentProcessV2, sourcePath: item.path })),
  ];
  const provenCleanup = await cleanupProvenProcesses(
    provenItems.map((item) => item.entry),
    options,
    observationMs
  );
  const provenSurvivorSet = new Set(provenCleanup.survivors);
  const primaryProvenSurvivors = primaryProven.filter((entry) => provenSurvivorSet.has(entry));
  await Promise.all(
    provenItems
      .filter(
        (item): item is typeof item & { sourcePath: string } =>
          Boolean(item.sourcePath) && !provenSurvivorSet.has(item.entry)
      )
      .map((item) => removeEmergencyEvidence(item.sourcePath, emergencyDirectory))
  );
  if (primaryProvenSurvivors.length !== primaryProven.length) changed = true;

  const retainedPrimary: CanonicalAgentProcessV2[] = [...primaryUnproven, ...primaryProvenSurvivors];
  if (changed || JSON.stringify(registry.processes) !== JSON.stringify(retainedPrimary)) {
    await writeRegistry(registryPath, {
      version: REGISTRY_VERSION,
      processes: retainedPrimary,
    });
  }

  const remainingEmergency = await readEmergencyEvidence(emergencyDirectory);
  const survivorEntries = [
    ...retainedPrimary,
    ...remainingEmergency.flatMap((item) => (item.process ? [item.process] : [])),
    ...malformedSurvivors,
  ];
  const diagnostics = [
    ...new Set([
      ...diagnosticPaths,
      ...malformedEmergency.map((item) => item.path),
      ...remainingEmergency.map((item) => item.path),
    ]),
  ].toSorted();
  return {
    survivor_pids: numericPids(survivorEntries),
    registry_unproven: survivorEntries.length > 0 || diagnostics.length > 0,
    ...(diagnostics.length > 0 ? { diagnostic_paths: diagnostics } : {}),
  };
}

type EmergencyEvidence = Readonly<{ path: string; process?: unknown }>;

async function listDiagnosticPaths(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).map((entry) => path.join(directory, entry)).toSorted();
  } catch (error) {
    return isNotFound(error) ? [] : [directory];
  }
}

async function quarantineMalformedRegistry(
  registryPath: string,
  quarantineDirectory: string,
  reason = 'registry_structure_invalid'
): Promise<string | undefined> {
  try {
    const identity = await lstat(registryPath);
    if (!identity.isFile() || identity.isSymbolicLink()) return registryPath;
    await mkdir(quarantineDirectory, { recursive: true });
    const target = path.join(quarantineDirectory, `agent-process-registry.${reason}.${randomUUID()}.json`);
    await rename(registryPath, target);
    await syncDirectory(path.dirname(registryPath));
    await syncDirectory(quarantineDirectory);
    return target;
  } catch (error) {
    return isNotFound(error) ? undefined : registryPath;
  }
}

async function writeQuarantineEntries(directory: string, entries: readonly unknown[]): Promise<string> {
  const target = path.join(directory, `agent-process-registry.entries.${randomUUID()}.json`);
  await writeAtomicPayload(
    target,
    `${JSON.stringify({ version: 1, reason: 'malformed_registry_entries', entries }, null, 2)}\n`
  );
  return target;
}

async function readEmergencyEvidence(directory: string): Promise<EmergencyEvidence[]> {
  let entries: string[];
  try {
    entries = (await readdir(directory)).toSorted();
  } catch (error) {
    return isNotFound(error) ? [] : [{ path: directory }];
  }
  return Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(directory, entry);
      try {
        const identity = await lstat(filePath);
        if (!identity.isFile() || identity.isSymbolicLink()) return { path: filePath };
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
        if (
          !isPlainObject(parsed) ||
          !hasExactKeys(parsed, EMERGENCY_REQUIRED_KEYS) ||
          parsed.version !== 1 ||
          parsed.reason !== 'registry_write_failed_cleanup_unproven'
        ) {
          return { path: filePath };
        }
        return { path: filePath, process: parsed.process };
      } catch {
        return { path: filePath };
      }
    })
  );
}

async function removeEmergencyEvidence(filePath: string, directory: string): Promise<void> {
  try {
    const identity = await lstat(filePath);
    if (!identity.isFile() || identity.isSymbolicLink()) return;
    await rm(filePath);
    await syncDirectory(directory);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function normalizeUnprovenRegistryEntry(value: unknown): CanonicalAgentProcessV2 | undefined {
  if (!isPlainObject(value)) return undefined;
  const required = ['agent_type', 'conversation_id', 'pid', 'registered_at_ms'] as const;
  const optional = [...ENTRY_OPTIONAL_KEYS, 'process_identity'] as const;
  if (!hasExactKeys(value, required, optional)) return undefined;
  if (
    !isPositiveU32(value.pid) ||
    !isNonNegativeSafeInteger(value.registered_at_ms) ||
    typeof value.conversation_id !== 'string' ||
    typeof value.agent_type !== 'string' ||
    (value.backend !== undefined && typeof value.backend !== 'string') ||
    (value.command_preview !== undefined && typeof value.command_preview !== 'string') ||
    (value.process_group_id !== undefined && !isPositiveU32(value.process_group_id)) ||
    (value.process_identity !== undefined && value.process_identity !== null)
  ) {
    return undefined;
  }
  const processGroupId = value.process_group_id as number | undefined;
  const backend = value.backend as string | undefined;
  const commandPreview = value.command_preview as string | undefined;
  return {
    pid: value.pid,
    ...(processGroupId === undefined ? {} : { process_group_id: processGroupId }),
    conversation_id: value.conversation_id,
    agent_type: value.agent_type,
    ...(backend === undefined ? {} : { backend }),
    ...(commandPreview === undefined ? {} : { command_preview: commandPreview }),
    registered_at_ms: value.registered_at_ms,
    process_identity: null,
  };
}

async function observeUnprovenProcessAbsence(value: unknown, timeoutMs: number): Promise<boolean> {
  if (!isPlainObject(value) || !isPositiveU32(value.pid)) return false;
  if ((await observeNumericTargetAbsence(value.pid, timeoutMs)) !== 'absent') return false;
  if (process.platform === 'win32' || !isPositiveU32(value.process_group_id) || value.process_group_id <= 1) {
    return true;
  }
  return (await observeNumericTargetAbsence(-value.process_group_id, timeoutMs)) === 'absent';
}

async function observeNumericTargetAbsence(
  target: number,
  timeoutMs: number,
  intervalMs = 100
): Promise<'absent' | 'present' | 'unknown'> {
  const deadline = Date.now() + timeoutMs;
  let last: 'present' | 'unknown' = 'present';
  let first = true;
  while (first || Date.now() <= deadline) {
    first = false;
    try {
      process.kill(target, 0);
      last = 'present';
    } catch (error) {
      if (isProcessAbsent(error)) return 'absent';
      last = 'unknown';
    }
    if (Date.now() >= deadline) return last;
    // oxlint-disable-next-line no-await-in-loop -- absence requires ordered observations across the grace window
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return last;
}

async function readRegistry(registryPath: string): Promise<ReadRegistryResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    if (!isPlainObject(parsed) || !hasExactKeys(parsed, ['processes', 'version'])) {
      return { version: 0, processes: [], structurallyValid: false, reason: 'registry_structure_invalid' };
    }
    if (!Number.isSafeInteger(parsed.version) || !Array.isArray(parsed.processes)) {
      return { version: 0, processes: [], structurallyValid: false, reason: 'registry_structure_invalid' };
    }
    return {
      version: parsed.version as number,
      processes: parsed.processes,
      structurallyValid: true,
    };
  } catch (error) {
    if (isNotFound(error)) return { version: REGISTRY_VERSION, processes: [], structurallyValid: true };
    return { version: 0, processes: [], structurallyValid: false, reason: 'registry_parse_or_read_invalid' };
  }
}

async function writeRegistry(
  registryPath: string,
  registry: Readonly<{ version: number; processes: unknown[] }>
): Promise<void> {
  await writeAtomicPayload(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

async function writeAtomicPayload(targetPath: string, payload: string): Promise<void> {
  const parent = path.dirname(targetPath);
  await mkdir(parent, { recursive: true });
  const tmpPath = path.join(parent, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // rename is the publication point. Never unlink the prior registry first:
    // a crash between unlink and rename would erase the only process evidence.
    await rename(tmpPath, targetPath);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch((): undefined => undefined);
    await rm(tmpPath, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync through Node. The rename remains
    // atomic there; POSIX/macOS must not silently ignore a real fsync failure.
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close().catch((): undefined => undefined);
  }
}

async function cleanupProvenProcesses(
  entries: readonly RegisteredAgentProcessV2[],
  options: AgentProcessCleanupOptions,
  observationMs: number
): Promise<Readonly<{ survivors: RegisteredAgentProcessV2[] }>> {
  if (entries.length === 0) return { survivors: [] };
  let session: RegisteredAgentProcessIdentityProbeSession | undefined;
  try {
    session = options.identityProbeProvider ? await options.identityProbeProvider.open() : undefined;
  } catch {
    session = undefined;
  }
  const probeMany: RegisteredAgentProcessIdentityBatchProbe = session
    ? session.probeMany
    : async (candidates) =>
        Promise.all(candidates.map((entry) => probeRegisteredProcess(entry, options.identityProbe)));
  const safeProbeMany: RegisteredAgentProcessIdentityBatchProbe = async (candidates) => {
    try {
      const results = await probeMany(candidates);
      return results.length === candidates.length ? results : candidates.map(() => 'unknown' as const);
    } catch {
      return candidates.map(() => 'unknown' as const);
    }
  };

  try {
    const firstObservations = await probeRegisteredProcessTrees(entries, safeProbeMany, observationMs);
    const termOutcomes = await Promise.all(
      entries.map(async (entry, index) => {
        const observed = firstObservations[index];
        if (observed === 'absent') return 'absent' as const;
        if (observed !== 'match') return 'unproven' as const;
        return signalMatchedProcess(entry, 'SIGTERM', safeProbeMany);
      })
    );
    const afterTerm = entries.filter((_entry, index) => termOutcomes[index] !== 'absent');

    if (afterTerm.length > 0) await delay(observationMs);
    const killObservations = await probeRegisteredProcessTrees(afterTerm, safeProbeMany, observationMs);
    const killOutcomes = await Promise.all(
      afterTerm.map(async (entry, index) => {
        const observed = killObservations[index];
        if (observed === 'absent') return 'absent' as const;
        if (observed !== 'match') return 'unproven' as const;
        return signalMatchedProcess(entry, 'SIGKILL', safeProbeMany);
      })
    );
    const afterKill = afterTerm.filter((_entry, index) => killOutcomes[index] !== 'absent');

    const finalObservations = await probeRegisteredProcessTrees(afterKill, safeProbeMany, observationMs);
    return {
      survivors: afterKill.filter((_entry, index) => finalObservations[index] !== 'absent'),
    };
  } finally {
    await session?.close();
  }
}

async function signalMatchedProcess(
  entry: RegisteredAgentProcessV2,
  signal: 'SIGTERM' | 'SIGKILL',
  revalidate: RegisteredAgentProcessIdentityBatchProbe
): Promise<'signalled' | 'absent' | 'unproven'> {
  const [immediate] = await revalidate([entry]);
  if (immediate !== 'match') return 'unproven';
  if (process.platform === 'win32') {
    await runTaskkill(entry.pid, signal === 'SIGKILL');
    return 'signalled';
  }
  const target = entry.process_group_id && entry.process_group_id > 1 ? -entry.process_group_id : entry.pid;
  try {
    process.kill(target, signal);
    return 'signalled';
  } catch (error) {
    if (!isProcessAbsent(error)) return 'unproven';
    if (target === entry.pid) return 'absent';
    const [fallbackObserved] = await revalidate([entry]);
    if (fallbackObserved === 'absent') return 'absent';
    if (fallbackObserved !== 'match') return 'unproven';
    try {
      process.kill(entry.pid, signal);
      return 'signalled';
    } catch (fallbackError) {
      return isProcessAbsent(fallbackError) ? 'absent' : 'unproven';
    }
  }
}

async function probeRegisteredProcessTrees(
  entries: readonly RegisteredAgentProcessV2[],
  probeMany: RegisteredAgentProcessIdentityBatchProbe,
  observationMs: number
): Promise<RegisteredAgentProcessIdentityProbeResult[]> {
  const leaders = await probeMany(entries);
  return Promise.all(
    entries.map(async (entry, index) => {
      const leader = leaders[index] ?? 'unknown';
      if (leader !== 'absent') return leader;
      if (process.platform === 'win32' || !entry.process_group_id || entry.process_group_id <= 1) return 'absent';
      return (await observeNumericTargetAbsence(-entry.process_group_id, observationMs)) === 'absent'
        ? 'absent'
        : 'unknown';
    })
  );
}

async function probeRegisteredProcess(
  entry: RegisteredAgentProcessV2,
  identityProbe: RegisteredAgentProcessIdentityProbe | undefined
): Promise<RegisteredAgentProcessIdentityProbeResult> {
  if (!identityProbe) return 'unknown';
  try {
    return await identityProbe(entry);
  } catch {
    return 'unknown';
  }
}

function isRegisteredProcessV2(value: unknown): value is RegisteredAgentProcessV2 {
  if (!isPlainObject(value) || !hasExactKeys(value, ENTRY_REQUIRED_KEYS, ENTRY_OPTIONAL_KEYS)) return false;
  if (!isPositiveU32(value.pid) || !isNonNegativeSafeInteger(value.registered_at_ms)) return false;
  if (
    typeof value.conversation_id !== 'string' ||
    typeof value.agent_type !== 'string' ||
    (value.backend !== undefined && typeof value.backend !== 'string') ||
    (value.command_preview !== undefined && typeof value.command_preview !== 'string') ||
    (value.process_group_id !== undefined && !isPositiveU32(value.process_group_id))
  ) {
    return false;
  }
  return isRegisteredProcessIdentity(value.process_identity);
}

function isRegisteredProcessIdentity(value: unknown): value is RegisteredAgentProcessIdentity {
  if (!isPlainObject(value) || !hasExactKeys(value, ['executable_path', 'parent_pid', 'platform', 'start_time'])) {
    return false;
  }
  if (!['darwin', 'linux', 'win32'].includes(String(value.platform))) return false;
  if (
    !isPositiveU32(value.parent_pid) ||
    typeof value.executable_path !== 'string' ||
    value.executable_path.length === 0
  ) {
    return false;
  }
  const startTime = value.start_time;
  if (!isPlainObject(startTime) || !hasExactKeys(startTime, ['kind', 'value'])) return false;
  const expectedKind = {
    darwin: 'unix_epoch_us',
    linux: 'linux_boot_ticks',
    win32: 'windows_filetime_100ns',
  }[value.platform as 'darwin' | 'linux' | 'win32'];
  const exactValue =
    value.platform === 'linux'
      ? typeof startTime.value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9]+$/.test(startTime.value)
      : typeof startTime.value === 'string' && /^[0-9]+$/.test(startTime.value);
  return startTime.kind === expectedKind && exactValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value).toSorted();
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function isPositiveU32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffff_ffff;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function numericPids(entries: readonly unknown[]): number[] {
  return [
    ...new Set(entries.flatMap((entry) => (isPlainObject(entry) && isPositiveU32(entry.pid) ? [entry.pid] : []))),
  ];
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isProcessAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.unshift('/F');

    try {
      const child = spawn('taskkill', args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    } catch {
      resolve();
    }
  });
}
