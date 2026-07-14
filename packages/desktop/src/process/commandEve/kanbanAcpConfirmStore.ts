/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE 1.7.0 — Kanban-ACP Propose/Confirm store (COMPA-626, Design-B mirror).
 *
 * "EVE schlägt vor, Code wendet an." This is the PURE heart of the kanban propose lane,
 * mirroring eveTeamManageBridgeCore: it validates a kanban write PROPOSAL against the
 * gate policy, and stores AT MOST ONE pending intent with a TTL. It holds NO write path
 * to kanban.db — there is no function here that mutates a card. The mutation happens ONLY
 * in the confirm IPC handler, against the existing desktop kanban bridge, AFTER the human
 * clicks the Confirm-Card. That structural gap is the governance gate.
 *
 * SCOPE-LOCK: the only ops are 'create' | 'move' | 'action' (comment/block/unblock/
 * complete). NEVER delete, dispatch, worker-spawn, assign, swarm, or decompose — those
 * are not even representable and any attempt to carry them is a hard reject.
 *
 * SEAT-PARTITION + TAMPER-GUARD: an intent carries the seat it was proposed on (consuming
 * on another seat is refused) AND a mutation hash of its canonical payload — the confirm
 * must present the SAME hash, so the human can only apply the EXACT change they saw, never
 * a swapped one (a TOCTOU / bait-and-switch guard team_manage did not need but a
 * free-form card payload does).
 */

import * as crypto from 'node:crypto';

/** The kanban write ops EVE may PROPOSE (nothing else is in scope). */
export const KANBAN_ACP_ALLOWED_OPS: readonly string[] = ['create', 'move', 'action'];
/** The card sub-actions the 'action' op may carry (dispatch/assign/delete are absent by design). */
export const KANBAN_ACP_ALLOWED_ACTIONS: readonly string[] = ['comment', 'block', 'unblock', 'complete'];
/** Keys that, if present on a proposal, mean it is trying to escape the propose scope. */
const KANBAN_FORBIDDEN_KEYS: readonly string[] = [
  'delete',
  'dispatch',
  'spawn',
  'assign',
  'worker',
  'swarm',
  'decompose',
  'heartbeat',
];

export const KANBAN_ACP_DEFAULT_TTL_MS = 5 * 60 * 1000;

/** The sanitized, op-specific fields the apply path feeds to the real kanban write. */
export interface KanbanAcpPayload {
  title?: string; // create
  lane?: string; // create (optional starting lane)
  task_id?: string; // move / action
  to_lane_key?: string; // move
  comment?: string; // action
}

export interface KanbanAcpIntent {
  readonly intent_id: string;
  readonly board_slug: string;
  readonly op: string; // 'create' | 'move' | 'action'
  readonly action: string; // '' for create/move; the sub-action for 'action'
  readonly payload: KanbanAcpPayload; // the sanitized fields apply executes
  readonly summary: string;
  readonly reason: string;
  readonly seat_id: string;
  readonly source: string;
  readonly mutation_hash: string;
  readonly created_ms: number;
  readonly expires_ms: number;
}

export type KanbanAcpRejectCode =
  | 'bad-schema'
  | 'not-visible'
  | 'unknown-op'
  | 'unknown-action'
  | 'scope-violation'
  | 'no-board'
  | 'missing-field';

export interface KanbanProposalValidation {
  ok: boolean;
  op?: string;
  action?: string;
  board_slug?: string;
  payload?: KanbanAcpPayload;
  summary?: string;
  reason?: string;
  mutation_hash?: string;
  reject_code?: KanbanAcpRejectCode;
  message?: string;
}

/** A COLLISION-RESISTANT sha256 hash of the canonical proposal — the tamper guard, so a
 * confirm can only apply the EXACT payload that was proposed. Codex re-audit: the prior
 * 32-bit polynomial hash collided (two different titles → same hash → a swapped payload
 * passed the tamper check). sha256 over a stable (sorted-key) canonical closes that. */
