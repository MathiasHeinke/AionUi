/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 402 quota-exhausted wall controller (Lane 3, spec §3).
 *
 * The single seam between the inference error path and the wall UI: a send /
 * stream site calls `reportInferenceError(error, { jobInFlight })` whenever an
 * EVE-inference call rejects. This hook runs the PURE
 * `creditsCore.detectQuotaExhausted` (recovers the structured 402 body) and the
 * PURE idle-suppression (`shouldSurfaceQuotaWall`, applied in the wall
 * component) and exposes the parsed body + in-flight flag for
 * <QuotaExhaustedWall/>.
 *
 * Keeping this as a tiny hook means the existing send/permission/EVE-inference
 * flow stays intact — a caller adds exactly one `.catch(err => reportInferenceError(err, ...))`.
 */

import { useCallback, useState } from 'react';
import { detectDailyCapReached, detectQuotaExhausted, showsFreeActionMeter, type QuotaExhaustedBody } from '@/common/config/creditsCore';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';

export interface QuotaWallState {
  /** The parsed 402 body, or null when no quota signal is active. */
  body: QuotaExhaustedBody | null;
  /** Whether a job was in-flight when the quota signal arrived (drives suppression). */
  jobInFlight: boolean;
  /** The persisted auto-reload preference (passed to the wall toggle). */
  autoReload: boolean;
  /**
   * True when the FREE daily allowance was just spent (429 → 'eve_daily_cap').
   * Distinct from `body` (402 credits): the free cap resets tomorrow, so its
   * wall never sells anything — it just reassures. Surfaces only when in-flight.
   */
  dailyCapReached: boolean;
  /**
   * Feed a caught inference error. If it is a 402 quota_exhausted, the wall body
   * is set; else if it is the free daily cap, the warm cap wall is set;
   * otherwise it is a no-op so non-quota errors fall through. Returns true iff a
   * quota/cap signal was recognized (so the caller can suppress its own toast).
   */
  reportInferenceError: (error: unknown, opts: { jobInFlight: boolean }) => boolean;
  /** Dismiss the wall (both the 402 and the daily-cap variant). */
  closeWall: () => void;
  /** Persist the auto-reload toggle. */
  setAutoReload: (enabled: boolean) => void;
}

export function useQuotaWall(): QuotaWallState {
  const [body, setBody] = useState<QuotaExhaustedBody | null>(null);
  const [jobInFlight, setJobInFlight] = useState(false);
  const [dailyCapReached, setDailyCapReached] = useState(false);
  const [autoReload, setAutoReloadState] = useState<boolean>(false);
  // The shim rewrites EVERY upstream 429 into the free-tier `eve_daily_cap`
  // signal — tier-blind by design (it cannot see the server entitlement). So the
  // free-cap WALL must only surface for a CONFIRMED free user; a paid user who
  // hits a transient provider 429 must fall through to the normal error path,
  // never a "your free daily quota is spent, come back tomorrow" modal.
  // 1.6.2: "confirmed free" means the CREDIT-LESS free seat (showsFreeActionMeter),
  // not tier==='free' — a free seat holding a purchased balance renders the tank
  // on every meter surface and consumes credits server-side, so a 429 reaching it
  // is a transient throttle, not the daily cap.
  const { meter } = useCreditsStatus();
  const isFree = meter ? showsFreeActionMeter(meter) : false;

  const reportInferenceError = useCallback(
    (error: unknown, opts: { jobInFlight: boolean }): boolean => {
      // 402 credits-exhaust wins (it is the paid path); only if it is NOT that do
      // we check the free daily cap.
      const parsed = detectQuotaExhausted(error);
      if (parsed) {
        setBody(parsed);
        setJobInFlight(opts.jobInFlight);
        return true;
      }
      // Only honor the free daily-cap for a confirmed free user. For a paid /
      // unknown tier, a rewritten `eve_daily_cap` 429 is a transient throttle —
      // let it fall through to the normal error handling (cold bubble / retry).
      if (isFree && detectDailyCapReached(error)) {
        setDailyCapReached(true);
        setJobInFlight(opts.jobInFlight);
        return true;
      }
      return false;
    },
    [isFree]
  );

  const closeWall = useCallback(() => {
    setBody(null);
    setDailyCapReached(false);
    setJobInFlight(false);
  }, []);

  const setAutoReload = useCallback((enabled: boolean) => {
    // Records the user's auto-reload intent for the wall toggle. The actual
    // auto-reload execution is the backend's (Lane-2 webhook on the saved card);
    // the desktop only carries the intent into the checkout it opens.
    setAutoReloadState(enabled);
  }, []);

  return { body, jobInFlight, dailyCapReached, autoReload, reportInferenceError, closeWall, setAutoReload };
}
