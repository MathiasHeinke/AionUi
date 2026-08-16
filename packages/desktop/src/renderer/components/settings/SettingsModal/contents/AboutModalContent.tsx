/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Switch } from '@arco-design/web-react';
import { Right } from '@renderer/components/icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsViewMode } from '../settingsViewContext';
import { isElectronDesktop, openExternalUrl } from '@/renderer/utils/platform';
import FeedbackReportModal from './FeedbackReportModal';
import {
  COMMAND_EVE_APP_NAME,
  COMMAND_EVE_ASSISTANT_AVATAR,
  COMMAND_EVE_SHELL_ENABLED,
  formatCommandEveDisplayVersion,
} from '@/common/config/commandEveShell';
import SettingsSection, { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';
import PreferenceRow from '@/renderer/components/settings/PreferenceRow';

// __APP_VERSION__ is injected by electron.vite.config.ts `define:` from the
// repo-root package.json. The previous `import packageJson from
// '../../../../../../package.json'` resolved to packages/desktop/package.json
// which is a workspace placeholder permanently pinned at "0.0.0".
declare const __APP_VERSION__: string;

const dispatchUpdateCheck = () => {
  window.dispatchEvent(new CustomEvent('aionui-open-update-modal', { detail: { source: 'about' } }));
};

type LinkItem =
  | { title: string; url: string; testId?: string; onClick?: never }
  | { title: string; onClick: () => void; testId?: string; url?: never };

const AboutModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isElectron = isElectronDesktop();

  const [includePrerelease, setIncludePrerelease] = useState(false);
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('update.includePrerelease');
    setIncludePrerelease(saved === 'true');
  }, []);

  const handlePrereleaseChange = (val: boolean) => {
    setIncludePrerelease(val);
    localStorage.setItem('update.includePrerelease', String(val));
  };

  const openLink = async (url: string) => {
    try {
      await openExternalUrl(url);
    } catch (error) {
      console.log('Failed to open link:', error);
    }
  };

  const linkItems: LinkItem[] = [
    {
      title: t('settings.helpDocumentation'),
      url: COMMAND_EVE_SHELL_ENABLED ? 'https://command-eve.com' : 'https://github.com/iOfficeAI/AionUi/wiki',
    },
    {
      title: t('settings.updateLog'),
      url: COMMAND_EVE_SHELL_ENABLED
        ? 'https://github.com/MathiasHeinke/company-os/releases'
        : 'https://github.com/iOfficeAI/AionUi/releases',
    },
    {
      title: t('settings.feedback'),
      url: COMMAND_EVE_SHELL_ENABLED
        ? 'https://github.com/MathiasHeinke/company-os/issues'
        : 'https://github.com/iOfficeAI/AionUi/issues',
    },
    {
      title: t('settings.bugReport'),
      onClick: () => setShowFeedbackModal(true),
      testId: 'about-bug-report',
    },
    {
      title: t('settings.contactMe'),
      url: COMMAND_EVE_SHELL_ENABLED ? 'https://command-eve.com' : 'https://x.com/WailiVery',
    },
    {
      title: t('settings.officialWebsite'),
      url: COMMAND_EVE_SHELL_ENABLED ? 'https://command-eve.com' : 'https://www.aionui.com',
    },
  ];

  return (
    <div className='flex flex-col h-full w-full'>
      <div className={isPageMode ? 'flex-1 min-h-0 overflow-visible' : 'flex-1 min-h-0 overflow-y-auto px-24px'}>
        <SettingsPageHeader title={t('settings.about')} description={t('settings.aboutPageDescription')} />

        <SettingsSection
          title={t('settings.aboutApplicationSection')}
          description={t('settings.aboutApplicationSectionDescription')}
        >
          <div className='eve-about-summary'>
            {COMMAND_EVE_SHELL_ENABLED && (
              <img
                src={COMMAND_EVE_ASSISTANT_AVATAR}
                alt=''
                width={40}
                height={40}
                className='eve-about-summary__logo'
              />
            )}
            <div className='eve-about-summary__copy'>
              <strong>{COMMAND_EVE_SHELL_ENABLED ? COMMAND_EVE_APP_NAME : 'AionUi'}</strong>
              <span>
                {t(COMMAND_EVE_SHELL_ENABLED ? 'settings.commandEveAppDescription' : 'settings.appDescription')}
              </span>
            </div>
            <span className='eve-pill eve-about-summary__version'>
              {t('settings.currentVersion')} v{formatCommandEveDisplayVersion(__APP_VERSION__)}
            </span>
          </div>
        </SettingsSection>

        {isElectron && (
          <SettingsSection
            title={t('settings.aboutUpdatesSection')}
            description={t('settings.aboutUpdatesSectionDescription')}
            bodyClassName='eve-settings-list'
          >
            <div className='eve-settings-action-row eve-about-update-row'>
              <p>{t('settings.aboutUpdateActionDescription')}</p>
              <Button type='primary' data-testid='about-check-updates' onClick={dispatchUpdateCheck}>
                {t('settings.checkForUpdates')}
              </Button>
            </div>
            <PreferenceRow label={t('settings.includePrereleaseUpdates')}>
              <Switch size='small' checked={includePrerelease} onChange={handlePrereleaseChange} />
            </PreferenceRow>
          </SettingsSection>
        )}

        <SettingsSection
          title={t('settings.aboutSupportSection')}
          description={t('settings.aboutSupportSectionDescription')}
          bodyClassName='eve-settings-link-list'
        >
          {linkItems.map((item, index) => (
            <Button
              key={index}
              type='text'
              long
              data-testid={item.testId}
              className='eve-settings-link-row'
              onClick={() => {
                // `'url' in item` does NOT discriminate here: the other union member
                // declares `url?: never`, so the key is optional-present on both and
                // the narrowing leaves `string | undefined`. Testing the VALUE picks
                // the right member, and behaves identically — a member with
                // `url?: never` can only ever be falsy.
                if (item.url) {
                  openLink(item.url).catch((error) => console.error('Failed to open link:', error));
                } else {
                  item.onClick();
                }
              }}
            >
              <span className='eve-settings-link-row__content'>
                <span>{item.title}</span>
                <Right size='16' />
              </span>
            </Button>
          ))}
        </SettingsSection>
      </div>
      <FeedbackReportModal visible={showFeedbackModal} onCancel={() => setShowFeedbackModal(false)} />
    </div>
  );
};

export default AboutModalContent;
