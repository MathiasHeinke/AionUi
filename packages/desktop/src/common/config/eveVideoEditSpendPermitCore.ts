/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the EPHEMERAL SINGLE-USE SPEND PERMIT.
 *
 * Why this exists, in one sentence: a long-lived capability handle is the right
 * authority for READING an artifact and the wrong authority for SPENDING money
 * on one.
 *
 * The first Variant C build made possession of a fourteen-day handle sufficient
 * for a paid edit. That handle is emitted into every turn's context envelope, is
 * shipped to a third-party model API, and is never revoked — so "the model has a
 * handle" was, in practice, "the model may spend, repeatedly, whenever it likes,
 * for two weeks". The founder removed the confirmation popup; that decision does
 * not extend to a reusable key to a paid action.
 *
 * So the handle keeps only the authority it can honestly carry — read-only
 * list/get — and a SECOND, different credential authorises spend:
 *
 *   - it is bound, server-side, to the conversation, the operation, the exact
 *     artifact bytes it may act on, and the hash of the ORDINARY USER TURN that
 *     caused it — the raw bytes of that turn, verbatim, no trim, no case
 *     folding, no line-ending or Unicode normalisation between what arrived at
 *     the IPC boundary and what was hashed. THIS SCOPE IS THE CLAIM. It holds
 *     for the ordinary send path and for nothing else, because the ordinary
 *     send path is the only one that mints. A mid-run CORRECTION mints nothing
 *     at all — see the pointer note below;
 *   - that turn hash is RE-COMPARED at redeem against the conversation's
 *     current turn, so a permit stops working the moment the person moves on —
 *     including when they move on with a mid-run CORRECTION, which reaches the
 *     agent without ever building a context envelope and is therefore handled by
 *     its own path (`revokeVideoEditSpendOnUserSteer`) rather than by the mint
 *     path here. That path RETIRES authority instead of issuing it, and its
 *     pointer binds the bytes the runtime was ACTUALLY GIVEN — which the send
 *     box trims — not the raw keystrokes. Two different invariants, deliberately:
 *     a mint must name exactly what the user asked, a retirement must name
 *     exactly what the agent was told;
 *   - it expires in minutes, not weeks;
 *   - it is consumed ATOMICALLY, exactly once, before the provider is called;
 *   - the TURN is consumed atomically too, so however many permits exist for one
 *     turn, that turn buys one edit;
 *   - and the SAME permit with a DIFFERENT instruction is a refusal, which is
 *     what closes the varied-instruction loop: a model that gets one permit per
 *     user turn cannot turn one turn into ten charges.
 *
 * WHAT THIS DOES NOT ENFORCE, stated plainly because round 1 claimed it did:
 * Main cannot observe an "active send" on the pinned AionCore. Nothing here
 * proves a human pressed send — the mint path is an IPC handler and the renderer
 * is the only thing that calls it. The model reaches this app through the MCP
 * loopback, which exposes no mint operation at all, so a model cannot mint one
 * for itself; that is a property of the exposed surface, not of a check in this
 * file. The bindings above are the strongest real proxy for "the user just
 * asked": exact turn bytes, single use, one spend per turn, minutes-long life.
 *
 * What a permit deliberately is NOT is a confirmation dialog. Nothing here asks
 * the user anything. It bounds what one send can cost.
 *
 * PURE: no fs, no crypto, no Electron. Randomness and hashing are injected, so
 * every refusal below is reachable in a unit test without a disk.
 */

import { isOpaqueToken, isSha256Hex, toLowerHex } from './eveOpaqueTokenCore';

/**
 * A visibly different prefix from `evecap_`. Two credentials that looked alike
 * would eventually be passed to each other's checks by someone reading fast.
 */
export const VIDEO_EDIT_SPEND_PERMIT_PREFIX = 'evespend_';

export const VIDEO_EDIT_SPEND_PERMIT_ENTROPY_BYTES = 32;

