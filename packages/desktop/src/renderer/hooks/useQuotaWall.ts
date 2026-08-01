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
import { detectDailyCapReached, detectQuotaExhausted, type QuotaExhaustedBody } from '@/common/config/creditsCore';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';

export interface QuotaWallState {
  /** The parsed 402 body, or null when no quota signal is active. */
  body: QuotaExhaustedBody | null;
  /** Whether a job was in-flight when the quota signal arrived (drives suppression). */
  jobInFlight: boolean;
  /** The persisted auto-reload preference (passed to the wall toggle). */
  autoReload: boolean;
  /**
   * True when the fair-use DAILY CAP was hit (429 → 'eve_daily_cap'). It is an
   * abuse ceiling, not a free allowance — the server's own note on the counter
   * says "every turn it lets through is still metered".
   * Distinct from `body` (402 credits): the cap rolls over on its own, and buying
   * credits does not lift it, so its wall never sells anything. Surfaces only when in-flight.
   */
  dailyCapReached: boolean;
  /**
   * Feed a caught inference error. If it is a 402 quota_exhausted, the wall body
   * is set; else if it is the fair-use daily cap, the warm cap wall is set;
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
  // The shim rewrites EVERY upstream 429 into the `eve_daily_cap` signal — it is
  // tier-blind by design (it cannot see the server entitlement). So the WALL must
  // only surface for a seat whose tank is genuinely empty; a seat with credits
  // that hits a transient provider 429 must fall through to the normal error path
  // rather than be told its day is over.
  //
  // `meter.isFree` IS that test, and is what `showsFreeActionMeter` computed: the
  // model sets it only for a free-tier seat with NO credit balance
  // (`effectiveTier === 'free' && !hasCreditTank`), so the deleted predicate was
  // this flag with extra steps. Same seats, same behaviour, no free-lane
  // vocabulary — there is no free daily quota for the wall to be about.
  const { meter } = useCreditsStatus();
  const emptyTank = meter ? meter.isFree : false;

  const reportInferenceError = useCallback(
    (error: unknown, opts: { jobInFlight: boolean }): boolean => {
      // 402 credits-exhaust wins (it is the money path); only if it is NOT that do
      // we check the fair-use daily cap.
      const parsed = detectQuotaExhausted(error);
      if (parsed) {
        setBody(parsed);
        setJobInFlight(opts.jobInFlight);
        return true;
      }
      // Only honor the daily cap for a seat with nothing left in the tank. For a
      // funded / unknown seat a rewritten `eve_daily_cap` 429 is a transient
      // throttle — let it fall through to normal error handling (bubble / retry).
      if (emptyTank && detectDailyCapReached(error)) {
        setDailyCapReached(true);
        setJobInFlight(opts.jobInFlight);
        return true;
      }
      return false;
    },
    [emptyTank]
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
