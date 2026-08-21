/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — where spend permits live, and where they are spent.
 *
 * Three files, and each one exists because a different thing goes wrong without
 * it:
 *
 *   `<sha256(permit)>.json`          the record. Filed UNDER the digest, so the
 *                                    file never contains the secret; a lookup is
 *                                    itself the proof of possession.
 *   `<sha256(permit)>.consumed.json` the claim. Written with `wx` — an EXCLUSIVE
 *                                    create — which is the whole double-billing
 *                                    defence. Read-then-write would let two
 *                                    arrivals both read "unused" and both spend.
 *   `<sha256(permit)>.result.json`   the receipt. What the first arrival
 *                                    produced, so a retry gets THAT clip back
 *                                    instead of a second charge or a bare error.
 *
 * Plus one lock, `inflight/<sha256(conversation)>.lock`, also `wx`: at most one
 * paid edit in flight per conversation. Without it, a model that fires two tool
 * calls in the same breath spends twice before either consumption lands.
 *
 * And two files per TURN, under `turns/`, which round 1 did not have and which
 * are what make the turn a real unit rather than a label:
 *
 *   `<sha256(conversation)>.active.json`  which turn this conversation is on
 *                                         RIGHT NOW. Written by the send path on
 *                                         every turn that builds a context
 *                                         envelope, whether or not that turn
 *                                         mints anything, AND by the steer path
 *                                         for a correction typed mid-run, which
 *                                         never builds one. Redeem compares the
 *                                         permit's stored turn against this, so
 *                                         a permit dies when the person moves on
 *                                         rather than lingering for its full
 *                                         TTL.
 *   `<sha256(conversation|turn)>.spent.json`   the turn's ONE spend, claimed
 *                                         with `wx`. However many permits exist
 *                                         for a turn — and re-driving the mint
 *                                         path used to produce one per call —
 *                                         the turn buys a single edit.
 *
 * Round 5 adds no file at all. It adds a BOUNDARY: none of the three live
 * authorities above — the permit record, the active-turn pointer, the in-flight
 * lock — may survive a process boundary. See the store-health section for why a
 * marker could not have fixed this, and what happens when the sweep cannot prove
 * itself.
 *
 * And one file per RETIRED conversation, under `deny/`, which round 3 did not
 * have and whose absence was a fail-open on spending:
 *
 *   `<sha256(conversation)>.json`         this conversation may not buy a paid
 *                                         edit at all. Written whenever spend
 *                                         authority had to be withdrawn and we
 *                                         could not prove it was withdrawn by
 *                                         deletion. NEVER swept — see the deny
 *                                         section for why expiry is the one
 *                                         thing it must not do.
 *
 * The gateway's own content-only ledger key remains the last line of defence and
 * is not weakened by anything here — the desktop simply stops relying on it as
 * the ONLY line, which was the original defect: a remote ledger cannot refuse a
 * request that was never supposed to be made.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateVideoEditSpendPermit,
  isWellFormedVideoEditSpendPermit,
  mintVideoEditSpendPermit,
  VIDEO_EDIT_SPEND_PERMIT_TTL_MS,
  type SpendPermitEvaluation,
  type SpendPermitOperation,
  type SpendPermitRefusal,
  type VideoEditSpendPermitRecord,
} from '@/common/config/eveVideoEditSpendPermitCore';
import { hasVisibleCharacters, isSha256Hex } from '@/common/config/eveOpaqueTokenCore';
import { writeFileCreateOnly, writeJsonAtomic } from '@process/services/project-workspace/storage/atomicJson';

const SPEND_PERMIT_DIR = 'command-eve-artifact-capabilities';
const SPEND_PERMIT_SUBDIR = 'spend-permits';
const INFLIGHT_SUBDIR = 'inflight';
const TURN_SUBDIR = 'turns';
const DENY_SUBDIR = 'deny';

/**
 * A conversation lock older than this is treated as abandoned.
 *
 * Slightly above the bridge's own 200s request timeout, so a live edit can never
 * have its lock stolen, while a lock left behind by a crashed or killed process
 * does not close the lane forever. A permanent lock would be a denial of service
 * we inflicted on ourselves.
 */
export const VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS = 240_000;

export interface VideoEditSpendCompletion {
  artifact_id: string;
  source_artifact_id: string;
  conversation_id: string;
  instruction_sha256: string;
  artifact_sha256: string;
  completed_at_ms: number;
}

