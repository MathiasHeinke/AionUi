/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import CompanyBrainModalContent from '@/renderer/components/settings/SettingsModal/contents/CompanyBrainModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';

/**
 * Route-based Company Brain settings page (fix #4): per-profile seed status +
 * on-demand seed UI. Replaces the repeated forced Day-0 modal.
 */
const CompanyBrainSettings: React.FC = () => {
  return (
    <SettingsPageWrapper contentClassName='max-w-640px'>
      <CompanyBrainModalContent />
    </SettingsPageWrapper>
  );
};

export default CompanyBrainSettings;
