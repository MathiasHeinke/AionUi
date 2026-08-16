/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Brain,
  Cat,
  Communication,
  Computer,
  Cube,
  Earth,
  Heartbeat,
  Info,
  Link,
  Lock,
  Pulse,
  RocketLaunch,
  Sparkle,
  System,
  User,
  UsersThree,
  Wallet,
} from '@renderer/components/icons';
import React from 'react';

export const BUILTIN_TAB_IDS = [
  'ersteSchritte',
  'model',
  'eveRuntime',
  'capabilities',
  'runtime',
  'connectors',
  'authority',
  'appearance',
  'webui',
  'pet',
  'privacy',
  'billing',
  'companyBrain',
  'account',
  'system',
  'about',
] as const;

export type BuiltinSettingsNavigationId = (typeof BUILTIN_TAB_IDS)[number];

export const LEGACY_ANCHOR_REMAP: Record<string, string> = {
  'skills-hub': 'capabilities',
  tools: 'capabilities',
  display: 'appearance',
  agent: 'eveRuntime',
  assistants: 'eveRuntime',
};

export function isSettingsPathActive(pathname: string, path: string): boolean {
  const route = `/settings/${path}`;
  return pathname === route || pathname.startsWith(`${route}/`);
}

export type SettingsNavigationItem = {
  id: BuiltinSettingsNavigationId;
  label: string;
  icon: React.ReactElement;
  path: string;
};

export type SettingsNavigationTranslate = (key: string, options?: { defaultValue?: string }) => string;

/**
 * The single built-in settings vocabulary for route sidebar, mobile nav and
 * the compatibility modal. Callers own layout; glyph choice cannot drift.
 */
export function getBuiltinSettingsNavigationItems(
  isDesktop: boolean,
  t: SettingsNavigationTranslate
): SettingsNavigationItem[] {
  const builtinMap: Record<BuiltinSettingsNavigationId, SettingsNavigationItem> = {
    ersteSchritte: {
      id: 'ersteSchritte',
      label: t('settings.ersteSchritte', { defaultValue: 'Erste Schritte' }),
      icon: <RocketLaunch />,
      path: 'erste-schritte',
    },
    model: { id: 'model', label: t('settings.model'), icon: <Cube />, path: 'model' },
    eveRuntime: {
      id: 'eveRuntime',
      label: t('settings.eveRuntime', { defaultValue: 'EVE-Runtime' }),
      icon: <Pulse />,
      path: 'eve-runtime',
    },
    capabilities: {
      id: 'capabilities',
      label: t('settings.capabilities', { defaultValue: 'Capabilities' }),
      icon: <Sparkle />,
      path: 'capabilities',
    },
    runtime: {
      id: 'runtime',
      label: t('settings.runtime', { defaultValue: 'Runtime' }),
      icon: <Heartbeat />,
      path: 'runtime',
    },
    connectors: {
      id: 'connectors',
      label: t('settings.connectors', { defaultValue: 'Connectoren' }),
      icon: <Link />,
      path: 'connectors',
    },
    authority: {
      id: 'authority',
      label: t('settings.authority', { defaultValue: 'Freigaben' }),
      icon: <UsersThree />,
      path: 'authority',
    },
    appearance: {
      id: 'appearance',
      label: t('settings.appearancePanel'),
      icon: <Computer />,
      path: 'appearance',
    },
    webui: {
      id: 'webui',
      label: t('settings.webui'),
      icon: isDesktop ? <Earth /> : <Communication />,
      path: 'webui',
    },
    pet: { id: 'pet', label: t('pet.desktopPet'), icon: <Cat />, path: 'pet' },
    privacy: {
      id: 'privacy',
      label: t('settings.privacy.navLabel', { defaultValue: 'Privacy' }),
      icon: <Lock />,
      path: 'privacy',
    },
    billing: {
      id: 'billing',
      label: t('settings.billing', { defaultValue: 'Billing' }),
      icon: <Wallet />,
      path: 'billing',
    },
    companyBrain: {
      id: 'companyBrain',
      label: t('settings.companyBrain', { defaultValue: 'Company Brain' }),
      icon: <Brain />,
      path: 'company-brain',
    },
    account: {
      id: 'account',
      label: t('settings.account', { defaultValue: 'Account' }),
      icon: <User />,
      path: 'account',
    },
    system: { id: 'system', label: t('settings.system'), icon: <System />, path: 'system' },
    about: { id: 'about', label: t('settings.about'), icon: <Info />, path: 'about' },
  };

  return BUILTIN_TAB_IDS.filter((id) => isDesktop || id !== 'pet').map((id) => builtinMap[id]);
}