function permitDirectory(dataPath: string): string {
  return path.join(path.resolve(dataPath), SPEND_PERMIT_DIR, SPEND_PERMIT_SUBDIR);
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function permitFiles(dataPath: string, permit: string): { record: string; consumed: string; result: string } {
  const key = digest(permit);
  const dir = permitDirectory(dataPath);
  return {
    record: path.join(dir, `${key}.json`),
    consumed: path.join(dir, `${key}.consumed.json`),
    result: path.join(dir, `${key}.result.json`),
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Exclusive create. Returns false when the file already existed. */
function createExclusive(file: string, value: unknown): boolean {
  try {
    // The claim has to reach the platter, not just the page cache: a consumed
    // marker lost to a crash is a permit that reads unused again, and the
    // gateway's content-key is then the only thing between a retry and a second
    // charge. `writeFileCreateOnly` keeps the create-only guarantee — the link
    // step never overwrites — and adds the fsync this claim always needed.
    writeFileCreateOnly(file, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function parsePermitRecord(value: unknown): VideoEditSpendPermitRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.conversation_id !== 'string' ||
    (record.operation !== 'video_edit' && record.operation !== 'image_edit') ||
    !isSha256Hex(record.user_turn_sha256) ||
    !Array.isArray(record.allowed_artifact_sha256) ||
    typeof record.issued_at_ms !== 'number' ||
    typeof record.expires_at_ms !== 'number'
  ) {
    return undefined;
  }
  for (const sha of record.allowed_artifact_sha256) if (!isSha256Hex(sha)) return undefined;
  if (record.allowed_artifact_sha256.length === 0 || Object.hasOwn(record, 'allowed_request_sha256')) return undefined;
  return record as unknown as VideoEditSpendPermitRecord;
}

// ---------------------------------------------------------------------------
// The DENY — a conversation whose spend authority could not be proven retired
// ---------------------------------------------------------------------------

/**
 * WHY A SEPARATE STATE AT ALL, when a revoke already deletes the permit.
 *
 * Because a revoke can fail. Round 3 retired the permit from the steer path and
 * then swallowed any failure of that retirement, and the swallow was fail-open on
 * spending: the local disk misbehaves, and the app silently keeps the ability to
 * charge the user against an instruction they have already superseded. Deleting a
 * file is a thing that can fail; NOT SPENDING is a thing we can always do.
 *
 * So the deny is the answer to "we could not prove the authority is gone". It is
 * checked on the edit path by ITS OWN read — never derived from the permit record
 * whose deletion is the operation that failed.
 *
 * TWO tiers, and the second one exists precisely because the first can be the
 * thing that broke:
 *
 *   DURABLE   `deny/<sha256(conversation)>.json`. Survives a restart.
 *   PROCESS   a module-level `Set` in Main. The last resort when writing the
 *             marker is exactly what failed.
 *
 * WHAT THE PROCESS TIER DOES NOT DO, stated here rather than in a reassuring
 * sentence somewhere else: it does not survive a restart of the app, and it is
 * not shared with any other process. When the durable write failed AND the app is
 * restarted, the conversation is no longer denied — and if the revoke that
 * started all this also failed, an old permit still inside its fifteen-minute
 * window, whose turn pointer also survived, becomes spendable again.
 * `videoEditSpendDeny.test.ts` asserts that residual instead of describing it
 * away, and it is reported as a substrate gap.
 *
 * The deny is NEVER swept. Every other artefact in this store expires; this one
 * must not, because expiry is exactly the implicit clearing the contract forbids.
 * It clears in one place only — a later ordinary send that provably established
 * fresh turn state AND wrote a new permit record.
 */

/**
 * Keyed by conversation id ALONE, deliberately, and not by (dataPath,
 * conversation).
 *
 * A seat switch changes the data path; a conversation id is a uuid and does not
 * collide across seats. Keying on the conversation alone therefore denies in
 * every seat rather than in one, which is the fail-closed direction — and the
 * situation this set exists for is one where we already know the disk is lying to
 * us, so the narrower key would be trusting the very thing that failed.
 */
const processScopedSpendDeny = new Set<string>();

export type VideoEditSpendDenyScope = 'durable' | 'process' | 'none';

export interface VideoEditSpendDenyState {
  denied: boolean;
  durable: boolean;
  processScoped: boolean;
}

function denyDirectory(dataPath: string): string {
  return path.join(permitDirectory(dataPath), DENY_SUBDIR);
}

function denyFile(dataPath: string, conversationId: string): string {
  return path.join(denyDirectory(dataPath), `${digest(conversationId)}.json`);
}

/**
 * Is there a marker on disk?
 *
 * THREE answers, not two. `unprovable` is the one that matters: an EACCES, an
 * EIO or a path that exists but is not a file means we cannot demonstrate the
 * ABSENCE of a deny, and the caller must read that as denied. `existsSync` was
 * the obvious call here and is the wrong one — it collapses "provably absent"
 * and "cannot tell" into the same `false`.
 */
function durableDenyState(dataPath: string | undefined, conversationId: string): 'present' | 'absent' | 'unprovable' {
  if (typeof dataPath !== 'string' || dataPath.length === 0) return 'unprovable';
  let file: string;
  try {
    file = denyFile(dataPath, conversationId);
  } catch {
    return 'unprovable';
  }
  try {
    return fs.statSync(file).isFile() ? 'present' : 'unprovable';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unprovable';
  }
}

/**
 * Retire this conversation's paid-edit authority.
 *
 * The in-memory half is taken FIRST and unconditionally, so a durable write that
 * throws half way through still leaves the conversation denied in this process.
 * The return value names the strongest tier that was actually achieved; `none`
 * only for a request with no conversation, which denies nothing because it
 * identifies nothing.
 *
 * `dataPath` may be absent — that is the case where we could not even name the
 * store — and then the process tier is the whole answer.
 */
export function denyVideoEditSpend(
  dataPath: string | undefined,
  conversationId: string,
  nowMs: number = Date.now()
): VideoEditSpendDenyScope {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return 'none';
  processScopedSpendDeny.add(conversationId);
  if (typeof dataPath !== 'string' || dataPath.length === 0) return 'process';
  try {
    writeJsonAtomic(denyFile(dataPath, conversationId), {
      conversation_id: conversationId,
      denied_at_ms: nowMs,
    });
    return 'durable';
  } catch {
    return 'process';
  }
}

/** Both tiers, for callers that need to say WHICH one is holding. */
export function readVideoEditSpendDenyState(
  dataPath: string | undefined,
  conversationId: string
): VideoEditSpendDenyState {
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return { denied: false, durable: false, processScoped: false };
  }
  const processScoped = processScopedSpendDeny.has(conversationId);
  const durable = durableDenyState(dataPath, conversationId);
  return {
    denied: processScoped || durable !== 'absent',
    durable: durable === 'present',
    processScoped,
  };
}

/**
 * May this conversation buy a paid edit at all?
 *
 * `true` means NO. Anything we cannot prove absent reads as denied — if the state
 * cannot be established, the answer is no.
 */
export function isVideoEditSpendDenied(dataPath: string | undefined, conversationId: string): boolean {
  return readVideoEditSpendDenyState(dataPath, conversationId).denied;
}

/**
 * Lift the deny — the ONLY place that does.
 *
 * Called from the mint path after fresh turn state and a new permit record are
 * both on disk, and nowhere else. Not on a timer, not on a retry of the edit, not
 * on a steer, not on app start.
 *
 * The durable marker goes first and the in-memory one only follows if the marker
 * is provably gone: an unlink we could not perform leaves the conversation
 * denied, which is a refusal rather than a charge.
 */
export function clearVideoEditSpendDeny(dataPath: string | undefined, conversationId: string): boolean {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return false;
  if (typeof dataPath !== 'string' || dataPath.length === 0) return false;
  try {
    fs.unlinkSync(denyFile(dataPath, conversationId));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // Anything other than "it was not there" means the marker may still be
    // there. Leave the in-memory deny standing too.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
  }
  if (durableDenyState(dataPath, conversationId) !== 'absent') return false;
  processScopedSpendDeny.delete(conversationId);
  return true;
}

// ---------------------------------------------------------------------------
// STORE HEALTH — round 5. No live spend authority survives a process boundary.
// ---------------------------------------------------------------------------

/**
 * THE RESIDUAL ROUND 4 PINNED AND DID NOT CLOSE, and why a bigger deny could
 * not have closed it.
 *
 * When the DURABLE deny write is exactly what failed, the only record that a
 * conversation lost its spend authority is `processScopedSpendDeny` — a Set in
 * this process. Restart the app and the Set is gone, while the permit record it
 * was compensating for is still on disk, still inside its window, with a turn
 * pointer that also survived. `videoEditSpendDeny.test.ts` asserted that as a
 * residual rather than describing it away, and it was reported as a substrate
 * gap. It is a fail-open on spending, and it survives a restart, which makes it
 * the worst-shaped kind: nothing in the app notices.
 *
 * Adding a second durable marker cannot fix it. The premise of the whole case is
 * that writing to this store is what failed; a fix that needs a successful write
 * is a fix that is absent exactly when it is needed.
 *
 * So the answer is the other direction. A LIVE AUTHORITY IS NOT ALLOWED TO
 * OUTLIVE THE PROCESS THAT MINTED IT:
 *
 *   LIVE AUTHORITY (deleted on reinitialization)
 *     `<permit>.json`                    the permit record — the spend credential
 *     `turns/<conv>.active.json`         the active-turn pointer
 *     `inflight/<conv>.lock`             the in-flight edit lock
 *
 *   COMPLETED RECEIPT (kept, always)
 *     `<permit>.consumed.json`           this permit already bought its edit
 *     `<permit>.result.json`             and this is what it produced
 *     `turns/<conv|turn>.spent.json`     this turn already bought its one edit
 *
 * Keeping the receipts is not a convenience. They are the whole double-charge
 * defence: a slow edit whose response was lost, retried after a restart, must be
 * answered from its receipt rather than billed again. Deleting them to be "safe"
 * would trade a fail-open for a fail-expensive.
 *
 * AND UNTIL A REINITIALIZATION HAS PROVEN THAT, THE PAID PATH IS DENIED
 * PROCESS-WIDE. A fresh process starts at `unproven`, not at `healthy`, because
 * the model's loopback can present a permit string it remembered from before the
 * restart without any user send happening first — so a proactive startup sweep
 * that has not run yet is not a guarantee, it is a race. The gate has to be the
 * default.
 *
 * The state is per-process on purpose and is NOT persisted: it is a statement
 * about what THIS process has proven, and a persisted copy would be a claim made
 * by a previous process about a store it no longer has.
 */
export type VideoEditSpendStoreHealth = 'unproven' | 'healthy' | 'denied';

/**
 * `unproven` at module load, which is the whole point — see above. It becomes
 * `healthy` only through `reinitializeVideoEditSpendStore` returning a proven
 * sweep, and it is never set by a timer, by a prune or by an edit.
 */
let spendStoreHealth: VideoEditSpendStoreHealth = 'unproven';

/** What this process has proven about the store. */
export function readVideoEditSpendStoreHealth(): VideoEditSpendStoreHealth {
  return spendStoreHealth;
}

/** May the paid video-edit path run at all in this process? */
export function isVideoEditSpendStoreHealthy(): boolean {
  return spendStoreHealth === 'healthy';
}

/**
 * Delete every file in `dir` the predicate names as a live authority.
 *
 * Returns whether the sweep is PROVABLE, not whether it deleted anything. A
 * directory that does not exist provably holds no authority and is clean — that
 * is what keeps an untouched seat from being denied for having nothing. A
 * directory we could not read, or an `unlink` that refused, is not clean, and
 * "not clean" is the only input that can deny.
 */
function sweepLiveAuthorityFiles(dir: string, isLiveAuthority: (name: string) => boolean): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
  let clean = true;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isLiveAuthority(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry.name));
    } catch {
      clean = false;
    }
  }
  return clean;
}

