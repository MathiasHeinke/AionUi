/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { httpRequest } from '@/common/adapter/httpBridge';
import {
  COMMAND_EVE_CLOUD_VISUAL_POLICY_KEY,
  COMMAND_EVE_CLOUD_VISUAL_POLICY_VERSION,
  isCommandEveCloudVisualFlowId,
  type CommandEveCloudVisualPolicyMutationResult,
  type CommandEveCloudVisualPolicyReceipt,
  type CommandEveCloudVisualPolicyReceiptResult,
  type CommandEveCloudVisualPolicyState,
} from '@/common/config/visual/cloudVisualPolicyCore';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import { getActiveSeatContextRevision, getActiveSeatId } from '../seatContextCore';

const RECEIPT_TTL_MS = 5 * 60 * 1000;
const MAX_RECEIPTS = 64;

type SeatCapture = {
  seatId: string;
  seatContextRevision: number;
  physicalKey: string;
};

type ReceiptRecord = {
  receiptId: string;
  flowId: string;
  seatId: string;
  seatContextRevision: number;
  expiresAtMs: number;
};

export type CommandEveCloudVisualPolicyMainDeps = {
  getActiveSeatId: () => string;
  getActiveSeatContextRevision: () => number;
  readSettings: () => Promise<unknown>;
  writeSettings: (patch: Readonly<Record<string, unknown>>) => Promise<void>;
};

type IssueReceiptOptions = {
  nowMs?: number;
  randomReceiptId?: () => string;
};

export type CommandEveCloudVisualPolicyReceiptVerification =
  | {
      ok: true;
      seatId: string;
      seatContextRevision: number;
      flowId: string;
      expiresAtMs: number;
    }
  | {
      ok: false;
      reason:
        | 'receipt_invalid'
        | 'receipt_unknown'
        | 'receipt_expired'
        | 'receipt_flow_mismatch'
        | 'receipt_seat_mismatch'
        | 'seat_changed';
    };

const productionDeps: CommandEveCloudVisualPolicyMainDeps = {
  getActiveSeatId,
  getActiveSeatContextRevision,
  readSettings: () => httpRequest<unknown>('GET', '/api/settings/client'),
  writeSettings: (patch) => httpRequest<void>('PUT', '/api/settings/client', patch),
};

const receipts = new Map<string, ReceiptRecord>();

function captureSeat(deps: CommandEveCloudVisualPolicyMainDeps): SeatCapture | undefined {
  try {
    const seatId = deps.getActiveSeatId();
    const seatContextRevision = deps.getActiveSeatContextRevision();
    return {
      seatId,
      seatContextRevision,
      physicalKey: seatScopedKey(COMMAND_EVE_CLOUD_VISUAL_POLICY_KEY, seatId),
    };
  } catch {
    return undefined;
  }
}

function seatStillMatches(capture: SeatCapture, deps: CommandEveCloudVisualPolicyMainDeps): boolean {
  try {
    return (
      deps.getActiveSeatId() === capture.seatId && deps.getActiveSeatContextRevision() === capture.seatContextRevision
    );
  } catch {
    return false;
  }
}

function unavailable(
  reason: Extract<CommandEveCloudVisualPolicyState, { status: 'unavailable' }>['reason'],
  capture?: SeatCapture
): CommandEveCloudVisualPolicyState {
  return {
    status: 'unavailable',
    reason,
    ...(capture ? { seatId: capture.seatId, physicalKey: capture.physicalKey } : {}),
  };
}

function resolveStoredValue(settings: unknown, capture: SeatCapture): CommandEveCloudVisualPolicyState {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return unavailable('malformed_settings_response', capture);
  }
  if (!Object.hasOwn(settings, capture.physicalKey)) {
    return {
      status: 'enabled',
      reason: 'enabled_by_product_default',
      seatId: capture.seatId,
      physicalKey: capture.physicalKey,
    };
  }
  const value = (settings as Record<string, unknown>)[capture.physicalKey];
  if (value === true) {
    return {
      status: 'enabled',
      reason: 'enabled_explicit_compat',
      seatId: capture.seatId,
      physicalKey: capture.physicalKey,
    };
  }
  if (value === false) {
    return {
      status: 'disabled',
      reason: 'disabled_by_operator',
      seatId: capture.seatId,
      physicalKey: capture.physicalKey,
    };
  }
  return unavailable('malformed_stored_value', capture);
}