/**
 * Fifteen minutes.
 *
 * Long enough that a model which thinks for a while, calls a read tool first and
 * then decides to edit still succeeds on the turn the user actually asked. Short
 * enough that a permit found in a log, a transcript or a crash dump tomorrow is
 * already worthless — which is the property the fourteen-day handle never had.
 */
export const VIDEO_EDIT_SPEND_PERMIT_TTL_MS = 15 * 60 * 1000;

/** Never bind a permit to more artifacts than one envelope can show. */
export const VIDEO_EDIT_SPEND_PERMIT_MAX_ARTIFACTS = 24;

export type SpendPermitOperation = 'video_edit';

/**
 * What is stored, server-side, for one permit.
 *
 * The permit VALUE is deliberately absent. The record is filed under the SHA-256
 * of the permit, so the lookup already proves possession and the file itself
 * never contains the secret — a backup, a crash dump or a directory listing of
 * this store hands over nothing that can be presented. (The long-lived handle
 * store cannot make that claim, because the envelope has to be able to re-emit a
 * handle every turn; it is honest about that in its own header.)
 */
export interface VideoEditSpendPermitRecord {
  conversation_id: string;
  operation: SpendPermitOperation;
  /** SHA-256 of the RAW user turn that caused this permit to be minted. */
  user_turn_sha256: string;
  /** The artifact bytes this permit may be spent on — nothing else resolves. */
  allowed_artifact_sha256: string[];
  issued_at_ms: number;
  expires_at_ms: number;
}

export type SpendPermitRefusal =
  | 'permit-missing'
  | 'permit-malformed'
  | 'permit-unknown'
  | 'permit-expired'
  | 'permit-conversation-mismatch'
  | 'permit-operation-mismatch'
  | 'permit-turn-unknown'
  | 'permit-turn-mismatch'
  | 'permit-turn-consumed'
  | 'permit-artifact-not-covered'
  | 'permit-consumed'
  | 'permit-in-flight'
  | 'permit-consume-failed'
  | 'edit-already-in-flight'
  /**
   * The conversation is RETIRED: something that had to retire spend authority
   * could not be stored, so the authority was withdrawn instead of kept.
   *
   * This is not a judgement about a permit at all — no permit is even looked at
   * when it is raised — which is why it is checked by its own state in the store
   * rather than derived from a record here.
   */
  | 'conversation-retired'
  /**
   * The STORE has not been proven in this process — round 5.
   *
   * Also not a judgement about a permit: no permit is looked at when it is
   * raised. A live spend authority is not allowed to outlive the process that
   * minted it, so a process that has not yet swept the store (or swept it and
   * could not prove the sweep) refuses the paid path in EVERY conversation. It
   * is the only refusal here that is process-wide.
   */
  | 'spend-store-unreconciled';

export type SpendPermitEvaluation = { ok: true; record: VideoEditSpendPermitRecord } | { ok: false; reason: SpendPermitRefusal };

/** Shape check only. Says nothing about whether we ever minted it. */
export function isWellFormedVideoEditSpendPermit(value: unknown): value is string {
  return isOpaqueToken(value, VIDEO_EDIT_SPEND_PERMIT_PREFIX);
}

export interface MintVideoEditSpendPermitInput {
  conversationId: string;
  userTurnSha256: string;
  /** The editable artifacts visible in THIS turn's envelope, by their bytes. */
  allowedArtifactSha256: readonly string[];
  nowMs: number;
  randomBytes: (size: number) => Uint8Array;
  ttlMs?: number;
}

/**
 * Mint a permit, or refuse.
 *
 * `undefined` rather than a throw, for the same reason the handle minter returns
 * `undefined`: the caller is the send path, and "this turn gets no spend permit"
 * is an ordinary, correct outcome — a conversation with nothing editable in it
 * simply does not get one, and the turn is unchanged.
 *
 * A permit is refused outright when the user turn is empty. That is the rule
 * that makes "minted only on a real user send" enforceable rather than a comment:
 * there is no hash of nothing, so there is no permit for nothing.
 */
