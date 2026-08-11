/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TypedUIActionReceipt } from '@/common/typedUI';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateCommandEveGateDecision } from './executionModeCore';

const ACTION_ID = /^(?:[A-Za-z][A-Za-z0-9_-]{0,63}|host-open-workbench)$/;
const ACTION_TYPES = new Set(['reply_with_state', 'open_artifact', 'open_url', 'select_option', 'request_approval']);
const STATUSES = new Set(['authorized', 'completed', 'blocked', 'failed', 'approval_recorded']);
const GATE_ACTIONS = new Set([
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECEIPT_LEDGER_TAIL_BYTES = 8 * 1024 * 1024;

export type TypedUIActionReceiptValidation =
  | { ok: true; receipt: TypedUIActionReceipt }
  | { ok: false; reason: string };

export interface PersistedTypedUIActionReceipt extends TypedUIActionReceipt {
  receipt_id: string;
  recorded_at: string;
}

function readRecentTypedUIActionReceipts(auditPath: string): PersistedTypedUIActionReceipt[] {
  if (!fs.existsSync(auditPath)) return [];
  const size = fs.statSync(auditPath).size;
  if (size === 0) return [];
  const start = Math.max(0, size - MAX_RECEIPT_LEDGER_TAIL_BYTES);
  const handle = fs.openSync(auditPath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, start);
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline < 0) return [];
      content = content.slice(firstNewline + 1);
    }
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          throw new Error('receipt.ledger_corrupt');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('receipt.ledger_corrupt');
        }
        const { receipt_id, recorded_at, ...wireReceipt } = parsed as Record<string, unknown>;
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
        return Object.assign({}, validated.receipt, { receipt_id, recorded_at });
      });
  } finally {
    fs.closeSync(handle);
  }
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

function assertTerminalIntentCorrelation(auditPath: string, receipt: TypedUIActionReceipt): void {
  if (receipt.status !== 'completed' && receipt.status !== 'failed') return;
  const records = readRecentTypedUIActionReceipts(auditPath);
  const intent = records.find((record) => record.receipt_id === receipt.intent_receipt_id);
  if (!intent) throw new Error('receipt.intent_not_found');
  if (intent.status !== 'authorized') throw new Error('receipt.intent_not_authorized');
  if (
    intent.action_id !== receipt.action_id ||
    intent.action_type !== receipt.action_type ||
    intent.request_id !== receipt.request_id ||
    intent.source_message_id !== receipt.source_message_id ||
    intent.decided_at !== receipt.decided_at ||
    !sameAuthority(intent.authority, receipt.authority)
  ) {
    throw new Error('receipt.intent_mismatch');
  }
  if (
    records.some(
      (record) =>
        record.intent_receipt_id === receipt.intent_receipt_id &&
        (record.status === 'completed' || record.status === 'failed')
    )
  ) {
    throw new Error('receipt.intent_already_terminal');
  }
}

export function validateTypedUIActionReceipt(value: unknown): TypedUIActionReceiptValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'receipt.invalid_shape' };
  const receipt = value as Partial<TypedUIActionReceipt>;
  const allowedKeys = new Set([
    'version',
    'receipt_id',
    'intent_receipt_id',
    'request_id',
    'source_message_id',
    'action_id',
    'action_type',
    'status',
    'decided_at',
    'authority',
    'reason',
  ]);
  if (
    Object.keys(receipt).some((key) => !allowedKeys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key))
  ) {
    return { ok: false, reason: 'receipt.unknown_field' };
  }
  if (receipt.version !== 'command-eve.typed-ui-action-receipt/v1') return { ok: false, reason: 'receipt.version' };
  if (receipt.receipt_id !== undefined) return { ok: false, reason: 'receipt.preassigned_id' };
  if (typeof receipt.request_id !== 'string' || receipt.request_id.length === 0 || receipt.request_id.length > 500) {
    return { ok: false, reason: 'receipt.request_id' };
  }
  if (
    receipt.source_message_id !== undefined &&
    (typeof receipt.source_message_id !== 'string' ||
      receipt.source_message_id.length === 0 ||
      receipt.source_message_id.length > 500)
  ) {
    return { ok: false, reason: 'receipt.source_message_id' };
  }
  if (typeof receipt.action_id !== 'string' || !ACTION_ID.test(receipt.action_id))
    return { ok: false, reason: 'receipt.action_id' };
  if (typeof receipt.action_type !== 'string' || !ACTION_TYPES.has(receipt.action_type))
    return { ok: false, reason: 'receipt.action_type' };
  if (typeof receipt.status !== 'string' || !STATUSES.has(receipt.status))
    return { ok: false, reason: 'receipt.status' };
  if (typeof receipt.decided_at !== 'string' || Number.isNaN(Date.parse(receipt.decided_at)))
    return { ok: false, reason: 'receipt.decided_at' };
  if (receipt.reason !== undefined && (typeof receipt.reason !== 'string' || receipt.reason.length > 1000)) {
    return { ok: false, reason: 'receipt.reason' };
  }
  const authority = receipt.authority;
  if (!authority || authority.version !== 'command-eve-gate-decision/v0')
    return { ok: false, reason: 'receipt.authority' };
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
  if (
    (receipt.status === 'authorized' || receipt.status === 'completed' || receipt.status === 'approval_recorded') &&
    !authority.allowed
  ) {
    return { ok: false, reason: 'receipt.status_authority_mismatch' };
  }
  if (receipt.status === 'blocked' && authority.allowed)
    return { ok: false, reason: 'receipt.blocked_authority_mismatch' };
  if (receipt.action_type === 'request_approval') {
    if (!['approval_recorded', 'blocked'].includes(receipt.status)) {
      return { ok: false, reason: 'receipt.approval_status' };
    }
    if (receipt.intent_receipt_id !== undefined) return { ok: false, reason: 'receipt.approval_intent' };
  } else if (receipt.status === 'authorized') {
    if (receipt.intent_receipt_id !== undefined) return { ok: false, reason: 'receipt.intent_on_authorization' };
  } else if (receipt.status === 'completed' || receipt.status === 'failed') {
    if (typeof receipt.intent_receipt_id !== 'string' || !UUID.test(receipt.intent_receipt_id)) {
      return { ok: false, reason: 'receipt.missing_intent' };
    }
  }
  return { ok: true, receipt: receipt as TypedUIActionReceipt };
}

export function appendTypedUIActionReceipt(
  auditPath: string,
  value: unknown,
  options: { now?: () => Date; randomUUID?: () => string } = {}
): PersistedTypedUIActionReceipt {
  const validated = validateTypedUIActionReceipt(value);
  if ('reason' in validated) throw new Error(validated.reason);
  assertTerminalIntentCorrelation(auditPath, validated.receipt);
  const record: PersistedTypedUIActionReceipt = {
    ...validated.receipt,
    receipt_id: (options.randomUUID || crypto.randomUUID)(),
    recorded_at: (options.now || (() => new Date()))().toISOString(),
  };
  fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.chmodSync(auditPath, 0o600);
  return record;
}
