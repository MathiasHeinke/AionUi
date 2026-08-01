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
 * `maxActive` from `resolveEffectiveWireTierFromSelection` locally, in parallel
 * with main. Two authorities can disagree, and when they do the composer paints a
 * state the wire is not in — the surface-honesty defect, reintroduced one level
 * up. The local derivation is DELETED, not flagged: a fallback is a second answer.
 *
 * FAIL VISUALLY CLOSED. Loading, error, a receipt for another seat, a stale
 * revision, or a malformed payload all resolve to "do not paint". Painting MAX is
 * the claim that needs proof.
 */

import { commandEve } from '@/common/adapter/ipcBridge';
import { shouldPaintMaxSurface, type EveMaxAuthorityState } from '@/common/config/eveMaxAuthorityCore';
import { useActiveSeatId } from '@renderer/hooks/useActiveSeatId';
import { isElectronDesktop } from '@renderer/utils/platform';
import { useCallback, useEffect, useState } from 'react';

export interface UseEveMaxAuthorityResult {
  /**
   * THE ONLY input a MAX visual may key on. True iff main says the wire tier is
   * `max` for THIS seat, at this revision. False for every untrustworthy state.
   */
  maxActive: boolean;
  /** Raw state, for surfaces that want to distinguish loading from a negative. */
  state: EveMaxAuthorityState;
  /** Re-ask (e.g. after a seat switch or a purchase). */
  refresh: () => Promise<void>;
}

export function useEveMaxAuthority(): UseEveMaxAuthorityResult {
  const activeSeatId = useActiveSeatId();
  const [state, setState] = useState<EveMaxAuthorityState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    if (!isElectronDesktop()) {
      // No bridge: we cannot obtain the authority, so we must not paint.
      setState({ status: 'error' });
      return;
    }
    try {
      const response = await commandEve.inferenceLaneDecision.invoke();
      const receipt = response?.data;
      if (response?.success !== true || !receipt) {
        setState({ status: 'error' });
        return;
      }
      setState({ status: 'ready', receipt });
    } catch {
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
    maxActive: shouldPaintMaxSurface(state, activeSeatId),
    state,
    refresh,
  };
}

export default useEveMaxAuthority;