export function mintVideoEditSpendPermit(
  input: MintVideoEditSpendPermitInput
): { permit: string; record: VideoEditSpendPermitRecord } | undefined {
  if (typeof input.conversationId !== 'string' || input.conversationId.length === 0) return undefined;
  if (!isSha256Hex(input.userTurnSha256)) return undefined;

  const allowed: string[] = [];
  for (const sha of input.allowedArtifactSha256 ?? []) {
    if (!isSha256Hex(sha)) continue;
    let seen = false;
    for (const already of allowed) if (already === sha) seen = true;
    if (seen) continue;
    allowed.push(sha);
    if (allowed.length >= VIDEO_EDIT_SPEND_PERMIT_MAX_ARTIFACTS) break;
  }
  // A permit that authorises nothing is not a permit. Minting one anyway would
  // put a live spend credential into a transcript that could never legitimately
  // be redeemed — pure downside.
  if (allowed.length === 0) return undefined;

  let bytes: Uint8Array;
  try {
    bytes = input.randomBytes(VIDEO_EDIT_SPEND_PERMIT_ENTROPY_BYTES);
  } catch {
    return undefined;
  }
  // A short read from the random source silently downgrades the only thing that
  // makes the permit unguessable. Refuse rather than mint a weak one.
  if (!bytes || bytes.length !== VIDEO_EDIT_SPEND_PERMIT_ENTROPY_BYTES) return undefined;

  const ttlMs = typeof input.ttlMs === 'number' && input.ttlMs > 0 ? input.ttlMs : VIDEO_EDIT_SPEND_PERMIT_TTL_MS;
  return {
    permit: `${VIDEO_EDIT_SPEND_PERMIT_PREFIX}${toLowerHex(bytes)}`,
    record: {
      conversation_id: input.conversationId,
      operation: 'video_edit',
      user_turn_sha256: input.userTurnSha256,
      allowed_artifact_sha256: allowed,
      issued_at_ms: input.nowMs,
      expires_at_ms: input.nowMs + ttlMs,
    },
  };
}

/**
 * Judge a presented permit against its stored record.
 *
 * `conversationId` is NOT taken from the caller. Every caller passes the
 * conversation named by the capability GRANT it already resolved, so this
 * comparison is one server-side record against another server-side record —
 * which is the whole difference between a binding and a claim.
 *
 * `observedUserTurnSha256` is the SAME kind of value: the hash of the turn this
 * conversation is currently on, read from our own store, never presented by the
 * caller. It is REQUIRED rather than optional on purpose — round 1 stored
 * `user_turn_sha256` at mint and never compared it anywhere, which made the
 * turn binding decorative. An optional parameter would let a future caller
 * recreate that hole by simply not passing it; a required one cannot be
 * forgotten, and an unreadable current turn refuses instead of waving through.
 */
export function evaluateVideoEditSpendPermit(input: {
  permit: unknown;
  record: VideoEditSpendPermitRecord | undefined;
  conversationId: string;
  operation: SpendPermitOperation;
  observedUserTurnSha256: unknown;
  observedArtifactSha256: string;
  nowMs: number;
}): SpendPermitEvaluation {
  if (input.permit === undefined || input.permit === null || input.permit === '') {
    return { ok: false, reason: 'permit-missing' };
  }
  if (!isWellFormedVideoEditSpendPermit(input.permit)) return { ok: false, reason: 'permit-malformed' };
  const record = input.record;
  if (!record) return { ok: false, reason: 'permit-unknown' };
  if (typeof record.expires_at_ms !== 'number' || input.nowMs >= record.expires_at_ms) {
    return { ok: false, reason: 'permit-expired' };
  }
  if (record.conversation_id !== input.conversationId) return { ok: false, reason: 'permit-conversation-mismatch' };
  if (record.operation !== input.operation) return { ok: false, reason: 'permit-operation-mismatch' };
  // THE re-comparison. Without it the turn hash is a field we write and never
  // read, and "this permit belongs to the request the user just made" is a
  // sentence in a comment rather than a check. No readable current turn is a
  // refusal, not a pass: we would be spending on a turn we cannot name.
  if (!isSha256Hex(input.observedUserTurnSha256)) return { ok: false, reason: 'permit-turn-unknown' };
  if (record.user_turn_sha256 !== input.observedUserTurnSha256) return { ok: false, reason: 'permit-turn-mismatch' };
  if (!isSha256Hex(input.observedArtifactSha256)) return { ok: false, reason: 'permit-artifact-not-covered' };

  let covered = false;
  for (const sha of record.allowed_artifact_sha256 ?? []) {
    if (sha === input.observedArtifactSha256) covered = true;
  }
  if (!covered) return { ok: false, reason: 'permit-artifact-not-covered' };
  return { ok: true, record };
}

