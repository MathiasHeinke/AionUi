/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205 — THE BOOT-TIME ACTIVE-SEAT POINTER.
 *
 * THE BUG THIS CLOSES, and it was documented in the tree before it was fixed.
 * `index.ts` said it plainly at the env bake:
 *
 *   "At BOOT the active seat is ALWAYS the legacy/founder home: nothing calls
 *    setActiveSeatId before this point (the persist pointer is a no-op … and
 *    there is no boot-time restore of a saved seat) … If a boot-time
 *    seat-restore is ever added, it MUST call setActiveSeatId +
 *    setActiveSeatLabel BEFORE this bake."
 *
 * The consequence was not cosmetic. `seatContextCore` is the ONLY holder of the
 * active seat, and everything downstream namespaces off it:
 *
 *   - `inferenceSelectionBackendRead.physicalSettingsKey` builds
 *     `seatScopedKey(logicalKey, getActiveSeatId())`;
 *   - on the legacy seat `seatScopedKey` returns the key UNCHANGED.
 *
 * So after a restart, main read `commandEve.maxEntitled` UN-NAMESPACED while the
 * renderer had written it to `seat:<uuid>:commandEve.maxEntitled`. The value was
 * there and simply not looked at: `rawMaxEntitled` came back `undefined`,
 * `maxEntitled` stayed `undefined`, and the turn parked on
 * "Berechtigung wird geprüft" instead of routing MAX or Standard. The renderer
 * could not compensate — it asks MAIN for the id over `command-eve.active-seat`,
 * so both sides agreed on the wrong seat.
 *
 * WHY A LOCAL FILE. The server-side pointer (`persistActiveSeatPointer` in
 * commandEveBridge) is authored-but-not-deployed and is a documented no-op, and
 * the my-seats read needs a network the app may not have at boot. The active
 * seat has to survive a restart OFFLINE, before any renderer or bridge is up,
 * because the env bake that homes HERMES_HOME happens first. A 0600 JSON file
 * next to the other runtime receipts is the smallest thing that does that.
 *
 * FAIL-CLOSED, in the byte-identical direction. Absent, unreadable, malformed,
 * wrong version, or an id that fails the seat-id allowlist ⇒ `null` ⇒ the caller
 * leaves the holder on `LEGACY_SEAT_ID`, which is EXACTLY today's shipped
 * behaviour. This module can therefore only ever restore a seat the app itself
 * wrote; it can never invent one, and a corrupted pointer degrades to the
 * single-seat path rather than to someone else's seat.
 *
 * WHAT IT IS NOT: an authorization record. The pointer says "this is the seat
 * this install last switched to", nothing more. The seat-switch IPC still
 * re-authorizes against a fresh my-seats read, and every server-side gate is
 * unchanged — restoring context is not granting access.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  isLegacySeatId,
  sanitizeSeatId,
  setActiveSeatId,
  setActiveSeatKind,
  setActiveSeatLabel,
} from './seatContextCore';

/** Bump only on a shape change; an unknown version reads as absent (fail-closed). */
export const ACTIVE_SEAT_POINTER_VERSION = 'command-eve-active-seat-pointer/v0';

const POINTER_FILE_NAME = 'active-seat-pointer.json';

/** `<userData>/command-eve-runtime/active-seat-pointer.json`. */
export function activeSeatPointerFilePath(dataPath: string): string {
  return path.join(path.resolve(dataPath), 'command-eve-runtime', POINTER_FILE_NAME);
}

export interface ActiveSeatPointer {
  seatId: string;
  /** Display label only — never a secret. Absent ⇒ the holder's 'Founder' default. */
  label?: string;
  /** 'own_company' | 'department' | 'client'; anything else folds to 'client'. */
  kind?: string;
}

/**
 * The outcome of a pointer write. THREE states, not a boolean, because the two
 * non-written ones mean opposite things and the caller must be able to tell them
 * apart:
 *
 *   - `'written'` — a real seat's pointer is on disk;
 *   - `'cleared'` — the target was the legacy seat, so the pointer was REMOVED.
 *     That is a success: absence is how the next boot resolves to legacy;
 *   - `'failed'`  — the write did not happen (full disk, permissions, a read-only
 *     volume). The switch still stands, but the NEXT BOOT will come up on the
 *     legacy seat and read every seat-scoped key un-namespaced — the exact bug
 *     this module exists to close, silently reintroduced.
 *
 * A single `false` conflated the last two, and the only caller discarded it, so a
 * failed write was invisible. `'failed'` is now mapped onto the switch result's
 * existing `persist_failed` flag.
 *
 * Still BEST-EFFORT: this never throws. A seat switch that already succeeded
 * locally must not be failed by a bookkeeping write.
 */
export type ActiveSeatPointerWriteResult = 'written' | 'cleared' | 'failed';

