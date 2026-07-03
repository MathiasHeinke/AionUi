/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.6.x — the "Erste Schritte" settings surface (F3). Settings used to open on
 * the Model tab, which is thin/empty for a cloud user; this gives them a
 * meaningful first screen: their readiness ("startklar" or the real remaining
 * gaps) with click-through links.
 *
 * It REUSES the S0 onboarding-status data path via useOnboardingStatus (the same
 * aggregator the chat greeting uses) — no new IPC, no new data path. refresh-on-
 * focus so a gap the operator just closed (e.g. re-activated in the browser)
 * clears without a restart. Honesty: on a failed/unknown status it renders a
 * claim-free line, never a false "ready".
 */

import React, { useCallback } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { isElectronDesktop } from '@renderer/utils/platform';
import { useOnboardingStatus } from '@renderer/hooks/useOnboardingStatus';
import { targetToRoute } from '@renderer/pages/conversation/components/OnboardingReadinessGreeting';

const ErsteSchritteModalContent: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { loading, greeting, error, refresh } = useOnboardingStatus({ refreshOnFocus: true });

  const onNavigate = useCallback(
    (route: string) => {
      void Promise.resolve(navigate(route)).catch((navError) => {
        console.error('Erste-Schritte navigation failed:', navError);
      });
    },
    [navigate]
  );

  // WebUI / non-desktop: no onboarding data — render a neutral, claim-free note.
  if (!isElectronDesktop()) {
    return (
      <div className='p-4px text-14px leading-22px text-t-secondary' data-testid='erste-schritte-webui'>
        {t('settings.ersteSchritteWebui', {
          defaultValue: 'Die Ersten Schritte siehst du in der Desktop-App.',
        })}
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-16px p-4px' data-testid='erste-schritte-content'>
      <div className='flex items-start justify-between gap-12px'>
        <div className='min-w-0'>
          <h2 className='m-0 text-18px font-700 leading-26px text-t-primary'>
            {t('settings.ersteSchritte', { defaultValue: 'Erste Schritte' })}
          </h2>
          <p className='m-0 mt-4px max-w-620px text-13px leading-20px text-t-secondary'>
            {t('settings.ersteSchritteIntro', {
              defaultValue: 'Dein Startpunkt mit EVE — hier siehst du, ob alles bereit ist.',
            })}
          </p>
        </div>
        <Button size='small' loading={loading} onClick={() => void refresh()}>
          {t('settings.ersteSchritteRefresh', { defaultValue: 'Aktualisieren' })}
        </Button>
      </div>

      {loading ? null : greeting ? (
        <div
          data-testid='erste-schritte-status'
          data-ready={greeting.ready ? 'true' : 'false'}
          className='flex flex-col gap-12px rounded-14px border border-solid border-[var(--color-border-2)] bg-fill-1 px-16px py-14px'
        >
          <div className='flex flex-col gap-4px'>
            <span className='text-15px font-600 text-t-primary'>{greeting.headline}</span>
            <span className='text-13px text-t-secondary'>{greeting.subline}</span>
          </div>
          {!greeting.ready && greeting.gaps.length > 0 ? (
            <div className='flex flex-col gap-8px'>
              {greeting.gaps.map((gap) => {
                const route = targetToRoute(gap.link_target);
                return (
                  <div
                    key={gap.id}
                    data-testid={`erste-schritte-gap-${gap.id}`}
                    className='flex items-start gap-8px rounded-10px bg-fill-2 px-12px py-10px text-13px leading-20px text-t-secondary'
                  >
                    <span aria-hidden>•</span>
                    <span>
                      {gap.text}
                      {route && gap.link_label ? (
                        <>
                          {' '}
                          <a
                            data-testid={`erste-schritte-link-${gap.id}`}
                            className='text-primary hover:underline cursor-pointer'
                            onClick={() => onNavigate(route)}
                          >
                            {gap.link_label}
                          </a>
                        </>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : (
        // Failed/unknown read — claim-free, never a false "ready".
        <div className='rounded-14px border border-solid border-[var(--color-border-2)] bg-fill-1 px-16px py-14px text-13px leading-20px text-t-secondary'>
          {t('settings.ersteSchritteUnavailable', {
            defaultValue: 'Ich konnte deinen Einrichtungs-Status gerade nicht lesen — im Chat geht es trotzdem weiter.',
          })}
        </div>
      )}
      {error ? null : null}
    </div>
  );
};

export default ErsteSchritteModalContent;
