/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_ICON_CONFIGS, IconProvider, type IIconConfig } from '@icon-park/react/es/runtime';
import type { PropsWithChildren } from 'react';
import React from 'react';

/**
 * One ambient icon language for Command EVE.
 *
 * Icon Park remains the canonical source. Icons inherit their foreground from
 * the control around them, which keeps selected, disabled, Light and Dark
 * states in the same semantic color system as text and borders.
 */
export const PREMIUM_ICON_CONFIG: IIconConfig = {
  ...DEFAULT_ICON_CONFIGS,
  size: '1em',
  strokeWidth: 3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  theme: 'outline',
  colors: {
    outline: {
      fill: 'currentColor',
      background: 'transparent',
    },
    filled: {
      fill: 'currentColor',
      background: 'transparent',
    },
    twoTone: {
      fill: 'currentColor',
      twoTone: 'color-mix(in srgb, currentColor 18%, transparent)',
    },
    multiColor: {
      outStrokeColor: 'currentColor',
      outFillColor: 'color-mix(in srgb, currentColor 18%, transparent)',
      innerStrokeColor: 'currentColor',
      innerFillColor: 'color-mix(in srgb, currentColor 9%, transparent)',
    },
  },
};

const PremiumIconProvider: React.FC<PropsWithChildren> = ({ children }) => (
  <IconProvider value={PREMIUM_ICON_CONFIG}>{children}</IconProvider>
);

PremiumIconProvider.displayName = 'PremiumIconProvider';

export default PremiumIconProvider;