const INFLIGHT_LOCK_NAME_LENGTH = 69; // <64 hex>.lock

/**
 * Invalidate every live spend authority in the store, and record whether that
 * could be PROVEN.
 *
 * Called from exactly two places, and both are the contract's two ways of
 * clearing a process-wide deny:
 *
 *   1. main-process startup (`initializeProcess`) — the proactive sweep;
 *   2. `issueVideoEditSpendPermit`, when this process has not proven the store
 *      yet. That is the "a fresh ordinary user send clears it" half, and it
 *      clears it by RUNNING this — a send proves the store, it does not merely
 *      happen. Doing it any other way would let a send in conversation B lift a
 *      deny while conversation A's pre-restart permit was still live, which is
 *      the fail-open with an extra step.
 *
 * NOT called on a timer, NOT called from the edit path, and NOT called from
 * `pruneVideoEditSpendPermits`. A retry of an edit can never move this.
 *
 * DENY MARKERS ARE NOT TOUCHED. They live in the `deny/` SUBDIRECTORY and every
 * sweep here takes `entry.isFile()` only, so a conversation retired before the
 * restart stays retired after it. A reinitialization that cleared them would
 * hand back exactly the authority the deny exists to withhold.
 *
 * Never throws. The worst outcome is `denied`, which costs refusals.
 */
export function reinitializeVideoEditSpendStore(dataPath: string | undefined): VideoEditSpendStoreHealth {
  // Pessimistic for the whole duration: a throw escaping mid-sweep must not
  // leave a stale `healthy` behind.
  spendStoreHealth = 'denied';
  if (typeof dataPath !== 'string' || dataPath.length === 0) return spendStoreHealth;
  let proven = true;
  try {
    // The permit record — the credential itself. `<64 hex>.json` and nothing
    // else, so the consumed claim and the result receipt beside it are kept.
    proven =
      sweepLiveAuthorityFiles(
        permitDirectory(dataPath),
        (name) => name.length === RECORD_NAME_LENGTH && name.slice(-5) === '.json' && isSha256Hex(name.slice(0, 64))
      ) && proven;
    // The active-turn pointer. `<64 hex>.spent.json` in the same directory is a
    // completed receipt and is deliberately left standing.
    proven =
      sweepLiveAuthorityFiles(
        turnDirectory(dataPath),
        (name) =>
          name.length === ACTIVE_TURN_NAME_LENGTH &&
          name.slice(-12) === '.active.json' &&
          isSha256Hex(name.slice(0, 64))
      ) && proven;
    // The in-flight edit lock. A lock held by a process that no longer exists is
    // not protecting anything; leaving it would close the lane for its TTL.
    proven =
      sweepLiveAuthorityFiles(
        path.join(permitDirectory(dataPath), INFLIGHT_SUBDIR),
        (name) =>
          name.length === INFLIGHT_LOCK_NAME_LENGTH && name.slice(-5) === '.lock' && isSha256Hex(name.slice(0, 64))
      ) && proven;
  } catch {
    proven = false;
  }
  spendStoreHealth = proven ? 'healthy' : 'denied';
  return spendStoreHealth;
}

