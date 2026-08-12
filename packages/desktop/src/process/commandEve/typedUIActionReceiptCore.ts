/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TYPED_UI_ACTION_AUTHORIZATION_VERSION,
  type TypedUIActionAuthorizeRequest,
  type TypedUIActionFinalizeRequest,
  type TypedUIActionReceipt,
  type TypedUIActionReceiptRequest,
  type TypedUIActionType,
  type TypedUIJsonValue,
} from '@/common/typedUI';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendCommandEveGateDecision,
  evaluateCommandEveGateDecision,
  type CommandEveExecutionMode,
  type CommandEveGateAction,
} from './executionModeCore';
import {
  requireVerifiedTypedUIActionBinding,
  requireVerifiedTypedUIActionBindingHash,
} from './typedUIProvenanceAttestationCore';

const RECEIPT_VERSION = 'command-eve.typed-ui-action-receipt/v2' as const;
const INTENT_CLAIM_VERSION = 'command-eve.typed-ui-action-intent-claim/v1' as const;
const ACTION_ID = /^(?:[A-Za-z][A-Za-z0-9_-]{0,63}|host-open-workbench)$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const ACTION_TYPES = new Set<TypedUIActionType>([
  'reply_with_state',
  'open_artifact',
  'open_url',
  'select_option',
  'request_approval',
]);
const STATUSES = new Set(['authorized', 'completed', 'blocked', 'failed', 'approval_recorded']);
const GATE_ACTIONS = new Set<CommandEveGateAction>([
  'edit_code',
  'prepare_pr',
  'run_local_tests',
  'merge_main',
  'prod_write',
  'money',
  'external_send',
  'schema_auth_secret',
  'truth_gate',
]);
const MODES = new Set(['observed', 'delegated', 'autonomous']);
const GATES = new Set(['auto', 'founder_stop', 'founder_click', 'hg_2_5', 'hg_4', 'cao_required']);
const AUTHORITY_KEYS = new Set(['version', 'decided_at', 'mode', 'action', 'allowed', 'gate', 'reason']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTESTATION_ID = /^tuia_[a-f0-9]{64}$/;
const INTENT_CLAIM_ID = /^tuic_[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_ACTION_PARAMS_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 12;

export type TypedUIActionReceiptValidation =
  | { ok: true; receipt: TypedUIActionReceipt }
  | { ok: false; reason: string };

export interface PersistedTypedUIActionReceipt extends TypedUIActionReceipt {
  receipt_id: string;
  recorded_at: string;
}

type TypedUIActionCoreOptions = {
  attestationAuditPath: string;
  activeSeatId: string;
  seatContextRevision: number;
  executionMode?: CommandEveExecutionMode;
  gateAuditPath: string;
  intentClaimDirectory: string;
  now?: () => Date;
  randomUUID?: () => string;
};

type PersistedTypedUIIntentClaim = {
  version: typeof INTENT_CLAIM_VERSION;
  claim_id: string;
  intent: PersistedTypedUIActionReceipt;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key) && !FORBIDDEN_KEYS.has(key));
}

