/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import ErsteSchritteModalContent from '@/renderer/components/settings/SettingsModal/contents/ErsteSchritteModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';

const ErsteSchritteSettings: React.FC = () => {
  return (
    <SettingsPageWrapper contentClassName='max-w-1100px'>
      <ErsteSchritteModalContent />
    </SettingsPageWrapper>
  );
};

export default ErsteSchritteSettings;
