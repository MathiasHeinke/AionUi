/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Theme } from '@/common/theme/types';
import { LIGHT_THEME_ID, DARK_THEME_ID } from '@/common/theme/constants';

import {
  defaultThemeCover,
  retroWindowsCover,
  retromaObsidianBookCover,
} from '@renderer/pages/settings/AppearanceSettings/themeCovers';

import retroWindowsCss from '@renderer/pages/settings/AppearanceSettings/presets/retro-windows.css?raw';
import retromaObsidianBookCss from '@renderer/pages/settings/AppearanceSettings/presets/retroma-obsidian-book.css?raw';
import discourseHorizonCss from '@renderer/pages/settings/AppearanceSettings/presets/discourse-horizon.css?raw';
import glitteringInputFieldCss from '@renderer/pages/settings/AppearanceSettings/presets/glittering-input-field.css?raw';

const T0 = 0;

const decorative = (id: string, name: string, appearance: Theme['appearance'], css: string, cover?: string): Theme => ({
  id,
  name,
  appearance,
  css,
  cover,
  builtin: true,
  created_at: T0,
  updated_at: T0,
});

export const BUILTIN_THEMES: Theme[] = [
  {
    id: LIGHT_THEME_ID,
    name: 'EVE',
    appearance: 'light',
    cover: defaultThemeCover,
    builtin: true,
    created_at: T0,
    updated_at: T0,
  },
  { id: DARK_THEME_ID, name: 'Dark', appearance: 'dark', builtin: true, created_at: T0, updated_at: T0 },
  decorative('retro-windows', 'Retro Windows', 'light', retroWindowsCss, retroWindowsCover),
  decorative(
    'retroma-obsidian-book',
    'Retroma Obsidian Book',
    'dark',
    retromaObsidianBookCss,
    retromaObsidianBookCover
  ),
  decorative('discourse-horizon', 'Discourse Horizon', 'light', discourseHorizonCss),
  decorative('glittering-input-field', 'Glittering Input Field', 'light', glitteringInputFieldCss),
];

export const BUILTIN_THEME_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));