// ---------------------------------------------------------------------------
// The TURN — which one this conversation is on, and whether it has spent yet
// ---------------------------------------------------------------------------

export interface VideoEditActiveTurnRecord {
  user_turn_sha256: string;
  observed_at_ms: number;
}

function turnDirectory(dataPath: string): string {
  return path.join(permitDirectory(dataPath), TURN_SUBDIR);
}

function activeTurnFile(dataPath: string, conversationId: string): string {
  return path.join(turnDirectory(dataPath), `${digest(conversationId)}.active.json`);
}

/**
 * A turn is identified by the conversation AND the exact bytes of the turn text
 * this store was handed.
 *
 * On the ORDINARY send path those are the raw bytes the person typed, verbatim.
 * On the STEER path they are the bytes actually delivered to the runtime, which
 * the send box trims. Stated as "handed to this store" rather than "typed"
 * because only the first of those two is literally what was typed, and a comment
 * that says "typed" for both is the overclaim an audit correctly rejected.
 *
 * The turn digest is fixed-length and always last, so the pair cannot be made
 * ambiguous by a conversation id that happens to contain the separator — and a
 * collision here would be one conversation spending another's edit, which is
 * worth one sentence of reasoning rather than a hope.
 */
function turnSpentFile(dataPath: string, conversationId: string, userTurnSha256: string): string {
  return path.join(turnDirectory(dataPath), `${digest(`${conversationId}|${userTurnSha256}`)}.spent.json`);
}

/**
 * Note which turn this conversation is on.
 *
 * Called on every ordinary send that builds a context envelope while the paid
 * path is open — not only when a permit is minted. That independence is the
 * point: if this only moved when something was minted, the redeem-time
 * comparison would be comparing a value against the value that wrote it, which
 * is the tautology round 1 shipped.
 *
 * It is NOT the whole story of "the user said something new". A correction sent
 * while the model is still working — a STEER — never reaches the envelope path
 * at all, so it cannot move this pointer. `revokeVideoEditSpendOnUserSteer`
 * below is the other half, and it exists because an independent audit found this
 * exact gap between the comment and the code.
 *
 * Never throws. It RETURNS whether the pointer is actually on disk, and callers
 * are expected to treat `false` as "the turn state could not be established" —
 * which on the mint path means no permit and a deny, not a quiet carry-on. A
 * `void` return was the round-3 shape and it is what let a failed pointer write
 * pass unnoticed.
 *
 * `false` also covers a request that named nothing to record; that is not a
 * storage failure, so only callers that already validated their input may read
 * `false` as one — every caller here does.
 */
export function recordActiveUserTurn(
  dataPath: string,
  conversationId: string,
  userTurnSha256: string,
  nowMs: number = Date.now()
): boolean {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return false;
  if (!isSha256Hex(userTurnSha256)) return false;
  try {
    writeJsonAtomic(activeTurnFile(dataPath, conversationId), {
      user_turn_sha256: userTurnSha256,
      observed_at_ms: nowMs,
    });
    return true;
  } catch {
    /* the next redeem simply refuses; nothing is granted on a missing pointer */
    return false;
  }
}

/** The turn this conversation is on, or `undefined`. Unreadable reads as absent. */
export function readActiveUserTurn(dataPath: string, conversationId: string): VideoEditActiveTurnRecord | undefined {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return undefined;
  const value = readJson(activeTurnFile(dataPath, conversationId));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isSha256Hex(record.user_turn_sha256) || typeof record.observed_at_ms !== 'number') return undefined;
  return record as unknown as VideoEditActiveTurnRecord;
}

/**
 * A user STEER — a correction typed while the model is still working — is a real
 * user turn, and this is what makes it one.
 *
 * THE GAP THIS CLOSES, found by an independent audit and not by us: a steer does
 * not go through the send path that builds a context envelope. It is an HTTP
 * call straight to the runtime (`/api/conversations/<id>/steer`), so it never
 * reached `recordActiveUserTurn` and never retired anything. The permit minted
 * for the PREVIOUS turn therefore stayed live across it, and "one paid edit per
 * explicit user turn" was a claim broader than the code that backed it.
 *
 * THREE effects now, and the third is the round-4 correction. Round 3 had the
 * first two and swallowed their failures:
 *
 *   - every still-live permit for this conversation is REVOKED;
 *   - the turn pointer moves to the steer's own bytes — THE BYTES THE RUNTIME
 *     WAS GIVEN, which is what `steerText` carries and which the send box has
 *     already trimmed. That is the honest invariant for a retirement: the
 *     recorded turn is the turn the agent read. It is NOT the raw-keystroke
 *     binding the mint path uses, and the two are not meant to be the same
 *     rule — a mint says "this is what the user asked", a retirement says "this
 *     is what superseded it in the run".
 *
 *     It catches a revoke whose `unlink` failed, and it is why the two are not
 *     redundant. (The pointer alone would not be enough either: a steer that is
 *     byte-identical to the turn that minted the permit would not move it — and
 *     because the delivered bytes are trimmed, a steer differing from that turn
 *     ONLY in leading or trailing whitespace does not move it either. Both are
 *     covered by the revoke and by the unconditional deny below, which is why
 *     the pointer is the backstop here and not the defence.)
 *   - the conversation is DENIED. Both defences above are deletions and writes,
 *     and both can fail; the deny is the state that does not depend on either
 *     succeeding. It is taken UNCONDITIONALLY once the store exists, not only on
 *     an error, because that is already the documented meaning of a steer: after
 *     one, the conversation has no spend authority until the next ordinary send.
 *     Making it conditional on an error would be a second thing to get wrong for
 *     no gain.
 *
 * NOTHING IS MINTED HERE, and that is the whole shape of the answer. A steer
 * carries no context envelope, so a permit minted for it could never be shown to
 * anyone — it would be a live spending credential emitted into nothing.
 *
 * Ungated by the spending flag on purpose. A revoke is the safe direction in
 * every state, and a gate on it would repeat the mistake of a gate that lives in
 * one lane's wrapper. It is still free on a seat that has never minted anything:
 * with no permit directory on disk there is provably no permit to retire, so this
 * returns immediately and writes nothing — an untouched seat stays byte-identical
 * and does not acquire a deny it has no use for. A store we cannot even look at
 * is the other case, and that one denies.
 *
 * Never throws. A failed revoke costs a refusal later, never a wrong charge.
 */
