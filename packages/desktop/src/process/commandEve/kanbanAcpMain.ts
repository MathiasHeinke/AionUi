/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE 1.7.0 — Kanban-ACP main-side glue (COMPA-626, Design-B mirror).
 *
 * The thin IO layer around the pure kanbanAcpConfirmStore + kanbanAcpToolsetGateCore: it
 * authenticates the propose lane (per-boot bearer, ISO-6 gated on operator seat),
 * validates + stores the pending intent (NO kanban.db write on propose — K1), peeks for
 * the renderer, exposes a READ-ONLY board digest to EVE (K10, no write path), and on
 * CONFIRM consumes the intent and performs the ONE real kanban write by dispatching to
 * the existing marketing-board write functions. Never auto-dispatches / spawns / deletes.
 *
 * Codex re-audit hardening: apply re-checks the client seat (K3); move/action prove the
 * target card belongs to the marketing board (K16); apply fails CLOSED if the authoritative
 * receipt can not be written first (K18); rejected proposals are receipted (K13); the
 * bearer + receipt files are chmod-verified even when preexisting (K3/K13); the create
 * idempotency token is the crypto-random intent id (never the mutation hash).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataPath } from '@process/utils/utils';
import { getActiveSeatId, getActiveSeatKind } from './seatContextCore';
import { applyKanbanMarketingCardAction, buildKanbanMarketingBoard, createKanbanMarketingCard, moveKanbanMarketingCard } from './kanbanPreflightCore';
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
 * PATH goes into EVE's env. Removed on a client seat (ISO-6). chmod is enforced even on a
 * preexisting file (writeFileSync mode only applies on creation). Returns the path or ''. */
export function provisionKanbanAcpBearerFile(dataPath: string, isClientSeat: boolean): string {
  const file = kanbanAcpBearerFilePath(dataPath);
  try {
    if (isClientSeat) {
      fs.rmSync(file, { force: true });
      return '';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ensureKanbanAcpBearer(), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600); // enforce 0600 even if the file preexisted with broad perms
    } catch {
      /* best-effort chmod */
    }
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

// --- receipt (authoritative, append-only JSONL; returns success for K18) --------

function receiptPath(): string {
  return path.join(getDataPath(), 'eve-kanban-acp', 'receipts.jsonl');
}

function writeReceipt(record: Record<string, unknown>): boolean {
  try {
    const file = receiptPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best-effort chmod */
    }
    return true;
  } catch (error) {
    console.warn('[Command EVE] kanban-acp receipt write failed:', error);
    return false;
  }
}

// --- board read (shared by preflight, ownership check, and read-exposure) --------

function readBoard() {
  return buildKanbanMarketingBoard({ userDataPath: getDataPath(), boardSlug: KANBAN_ACP_BOARD_SLUG });
}

/** Flatten every card across the board's lane columns. */
function allBoardCards(board: ReturnType<typeof readBoard>): Array<{ card_id: string; card_title: string; card_status: string; lane_key: string }> {
  const columns = (board && board.model && board.model.columns) || [];
  const out: Array<{ card_id: string; card_title: string; card_status: string; lane_key: string }> = [];
  for (const col of columns) {
    for (const c of col.cards || []) out.push({ card_id: c.card_id, card_title: c.card_title, card_status: c.card_status, lane_key: c.lane_key });
  }
  return out;
}

/** Is the desktop-mediated surface visible? Operator-only + a REAL, readable board. */
function resolveVisible(): boolean {
  if (getActiveSeatKind() === 'client') return false;
  const board = readBoard();
  if (!board || board.ok !== true) return false; // real preflight, not a hardcoded true
  const gate = resolveKanbanAcpToolsetGate({ preflightReady: true, activeSeatId: getActiveSeatId(), boardSlug: KANBAN_ACP_BOARD_SLUG });
  return gate.visible === true;
}

/** True when `task_id` is a card that actually lives on the marketing board (K16). */
function isMarketingCard(task_id: string): boolean {
  if (!task_id) return false;
  const board = readBoard();
  if (!board || board.ok !== true) return false;
  return allBoardCards(board).some((c) => c.card_id === task_id);
}

// --- READ EXPOSURE (K10) — a read-only board digest; NO write path, no intent, no hash --

export interface KanbanAcpReadResult {
  ok: boolean;
  board_slug: string;
  lanes: string[];
  cards: Array<{ card_id: string; title: string; lane: string; status: string }>;
  reason?: string;
}

/** The board state EVE may SEE. Operator-only, seat-scoped, capped + sanitized, read-only.
 * Carries NO mutation surface — no intent_id, no mutation_hash, no confirm. */
