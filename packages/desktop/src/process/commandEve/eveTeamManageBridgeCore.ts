/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE 1.7.0 — team_manage Propose/Confirm core (SG-1 Design B).
 *
 * "EVE schlägt vor, Code wendet an. 'Nie still' ist Architektur, nicht Konvention."
 *
 * This module is the PURE heart of the propose lane: it validates a proposal,
 * runs the Floor-Guard, and stores AT MOST ONE pending intent with a TTL. It holds
 * NO write path to the settings store — by construction there is no function here
 * that mutates commandEve.teamWorkerStatus. The write happens ONLY in the confirm
 * IPC handler (apply), against a fresh backend read. That structural gap is gate B1.
 *
 * Scope-lock (B8): the ONLY thing team_manage can change is a role's STATUS
 * (pause/resume/stop/release/hire — all EveTeamControlAction status transitions).
 * A proposal that tries to touch assignment / cli_path (code-execution vector) /
 * free (money flag) / tier is REJECTED — those are not even representable in the
 * proposal schema, and any attempt to smuggle them in is a hard reject.
 *
 * Seat-partition: an intent carries the seat it was proposed on; consuming it on a
 * different seat is refused (the bridge lives on the singleton shim server, which
 * survives seat-switches — same isolation discipline as eveAgentTaskRegistry).
 */

import * as crypto from 'node:crypto';
import {
  applyControlAction,
  evaluateFloorGuard,
  type EveTeamControlAction,
  type EveTeamWorkerStatusMap,
} from '../../common/config/eveTeamControlsCore';
import { EVE_TEAM_ROSTER, findEveTeamRole, isEveTeamAgentId } from '../../common/config/eveTeamRoster';

/** The status-transition verbs team_manage may propose (nothing else is in scope). */
const ALLOWED_ACTIONS: readonly EveTeamControlAction[] = ['pause', 'resume', 'stop', 'release', 'hire'];
/** Keys that, if present on a proposal, mean it is trying to escape the set_status scope (B8). */
const FORBIDDEN_KEYS = ['assignment', 'cli_path', 'cli_version', 'free', 'tier', 'kind', 'model', 'worker'];

export const TEAM_MANAGE_DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface TeamManageIntent {
  readonly intent_id: string;
  readonly role_agent_id: string;
  readonly action: EveTeamControlAction;
  readonly seat_id: string;
  readonly source: string;
  readonly reason: string;
  readonly created_ms: number;
  readonly expires_ms: number;
}

export type TeamManageRejectCode =
  | 'bad-schema'
  | 'unknown-role'
  | 'unknown-action'
  | 'scope-violation'
  | 'would-empty-company';

// NOTE: this project runs WITHOUT strictNullChecks, so TS does not narrow
// discriminated unions on a boolean discriminant. These result types are therefore
// flat interfaces with optional fields (the idiomatic shape here) — `ok` tells the
// caller which fields are populated; the runtime logic + unit tests are the guarantee.
export interface ProposalValidation {
  ok: boolean;
  /** present when ok */
  role_agent_id?: string;
  action?: EveTeamControlAction;
  reason?: string;
  /** present when !ok */
  reject_code?: TeamManageRejectCode;
  message?: string;
}

/**
 * Validate a raw proposal payload against the roster, the action scope, and the
 * Floor-Guard. Pure — reads statuses, never writes. A firmenleerende sequence is
 * REJECTED here already (B2), with a machine-readable code, so EVE gets a feedback
 * loop instead of a silently-swallowed proposal.
 */
