/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { Shield } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type EgressBoundaryStatus = {
  decision?: string;
  observed_at?: string;
  finding_count?: number;
  policy_action?: string;
  receipt_path?: string;
};

/**
 * EgressBoundaryNotice — the DSGVO data-boundary signal, extracted out of
 * AcpRuntimeStatus; both surfaces remain independently gated and this notice is
 * never replaced by the redacted runtime lifecycle line.
 *
 * It surfaces ONLY a REAL action EVE took on outbound text (it redacted or blocked a
 * detected secret before model egress). We deliberately DO NOT render an "all clear"
 * line — that would assert a guarantee we can't prove (founder 2026-06-26). It is a
 * security/compliance signal for ALL users (operators + founders), gated ONLY by the
 * operator off-switch `commandEve.egressStatusVisible`, NEVER by dev mode.
 */
const EgressBoundaryNotice: React.FC<{ active?: boolean }> = ({ active = false }) => {
  const { t } = useTranslation();
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

  const egressDecision = egressBoundary?.decision;
  const egressLabel =
    egressDecision === 'block'
      ? t('conversation.runtimeStatus.egress.blocked', { count: egressBoundary?.finding_count ?? 0 })
      : egressDecision === 'redact'
        ? t('conversation.runtimeStatus.egress.redacted', { count: egressBoundary?.finding_count ?? 0 })
        : null;

  // Only the ACTION strip is gated by the display toggle; the off-badge is not.
  const actionStrip =
    egressVisible && egressLabel ? (
      <div
        className={`mb-8px flex items-center gap-6px px-12px py-6px rd-12px border border-solid border-border-2 bg-fill-1 text-12px ${
          egressDecision === 'block' ? 'text-danger-6' : 'text-warning-6'
        }`}
      >
        <Shield theme='outline' size='13' />
        <span>{egressLabel}</span>
        {egressBoundary?.observed_at ? (
          <span className='text-t-tertiary'>
            {new Date(egressBoundary.observed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : null}
      </div>
    ) : null;

  if (!actionStrip) return null;

  return <>{actionStrip}</>;
};

export default EgressBoundaryNotice;
