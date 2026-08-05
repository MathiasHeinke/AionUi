/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { INITIAL_UPDATE_READY_PROMPT_STATE, reduceUpdateReadyPrompt } from '@/common/update/updateReadyPromptCore';
import { useAutoUpdateStatus } from '@renderer/hooks/system/useAutoUpdateStatus';

/**
 * Persistent, non-modal "update installed — restart now" banner.
 *
 * Command EVE downloads updates quietly in the background and used to wait for
 * a manual quit, so a stale build could keep running for days with the new
 * version already on disk. This banner closes that gap: once the updater
 * reports `downloaded`, it offers a quitAndInstall affordance. "Later" only
 * snoozes (UPDATE_READY_SNOOZE_MS) — the banner re-surfaces on the snooze
 * wake-up timer and on window focus, so a dismissed banner never strands the
 * user on the old build without any affordance. All show/hide decisions live
 * in the pure updateReadyPromptCore reducer; this component is only the shell.
 */
const UpdateReadyBanner: React.FC = () => {
  const { t } = useTranslation();
  const status = useAutoUpdateStatus();
  const [prompt, dispatch] = useReducer(reduceUpdateReadyPrompt, INITIAL_UPDATE_READY_PROMPT_STATE);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (status.status === 'idle') return;
    dispatch({ type: 'status', status });
  }, [status]);

  // Re-surface once the snooze expires, even while the window stays unfocused.
  const snoozedUntil = prompt.phase === 'snoozed' ? prompt.snoozedUntil : null;
  useEffect(() => {
    if (snoozedUntil === null) return;
    const timer = setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), Math.max(0, snoozedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [snoozedUntil]);

  // Re-surface on window focus once the snooze has expired.
  useEffect(() => {
    const onFocus = () => dispatch({ type: 'tick', now: Date.now() });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (prompt.phase !== 'visible') return null;

  const version = 'version' in status ? status.version : undefined;

  const handleDismiss = () => {
    dispatch({ type: 'dismiss', now: Date.now() });
  };

  const handleRestartNow = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await ipcBridge.autoUpdate.quitAndInstall.invoke();
      // On success the app quits and electron-updater performs the swap;
      // there is no "installed" UI state to reach.
    } catch (error) {
      console.error('quitAndInstall failed:', error);
      setInstalling(false);
      Message.error(t('update.errorTitle'));
    }
  };

  return (
    <div
      className='fixed bottom-24px left-1/2 z-100 flex items-center gap-16px max-w-560px rounded-8px px-16px py-12px bg-1 border-1 border-solid border-[var(--color-border-2)] shadow-lg -translate-x-1/2'
      data-testid='update-ready-banner'
      role='alert'
    >
      <div className='flex flex-col gap-2px min-w-0'>
        <span className='text-14px font-600 text-[var(--color-text-1)]'>{t('update.restartBannerTitle')}</span>
        <span className='text-12px text-[var(--color-text-2)]'>
          {t('update.restartBannerDescription', { version: version || '' })}
        </span>
      </div>
      <div className='flex items-center gap-8px shrink-0'>
        <Button
          size='small'
          type='text'
          disabled={installing}
          onClick={handleDismiss}
          data-testid='update-ready-banner-later'
        >
          {t('update.later')}
        </Button>
        <Button
          size='small'
          type='primary'
          loading={installing}
          icon={<Refresh size={14} />}
          onClick={() => {
            void handleRestartNow();
          }}
          data-testid='update-ready-banner-restart'
        >
          {t('update.installNow')}
        </Button>
      </div>
    </div>
  );
};

export default UpdateReadyBanner;
