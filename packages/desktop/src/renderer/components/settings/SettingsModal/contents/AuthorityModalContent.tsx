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
import { type EveAuthorityGrant, type EveLadderRung, type EveSealedCapability } from '@/common/config/eveAuthorityCore';
import { readRememberedCommands } from '@/common/config/eveRememberedCommandsCore';
import { COMMAND_EVE_LEGACY_BACKEND } from '@/common/config/eveAuthorityStoreCore';
import {
  ENFORCED_LADDER_RUNGS,
  backendModeForGrant,
  isUnconfirmedGrant,
  resolveStoredGrant,
  withLadder,
  withoutRememberedCommand,
} from '@/common/config/eveAuthorityStoreCore';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import SettingsSection from '@/renderer/components/settings/SettingsSection';
import { Button, Radio } from '@arco-design/web-react';
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

const AuthorityModalContent: React.FC = () => {
  const { t } = useTranslation();
  const [grant, setGrant] = useState<EveAuthorityGrant | null>(null);

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
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: EveAuthorityGrant) => {
    setGrant(next);
    await configService.set('commandEve.authority', next);
    // The grant is the record; `acp.config[hermes].preferredMode` is what the
    // session-opening path already reads. Writing only the record would leave a
    // setting that stores a preference and changes nothing — the exact defect
    // class this whole change exists to remove.
    const mode = backendModeForGrant(next);
    if (mode) {
      const acp = (await configService.get('acp.config')) ?? {};
      const backend = (acp as Record<string, Record<string, unknown>>)[COMMAND_EVE_LEGACY_BACKEND] ?? {};
      await configService.set('acp.config', {
        ...(acp as Record<string, unknown>),
        [COMMAND_EVE_LEGACY_BACKEND]: { ...backend, preferredMode: mode },
      });
    }
  }, []);

  const remembered = useMemo(() => (grant ? readRememberedCommands(grant.rememberedCommands) : []), [grant]);

  if (!grant) return null;

  const onLadder = (value: EveLadderRung): void => {
    void persist(withLadder(grant, value));
  };

  const onForget = (command: string): void => {
    if (!grant) return;
    void persist(withoutRememberedCommand(grant, command));
  };

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
          <Radio.Group direction='vertical' value={grant.ladder} onChange={onLadder} className='flex flex-col gap-12px'>
            {ENFORCED_LADDER_RUNGS.map((rung) => (
              <Radio key={rung} value={rung}>
                <span className='font-medium'>{t(`commandEve.${RUNG_KEYS[rung]}.title`)}</span>
                <div className='text-13px op-70'>{t(`commandEve.${RUNG_KEYS[rung]}.body`)}</div>
              </Radio>
            ))}
          </Radio.Group>
        </SettingsSection>

        {/*
          The sealed capability switches (money, outward publishing, deletion
          outside the workspace, credentials, production deploys) are modelled
          and tested in eveAuthorityCore, but NOTHING enforces them yet: no
          production code calls grantAllows/decideAuthority. Rendering them would
          ship five switches that store a preference and change nothing. They
          land together with the classification that makes them real.
        */}

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
