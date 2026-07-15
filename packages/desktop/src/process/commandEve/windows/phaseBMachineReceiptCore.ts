/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsGateAssertionReceipt } from './types';

export const PHASE_B_MACHINE_FACTS_SCHEMA_VERSION = 'command-eve-windows-phase-b-machine-facts/v1' as const;

export type PhaseBMemoryClass = 'lowmem-8gb' | 'normal-16gb';

export type PhaseBMachineFactsV1 = {
  schema_version: typeof PHASE_B_MACHINE_FACTS_SCHEMA_VERSION;
  collected_at: string;
  collection_errors: string[];
  host: {
    os_caption: string;
    os_version: string;
    os_build: string;
    product_type: number;
    native_architecture: string;
    process_architecture: string;
    processor_architecture_codes: number[];
    ram_bytes: number;
    logical_cpu_count: number;
  };
  user: {
    is_local_administrator: boolean | null;
    token_is_elevated: boolean | null;
    uac_enabled: boolean | null;
    secure_desktop_enabled: boolean | null;
  };
  security: {
    defender_service_running: boolean | null;
    defender_antivirus_enabled: boolean | null;
    defender_real_time_protection_enabled: boolean | null;
    defender_behavior_monitor_enabled: boolean | null;
    defender_ioav_protection_enabled: boolean | null;
    defender_tamper_protected: boolean | null;
    smart_screen_policy_enabled: boolean | null;
    smart_screen_shell_mode: string | null;
    smart_screen_app_reputation_enabled: boolean | null;
    process_creation_command_line_audit_enabled: boolean | null;
    firewall_domain_enabled: boolean | null;
    firewall_private_enabled: boolean | null;
    firewall_public_enabled: boolean | null;
  };
};

export type PhaseBMachineRejectCode =
  | 'WIN_B_MACHINE_SCHEMA_INVALID'
  | 'WIN_B_MACHINE_COLLECTION_INCOMPLETE'
  | 'WIN_B_MACHINE_FACTS_STALE'
  | 'WIN_B_OS_NOT_WINDOWS_11'
  | 'WIN_B_OS_BUILD_INVALID'
  | 'WIN_B_OS_NOT_WORKSTATION'
  | 'WIN_B_ARCH_NOT_X64'
  | 'WIN_B_MEMORY_CLASS_MISMATCH'
  | 'WIN_B_CPU_BELOW_PROFILE_MINIMUM'
  | 'WIN_B_USER_IS_ADMIN'
  | 'WIN_B_UAC_NOT_PROVEN'
  | 'WIN_B_DEFENDER_SERVICE_NOT_RUNNING'
  | 'WIN_B_DEFENDER_PROTECTION_INCOMPLETE'
  | 'WIN_B_DEFENDER_TAMPER_NOT_PROVEN'
  | 'WIN_B_SMARTSCREEN_NOT_PROVEN'
  | 'WIN_B_PROCESS_COMMAND_LINE_AUDIT_ENABLED'
  | 'WIN_B_FIREWALL_INCOMPLETE';

export type PhaseBMachineReadinessResult = {
  schema_version: 'command-eve-windows-phase-b-machine-readiness/v1';
  memory_class: PhaseBMemoryClass;
  status: 'PASS' | 'REJECT';
  reject_code: 'WIN_PHASE_B_MACHINE_REJECT' | null;
  reject_codes: PhaseBMachineRejectCode[];
  assertions: WindowsGateAssertionReceipt[];
  metrics: {
    ram_bytes: number | null;
    logical_cpu_count: number | null;
    os_build: string | null;
  };
  completion_sentinel: 'WIN_PHASE_B_MACHINE_READINESS_COMPLETE';
};

type MemoryProfileRequirement = {
  minimum_ram_bytes: number;
  maximum_ram_bytes_exclusive: number;
  minimum_logical_cpu_count: number;
};

