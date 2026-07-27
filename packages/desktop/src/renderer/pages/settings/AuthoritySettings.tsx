/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settings → Freigaben, as a ROUTE.
 *
 * The first cut of this lived only in `SettingsModal`. Command EVE's shell never
 * opens that modal — it routes to `/settings/*` — so the panel was unreachable in
 * the product while every unit test passed. Found by running the app, not by
 * reading it.
 *
 * The body is shared with the modal surface so the two can never drift: one
 * component, two hosts.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';
import AuthorityPanel from '@/renderer/components/settings/SettingsModal/contents/AuthorityModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';
import { useSettingsViewMode } from '@/renderer/components/settings/SettingsModal/settingsViewContext';

const AuthoritySettings: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';

  return (
    <SettingsPageWrapper>
      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <SettingsPageHeader
          title={t('settings.authority', { defaultValue: 'Freigaben' })}
          description={t('commandEve.authority.pageDescription', {
            defaultValue:
              'Lege fest, was EVE ohne Rückfrage tun darf — und nimm jederzeit zurück, was sie sich gemerkt hat.',
          })}
        />
        <AuthorityPanel />
      </AionScrollArea>
    </SettingsPageWrapper>
  );
};

export default AuthoritySettings;