/**
 * Persist the pointer.
 *
 * A legacy/unsafe id CLEARS the pointer rather than writing one: switching back to
 * the founder seat must not leave a stale client-seat pointer that the next boot
 * would restore.
 */
export function writeActiveSeatPointer(dataPath: string, pointer: ActiveSeatPointer): ActiveSeatPointerWriteResult {
  try {
    const file = activeSeatPointerFilePath(dataPath);
    /** Remove any existing pointer so the next boot resolves to legacy by ABSENCE. */
    const removePointer = (): boolean => {
      try {
        fs.rmSync(file, { force: true });
        return true;
      } catch {
        // A pointer we cannot REMOVE is as dangerous as one we cannot write: the
        // next boot would restore a seat the operator has already left.
        return false;
      }
    };
    const sanitized = sanitizeSeatId(pointer.seatId);
    if (sanitized === null) {
      // An id that fails the allowlist is REFUSED, not "cleared on purpose": the
      // caller asked for a pointer and is not getting one, which is exactly what
      // 'failed' means. We still drop any existing pointer — a caller handing us a
      // traversal id is not a state we want to keep a stale seat through.
      removePointer();
      return 'failed';
    }
    if (isLegacySeatId(sanitized)) {
      // Back on the founder seat: absence IS the desired end state, so a successful
      // removal is a success, not a failure.
      return removePointer() ? 'cleared' : 'failed';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = {
      version: ACTIVE_SEAT_POINTER_VERSION,
      seat_id: sanitized,
      ...(typeof pointer.label === 'string' && pointer.label.trim().length > 0
        ? { seat_label: pointer.label.trim() }
        : {}),
      ...(typeof pointer.kind === 'string' && pointer.kind.trim().length > 0 ? { seat_kind: pointer.kind.trim() } : {}),
    };
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best-effort: the write already carried the mode */
    }
    return 'written';
  } catch {
    return 'failed';
  }
}

/**
 * Read the pointer, or `null`.
 *
 * Every failure mode collapses to `null` on purpose — see the module docstring.
 * The id is re-sanitized on the way OUT as well as on the way in: the file is
 * 0600 in private app data, but a value that became a path segment or a config-key
 * prefix must be validated where it is USED, not only where it was written.
 */
export function readActiveSeatPointer(dataPath: string): ActiveSeatPointer | null {
  try {
    const raw = fs.readFileSync(activeSeatPointerFilePath(dataPath), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== ACTIVE_SEAT_POINTER_VERSION) return null;
    if (typeof record.seat_id !== 'string') return null;
    const sanitized = sanitizeSeatId(record.seat_id);
    if (sanitized === null || isLegacySeatId(sanitized)) return null;
    return {
      seatId: sanitized,
      ...(typeof record.seat_label === 'string' && record.seat_label.trim().length > 0
        ? { label: record.seat_label.trim() }
        : {}),
      ...(typeof record.seat_kind === 'string' && record.seat_kind.trim().length > 0
        ? { kind: record.seat_kind.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface RestoreActiveSeatResult {
  /** The id the holder is on AFTER the attempt. */
  seatId: string;
  /** 'pointer' when a saved seat was restored; 'legacy' when nothing was. */
  source: 'pointer' | 'legacy';
}

/**
 * THE BOOT RESTORE. Call this BEFORE anything reads `getActiveSeatId()` — in
 * particular before `prepareCommandEveRuntimeProcessEnv`, which bakes
 * HERMES_HOME and the seat env trio for every child process.
 *
 * Sets id → label → kind in that order, mirroring `applySeatSwitch` so a restored
 * boot and a fresh switch leave the holder in the SAME shape. `setActiveSeatId`
 * throws on an unsafe id; the id was already sanitized by the reader, and the
 * throw is caught here anyway so a boot can never die on a bad pointer.
 */
export function restoreActiveSeatFromPointer(
  dataPath: string,
  deps: {
    readPointer?: typeof readActiveSeatPointer;
    setSeatId?: typeof setActiveSeatId;
    setSeatLabel?: typeof setActiveSeatLabel;
    setSeatKind?: typeof setActiveSeatKind;
  } = {}
): RestoreActiveSeatResult {
  const read = deps.readPointer ?? readActiveSeatPointer;
  const setId = deps.setSeatId ?? setActiveSeatId;
  const setLabel = deps.setSeatLabel ?? setActiveSeatLabel;
  const setKind = deps.setSeatKind ?? setActiveSeatKind;
  try {
    const pointer = read(dataPath);
    if (!pointer) return { seatId: 'seat-1', source: 'legacy' };
    setId(pointer.seatId);
    setLabel(pointer.label);
    setKind(pointer.kind);
    return { seatId: pointer.seatId, source: 'pointer' };
  } catch {
    // A restore that cannot complete leaves the process on the legacy seat —
    // today's behaviour, and the only safe direction: a half-restored context
    // (id set, label/kind not) would bake an env that describes no real seat.
    return { seatId: 'seat-1', source: 'legacy' };
  }
}
