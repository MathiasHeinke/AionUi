/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { ArrowCircleLeft, CloseOne, Download, Moon, SunOne } from '@icon-park/react';
import classNames from 'classnames';
import CommandEveGlyph from '@renderer/components/commandEve/CommandEveGlyph';
import { initialsFromName, useCommandEveProfile } from '@renderer/components/account/useCommandEveProfile';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import './SiderFooter.css';

interface SiderFooterProps {
  isMobile: boolean;
  isSettings: boolean;
  collapsed?: boolean;
  theme: string;
  siderTooltipProps: SiderTooltipProps;
  onSettingsClick: () => void;
  onThemeToggle: () => void;
  showLogout?: boolean;
  onLogoutClick?: () => void;
}

const openUpdateModal = () => {
  window.dispatchEvent(new Event('aionui-open-update-modal'));
};

const SiderFooter: React.FC<SiderFooterProps> = ({
  isMobile,
  isSettings,
  collapsed = false,
  theme,
  siderTooltipProps,
  onSettingsClick,
  onThemeToggle,
  showLogout = false,
  onLogoutClick,
}) => {
  const { t } = useTranslation();
  const { name, email } = useCommandEveProfile();
  const displayName = name || email || 'Command EVE';
  const initials = initialsFromName(name);
  const identityLabel = isSettings ? t('common.back') : displayName;
  const settingsTooltip = isSettings ? t('common.back') : `${displayName} · ${t('common.settings')}`;
  const updateLabel = t('update.modalTitle');
  const updateHint = t('settings.checkForUpdates');
  const showThemeToggle = isSettings && !collapsed;
  const themeTooltip = theme === 'dark' ? t('settings.lightMode') : t('settings.darkMode');

  return (
    <footer className='sider-footer'>
      <div className={classNames('sider-footer__row', collapsed && 'sider-footer__row--collapsed')}>
        <Tooltip {...siderTooltipProps} content={settingsTooltip} position='right'>
          <button
            type='button'
            onClick={onSettingsClick}
            className={classNames(
              'sider-footer__identity',
              isSettings && 'sider-footer__identity--active',
              isMobile && 'sider-footer-btn-mobile'
            )}
            aria-label={settingsTooltip}
            data-testid='sider-footer-identity'
          >
            <span className='sider-footer__avatar' aria-hidden='true'>
              {isSettings ? <ArrowCircleLeft size={16} /> : initials ? initials : <CommandEveGlyph size={15} />}
            </span>
            <span className='sider-footer__identity-label collapsed-hidden'>{identityLabel}</span>
          </button>
        </Tooltip>

        <div className='sider-footer__controls'>
          {showLogout && onLogoutClick && (
            <Tooltip {...siderTooltipProps} content={t('settings.googleLogout')} position='right'>
              <button
                type='button'
                onClick={onLogoutClick}
                className={classNames('sider-footer__icon-button', isMobile && 'sider-footer-btn-mobile')}
                aria-label={t('settings.googleLogout')}
              >
                <CloseOne size={16} />
              </button>
            </Tooltip>
          )}

          {showThemeToggle && (
            <Tooltip {...siderTooltipProps} content={themeTooltip} position='right'>
              <button
                type='button'
                onClick={onThemeToggle}
                className={classNames('sider-footer__icon-button', isMobile && 'sider-footer-btn-mobile')}
                aria-label={themeTooltip}
              >
                {theme === 'dark' ? <SunOne size={17} /> : <Moon size={17} />}
              </button>
            </Tooltip>
          )}

          <Tooltip {...siderTooltipProps} content={updateHint} position='right'>
            <button
              type='button'
              onClick={openUpdateModal}
              className={classNames(
                'sider-footer__update',
                (collapsed || isSettings) && 'sider-footer__update--compact',
                isMobile && 'sider-footer-btn-mobile'
              )}
              aria-label={updateHint}
              data-testid='sider-footer-update'
            >
              <Download size={16} className='sider-footer__update-icon' />
              <span className='sider-footer__update-label'>{updateLabel}</span>
            </button>
          </Tooltip>
        </div>
      </div>
    </footer>
  );
};

export default SiderFooter;
