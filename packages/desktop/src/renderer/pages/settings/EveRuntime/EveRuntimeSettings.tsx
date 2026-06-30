/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EveRuntimeSettings — thin Settings route wrapper for the merged EVE-Runtime
 * view. Mirrors the sibling settings pages (AssistantSettings / Capabilities):
 * the outer {@link SettingsPageWrapper} supplies scroll/padding/nav chrome and
 * the page-mode view context; {@link EveRuntime} owns the three sub-tabs.
 *
 * Route-wiring (Router.tsx) is owned by a separate worker; this is the element
 * they mount at `/settings/eve-runtime`.
 */

import React from 'react';
import SettingsPageWrapper from '@/renderer/pages/settings/components/SettingsPageWrapper';
import EveRuntime from './index';

const EveRuntimeSettings: React.FC = () => (
  <SettingsPageWrapper>
    <EveRuntime />
  </SettingsPageWrapper>
);

export default EveRuntimeSettings;