function boundedString(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function isBoundedJsonValue(value: unknown, depth = 0): value is TypedUIJsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 10_000 && !value.includes('\0');
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isBoundedJsonValue(item, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(
    ([key, item]) => !FORBIDDEN_KEYS.has(key) && key.length <= 128 && isBoundedJsonValue(item, depth + 1)
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameAuthority(left: TypedUIActionReceipt['authority'], right: TypedUIActionReceipt['authority']): boolean {
  return (
    left.version === right.version &&
    left.decided_at === right.decided_at &&
    left.mode === right.mode &&
    left.action === right.action &&
    left.allowed === right.allowed &&
    left.gate === right.gate &&
    left.reason === right.reason
  );
}

export function validateTypedUIActionReceipt(value: unknown): TypedUIActionReceiptValidation {
  if (!isRecord(value)) return { ok: false, reason: 'receipt.invalid_shape' };
  const receipt = value as Partial<TypedUIActionReceipt>;
  const allowedKeys = [
    'version',
    'receipt_id',
    'intent_receipt_id',
    'intent_claim_id',
    'request_id',
    'artifact_id',
    'conversation_id',
    'attestation_id',
    'content_sha256',
    'source_message_id',
    'action_id',
    'action_type',
    'action_params_sha256',
    'action_binding_sha256',
    'status',
    'decided_at',
    'authority',
    'reason',
  ];
  if (!exactKeys(value, allowedKeys)) return { ok: false, reason: 'receipt.unknown_field' };
  if (receipt.version !== RECEIPT_VERSION) return { ok: false, reason: 'receipt.version' };
  if (receipt.receipt_id !== undefined) return { ok: false, reason: 'receipt.preassigned_id' };
  if (!boundedString(receipt.request_id)) return { ok: false, reason: 'receipt.request_id' };
  if (typeof receipt.artifact_id !== 'string' || !ARTIFACT_ID.test(receipt.artifact_id)) {
    return { ok: false, reason: 'receipt.artifact_id' };
  }
  if (!boundedString(receipt.conversation_id, 256)) return { ok: false, reason: 'receipt.conversation_id' };
  if (typeof receipt.attestation_id !== 'string' || !ATTESTATION_ID.test(receipt.attestation_id)) {
    return { ok: false, reason: 'receipt.attestation_id' };
  }
  if (typeof receipt.content_sha256 !== 'string' || !SHA256.test(receipt.content_sha256)) {
    return { ok: false, reason: 'receipt.content_sha256' };
  }
  if (!boundedString(receipt.source_message_id)) return { ok: false, reason: 'receipt.source_message_id' };
  if (typeof receipt.action_id !== 'string' || !ACTION_ID.test(receipt.action_id)) {
    return { ok: false, reason: 'receipt.action_id' };
  }
  if (typeof receipt.action_type !== 'string' || !ACTION_TYPES.has(receipt.action_type)) {
    return { ok: false, reason: 'receipt.action_type' };
  }
  if (typeof receipt.action_params_sha256 !== 'string' || !SHA256.test(receipt.action_params_sha256)) {
    return { ok: false, reason: 'receipt.action_params_sha256' };
  }
  if (typeof receipt.action_binding_sha256 !== 'string' || !SHA256.test(receipt.action_binding_sha256)) {
    return { ok: false, reason: 'receipt.action_binding_sha256' };
  }
  if (typeof receipt.status !== 'string' || !STATUSES.has(receipt.status)) {
    return { ok: false, reason: 'receipt.status' };
  }
  if (typeof receipt.decided_at !== 'string' || Number.isNaN(Date.parse(receipt.decided_at))) {
    return { ok: false, reason: 'receipt.decided_at' };
  }
  if (receipt.reason !== undefined && (typeof receipt.reason !== 'string' || receipt.reason.length > 1000)) {
    return { ok: false, reason: 'receipt.reason' };
  }
  const authority = receipt.authority;
  if (!authority || authority.version !== 'command-eve-gate-decision/v0') {
    return { ok: false, reason: 'receipt.authority' };
  }
  if (
    Object.keys(authority).some((key) => !AUTHORITY_KEYS.has(key)) ||
    !GATE_ACTIONS.has(authority.action) ||
    !MODES.has(authority.mode) ||
    !GATES.has(authority.gate) ||
    typeof authority.allowed !== 'boolean' ||
    typeof authority.reason !== 'string' ||
    authority.reason.length > 1000 ||
    typeof authority.decided_at !== 'string' ||
    Number.isNaN(Date.parse(authority.decided_at))
  ) {
    return { ok: false, reason: 'receipt.authority_shape' };
  }
  if (receipt.decided_at !== authority.decided_at) return { ok: false, reason: 'receipt.authority_timestamp' };
  if (receipt.action_type !== 'request_approval' && authority.action !== 'truth_gate') {
    return { ok: false, reason: 'receipt.authority_action' };
  }
  const expected = evaluateCommandEveGateDecision({
    mode: authority.mode,
    action: authority.action,
    now: () => new Date(authority.decided_at),
  });
  if (
    expected.allowed !== authority.allowed ||
    expected.gate !== authority.gate ||
    expected.reason !== authority.reason ||
    expected.mode !== authority.mode
  ) {
    return { ok: false, reason: 'receipt.authority_mismatch' };
  }
  if (['authorized', 'completed', 'failed', 'approval_recorded'].includes(receipt.status) && !authority.allowed) {
    return { ok: false, reason: 'receipt.status_authority_mismatch' };
  }
  if (receipt.status === 'blocked' && authority.allowed) {
    return { ok: false, reason: 'receipt.blocked_authority_mismatch' };
  }
  if (receipt.action_type === 'request_approval') {
    if (!['approval_recorded', 'blocked'].includes(receipt.status)) {
      return { ok: false, reason: 'receipt.approval_status' };
    }
    if (receipt.intent_receipt_id !== undefined || receipt.intent_claim_id !== undefined) {
      return { ok: false, reason: 'receipt.approval_intent' };
    }
  } else if (receipt.status === 'approval_recorded') {
    return { ok: false, reason: 'receipt.approval_action_type' };
  } else if (receipt.status === 'authorized') {
    if (receipt.intent_receipt_id !== undefined) return { ok: false, reason: 'receipt.intent_on_authorization' };
    if (typeof receipt.intent_claim_id !== 'string' || !INTENT_CLAIM_ID.test(receipt.intent_claim_id)) {
      return { ok: false, reason: 'receipt.missing_claim' };
    }
  } else if (receipt.status === 'completed' || receipt.status === 'failed') {
    if (typeof receipt.intent_receipt_id !== 'string' || !UUID.test(receipt.intent_receipt_id)) {
      return { ok: false, reason: 'receipt.missing_intent' };
    }
    if (typeof receipt.intent_claim_id !== 'string' || !INTENT_CLAIM_ID.test(receipt.intent_claim_id)) {
      return { ok: false, reason: 'receipt.missing_claim' };
    }
  } else if (receipt.intent_receipt_id !== undefined || receipt.intent_claim_id !== undefined) {
    return { ok: false, reason: 'receipt.unexpected_intent' };
  }
  return { ok: true, receipt: receipt as TypedUIActionReceipt };
}

function parsePersistedReceipt(value: unknown): PersistedTypedUIActionReceipt {
  if (!isRecord(value)) throw new Error('receipt.ledger_corrupt');
  const { receipt_id, recorded_at, ...wireReceipt } = value;
  const validated = validateTypedUIActionReceipt(wireReceipt);
  if (
    'reason' in validated ||
    typeof receipt_id !== 'string' ||
    !UUID.test(receipt_id) ||
    typeof recorded_at !== 'string' ||
    Number.isNaN(Date.parse(recorded_at))
  ) {
    throw new Error('receipt.ledger_corrupt');
  }
  return { ...validated.receipt, receipt_id, recorded_at };
}

function readTypedUIActionReceipts(auditPath: string): PersistedTypedUIActionReceipt[] {
  if (!fs.existsSync(auditPath)) return [];
  const size = fs.statSync(auditPath).size;
  if (size === 0) return [];
  if (size > MAX_RECEIPT_LEDGER_BYTES) throw new Error('receipt.ledger_too_large');
  return fs
    .readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return parsePersistedReceipt(JSON.parse(line) as unknown);
      } catch (error) {
        if (error instanceof Error && error.message === 'receipt.ledger_corrupt') throw error;
        throw new Error('receipt.ledger_corrupt', { cause: error });
      }
    });
}

