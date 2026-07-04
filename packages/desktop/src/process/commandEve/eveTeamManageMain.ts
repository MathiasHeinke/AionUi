/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE 1.7.0 — team_manage main-side glue (SG-1 Design B).
 *
 * The thin IO layer around the pure eveTeamManageBridgeCore: it reads the live
 * team state, runs the pure validate/apply, and performs the ONLY settings write
 * (in the confirm/apply path — never in propose; B1). It also owns the per-boot
 * bearer and the authoritative append-only receipt.
 *
 * ISO-6 (B5): the bearer resolver returns '' on a client seat, so the shim's
 * propose route is inert there (non-provisioning). The propose handler ALSO checks
 * the seat kind directly (defense-in-depth). The bearer is provisioned into EVE's
 * runtime env only on an operator seat (see index.ts).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpRequest } from '@/common/adapter/httpBridge';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import type { EveTeamWorkerStatusMap } from '@/common/config/eveTeamControlsCore';
import type { EveWorkerAssignmentMap } from '@/common/config/eveWorkerAssignmentCore';
import { getActiveSeatId, getActiveSeatKind } from './seatContextCore';
import { getDataPath } from '@process/utils/utils';
import { readCommandEveSettingsFromBackend } from './commandEveBackendSettingsRead';
import { syncEveWorkerLauncherFiles } from './eveWorkerLauncherCore';
import {
  applyConsumedIntent,
  buildProposeResponse,
  consumeIntent,
  describeProposal,
  peekIntentForSeat,
  type TeamManageIntent,
} from './eveTeamManageBridgeCore';

// --- per-boot bearer (ISO-6 gated) ---------------------------------------------

let bootBearer = '';

/** The stable per-boot bearer (minted once). Used to provision EVE's runtime env. */
export function ensureTeamManageBearer(): string {
  if (!bootBearer) bootBearer = crypto.randomBytes(24).toString('hex');
  return bootBearer;
}

/** Path to the per-boot bearer FILE (audit H11 — bearer off process.env). */
export function teamManageBearerFilePath(dataPath: string): string {
  return path.join(dataPath, 'eve-team-manage', 'bearer');
}

/**
 * FILE-deliver the bearer (audit H11): the bearer must NOT sit on process.env, which
 * the backend + Hermes + every child (MCP subprocess, a delegated CLI) inherit
 * automatically and model-visibly. Instead it lives in a 0600 file; only the FILE
 * PATH goes into env (not a secret), and EVE reads the value on demand. On a client
 * seat the file is removed (ISO-6). Returns the path, or '' when removed/unavailable.
 */
