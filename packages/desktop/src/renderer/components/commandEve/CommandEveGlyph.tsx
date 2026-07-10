/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
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
    style={{ fontSize: size }}
    aria-hidden={decorative || undefined}
    data-testid='command-eve-glyph'
  >
    {'⌘'}
  </span>
);

export default CommandEveGlyph;
