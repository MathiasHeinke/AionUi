/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { sessionStatusColor, sessionStatusLabelKey, type SessionStatus } from './sessionStatus';

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
 * Renders nothing for the `idle` status (and for `running`, which the row
 * already shows as a Spin in place of the avatar).
 */
const SessionStatusDot: React.FC<SessionStatusDotProps> = ({ status, overlay = false, className = '' }) => {
  const { t } = useTranslation();
  const color = sessionStatusColor(status);

  // `idle` (and `running`, surfaced as the row Spin) render no dot.
  if (!color || status === 'running') {
    return null;
  }

  const dot = (
    <span
      data-testid='session-status-dot'
      data-status={status}
      aria-label={t(sessionStatusLabelKey(status))}
      className={classNames(
        'block rounded-full w-8px h-8px',
        overlay ? 'absolute -bottom-1px -right-1px' : '',
        className
      )}
      style={{
        backgroundColor: color,
        // A 2px ring in the row background color so the dot reads cleanly on top
        // of the avatar (matches the old completion-dot's box-shadow approach;
        // UnoCSS-safe inline style rather than a ring-* utility).
        ...(overlay ? { boxShadow: '0 0 0 2px var(--color-bg-2)' } : {}),
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