export interface VideoEditSteerRetirement {
  /** Live permit records actually deleted. */
  revoked: number;
  /** Whether the conversation now holds a deny. */
  denied: boolean;
  /** The strongest tier that deny was recorded at. */
  denyScope: VideoEditSpendDenyScope;
}

export function revokeVideoEditSpendOnUserSteer(
  dataPath: string,
  conversationId: string,
  /**
   * The correction text AS DELIVERED TO THE RUNTIME — not the raw keystrokes.
   * Named for what it is: the renderer passes the same value it posts to
   * `/api/conversations/<id>/steer`, and that value is trimmed.
   */
  steerTextAsDelivered: string,
  nowMs: number = Date.now()
): VideoEditSteerRetirement {
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return { revoked: 0, denied: false, denyScope: 'none' };
  }
  let storeExists: boolean;
  try {
    storeExists = fs.existsSync(permitDirectory(dataPath));
  } catch {
    // We cannot tell whether a permit exists, so we cannot claim there is none.
    const denyScope = denyVideoEditSpend(dataPath, conversationId, nowMs);
    return { revoked: 0, denied: denyScope !== 'none', denyScope };
  }
  // No store means nothing to revoke, and nothing worth creating one for.
  if (!storeExists) return { revoked: 0, denied: false, denyScope: 'none' };

  let revoked = 0;
  try {
    revoked = revokeLiveVideoEditSpendPermits(dataPath, conversationId, nowMs).revoked;
  } catch {
    /* the deny below does not depend on this having worked */
  }
  // Hashed EXACTLY AS RECEIVED — this function applies no trim, no case fold and
  // no normalisation of its own, and `hasVisibleCharacters` judges the value
  // without ever replacing it, for the same reason it does on the mint path.
  //
  // What arrives here is NOT the user's raw keystrokes, and calling it that was
  // the overclaim an audit rejected. `AcpSendBox.dispatchSteer` sends the same
  // `normalizedInput` it posts to the runtime, so these are the bytes the AGENT
  // was given — leading and trailing whitespace already gone. That is the
  // correct binding for a retirement, and it is a different rule from the mint
  // path's raw-turn binding on purpose.
  if (hasVisibleCharacters(steerTextAsDelivered)) {
    try {
      recordActiveUserTurn(dataPath, conversationId, digest(steerTextAsDelivered), nowMs);
    } catch {
      /* likewise: the deny below stands whether or not the pointer moved */
    }
  }
  const denyScope = denyVideoEditSpend(dataPath, conversationId, nowMs);
  return { revoked, denied: denyScope !== 'none', denyScope };
}

/** Has this exact turn already bought its one edit? */
export function hasUserTurnAlreadySpent(dataPath: string, conversationId: string, userTurnSha256: string): boolean {
  if (typeof conversationId !== 'string' || conversationId.length === 0) return false;
  if (!isSha256Hex(userTurnSha256)) return false;
  const value = readJson(turnSpentFile(dataPath, conversationId, userTurnSha256));
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const RECORD_NAME_LENGTH = 69; // <64 hex>.json
const CONSUMED_NAME_LENGTH = 78; // <64 hex>.consumed.json
const RESULT_NAME_LENGTH = 76; // <64 hex>.result.json
const ACTIVE_TURN_NAME_LENGTH = 76; // <64 hex>.active.json
const SPENT_TURN_NAME_LENGTH = 75; // <64 hex>.spent.json

/**
 * How long a CLAIM and a RECEIPT outlive the permit they belong to.
 *
 * Deliberately independent of whether the permit record still exists, because
 * the record is deleted the moment the next user turn mints its own — and a slow
 * edit whose permit was retired underneath it must still be recoverable. Tying
 * receipt retention to the record was the first version of this sweep and it
 * turned exactly that case into a second charge.
 */
export const VIDEO_EDIT_SPEND_RECEIPT_RETENTION_MS = VIDEO_EDIT_SPEND_PERMIT_TTL_MS + VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS;

function numberField(value: unknown, field: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const at = (value as Record<string, unknown>)[field];
  return typeof at === 'number' ? at : 0;
}

/**
 * Delete every turn artefact whose window has closed.
 *
 * Retention matches the receipts, and that number is a deliberate trade rather
 * than a default: while a turn's spend claim lives, that turn cannot buy a
 * second edit. Keeping it forever would mean a user who retypes the identical
 * sentence next week is refused; dropping it early would reopen the re-drive.
 * One permit window plus one lock window is long enough that nothing in flight
 * can outlive it.
 */
function pruneVideoEditTurnRecords(dataPath: string, nowMs: number): number {
  const dir = turnDirectory(dataPath);
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.slice(name.length - 5) !== '.json') continue;
    if (!isSha256Hex(name.slice(0, 64))) continue;
    const file = path.join(dir, name);
    const value = readJson(file);
    let liveUntil = 0;
    if (name.length === ACTIVE_TURN_NAME_LENGTH) {
      liveUntil = numberField(value, 'observed_at_ms') + VIDEO_EDIT_SPEND_RECEIPT_RETENTION_MS;
    } else if (name.length === SPENT_TURN_NAME_LENGTH) {
      liveUntil = numberField(value, 'consumed_at_ms') + VIDEO_EDIT_SPEND_RECEIPT_RETENTION_MS;
    }
    if (nowMs < liveUntil) continue;
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      /* an undeletable pointer is still judged on read; nothing is granted */
    }
  }
  return removed;
}

