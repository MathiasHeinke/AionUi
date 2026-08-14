/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import BillingModalContent from '@/renderer/components/settings/SettingsModal/contents/BillingModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';

/** Route-based billing settings page (Lane 3): meter + spend cap + pricing + packs. */
const BillingSettings: React.FC = () => {
  const navigate = useNavigate();

  return (
    <SettingsPageWrapper contentClassName='max-w-640px'>
      <BillingModalContent onOpenAccount={() => navigate('/settings/account')} />
    </SettingsPageWrapper>
  );
};

export default BillingSettings;
