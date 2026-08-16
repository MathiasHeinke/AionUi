/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { IconContext, type IconProps } from '@phosphor-icons/react';
import type { PropsWithChildren } from 'react';
import React from 'react';

/**
 * One ambient icon language for Command EVE.
 *
 * Phosphor is the canonical source. Icons inherit their foreground from the
 * control around them, which keeps selected, disabled, Light and Dark states
 * in the same semantic color system as text and borders.
 */
export const PREMIUM_ICON_CONFIG: IconProps = {
  color: 'currentColor',
  size: '1em',
  weight: 'regular',
};

const PremiumIconProvider: React.FC<PropsWithChildren> = ({ children }) => (
  <IconContext.Provider value={PREMIUM_ICON_CONFIG}>{children}</IconContext.Provider>
);

PremiumIconProvider.displayName = 'PremiumIconProvider';

export default PremiumIconProvider;
