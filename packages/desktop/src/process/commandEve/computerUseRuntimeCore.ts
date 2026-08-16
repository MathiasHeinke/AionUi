/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Native Hermes 0.20 Computer Use readiness, install and permission adapter. */

import {
  COMMAND_EVE_COMPUTER_USE_VERSION,
  type CommandEveComputerUseActionResult,
  type CommandEveComputerUseCheck,
  type CommandEveComputerUseStatus,
} from '@/common/config/eveComputerUseCore';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCommandEveRuntimeBootstrapPaths } from './runtimeBootstrapCore';

export const COMMAND_EVE_CUA_DRIVER_PIN = '0.12.6' as const;
export const COMMAND_EVE_CUA_DRIVER_RELEASE = `cua-driver-rs-v${COMMAND_EVE_CUA_DRIVER_PIN}` as const;
export const COMMAND_EVE_CUA_DRIVER_IDENTITY = 'com.trycua.driver' as const;
export const COMMAND_EVE_CUA_DRIVER_TEAM_IDENTIFIER = 'YCK386LBJ7' as const;

/**
 * SHA-256 of the executable inside the upstream v0.12.6 release assets. The
 * containing archives were first verified against the checksums published on
 * https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.12.6.
 */
export const COMMAND_EVE_CUA_DRIVER_EXECUTABLE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'darwin:arm64': 'eae725a09e0cdbda4bb37058a0393b86f7c97b5dda3769a10b1d79269ba8b334',
  'darwin:x64': 'eae725a09e0cdbda4bb37058a0393b86f7c97b5dda3769a10b1d79269ba8b334',
  'linux:arm64': 'f32b1ae084f5c7b433ad4f2b6ce203902f6ab59a69973f5807e7ac91d611f041',
  'linux:x64': '6cc18baf126f63e08363d646b9f681cd5e4e410ae0070cce341c70deb1d71b96',
  'win32:arm64': 'af2f0f27234c86401434ee9e38d29630574fe474b9ba7dafd28740e94a729755',
  'win32:x64': '14ba822d54349bce279263eecab572f91df828291bde2f543833c07115f10acd',
});

const STATUS_TIMEOUT_MS = 30_000;
const DOCTOR_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const GRANT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const DRIVER_RESOLVER = String.raw`
import json
import os
from tools.computer_use.cua_backend import resolve_cua_driver_cmd

resolved = resolve_cua_driver_cmd()
print(json.dumps({
    "path": resolved,
    "resolution": "HERMES_CUA_DRIVER_CMD" if os.environ.get("HERMES_CUA_DRIVER_CMD", "").strip() else "PATH_OR_CANONICAL_LOCATION",
}))
`;

export type CommandEveComputerUseRunnerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type CommandEveComputerUseRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
) => Promise<CommandEveComputerUseRunnerResult>;

export type CommandEveComputerUseNativeIntent = {
  readonly version: 'command-eve-computer-use-native-intent/v1';
  readonly action: 'install' | 'grant';
  readonly seatId: string;
  readonly revision: number;
  readonly issuedAt: number;
};

const issuedNativeIntents = new WeakSet<CommandEveComputerUseNativeIntent>();

/** MAIN-only factory. Object identity is the one-shot capability. */
export function issueCommandEveComputerUseNativeIntent(
  action: CommandEveComputerUseNativeIntent['action'],
  scope: { seatId: string; revision: number },
  now = Date.now()
): CommandEveComputerUseNativeIntent {
  const intent = Object.freeze({
    version: 'command-eve-computer-use-native-intent/v1' as const,
    action,
    seatId: scope.seatId,
    revision: scope.revision,
    issuedAt: now,
  });
  issuedNativeIntents.add(intent);
  return intent;
}

function consumeNativeIntent(
  intent: CommandEveComputerUseNativeIntent | undefined,
  action: CommandEveComputerUseNativeIntent['action'],
  now = Date.now()
): boolean {
  if (!intent || !issuedNativeIntents.has(intent)) return false;
  issuedNativeIntents.delete(intent);
  return intent.action === action && now - intent.issuedAt >= 0 && now - intent.issuedAt <= 60_000;
}

export type CommandEveComputerUseOptions = {
  userDataPath: string;
  runner?: CommandEveComputerUseRunner;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  nativeIntent?: CommandEveComputerUseNativeIntent;
  /** Vitest-only trust injection; ignored outside NODE_ENV=test. */
  testTrust?: {
    executableSha256: string;
    identity?: string;
    teamIdentifier?: string;
  };
};

