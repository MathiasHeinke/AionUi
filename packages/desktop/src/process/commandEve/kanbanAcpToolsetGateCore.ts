/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE KANBAN-ACP TOOLSET GATE core (1.7.0 / COMPA-626 — the PURE policy
 * resolver for how EVE (the ACP agent) may touch the native Hermes Kanban).
 *
 * FACT (bundled Hermes wheel, toolsets.py + tools/kanban_tools.py): the native
 * "kanban" toolset is ONE all-or-nothing group of 9 tools — reads (kanban_show,
 * kanban_list) AND writes (kanban_create/complete/block/unblock/comment/link/
 * heartbeat) — that mutate kanban.db IN-PROCESS. It self-enables when the profile
 * lists "kanban" in its toolsets OR the process is a dispatcher-spawned worker
 * (HERMES_KANBAN_TASK). So it CANNOT be split read-only at the config level, and an
 * in-process write can NOT be wrapped in a Confirm-Card after the fact.
 *
 * Therefore the gate is: NEVER hand the raw "kanban" toolset to the ACP agent.
 * Instead EVE gets a DESKTOP-MEDIATED surface — a visible READ of the board plus
 * WRITE PROPOSALS that only land after an explicit Confirm-Card (the same
 * button-only, YOLO-exempt governance gate as team_manage). No auto-dispatch, no
 * worker-spawn, no delete — ever. This module is the pure decision + the structural
 * invariants; the bridge + confirm store do the I/O.
 */

/** The desktop-mediated ACP kanban tools EVE may be offered (NOT the raw wheel tools). */
export type KanbanAcpTool =
  | 'kanban.board.read' // visible read: board + cards (maps to wheel kanban_show/list, read-only)
  | 'kanban.card.create.plan' // PROPOSE a new card — no mutation until confirmed
  | 'kanban.card.move.plan' // PROPOSE a lane move
  | 'kanban.card.action.plan' // PROPOSE comment/block/unblock/complete
  | 'kanban.write.confirm'; // apply a proposal AFTER the human confirms the card

/** The raw wheel kanban tools. The reads are safe to mirror; the writes must NEVER be
 * exposed directly to the ACP agent (they mutate kanban.db in-process, un-gated). */
export const KANBAN_WHEEL_READ_TOOLS: readonly string[] = Object.freeze(['kanban_show', 'kanban_list']);
export const KANBAN_WHEEL_WRITE_TOOLS: readonly string[] = Object.freeze(['kanban_create', 'kanban_complete', 'kanban_block', 'kanban_unblock', 'kanban_comment', 'kanban_link', 'kanban_heartbeat']);

/** The raw wheel TOOLSET key that must never appear in the ACP agent's platform toolsets. */
export const KANBAN_WHEEL_TOOLSET_KEY = 'kanban';

/** Sentinel leak: the scan could not complete (pathological/hostile input hit the node
 * budget or threw). Reported so an incomplete scan is NEVER mistaken for "clean". */
export const KANBAN_LEAK_SCAN_TRUNCATED = '__kanban_scan_truncated__';

/** Config markers that would turn on autonomous dispatch / worker-spawn — must stay off.
 * Matched as case-insensitive SUBSTRINGS (so `HERMES_KANBAN_TASK`, `kanban.dispatch_in_gateway`,
 * a bare `dispatch_in_gateway`, `kanban.auto_decompose`, a bare `auto_decompose`, etc. all hit). */
export const KANBAN_FORBIDDEN_DISPATCH_MARKERS: readonly string[] = Object.freeze(['kanban_task', 'dispatch_in_gateway', 'kanban_swarm', 'kanban_decompose', 'auto_decompose']);

export const KANBAN_ACP_READ_TOOLS: readonly KanbanAcpTool[] = Object.freeze(['kanban.board.read']);
export const KANBAN_ACP_WRITE_TOOLS: readonly KanbanAcpTool[] = Object.freeze(['kanban.card.create.plan', 'kanban.card.move.plan', 'kanban.card.action.plan', 'kanban.write.confirm']);

/** The fixed policy — these bits are structural, never negotiable per call. */
export interface KanbanAcpGatePolicy {
  writeRequiresConfirmCard: true;
  autoDispatchAllowed: false;
  workerSpawnAllowed: false;
  deleteAllowed: false;
}

export interface KanbanAcpGateInput {
  /** True when the kanban preflight resolved 'ready' (db reachable + board present). */
  preflightReady?: boolean;
  /** The active seat (writes are pinned to it; a seatless call exposes nothing). */
  activeSeatId?: string;
  /** The board the surface targets (empty ⇒ nothing exposed). */
  boardSlug?: string;
}

export interface KanbanAcpGateResult {
  /** True only when the surface may be shown at all (ready + seat + board). */
  visible: boolean;
  readTools: KanbanAcpTool[];
  writeTools: KanbanAcpTool[];
  /** The raw wheel write tools that are explicitly withheld from the agent (audit). */
  blockedTools: string[];
  policy: KanbanAcpGatePolicy;
}

/** A FRESH frozen policy every call — never a shared mutable object a caller could
 * poison for every future call (Codex re-audit). Frozen so an attempt to flip a bit
 * fails instead of silently sticking. */
function freshPolicy(): KanbanAcpGatePolicy {
  return Object.freeze({ writeRequiresConfirmCard: true, autoDispatchAllowed: false, workerSpawnAllowed: false, deleteAllowed: false }) as KanbanAcpGatePolicy;
}

