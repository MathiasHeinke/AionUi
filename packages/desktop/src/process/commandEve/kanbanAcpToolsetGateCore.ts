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
export const KANBAN_WHEEL_READ_TOOLS: readonly string[] = ['kanban_show', 'kanban_list'];
export const KANBAN_WHEEL_WRITE_TOOLS: readonly string[] = ['kanban_create', 'kanban_complete', 'kanban_block', 'kanban_unblock', 'kanban_comment', 'kanban_link', 'kanban_heartbeat'];

/** The raw wheel TOOLSET key that must never appear in the ACP agent's platform toolsets. */
export const KANBAN_WHEEL_TOOLSET_KEY = 'kanban';

/** Config markers that would turn on autonomous dispatch / worker-spawn — must stay off. */
export const KANBAN_FORBIDDEN_DISPATCH_MARKERS: readonly string[] = ['HERMES_KANBAN_TASK', 'kanban.dispatch_in_gateway', 'kanban_swarm', 'kanban_decompose'];

export const KANBAN_ACP_READ_TOOLS: readonly KanbanAcpTool[] = ['kanban.board.read'];
export const KANBAN_ACP_WRITE_TOOLS: readonly KanbanAcpTool[] = ['kanban.card.create.plan', 'kanban.card.move.plan', 'kanban.card.action.plan', 'kanban.write.confirm'];

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

const FIXED_POLICY: KanbanAcpGatePolicy = { writeRequiresConfirmCard: true, autoDispatchAllowed: false, workerSpawnAllowed: false, deleteAllowed: false };

/**
 * Resolve what EVE may do with the board this turn. DEFAULT-DENY: unless the preflight
 * is ready AND there is an active seat AND a board slug, NOTHING is exposed (not even
 * read). When exposed, reads are offered and writes are offered ONLY as proposals (the
 * apply step is gated by the Confirm-Card). The raw wheel write tools are always in
 * blockedTools — they are never handed to the agent. Never throws.
 */
export function resolveKanbanAcpToolsetGate(input: KanbanAcpGateInput): KanbanAcpGateResult {
  const inp = input || {};
  const seat = typeof inp.activeSeatId === 'string' ? inp.activeSeatId.trim() : '';
  const board = typeof inp.boardSlug === 'string' ? inp.boardSlug.trim() : '';
  const visible = inp.preflightReady === true && seat.length > 0 && board.length > 0;
  if (!visible) {
    return { visible: false, readTools: [], writeTools: [], blockedTools: [...KANBAN_WHEEL_WRITE_TOOLS], policy: FIXED_POLICY };
  }
  return {
    visible: true,
    readTools: [...KANBAN_ACP_READ_TOOLS],
    writeTools: [...KANBAN_ACP_WRITE_TOOLS],
    blockedTools: [...KANBAN_WHEEL_WRITE_TOOLS],
    policy: FIXED_POLICY,
  };
}

/**
 * STRUCTURAL INVARIANT: the raw wheel "kanban" toolset (and any dispatch marker) must
 * NEVER be present in the ACP agent's emitted platform toolset list — otherwise EVE
 * would get the un-gated in-process write tools + dispatch, bypassing the Confirm-Card
 * entirely. Returns the offending entries (empty = clean). The config-render + a
 * regression test assert this stays empty for the acp platform.
 */
export function findRawKanbanLeaks(acpPlatformToolsets: unknown): string[] {
  if (!Array.isArray(acpPlatformToolsets)) return [];
  const leaks: string[] = [];
  for (const entry of acpPlatformToolsets) {
    const s = typeof entry === 'string' ? entry.trim() : '';
    if (!s) continue;
    if (s === KANBAN_WHEEL_TOOLSET_KEY) leaks.push(s);
    else if (KANBAN_WHEEL_WRITE_TOOLS.indexOf(s) >= 0) leaks.push(s);
    else if (KANBAN_FORBIDDEN_DISPATCH_MARKERS.indexOf(s) >= 0) leaks.push(s);
  }
  return leaks;
}