const defaultRunner: CommandEveComputerUseRunner = (command, args, options) =>
  new Promise((resolve) => {
    childProcess.execFile(
      command,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        const exitError = error as (Error & { code?: number | string | null }) | null;
        resolve({
          status: typeof exitError?.code === 'number' ? exitError.code : error ? null : 0,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          ...(error ? { error: error.message } : {}),
        });
      }
    );
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function bounded(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeChecks(value: unknown): CommandEveComputerUseCheck[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .slice(0, 128)
    .map((check) => ({
      label: bounded(check.label || check.name, 160),
      status: bounded(check.status, 80),
      message: bounded(check.message || check.detail, 1_000),
    }))
    .filter((check) => check.label || check.message);
}

function runtime(options: CommandEveComputerUseOptions) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const paths = resolveCommandEveRuntimeBootstrapPaths(options.userDataPath, undefined, platform);
  const python =
    platform === 'win32'
      ? path.join(paths.hermesVenv, 'Scripts', 'python.exe')
      : path.join(paths.hermesVenv, 'bin', 'python');
  const homeBin = path.join(os.homedir(), '.local', 'bin');
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
  const base = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ...base,
    HERMES_HOME: paths.hermesHome,
    HERMES_DESKTOP: '1',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: base.CUA_DRIVER_RS_TELEMETRY_ENABLED === '1' ? '1' : '0',
    PATH: [path.dirname(paths.hermesShim), homeBin, cargoBin, '/opt/homebrew/bin', '/usr/local/bin', base.PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  return { platform, arch, paths, python, env };
}

function trustFor(options: CommandEveComputerUseOptions, platform: NodeJS.Platform, arch: string) {
  const injected = process.env.NODE_ENV === 'test' ? options.testTrust : undefined;
  return {
    executableSha256:
      injected?.executableSha256 ?? COMMAND_EVE_CUA_DRIVER_EXECUTABLE_SHA256[`${platform}:${arch}`] ?? null,
    identity: platform === 'darwin' ? (injected?.identity ?? COMMAND_EVE_CUA_DRIVER_IDENTITY) : null,
    teamIdentifier: platform === 'darwin' ? (injected?.teamIdentifier ?? COMMAND_EVE_CUA_DRIVER_TEAM_IDENTIFIER) : null,
  };
}

async function sha256File(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function emptyProvenance(platform: NodeJS.Platform, arch = process.arch): CommandEveComputerUseStatus['provenance'] {
  const trust = trustFor({ userDataPath: '' }, platform, arch);
  return {
    resolution: 'missing',
    executable_name: null,
    executable_sha256: null,
    expected_executable_sha256: trust.executableSha256,
    checksum_verified: false,
    driver_version: null,
    expected_version: COMMAND_EVE_CUA_DRIVER_PIN,
    release_tag: COMMAND_EVE_CUA_DRIVER_RELEASE,
    expected_identity: trust.identity,
    expected_team_identifier: trust.teamIdentifier,
    installer_source: 'hermes-0.20-upstream-pinned',
    identity: null,
    team_identifier: null,
    signature_valid: null,
  };
}

function unavailable(
  platform: NodeJS.Platform,
  reasonCode: string,
  message: string,
  state: CommandEveComputerUseStatus['state'] = 'failed'
): CommandEveComputerUseStatus {
  return {
    version: COMMAND_EVE_COMPUTER_USE_VERSION,
    ok: false,
    state,
    platform,
    platform_supported: ['darwin', 'win32', 'linux'].includes(platform),
    installed: false,
    ready: null,
    can_install: false,
    can_grant: platform === 'darwin',
    can_revoke_automatically: false,
    accessibility: null,
    screen_recording: null,
    screen_recording_capturable: null,
    checks: [],
    provenance: emptyProvenance(platform),
    reason_code: reasonCode,
    message,
  };
}

async function resolveDriver(
  python: string,
  env: NodeJS.ProcessEnv,
  runner: CommandEveComputerUseRunner
): Promise<{ filePath: string | null; resolution: CommandEveComputerUseStatus['provenance']['resolution'] }> {
  const result = await runner(python, ['-c', DRIVER_RESOLVER], { env, timeoutMs: STATUS_TIMEOUT_MS });
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!isRecord(parsed)) return { filePath: null, resolution: 'unknown' };
    const candidate = bounded(parsed.path, 4_096);
    if (!candidate || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) {
      return { filePath: null, resolution: candidate ? 'unknown' : 'missing' };
    }
    return {
      filePath: fs.realpathSync(candidate),
      resolution:
        parsed.resolution === 'HERMES_CUA_DRIVER_CMD' ? 'HERMES_CUA_DRIVER_CMD' : 'PATH_OR_CANONICAL_LOCATION',
    };
  } catch {
    return { filePath: null, resolution: 'unknown' };
  }
}

async function inspectSignature(
  driverPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  runner: CommandEveComputerUseRunner,
  expectedIdentity: string | null,
  expectedTeamIdentifier: string | null
): Promise<Pick<CommandEveComputerUseStatus['provenance'], 'identity' | 'team_identifier' | 'signature_valid'>> {
  if (platform !== 'darwin') return { identity: null, team_identifier: null, signature_valid: null };
  if (!expectedIdentity || !expectedTeamIdentifier)
    return { identity: null, team_identifier: null, signature_valid: false };
  const requirement = `=identifier "${expectedIdentity}" and anchor apple generic and certificate leaf[subject.OU] = "${expectedTeamIdentifier}"`;
  const verification = await runner(
    '/usr/bin/codesign',
    ['--verify', '--strict', `--test-requirement=${requirement}`, driverPath],
    {
      env,
      timeoutMs: STATUS_TIMEOUT_MS,
    }
  );
  const details = await runner('/usr/bin/codesign', ['-dv', '--verbose=4', driverPath], {
    env,
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  const text = `${details.stdout}\n${details.stderr}`;
  const identity = /Identifier=([^\n\r]+)/.exec(text)?.[1]?.trim() || null;
  const teamIdentifier = /TeamIdentifier=([^\n\r]+)/.exec(text)?.[1]?.trim() || null;
  return {
    identity,
    team_identifier: teamIdentifier,
    signature_valid: verification.status === 0 && details.status === 0,
  };
}

function driverVersionMatchesPin(version: string | null): boolean {
  if (!version) return false;
  return (
    version.match(/\d+\.\d+\.\d+/g)?.some((candidate: string) => candidate === COMMAND_EVE_CUA_DRIVER_PIN) === true
  );
}

/** Read native permission state, doctor checks and exact resolved-binary provenance. */
export async function readCommandEveComputerUseStatus(
  options: CommandEveComputerUseOptions
): Promise<CommandEveComputerUseStatus> {
  let resolved: ReturnType<typeof runtime>;
  try {
    resolved = runtime(options);
  } catch (error) {
    return unavailable(
      options.platform ?? process.platform,
      'COMPUTER_USE_SEAT_SCOPE_INVALID',
      error instanceof Error ? error.message : 'Computer Use seat scope is invalid.'
    );
  }
  if (!fs.existsSync(resolved.paths.hermesShim) || !fs.existsSync(resolved.python)) {
    return unavailable(
      resolved.platform,
      'HERMES_RUNTIME_NOT_READY',
      'The app-managed Hermes runtime is not ready.',
      'needs_user'
    );
  }

  const runner = options.runner ?? defaultRunner;
  const permissionResult = await runner(
    resolved.paths.hermesShim,
    ['computer-use', 'permissions', 'status', '--json'],
    { env: resolved.env, timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS }
  );
  let permission: Record<string, unknown>;
  try {
    const parsed = JSON.parse(permissionResult.stdout.trim()) as unknown;
    if (!isRecord(parsed)) throw new Error('not an object');
    permission = parsed;
  } catch {
    return unavailable(
      resolved.platform,
      'COMPUTER_USE_STATUS_UNAVAILABLE',
      permissionResult.error ||
        bounded(permissionResult.stderr, 1_000) ||
        'Hermes did not return Computer Use permission state.'
    );
  }

  const installed = permission.installed === true;
  const driver = await resolveDriver(resolved.python, resolved.env, runner);
  const trust = trustFor(options, resolved.platform, resolved.arch);
  let doctor: Record<string, unknown> = {};
  let doctorOverall: 'ok' | 'degraded' | 'failed' | null = null;
  let doctorContractValid = false;
  let doctorReady = false;
  let doctorIssue = '';
  if (installed) {
    const doctorResult = await runner(resolved.paths.hermesShim, ['computer-use', 'doctor', '--json'], {
      env: resolved.env,
      timeoutMs: options.timeoutMs ?? DOCTOR_TIMEOUT_MS,
    });
    try {
      const parsed = JSON.parse(doctorResult.stdout.trim()) as unknown;
      if (!isRecord(parsed)) throw new Error('doctor payload is not an object');
      doctor = parsed;
      const schemaVersion = bounded(parsed.schema_version, 20);
      const overall = bounded(parsed.overall, 32);
      if (schemaVersion !== '1' || !Array.isArray(parsed.checks) || !['ok', 'degraded', 'failed'].includes(overall)) {
        throw new Error('doctor returned an unknown schema or overall state');
      }
      doctorOverall = overall as typeof doctorOverall;
      const expectedStatus = overall === 'ok' ? 0 : 1;
      doctorContractValid = doctorResult.status === expectedStatus;
      doctorReady = doctorContractValid && overall === 'ok';
      if (!doctorContractValid) {
        doctorIssue = `Doctor exit ${String(doctorResult.status)} contradicted overall=${overall}.`;
      } else if (!doctorReady) {
        doctorIssue = `Doctor reported overall=${overall}.`;
      }
    } catch {
      doctorIssue =
        doctorResult.error || bounded(doctorResult.stderr, 1_000) || 'Doctor returned no valid schema_version=1 JSON.';
      if (!Array.isArray(doctor.checks)) doctor = { checks: [] };
    }
  }

  const signature = driver.filePath
    ? await inspectSignature(
        driver.filePath,
        resolved.platform,
        resolved.env,
        runner,
        trust.identity,
        trust.teamIdentifier
      )
    : { identity: null, team_identifier: null, signature_valid: null };
  const executableSha256 = driver.filePath ? await sha256File(driver.filePath) : null;
  const version = bounded(permission.version, 160) || bounded(doctor.driver_version, 160) || null;
  const nativeReady = nullableBoolean(permission.ready);
  const permissionChecks = normalizeChecks(permission.checks);
  const doctorChecks = normalizeChecks(doctor.checks);
  const diagnosticChecks = doctorIssue
    ? [{ label: 'doctor', status: doctorReady ? 'pass' : 'fail', message: doctorIssue }]
    : [];
  const checks = [...permissionChecks, ...doctorChecks, ...diagnosticChecks].filter(
    (check, index, list) =>
      list.findIndex((candidate) => candidate.label === check.label && candidate.message === check.message) === index
  );
  const platformSupported = permission.platform_supported === true;
  const driverResolved = driver.filePath !== null;
  const versionVerified = driverVersionMatchesPin(version);
  const checksumVerified =
    trust.executableSha256 !== null && executableSha256 !== null && executableSha256 === trust.executableSha256;
  const signatureVerified =
    resolved.platform !== 'darwin' ||
    (signature.signature_valid === true &&
      signature.identity === trust.identity &&
      signature.team_identifier === trust.teamIdentifier);
  const provenanceVerified = driverResolved && versionVerified && checksumVerified && signatureVerified;
  const accessibility = nullableBoolean(permission.accessibility);
  const screenRecording = nullableBoolean(permission.screen_recording);
  const screenRecordingCapturable = nullableBoolean(permission.screen_recording_capturable);
  const osPermissionMissing =
    resolved.platform === 'darwin' &&
    permission.can_grant === true &&
    (accessibility !== true || screenRecording !== true || screenRecordingCapturable !== true);
  const knownPermissionDegradation = osPermissionMissing && doctorContractValid && doctorOverall === 'degraded';
  const ready = nativeReady === true && provenanceVerified && doctorReady;
  const state: CommandEveComputerUseStatus['state'] = !platformSupported
    ? 'blocked'
    : !installed
      ? 'needs_install'
      : !provenanceVerified
        ? 'needs_user'
        : ready
          ? 'ready'
          : knownPermissionDegradation
            ? 'needs_permission'
            : 'needs_user';

  const problem = !platformSupported
    ? { reason_code: 'COMPUTER_USE_PLATFORM_UNSUPPORTED', message: 'Computer Use is unavailable on this platform.' }
    : !installed
      ? { reason_code: 'CUA_DRIVER_MISSING', message: `Install the pinned cua-driver ${COMMAND_EVE_CUA_DRIVER_PIN}.` }
      : !driverResolved
        ? {
            reason_code: 'CUA_DRIVER_PROVENANCE_UNRESOLVED',
            message: 'Hermes reported cua-driver as installed, but its executable could not be resolved.',
          }
        : !versionVerified
          ? {
              reason_code: 'CUA_DRIVER_VERSION_MISMATCH',
              message: `cua-driver must match pin ${COMMAND_EVE_CUA_DRIVER_PIN}. Use the official ${COMMAND_EVE_CUA_DRIVER_RELEASE} uninstall flow before reinstalling; Hermes cannot safely downgrade an already-current driver.`,
            }
          : !checksumVerified
            ? {
                reason_code: 'CUA_DRIVER_CHECKSUM_MISMATCH',
                message: `cua-driver does not match the executable hash audited from ${COMMAND_EVE_CUA_DRIVER_RELEASE}. Remove it with the official tag-pinned uninstall flow before reinstalling.`,
              }
            : !signatureVerified
              ? {
                  reason_code: 'CUA_DRIVER_SIGNATURE_INVALID',
                  message: `cua-driver must satisfy the ${trust.identity ?? 'release'} / ${trust.teamIdentifier ?? 'platform'} designated requirement. Remove it before reinstalling.`,
                }
              : knownPermissionDegradation
                ? {
                    reason_code: 'COMPUTER_USE_NEEDS_PERMISSION',
                    message: 'Computer Use still needs an OS-owned permission.',
                  }
                : !doctorReady
                  ? {
                      reason_code: 'COMPUTER_USE_DOCTOR_FAILED',
                      message: doctorIssue || 'Computer Use doctor did not report overall=ok.',
                    }
                  : ready !== true
                    ? {
                        reason_code: 'COMPUTER_USE_NEEDS_PERMISSION',
                        message: 'Computer Use still needs an OS-owned permission.',
                      }
                    : {};

  return {
    version: COMMAND_EVE_COMPUTER_USE_VERSION,
    ok: true,
    state,
    platform: bounded(permission.platform, 80) || resolved.platform,
    platform_supported: platformSupported,
    installed,
    ready,
    can_install: permission.platform_supported === true,
    can_grant: permission.can_grant === true,
    can_revoke_automatically: false,
    accessibility,
    screen_recording: screenRecording,
    screen_recording_capturable: screenRecordingCapturable,
    checks,
    provenance: {
      resolution: driver.resolution,
      executable_name: driver.filePath ? path.basename(driver.filePath) : null,
      executable_sha256: executableSha256,
      expected_executable_sha256: trust.executableSha256,
      checksum_verified: checksumVerified,
      driver_version: version,
      expected_version: COMMAND_EVE_CUA_DRIVER_PIN,
      release_tag: COMMAND_EVE_CUA_DRIVER_RELEASE,
      expected_identity: trust.identity,
      expected_team_identifier: trust.teamIdentifier,
      installer_source: 'hermes-0.20-upstream-pinned',
      ...signature,
    },
    ...problem,
  };
}

async function runAction(
  options: CommandEveComputerUseOptions,
  args: string[],
  timeoutMs: number,
  envPatch: NodeJS.ProcessEnv = {}
): Promise<CommandEveComputerUseActionResult> {
  let resolved: ReturnType<typeof runtime>;
  try {
    resolved = runtime(options);
  } catch (error) {
    return {
      version: COMMAND_EVE_COMPUTER_USE_VERSION,
      ok: false,
      state: 'blocked',
      reason_code: 'COMPUTER_USE_SEAT_SCOPE_INVALID',
      message: error instanceof Error ? error.message : 'Computer Use seat scope is invalid.',
    };
  }
  if (!fs.existsSync(resolved.paths.hermesShim)) {
    return {
      version: COMMAND_EVE_COMPUTER_USE_VERSION,
      ok: false,
      state: 'needs_user',
      reason_code: 'HERMES_RUNTIME_NOT_READY',
      message: 'The app-managed Hermes runtime is not ready.',
    };
  }
  const result = await (options.runner ?? defaultRunner)(resolved.paths.hermesShim, args, {
    env: { ...resolved.env, ...envPatch },
    timeoutMs: options.timeoutMs ?? timeoutMs,
  });
  if (result.status === 0) return { version: COMMAND_EVE_COMPUTER_USE_VERSION, ok: true, state: 'ready' };
  return {
    version: COMMAND_EVE_COMPUTER_USE_VERSION,
    ok: false,
    state: 'blocked',
    reason_code: 'COMPUTER_USE_NATIVE_ACTION_FAILED',
    message:
      result.error || bounded(result.stderr, 1_000) || bounded(result.stdout, 1_000) || 'Hermes rejected the action.',
  };
}

/** Explicit user action only: run Hermes' installer with the audited exact pin. */
export async function installCommandEveComputerUseDriver(
  options: CommandEveComputerUseOptions
): Promise<CommandEveComputerUseActionResult> {
  if (!consumeNativeIntent(options.nativeIntent, 'install')) {
    return {
      version: COMMAND_EVE_COMPUTER_USE_VERSION,
      ok: false,
      state: 'blocked',
      reason_code: 'COMPUTER_USE_CONFIRMATION_REQUIRED',
      message: 'A fresh MAIN-owned install confirmation is required.',
    };
  }
  const installed = await runAction(options, ['computer-use', 'install', '--upgrade'], INSTALL_TIMEOUT_MS, {
    CUA_DRIVER_RS_VERSION: COMMAND_EVE_CUA_DRIVER_PIN,
  });
  if (!installed.ok) return installed;
  const status = await readCommandEveComputerUseStatus(options);
  const versionVerified = driverVersionMatchesPin(status.provenance.driver_version);
  const signatureVerified =
    (options.platform ?? process.platform) !== 'darwin' ||
    (status.provenance.signature_valid === true &&
      status.provenance.identity === status.provenance.expected_identity &&
      status.provenance.team_identifier === status.provenance.expected_team_identifier);
  if (!status.installed || !versionVerified || !status.provenance.checksum_verified || !signatureVerified) {
    return {
      version: COMMAND_EVE_COMPUTER_USE_VERSION,
      ok: false,
      state: 'blocked',
      reason_code: 'CUA_DRIVER_PROVENANCE_MISMATCH',
      message: `cua-driver install finished, but version, executable checksum and platform signature did not all match ${COMMAND_EVE_CUA_DRIVER_RELEASE}.`,
    };
  }
  return installed;
}

/** Explicit user action only: launch CuaDriver's macOS-owned TCC grant flow. */
export async function grantCommandEveComputerUsePermissions(
  options: CommandEveComputerUseOptions
): Promise<CommandEveComputerUseActionResult> {
  if (!consumeNativeIntent(options.nativeIntent, 'grant')) {
    return {
      version: COMMAND_EVE_COMPUTER_USE_VERSION,
      ok: false,
      state: 'blocked',
      reason_code: 'COMPUTER_USE_CONFIRMATION_REQUIRED',
      message: 'A fresh MAIN-owned permission confirmation is required.',
    };
  }
  if ((options.platform ?? process.platform) !== 'darwin') {
    return {
      version: COMMAND_EVE_COMPUTER_USE_VERSION,
      ok: false,
      state: 'needs_user',
      reason_code: 'COMPUTER_USE_GRANT_NOT_APPLICABLE',
      message: 'This platform has no macOS TCC grant flow.',
    };
  }
  const status = await readCommandEveComputerUseStatus(options);
  if (
    !status.installed ||
    !status.provenance.checksum_verified ||
    status.provenance.identity !== status.provenance.expected_identity ||
    status.provenance.team_identifier !== status.provenance.expected_team_identifier ||
    status.provenance.signature_valid !== true ||
    !driverVersionMatchesPin(status.provenance.driver_version)
  ) {
    return {
      version: COMMAND_EVE_COMPUTER_USE_VERSION,
      ok: false,
      state: 'blocked',
      reason_code: 'CUA_DRIVER_PROVENANCE_MISMATCH',
      message: 'Permission grant refused until the pinned, signed cua-driver is verified.',
    };
  }
  return runAction(options, ['computer-use', 'permissions', 'grant'], GRANT_TIMEOUT_MS);
}

/**
 * Upstream 0.20 has no revoke command. Never synthesize one with `tccutil`:
 * revocation stays a visible System Settings action owned by the user.
 */
export function revokeCommandEveComputerUsePermissionsGuide(): CommandEveComputerUseActionResult {
  return {
    version: COMMAND_EVE_COMPUTER_USE_VERSION,
    ok: false,
    state: 'needs_user',
    reason_code: 'COMPUTER_USE_REVOKE_OS_OWNED',
    message:
      'Revoke CuaDriver (com.trycua.driver) in System Settings > Privacy & Security > Accessibility and Screen Recording, then refresh.',
  };
}