async function readPolicyForCapture(
  capture: SeatCapture,
  deps: CommandEveCloudVisualPolicyMainDeps
): Promise<CommandEveCloudVisualPolicyState> {
  let settings: unknown;
  try {
    settings = await deps.readSettings();
  } catch {
    return seatStillMatches(capture, deps)
      ? unavailable('settings_read_failed', capture)
      : unavailable('seat_changed', capture);
  }
  if (!seatStillMatches(capture, deps)) return unavailable('seat_changed', capture);
  return resolveStoredValue(settings, capture);
}

/**
 * Resolve only the exact key for one captured Main seat context.
 *
 * The pre/post revision comparison catches A→B as well as A→B→A while the
 * loopback settings read is in flight. There is no legacy or sibling fallback.
 */
export async function readCommandEveCloudVisualPolicy(
  deps: CommandEveCloudVisualPolicyMainDeps = productionDeps
): Promise<CommandEveCloudVisualPolicyState> {
  const capture = captureSeat(deps);
  if (!capture) return unavailable('seat_resolution_failed');
  return readPolicyForCapture(capture, deps);
}

/**
 * Disable by storing exact false, or enable by deleting the exact captured key
 * with the backend's proven JSON-null deletion contract.
 */
export async function setCommandEveCloudVisualPolicy(
  input: { expectedSeatId: string; enabled: boolean },
  deps: CommandEveCloudVisualPolicyMainDeps = productionDeps
): Promise<CommandEveCloudVisualPolicyMutationResult> {
  const capture = captureSeat(deps);
  if (!capture) return { ok: false, policy: unavailable('seat_resolution_failed') };
  if (input.expectedSeatId !== capture.seatId) {
    return { ok: false, policy: unavailable('seat_changed', capture) };
  }

  try {
    await deps.writeSettings({ [capture.physicalKey]: input.enabled ? null : false });
  } catch {
    return {
      ok: false,
      policy: seatStillMatches(capture, deps)
        ? unavailable('settings_write_failed', capture)
        : unavailable('seat_changed', capture),
    };
  }
  if (!seatStillMatches(capture, deps)) {
    return { ok: false, policy: unavailable('seat_changed', capture) };
  }

  // Never infer success from the PUT response. Prove the persisted state with a
  // second exact-key read under the original captured seat and revision.
  const policy = await readPolicyForCapture(capture, deps);
  const expected = input.enabled ? policy.status === 'enabled' : policy.status === 'disabled';
  return { ok: expected, policy };
}

function pruneReceipts(nowMs: number): void {
  for (const [receiptId, record] of receipts) {
    if (record.expiresAtMs <= nowMs) receipts.delete(receiptId);
  }
  while (receipts.size >= MAX_RECEIPTS) {
    const oldest = receipts.keys().next().value;
    if (typeof oldest !== 'string') break;
    receipts.delete(oldest);
  }
}

function isReceiptShape(value: unknown): value is CommandEveCloudVisualPolicyReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === 4 &&
    receipt.version === COMMAND_EVE_CLOUD_VISUAL_POLICY_VERSION &&
    typeof receipt.receiptId === 'string' &&
    /^[A-Za-z0-9_-]{32,128}$/.test(receipt.receiptId) &&
    isCommandEveCloudVisualFlowId(receipt.flowId) &&
    typeof receipt.expiresAt === 'string' &&
    Number.isFinite(Date.parse(receipt.expiresAt))
  );
}

