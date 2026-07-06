/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.6.x → 1.7.2 — the "Erste Schritte" settings surface (F3).
 *
 * v1.6 shipped this as a status MIRROR (the same readiness card the chat greeting
 * shows). 1.7.2 turns it into a real Day-0 HUB: the readiness block stays on top,
 * and below it a "Nächste Schritte" grid lists the concrete first steps, each
 * deep-linking to the (already existing) page that does it — the Day-0 actions
 * that previously were only discoverable by hunting (model/local, Company-Brain,
 * client seat, connectors, team, skills, privacy, budget, name).
 *
 * It REUSES the S0 onboarding-status data path via useOnboardingStatus (the same
 * aggregator the chat greeting uses) — no new IPC, no new cloud call. refresh-on-
 * focus so a gap the operator just closed clears without a restart.
 *
 * HONESTY (founder 2026-07-06): the step chips are 'erledigt' ONLY where a real
 * signal proves it (first-value readiness, the identity item). Everything we can't
 * cheaply prove is a neutral 'öffnen' — never a fake green check, never a red
 * "you failed". On a failed/unknown status the readiness block renders a claim-
 * free line, never a false "ready"; the hub steps still work (all neutral).
 */

import React, { useCallback } from 'react';
import { Button, Card, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { isElectronDesktop, openAccountWeb } from '@renderer/utils/platform';
import { useOnboardingStatus } from '@renderer/hooks/useOnboardingStatus';
import { targetToRoute } from '@renderer/pages/conversation/components/OnboardingReadinessGreeting';
import {
  buildErsteSchritteHubSteps,
  type ErsteSchritteItemState,
  type ErsteSchritteStep,
  type ErsteSchritteStepStatus,
} from '@/common/config/ersteSchritteHubCore';

const STATUS_TAG_COLOR: Record<ErsteSchritteStepStatus, 'green' | 'orange' | 'gray'> = {
  done: 'green',
  attention: 'orange',
  optional: 'gray',
};

/** German fallback copy per step (the i18n locale files override these keys). */
const STEP_COPY: Record<string, { title: string; desc: string }> = {
  'ki-spur': { title: 'KI-Spur wählen', desc: 'Die Cloud-KI antwortet sofort. Optional: die lokale KI (Smart Local) laden.' },
  'company-brain': { title: 'Company-Brain füllen', desc: 'Erzähl EVE dein Geschäft — sie merkt es sich und arbeitet damit.' },
  kunde: { title: 'Ersten Kunden anlegen', desc: 'Als Agentur einen Kunden-Seat hinzufügen (öffnet dein Konto im Browser).' },
  connectors: { title: 'Integration verbinden', desc: 'Geprüfte Connectoren freischalten — Schlüssel bleiben im Vault, nie im Chat.' },
  team: { title: 'Dein Team', desc: 'Rollen, Budget und Worker (z. B. deine Claude-CLI) steuern.' },
  skills: { title: 'Was EVE kann', desc: 'Die Fähigkeiten-Bibliothek — inklusive von EVE selbst erstellter Skills.' },
  privacy: { title: 'Datenschutz', desc: 'Telemetrie ist standardmäßig aus. Hier prüfen und steuern.' },
  budget: { title: 'Budget & Guthaben', desc: 'Ausgabe-Limit, Guthaben und Pakete verwalten.' },
  name: { title: 'Wie EVE dich nennt', desc: 'Bestätige, wie EVE dich ansprechen soll.' },
};

const STATUS_LABEL: Record<ErsteSchritteStepStatus, string> = {
  done: 'erledigt',
  attention: 'offen',
  optional: 'öffnen',
};

const ErsteSchritteModalContent: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { loading, model, greeting, refresh } = useOnboardingStatus({ refreshOnFocus: true });

  const onNavigate = useCallback(
    (route: string) => {
      void Promise.resolve(navigate(route)).catch((navError) => {
        console.error('Erste-Schritte navigation failed:', navError);
      });
    },
    [navigate]
  );

  const onStepClick = useCallback(
    (step: ErsteSchritteStep) => {
      if (step.isWebIntent) {
        void openAccountWeb(step.route);
        return;
      }
      onNavigate(step.route);
    },
    [onNavigate]
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

  // Honest inputs to the hub: 'done' only where a real signal proves it; a null
  // model (loading/failed read) yields all-neutral steps, never false claims.
  const identityItem = model?.items.find((item) => item.id === 'identity');
  const hubSteps = buildErsteSchritteHubSteps({
    firstValueReady: model?.first_value_ready === true,
    identityState: (identityItem?.state ?? 'unknown') as ErsteSchritteItemState,
  });

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

      {/* 1.7.2 — the real Day-0 hub: concrete next steps, each deep-linking to the
          existing page that does it. Honest chips ('erledigt' only where proven). */}
      <div className='flex flex-col gap-8px' data-testid='erste-schritte-hub'>
        <h3 className='m-0 text-14px font-700 leading-22px text-t-primary'>
          {t('settings.ersteSchritteNextSteps', { defaultValue: 'Nächste Schritte' })}
        </h3>
        <div className='grid gap-8px sm:grid-cols-2'>
          {hubSteps.map((step) => (
            <Card
              key={step.id}
              hoverable
              data-testid={`erste-schritte-step-${step.id}`}
              data-status={step.status}
              onClick={() => onStepClick(step)}
              className='cursor-pointer rounded-12px'
              bodyStyle={{ padding: '12px 14px' }}
            >
              <div className='flex flex-col gap-4px'>
                <div className='flex items-start justify-between gap-8px'>
                  <span className='text-13px font-600 leading-20px text-t-primary'>
                    {t(`settings.ersteSchritteStep.${step.id}.title`, { defaultValue: STEP_COPY[step.id]?.title ?? step.id })}
                  </span>
                  <Tag color={STATUS_TAG_COLOR[step.status]} size='small'>
                    {t(`settings.ersteSchritteStatus.${step.status}`, { defaultValue: STATUS_LABEL[step.status] })}
                  </Tag>
                </div>
                <span className='text-12px leading-18px text-t-secondary'>
                  {t(`settings.ersteSchritteStep.${step.id}.desc`, { defaultValue: STEP_COPY[step.id]?.desc ?? '' })}
                </span>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ErsteSchritteModalContent;
