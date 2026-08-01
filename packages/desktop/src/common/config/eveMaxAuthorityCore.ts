/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE MAX VISUAL AUTHORITY — one decision, made where the request is made.
 *
 * WHY THIS EXISTS. The renderer used to compute its own effective wire tier
 * (the wire-tier resolver, inside the selection hook) while the
 * MAIN process independently computed the tier that actually goes on the wire.
 * Two authorities can disagree, and when they do the composer paints a state the
 * request is not in — the same defect that was removed at the surface,
 * reintroduced one level up.
 *
 * So the renderer no longer DECIDES; it RECEIVES. This module holds the receipt
 * shape and the pure validation both sides share.
 *
 * SEAT BINDING IS PART OF THE DECISION, not metadata about it. A receipt carries
 * the seat it was computed for AND that seat's context revision, because a seat
 * transition must not be able to reuse a prior answer: seat A's MAX entitlement
 * painting seat B's composer is a cross-tenant visual lie, and revision catches
 * the case where the same seat id was re-bound underneath us.
 *
 * FAIL VISUALLY CLOSED. Painting MAX is the claim that needs proof; not painting
 * it is always safe. Loading, error, staleness, seat mismatch and any malformed
 * receipt all resolve to "do not paint".
 */

/** What the MAIN process reports about the lane it would actually send on. */
export type EveMaxAuthorityReceipt = {
  /** The seat this decision was computed for. */
  seatId: string;
  /** That seat's context revision at decision time. */
  seatContextRevision: number;
  /**
   * TRUE iff the effective wire tier the shim would send for this seat RIGHT NOW
   * is `max`. Derived in main from the same resolver that builds the real
   * request — never recomputed in the renderer.
   */
  maxActive: boolean;
  /** The effective wire tier, for diagnostics. Never used to re-derive maxActive. */
  wireTier?: string;
  /**
   * Present iff the lane is HELD: the seat's persisted intent is MAX and its
   * entitlement is UNKNOWN, so main will send NOTHING on this selection.
   *
   * It is a THIRD state, not a flavour of `maxActive: false`. False alone cannot
   * be distinguished from "proven unentitled, sending Standard", and the two owe
   * the user opposite things: Standard runs and explains the downgrade, a hold
   * runs nothing and says the entitlement is still being checked.
   */
  laneHold?: 'max-entitlement-unknown';
};

/** The renderer's view of the authority, including the not-yet-trustworthy states. */
export type EveMaxAuthorityState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; receipt: EveMaxAuthorityReceipt };

/**
 * Should the composer paint MAX?
 *
 * The ONLY function allowed to answer that. It takes the authority state and the
 * seat the renderer believes is active, and returns false for every case that is
 * not a positive, current, seat-matched `maxActive: true`.
 *
 * `currentRevision` is REQUIRED, and that is the whole point. It was optional
 * once; production then called this WITHOUT it, so the revision branch never ran
 * and the "stale seat" guard did nothing at all. An optional guard is an absent
 * guard. It must be supplied from an INDEPENDENT main-authoritative read of the
 * CURRENT seat context — never from the receipt itself, because comparing a
 * receipt's revision to its own is not a staleness check.
 *
 * Pass `null` when that read is unavailable (loading/error). Null never paints.
 */
export function shouldPaintMaxSurface(
  state: EveMaxAuthorityState | null | undefined,
  currentSeatId: string | null | undefined,
  currentRevision: number | null
): boolean {
  const receipt = currentSeatReceipt(state, currentSeatId, currentRevision);
  return receipt?.maxActive === true;
}

/**
 * Is the send path HELD for this seat right now?
 *
 * The mirror of {@link shouldPaintMaxSurface}, over the SAME binding, so the two
 * cannot disagree about which receipt is current. It answers TRUE only for a
 * ready, seat-matched, revision-matched receipt that main marked as held.
 *
 * FAIL-CLOSED HERE MEANS "DO NOT HOLD", and the asymmetry is deliberate. A hold
 * stops the user from sending, so inventing one from loading/error/stale state
 * would brick a composer on no evidence. The spend guarantee does not depend on
 * this returning true: main refuses the turn regardless (see
 * `CommandEveMaxEntitlementHoldError`). This function exists so the surface can
 * be HONEST about a hold it KNOWS about — never so it can be the only thing
 * standing between an unverified seat and paid inference.
 */
export function shouldHoldSendForMaxEntitlement(
  state: EveMaxAuthorityState | null | undefined,
  currentSeatId: string | null | undefined,
  currentRevision: number | null
): boolean {
  const receipt = currentSeatReceipt(state, currentSeatId, currentRevision);
  return receipt?.laneHold === 'max-entitlement-unknown';
}

/**
 * The receipt IFF it is ready, well-formed and bound to the CURRENT seat at the
 * CURRENT revision — otherwise `undefined`. Extracted so paint and hold share one
 * definition of "this answer is about the seat in front of the user".
 */
function currentSeatReceipt(
  state: EveMaxAuthorityState | null | undefined,
  currentSeatId: string | null | undefined,
  currentRevision: number | null
): EveMaxAuthorityReceipt | undefined {
  if (!state || state.status !== 'ready') return undefined;

  const receipt = state.receipt;
  if (!receipt || typeof receipt !== 'object') return undefined;

  // SEAT IDENTITY. A receipt for another seat — or for no seat at all — never
  // paints. Both sides must be non-empty strings; "" === "" must not pass.
  if (typeof receipt.seatId !== 'string' || receipt.seatId.length === 0) return undefined;
  if (typeof currentSeatId !== 'string' || currentSeatId.length === 0) return undefined;
  if (receipt.seatId !== currentSeatId) return undefined;

  // SEAT REVISION — an EXACT match against an INDEPENDENTLY-read CURRENT value.
  // Catches a re-bind of the same seat id underneath us, which the seat id alone
  // cannot see. Absent (null) means we could not establish the current revision,
  // and an unestablished guard must refuse rather than wave the receipt through.
  if (typeof currentRevision !== 'number') return undefined;
  if (typeof receipt.seatContextRevision !== 'number') return undefined;
  if (receipt.seatContextRevision !== currentRevision) return undefined;

  return receipt;
}
