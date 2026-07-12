/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICronTriggerArtifact } from '@/common/adapter/ipcBridge';
import { iconColors } from '@/renderer/styles/colors';
import { AlarmClock, Right } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

const MessageCronTrigger: React.FC<{ artifact: ICronTriggerArtifact }> = ({ artifact }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const rawContent = artifact.payload as
    | ICronTriggerArtifact['payload']
    | {
        cronJobId?: string;
        cronJobName?: string;
        triggeredAt?: number;
      }
    | string;
  const parseContent = () => {
    if (typeof rawContent !== 'string') {
      return rawContent;
    }
    try {
      return JSON.parse(rawContent) as
        | ICronTriggerArtifact['payload']
        | {
            cronJobId?: string;
            cronJobName?: string;
            triggeredAt?: number;
          };
    } catch {
      return {} as ICronTriggerArtifact['payload'];
    }
  };
  const parsedContent = parseContent();
  const cron_job_id = 'cron_job_id' in parsedContent ? parsedContent.cron_job_id : (parsedContent.cronJobId ?? '');
  const cron_job_name =
    'cron_job_name' in parsedContent ? parsedContent.cron_job_name : (parsedContent.cronJobName ?? '');

  return (
    <button
      type='button'
      data-testid='message-cron-trigger'
      className='max-w-780px w-full mx-auto px-16px py-12px border border-solid rd-8px bg-transparent hover:bg-[var(--eve-row-hover-bg)] transition-colors cursor-pointer flex items-center gap-8px text-left font-inherit'
      style={{ borderColor: 'var(--glass-panel-border)' }}
      onClick={() => navigate(`/scheduled/${cron_job_id}`)}
    >
      <AlarmClock
        theme='outline'
        size={18}
        fill={iconColors.secondary}
        className='block leading-none shrink-0'
        style={{ lineHeight: 0 }}
      />
      <span className='flex-1 text-14px truncate text-t-primary'>
        {t('cron.trigger.runScheduledTask', { name: cron_job_name })}
      </span>
      <Right
        theme='outline'
        size={16}
        fill={iconColors.secondary}
        className='block leading-none shrink-0'
        style={{ lineHeight: 0 }}
      />
    </button>
  );
};

export default MessageCronTrigger;
