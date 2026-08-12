/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EveAuthorityGrant } from '@/common/config/eveAuthorityCore';
import {
  EVE_EXTERNAL_ACTION_KINDS,
  failClosedEveExternalActionPolicyView,
  type EveExternalActionKind,
  type EveExternalActionPolicyView,
} from '@/common/config/eveExternalActionPolicyCore';
import PreferenceRow from '@/renderer/components/settings/PreferenceRow';
import SettingsSection from '@/renderer/components/settings/SettingsSection';
import { Button, InputNumber, Switch } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const EXPIRY_HOURS = [1, 24, 24 * 7, 24 * 30] as const;

interface ExternalActionPolicySectionProps {
  activeSeatId: string;
  authorityGrant: EveAuthorityGrant;
}

function minorToEuros(minorUnits: number): number {
  return Math.round(minorUnits) / 100;
}

function eurosToMinor(eurosValue: number | undefined): number {
  return typeof eurosValue === 'number' && Number.isFinite(eurosValue) && eurosValue >= 0
    ? Math.round(eurosValue * 100)
    : 0;
}

const ExternalActionPolicySection: React.FC<ExternalActionPolicySectionProps> = ({ activeSeatId, authorityGrant }) => {
  const { t } = useTranslation();
  const generation = useRef(0);
  const [policy, setPolicy] = useState<EveExternalActionPolicyView>(() => failClosedEveExternalActionPolicyView());
  const [perAction, setPerAction] = useState<number | undefined>(0);
  const [daily, setDaily] = useState<number | undefined>(0);
  const [monthly, setMonthly] = useState<number | undefined>(0);
  const [origins, setOrigins] = useState('');
  const [actions, setActions] = useState<EveExternalActionKind[]>([]);
  const [expiryHours, setExpiryHours] = useState<number>(24);
  const [contextToken, setContextToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasonCode, setReasonCode] = useState<string | null>(null);

  const applyPolicy = useCallback((next: EveExternalActionPolicyView) => {
    setPolicy(next);
    setPerAction(minorToEuros(next.perActionLimitMinor));
    setDaily(minorToEuros(next.dailyLimitMinor));
    setMonthly(minorToEuros(next.monthlyLimitMinor));
    setOrigins(next.allowedOrigins.join('\n'));
    setActions([...next.allowedActionKinds]);
  }, []);

  const refresh = useCallback(async () => {
    const run = ++generation.current;
    const seatAtStart = activeSeatId;
    try {
      const { commandEve } = await import('@/common/adapter/ipcBridge');
      const response = await commandEve.externalActionPolicyGet.invoke();
      if (run !== generation.current || seatAtStart !== activeSeatId) return;
      const data = response?.data;
      if (!data?.policy || typeof data.context_token !== 'string') throw new Error('EXTERNAL_POLICY_READ_FAILED');
      applyPolicy(data.policy);
      setContextToken(data.context_token);
      setReasonCode(data.reason_code ?? null);
    } catch {
      if (run !== generation.current || seatAtStart !== activeSeatId) return;
      applyPolicy(failClosedEveExternalActionPolicyView('EXTERNAL_POLICY_READ_FAILED'));
      setContextToken(null);
      setReasonCode('EXTERNAL_POLICY_READ_FAILED');
    }
  }, [activeSeatId, applyPolicy]);

  useEffect(() => {
    applyPolicy(failClosedEveExternalActionPolicyView());
    setContextToken(null);
    setReasonCode(null);
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [activeSeatId, applyPolicy, refresh]);

  const invokeMutation = useCallback(
    async (operation: 'save' | 'kill' | 'revoke', enabled?: boolean) => {
      const run = ++generation.current;
      const seatAtStart = activeSeatId;
      setBusy(true);
      setReasonCode(null);
      try {
        if (!contextToken) throw new Error('EXTERNAL_POLICY_CONTEXT_STALE');
        const { commandEve } = await import('@/common/adapter/ipcBridge');
        const response =
          operation === 'save'
            ? await commandEve.externalActionPolicySet.invoke({
                context_token: contextToken,
                mutation: {
                  currency: 'EUR',
                  perActionLimitMinor: eurosToMinor(perAction),
                  dailyLimitMinor: eurosToMinor(daily),
                  monthlyLimitMinor: eurosToMinor(monthly),
                  allowedOrigins: origins
                    .split(/\r?\n/)
                    .map((entry) => entry.trim())
                    .filter(Boolean),
                  allowedActionKinds: actions,
                  expiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString(),
                },
              })
            : operation === 'kill'
              ? await commandEve.externalActionPolicyKill.invoke({
                  context_token: contextToken,
                  enabled: enabled === true,
                })
              : await commandEve.externalActionPolicyRevoke.invoke({ context_token: contextToken });
        if (run !== generation.current || seatAtStart !== activeSeatId) return;
        const data = response?.data;
        if (!data?.policy || typeof data.context_token !== 'string') throw new Error('EXTERNAL_POLICY_WRITE_FAILED');
        applyPolicy(data.policy);
        setContextToken(data.context_token);
        setReasonCode(data.reason_code ?? null);
      } catch {
        if (run === generation.current && seatAtStart === activeSeatId) setReasonCode('EXTERNAL_POLICY_WRITE_FAILED');
      } finally {
        if (run === generation.current && seatAtStart === activeSeatId) setBusy(false);
      }
    },
    [activeSeatId, actions, applyPolicy, contextToken, daily, expiryHours, monthly, origins, perAction]
  );

  const toggleAction = (kind: EveExternalActionKind): void => {
    setActions((current) =>
      current.includes(kind) ? current.filter((candidate) => candidate !== kind) : [...current, kind]
    );
  };

  return (
    <SettingsSection
      title={t('commandEve.authority.externalPolicy.title')}
      description={t('commandEve.authority.externalPolicy.description', { rung: authorityGrant.ladder })}
      testId='external-action-policy-section'
    >
      <div className='flex flex-col gap-14px' data-testid='external-action-policy-content'>
        <div className='eve-settings-notice text-13px' data-testid='external-action-policy-native-note'>
          {t('commandEve.authority.externalPolicy.nativeNote')}
        </div>

        <div className='grid grid-cols-1 gap-10px sm:grid-cols-3'>
          <PreferenceRow label={t('commandEve.authority.externalPolicy.perAction')} stackOnMobile>
            <InputNumber
              min={0}
              precision={2}
              value={perAction}
              onChange={setPerAction}
              data-testid='external-policy-per-action'
            />
          </PreferenceRow>
          <PreferenceRow label={t('commandEve.authority.externalPolicy.daily')} stackOnMobile>
            <InputNumber min={0} precision={2} value={daily} onChange={setDaily} data-testid='external-policy-daily' />
          </PreferenceRow>
          <PreferenceRow label={t('commandEve.authority.externalPolicy.monthly')} stackOnMobile>
            <InputNumber
              min={0}
              precision={2}
              value={monthly}
              onChange={setMonthly}
              data-testid='external-policy-monthly'
            />
          </PreferenceRow>
        </div>

        <label className='flex flex-col gap-6px text-13px'>
          <span>{t('commandEve.authority.externalPolicy.origins')}</span>
          <textarea
            className='arco-textarea min-h-88px w-full'
            value={origins}
            placeholder='https://shop.example'
            onChange={(event) => setOrigins(event.target.value)}
            data-testid='external-policy-origins'
          />
        </label>

        <fieldset className='flex flex-col gap-6px' data-testid='external-policy-actions'>
          <legend className='text-13px'>{t('commandEve.authority.externalPolicy.actions')}</legend>
          <div className='grid grid-cols-1 gap-6px sm:grid-cols-2'>
            {EVE_EXTERNAL_ACTION_KINDS.map((kind) => (
              <label key={kind} className='flex items-center gap-8px text-13px'>
                <input
                  type='checkbox'
                  checked={actions.includes(kind)}
                  onChange={() => toggleAction(kind)}
                  data-testid={`external-policy-action-${kind}`}
                />
                {t(`commandEve.authority.externalPolicy.action.${kind}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <label className='flex items-center gap-10px text-13px'>
          <span>{t('commandEve.authority.externalPolicy.expiry')}</span>
          <select
            value={expiryHours}
            onChange={(event) => setExpiryHours(Number(event.target.value))}
            data-testid='external-policy-expiry'
          >
            {EXPIRY_HOURS.map((hours) => (
              <option key={hours} value={hours}>
                {t(`commandEve.authority.externalPolicy.expiryHours.${hours}`)}
              </option>
            ))}
          </select>
        </label>

        <div className='flex flex-wrap items-center gap-8px'>
          <Button
            type='primary'
            disabled={busy || !contextToken || actions.length === 0}
            onClick={() => void invokeMutation('save')}
            data-testid='external-policy-save'
          >
            {t('commandEve.authority.externalPolicy.save')}
          </Button>
          <PreferenceRow label={t('commandEve.authority.externalPolicy.kill')}>
            <Switch
              checked={policy.killSwitch}
              disabled={busy || !contextToken || !policy.configured || policy.revoked}
              onChange={(enabled) => void invokeMutation('kill', enabled)}
              data-testid='external-policy-kill'
            />
          </PreferenceRow>
          <Button
            status='danger'
            disabled={busy || !contextToken || !policy.configured || policy.revoked}
            onClick={() => void invokeMutation('revoke')}
            data-testid='external-policy-revoke'
          >
            {t('commandEve.authority.externalPolicy.revoke')}
          </Button>
        </div>

        <div className='text-12px text-[var(--eve-shell-text-secondary)]' data-testid='external-policy-status'>
          {policy.configured
            ? t('commandEve.authority.externalPolicy.status', {
                revision: policy.revision,
                expiry: policy.expiresAt ?? '—',
              })
            : t('commandEve.authority.externalPolicy.notConfigured')}
          {reasonCode ? ` · ${reasonCode}` : ''}
        </div>
      </div>
    </SettingsSection>
  );
};

export default ExternalActionPolicySection;