export function kanbanMutationHash(op: string, action: string, boardSlug: string, payload: unknown): string {
  let canonical = '';
  try {
    canonical = `${op}|${action}|${boardSlug}|${stableStringify(payload)}`;
  } catch {
    canonical = `${op}|${action}|${boardSlug}|<unserializable>`;
  }
  return `k_${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Stable JSON: object keys sorted so the same logical payload always hashes identically. */
function stableStringify(value: unknown, depth = 0): string {
  if (depth > 8) return '"…"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
}

/**
 * Validate a raw kanban proposal against the gate. Pure — never mutates. Requires the
 * surface to be VISIBLE (ready+seat+board from resolveKanbanAcpToolsetGate, passed in as
 * `visible`), a known op, an allowed sub-action for 'action', a board, and no forbidden
 * escape key. Computes the mutation hash for the tamper guard.
 */
export function validateKanbanProposal(
  payload: unknown,
  ctx: { visible: boolean; boardSlug: string }
): KanbanProposalValidation {
  if (!ctx || ctx.visible !== true) {
    return {
      ok: false,
      reject_code: 'not-visible',
      message: 'Die Kanban-Lane ist gerade nicht verfügbar (kein Board / kein aktiver Seat).',
    };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reject_code: 'bad-schema', message: 'Vorschlag muss ein Objekt sein.' };
  }
  const p = payload as Record<string, unknown>;
  for (const key of KANBAN_FORBIDDEN_KEYS) {
    if (key in p) {
      return { ok: false, reject_code: 'scope-violation', message: `Über diesen Kanal gesperrt: "${key}".` };
    }
  }
  const board = typeof ctx.boardSlug === 'string' ? ctx.boardSlug.trim() : '';
  if (!board) {
    return { ok: false, reject_code: 'no-board', message: 'Kein Board angegeben.' };
  }
  const op = typeof p.op === 'string' ? p.op.trim() : '';
  if (KANBAN_ACP_ALLOWED_OPS.indexOf(op) < 0) {
    return { ok: false, reject_code: 'unknown-op', message: `Unbekannte Operation: "${String(op)}".` };
  }
  let action = '';
  if (op === 'action') {
    action = typeof p.action === 'string' ? p.action.trim() : '';
    if (KANBAN_ACP_ALLOWED_ACTIONS.indexOf(action) < 0) {
      return { ok: false, reject_code: 'unknown-action', message: `Unbekannte Karten-Aktion: "${String(action)}".` };
    }
  }

  // Extract + sanitize the op-specific fields the apply path executes. EVE may name the
  // card as `task_id` or `card`, and the target lane as `to_lane_key` or `to`.
  const str = (v: unknown, cap: number): string => (typeof v === 'string' ? v.trim().slice(0, cap) : '');
  const fields: KanbanAcpPayload = {};
  if (op === 'create') {
    fields.title = str(p.title ?? p.card, 200);
    if (!fields.title)
      return { ok: false, reject_code: 'missing-field', message: 'Für eine neue Karte fehlt der Titel.' };
    const lane = str(p.lane ?? p.to ?? p.to_lane_key, 60);
    if (lane) fields.lane = lane;
  } else if (op === 'move') {
    fields.task_id = str(p.task_id ?? p.card, 120);
    fields.to_lane_key = str(p.to_lane_key ?? p.to, 60);
    if (!fields.task_id || !fields.to_lane_key)
      return {
        ok: false,
        reject_code: 'missing-field',
        message: 'Zum Verschieben fehlt die Karte oder die Ziel-Spalte.',
      };
  } else {
    // action
    fields.task_id = str(p.task_id ?? p.card, 120);
    if (!fields.task_id)
      return { ok: false, reject_code: 'missing-field', message: 'Für die Karten-Aktion fehlt die Karte.' };
    const comment = str(p.comment, 1000);
    if (comment) fields.comment = comment;
  }

  const reason = typeof p.reason === 'string' ? p.reason.slice(0, 500) : '';
  const summary = describeKanbanProposal(op, action, p);
  // The hash covers the op/action/board AND the sanitized fields, so the confirm can
  // only apply the exact change that was proposed.
  return {
    ok: true,
    op,
    action,
    board_slug: board,
    payload: fields,
    summary,
    reason,
    mutation_hash: kanbanMutationHash(op, action, board, { ...fields }),
  };
}

/** Human-readable German summary for the confirm card. Pure. */
export function describeKanbanProposal(op: string, action: string, payload: Record<string, unknown>): string {
  const title =
    typeof payload.title === 'string'
      ? payload.title.slice(0, 80)
      : typeof payload.card === 'string'
        ? payload.card.slice(0, 80)
        : '';
  const laneVerb: Record<string, string> = {
    create: 'Neue Karte anlegen',
    move: 'Karte verschieben',
    action: 'Karten-Aktion',
  };
  const actionVerb: Record<string, string> = {
    comment: 'kommentieren',
    block: 'blockieren',
    unblock: 'entsperren',
    complete: 'abschließen',
  };
  const head = laneVerb[op] || op;
  const tail = op === 'action' && actionVerb[action] ? ` — ${actionVerb[action]}` : '';
  return title ? `${head}${tail}: „${title}"` : `${head}${tail}`;
}

