/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { AlarmClock } from '@renderer/components/icons';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderScheduledEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const SiderScheduledEntry: React.FC<SiderScheduledEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={t('cron.scheduledTasks')} position='right'>
        <button
          type='button'
          aria-label={t('cron.scheduledTasks')}
          aria-current={isActive ? 'page' : undefined}
          className={classNames(
            'w-full h-34px flex items-center justify-center cursor-pointer border-0 bg-transparent p-0 transition-colors rd-8px text-t-primary',
            isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={onClick}
        >
          <AlarmClock size='20' className='block leading-none shrink-0' style={{ lineHeight: 0 }} />
        </button>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content={t('cron.scheduledTasks')} position='right'>
      <button
        type='button'
        aria-current={isActive ? 'page' : undefined}
        className={classNames(
          'box-border group h-34px w-full flex items-center justify-start gap-8px border-0 bg-transparent pl-10px pr-8px rd-0.5rem cursor-pointer shrink-0 transition-all text-left text-t-primary',
          isMobile && 'sider-action-btn-mobile',
          isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
      >
        <span className='size-22px flex items-center justify-center shrink-0 text-t-primary'>
          <AlarmClock size='16' className='block leading-none' style={{ lineHeight: 0 }} />
        </span>
        <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px'>
          {t('cron.scheduledTasks')}
        </span>
      </button>
    </Tooltip>
  );
};

export default SiderScheduledEntry;
