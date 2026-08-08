/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE MEMORY-BOUNDARY CONTRACT core (1.7.0 / COMPA-625 — the PURE, injectable
 * "may this memory operation cross this boundary?" gate).
 *
 * The 4-truth model (Memory / Work / Proof / Sync) only stays safe if EVERY durable
 * memory write + every cross-store derive passes ONE explicit contract. This module is
 * that contract. It owns NO fs/net/spawn — it takes the operation + store + seat +
 * payload text + intended egress and returns a decision. The bridge wires it in FRONT
 * of the real Company-Brain / MEMORY.md / USER.md / session-digest / Honcho write paths.
 *
 * THREE STRUCTURAL INVARIANTS (not just defaults):
 *  - SEAT ISOLATION (GATE-NULL extension): a seat-scoped store may only be written for
 *    the ACTIVE seat (`activeSeatId === targetSeatId`, both present). A missing or
 *    mismatched seat id rejects — a memory write can never bleed across the client
 *    boundary, exactly like HERMES_HOME / Company-Brain isolation.
 *  - S3 HARD FLOOR: a durable memory write whose payload carries an S3 finding (raw
 *    secret / financial / health data — the SAME detector the egress boundary uses)
 *    is REJECTED, never persisted. A per-client durable store is the worst place for a
 *    raw credential or health record; no memory is an honest, safe outcome.
 *  - EGRESS CLASS: the dialectical DERIVE path (Honcho's reasoning LLM) may only leave
 *    the device as 'local-only' (local Gemma) or 'redacted-cloud-deriver' (through the
 *    S11/S13 loopback shim). A raw-cloud egress for memory content is rejected — the
 *    deriver can never bypass the redaction shim.
 *
 * PURE: reuses the egress detector (`detectCommandEveSensitiveEgress` +
 * `sensitivityClassForRule`) so memory + egress share ONE sensitivity source of truth,
 * and adds NO new regexes to drift.
 */

import {
  detectCommandEveSensitiveEgress,
  redactCommandEveSensitiveTextAtOrAbove,
  sensitivityClassForRule,
  type CommandEveEgressFinding,
  type CommandEveSensitivityClass,
} from '@/common/api/egressBoundaryCore';

/** The durable memory stores the contract governs. All are per-seat / per-client. */
export type MemoryBoundaryStore =
  | 'company-brain'
  | 'memory-md'
  | 'user-md'
  | 'honcho'
  | 'session-digest'
  | 'project-wiki'
  | 'project-memory-bank';

/** read = recall; write = persist a durable entry; derive = feed content to the dialectical LLM. */
export type MemoryBoundaryOperation = 'read' | 'write' | 'derive';

/**
 * Where the content is allowed to travel:
 *  - local-only              — never leaves the device (Company Brain, MEMORY.md, local Gemma deriver).
 *  - redacted-cloud-deriver  — leaves ONLY through the S11/S13 loopback shim (cloud-flash deriver).
 *  - syncable-metadata       — opt-in export (Plane/Notion/…); NEVER raw content, metadata only (1.9).
 */
export type MemoryBoundaryEgress = 'local-only' | 'redacted-cloud-deriver' | 'syncable-metadata';

export const MEMORY_BOUNDARY_OK = 'ok';
export const MEMORY_BOUNDARY_MALFORMED = 'malformed';
export const MEMORY_BOUNDARY_SEAT_UNKNOWN = 'seat_unknown';
export const MEMORY_BOUNDARY_SEAT_MISMATCH = 'seat_mismatch';
export const MEMORY_BOUNDARY_S3_FORBIDDEN = 's3_forbidden';
export const MEMORY_BOUNDARY_EGRESS_UNREDACTED = 'egress_unredacted';
export const MEMORY_BOUNDARY_OVERSIZE = 'oversize';

/** The recognized operations + stores. Anything else is a MALFORMED call (fail-closed). */
const KNOWN_OPERATIONS: MemoryBoundaryOperation[] = ['read', 'write', 'derive'];
const KNOWN_STORES: MemoryBoundaryStore[] = [
  'company-brain',
  'memory-md',
  'user-md',
  'honcho',
  'session-digest',
  'project-wiki',
  'project-memory-bank',
];

/**
 * Per-store hard cap on a single durable write (characters). A memory store holds
 * summaries + facts, never a raw transcript — an oversize payload is a smell that raw
 * content is being dumped, so it is rejected. The session digest cap matches the
 * digest core's own output cap; MEMORY.md/USER.md/Company-Brain get a generous cap that
 * still forbids a whole transcript. Honcho content is capped by the wheel plugin, so it
 * is not gated here (0 = no cap).
 */
export const MEMORY_BOUNDARY_MAX_CHARS: Record<MemoryBoundaryStore, number> = {
  // Durable stores hold facts/briefs/summaries. A long client brief is legitimate
  // (several thousand chars), so the cap only catches an EGREGIOUS raw-transcript dump
  // — it must never false-reject a real brief. The session digest is genuinely short
  // (the digest core caps its own output at ~600), so it gets a tight cap.
  'company-brain': 40000,
  'memory-md': 40000,
  'user-md': 40000,
  'session-digest': 2000,
  'project-wiki': 40000,
  'project-memory-bank': 40000,
  honcho: 0,
};

export interface MemoryBoundaryInput {
  operation?: MemoryBoundaryOperation;
  store?: MemoryBoundaryStore;
  /** The currently active seat (the only seat a write may target). */
  activeSeatId?: string;
  /** The seat the operation targets. Must equal activeSeatId for a seat-scoped write. */
  targetSeatId?: string;
  /** The content being written / derived (omit for a pure read). */
  payloadText?: string;
  /** Where this content is allowed to travel (defaults to local-only — the safe floor). */
  egress?: MemoryBoundaryEgress;
}

export interface MemoryBoundaryDecision {
  ok: boolean;
  /** MEMORY_BOUNDARY_* — the machine reason (ok on allow). */
  reasonCode: string;
  /** The max sensitivity class detected in the payload (S0 when none / no payload). */
  sensitivityClass: CommandEveSensitivityClass;
  /** The finding kinds that triggered (for the audit receipt; never the raw match). */
  findings: string[];
  /**
   * When the operation is ALLOWED but the payload carried S1/S2 content that a
   * redacted egress must strip, the caller-safe redacted text (S1+ removed). Present
   * only for the redacted-cloud-deriver derive path; undefined otherwise.
   */
  redactedText?: string;
}

/** The max sensitivity class across a finding list (S0 when empty). */
function maxClass(findings: CommandEveEgressFinding[]): CommandEveSensitivityClass {
  let max: CommandEveSensitivityClass = 'S0';
  const order: Record<CommandEveSensitivityClass, number> = { S0: 0, S1: 1, S2: 2, S3: 3 };
  for (const f of findings) {
    const c = sensitivityClassForRule(f.kind, f.rule_id);
    if (order[c] > order[max]) max = c;
  }
  return max;
}

/**
 * Enforce the memory-boundary contract for ONE operation. Never throws — a malformed
 * input REJECTS (fail-closed), never allows. The ORDER is deliberate: reject malformed
 * calls first (a valid operation + a known store are MANDATORY — no silent 'read'
 * default that a forgotten `operation` could ride, and no unknown store/op that could
 * skip a gate; Codex re-audit), then seat isolation, then the S3 hard floor, then egress
 * class, then the oversize smell — so the reason code names the FIRST + most important
 * breach. Every known store is per-seat, so a non-read to any of them is seat-checked.
 */
export function enforceMemoryBoundary(input: MemoryBoundaryInput): MemoryBoundaryDecision {
  const inp: MemoryBoundaryInput = input || {};
  const store: MemoryBoundaryStore | undefined = inp.store;
  const operation: MemoryBoundaryOperation | undefined = inp.operation;
  const egress: MemoryBoundaryEgress = inp.egress || 'local-only';
  const text = typeof inp.payloadText === 'string' ? inp.payloadText : '';
  const findings = text ? detectCommandEveSensitiveEgress(text) : [];
  const sClass = maxClass(findings);
  const findingKinds = Array.from(new Set(findings.map((f) => f.kind)));

  const deny = (reasonCode: string): MemoryBoundaryDecision => ({
    ok: false,
    reasonCode,
    sensitivityClass: sClass,
    findings: findingKinds,
  });

  // (0) MALFORMED (fail-closed) — the operation MUST be an explicit known op (no silent
  // 'read' default), any provided store MUST be known, and a non-read MUST name a known
  // (therefore seat-scoped, per-client) store. This closes every "unknown op/store skips
  // a gate" and "undefined input allows" bypass.
  // `undefined` is spelled out rather than left to `indexOf`. It already denied —
  // `indexOf(undefined)` is -1 — so this changes nothing at runtime; what it
  // changes is that the deny for a MISSING operation or store is now visible in
  // the code instead of being an accident of a lookup's return value. On a gate
  // whose whole comment above promises "no silent default", that distinction is
  // the point.
  if (operation === undefined || KNOWN_OPERATIONS.indexOf(operation) < 0) return deny(MEMORY_BOUNDARY_MALFORMED);
  if (store !== undefined && KNOWN_STORES.indexOf(store) < 0) return deny(MEMORY_BOUNDARY_MALFORMED);
  if (operation !== 'read' && (store === undefined || KNOWN_STORES.indexOf(store) < 0))
    return deny(MEMORY_BOUNDARY_MALFORMED);

  // (1) SEAT ISOLATION — a read may be seatless (recall resolves its own seat), but any
  // WRITE / DERIVE (to a now-guaranteed known, per-seat store) must target the ACTIVE
  // seat and no other.
  if (operation !== 'read') {
    const active = typeof inp.activeSeatId === 'string' ? inp.activeSeatId.trim() : '';
    const target = typeof inp.targetSeatId === 'string' ? inp.targetSeatId.trim() : '';
    if (!active || !target) return deny(MEMORY_BOUNDARY_SEAT_UNKNOWN);
    if (active !== target) return deny(MEMORY_BOUNDARY_SEAT_MISMATCH);
  }

  // (2) S3 HARD FLOOR — never persist / derive raw secret / financial / health data.
  // Applies to writes AND derives (an S3 secret must not reach the deriver either).
  if (operation !== 'read' && sClass === 'S3') {
    return deny(MEMORY_BOUNDARY_S3_FORBIDDEN);
  }

  // (3) EGRESS CLASS — the dialectical derive may only leave the device redacted-through-
  // shim or local-only. A syncable-metadata or (absent) raw-cloud egress for derive is
  // rejected: the deriver never bypasses the S11/S13 redaction.
  if (operation === 'derive' && egress !== 'local-only' && egress !== 'redacted-cloud-deriver') {
    return deny(MEMORY_BOUNDARY_EGRESS_UNREDACTED);
  }

  // (4) OVERSIZE SMELL — a durable write far past the store cap is a raw-transcript dump.
  if (operation === 'write' && store) {
    const cap = MEMORY_BOUNDARY_MAX_CHARS[store] || 0;
    if (cap > 0 && text.length > cap) return deny(MEMORY_BOUNDARY_OVERSIZE);
  }

  // ALLOWED. For a redacted cloud derive, hand back the S1+-stripped text so the caller
  // sends the redacted form even before the shim's own pass (defense in depth).
  const decision: MemoryBoundaryDecision = {
    ok: true,
    reasonCode: MEMORY_BOUNDARY_OK,
    sensitivityClass: sClass,
    findings: findingKinds,
  };
  if (operation === 'derive' && egress === 'redacted-cloud-deriver' && sClass !== 'S0') {
    decision.redactedText = redactCommandEveSensitiveTextAtOrAbove(text, 'S1');
  }
  return decision;
}
