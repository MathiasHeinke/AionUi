/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings → Freigaben. The one place a human sets what EVE may do unasked.
 *
 * Two blocks, deliberately not one: a ladder for the everyday decision, and the
 * sealed switches for the trust decisions. They never share a control, so nobody
 * who meant "just get on with it" also buys "and spend my money".
 *
 * All logic lives in eveAuthorityCore / eveAuthorityStoreCore. This file reads,
 * renders and writes — nothing here decides anything.
 */

import { configService } from '@/common/config/configService';
import {
  EVE_LADDER_RUNGS,
  EVE_SEALED_CAPABILITIES,
  type EveAuthorityGrant,
  type EveLadderRung,
  type EveSealedCapability,
} from '@/common/config/eveAuthorityCore';
import {
  classifyDailyBudget,
  grantNeedsAttention,
  isUnconfirmedGrant,
  resolveStoredGrant,
  withDailyBudget,
  withLadder,
  withSeal,
} from '@/common/config/eveAuthorityStoreCore';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import SettingsSection from '@/renderer/components/settings/SettingsSection';
import { InputNumber, Message, Radio, Switch, Tag } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const CENTS_PER_EUR = 100;

/** i18n keys per rung. Copy lives in commandEve.json so translators see them together. */
const RUNG_KEYS: Record<EveLadderRung, string> = {
  0: 'authority.rung.watch',
  1: 'authority.rung.ask',
  2: 'authority.rung.routine',
  3: 'authority.rung.work',
  4: 'authority.rung.independent',
  5: 'authority.rung.full',
};

const SEAL_KEYS: Record<EveSealedCapability, string> = {
  'spend.money': 'authority.seal.money',
  'publish.outward': 'authority.seal.publish',
  'delete.outside': 'authority.seal.delete',
  'credentials.read': 'authority.seal.credentials',
  'deploy.production': 'authority.seal.deploy',
};

const AuthorityModalContent: React.FC = () => {
  const { t } = useTranslation();
  const [grant, setGrant] = useState<EveAuthorityGrant | null>(null);
  const [budgetEur, setBudgetEur] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [stored, legacy] = await Promise.all([
        configService.get('commandEve.authority'),
        configService.get('acp.config'),
      ]);
      if (cancelled) return;
      const resolved = resolveStoredGrant(stored, legacy);
      setGrant(resolved);
      const cents = resolved.limits?.['spend.money']?.dailyCents;
      setBudgetEur(typeof cents === 'number' ? cents / CENTS_PER_EUR : undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: EveAuthorityGrant) => {
    setGrant(next);
    await configService.set('commandEve.authority', next);
  }, []);

  const attention = useMemo(() => (grant ? grantNeedsAttention(grant) : null), [grant]);

  if (!grant) return null;

  const onLadder = (value: EveLadderRung): void => {
    void persist(withLadder(grant, value));
  };

  const onSeal = (capability: EveSealedCapability, open: boolean) => {
    const next = withSeal(grant, capability, open, new Date().toISOString());
    if (capability === 'spend.money' && !open) setBudgetEur(undefined);
    void persist(next);
  };

  const onBudget = (value: number | undefined) => {
    setBudgetEur(value);
    if (value === undefined) return;
    const cents = Math.round(value * CENTS_PER_EUR);
    const verdict = classifyDailyBudget(cents);
    if (verdict === 'invalid') return;
    if (verdict === 'confirm') {
      // Not refused — just not waved through. A four-figure daily ceiling is
      // allowed to be deliberate; it is not allowed to be a slip of the keyboard.
      Message.warning(t('commandEve:authority.budgetHigh'));
    }
    void persist(withDailyBudget(grant, cents));
  };

  return (
    <AionScrollArea>
      <div className='flex flex-col gap-24px pb-24px'>
        {isUnconfirmedGrant(grant) && (
          <div className='rd-8px bg-orange-1 p-12px text-14px'>{t('commandEve:authority.notConfirmedYet')}</div>
        )}

        <SettingsSection
          title={t('commandEve:authority.ladderTitle')}
          description={t('commandEve:authority.ladderDescription')}
        >
          <Radio.Group direction='vertical' value={grant.ladder} onChange={onLadder} className='flex flex-col gap-12px'>
            {EVE_LADDER_RUNGS.map((rung) => (
              <Radio key={rung} value={rung}>
                <span className='font-medium'>{t(`commandEve:${RUNG_KEYS[rung]}.title`)}</span>
                <div className='text-13px op-70'>{t(`commandEve:${RUNG_KEYS[rung]}.body`)}</div>
              </Radio>
            ))}
          </Radio.Group>
        </SettingsSection>

        <SettingsSection
          title={t('commandEve:authority.sealsTitle')}
          description={t('commandEve:authority.sealsDescription')}
        >
          <div className='flex flex-col gap-16px'>
            {EVE_SEALED_CAPABILITIES.map((capability) => {
              const open = grant.capabilities[capability] === true;
              const grantedAt = grant.grantedAt?.[capability];
              return (
                <div key={capability} className='flex flex-col gap-8px'>
                  <div className='flex items-start justify-between gap-16px'>
                    <div>
                      <div className='font-medium'>{t(`commandEve:${SEAL_KEYS[capability]}.title`)}</div>
                      <div className='text-13px op-70'>{t(`commandEve:${SEAL_KEYS[capability]}.body`)}</div>
                      {open && grantedAt && (
                        <div className='text-12px op-60 mt-4px'>
                          {t('commandEve:authority.grantedAt', {
                            date: new Date(grantedAt).toLocaleDateString(),
                          })}
                        </div>
                      )}
                    </div>
                    <Switch checked={open} onChange={(checked) => onSeal(capability, checked)} />
                  </div>

                  {capability === 'spend.money' && open && (
                    <div className='flex items-center gap-8px pl-4px'>
                      <span className='text-13px'>{t('commandEve:authority.dailyBudget')}</span>
                      <InputNumber
                        value={budgetEur}
                        onChange={onBudget}
                        min={0.01}
                        step={1}
                        precision={2}
                        suffix='€'
                        style={{ width: 140 }}
                      />
                      {attention === 'money-without-budget' && (
                        <Tag color='red'>{t('commandEve:authority.budgetMissing')}</Tag>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SettingsSection>
      </div>
    </AionScrollArea>
  );
};

export default AuthorityModalContent;