const denied = (): KanbanAcpGateResult => ({ visible: false, readTools: [], writeTools: [], blockedTools: [...KANBAN_WHEEL_WRITE_TOOLS], policy: freshPolicy() });

/**
 * Resolve what EVE may do with the board this turn. DEFAULT-DENY: unless the preflight
 * is ready AND there is an active seat AND a board slug, NOTHING is exposed (not even
 * read). When exposed, reads are offered and writes are offered ONLY as proposals (the
 * apply step is gated by the Confirm-Card). The raw wheel write tools are always in
 * blockedTools — never handed to the agent. NEVER throws: a hostile input (e.g. a
 * throwing getter) fails CLOSED to a denied result.
 */
export function resolveKanbanAcpToolsetGate(input: KanbanAcpGateInput): KanbanAcpGateResult {
  try {
    const inp = input || {};
    const seat = typeof inp.activeSeatId === 'string' ? inp.activeSeatId.trim() : '';
    const board = typeof inp.boardSlug === 'string' ? inp.boardSlug.trim() : '';
    if (inp.preflightReady !== true || seat.length === 0 || board.length === 0) return denied();
    return {
      visible: true,
      readTools: [...KANBAN_ACP_READ_TOOLS],
      writeTools: [...KANBAN_ACP_WRITE_TOOLS],
      blockedTools: [...KANBAN_WHEEL_WRITE_TOOLS],
      policy: freshPolicy(),
    };
  } catch {
    return denied();
  }
}

/** Recursively collect every string LEAF from an arbitrary value (arrays + object
 * values). Robust against hostile input: bounded by DEPTH, total collected strings, AND
 * a shared NODE budget (so a huge sparse array / huge object can not burn time), and each
 * element/key is read in its OWN try/catch so ONE throwing getter can not hide the
 * siblings after it (Codex re-audit). `budget.n` is decremented per node visited. */
function collectStringLeaves(value: unknown, out: string[], depth: number, budget: { n: number; exhausted: boolean }): void {
  if (depth > 6) return;
  // The node budget is the SINGLE bound — it decrements once per node, so `out` can
  // never exceed the initial budget, and an exhausted budget is flagged (never a silent
  // truncation that reads as clean).
  if (budget.n <= 0) {
    budget.exhausted = true;
    return;
  }
  budget.n -= 1;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    let len = 0;
    try {
      len = value.length; // a Proxy length trap could throw — unscannable ⇒ fail-closed
    } catch {
      budget.exhausted = true;
      return;
    }
    for (let i = 0; i < len; i += 1) {
      if (budget.n <= 0) {
        budget.exhausted = true;
        return;
      }
      try {
        collectStringLeaves(value[i], out, depth + 1, budget);
      } catch {
        budget.exhausted = true; // throwing element getter — skip it, keep siblings, flag incomplete
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    let keys: string[] = [];
    try {
      keys = Object.keys(value);
    } catch {
      budget.exhausted = true;
      return;
    }
    for (const k of keys) {
      if (budget.n <= 0) {
        budget.exhausted = true;
        return;
      }
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[k];
      } catch {
        budget.exhausted = true; // hostile getter on THIS key — keep scanning others, flag incomplete
        continue;
      }
      try {
        collectStringLeaves(child, out, depth + 1, budget);
      } catch {
        budget.exhausted = true;
      }
    }
  }
}

/**
 * STRUCTURAL INVARIANT: the raw wheel "kanban" toolset, any raw kanban WRITE tool, and
 * any dispatch/decompose/swarm marker must NEVER appear ANYWHERE in the ACP agent's
 * emitted platform toolset config — otherwise EVE would get the un-gated in-process
 * write tools + dispatch, bypassing the Confirm-Card. Scans recursively (arrays + object
 * values), case-insensitively; exact match for the toolset key + write tools (so
 * `kanban.board.read` is NOT flagged) and SUBSTRING match for the dispatch markers.
 * Returns the offending original strings (empty = clean).
 *
 * THREAT MODEL: the input is the desktop's OWN emitted ACP platform-toolset list — a
 * small array of short strings — so this guards a config REGRESSION (did the render
 * accidentally include a kanban write/dispatch entry?), not adversarial input. Even so
 * it is hardened to never throw and to fail-CLOSED: a pathological input that exhausts
 * the node budget or throws is reported as a KANBAN_LEAK_SCAN_TRUNCATED sentinel (a
 * non-empty result ⇒ "not clean"), never a silent empty/clean.
 */
export function findRawKanbanLeaks(acpPlatformToolsets: unknown): string[] {
  try {
    const strings: string[] = [];
    const budget = { n: 20000, exhausted: false };
    collectStringLeaves(acpPlatformToolsets, strings, 0, budget);
    const exactBlocked = new Set<string>([KANBAN_WHEEL_TOOLSET_KEY, ...KANBAN_WHEEL_WRITE_TOOLS].map((s) => s.toLowerCase()));
    const leaks: string[] = [];
    // Fail-closed: an incomplete scan must never read as clean.
    if (budget.exhausted) leaks.push(KANBAN_LEAK_SCAN_TRUNCATED);
    for (const raw of strings) {
      const s = raw.trim().toLowerCase();
      if (!s) continue;
      if (exactBlocked.has(s) || KANBAN_FORBIDDEN_DISPATCH_MARKERS.some((m) => s.indexOf(m) >= 0)) {
        leaks.push(raw.trim());
      }
    }
    return leaks;
  } catch {
    // A hostile top-level value (e.g. a Proxy length trap) is itself a not-clean signal.
    return [KANBAN_LEAK_SCAN_TRUNCATED];
  }
}
