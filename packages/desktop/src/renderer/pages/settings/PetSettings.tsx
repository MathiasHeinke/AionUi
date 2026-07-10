/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Radio, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { systemSettings } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@/renderer/utils/platform';
import SettingsPageWrapper from './components/SettingsPageWrapper';
import PreferenceRow from '@/renderer/components/settings/PreferenceRow';
import SettingsSection, { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '@/renderer/components/settings/SettingsModal/settingsViewContext';

const PetSettings: React.FC = () => {
  const [enabled, setEnabled] = useState(true);
  const [size, setSize] = useState(280);
  const [dnd, setDnd] = useState(false);
  const [confirmEnabled, setConfirmEnabled] = useState(true);
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isDesktop = isElectronDesktop();

  useEffect(() => {
    // Honest default: the MAIN-process spawn gate (index.ts) only creates the pet
    // window when pet.enabled === true, so an absent value means the pet is OFF.
    // The old `?? true` DISPLAY default lied — it showed the toggle ON while no pet
    // ever spawned ("pets don't run") and implied an unasked ~100-250MB extra
    // renderer on 8GB. OFF-by-default matches reality + the perf budget.
    setEnabled(configService.get('pet.enabled') ?? false);
    setSize(configService.get('pet.size') ?? 280);
    setDnd(configService.get('pet.dnd') ?? false);
    setConfirmEnabled(configService.get('pet.confirmEnabled') ?? true);
  }, []);

  const handleEnabledChange = useCallback((checked: boolean) => {
    setEnabled(checked);
    configService.setLocal('pet.enabled', checked);
    systemSettings.setPetEnabled.invoke({ enabled: checked }).catch(() => {
      setEnabled(!checked);
      configService.setLocal('pet.enabled', !checked);
    });
  }, []);

  const handleSizeChange = useCallback(
    (val: number) => {
      const prevSize = size;
      setSize(val);
      configService.setLocal('pet.size', val);
      systemSettings.setPetSize.invoke({ size: val }).catch(() => {
        setSize(prevSize);
        configService.setLocal('pet.size', prevSize);
      });
    },
    [size]
  );

  const handleDndChange = useCallback((checked: boolean) => {
    setDnd(checked);
    configService.setLocal('pet.dnd', checked);
    systemSettings.setPetDnd.invoke({ dnd: checked }).catch(() => {
      setDnd(!checked);
      configService.setLocal('pet.dnd', !checked);
    });
  }, []);

  const handleConfirmEnabledChange = useCallback((checked: boolean) => {
    setConfirmEnabled(checked);
    configService.setLocal('pet.confirmEnabled', checked);
    systemSettings.setPetConfirmEnabled.invoke({ enabled: checked }).catch(() => {
      setConfirmEnabled(!checked);
      configService.setLocal('pet.confirmEnabled', !checked);
    });
  }, []);

  if (!isDesktop) {
    return (
      <SettingsPageWrapper>
        <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
          <SettingsPageHeader title={t('pet.desktopPet')} description={t('pet.pageDescription')} />
          <SettingsSection title={t('pet.availabilityTitle')}>
            <div className='eve-settings-notice'>
              <p className='m-0 text-13px text-t-secondary'>{t('pet.desktopOnly')}</p>
            </div>
          </SettingsSection>
        </AionScrollArea>
      </SettingsPageWrapper>
    );
  }

  const preferenceItems = [
    {
      key: 'enabled',
      label: t('pet.enable'),
      component: <Switch checked={enabled} onChange={handleEnabledChange} />,
    },
    {
      key: 'size',
      label: t('pet.size'),
      component: (
        <Radio.Group value={size} onChange={handleSizeChange} disabled={!enabled}>
          <Radio value={200}>{t('pet.sizeSmall', { px: 200 })}</Radio>
          <Radio value={280}>{t('pet.sizeMedium', { px: 280 })}</Radio>
          <Radio value={360}>{t('pet.sizeLarge', { px: 360 })}</Radio>
        </Radio.Group>
      ),
    },
    {
      key: 'dnd',
      label: t('pet.dnd'),
      description: t('pet.dndDescription'),
      component: <Switch checked={dnd} onChange={handleDndChange} disabled={!enabled} />,
    },
    {
      key: 'confirmBubble',
      label: t('pet.confirmBubble'),
      description: t('pet.confirmBubbleDescription'),
      component: <Switch checked={confirmEnabled} onChange={handleConfirmEnabledChange} disabled={!enabled} />,
    },
  ];

  return (
    <SettingsPageWrapper>
      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <SettingsPageHeader title={t('pet.desktopPet')} description={t('pet.pageDescription')} />
        <SettingsSection
          title={t('pet.behaviorTitle')}
          description={t('pet.behaviorDescription')}
          bodyClassName='eve-settings-list'
        >
          {preferenceItems.map((item) => (
            <PreferenceRow
              key={item.key}
              label={item.label}
              description={item.description}
              stackOnMobile={item.key === 'size'}
            >
              {item.component}
            </PreferenceRow>
          ))}
        </SettingsSection>
      </AionScrollArea>
    </SettingsPageWrapper>
  );
};

export default PetSettings;