export function validateProposal(
  payload: unknown,
  statuses: EveTeamWorkerStatusMap,
  roster: readonly (typeof EVE_TEAM_ROSTER)[number][] = EVE_TEAM_ROSTER
): ProposalValidation {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reject_code: 'bad-schema', message: 'Proposal must be an object.' };
  }
  const p = payload as Record<string, unknown>;

  // B8 scope-lock: reject any attempt to carry an out-of-scope mutation key.
  for (const key of FORBIDDEN_KEYS) {
    if (key in p) {
      return {
        ok: false,
        reject_code: 'scope-violation',
        message: `team_manage darf nur den Status ändern — "${key}" ist über diesen Kanal gesperrt.`,
      };
    }
  }

  const roleId = typeof p.role_agent_id === 'string' ? p.role_agent_id : typeof p.role === 'string' ? p.role : '';
  if (!isEveTeamAgentId(roleId)) {
    return { ok: false, reject_code: 'unknown-role', message: `Unbekannte Rolle: "${String(roleId)}".` };
  }
  const action = p.action;
  if (typeof action !== 'string' || !ALLOWED_ACTIONS.includes(action as EveTeamControlAction)) {
    return { ok: false, reject_code: 'unknown-action', message: `Unbekannte Aktion: "${String(action)}".` };
  }
  const role = findEveTeamRole(roleId);
  if (!role) {
    return { ok: false, reject_code: 'unknown-role', message: `Unbekannte Rolle: "${roleId}".` };
  }

  // B2 Floor-Guard at PROPOSE: a company-emptying action is refused here, not just
  // warned. (The operator can still do it manually via the panel Popconfirm.)
  const guard = evaluateFloorGuard(role, action as EveTeamControlAction, statuses, roster);
  if (guard.requiresWarning) {
    return {
      ok: false,
      reject_code: 'would-empty-company',
      message:
        'Das würde deine Firma ohne aktiven Mitarbeiter zurücklassen. EVE schlägt so etwas nicht vor — nimm die Änderung bei Bedarf selbst in "Dein Team" vor.',
    };
  }

  const reason = typeof p.reason === 'string' ? p.reason.slice(0, 500) : '';
  return { ok: true, role_agent_id: roleId, action: action as EveTeamControlAction, reason };
}

/**
 * Compute the human-readable German diff + Floor-Guard note for the confirm card.
 * Pure. The honesty sentence (B6) is APPENDED by the card renderer, not here.
 */
export function describeProposal(role_agent_id: string, action: EveTeamControlAction): string {
  const role = findEveTeamRole(role_agent_id);
  const name = role ? `${role.displayName} (${role.title})` : role_agent_id;
  const verb: Record<EveTeamControlAction, string> = {
    pause: 'pausieren (drosseln)',
    resume: 'fortsetzen',
    stop: 'stoppen',
    release: 'entlassen',
    hire: 'für einen Sprint einstellen',
  };
  return `${name} ${verb[action]}`;
}

// ---- Single-pending intent store (module singleton; TTL; seat-partitioned) ----

let pending: TeamManageIntent | null = null;

export interface CreateIntentDeps {
  now: number;
  ttlMs?: number;
  randomId?: () => string;
}

/**
 * Store a NEW pending intent, replacing any existing one (B4: max 1 pending — a
 * new proposal supersedes an unconfirmed old one). Returns the stored intent.
 */
export function createIntent(
  role_agent_id: string,
  action: EveTeamControlAction,
  seat_id: string,
  source: string,
  reason: string,
  deps: CreateIntentDeps
): TeamManageIntent {
  const ttl = deps.ttlMs ?? TEAM_MANAGE_DEFAULT_TTL_MS;
  const intent: TeamManageIntent = {
    // COLLISION-FREE (final-audit): the id carries a random uuid suffix, not just
    // `intent-${now}`. Two proposals in the SAME millisecond used to share an id, so
    // the confirm-card kept the OLD visible change while the pending intent was the
    // NEW one — the operator could confirm A while B applied. With unique ids, a
    // superseded card's id no longer matches the pending intent, so consumeIntent
    // refuses the stale confirm ('wrong-intent') and the card updates to the live one.
    intent_id: (deps.randomId ?? (() => `intent-${deps.now}-${crypto.randomUUID()}`))(),
    role_agent_id,
    action,
    seat_id: typeof seat_id === 'string' ? seat_id.trim() || 'seat-1' : 'seat-1',
    source: source || 'unbekannt',
    reason,
    created_ms: deps.now,
    expires_ms: deps.now + ttl,
  };
  pending = intent;
  return intent;
}

/** The current pending intent if it exists and has not expired at `now`. */
export function peekIntent(now: number): TeamManageIntent | null {
  if (!pending) return null;
  if (now >= pending.expires_ms) return null;
  return pending;
}