/** A user-facing sentence per refusal. Named causes, never one generic. */
export function describeSpendPermitRefusal(reason: SpendPermitRefusal): string {
  switch (reason) {
    case 'permit-missing':
      return 'Für eine Videobearbeitung braucht es eine frische Anfrage von dir — schreib kurz, was geändert werden soll.';
    case 'permit-malformed':
      return 'Die Freigabe für diese Bearbeitung war unlesbar. Frag es bitte noch einmal.';
    case 'permit-unknown':
      return 'Für diese Bearbeitung gibt es keine gültige Freigabe — es wurde nichts bearbeitet und nichts berechnet.';
    case 'permit-expired':
      return 'Die Freigabe für diese Bearbeitung ist abgelaufen. Frag es bitte noch einmal.';
    case 'permit-conversation-mismatch':
      return 'Diese Freigabe gehört zu einer anderen Unterhaltung und gilt hier nicht.';
    case 'permit-operation-mismatch':
      return 'Diese Freigabe erlaubt diese Aktion nicht.';
    case 'permit-turn-unknown':
      return 'Zu dieser Bearbeitung gibt es keine erkennbare Anfrage von dir — schreib kurz, was geändert werden soll.';
    case 'permit-turn-mismatch':
      return 'Diese Freigabe gehört zu einer früheren Nachricht. Sag noch einmal, was am Video geändert werden soll.';
    case 'permit-turn-consumed':
      return 'Diese Nachricht hat ihre eine Videobearbeitung bereits bekommen. Für eine weitere schreib bitte noch einmal, was geändert werden soll.';
    case 'permit-artifact-not-covered':
      return 'Diese Freigabe gilt nicht für dieses Video.';
    case 'permit-consumed':
      return 'Diese Anfrage erlaubt genau eine Bearbeitung, und die ist bereits erfolgt. Für eine weitere schreib bitte noch einmal, was geändert werden soll.';
    case 'permit-in-flight':
      return 'Diese Bearbeitung läuft bereits — es wird nichts doppelt berechnet.';
    case 'permit-consume-failed':
      return 'Die Freigabe konnte nicht sicher eingelöst werden — es wurde nichts bearbeitet und nichts berechnet.';
    case 'edit-already-in-flight':
      return 'In dieser Unterhaltung läuft bereits eine Videobearbeitung. Warte kurz, bis sie fertig ist.';
    case 'conversation-retired':
      return 'Deine Korrektur ist angekommen, aber die Freigabe zum Bearbeiten konnte nicht sicher zurückgezogen werden — deshalb wurde hier nichts bearbeitet und nichts berechnet. Schreib kurz, was geändert werden soll, dann geht es weiter.';
    case 'spend-store-unreconciled':
      return 'Videobearbeitungen sind gerade gesperrt, weil ältere Freigaben nicht sicher zurückgezogen werden konnten. Es wurde nichts bearbeitet und nichts berechnet. Schreib einfach die nächste Nachricht, dann wird das wieder freigegeben.';
  }
}
