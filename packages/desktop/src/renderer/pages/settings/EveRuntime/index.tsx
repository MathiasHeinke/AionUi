/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EveRuntime — the merged "EVE-Runtime" Settings view (1.2.18, STEP 5+6).
 *
 * Founder framing: the operator is the CONDUCTOR; EVE orchestrates. This page
 * MERGES three previously separate surfaces into ONE view with three LOCAL
 * sub-tabs (Arco `Tabs`, NOT routes):
 *
 *   - "Orchestrierung"        → {@link DeinTeamPanel} (curated A-roster, controls,
 *                                budget projection, non-empty-floor guard).
 *   - "Assistenten"           → {@link AssistantSettingsBody} (the wrapper-less
 *                                AssistantSettings body — full CRUD + drawer/modals).
 *   - "Agenten & Belegschaft" → {@link AgentModalContent} + the two NEW honest
 *                                stub cards ({@link WorkerAssignmentCard},
 *                                {@link HumanGateDisplay}).
 *
 * IMPORTANT — NO backend deletion. This EMBEDS existing components; it does not
 * rewrite or remove any orchestration backend (eveTeamRoster / eveTeamControls /
 * eveTeamBudget / teamTypes / TeamPage / evaluateWorkerDispatch / assistant +
 * agent CRUD all stay). The merge is UI-only.
 */

import { Tabs } from '@arco-design/web-react';
import classNames from 'classnames';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DeinTeamPanel from '@renderer/components/team/DeinTeamPanel';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import { commandEve } from '@/common/adapter/ipcBridge';
import AgentModalContent from '@/renderer/components/settings/SettingsModal/contents/AgentModalContent';
import { AssistantSettingsBody } from '@/renderer/pages/settings/AssistantSettings';
import WorkerAssignmentCard from './WorkerAssignmentCard';
import HumanGateDisplay from './HumanGateDisplay';

type EveRuntimeTab = 'orchestration' | 'assistants' | 'agents';

const EveRuntime: React.FC = () => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const [activeTab, setActiveTab] = useState<EveRuntimeTab>('orchestration');
  // 1.7.9 hotfix: raw assistant/agent/CLI runtime surfaces are founder-only.
  // Public users see Command EVE as the only operator-facing runtime; Hermes may
  // still orchestrate Claude/Codex/Gemini internally behind governed routes.
  // The renderer may not touch process.env, so read the shell flag via MAIN.
  const [showFounderRuntimeTabs, setShowFounderRuntimeTabs] = useState(false);
  useEffect(() => {
    let alive = true;
    commandEve.shellFlags
      .invoke()
      .then((res) => {
        if (alive && res?.data?.founder_build === true) setShowFounderRuntimeTabs(true);
      })
      .catch(() => {
        /* fail-soft: public shape */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className='flex flex-col h-full w-full'>
      <header className='min-w-0 mb-4'>
        <h1 className='m-0 text-24px font-700 leading-30px text-t-primary'>
          {t('eveRuntime.title', { defaultValue: 'EVE-Runtime' })}
        </h1>
        <p className='m-0 mt-6px max-w-820px text-14px leading-22px text-t-secondary'>
          {t('eveRuntime.subtitle', {
            defaultValue:
              'Du bist der Dirigent — EVE orchestriert. Hier laufen Team, Assistenten und Agenten zusammen: ein Ort statt drei.',
          })}
        </p>
      </header>

      <Tabs
        activeTab={activeTab}
        onChange={(key) => setActiveTab(key as EveRuntimeTab)}
        type='line'
        className='flex flex-col flex-1 min-h-0 [&>.arco-tabs-content]:pt-0'
      >
        <Tabs.TabPane
          key='orchestration'
          title={t('eveRuntime.tab.orchestration', { defaultValue: 'Orchestrierung' })}
        >
          {/* Header + section-card chrome for the curated Dein-Team panel (the old
              standalone pages/deinTeam route was deleted in S9 cleanup; the panel
              lives here under EveRuntime settings now). */}
          <div className={classNames('flex flex-col gap-18px', isMobile ? 'pt-2' : 'pt-4')}>
            <header className='min-w-0'>
              <h2 className='m-0 text-18px font-700 leading-24px text-t-primary'>
                {t('deinTeam.title', { defaultValue: 'Dein Team' })}
              </h2>
              <p className='m-0 mt-6px max-w-820px text-14px leading-22px text-t-secondary'>
                {t('deinTeam.subtitle', {
                  defaultValue:
                    'Ein festes, kuratiertes Team. EVE verteilt die Arbeit an die passende Rolle — du steuerst Rhythmus und Budget.',
                })}
              </p>
            </header>
            <section className='rounded-16px border border-solid border-[var(--color-border-2)] bg-bg-2 px-18px py-16px'>
              <DeinTeamPanel />
            </section>
          </div>
        </Tabs.TabPane>

        {showFounderRuntimeTabs && (
          <Tabs.TabPane key='assistants' title={t('eveRuntime.tab.assistants', { defaultValue: 'Assistenten' })}>
            {/* Wrapper-less body — keeps full CRUD + drawer/modal portals + hooks. */}
            <AssistantSettingsBody />
          </Tabs.TabPane>
        )}

        {showFounderRuntimeTabs && (
          <Tabs.TabPane
            key='agents'
            title={t('eveRuntime.tab.agents', { defaultValue: 'Agenten & Belegschaft' })}
          >
            <div className='flex flex-col gap-18px pt-2'>
              <AgentModalContent />
              <WorkerAssignmentCard />
              <HumanGateDisplay />
            </div>
          </Tabs.TabPane>
        )}
      </Tabs>
    </div>
  );
};

export default EveRuntime;
