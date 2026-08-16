/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Circular profile avatar (titlebar right side, desktop only).
 *
 * Shows the account initials derived from the local registration/session name;
 * when no name is available it falls back to the EVE glyph (⌘). Clicking it
 * opens the Account settings panel. Reads the LOCAL registration-status bridge
 * (no tokens) and self-quiets in non-desktop builds. PII (name/email) stays
 * local — only this chrome reads it.
 */

import React from 'react';
import { Tooltip } from '@arco-design/web-react';
import { User } from '@renderer/components/icons';
import { useTranslation } from 'react-i18next';
import CommandEveGlyph from '@/renderer/components/commandEve/CommandEveGlyph';
import { initialsFromName, useCommandEveProfile } from './useCommandEveProfile';
import './profileAvatar.css';

export { initialsFromName } from './useCommandEveProfile';

export interface ProfileAvatarProps {
  /** Open the account settings panel. */
  onOpenAccount?: () => void;
}

const ProfileAvatar: React.FC<ProfileAvatarProps> = ({ onOpenAccount }) => {
  const { t } = useTranslation();
  const { name, email } = useCommandEveProfile();

  const initials = initialsFromName(name);
  // Tooltip makes the "this opens your profile" intent explicit on hover.
  const profileHint = t('settings.accountPanel.openProfile', { defaultValue: 'Profil öffnen' });
  const tooltip = `${name || email || t('settings.accountPanel.title', { defaultValue: 'Account' })} · ${profileHint}`;

  return (
    <Tooltip content={tooltip} position='bottom'>
      <button
        type='button'
        // `profile-avatar--button` reads as a pill (person icon + initials) so it
        // is obviously a clickable "open profile" control, not a static badge.
        className='profile-avatar profile-avatar--button'
        onClick={() => onOpenAccount?.()}
        aria-label={tooltip}
        data-testid='profile-avatar'
      >
        {/* Person icon BEFORE the initials — the universal "this is your account /
            open profile" affordance (founder mandate 1.2.13). */}
        <User size={14} className='profile-avatar__person-icon' aria-hidden='true' />
        {initials ? (
          <span className='profile-avatar__initials'>{initials}</span>
        ) : (
          <span className='profile-avatar__glyph'>
            <CommandEveGlyph size={14} />
          </span>
        )}
      </button>
    </Tooltip>
  );
};

export default ProfileAvatar;
