/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import React, { useEffect, useState } from 'react';

export type EgressBoundaryStatus = {
  decision?: string;
  observed_at?: string;
  finding_count?: number;
  policy_action?: string;
  receipt_path?: string;
};

/**
 * Poll the real egress receipt without creating another chat surface. The compact,
 * operator-safe receipt is rendered by AcpRuntimeStatus in the existing footer row.
 * Raw values and receipt paths never enter the DOM.
 */
export const useEgressBoundaryStatus = (active = false): EgressBoundaryStatus | null => {
  const [egressVisibleSetting] = useConfig('commandEve.egressStatusVisible');
  const egressVisible = egressVisibleSetting ?? true;
  // NOTE: the persistent "Datenschutz aus" control-waiver indicator moved to the
  // top-right chat-window toggle (EgressRedactionTogglePill, founder 2026-07-05).
  // This component now only surfaces the TRANSIENT redact/block ACTION strip.
  const [egressBoundary, setEgressBoundary] = useState<EgressBoundaryStatus | null>(null);

  useEffect(() => {
    if (!egressVisible) return;
    let cancelled = false;
    const refresh = () => {
      void ipcBridge.commandEve.runtimeStatus
        .invoke()
        .then((response) => {
          if (cancelled || !response.success) return;
          setEgressBoundary(response.data?.egress_boundary ?? null);
        })
        .catch(() => {});
    };
    refresh();
    // Poll faster while a turn is in flight (egress actions happen during generation).
    // Perf (8GB audit): gate the tick on window visibility so a backgrounded window
    // stops the 2.5–10s IPC heartbeat (which otherwise keeps main + aioncore awake and
    // defeats macOS App Nap). Catch up with one immediate refresh when it returns to
    // the foreground so a redact/block that happened while hidden shows promptly.
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      refresh();
    };
    const timer = window.setInterval(tick, active ? 2500 : 10000);
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') refresh();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [egressVisible, active]);

  return egressVisible ? egressBoundary : null;
};