export function readKanbanAcpBoard(): KanbanAcpReadResult {
  const empty = (reason: string): KanbanAcpReadResult => ({ ok: false, board_slug: KANBAN_ACP_BOARD_SLUG, lanes: [], cards: [], reason });
  if (getActiveSeatKind() === 'client') return empty('not-available-on-client-seat');
  const board = readBoard();
  if (!board || board.ok !== true) return empty((board && board.reason_code) || 'board-not-ready');
  const raw = allBoardCards(board);
  const cards = raw.slice(0, 200).map((c) => ({ card_id: c.card_id, title: String(c.card_title || '').slice(0, 200), lane: c.lane_key, status: c.card_status }));
  const lanes = Array.from(new Set<string>(cards.map((c) => c.lane)));
  return { ok: true, board_slug: KANBAN_ACP_BOARD_SLUG, lanes, cards };
}

// --- propose (async lane; NO kanban.db write) ----------------------------------

export async function kanbanAcpProposeHandler(proposal: unknown): Promise<{ status: number; payload: unknown }> {
  if (getActiveSeatKind() === 'client') {
    return { status: 404, payload: { error: { message: 'kanban_manage is not available on this seat.' } } };
  }
  const seatId = getActiveSeatId();
  const now = Date.now();
  const res = buildKanbanProposeResponse(proposal, {
    visible: resolveVisible(),
    boardSlug: KANBAN_ACP_BOARD_SLUG,
    seatId,
    now,
    randomId: () => `k_${crypto.randomBytes(12).toString('hex')}`,
  });
  if (res.ok) {
    writeReceipt({ event: 'proposed', intent_id: res.intent_id, seat_id: seatId, summary: res.summary, ts: now });
    return { status: 202, payload: res };
  }
  // K13: a rejected proposal is receipted too (EVE gets a machine-readable reject + an audit row).
  writeReceipt({ event: 'propose-rejected', seat_id: seatId, reject_code: res.reject_code, ts: now });
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

/** Dispatch a consumed intent to the real marketing-board write. Never deletes/dispatches.
 * move/action are refused unless the target card belongs to the marketing board (K16). */
function applyKanbanWrite(intent: KanbanAcpIntent): { ok: boolean } {
  const userDataPath = getDataPath();
  const boardSlug = intent.board_slug || KANBAN_ACP_BOARD_SLUG;
  const pl = intent.payload || {};
  if (intent.op === 'create') {
    const result = createKanbanMarketingCard({
      userDataPath,
      title: pl.title || '',
      // Default to the first marketing lane; an invalid lane makes the real write return
      // ok:false → apply reports not-applied (fail-safe).
      lane_key: pl.lane || 'research',
      // Idempotency: the crypto-random intent id (unique per proposal); NEVER the mutation
      // hash (a hash could theoretically collide, deduping two distinct creates).
      client_token: intent.intent_id,
      boardSlug,
    });
    return { ok: result?.ok === true };
  }
  if (intent.op === 'move') {
    if (!isMarketingCard(pl.task_id || '')) return { ok: false }; // K16
    const result = moveKanbanMarketingCard({ userDataPath, task_id: pl.task_id || '', to_lane_key: pl.to_lane_key || '', boardSlug });
    return { ok: result?.ok === true };
  }
  if (intent.op === 'action') {
    if (!isMarketingCard(pl.task_id || '')) return { ok: false }; // K16
    const action = (intent.action as 'comment' | 'block' | 'unblock' | 'complete') || 'comment';
    const result = applyKanbanMarketingCardAction({ userDataPath, task_id: pl.task_id || '', action, comment: pl.comment, boardSlug });
    return { ok: result?.ok === true };
  }
  return { ok: false };
}

export async function applyKanbanAcpIntent(intent_id: string, mutationHash: string): Promise<{ ok: boolean; reason?: string; op?: string }> {
  const seatId = getActiveSeatId();
  const now = Date.now();
  // K3 defense-in-depth: never apply on a client seat, even if an intent somehow exists.
  if (getActiveSeatKind() === 'client') {
    writeReceipt({ event: 'apply-refused', intent_id, seat_id: seatId, reason: 'client-seat', ts: now });
    return { ok: false, reason: 'client-seat' };
  }
  const consumed = consumeKanbanIntent(intent_id, seatId, mutationHash, now);
  if (!consumed.ok) {
    writeReceipt({ event: 'apply-refused', intent_id, seat_id: seatId, reason: consumed.reason, ts: now });
    return { ok: false, reason: consumed.reason };
  }
  const intent = consumed.intent;
  // K18: prove the authoritative receipt is writable BEFORE the kanban write. If it is
  // not, refuse the write — a confirmed mutation must never happen without an audit row.
  if (!writeReceipt({ event: 'applying', intent_id, seat_id: seatId, op: intent.op, action: intent.action, board: intent.board_slug, ts: now })) {
    return { ok: false, reason: 'no-receipt' };
  }
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
  const live = peekKanbanIntentForSeat(seatId, now);
  const hash = live && live.intent_id === intent_id ? live.mutation_hash : '';
  const consumed = consumeKanbanIntent(intent_id, seatId, hash, now);
  writeReceipt({ event: 'rejected', intent_id, seat_id: seatId, ok: consumed.ok, ts: now });
  return { ok: consumed.ok };
}