export function provisionTeamManageBearerFile(dataPath: string, isClientSeat: boolean): string {
  const file = teamManageBearerFilePath(dataPath);
  try {
    if (isClientSeat) {
      fs.rmSync(file, { force: true });
      return '';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ensureTeamManageBearer(), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch (error) {
    console.warn('[Command EVE] team_manage bearer file provisioning failed:', error);
    return '';
  }
}

/**
 * The bearer the shim route expects. '' on a client seat (ISO-6 — the route is inert
 * there). Read live per request (the shim outlives seat-switches). NOTE: the route
 * validates against this in-memory bootBearer, NOT against env — so removing the
 * bearer from env (H11) does not affect route auth.
 */
export function resolveTeamManageBearer(): string {
  if (getActiveSeatKind() === 'client') return '';
  return ensureTeamManageBearer();
}

// --- fresh team state read ------------------------------------------------------

async function readTeam(): Promise<{ assignments: EveWorkerAssignmentMap; statuses: EveTeamWorkerStatusMap }> {
  const bag = await readCommandEveSettingsFromBackend(['commandEve.workerAssignments', 'commandEve.teamWorkerStatus']);
  const assignmentsRaw = bag['commandEve.workerAssignments'];
  const statusesRaw = bag['commandEve.teamWorkerStatus'];
  const assignments =
    assignmentsRaw && typeof assignmentsRaw === 'object'
      ? (Object.fromEntries(
          Object.entries(assignmentsRaw as Record<string, { kind: string; cli_path?: string }>).map(([id, v]) => [
            id,
            { agent_id: id, ...v },
          ])
        ) as EveWorkerAssignmentMap)
      : ({} as EveWorkerAssignmentMap);
  const statuses =
    statusesRaw && typeof statusesRaw === 'object' ? (statusesRaw as EveTeamWorkerStatusMap) : ({} as EveTeamWorkerStatusMap);
  return { assignments, statuses };
}

// --- receipt (authoritative, append-only JSONL) --------------------------------

function receiptPath(): string {
  return path.join(getDataPath(), 'eve-team-manage', 'receipts.jsonl');
}

function writeReceipt(record: Record<string, unknown>): void {
  try {
    const file = receiptPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.warn('[Command EVE] team_manage receipt write failed:', error);
  }
}

// --- propose (async lane; NO settings write) -----------------------------------

/** The shim-injected propose handler: authenticate happens in the shim; here we
 *  validate + store the pending intent. Returns the HTTP status/payload. */
export async function teamManageProposeHandler(proposal: unknown): Promise<{ status: number; payload: unknown }> {
  // Defense-in-depth ISO-6: never accept a proposal on a client seat, even if the
  // bearer somehow matched.
  if (getActiveSeatKind() === 'client') {
    return { status: 404, payload: { error: { message: 'team_manage is not available on this seat.' } } };
  }
  const { statuses } = await readTeam();
  const seatId = getActiveSeatId();
  const now = Date.now();
  const res = buildProposeResponse(proposal, statuses, { seatId, now });
  if (res.ok) {
    writeReceipt({ event: 'proposed', intent_id: res.intent_id, seat_id: seatId, summary: res.summary, ts: now });
    return { status: 202, payload: res };
  }
  return { status: 422, payload: res };
}

// --- peek (renderer poll) ------------------------------------------------------

export function peekTeamManageForRenderer(): {
  intent_id: string;
  role_agent_id: string;
  action: string;
  summary: string;
  reason: string;
  expires_ms: number;
} | null {
  const intent = peekIntentForSeat(getActiveSeatId(), Date.now());
  if (!intent) return null;
  return {
    intent_id: intent.intent_id,
    role_agent_id: intent.role_agent_id,
    action: intent.action,
    // The human German diff, computed main-side so the renderer stays free of any
    // process-module import.
    summary: describeProposal(intent.role_agent_id, intent.action),
    reason: intent.reason,
    expires_ms: intent.expires_ms,
  };
}

// --- apply (confirm IPC — the ONLY settings write; B1/B7) -----------------------

export async function applyTeamManageIntent(
  intent_id: string
): Promise<{ ok: boolean; reason?: string; role_agent_id?: string; action?: string }> {
  const seatId = getActiveSeatId();
  const now = Date.now();
  const consumed = consumeIntent(intent_id, seatId, now);
  if (!consumed.ok) {
    const reason = consumed.reason;
    writeReceipt({ event: 'apply-refused', intent_id, seat_id: seatId, reason, ts: now });
    return { ok: false, reason };
  }
  const intent: TeamManageIntent = consumed.intent;
  // The intent is now consumed (single-use — no double-apply). Everything past this
  // point is wrapped: a throw after consume must NEVER silently drop the intent
  // (review fix) — it writes a terminal apply-error receipt and reports failure so
  // the card shows "couldn't apply" instead of the confirm vanishing without trace.
  try {
    // Re-validate against the CURRENT backend state (race with a manual panel
    // toggle): applyConsumedIntent re-runs the Floor-Guard via applyControlAction.
    const { assignments, statuses } = await readTeam();
    const { next, applied } = applyConsumedIntent(intent, statuses);
    if (!applied) {
      writeReceipt({ event: 'apply-noop', intent_id, seat_id: seatId, role: intent.role_agent_id, action: intent.action, ts: now });
      return { ok: false, reason: 'not-applied' };
    }
    // The ONE write: PUT the new status map under the SAME seat-scoped key the panel
    // uses (configService.set → PUT /api/settings/client with seatScopedKey). Same
    // store, same key derivation — NOT a store-split.
    await httpRequest<void>('PUT', '/api/settings/client', {
      [seatScopedKey('commandEve.teamWorkerStatus', seatId)]: next,
    });
    // Refresh the derived launcher status files so the delegate-lane pause-gate is
    // honest immediately (A3). Its success is recorded in the receipt — a throw here
    // does NOT unwind the authoritative PUT (the shim reads teamWorkerStatus fresh,
    // so the pause is already effective there; only the delegate-lane file may lag
    // until the next boot/switch/panel-sync).
    let launcherSynced = false;
    try {
      syncEveWorkerLauncherFiles(assignments, next, { dataPath: getDataPath(), seatId });
      launcherSynced = true;
    } catch (error) {
      console.warn('[Command EVE] launcher sync after team_manage apply failed:', error);
    }
    writeReceipt({
      event: 'applied',
      intent_id,
      seat_id: seatId,
      role: intent.role_agent_id,
      action: intent.action,
      before: (statuses as Record<string, string>)[intent.role_agent_id] ?? 'active',
      after: (next as Record<string, string>)[intent.role_agent_id] ?? 'active',
      launcher_synced: launcherSynced,
      decided_by: 'user-confirm',
      source: intent.source,
      ts: now,
    });
    return { ok: true, role_agent_id: intent.role_agent_id, action: intent.action };
  } catch (error) {
    // A failure AFTER the intent was consumed (readTeam or the PUT threw): no silent
    // drop — terminal receipt + honest failure. No partial write happened (the PUT
    // is a single atomic call; if it threw, nothing was persisted).
    writeReceipt({
      event: 'apply-error',
      intent_id,
      seat_id: seatId,
      role: intent.role_agent_id,
      action: intent.action,
      error: error instanceof Error ? error.message : String(error),
      ts: now,
    });
    return { ok: false, reason: 'error' };
  }
}

/** Reject/dismiss the pending intent (the card's dismiss button). */
export function rejectTeamManageIntent(intent_id: string): { ok: boolean } {
  const seatId = getActiveSeatId();
  const now = Date.now();
  const consumed = consumeIntent(intent_id, seatId, now);
  writeReceipt({ event: 'rejected', intent_id, seat_id: seatId, ok: consumed.ok, ts: now });
  return { ok: consumed.ok };
}
