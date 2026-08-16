/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { webui } from '@/common/adapter/ipcBridge';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import { Tooltip } from '@arco-design/web-react';
import { Comment, Earth, WebPage } from '@renderer/components/icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import styles from '../index.module.css';

type QuickActionButtonsProps = {
  onOpenLink: (url: string) => void;
  onOpenBugReport: () => void;
};

type WebuiQuickStatus = 'checking' | 'running' | 'stopped' | 'error';

const WEBUI_STATUS_CACHE_TTL_MS = 3000;
let webuiStatusCache: {
  quickStatus: WebuiQuickStatus;
  at: number;
} | null = null;

const QuickActionButtons: React.FC<QuickActionButtonsProps> = ({ onOpenLink, onOpenBugReport }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [webuiQuickStatus, setWebuiQuickStatus] = useState<WebuiQuickStatus>('checking');

  useEffect(() => {
    let alive = true;
    const loadStatus = async () => {
      const now = Date.now();
      if (webuiStatusCache && now - webuiStatusCache.at < WEBUI_STATUS_CACHE_TTL_MS) {
        setWebuiQuickStatus(webuiStatusCache.quickStatus);
        return;
      }

      try {
        const result = await webui.getStatus.invoke();
        if (!alive) return;
        if (result) {
          const quickStatus: WebuiQuickStatus = result.running ? 'running' : 'stopped';
          setWebuiQuickStatus(quickStatus);
          webuiStatusCache = { quickStatus, at: Date.now() };
          return;
        }
        setWebuiQuickStatus('error');
        webuiStatusCache = { quickStatus: 'error', at: Date.now() };
      } catch {
        if (!alive) return;
        setWebuiQuickStatus('error');
        webuiStatusCache = { quickStatus: 'error', at: Date.now() };
      }
    };

    void loadStatus();

    const unsubscribe = webui.statusChanged.on((payload) => {
      const nextQuickStatus: WebuiQuickStatus = payload.running ? 'running' : 'stopped';
      setWebuiQuickStatus(nextQuickStatus);
      webuiStatusCache = { quickStatus: nextQuickStatus, at: Date.now() };
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const handleOpenWebUI = useCallback(() => {
    void navigate('/settings/webui');
  }, [navigate]);

  const webuiStatusLabel =
    webuiQuickStatus === 'running'
      ? t('settings.webui.running', { defaultValue: 'Running' })
      : webuiQuickStatus === 'checking'
        ? t('settings.webui.starting', { defaultValue: 'Checking' })
        : webuiQuickStatus === 'error'
          ? t('settings.webui.operationFailed', { defaultValue: 'Unavailable' })
          : t('settings.webui.enable', { defaultValue: 'Start' });
  const webuiIconColor =
    webuiQuickStatus === 'running'
      ? 'rgb(var(--success-6))'
      : webuiQuickStatus === 'checking'
        ? 'rgb(var(--primary-6))'
        : webuiQuickStatus === 'error'
          ? 'var(--color-text-3)'
          : 'var(--color-text-4)';
  const feedbackLabel = t('conversation.welcome.quickActionFeedback');
  const websiteLabel = COMMAND_EVE_SHELL_ENABLED ? t('common.website') : t('conversation.welcome.quickActionStar');
  const webuiLabel = `${t('settings.webui', { defaultValue: 'WebUI' })} · ${webuiStatusLabel}`;

  return (
    <div
      className={`absolute left-50% -translate-x-1/2 flex flex-col justify-center items-center ${styles.guidQuickActions}`}
    >
      <div className={styles.guidQuickActionsToolbar} role='group'>
        <Tooltip content={feedbackLabel} position='top' trigger={['hover', 'focus']}>
          <button
            type='button'
            className={styles.guidQuickActionButton}
            onClick={onOpenBugReport}
            aria-label={feedbackLabel}
            data-testid='guid-quick-action-feedback'
          >
            <Comment size={20} aria-hidden='true' />
          </button>
        </Tooltip>
        <Tooltip content={websiteLabel} position='top' trigger={['hover', 'focus']}>
          <button
            type='button'
            className={styles.guidQuickActionButton}
            onClick={() =>
              onOpenLink(COMMAND_EVE_SHELL_ENABLED ? 'https://command-eve.com' : 'https://github.com/iOfficeAI/AionUi')
            }
            aria-label={websiteLabel}
            data-testid='guid-quick-action-website'
          >
            <WebPage size={20} aria-hidden='true' />
          </button>
        </Tooltip>
        <Tooltip content={webuiLabel} position='top' trigger={['hover', 'focus']}>
          <button
            type='button'
            className={styles.guidQuickActionButton}
            onClick={handleOpenWebUI}
            aria-label={webuiLabel}
            data-testid='guid-quick-action-webui'
          >
            <Earth size={20} style={{ color: webuiIconColor }} aria-hidden='true' />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

export default QuickActionButtons;