function appendReceiptRecord(
  auditPath: string,
  receipt: TypedUIActionReceipt,
  options: Pick<TypedUIActionCoreOptions, 'now' | 'randomUUID'>
): PersistedTypedUIActionReceipt {
  const validated = validateTypedUIActionReceipt(receipt);
  if ('reason' in validated) throw new Error(validated.reason);
  const receiptId = (options.randomUUID || crypto.randomUUID)();
  if (!UUID.test(receiptId)) throw new Error('receipt.generated_id_invalid');
  if (readTypedUIActionReceipts(auditPath).some((record) => record.receipt_id === receiptId)) {
    throw new Error('receipt.generated_id_conflict');
  }
  const record: PersistedTypedUIActionReceipt = {
    ...validated.receipt,
    receipt_id: receiptId,
    recorded_at: (options.now || (() => new Date()))().toISOString(),
  };
  appendPersistedReceiptRecord(auditPath, record);
  return record;
}

function appendPersistedReceiptRecord(auditPath: string, record: PersistedTypedUIActionReceipt): void {
  const line = `${JSON.stringify(record)}\n`;
  const existingSize = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0;
  if (existingSize + Buffer.byteLength(line, 'utf8') > MAX_RECEIPT_LEDGER_BYTES) {
    throw new Error('receipt.ledger_too_large');
  }
  const directory = path.dirname(auditPath);
  const existed = fs.existsSync(auditPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const handle = fs.openSync(auditPath, 'a', 0o600);
  try {
    fs.writeFileSync(handle, line, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(auditPath, 0o600);
  if (!existed) fsyncDirectory(directory);
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const handle = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function validateAuthorizeRequest(value: unknown): TypedUIActionAuthorizeRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'phase',
      'request_id',
      'artifact_id',
      'conversation_id',
      'attestation_id',
      'content_sha256',
      'source_message_id',
      'action_id',
      'action_type',
      'params',
    ])
  ) {
    throw new Error('receipt.authorize_shape');
  }
  if (value.version !== TYPED_UI_ACTION_AUTHORIZATION_VERSION || value.phase !== 'authorize') {
    throw new Error('receipt.authorize_version');
  }
  if (
    !boundedString(value.request_id) ||
    typeof value.artifact_id !== 'string' ||
    !ARTIFACT_ID.test(value.artifact_id) ||
    !boundedString(value.conversation_id, 256) ||
    typeof value.attestation_id !== 'string' ||
    !ATTESTATION_ID.test(value.attestation_id) ||
    typeof value.content_sha256 !== 'string' ||
    !SHA256.test(value.content_sha256) ||
    !boundedString(value.source_message_id) ||
    typeof value.action_id !== 'string' ||
    !ACTION_ID.test(value.action_id) ||
    typeof value.action_type !== 'string' ||
    !ACTION_TYPES.has(value.action_type as TypedUIActionType) ||
    !isRecord(value.params) ||
    !isBoundedJsonValue(value.params) ||
    Buffer.byteLength(JSON.stringify(value.params), 'utf8') > MAX_ACTION_PARAMS_BYTES
  ) {
    throw new Error('receipt.authorize_invalid');
  }
  return value as unknown as TypedUIActionAuthorizeRequest;
}

