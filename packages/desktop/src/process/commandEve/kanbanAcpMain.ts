/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE 1.7.0 — Kanban-ACP main-side glue (COMPA-626, Design-B mirror).
 *
 * The thin IO layer around the pure kanbanAcpConfirmStore + kanbanAcpToolsetGateCore:
 * it authenticates the propose lane (per-boot bearer, ISO-6 gated on operator seat),
 * validates + stores the pending intent (NO kanban.db write on propose — B1), peeks for
 * the renderer, and on CONFIRM consumes the intent and performs the ONE real kanban write
 * by dispatching to the existing marketing-board write functions. Never auto-dispatches,
 * never spawns a worker, never deletes. An authoritative append-only receipt records
 * every propose / apply / refuse.
 *
 * ISO-6: the bearer resolver returns '' on a client seat, so the propose route is inert
 * there; the propose handler ALSO checks the seat kind directly (defense-in-depth).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataPath } from '@process/utils/utils';
import { getActiveSeatId, getActiveSeatKind } from './seatContextCore';
import { applyKanbanMarketingCardAction, createKanbanMarketingCard, moveKanbanMarketingCard } from './kanbanPreflightCore';
import { resolveKanbanAcpToolsetGate } from './kanbanAcpToolsetGateCore';
import { buildKanbanProposeResponse, consumeKanbanIntent, peekKanbanIntentForSeat, type KanbanAcpIntent } from './kanbanAcpConfirmStore';

/** The board EVE's ACP kanban surface operates on (the marketing board). */
export const KANBAN_ACP_BOARD_SLUG = 'marketing';

// --- per-boot bearer (ISO-6 gated) ---------------------------------------------

let bootBearer = '';

export function ensureKanbanAcpBearer(): string {
  if (!bootBearer) bootBearer = crypto.randomBytes(24).toString('hex');
  return bootBearer;
}

export function kanbanAcpBearerFilePath(dataPath: string): string {
  return path.join(dataPath, 'eve-kanban-acp', 'bearer');
}

/** FILE-deliver the bearer (H11 discipline): the value lives in a 0600 file, only the
 * PATH goes into EVE's env. Removed on a client seat (ISO-6). Returns the path or ''. */
