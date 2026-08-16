/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import { Command } from '@renderer/components/icons';
import React from 'react';

export type CommandEveGlyphProps = {
  size?: number;
  className?: string;
  decorative?: boolean;
};

/** Transparent in-app EVE identity. Packaged app icons keep their square asset. */
const CommandEveGlyph: React.FC<CommandEveGlyphProps> = ({ size = 20, className, decorative = true }) => (
  <span
    className={classNames('command-eve-glyph', className)}
    style={{ width: size, height: size }}
    aria-hidden={decorative || undefined}
    aria-label={decorative ? undefined : 'Command EVE'}
    role={decorative ? undefined : 'img'}
    data-testid='command-eve-glyph'
  >
    <Command size={size} aria-hidden='true' />
  </span>
);

export default CommandEveGlyph;
