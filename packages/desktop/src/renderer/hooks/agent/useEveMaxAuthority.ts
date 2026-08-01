/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useEveMaxAuthority — the renderer RECEIVES the MAX decision; it does not make one.
 *
 * The composer's MAX visual asks the MAIN process "would the shim send `max` for
 * the active seat right now?" over `command-eve.inference-lane-decision`, which
 * answers using the SAME resolver that builds the real request. There is exactly
 * one computation of that answer in the product.
 *
 * WHAT THIS REPLACED, and why it was wrong: the selection hook used to derive
 * `maxActive` from the wire-tier resolver locally, in parallel
 * with main. Two authorities can disagree, and when they do the composer paints a
 * state the wire is not in — the surface-honesty defect, reintroduced one level
 * up. The local derivation is DELETED, not flagged: a fallback is a second answer.
 *
 * FAIL VISUALLY CLOSED. Loading, error, a receipt for another seat, a stale
 * revision, or a malformed payload all resolve to "do not paint". Painting MAX is
 * the claim that needs proof.
 */

import { commandEve } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import {
  shouldHoldSendForMaxEntitlement,
  shouldPaintMaxSurface,
  type EveMaxAuthorityState,
} from '@/common/config/eveMaxAuthorityCore';
import { useActiveSeatId } from '@renderer/hooks/useActiveSeatId';
import { isElectronDesktop } from '@renderer/utils/platform';
import { useCallback, useEffect, useState } from 'react';

export interface UseEveMaxAuthorityResult {
  /**
   * THE ONLY input a MAX visual may key on. True iff main says the wire tier is
   * `max` for THIS seat, at this revision. False for every untrustworthy state.
   */
  maxActive: boolean;
  /**
   * TRUE iff main reports the lane HELD for this seat: MAX intent, entitlement
   * still unverified, so main will send nothing on this selection.
   *
   * The surfaces owe this state two things — the neutral "entitlement is being
   * checked" copy, and a held send button. It is deliberately NOT the same
   * question as `!maxActive`: a proven-unentitled seat also has `maxActive:
   * false` and must keep sending on the routine lane.
   */
  entitlementPending: boolean;
  /** Raw state, for surfaces that want to distinguish loading from a negative. */
  state: EveMaxAuthorityState;
  /** Re-ask (e.g. after a seat switch or a purchase). */
  refresh: () => Promise<void>;
}

export function useEveMaxAuthority(): UseEveMaxAuthorityResult {
  const activeSeatId = useActiveSeatId();
  const [state, setState] = useState<EveMaxAuthorityState>({ status: 'loading' });
  // The CURRENT seat-context revision, read from main INDEPENDENTLY of the
  // decision receipt. `null` = not established → never paints.
  const [currentRevision, setCurrentRevision] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!isElectronDesktop()) {
      // No bridge: we cannot obtain the authority, so we must not paint.
      setState({ status: 'error' });
      return;
    }
    try {
      // TWO INDEPENDENT READS. The decision first, then the current seat context —
      // separately, and in that order, so the revision we compare against is read
      // AFTER the decision was made. A seat switch in between shows up as a
      // mismatch rather than being invisible.
      const response = await commandEve.inferenceLaneDecision.invoke();
      const receipt = response?.data;

      const seatContext = await commandEve.seatContext.invoke();
      const revision =
        seatContext?.success === true && typeof seatContext.data?.seatContextRevision === 'number'
          ? seatContext.data.seatContextRevision
          : null;
      setCurrentRevision(revision);

      if (response?.success !== true || !receipt) {
        setState({ status: 'error' });
        return;
      }
      setState({ status: 'ready', receipt });
    } catch {
      setCurrentRevision(null);
      setState({ status: 'error' });
    }
  }, []);

  // Re-ask whenever the active seat changes. The receipt is seat-bound, so a
  // transition invalidates the previous answer by construction — but re-asking
  // means the new seat gets its own decision rather than sitting unpainted.
  useEffect(() => {
    setState({ status: 'loading' });
    void refresh();
  }, [refresh, activeSeatId]);

  // RE-ASK AFTER INTENT IS DURABLY PERSISTED — `subscribePersisted`, not
  // `subscribe`, and the difference is the whole correctness of this effect.
  //
  // It is still the production event rather than a call wired into one
  // component: ANY surface that writes the selection — the composer's MAX
  // toggle, Settings → Modell — goes through configService, so subscribing here
  // covers all of them and cannot be bypassed by adding a third caller. Without
  // it the user toggles MAX, the next request genuinely goes out as MAX, and the
  // composer still says otherwise: the stale-surface bug relocated into the
  // refresh path.
  //
  // WHY THE PERSISTED CHANNEL. `subscribe` fires optimistically, BEFORE the
  // backend PUT is awaited. Refreshing from there re-asks MAIN — which answers
  // by reading the PERSISTED selection — while the old value is still what is
  // stored, so the composer could paint a decision for the value the user just
  // replaced. And a write that FAILS would still have signalled, painting a
  // state nothing is in. The persisted channel fires only after the PUT
  // resolves, and never at all when it rejects. No timer: the refresh waits on
  // the write, not on the clock.
  useEffect(() => {
    return configService.subscribePersisted('commandEve.inferenceSelection', () => {
      void refresh();
    });
  }, [refresh]);

  // A purchase or a lane switch changes the answer; window focus is the cheap,
  // already-established refresh trigger in this codebase.
  useEffect(() => {
    if (!isElectronDesktop()) return;
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return {
    // Validation lives in the shared pure core so main-side tests and
    // renderer-side tests cannot drift on what "trustworthy" means.
    maxActive: shouldPaintMaxSurface(state, activeSeatId, currentRevision),
    entitlementPending: shouldHoldSendForMaxEntitlement(state, activeSeatId, currentRevision),
    state,
    refresh,
  };
}

export default useEveMaxAuthority;
