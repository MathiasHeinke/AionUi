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
  EVE_SEALED_CAPABILITIES,
  type EveAuthorityGrant,
  type EveLadderRung,
  type EveSealedCapability,
} from '@/common/config/eveAuthorityCore';
import { readRememberedCommands } from '@/common/config/eveRememberedCommandsCore';
import {
  classifyDailyBudget,
  ENFORCED_LADDER_RUNGS,
  grantNeedsAttention,
  isUnconfirmedGrant,
  resolveStoredGrant,
  withDailyBudget,
  withLadder,
  withoutRememberedCommand,
  withSeal,
} from '@/common/config/eveAuthorityStoreCore';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import SettingsSection from '@/renderer/components/settings/SettingsSection';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { Button, InputNumber, Radio, Switch } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** i18n keys per rung. Copy lives in commandEve.json so translators see them together. */
const RUNG_KEYS: Record<EveLadderRung, string> = {
  0: 'authority.rung.watch',
  1: 'authority.rung.ask',
  2: 'authority.rung.routine',
  3: 'authority.rung.work',
  4: 'authority.rung.independent',
  5: 'authority.rung.full',
};

/** i18n keys per seal. Same arrangement as the rungs, for the same reason. */
const SEAL_KEYS: Record<EveSealedCapability, string> = {
  'spend.money': 'authority.seal.money',
  'publish.outward': 'authority.seal.publish',
  'delete.outside': 'authority.seal.delete',
  'credentials.read': 'authority.seal.credentials',
  'deploy.production': 'authority.seal.deploy',
};

