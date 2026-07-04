/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { useSettingsModal } from '@/renderer/components/settings/SettingsModal/useSettingsModal';
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
 * AcpRuntimeStatus so it survives in PRODUCTION even though the runtime log strip is
 * now founder/dev-only.
 *
 * It surfaces ONLY a REAL action EVE took on outbound text (it redacted or blocked a
 * detected secret before model egress). We deliberately DO NOT render an "all clear"
 * line — that would assert a guarantee we can't prove (founder 2026-06-26). It is a
 * security/compliance signal for ALL users (operators + founders), gated ONLY by the
 * operator off-switch `commandEve.egressStatusVisible`, NEVER by dev mode.
 */
const EgressBoundaryNotice: React.FC<{ active?: boolean }> = ({ active = false }) => {
  const { t } = useTranslation();
  const { openSettings, settingsModal } = useSettingsModal();
  const [egressVisibleSetting] = useConfig('commandEve.egressStatusVisible');
  const egressVisible = egressVisibleSetting ?? true;
  // S11 — PER-SEAT PII/DSGVO switch. When the operator turned the filter OFF for
  // this seat, a DSGVO control-waiver is in effect and must NEVER be invisible: we
  // show a persistent "PII-Schutz aus" badge for as long as it is off (absent ⇒ on).
  const [egressRedactionMode] = useConfig('commandEve.egressRedactionMode');
  const redactionDisabled = egressRedactionMode === 'off';
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
    const timer = window.setInterval(refresh, active ? 2500 : 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [egressVisible, active]);

  // The persistent "Datenschutz aus" hint must stay VISIBLE while the filter is off
  // (a DSGVO control-waiver is never invisible), but it must be UNOBTRUSIVE — a small,
  // muted footnote, NOT a prominent red banner (founder 2026-07-04). One click opens
  // the privacy settings to turn it back on.
  const offBadge = redactionDisabled ? (
    <button
      type='button'
      onClick={() => openSettings('system')}
      title={t('conversation.runtimeStatus.egress.disabledHint', {
        defaultValue: 'Datenschutz-Filter ist aus — hier klicken, um ihn in den Einstellungen wieder anzuschalten.',
      })}
      className='mb-4px inline-flex items-center gap-4px border-none bg-transparent px-0 text-11px text-t-tertiary opacity-60 hover:opacity-100 hover:underline cursor-pointer'
    >
      <Shield theme='outline' size='11' />
      <span>{t('conversation.runtimeStatus.egress.disabledFootnote', { defaultValue: '* Datenschutz aus' })}</span>
    </button>
  ) : null;

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

  if (!offBadge && !actionStrip) return null;

  return (
    <>
      {offBadge}
      {actionStrip}
      {/* Mounted so the unobtrusive "Datenschutz aus" footnote can open the privacy
          settings directly (system tab) — self-contained, no global settings owner. */}
      {offBadge ? settingsModal : null}
    </>
  );
};

export default EgressBoundaryNotice;