function validateFinalizeRequest(value: unknown): TypedUIActionFinalizeRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['version', 'phase', 'intent_receipt_id', 'intent_claim_id', 'outcome', 'reason'])
  ) {
    throw new Error('receipt.finalize_shape');
  }
  if (value.version !== TYPED_UI_ACTION_AUTHORIZATION_VERSION || value.phase !== 'finalize') {
    throw new Error('receipt.finalize_version');
  }
  if (
    typeof value.intent_receipt_id !== 'string' ||
    !UUID.test(value.intent_receipt_id) ||
    typeof value.intent_claim_id !== 'string' ||
    !INTENT_CLAIM_ID.test(value.intent_claim_id) ||
    (value.outcome !== 'completed' && value.outcome !== 'failed') ||
    (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 1000))
  ) {
    throw new Error('receipt.finalize_invalid');
  }
  return value as unknown as TypedUIActionFinalizeRequest;
}

export function validateTypedUIActionReceiptRequest(value: unknown): TypedUIActionReceiptRequest {
  if (!isRecord(value)) throw new Error('receipt.request_shape');
  return value.phase === 'authorize' ? validateAuthorizeRequest(value) : validateFinalizeRequest(value);
}

function claimPath(directory: string, claimId: string): string {
  if (!INTENT_CLAIM_ID.test(claimId)) throw new Error('receipt.claim_id');
  return path.join(directory, `${claimId}.json`);
}

function readIntentClaim(directory: string, claimId: string): PersistedTypedUIIntentClaim {
  const filePath = claimPath(directory, claimId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    throw new Error('receipt.intent_claim_missing');
  }
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ['version', 'claim_id', 'intent']) ||
    parsed.version !== INTENT_CLAIM_VERSION ||
    parsed.claim_id !== claimId
  ) {
    throw new Error('receipt.intent_claim_corrupt');
  }
  const intent = parsePersistedReceipt(parsed.intent);
  if (intent.status !== 'authorized' || intent.intent_claim_id !== claimId) {
    throw new Error('receipt.intent_claim_corrupt');
  }
  return { version: INTENT_CLAIM_VERSION, claim_id: claimId, intent };
}

function removeIntentClaim(directory: string, claimId: string): void {
  try {
    fs.unlinkSync(claimPath(directory, claimId));
    fsyncDirectory(directory);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
}

function writeIntentClaim(directory: string, claim: PersistedTypedUIIntentClaim): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filePath = claimPath(directory, claim.claim_id);
  const handle = fs.openSync(filePath, 'wx', 0o600);
  let durable = false;
  try {
    fs.writeFileSync(handle, `${JSON.stringify(claim)}\n`, 'utf8');
    fs.fchmodSync(handle, 0o600);
    fs.fsyncSync(handle);
    durable = true;
  } finally {
    fs.closeSync(handle);
    if (!durable) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // A partial marker is reconciled against the durable receipt ledger on
        // the next authorize/finalize call.
      }
    }
  }
  fsyncDirectory(directory);
}