export interface ConsumeResult {
  ok: boolean;
  /** present when ok */
  intent?: TeamManageIntent;
  /** present when !ok */
  reason?: 'not-found' | 'expired' | 'wrong-intent' | 'wrong-seat';
}

/**
 * Atomically take the pending intent for confirmation. Refuses (and clears) an
 * expired one (B4/B7 expired-receipt), a mismatched intent_id, or a mismatched
 * seat (seat-partition). Success REMOVES it so it can never be double-applied.
 */
export function consumeIntent(intent_id: string, currentSeatId: string, now: number): ConsumeResult {
  const current = pending;
  if (!current) return { ok: false, reason: 'not-found' };
  if (current.intent_id !== intent_id) return { ok: false, reason: 'wrong-intent' };
  if (now >= current.expires_ms) {
    pending = null;
    return { ok: false, reason: 'expired' };
  }
  const seat = typeof currentSeatId === 'string' ? currentSeatId.trim() : '';
  if (!seat || current.seat_id !== seat) return { ok: false, reason: 'wrong-seat' };
  pending = null;
  return { ok: true, intent: current };
}

/** Clear the pending intent (e.g. on seat-switch, or after a manual panel change). */
export function clearPendingIntent(): void {
  pending = null;
}

/**
 * The pending intent for the CURRENT seat, if live (not expired) — the peek the
 * renderer polls to know whether to surface a confirm card. Seat-partitioned: a
 * pending intent from another seat is invisible here (it can neither be shown nor
 * confirmed on the wrong seat). B4: survives a renderer restart because the intent
 * lives main-side, so the card re-appears on the next poll.
 */
export function peekIntentForSeat(currentSeatId: string, now: number): TeamManageIntent | null {
  const live = peekIntent(now);
  if (!live) return null;
  const seat = typeof currentSeatId === 'string' ? currentSeatId.trim() : '';
  return seat && live.seat_id === seat ? live : null;
}

export interface ProposeResponse {
  ok: boolean;
  status: 'proposed' | 'rejected';
  /** present when ok */
  intent_id?: string;
  summary?: string;
  /** present when !ok */
  reject_code?: TeamManageRejectCode;
  message?: string;
}

/**
 * Compose validate → create for the async propose lane: EVE POSTs a proposal, gets
 * an immediate `proposed` + intent_id (or a machine-readable `rejected` with a
 * reason) and polls. NO write to settings happens here — only the pending intent is
 * stored; the actual status write is the confirm handler's job (B1). Pure over its
 * inputs (statuses/seat/now/randomId injected), so it is fully unit-testable.
 */
export function buildProposeResponse(
  payload: unknown,
  statuses: EveTeamWorkerStatusMap,
  ctx: { seatId: string; now: number; ttlMs?: number; randomId?: () => string }
): ProposeResponse {
  const v = validateProposal(payload, statuses);
  if (v.ok) {
    const intent = createIntent(v.role_agent_id, v.action, ctx.seatId, 'skill', v.reason, {
      now: ctx.now,
      ttlMs: ctx.ttlMs,
      randomId: ctx.randomId,
    });
    return { ok: true, intent_id: intent.intent_id, status: 'proposed', summary: describeProposal(v.role_agent_id, v.action) };
  }
  return { ok: false, status: 'rejected', reject_code: v.reject_code, message: v.message };
}

/** Test seam. */
export function __resetTeamManageForTest(): void {
  pending = null;
}

/**
 * Apply a consumed intent to a FRESH status map (B5/apply). Returns the new map +
 * whether it applied. Delegates to the pure applyControlAction with confirmedWarning
 * so the Floor-Guard resolution is honoured. The CALLER (confirm IPC handler) is
 * responsible for persisting `next` via the single 1.6.3 writer and re-validating
 * against the current backend state first (Store-Split discipline).
 */
export function applyConsumedIntent(
  intent: TeamManageIntent,
  freshStatuses: EveTeamWorkerStatusMap
): { next: EveTeamWorkerStatusMap; applied: boolean } {
  const role = findEveTeamRole(intent.role_agent_id);
  if (!role) return { next: freshStatuses, applied: false };
  const { next, applied } = applyControlAction(role, intent.action, freshStatuses, { confirmedWarning: true });
  return { next, applied };
}
