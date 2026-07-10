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
import { Button, Tag } from '@arco-design/web-react';
import { Right } from '@icon-park/react';
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
import { EVE_SETTINGS_TAG_COLOR } from '@/renderer/components/settings/settingsSemantics';
import SettingsSection, { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';

const STATUS_TAG_COLOR: Record<ErsteSchritteStepStatus, 'green' | 'gold' | 'gray'> = {
  done: EVE_SETTINGS_TAG_COLOR.success,
  attention: EVE_SETTINGS_TAG_COLOR.attention,
  optional: EVE_SETTINGS_TAG_COLOR.neutral,
};

/** German fallback copy per step (the i18n locale files override these keys). */
const STEP_COPY: Record<string, { title: string; desc: string }> = {
  'ki-spur': {
    title: 'KI-Spur wählen',
    desc: 'Die Cloud-KI antwortet sofort. Optional: die lokale KI (Smart Local) laden.',
  },
  'company-brain': {
    title: 'Company-Brain füllen',
    desc: 'Erzähl EVE dein Geschäft — sie merkt es sich und arbeitet damit.',
  },
  kunde: {
    title: 'Ersten Kunden anlegen',
    desc: 'Als Agentur einen Kunden-Seat hinzufügen (öffnet dein Konto im Browser).',
  },
  connectors: {
    title: 'Integration verbinden',
    desc: 'Geprüfte Connectoren freischalten — Schlüssel bleiben im Vault, nie im Chat.',
  },
  team: { title: 'Dein Team', desc: 'Rollen, Budget und deine angebundenen Werkzeuge steuern.' },
  skills: { title: 'Was EVE kann', desc: 'Die Fähigkeiten-Bibliothek — inklusive von EVE selbst erstellter Skills.' },
  privacy: { title: 'Datenschutz', desc: 'Telemetrie ist standardmäßig aus. Hier prüfen und steuern.' },
  budget: { title: 'Budget & Guthaben', desc: 'Ausgabe-Limit, Guthaben und Pakete verwalten.' },
  name: { title: 'Wie EVE dich nennt', desc: 'Bestätige, wie EVE dich ansprechen soll.' },
};

const STATUS_LABEL: Record<ErsteSchritteStepStatus, string> = {
  done: 'erledigt',
  attention: 'prüfen',
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
      <div className='erste-schritte-settings' data-testid='erste-schritte-webui'>
        <SettingsPageHeader
          title={t('settings.ersteSchritte', { defaultValue: 'Erste Schritte' })}
          description={t('settings.ersteSchritteIntro', {
            defaultValue: 'Dein Startpunkt mit EVE — hier siehst du, ob alles bereit ist.',
          })}
        />
        <SettingsSection title={t('settings.ersteSchritteAvailabilityTitle', { defaultValue: 'Verfügbarkeit' })}>
          <div className='eve-settings-notice'>
            {t('settings.ersteSchritteWebui', {
              defaultValue: 'Die Ersten Schritte siehst du in der Desktop-App.',
            })}
          </div>
        </SettingsSection>
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
    <div className='erste-schritte-settings' data-testid='erste-schritte-content'>
      <SettingsPageHeader
        title={t('settings.ersteSchritte', { defaultValue: 'Erste Schritte' })}
        description={t('settings.ersteSchritteIntro', {
          defaultValue: 'Dein Startpunkt mit EVE — hier siehst du, ob alles bereit ist.',
        })}
        action={
          <Button size='small' loading={loading} onClick={() => void refresh()}>
            {t('settings.ersteSchritteRefresh', { defaultValue: 'Aktualisieren' })}
          </Button>
        }
      />

      <SettingsSection
        title={t('settings.ersteSchritteStatusTitle', { defaultValue: 'Einrichtungsstatus' })}
        description={t('settings.ersteSchritteStatusDescription', {
          defaultValue: 'EVE zeigt nur bestätigte Lücken und behauptet keinen Status, den sie nicht prüfen konnte.',
        })}
      >
        {loading ? (
          <div className='erste-schritte-settings__status' data-loading='true'>
            {t('settings.ersteSchritteLoading', { defaultValue: 'Status wird geprüft …' })}
          </div>
        ) : greeting ? (
          <div
            data-testid='erste-schritte-status'
            data-ready={greeting.ready ? 'true' : 'false'}
            className='erste-schritte-settings__status'
          >
            <div className='erste-schritte-settings__status-copy'>
              <strong>{greeting.headline}</strong>
              <span>{greeting.subline}</span>
            </div>
            {!greeting.ready && greeting.gaps.length > 0 ? (
              <ul className='erste-schritte-settings__gaps'>
                {greeting.gaps.map((gap) => {
                  const route = targetToRoute(gap.link_target);
                  return (
                    <li key={gap.id} data-testid={`erste-schritte-gap-${gap.id}`}>
                      <span>{gap.text}</span>
                      {route && gap.link_label ? (
                        <Button
                          type='text'
                          size='small'
                          data-testid={`erste-schritte-link-${gap.id}`}
                          onClick={() => onNavigate(route)}
                        >
                          {gap.link_label}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className='erste-schritte-settings__status'>
            {t('settings.ersteSchritteUnavailable', {
              defaultValue:
                'Ich konnte deinen Einrichtungs-Status gerade nicht lesen — im Chat geht es trotzdem weiter.',
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.ersteSchritteNextSteps', { defaultValue: 'Nächste Schritte' })}
        description={t('settings.ersteSchritteNextStepsDescription', {
          defaultValue: 'Öffne genau den Bereich, den du als Nächstes einrichten oder prüfen möchtest.',
        })}
        testId='erste-schritte-hub'
        bodyClassName='erste-schritte-settings__steps'
      >
        {hubSteps.map((step) => (
          <Button
            key={step.id}
            type='text'
            long
            data-testid={`erste-schritte-step-${step.id}`}
            data-status={step.status}
            onClick={() => onStepClick(step)}
            className='erste-schritte-settings__step'
          >
            <span className='erste-schritte-settings__step-copy'>
              <strong>
                {t(`settings.ersteSchritteStep.${step.id}.title`, {
                  defaultValue: STEP_COPY[step.id]?.title ?? step.id,
                })}
              </strong>
              <span>
                {t(`settings.ersteSchritteStep.${step.id}.desc`, { defaultValue: STEP_COPY[step.id]?.desc ?? '' })}
              </span>
            </span>
            <span className='erste-schritte-settings__step-state'>
              <Tag color={STATUS_TAG_COLOR[step.status]} size='small'>
                {t(`settings.ersteSchritteStatus.${step.status}`, { defaultValue: STATUS_LABEL[step.status] })}
              </Tag>
              <Right theme='outline' size={14} />
            </span>
          </Button>
        ))}
      </SettingsSection>
    </div>
  );
};

export default ErsteSchritteModalContent;