function ensureIntentClaim(directory: string, claimId: string, intent: PersistedTypedUIActionReceipt): void {
  try {
    const existing = readIntentClaim(directory, claimId);
    if (existing.intent.receipt_id === intent.receipt_id) return;
  } catch {
    // Missing or partial markers are reconstructed only from a durable
    // authorized ledger record supplied by the caller.
  }
  removeIntentClaim(directory, claimId);
  writeIntentClaim(directory, { version: INTENT_CLAIM_VERSION, claim_id: claimId, intent });
}

function isTerminal(record: PersistedTypedUIActionReceipt, intentReceiptId: string): boolean {
  return record.intent_receipt_id === intentReceiptId && (record.status === 'completed' || record.status === 'failed');
}

function assertTerminalMatchesIntent(intent: PersistedTypedUIActionReceipt, terminal: TypedUIActionReceipt): void {
  if (
    terminal.intent_receipt_id !== intent.receipt_id ||
    terminal.intent_claim_id !== intent.intent_claim_id ||
    terminal.action_id !== intent.action_id ||
    terminal.action_type !== intent.action_type ||
    terminal.action_params_sha256 !== intent.action_params_sha256 ||
    terminal.action_binding_sha256 !== intent.action_binding_sha256 ||
    terminal.request_id !== intent.request_id ||
    terminal.artifact_id !== intent.artifact_id ||
    terminal.conversation_id !== intent.conversation_id ||
    terminal.attestation_id !== intent.attestation_id ||
    terminal.content_sha256 !== intent.content_sha256 ||
    terminal.source_message_id !== intent.source_message_id ||
    terminal.decided_at !== intent.decided_at ||
    !sameAuthority(intent.authority, terminal.authority)
  ) {
    throw new Error('receipt.intent_mismatch');
  }
}

export function authorizeTypedUIAction(
  auditPath: string,
  value: unknown,
  options: TypedUIActionCoreOptions
): PersistedTypedUIActionReceipt {
  const request = validateAuthorizeRequest(value);
  const priorReceipts = readTypedUIActionReceipts(auditPath);
  const binding = requireVerifiedTypedUIActionBinding(options.attestationAuditPath, {
    attestationId: request.attestation_id,
    artifactId: request.artifact_id,
    conversationId: request.conversation_id,
    sourceMessageId: request.source_message_id,
    requestId: request.request_id,
    contentSha256: request.content_sha256,
    activeSeatId: options.activeSeatId,
    seatContextRevision: options.seatContextRevision,
    actionId: request.action_id,
    actionType: request.action_type,
    actionParams: request.params,
  });
  const gateAction =
    request.action_type === 'request_approval' && typeof request.params.gate_action === 'string'
      ? (request.params.gate_action as CommandEveGateAction)
      : 'truth_gate';
  if (!GATE_ACTIONS.has(gateAction)) throw new Error('receipt.gate_action');
  const authority = evaluateCommandEveGateDecision({
    mode: options.executionMode,
    action: gateAction,
    now: options.now,
  });
  appendCommandEveGateDecision(options.gateAuditPath, authority);
  const baseReceipt = {
    version: RECEIPT_VERSION,
    request_id: request.request_id,
    artifact_id: request.artifact_id,
    conversation_id: request.conversation_id,
    attestation_id: request.attestation_id,
    content_sha256: request.content_sha256,
    source_message_id: request.source_message_id,
    action_id: request.action_id,
    action_type: request.action_type,
    action_params_sha256: binding.params_sha256,
    action_binding_sha256: binding.binding_sha256,
    decided_at: authority.decided_at,
    authority,
  } as const;

  if (request.action_type === 'request_approval' || !authority.allowed) {
    return appendReceiptRecord(
      auditPath,
      {
        ...baseReceipt,
        status: request.action_type === 'request_approval' && authority.allowed ? 'approval_recorded' : 'blocked',
        reason: authority.reason,
      },
      options
    );
  }

  const claimId = `tuic_${sha256(
    `command-eve.typed-ui.intent-claim/v1\u0000${request.attestation_id}\u0000${request.source_message_id}\u0000${binding.binding_sha256}`
  )}`;
  const outstanding = priorReceipts.filter(
    (record) =>
      record.status === 'authorized' &&
      record.intent_claim_id === claimId &&
      !priorReceipts.some((candidate) => isTerminal(candidate, record.receipt_id))
  );
  if (outstanding.length > 1) throw new Error('receipt.multiple_outstanding_intents');
  if (outstanding[0]) {
    ensureIntentClaim(options.intentClaimDirectory, claimId, outstanding[0]);
    throw new Error('receipt.intent_outstanding');
  }
  // A marker without a durable authorized record can only precede Main's
  // response, so no renderer effect was permitted. It is safe to reconcile.
  removeIntentClaim(options.intentClaimDirectory, claimId);

  const receiptId = (options.randomUUID || crypto.randomUUID)();
  if (!UUID.test(receiptId)) throw new Error('receipt.generated_id_invalid');
  if (priorReceipts.some((record) => record.receipt_id === receiptId)) {
    throw new Error('receipt.generated_id_conflict');
  }
  const intent: PersistedTypedUIActionReceipt = {
    ...baseReceipt,
    intent_claim_id: claimId,
    status: 'authorized',
    receipt_id: receiptId,
    recorded_at: (options.now || (() => new Date()))().toISOString(),
  };
  parsePersistedReceipt(intent);

  try {
    writeIntentClaim(options.intentClaimDirectory, {
      version: INTENT_CLAIM_VERSION,
      claim_id: claimId,
      intent,
    });
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') {
      throw new Error('receipt.intent_outstanding', { cause: error });
    }
    throw error;
  }

  try {
    appendPersistedReceiptRecord(auditPath, intent);
  } catch (error) {
    removeIntentClaim(options.intentClaimDirectory, claimId);
    throw error;
  }
  return intent;
}