/**
 * Delete every permit artefact whose window has closed. Cheap, bounded, never
 * throws.
 *
 * Each file kind is judged by ITS OWN timestamp rather than by the record's, so
 * no kind can be swept out from under another.
 *
 * DENY MARKERS ARE NOT REACHED BY THIS, and that is enforced by shape rather
 * than by a filter someone could delete: they live in the `deny/` SUBDIRECTORY,
 * and both loops here take `entry.isFile()` only. A deny that expired on a timer
 * would be the implicit clearing the contract forbids.
 */
export function pruneVideoEditSpendPermits(dataPath: string, nowMs: number): number {
  const dir = permitDirectory(dataPath);
  let removed = pruneVideoEditTurnRecords(dataPath, nowMs);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.slice(name.length - 5) !== '.json') continue;
    if (!isSha256Hex(name.slice(0, 64))) continue;

    const file = path.join(dir, name);
    const value = readJson(file);
    let liveUntil = 0;
    if (name.length === RECORD_NAME_LENGTH) {
      const record = parsePermitRecord(value);
      liveUntil = record ? record.expires_at_ms + VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS : 0;
    } else if (name.length === CONSUMED_NAME_LENGTH) {
      liveUntil = numberField(value, 'consumed_at_ms') + VIDEO_EDIT_SPEND_RECEIPT_RETENTION_MS;
    } else if (name.length === RESULT_NAME_LENGTH) {
      liveUntil = numberField(value, 'completed_at_ms') + VIDEO_EDIT_SPEND_RECEIPT_RETENTION_MS;
    }
    if (nowMs < liveUntil) continue;

    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      /* a file we cannot delete still cannot resolve — the parsers refuse it */
    }
  }
  return removed;
}

export interface IssueVideoEditSpendPermitInput {
  conversationId: string;
  userTurnSha256: string;
  allowedArtifactSha256: readonly string[];
  /**
   * The operation the minted permit authorises (1.820.3). Optional; absent
   * means `video_edit`. The mint-time revocation below is scoped to the SAME
   * operation so a turn's video permit and its image permit can both be live —
   * the one-spend-per-turn rule still binds them, because the turn's
   * `.spent.json` claim is operation-agnostic and exactly one of them can win
   * it.
   */
  operation?: SpendPermitOperation;
  nowMs?: number;
  randomBytes?: (size: number) => Uint8Array;
  ttlMs?: number;
}

/**
 * Issue THE permit for one user turn, or `undefined`.
 *
 * Minting also PRUNES and REVOKES: the permit from the previous turn stops being
 * live the moment this one is written, so a model cannot bank permits across
 * turns and spend them in a burst. Its receipt survives the sweep for the lock
 * window, so an edit still running against the old permit can still be recovered
 * rather than double-charged.
 *
 * AND IT REFUSES A TURN THAT HAS ALREADY SPENT. That is the round-2 correction:
 * revoke-on-mint alone bounded how many permits were LIVE at once, not how many
 * a single request could buy — re-driving this function for the same raw turn
 * simply minted a fresh one each time. Now the turn itself is the unit. A second
 * paid edit needs a second thing the person typed.
 *
 * AND IT IS THE ONLY PLACE A DENY IS LIFTED — the round-4 addition. The lift
 * happens last, after the previous permits were provably retired, after the turn
 * pointer is provably on disk and after the new record is written: that sequence
 * IS the contract's "a later successful ordinary user send establishes fresh turn
 * state and a new valid permit". Any of those three failing denies the
 * conversation and returns no permit, rather than lifting anything.
 */