// ---- Single-pending intent store (module singleton; TTL; seat-partitioned) ----

let pending: KanbanAcpIntent | null = null;

export interface CreateKanbanIntentDeps {
  now: number;
  ttlMs?: number;
  randomId?: () => string;
}

/** Store a NEW pending intent, replacing any existing one (max 1 pending). */
export function createKanbanIntent(
  v: KanbanProposalValidation,
  seat_id: string,
  source: string,
  deps: CreateKanbanIntentDeps
): KanbanAcpIntent {
  const ttl = deps.ttlMs ?? KANBAN_ACP_DEFAULT_TTL_MS;
  const intent: KanbanAcpIntent = {
    intent_id: (deps.randomId ?? (() => `kintent-${deps.now}`))(),
    board_slug: v.board_slug || '',
    op: v.op || '',
    action: v.action || '',
    payload: v.payload || {},
    summary: v.summary || '',
    reason: v.reason || '',
    seat_id: typeof seat_id === 'string' ? seat_id.trim() || 'seat-1' : 'seat-1',
    source: source || 'skill',
    mutation_hash: v.mutation_hash || '',
    created_ms: deps.now,
    expires_ms: deps.now + ttl,
  };
  pending = intent;
  return intent;
}

/** The current pending intent if it exists and has not expired at `now`. */
export function peekKanbanIntent(now: number): KanbanAcpIntent | null {
  if (!pending) return null;
  if (now >= pending.expires_ms) return null;
  return pending;
}

/** The pending intent for the CURRENT seat, if live — the peek the renderer polls. */
export function peekKanbanIntentForSeat(currentSeatId: string, now: number): KanbanAcpIntent | null {
  const live = peekKanbanIntent(now);
  if (!live) return null;
  const seat = typeof currentSeatId === 'string' ? currentSeatId.trim() : '';
  return seat && live.seat_id === seat ? live : null;
}

export interface ConsumeKanbanResult {
  ok: boolean;
  intent?: KanbanAcpIntent;
  reason?: 'not-found' | 'expired' | 'wrong-intent' | 'wrong-seat' | 'tampered';
}

/**
 * Atomically take the pending intent for confirmation. Refuses (and clears) an expired
 * one, a mismatched intent_id, a mismatched seat, OR a mismatched mutation hash (the
 * confirmed change is not the proposed one — bait-and-switch). Success REMOVES it so it
 * can never be double-applied.
 */
export function consumeKanbanIntent(
  intent_id: string,
  currentSeatId: string,
  mutationHash: string,
  now: number
): ConsumeKanbanResult {
  const current = pending;
  if (!current) return { ok: false, reason: 'not-found' };
  if (current.intent_id !== intent_id) return { ok: false, reason: 'wrong-intent' };
  if (now >= current.expires_ms) {
    pending = null;
    return { ok: false, reason: 'expired' };
  }
  const seat = typeof currentSeatId === 'string' ? currentSeatId.trim() : '';
  if (!seat || current.seat_id !== seat) return { ok: false, reason: 'wrong-seat' };
  if (typeof mutationHash !== 'string' || mutationHash !== current.mutation_hash)
    return { ok: false, reason: 'tampered' };
  pending = null;
  return { ok: true, intent: current };
}

/** Clear the pending intent (e.g. on seat-switch). */
export function clearKanbanPendingIntent(): void {
  pending = null;
}

export interface KanbanProposeResponse {
  ok: boolean;
  status: 'proposed' | 'rejected';
  intent_id?: string;
  summary?: string;
  reject_code?: KanbanAcpRejectCode;
  message?: string;
}

/** Compose validate → create for the async propose lane. NO kanban.db write happens here. */
export function buildKanbanProposeResponse(
  payload: unknown,
  ctx: { visible: boolean; boardSlug: string; seatId: string; now: number; ttlMs?: number; randomId?: () => string }
): KanbanProposeResponse {
  const v = validateKanbanProposal(payload, { visible: ctx.visible, boardSlug: ctx.boardSlug });
  if (v.ok) {
    const intent = createKanbanIntent(v, ctx.seatId, 'skill', {
      now: ctx.now,
      ttlMs: ctx.ttlMs,
      randomId: ctx.randomId,
    });
    return { ok: true, status: 'proposed', intent_id: intent.intent_id, summary: v.summary };
  }
  return { ok: false, status: 'rejected', reject_code: v.reject_code, message: v.message };
}

/** Test seam. */
export function __resetKanbanAcpForTest(): void {
  pending = null;
}
