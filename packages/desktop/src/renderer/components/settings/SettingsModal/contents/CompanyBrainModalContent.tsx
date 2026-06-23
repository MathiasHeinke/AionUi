/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company Brain settings tab (fix #4).
 *
 * The Day-0 "Seed your Company Brain" prompt used to FORCE itself on every
 * launch until a seed was recorded — founder ask: stop pushing it on the user,
 * move it into Settings and show, per profile, what EVE has already learned.
 *
 * This panel:
 *  - shows the current seed status ("geseedet ✓ / noch nicht geseedet"),
 *  - lets the user seed at any time by reusing the EXACT same seed UI
 *    (`DayZeroOnboardingModal`) — but via `useDayZeroOnboarding({ enabled:false })`
 *    so the modal here is opened on demand and NEVER force-pops.
 *
 * The forced first-run host (`DayZeroOnboardingHost`) now shows at most once
 * (sticky `clientSeeded` / `clientSeedDismissed`); this panel is the always-on
 * place to seed afterwards.
 */

import React, { useState } from 'react';
import { Button, Card, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { persistCompanyBrainSeed, useDayZeroOnboarding } from '@renderer/hooks/useDayZeroOnboarding';
import DayZeroOnboardingModal from '@renderer/components/billing/DayZeroOnboardingModal';

const CompanyBrainModalContent: React.FC = () => {
  const { t } = useTranslation();
  // enabled:false → this hook instance NEVER force-pops; `shouldForce` stays
  // false. We only use its `seeded` status + `recordSeed` action here.
  const { seeded, recordSeed } = useDayZeroOnboarding({ enabled: false, onSeedRecorded: persistCompanyBrainSeed });
  const [seedOpen, setSeedOpen] = useState(false);

  const handleSeed = async (seed: Parameters<typeof recordSeed>[0]) => {
    await recordSeed(seed);
    setSeedOpen(false);
  };

  return (
    <div className='company-brain-settings' data-testid='company-brain-settings'>
      <Card
        className='company-brain-settings__status'
        title={t('credits.companyBrain.title', { defaultValue: 'Company Brain' })}
      >
        <div className='company-brain-settings__status-row' data-testid='company-brain-status'>
          {seeded ? (
            <Tag color='green' data-seeded='true'>
              {t('credits.companyBrain.seeded', { defaultValue: 'Company Brain: geseedet ✓' })}
            </Tag>
          ) : (
            <Tag color='gray' data-seeded='false'>
              {t('credits.companyBrain.notSeeded', { defaultValue: 'Company Brain: noch nicht geseedet' })}
            </Tag>
          )}
        </div>
        <p className='company-brain-settings__hint'>
          {seeded
            ? t('credits.companyBrain.seededHint', {
                defaultValue:
                  'EVE hat für dieses Profil bereits ein Profil angelegt. Du kannst jederzeit einen weiteren Client / Brief ergänzen.',
              })
            : t('credits.companyBrain.notSeededHint', {
                defaultValue:
                  'Gib EVE einen echten Client zum Lernen — ein Brief oder eine Verbindung. Alles, was du baust, bleibt deins.',
              })}
        </p>
        <Button
          type='primary'
          shape='round'
          onClick={() => setSeedOpen(true)}
          data-testid='company-brain-seed-open'
        >
          {seeded
            ? t('credits.companyBrain.seedMore', { defaultValue: 'Weiteren Client ergänzen' })
            : t('credits.companyBrain.seedNow', { defaultValue: 'Jetzt Company Brain seeden' })}
        </Button>
      </Card>

      {/* Same seed UI as the Day-0 modal, but opened on demand — never forced. */}
      <DayZeroOnboardingModal open={seedOpen} onSeed={handleSeed} onSkip={() => setSeedOpen(false)} />
    </div>
  );
};

export default CompanyBrainModalContent;