export function issueVideoEditSpendPermit(dataPath: string, input: IssueVideoEditSpendPermitInput): string | undefined {
  const nowMs = input.nowMs ?? Date.now();
  // ROUND 5 — THE SECOND (AND ONLY OTHER) WAY THE PROCESS-WIDE DENY CLEARS.
  //
  // "A fresh ordinary user send" is the contract's wording, and this is it: a
  // send that reaches the mint while the store is unproven runs the
  // reinitialization FIRST, so every pre-restart permit, turn pointer and lock
  // is gone before this call writes anything of its own. The permit minted below
  // therefore cannot be revived alongside an older one.
  //
  // It runs BEFORE `hasUserTurnAlreadySpent` on purpose: the sweep keeps the
  // `.spent.json` receipts, so that check still answers correctly afterwards,
  // and putting the sweep second would leave a path that returns without ever
  // proving the store.
  if (!isVideoEditSpendStoreHealthy() && reinitializeVideoEditSpendStore(dataPath) !== 'healthy') {
    // The store could not be proven, so this seat may not hold spend authority
    // at all. Denying the conversation as well costs nothing and keeps the
    // per-conversation gate consistent with the process-wide one.
    denyVideoEditSpend(dataPath, input.conversationId, nowMs);
    return undefined;
  }
  if (hasUserTurnAlreadySpent(dataPath, input.conversationId, input.userTurnSha256)) return undefined;
  const minted = mintVideoEditSpendPermit({
    conversationId: input.conversationId,
    userTurnSha256: input.userTurnSha256,
    allowedArtifactSha256: input.allowedArtifactSha256,
    operation: input.operation ?? 'video_edit',
    nowMs,
    randomBytes: input.randomBytes ?? ((size: number) => new Uint8Array(crypto.randomBytes(size))),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
  if (!minted) return undefined;
  try {
    // A sweep we cannot vouch for may have left a live permit from an earlier
    // turn on disk. Minting a second one beside it — and then lifting the deny —
    // is exactly the fail-open this round removes. The revocation covers EVERY
    // live permit regardless of operation: at most one permit is live per
    // conversation, so a model cannot bank permits across turns — and with the
    // 1.820.3 requestedEditOperation gate the newly minted one is always the
    // turn's ONE operation anyway.
    if (!revokeLiveVideoEditSpendPermits(dataPath, input.conversationId, nowMs).clean) {
      denyVideoEditSpend(dataPath, input.conversationId, nowMs);
      return undefined;
    }
    // Housekeeping, and deliberately NOT a reason to deny: a record we failed to
    // prune is still judged on expiry every time it is read, so leaving it costs
    // disk, not authority.
    pruneVideoEditSpendPermits(dataPath, nowMs);
    // The pointer is written HERE as well as on the send path, because a store
    // that could hand out a permit without leaving a turn to compare it against
    // would make the redeem check unreachable for every caller that is not the
    // renderer.
    if (!recordActiveUserTurn(dataPath, input.conversationId, input.userTurnSha256, nowMs)) {
      denyVideoEditSpend(dataPath, input.conversationId, nowMs);
      return undefined;
    }
    writeJsonAtomic(permitFiles(dataPath, minted.permit).record, minted.record);
    // LAST, and only here. If the marker cannot be removed the conversation stays
    // denied and this permit buys nothing — a refusal, never a charge.
    clearVideoEditSpendDeny(dataPath, input.conversationId);
    return minted.permit;
  } catch {
    // No permit is a correct outcome; a half-written one would not be. And a
    // throw anywhere above means we cannot account for this conversation's spend
    // state, which is the definition of a deny.
    denyVideoEditSpend(dataPath, input.conversationId, nowMs);
    return undefined;
  }
}

/**
 * Retire every still-live permit for a conversation.
 *
 * Called on every mint. This is the "one live permit per conversation" rule, and
 * it is why a permit the model saw three turns ago buys nothing today even
 * though its own TTL has not run out yet. Receipts are left alone.
 *
 * `clean` is the round-4 addition and it is the whole reason this returns an
 * object: a count of what WAS deleted says nothing about what could not be, and
 * the mint path has to be able to tell the difference. An empty store is clean —
 * there was nothing to delete and we know it. A directory we could not read, or
 * an `unlink` that refused, is not.
 */
export interface VideoEditSpendRevocation {
  revoked: number;
  clean: boolean;
}

export function revokeLiveVideoEditSpendPermits(
  dataPath: string,
  conversationId: string,
  nowMs: number
): VideoEditSpendRevocation {
  const dir = permitDirectory(dataPath);
  let revoked = 0;
  let clean = true;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // A store that does not exist yet holds no permit — provably nothing to
    // revoke. Any other reason is a sweep we cannot vouch for.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { revoked: 0, clean: code === 'ENOENT' || code === 'ENOTDIR' };
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.length !== 69) continue;
    const file = path.join(dir, entry.name);
    const record = parsePermitRecord(readJson(file));
    if (!record || record.conversation_id !== conversationId) continue;
    if (nowMs >= record.expires_at_ms) continue;
    try {
      fs.unlinkSync(file);
      revoked += 1;
    } catch {
      /* still live on disk but the next read re-checks expiry; nothing is granted */
      clean = false;
    }
  }
  return { revoked, clean };
}

/** Read a permit record by the permit itself. Unknown and unreadable read alike. */
export function readVideoEditSpendPermitRecord(
  dataPath: string,
  permit: unknown
): VideoEditSpendPermitRecord | undefined {
  if (!isWellFormedVideoEditSpendPermit(permit)) return undefined;
  return parsePermitRecord(readJson(permitFiles(dataPath, permit).record));
}

/**
 * The receipt for a permit that already produced a clip, when it matches THIS
 * request exactly.
 *
 * Matching on the instruction and the source bytes is what makes a retry free: a
 * repeat of the same edit gets its result back, while the same permit pointed at
 * a different instruction gets nothing — that second case is the
 * varied-instruction loop, and it must not be able to launder itself into a
 * recovery.
 *
 * `conversationId` is REQUIRED and is the round-2 correction. Round 1 matched on
 * (instruction, bytes) alone, so two conversations holding byte-identical clips
 * were enough for conversation B to recover conversation A's edit — and, with
 * it, A's `MEDIA: /Users/<name>/…` path. A receipt belongs to the conversation
 * that paid for it; anything else reads as absent.
 */
export function readVideoEditSpendCompletion(
  dataPath: string,
  permit: unknown,
  match: { conversationId: string; instructionSha256: string; artifactSha256: string }
): VideoEditSpendCompletion | undefined {
  if (!isWellFormedVideoEditSpendPermit(permit)) return undefined;
  if (typeof match.conversationId !== 'string' || match.conversationId.length === 0) return undefined;
  const value = readJson(permitFiles(dataPath, permit).result);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const completion = value as Record<string, unknown>;
  if (
    typeof completion.artifact_id !== 'string' ||
    typeof completion.source_artifact_id !== 'string' ||
    completion.conversation_id !== match.conversationId ||
    completion.instruction_sha256 !== match.instructionSha256 ||
    completion.artifact_sha256 !== match.artifactSha256
  ) {
    return undefined;
  }
  return completion as unknown as VideoEditSpendCompletion;
}

export function recordVideoEditSpendCompletion(
  dataPath: string,
  permit: string,
  completion: VideoEditSpendCompletion
): void {
  if (!isWellFormedVideoEditSpendPermit(permit)) return;
  try {
    writeJsonAtomic(permitFiles(dataPath, permit).result, completion);
  } catch {
    /* the clip is saved either way; losing the receipt only costs a retry a refusal */
  }
}

export type VideoEditSpendConsumption = { ok: true } | { ok: false; reason: SpendPermitRefusal };

/**
 * Spend the permit — exactly once, before the provider is called.
 *
 * TWO exclusive creates, in this order, and the order is the whole design:
 *
 *   1. THE TURN. `<conversation|turn>.spent.json`, `wx`. If it already exists
 *      and names a DIFFERENT permit, this is a second permit trying to buy a
 *      second edit for one thing the user said — refused. If it names THIS
 *      permit, we fall through, because that is a retry of our own request and
 *      the permit-level judgement below knows how to answer it.
 *   2. THE PERMIT. `<permit>.consumed.json`, `wx`, unchanged from round 1.
 *
 * Doing the turn first is what makes the guarantee atomic rather than checked:
 * two arrivals with two different permits for one turn race at the filesystem,
 * and exactly one wins. Doing it second would have needed a rollback, and a
 * rollback in a spend path is a second way to be wrong.
 *
 * There is no read-then-write anywhere in this function, because that pattern is
 * precisely how two concurrent arrivals both conclude they may spend.
 */