export function finalizeTypedUIAction(
  auditPath: string,
  value: unknown,
  options: Omit<TypedUIActionCoreOptions, 'executionMode' | 'gateAuditPath'>
): PersistedTypedUIActionReceipt {
  const request = validateFinalizeRequest(value);
  const records = readTypedUIActionReceipts(auditPath);
  const existingTerminal = records.find((record) => isTerminal(record, request.intent_receipt_id));
  if (existingTerminal) {
    if (
      existingTerminal.intent_claim_id !== request.intent_claim_id ||
      existingTerminal.status !== request.outcome ||
      (request.reason !== undefined && existingTerminal.reason !== request.reason)
    ) {
      throw new Error('receipt.intent_already_terminal');
    }
    removeIntentClaim(options.intentClaimDirectory, request.intent_claim_id);
    return existingTerminal;
  }
  const intent = records.find(
    (record) =>
      record.receipt_id === request.intent_receipt_id &&
      record.status === 'authorized' &&
      record.intent_claim_id === request.intent_claim_id
  );
  if (!intent) {
    removeIntentClaim(options.intentClaimDirectory, request.intent_claim_id);
    throw new Error('receipt.intent_not_found');
  }
  ensureIntentClaim(options.intentClaimDirectory, request.intent_claim_id, intent);
  requireVerifiedTypedUIActionBindingHash(options.attestationAuditPath, {
    attestationId: intent.attestation_id,
    artifactId: intent.artifact_id,
    conversationId: intent.conversation_id,
    sourceMessageId: intent.source_message_id,
    requestId: intent.request_id,
    contentSha256: intent.content_sha256,
    activeSeatId: options.activeSeatId,
    seatContextRevision: options.seatContextRevision,
    actionId: intent.action_id,
    actionType: intent.action_type,
    actionParamsSha256: intent.action_params_sha256,
    actionBindingSha256: intent.action_binding_sha256,
  });
  const terminal: TypedUIActionReceipt = {
    version: RECEIPT_VERSION,
    intent_receipt_id: intent.receipt_id,
    intent_claim_id: request.intent_claim_id,
    request_id: intent.request_id,
    artifact_id: intent.artifact_id,
    conversation_id: intent.conversation_id,
    attestation_id: intent.attestation_id,
    content_sha256: intent.content_sha256,
    source_message_id: intent.source_message_id,
    action_id: intent.action_id,
    action_type: intent.action_type,
    action_params_sha256: intent.action_params_sha256,
    action_binding_sha256: intent.action_binding_sha256,
    status: request.outcome,
    decided_at: intent.decided_at,
    authority: intent.authority,
    ...(request.reason ? { reason: request.reason } : {}),
  };
  assertTerminalMatchesIntent(intent, terminal);
  const record = appendReceiptRecord(auditPath, terminal, options);
  try {
    removeIntentClaim(options.intentClaimDirectory, request.intent_claim_id);
  } catch {
    // The terminal receipt is authoritative. A leftover marker is reconciled
    // on the next authorization attempt and can never authorize twice.
  }
  return record;
}
