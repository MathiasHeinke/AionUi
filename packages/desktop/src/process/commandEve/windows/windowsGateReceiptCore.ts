/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  WINDOWS_GATE_IDS,
  WINDOWS_GATE_SCHEMA_VERSION,
  type WindowsGateId,
  type WindowsGateReceiptV1,
  type WindowsGateStatus,
} from './types';

export type WindowsGateReceiptValidation = {
  ok: boolean;
  errors: string[];
};

const WINDOWS_GATE_ID_SET = new Set<string>(WINDOWS_GATE_IDS);
const WINDOWS_GATE_STATUS_SET = new Set<WindowsGateStatus>([
  'PASS',
  'REJECT',
  'BLOCKED_AUTH',
  'BLOCKED_ARTIFACT',
  'BLOCKED_ENVIRONMENT',
  'BLOCKED_EXTERNAL_APPROVAL',
]);
const ARTIFACT_BOUND_PHASE_A_GATES = new Set<WindowsGateId>(['WIN-G04', 'WIN-G05', 'WIN-G06', 'WIN-G06T', 'WIN-G07']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isRepositoryRelativePath(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

function validateSource(source: unknown, status: WindowsGateStatus | null, errors: string[]): void {
  if (!isRecord(source)) {
    errors.push('source must be an object');
    return;
  }
  if (!isNonEmptyString(source.repository)) errors.push('source.repository is required');
  if (typeof source.commit !== 'string' || !/^[0-9a-f]{40}$/.test(source.commit)) {
    errors.push('source.commit must be a 40-character lowercase SHA-1');
  }
  if (typeof source.tree_clean !== 'boolean') errors.push('source.tree_clean must be boolean');
  if (status === 'PASS' && source.tree_clean !== true) errors.push('source.tree_clean must be true for PASS');
}

function validateArtifact(
  artifact: unknown,
  gateId: WindowsGateId | null,
  status: WindowsGateStatus | null,
  errors: string[]
): void {
  if (artifact === null) {
    if (status === 'PASS' && gateId && ARTIFACT_BOUND_PHASE_A_GATES.has(gateId)) {
      errors.push(`artifact is required for ${gateId} PASS`);
    }
    return;
  }
  if (!isRecord(artifact)) {
    errors.push('artifact must be an object or null');
    return;
  }
  if (!isNonEmptyString(artifact.name)) errors.push('artifact.name is required');
  if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    errors.push('artifact.sha256 must be a 64-character lowercase SHA-256');
  }
  if (artifact.signed !== false) {
    errors.push('artifact.signed must be false for an unsigned Phase A receipt');
  }
  if (artifact.signature_subject !== null) {
    errors.push('artifact.signature_subject must be null for an unsigned Phase A receipt');
  }
}

function validateEnvironment(environment: unknown, errors: string[]): void {
  if (!isRecord(environment)) {
    errors.push('environment must be an object');
    return;
  }
  if (!isNonEmptyString(environment.os)) errors.push('environment.os is required');
  if (!isNonEmptyString(environment.os_build)) errors.push('environment.os_build is required');
  if (environment.arch !== 'x64') errors.push('environment.arch must be x64');
  if (
    typeof environment.ram_bytes !== 'number' ||
    !Number.isFinite(environment.ram_bytes) ||
    environment.ram_bytes < 0
  ) {
    errors.push('environment.ram_bytes must be a non-negative finite number');
  }
  if (!Number.isInteger(environment.cpu_count) || Number(environment.cpu_count) < 1) {
    errors.push('environment.cpu_count must be a positive integer');
  }
  if (!isNonEmptyString(environment.test_mode)) errors.push('environment.test_mode is required');
}

function validateCommands(commands: unknown, errors: string[]): void {
  if (!Array.isArray(commands)) {
    errors.push('commands must be an array');
    return;
  }
  commands.forEach((command, index) => {
    if (!isRecord(command) || !isNonEmptyString(command.command) || !Number.isInteger(command.exit_code)) {
      errors.push(`commands[${index}] is malformed`);
      return;
    }
    if (
      command.duration_ms !== undefined &&
      (!Number.isFinite(command.duration_ms) || Number(command.duration_ms) < 0)
    ) {
      errors.push(`commands[${index}].duration_ms must be a non-negative finite number`);
    }
  });
}

function validateAssertions(assertions: unknown, errors: string[]): void {
  if (!Array.isArray(assertions)) {
    errors.push('assertions must be an array');
    return;
  }
  assertions.forEach((assertion, index) => {
    if (
      !isRecord(assertion) ||
      !isNonEmptyString(assertion.id) ||
      (assertion.status !== 'PASS' && assertion.status !== 'REJECT') ||
      !isNonEmptyString(assertion.detail)
    ) {
      errors.push(`assertions[${index}] is malformed`);
    }
  });
}

export function validateWindowsGateReceipt(input: unknown): WindowsGateReceiptValidation {
  if (!isRecord(input)) return { ok: false, errors: ['receipt must be an object'] };

  const errors: string[] = [];
  if (input.schema_version !== WINDOWS_GATE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${WINDOWS_GATE_SCHEMA_VERSION}`);
  }

  const gateId =
    typeof input.gate_id === 'string' && WINDOWS_GATE_ID_SET.has(input.gate_id)
      ? (input.gate_id as WindowsGateId)
      : null;
  if (!gateId) errors.push('gate_id is not recognized');

  const status =
    typeof input.status === 'string' && WINDOWS_GATE_STATUS_SET.has(input.status as WindowsGateStatus)
      ? (input.status as WindowsGateStatus)
      : null;
  if (!status) errors.push('status is not recognized');

  if (status === 'PASS') {
    if (input.reject_code !== null) errors.push('reject_code must be null for PASS');
  } else if (!isNonEmptyString(input.reject_code)) {
    errors.push('reject_code is required unless status is PASS');
  }

  validateSource(input.source, status, errors);
  validateArtifact(input.artifact, gateId, status, errors);
  validateEnvironment(input.environment, errors);
  validateCommands(input.commands, errors);
  validateAssertions(input.assertions, errors);

  if (!isRecord(input.metrics)) errors.push('metrics must be an object');
  if (!Array.isArray(input.evidence_paths)) {
    errors.push('evidence_paths must be an array');
  } else {
    input.evidence_paths.forEach((evidencePath, index) => {
      if (!isRepositoryRelativePath(evidencePath)) {
        errors.push(`evidence_paths[${index}] must be repository-relative`);
      }
    });
  }

  if (!isIsoTimestamp(input.started_at)) errors.push('started_at must be an ISO-8601 timestamp');
  if (!isIsoTimestamp(input.completed_at)) errors.push('completed_at must be an ISO-8601 timestamp');
  if (
    isIsoTimestamp(input.started_at) &&
    isIsoTimestamp(input.completed_at) &&
    Date.parse(input.completed_at) < Date.parse(input.started_at)
  ) {
    errors.push('completed_at must not precede started_at');
  }
  if (!isNonEmptyString(input.worker)) errors.push('worker is required');
  if (!isNonEmptyString(input.reviewer)) errors.push('reviewer is required');
  if (input.completion_sentinel !== 'WIN_GATE_COMPLETE') {
    errors.push('completion_sentinel must be WIN_GATE_COMPLETE');
  }

  return { ok: errors.length === 0, errors };
}

export type { WindowsGateReceiptV1 } from './types';
