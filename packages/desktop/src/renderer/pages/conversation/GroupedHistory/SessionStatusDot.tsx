/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { sessionStatusColor, sessionStatusLabelKey, sessionStatusShape, type SessionStatus } from './sessionStatus';

interface SessionStatusDotProps {
  status: SessionStatus;
  /**
   * When true, the dot is an overlay pinned to the bottom-right of the leading
   * icon (presence-dot style, with a ring that matches the row background so it
   * reads cleanly on top of the avatar). When false, it renders inline.
   */
  overlay?: boolean;
  className?: string;
}

/**
 * A single, semantic status dot for a session row — the ONE consistent status
 * mark that replaces the previous mix of unread dots, cron glyphs and avatars.
 * Renders nothing only for the `idle` status. `running` renders as an animated
 * pulsing ring (CSS: `session-status-dot[data-status='running']`) so a live
 * turn is unmistakable on every row, including non-selected background rows.
 */
const SessionStatusDot: React.FC<SessionStatusDotProps> = ({ status, overlay = false, className = '' }) => {
  const { t } = useTranslation();
  const color = sessionStatusColor(status);
  const shape = sessionStatusShape(status);

  // Only `idle` renders nothing.
  if (!color) {
    return null;
  }

  const dot = (
    <span
      data-testid='session-status-dot'
      data-status={status}
      data-shape={shape}
      aria-label={t(sessionStatusLabelKey(status))}
      className={classNames(
        'session-status-dot block w-8px h-8px',
        overlay ? 'absolute -bottom-1px -right-1px' : '',
        className
      )}
      style={{
        backgroundColor: color,
        ...(overlay ? { boxShadow: '0 0 0 2px var(--eve-status-ring, var(--color-bg-2))' } : {}),
      }}
    />
  );

  return (
    <Tooltip content={t(sessionStatusLabelKey(status))} mini position='right'>
      {dot}
    </Tooltip>
  );
};

export default SessionStatusDot;
