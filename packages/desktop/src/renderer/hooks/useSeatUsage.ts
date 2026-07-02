/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useSeatUsage (v1.5 A3) — reads per-seat usage attribution from the main process
 * (`command-eve.seat-usage` bridge) for a given month.
 *
 * This is a REPORT, not a live meter: it loads on-mount and on demand
 * (`refresh()` / a month change), with NO continuous poll (contrast
 * useCreditsStatus). The truth is always the main process (which holds the CEVE
 * bearer and calls the seat-usage Edge Function). This hook never joins labels —
 * it returns the OPAQUE rows; the billing card joins `seat_id → access.seats[]`
 * from the my-seats wire (H3: the server never sends names).
 *
 * VERSION-SKEW SAFE: a not-yet-deployed seat-usage function makes the bridge
 * self-quiet (`ok:false`, empty seats). The hook surfaces `available:false` so
 * the card shows the honest "ab dem nächsten Server-Update" resting state. In
 * non-desktop (WebUI) builds there is no bridge ⇒ available:false, empty.
 */

import { useCallback, useEffect, useState } from 'react';
import { commandEve, type ICommandEveSeatUsageResult } from '@/common/adapter/ipcBridge';
import { isElectronDesktop } from '@renderer/utils/platform';
import { currentUsageMonth } from '@/common/config/seatUsageCore';

export interface SeatUsageState {
  /** True until the first read for the current month resolves. */
  loading: boolean;
  /** The queried month `YYYY-MM`. */
  month: string;
  /** Latest seat-usage result, or null before the first read / non-desktop. */
  usage: ICommandEveSeatUsageResult | null;
  /**
   * True when the server returned real data (`ok:true`). False on version-skew
   * (function not deployed) / no bearer / non-desktop — the card then shows the
   * honest resting state.
   */
  available: boolean;
  /** Switch the queried month (current ↔ prior) and re-read. */
  setMonth: (month: string) => void;
  /** Re-read the current month now. */
  refresh: () => Promise<void>;
}

export function useSeatUsage(initialMonth: string = currentUsageMonth()): SeatUsageState {
  const [loading, setLoading] = useState(true);
  const [month, setMonthState] = useState(initialMonth);
  const [usage, setUsage] = useState<ICommandEveSeatUsageResult | null>(null);

  const load = useCallback(async (targetMonth: string) => {
    if (!isElectronDesktop()) {
      setUsage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await commandEve.seatUsage.invoke({ month: targetMonth });
      setUsage(response?.data ?? null);
    } catch (error) {
      // A read failure must NOT crash the chrome: the card goes to its honest
      // resting state (available:false) instead of throwing.
      console.error('Seat usage bridge call failed:', error);
      setUsage(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await load(month);
  }, [load, month]);

  const setMonth = useCallback((next: string) => {
    setMonthState(next);
  }, []);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  return {
    loading,
    month,
    usage,
    available: usage?.ok === true,
    setMonth,
    refresh,
  };
}