/** Issue one nonpersistent coordination receipt after a fresh positive policy read. */
export async function issueCommandEveCloudVisualPolicyReceipt(
  flowId: string,
  deps: CommandEveCloudVisualPolicyMainDeps = productionDeps,
  options: IssueReceiptOptions = {}
): Promise<CommandEveCloudVisualPolicyReceiptResult> {
  const capture = captureSeat(deps);
  if (!capture) return { ok: false, policy: unavailable('seat_resolution_failed') };

  const policy = await readPolicyForCapture(capture, deps);
  if (policy.status !== 'enabled') return { ok: false, policy };
  if (!isCommandEveCloudVisualFlowId(flowId)) {
    return { ok: false, policy: unavailable('malformed_settings_response', capture) };
  }
  if (!seatStillMatches(capture, deps)) {
    return { ok: false, policy: unavailable('seat_changed', capture) };
  }

  const nowMs = options.nowMs ?? Date.now();
  pruneReceipts(nowMs);
  const receiptId = options.randomReceiptId?.() ?? crypto.randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(receiptId)) {
    return { ok: false, policy: unavailable('malformed_settings_response', capture) };
  }
  const expiresAtMs = nowMs + RECEIPT_TTL_MS;
  receipts.set(receiptId, {
    receiptId,
    flowId,
    seatId: capture.seatId,
    seatContextRevision: capture.seatContextRevision,
    expiresAtMs,
  });
  return {
    ok: true,
    policy,
    receipt: {
      version: COMMAND_EVE_CLOUD_VISUAL_POLICY_VERSION,
      receiptId,
      flowId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
}

/**
 * Verify a receipt against Main's process-local record and current seat context.
 * This deliberately does not read policy: callers must verify, then perform a
 * fresh positive `readCommandEveCloudVisualPolicy` immediately before egress.
 */
export function verifyCommandEveCloudVisualPolicyReceipt(
  receipt: unknown,
  expectedFlowId: string,
  deps: Pick<CommandEveCloudVisualPolicyMainDeps, 'getActiveSeatId' | 'getActiveSeatContextRevision'> = productionDeps,
  nowMs = Date.now()
): CommandEveCloudVisualPolicyReceiptVerification {
  if (!isReceiptShape(receipt) || receipt.flowId !== expectedFlowId) {
    return { ok: false, reason: 'receipt_invalid' };
  }
  const record = receipts.get(receipt.receiptId);
  if (!record) return { ok: false, reason: 'receipt_unknown' };
  if (record.expiresAtMs <= nowMs) {
    receipts.delete(receipt.receiptId);
    return { ok: false, reason: 'receipt_expired' };
  }
  if (
    receipt.flowId !== record.flowId ||
    receipt.expiresAt !== new Date(record.expiresAtMs).toISOString() ||
    expectedFlowId !== record.flowId
  ) {
    return { ok: false, reason: 'receipt_flow_mismatch' };
  }
  let activeSeatId: string;
  let activeSeatContextRevision: number;
  try {
    activeSeatId = deps.getActiveSeatId();
    activeSeatContextRevision = deps.getActiveSeatContextRevision();
  } catch {
    return { ok: false, reason: 'seat_changed' };
  }
  if (activeSeatId !== record.seatId) return { ok: false, reason: 'receipt_seat_mismatch' };
  if (activeSeatContextRevision !== record.seatContextRevision) {
    return { ok: false, reason: 'seat_changed' };
  }
  return {
    ok: true,
    seatId: record.seatId,
    seatContextRevision: record.seatContextRevision,
    flowId: record.flowId,
    expiresAtMs: record.expiresAtMs,
  };
}

/**
 * Atomically retire the exact receipt that survived the caller's final policy
 * read. Verification remains reusable during local image/PPTX preparation; only
 * a successful final marker mint invokes this synchronous transition.
 */
export function retireCommandEveCloudVisualPolicyReceipt(
  receipt: unknown,
  expectedFlowId: string,
  expected: Extract<CommandEveCloudVisualPolicyReceiptVerification, { ok: true }>,
  deps: Pick<CommandEveCloudVisualPolicyMainDeps, 'getActiveSeatId' | 'getActiveSeatContextRevision'> = productionDeps,
  nowMs = Date.now()
): boolean {
  if (!isReceiptShape(receipt)) return false;
  const verified = verifyCommandEveCloudVisualPolicyReceipt(receipt, expectedFlowId, deps, nowMs);
  if (
    !verified.ok ||
    verified.seatId !== expected.seatId ||
    verified.seatContextRevision !== expected.seatContextRevision ||
    verified.flowId !== expected.flowId ||
    verified.expiresAtMs !== expected.expiresAtMs
  ) {
    return false;
  }
  return receipts.delete(receipt.receiptId);
}

export function clearCommandEveCloudVisualPolicyReceiptsForTests(): void {
  receipts.clear();
}