export function provisionKanbanAcpBearerFile(dataPath: string, isClientSeat: boolean): string {
  const file = kanbanAcpBearerFilePath(dataPath);
  try {
    if (isClientSeat) {
      fs.rmSync(file, { force: true });
      return '';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ensureKanbanAcpBearer(), { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch (error) {
    console.warn('[Command EVE] kanban-acp bearer file provisioning failed:', error);
    return '';
  }
}

/** The bearer the shim route expects. '' on a client seat (route inert there). */
export function resolveKanbanAcpBearer(): string {
  if (getActiveSeatKind() === 'client') return '';
  return ensureKanbanAcpBearer();
}

// --- receipt (authoritative, append-only JSONL) --------------------------------

function receiptPath(): string {
  return path.join(getDataPath(), 'eve-kanban-acp', 'receipts.jsonl');
}

function writeReceipt(record: Record<string, unknown>): void {
  try {
    const file = receiptPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.warn('[Command EVE] kanban-acp receipt write failed:', error);
  }
}

/** Is the desktop-mediated surface visible for the active seat? Operator-only + a board. */
function resolveVisible(): boolean {
  if (getActiveSeatKind() === 'client') return false;
  const gate = resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: getActiveSeatId(), boardSlug: KANBAN_ACP_BOARD_SLUG });
  return gate.visible === true;
}

// --- propose (async lane; NO kanban.db write) ----------------------------------

/** The shim-injected propose handler: authentication happens in the shim; here we
 *  validate + store the pending intent. Returns the HTTP status/payload. */
export async function kanbanAcpProposeHandler(proposal: unknown): Promise<{ status: number; payload: unknown }> {
  if (getActiveSeatKind() === 'client') {
    return { status: 404, payload: { error: { message: 'kanban_manage is not available on this seat.' } } };
  }
  const seatId = getActiveSeatId();
  const now = Date.now();
  const res = buildKanbanProposeResponse(proposal, { visible: resolveVisible(), boardSlug: KANBAN_ACP_BOARD_SLUG, seatId, now });
  if (res.ok) {
    writeReceipt({ event: 'proposed', intent_id: res.intent_id, seat_id: seatId, summary: res.summary, ts: now });
    return { status: 202, payload: res };
  }
  return { status: 422, payload: res };
}

// --- peek (renderer poll) ------------------------------------------------------

export function peekKanbanAcpForRenderer(): { intent_id: string; op: string; action: string; summary: string; reason: string; mutation_hash: string; expires_ms: number } | null {
  const intent = peekKanbanIntentForSeat(getActiveSeatId(), Date.now());
  if (!intent) return null;
  return {
    intent_id: intent.intent_id,
    op: intent.op,
    action: intent.action,
    summary: intent.summary,
    reason: intent.reason,
    mutation_hash: intent.mutation_hash,
    expires_ms: intent.expires_ms,
  };
}

// --- apply (confirm IPC — the ONLY kanban.db write) ----------------------------

/** Dispatch a consumed intent to the real marketing-board write. Never deletes/dispatches. */
function applyKanbanWrite(intent: KanbanAcpIntent): { ok: boolean } {
  const userDataPath = getDataPath();
  const boardSlug = intent.board_slug || KANBAN_ACP_BOARD_SLUG;
  const pl = intent.payload || {};
  if (intent.op === 'create') {
    const result = createKanbanMarketingCard({
      userDataPath,
      title: pl.title || '',
      // Default to the first marketing lane ('research'); an invalid lane makes the real
      // write return ok:false → apply reports not-applied (fail-safe, no bad card).
      lane_key: pl.lane || 'research',
      // Deterministic idempotency token: the same confirmed proposal never double-creates.
      client_token: intent.mutation_hash,
      boardSlug,
    });
    return { ok: result?.ok === true };
  }
  if (intent.op === 'move') {
    const result = moveKanbanMarketingCard({ userDataPath, task_id: pl.task_id || '', to_lane_key: pl.to_lane_key || '', boardSlug });
    return { ok: result?.ok === true };
  }
  if (intent.op === 'action') {
    const action = (intent.action as 'comment' | 'block' | 'unblock' | 'complete') || 'comment';
    const result = applyKanbanMarketingCardAction({ userDataPath, task_id: pl.task_id || '', action, comment: pl.comment, boardSlug });
    return { ok: result?.ok === true };
  }
  return { ok: false };
}

export async function applyKanbanAcpIntent(intent_id: string, mutationHash: string): Promise<{ ok: boolean; reason?: string; op?: string }> {
  const seatId = getActiveSeatId();
  const now = Date.now();
  const consumed = consumeKanbanIntent(intent_id, seatId, mutationHash, now);
  if (!consumed.ok) {
    writeReceipt({ event: 'apply-refused', intent_id, seat_id: seatId, reason: consumed.reason, ts: now });
    return { ok: false, reason: consumed.reason };
  }
  const intent = consumed.intent;
  // Consumed (single-use). A throw past here must never silently drop the intent — it
  // writes a terminal receipt and reports failure so the card shows "couldn't apply".
  try {
    const { ok } = applyKanbanWrite(intent);
    writeReceipt({ event: ok ? 'applied' : 'apply-noop', intent_id, seat_id: seatId, op: intent.op, action: intent.action, board: intent.board_slug, decided_by: 'user-confirm', ts: now });
    return ok ? { ok: true, op: intent.op } : { ok: false, reason: 'not-applied' };
  } catch (error) {
    writeReceipt({ event: 'apply-error', intent_id, seat_id: seatId, op: intent.op, error: error instanceof Error ? error.message : String(error), ts: now });
    return { ok: false, reason: 'error' };
  }
}

/** Reject/dismiss the pending intent (the card's dismiss button). */
export function rejectKanbanAcpIntent(intent_id: string): { ok: boolean } {
  const seatId = getActiveSeatId();
  const now = Date.now();
  // Consume with the stored hash (a dismiss does not need to prove the hash) — refetch it.
  const live = peekKanbanIntentForSeat(seatId, now);
  const hash = live && live.intent_id === intent_id ? live.mutation_hash : '';
  const consumed = consumeKanbanIntent(intent_id, seatId, hash, now);
  writeReceipt({ event: 'rejected', intent_id, seat_id: seatId, ok: consumed.ok, ts: now });
  return { ok: consumed.ok };
}