export function consumeVideoEditSpendPermit(
  dataPath: string,
  input: {
    permit: string;
    conversationId: string;
    userTurnSha256: string;
    instructionSha256: string;
    artifactSha256?: string;
    requestSha256?: string;
    nowMs?: number;
  }
): VideoEditSpendConsumption {
  if (!isWellFormedVideoEditSpendPermit(input.permit)) return { ok: false, reason: 'permit-malformed' };
  // A spend we cannot attribute to a turn is a spend we cannot bound. Refuse
  // rather than fall back to permit-only accounting, which is what round 1 did
  // implicitly by never having this concept at all.
  if (typeof input.conversationId !== 'string' || input.conversationId.length === 0) {
    return { ok: false, reason: 'permit-turn-unknown' };
  }
  if (!isSha256Hex(input.userTurnSha256)) return { ok: false, reason: 'permit-turn-unknown' };
  const requestSha256 = isSha256Hex(input.requestSha256) ? input.requestSha256 : undefined;
  const artifactSha256 = isSha256Hex(input.artifactSha256) ? input.artifactSha256 : undefined;
  const consumesRequest = requestSha256 !== undefined;
  if (consumesRequest === (artifactSha256 !== undefined)) {
    return { ok: false, reason: consumesRequest ? 'permit-consume-failed' : 'permit-artifact-not-covered' };
  }
  const targetClaim = consumesRequest ? { request_sha256: requestSha256 } : { artifact_sha256: artifactSha256 };

  const permitKey = digest(input.permit);
  const turnFile = turnSpentFile(dataPath, input.conversationId, input.userTurnSha256);
  if (
    !createExclusive(turnFile, {
      permit_sha256: permitKey,
      instruction_sha256: input.instructionSha256,
      ...targetClaim,
      consumed_at_ms: input.nowMs ?? Date.now(),
    })
  ) {
    const priorTurn = readJson(turnFile);
    const priorPermit =
      priorTurn && typeof priorTurn === 'object' && !Array.isArray(priorTurn)
        ? (priorTurn as Record<string, unknown>).permit_sha256
        : undefined;
    // A different permit — or a claim we cannot read — means this turn's one
    // edit is not ours to take.
    if (priorPermit !== permitKey) return { ok: false, reason: 'permit-turn-consumed' };
  }

  const files = permitFiles(dataPath, input.permit);
  const claim = {
    instruction_sha256: input.instructionSha256,
    ...targetClaim,
    consumed_at_ms: input.nowMs ?? Date.now(),
  };
  if (createExclusive(files.consumed, claim)) return { ok: true };

  const prior = readJson(files.consumed);
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) {
    // We lost the race and cannot read what won it. Fail closed: the only other
    // option is to spend a second time on a guess.
    return { ok: false, reason: 'permit-consume-failed' };
  }
  const claimed = prior as Record<string, unknown>;
  if (
    claimed.instruction_sha256 !== input.instructionSha256 ||
    (consumesRequest
      ? claimed.request_sha256 !== requestSha256 || Object.hasOwn(claimed, 'artifact_sha256')
      : claimed.artifact_sha256 !== artifactSha256 || Object.hasOwn(claimed, 'request_sha256'))
  ) {
    // THE varied-instruction loop, refused. One permit, one edit — a different
    // instruction is a different edit and needs a different user turn.
    return { ok: false, reason: 'permit-consumed' };
  }
  return { ok: false, reason: 'permit-in-flight' };
}

function inflightLockFile(dataPath: string, conversationId: string): string {
  return path.join(permitDirectory(dataPath), INFLIGHT_SUBDIR, `${digest(conversationId)}.lock`);
}

/**
 * At most one paid edit in flight per conversation.
 *
 * Also `wx`. A stale lock past the TTL is reclaimed rather than honoured, so a
 * crash during an edit costs one wait, not a permanently closed lane.
 */
export function acquireVideoEditInflightLock(
  dataPath: string,
  conversationId: string,
  nowMs: number = Date.now()
): boolean {
  const file = inflightLockFile(dataPath, conversationId);
  if (createExclusive(file, { pid: process.pid, acquired_at_ms: nowMs })) return true;
  const held = readJson(file);
  const acquiredAt =
    held &&
    typeof held === 'object' &&
    !Array.isArray(held) &&
    typeof (held as Record<string, unknown>).acquired_at_ms === 'number'
      ? ((held as Record<string, unknown>).acquired_at_ms as number)
      : 0;
  if (nowMs - acquiredAt < VIDEO_EDIT_INFLIGHT_LOCK_TTL_MS) return false;
  try {
    fs.unlinkSync(file);
  } catch {
    return false;
  }
  return createExclusive(file, { pid: process.pid, acquired_at_ms: nowMs });
}

export function releaseVideoEditInflightLock(dataPath: string, conversationId: string): void {
  try {
    fs.unlinkSync(inflightLockFile(dataPath, conversationId));
  } catch {
    /* already gone, or never held — either way the lane is open */
  }
}

/**
 * Read + judge in one call, so no caller can accidentally skip the judging half.
 *
 * BOTH values the judgement compares are read from our own store here: the
 * permit record, and the turn the conversation is currently on. Neither is
 * accepted from the caller, which is what keeps the comparison a binding rather
 * than a claim the presenter gets to make about itself.
 */
export function evaluateStoredVideoEditSpendPermit(
  dataPath: string,
  input: {
    permit: unknown;
    conversationId: string;
    observedArtifactSha256: string;
    nowMs?: number;
    operation?: SpendPermitOperation;
  }
): SpendPermitEvaluation {
  const activeTurn = readActiveUserTurn(dataPath, input.conversationId);
  return evaluateVideoEditSpendPermit({
    permit: input.permit,
    record: readVideoEditSpendPermitRecord(dataPath, input.permit),
    conversationId: input.conversationId,
    operation: input.operation ?? 'video_edit',
    observedUserTurnSha256: activeTurn === undefined ? '' : activeTurn.user_turn_sha256,
    observedArtifactSha256: input.observedArtifactSha256,
    nowMs: input.nowMs ?? Date.now(),
  });
}

export { VIDEO_EDIT_SPEND_PERMIT_TTL_MS };