const GIBIBYTE = 1024 ** 3;
const MAX_MACHINE_FACT_AGE_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const MINIMUM_WINDOWS_11_BUILD = 22000;
const MEMORY_PROFILE_REQUIREMENTS: Record<PhaseBMemoryClass, MemoryProfileRequirement> = {
  'lowmem-8gb': {
    minimum_ram_bytes: 7 * GIBIBYTE,
    maximum_ram_bytes_exclusive: 12 * GIBIBYTE,
    minimum_logical_cpu_count: 2,
  },
  'normal-16gb': {
    minimum_ram_bytes: 14 * GIBIBYTE,
    maximum_ram_bytes_exclusive: 24 * GIBIBYTE,
    minimum_logical_cpu_count: 4,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function machineResult(
  memoryClass: PhaseBMemoryClass,
  rejectCodes: PhaseBMachineRejectCode[],
  assertions: WindowsGateAssertionReceipt[],
  host: Record<string, unknown> | null
): PhaseBMachineReadinessResult {
  const uniqueRejectCodes = [...new Set(rejectCodes)];
  return {
    schema_version: 'command-eve-windows-phase-b-machine-readiness/v1',
    memory_class: memoryClass,
    status: uniqueRejectCodes.length === 0 ? 'PASS' : 'REJECT',
    reject_code: uniqueRejectCodes.length === 0 ? null : 'WIN_PHASE_B_MACHINE_REJECT',
    reject_codes: uniqueRejectCodes,
    assertions,
    metrics: {
      ram_bytes: isFiniteNonNegativeNumber(host?.ram_bytes) ? host.ram_bytes : null,
      logical_cpu_count: isPositiveInteger(host?.logical_cpu_count) ? host.logical_cpu_count : null,
      os_build: isNonEmptyString(host?.os_build) ? host.os_build : null,
    },
    completion_sentinel: 'WIN_PHASE_B_MACHINE_READINESS_COMPLETE',
  };
}

export function evaluatePhaseBMachineReadiness(
  input: unknown,
  memoryClass: PhaseBMemoryClass,
  nowMs = Date.now()
): PhaseBMachineReadinessResult {
  const assertions: WindowsGateAssertionReceipt[] = [];
  const rejectCodes: PhaseBMachineRejectCode[] = [];
  const addAssertion = (
    id: string,
    ok: boolean,
    rejectCode: PhaseBMachineRejectCode,
    passDetail: string,
    rejectDetail: string
  ): void => {
    assertions.push({ id, status: ok ? 'PASS' : 'REJECT', detail: ok ? passDetail : rejectDetail });
    if (!ok) rejectCodes.push(rejectCode);
  };

  if (!isRecord(input)) {
    addAssertion(
      'machine-facts-schema',
      false,
      'WIN_B_MACHINE_SCHEMA_INVALID',
      'Machine facts use the Phase B schema.',
      'Machine facts are not an object.'
    );
    return machineResult(memoryClass, rejectCodes, assertions, null);
  }

  const host = isRecord(input.host) ? input.host : null;
  const user = isRecord(input.user) ? input.user : null;
  const security = isRecord(input.security) ? input.security : null;
  const schemaValid =
    input.schema_version === PHASE_B_MACHINE_FACTS_SCHEMA_VERSION &&
    host !== null &&
    user !== null &&
    security !== null;
  addAssertion(
    'machine-facts-schema',
    schemaValid,
    'WIN_B_MACHINE_SCHEMA_INVALID',
    'Machine facts use the Phase B schema.',
    'Machine facts schema or required sections are invalid.'
  );

  const collectionErrors = Array.isArray(input.collection_errors) ? input.collection_errors : null;
  const collectionComplete =
    collectionErrors !== null &&
    collectionErrors.length === 0 &&
    isNonEmptyString(input.collected_at) &&
    Number.isFinite(Date.parse(input.collected_at));
  addAssertion(
    'machine-facts-complete',
    collectionComplete,
    'WIN_B_MACHINE_COLLECTION_INCOMPLETE',
    'Machine facts were collected without probe errors.',
    'Machine fact collection is incomplete or has probe errors.'
  );

  const collectedAtMs = isNonEmptyString(input.collected_at) ? Date.parse(input.collected_at) : Number.NaN;
  const collectionFresh =
    Number.isFinite(collectedAtMs) &&
    collectedAtMs >= nowMs - MAX_MACHINE_FACT_AGE_MS &&
    collectedAtMs <= nowMs + MAX_CLOCK_SKEW_MS;
  addAssertion(
    'machine-facts-fresh',
    collectionFresh,
    'WIN_B_MACHINE_FACTS_STALE',
    'Machine facts are fresh and the host clock is within the allowed skew.',
    'Machine facts are stale or the host clock is outside the allowed skew.'
  );

  const osCaption = isNonEmptyString(host?.os_caption) ? host.os_caption : '';
  const windows11 = /^Microsoft Windows 11\b/i.test(osCaption);
  addAssertion(
    'windows-11-client',
    windows11,
    'WIN_B_OS_NOT_WINDOWS_11',
    'Host runs Microsoft Windows 11.',
    'Host is not proven to run Microsoft Windows 11.'
  );

  const osBuildText = isNonEmptyString(host?.os_build) ? host.os_build : '';
  const osBuild = /^\d+$/.test(osBuildText) ? Number.parseInt(osBuildText, 10) : Number.NaN;
  addAssertion(
    'windows-11-build',
    Number.isInteger(osBuild) && osBuild >= MINIMUM_WINDOWS_11_BUILD,
    'WIN_B_OS_BUILD_INVALID',
    'Host build is inside the Windows 11 build range.',
    'Host build is missing or below the Windows 11 minimum.'
  );

  addAssertion(
    'windows-workstation-sku',
    host?.product_type === 1,
    'WIN_B_OS_NOT_WORKSTATION',
    'Host is a Windows workstation SKU.',
    'Host is a server or non-workstation Windows SKU.'
  );

  const architectureCodes = Array.isArray(host?.processor_architecture_codes) ? host.processor_architecture_codes : [];
  const x64Architecture =
    String(host?.native_architecture ?? '').toUpperCase() === 'AMD64' &&
    ['X64', 'AMD64'].includes(String(host?.process_architecture ?? '').toUpperCase()) &&
    architectureCodes.length > 0 &&
    architectureCodes.every((code) => code === 9);
  addAssertion(
    'native-x64-architecture',
    x64Architecture,
    'WIN_B_ARCH_NOT_X64',
    'Native OS, process, and processor architecture are x64.',
    'Native x64 architecture is not proven; emulated x64 on ARM64 is rejected.'
  );

  const profile = MEMORY_PROFILE_REQUIREMENTS[memoryClass];
  const memoryMatches =
    isFiniteNonNegativeNumber(host?.ram_bytes) &&
    host.ram_bytes >= profile.minimum_ram_bytes &&
    host.ram_bytes < profile.maximum_ram_bytes_exclusive;
  addAssertion(
    'memory-class',
    memoryMatches,
    'WIN_B_MEMORY_CLASS_MISMATCH',
    `RAM is inside the ${memoryClass} evidence band.`,
    `RAM is outside the ${memoryClass} evidence band.`
  );

  const cpuMatches =
    isPositiveInteger(host?.logical_cpu_count) && host.logical_cpu_count >= profile.minimum_logical_cpu_count;
  addAssertion(
    'cpu-profile-minimum',
    cpuMatches,
    'WIN_B_CPU_BELOW_PROFILE_MINIMUM',
    `Logical CPU count meets the ${memoryClass} minimum.`,
    `Logical CPU count is below the ${memoryClass} minimum.`
  );

  const standardUser = user?.is_local_administrator === false && user.token_is_elevated === false;
  addAssertion(
    'standard-user',
    standardUser,
    'WIN_B_USER_IS_ADMIN',
    'Current account is neither a local administrator nor elevated.',
    'Current account is an administrator, elevated, or its posture is unknown.'
  );

  const uacProven = user?.uac_enabled === true && user.secure_desktop_enabled === true;
  addAssertion(
    'uac-secure-desktop',
    uacProven,
    'WIN_B_UAC_NOT_PROVEN',
    'UAC and secure-desktop prompting are enabled.',
    'UAC or secure-desktop prompting is disabled or unknown.'
  );

  addAssertion(
    'defender-service',
    security?.defender_service_running === true && security.defender_antivirus_enabled === true,
    'WIN_B_DEFENDER_SERVICE_NOT_RUNNING',
    'Microsoft Defender Antivirus is enabled and running.',
    'Microsoft Defender Antivirus is disabled, stopped, or unknown.'
  );

  const defenderProtectionComplete =
    security?.defender_real_time_protection_enabled === true &&
    security.defender_behavior_monitor_enabled === true &&
    security.defender_ioav_protection_enabled === true;
  addAssertion(
    'defender-protection',
    defenderProtectionComplete,
    'WIN_B_DEFENDER_PROTECTION_INCOMPLETE',
    'Defender real-time, behavior, and download scanning are enabled.',
    'One or more Defender protection layers are disabled or unknown.'
  );

  addAssertion(
    'defender-tamper-protection',
    security?.defender_tamper_protected === true,
    'WIN_B_DEFENDER_TAMPER_NOT_PROVEN',
    'Defender tamper protection is enabled.',
    'Defender tamper protection is disabled or unknown.'
  );

  const smartScreenPolicyAllows =
    security?.smart_screen_policy_enabled === true || security?.smart_screen_policy_enabled === null;
  const smartScreenAppReputationAllows =
    security?.smart_screen_app_reputation_enabled === true || security?.smart_screen_app_reputation_enabled === null;
  const smartScreenProven =
    smartScreenPolicyAllows &&
    ['warn', 'requireadmin'].includes(String(security?.smart_screen_shell_mode ?? '').toLowerCase()) &&
    smartScreenAppReputationAllows;
  addAssertion(
    'smart-screen',
    smartScreenProven,
    'WIN_B_SMARTSCREEN_NOT_PROVEN',
    'SmartScreen policy, shell checks, and app reputation checks are enabled.',
    'SmartScreen is disabled, permissive, or not explicitly proven.'
  );

  const commandLineAuditDisabled =
    security?.process_creation_command_line_audit_enabled === false ||
    security?.process_creation_command_line_audit_enabled === null;
  addAssertion(
    'process-command-line-audit',
    commandLineAuditDisabled,
    'WIN_B_PROCESS_COMMAND_LINE_AUDIT_ENABLED',
    'Process-creation events do not include command-line values on this disposable lab host.',
    'Process-command-line auditing is enabled or its state is not proven.'
  );

  const firewallComplete =
    security?.firewall_domain_enabled === true &&
    security.firewall_private_enabled === true &&
    security.firewall_public_enabled === true;
  addAssertion(
    'windows-firewall',
    firewallComplete,
    'WIN_B_FIREWALL_INCOMPLETE',
    'Windows Firewall is enabled for domain, private, and public profiles.',
    'One or more Windows Firewall profiles are disabled or unknown.'
  );

  return machineResult(memoryClass, rejectCodes, assertions, host);
}
