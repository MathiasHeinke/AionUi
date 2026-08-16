/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React from 'react';

export type EveIconTileTone = 'neutral' | 'action' | 'brand' | 'success' | 'warning' | 'danger';
export type EveIconTileSize = 'small' | 'medium' | 'large';

export interface EveIconTileProps extends React.HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode;
  tone?: EveIconTileTone;
  size?: EveIconTileSize;
  decorative?: boolean;
}

/** Alignment-only wrapper for naked Phosphor glyphs. */
const EveIconTile: React.FC<EveIconTileProps> = ({
  children,
  tone = 'neutral',
  size = 'medium',
  decorative = true,
  className,
  ...props
}) => (
  <span
    {...props}
    aria-hidden={decorative ? 'true' : props['aria-hidden']}
    className={classNames('eve-icon-tile', `eve-icon-tile--${size}`, className)}
    data-tone={tone}
  >
    {children}
  </span>
);

EveIconTile.displayName = 'EveIconTile';

export default EveIconTile;