const AuthorityModalContent: React.FC = () => {
  const { t } = useTranslation();

  // Read the grant REACTIVELY, not once on mount.
  //
  // `commandEve.authority` is seat-scoped, and `rebindSeat` re-notifies every
  // seat-scoped key whose value differs under the new seat. A one-shot
  // `configService.get` in a mount effect does not hear that: switching seats
  // with this page open left the PREVIOUS seat's ladder on screen until the
  // page was remounted — in both directions, so it could show "Fragen" while
  // the active seat was actually at "Arbeiten". On the page whose whole job is
  // to state what EVE may do unasked, that is the page lying about the seat you
  // are in. Verified in the packaged 1.820.0 app, not deduced.
  //
  // `useDayZeroOnboarding` already carries this exact lesson for
  // `commandEve.clientSeedDismissed`; this is the same fix on the same
  // mechanism.
  const [storedGrant] = useConfig('commandEve.authority');
  const [legacyAcpConfig] = useConfig('acp.config');

  // useConfig's first snapshot is a synchronous read that can land BEFORE the
  // config cache has finished loading, and `initialize()` does not notify per
  // key. Render nothing until it is ready rather than briefly showing a default
  // nobody chose — a flash of the wrong rung is the same defect in miniature.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void configService.whenReady().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const grant = useMemo(() => resolveStoredGrant(storedGrant, legacyAcpConfig), [storedGrant, legacyAcpConfig]);

  const persist = useCallback(async (next: EveAuthorityGrant) => {
    // No local mirror of the value: the write notifies, `useConfig` re-reads.
    // The seat-scoped grant IS the record, and it is the only thing written.
    //
    // This used to also mirror the choice into `acp.config[hermes].preferredMode`
    // so the session-opening path — which read that key raw — would see it. But
    // `acp.config` is install-global while the grant is per seat, so the mirror
    // carried one seat's decision into every seat that had never made one (P1,
    // Kimi). The session paths now read the grant through `getModePreference`,
    // which is what makes dropping the mirror safe rather than inert.
    await configService.set('commandEve.authority', next);
  }, []);

  const remembered = useMemo(() => readRememberedCommands(grant.rememberedCommands), [grant]);

  // `grant` is always resolved (resolveStoredGrant falls back closed); what we
  // wait for is the config cache, not the value.
  if (!ready) return null;

  const onLadder = (value: EveLadderRung): void => {
    void persist(withLadder(grant, value));
  };

  const onForget = (command: string): void => {
    void persist(withoutRememberedCommand(grant, command));
  };

  const onSeal = (capability: EveSealedCapability, open: boolean): void => {
    void persist(withSeal(grant, capability, open, new Date().toISOString()));
  };

  const onBudget = (value: number | undefined): void => {
    // A rejected amount leaves the grant alone (`withDailyBudget`), so a
    // half-typed number never becomes a ceiling nobody agreed to.
    if (typeof value !== 'number') return;
    void persist(withDailyBudget(grant, Math.round(value * 100)));
  };

  const dailyCents = grant.limits?.['spend.money']?.dailyCents;
  const moneyOpen = grant.capabilities['spend.money'] === true;

  return (
    <AionScrollArea>
      <div className='flex flex-col gap-24px pb-24px'>
        {isUnconfirmedGrant(grant) && (
          <div className='rd-8px bg-orange-1 p-12px text-14px'>{t('commandEve.authority.notConfirmedYet')}</div>
        )}

        <SettingsSection
          title={t('commandEve.authority.ladderTitle')}
          description={t('commandEve.authority.ladderDescription')}
        >
          {/*
            All six rungs render now, because all six bind. The old guard here
            existed for a real reason — a stored rung 4 inherited from a legacy
            `yolo` value had no option to sit on, and showing it would have
            presented an inert state as the human's decision. That reason is
            gone: `ENFORCED_LADDER_RUNGS` is the full ladder and the approval
            path reads the rung itself. The fallback stays anyway, for a grant
            whose stored value is not a rung at all.
          */}
          <Radio.Group
            direction='vertical'
            value={ENFORCED_LADDER_RUNGS.includes(grant.ladder) ? grant.ladder : undefined}
            onChange={onLadder}
            className='flex flex-col gap-12px'
          >
            {ENFORCED_LADDER_RUNGS.map((rung) => (
              <Radio key={rung} value={rung}>
                <span className='font-medium'>{t(`commandEve.${RUNG_KEYS[rung]}.title`)}</span>
                <div className='text-13px op-70'>{t(`commandEve.${RUNG_KEYS[rung]}.body`)}</div>
              </Radio>
            ))}
          </Radio.Group>
        </SettingsSection>

        {/*
          The five seals. They are NOT the top of the ladder — they hang off no
          rung at all, and stay shut on rung 5 until each one is switched on
          here. That separation is the whole point: raising the ladder is a
          convenience decision, unsealing one of these is a trust decision, and
          nobody who meant "just get on with it" should also buy "and spend my
          money".

          They render now because they finally BIND: the approval path asks
          `decideAuthority` through the loopback shim on every decision, and a
          closed seal beats every rung there (eveAuthorityRuntimeCore).
        */}
        <SettingsSection
          title={t('commandEve.authority.sealsTitle')}
          description={t('commandEve.authority.sealsDescription')}
        >
          <div className='flex flex-col gap-12px'>
            {EVE_SEALED_CAPABILITIES.map((capability) => (
              <div key={capability} className='flex flex-col gap-8px' data-testid={`seal-row-${capability}`}>
                <div className='flex items-start justify-between gap-16px'>
                  <div className='min-w-0'>
                    <div className='font-medium'>{t(`commandEve.${SEAL_KEYS[capability]}.title`)}</div>
                    <div className='text-13px op-70'>{t(`commandEve.${SEAL_KEYS[capability]}.body`)}</div>
                  </div>
                  <Switch
                    checked={grant.capabilities[capability] === true}
                    onChange={(open) => onSeal(capability, open)}
                    data-testid={`seal-switch-${capability}`}
                  />
                </div>
                {capability === 'spend.money' && moneyOpen && (
                  <div className='flex flex-col gap-4px pl-4px'>
                    <div className='flex items-center gap-8px'>
                      <span className='text-13px op-70'>{t('commandEve.authority.dailyBudget')}</span>
                      <InputNumber
                        size='small'
                        min={0.01}
                        step={1}
                        precision={2}
                        style={{ width: 120 }}
                        value={typeof dailyCents === 'number' ? dailyCents / 100 : undefined}
                        onChange={onBudget}
                        data-testid='seal-budget-money'
                      />
                    </div>
                    {/*
                      An open money seal with no usable ceiling is REFUSED at
                      decision time (`spendWithinDailyLimit`), never read as
                      unlimited. Saying so here is what stops the user seeing a
                      switch that is on, an EVE that never spends, and concluding
                      the feature is broken.
                    */}
                    {grantNeedsAttention(grant) === 'money-without-budget' && (
                      <div className='text-13px text-orange-6' data-testid='budget-missing'>
                        {t('commandEve.authority.budgetMissing')}
                      </div>
                    )}
                    {classifyDailyBudget(dailyCents) === 'confirm' && (
                      <div className='text-13px text-orange-6' data-testid='budget-high'>
                        {t('commandEve.authority.budgetHigh')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection
          title={t('commandEve.authority.rememberedTitle')}
          description={t('commandEve.authority.rememberedDescription')}
        >
          {remembered.length === 0 ? (
            <div className='text-13px op-70'>{t('commandEve.authority.rememberedEmpty')}</div>
          ) : (
            <div className='flex flex-col gap-8px'>
              {remembered.map((entry) => (
                <div
                  key={entry.command}
                  className='flex items-center justify-between gap-16px'
                  data-testid='remembered-row'
                >
                  <div className='min-w-0'>
                    <code className='text-13px break-all'>{entry.command}</code>
                    <div className='text-12px op-60'>
                      {t('commandEve.authority.grantedAt', {
                        date: new Date(entry.grantedAt).toLocaleDateString(),
                      })}
                    </div>
                  </div>
                  <Button size='mini' status='danger' onClick={() => onForget(entry.command)}>
                    {t('commandEve.authority.forget')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      </div>
    </AionScrollArea>
  );
};

export default AuthorityModalContent;
