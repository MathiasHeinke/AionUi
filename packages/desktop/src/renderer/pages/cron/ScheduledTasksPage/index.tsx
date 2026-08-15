/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button, Switch, Message, Empty, Spin, Tooltip } from '@arco-design/web-react';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import { useAllCronJobs } from '@renderer/pages/cron/useCronJobs';
import { formatSchedule, formatNextRun } from '@renderer/pages/cron/cronUtils';
import { systemSettings, type ICronJob } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { useConversationAgents } from '@renderer/pages/conversation/hooks/useConversationAgents';
import CronStatusTag from './CronStatusTag';
import CreateTaskDialog from './CreateTaskDialog';
import { getJobAgentMeta } from './jobAgentMeta';
import { AddOne, CalendarThirty } from '@icon-park/react';

const ScheduledTasksPage: React.FC = () => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { jobs, loading, pauseJob, resumeJob } = useAllCronJobs();
  const { cliAgents } = useConversationAgents();
  const [createDialogVisible, setCreateDialogVisible] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);

  useEffect(() => {
    setKeepAwake(configService.get('system.keepAwake') ?? false);
  }, []);

  const handleKeepAwakeChange = useCallback(async (enabled: boolean) => {
    setKeepAwake(enabled);
    configService.setLocal('system.keepAwake', enabled);
    try {
      await systemSettings.setKeepAwake.invoke({ enabled });
    } catch (err) {
      setKeepAwake(!enabled);
      configService.setLocal('system.keepAwake', !enabled);
      Message.error(String(err));
    }
  }, []);

  const handleGoToDetail = useCallback(
    (job: ICronJob) => {
      navigate(`/scheduled/${job.id}`);
    },
    [navigate]
  );

  const handleToggleEnabled = useCallback(
    async (job: ICronJob) => {
      try {
        if (job.enabled) {
          await pauseJob(job.id);
          Message.success(t('cron.pauseSuccess'));
        } else {
          await resumeJob(job.id);
          Message.success(t('cron.resumeSuccess'));
        }
      } catch (err) {
        Message.error(String(err));
      }
    },
    [pauseJob, resumeJob, t]
  );

  return (
    <div
      className={classNames(
        'eve-page w-full min-h-full box-border overflow-y-auto',
        isMobile ? 'px-16px py-14px' : 'px-12px py-24px md:px-40px md:py-32px'
      )}
    >
      <div
        className={classNames(
          'mx-auto flex w-full max-w-800px box-border flex-col',
          isMobile ? 'gap-14px' : 'gap-16px'
        )}
      >
        <div className='eve-page-header'>
          <div className='eve-page-header__copy'>
            <div className='flex w-full flex-col gap-6px'>
              <div className='flex w-full items-start justify-between gap-12px sm:gap-16px max-[520px]:flex-wrap'>
                <h1
                  className={classNames(
                    'eve-page-title min-w-0 flex-1',
                    isMobile ? 'text-24px leading-[1.2]' : 'text-28px leading-[1.15]'
                  )}
                >
                  {t('cron.scheduledTasks')}
                </h1>
              </div>
              <p
                className={classNames(
                  'eve-page-subtitle w-full',
                  isMobile ? 'text-13px leading-20px' : 'text-14px leading-22px'
                )}
              >
                {t('cron.page.description')}
              </p>
            </div>
          </div>
          <div className='eve-page-header__action'>
            <Button
              type='primary'
              shape='round'
              icon={<AddOne />}
              className='shrink-0'
              onClick={() => setCreateDialogVisible(true)}
            >
              {t('cron.page.newTask')}
            </Button>
          </div>
        </div>

        <div className='eve-panel grid w-full box-border grid-cols-[minmax(0,1fr)_auto] items-center gap-x-12px gap-y-10px px-14px py-12px sm:px-16px max-[520px]:grid-cols-1'>
          <span
            className={classNames(
              'min-w-0 text-t-primary',
              isMobile ? 'text-12px leading-18px' : 'text-13px leading-20px'
            )}
          >
            {t('cron.page.awakeBanner')}
          </span>
          <div className='justify-self-end max-[520px]:justify-self-start'>
            <Tooltip content={t('cron.page.keepAwakeTooltip')}>
              <div className='flex items-center gap-8px text-t-secondary text-12px leading-18px sm:text-13px'>
                <span>{t('cron.page.keepAwake')}</span>
                <Switch size='small' checked={keepAwake} onChange={handleKeepAwakeChange} />
              </div>
            </Tooltip>
          </div>
        </div>

        {loading ? (
          <div className='eve-empty-state flex min-h-220px items-center justify-center'>
            <Spin />
          </div>
        ) : jobs.length === 0 ? (
          <div className='eve-empty-state flex min-h-220px items-center justify-center'>
            <Empty
              icon={
                <span className='eve-empty-state__icon' aria-hidden='true'>
                  <CalendarThirty size={30} />
                </span>
              }
              description={t('cron.noTasks')}
            />
          </div>
        ) : (
          <div
            className={classNames(
              'grid w-full items-start grid-cols-1 gap-12px',
              isMobile ? '' : 'sm:grid-cols-2 lg:grid-cols-3'
            )}
          >
            {jobs.map((job) => {
              const agentMeta = getJobAgentMeta(job, cliAgents);
              const isManualOnly = job.schedule.kind === 'cron' && !job.schedule.expr;
              const executionModeLabel =
                job.target.execution_mode === 'new_conversation'
                  ? t('cron.page.form.newConversation')
                  : t('cron.page.form.existingConversation');

              return (
                <div
                  key={job.id}
                  className={classNames(
                    'eve-panel group relative flex flex-col border border-solid transition-colors duration-300 hover:border-[var(--color-border-3)] hover:shadow-sm',
                    isMobile ? 'rounded-8px px-16px py-16px' : 'rounded-8px px-20px py-18px'
                  )}
                >
                  <button
                    type='button'
                    aria-label={job.name}
                    className='flex w-full cursor-pointer flex-col border-none bg-transparent p-0 text-left'
                    onClick={() => handleGoToDetail(job)}
                  >
                    <span className='mb-12px flex items-center justify-between gap-8px'>
                      <span
                        className={classNames(
                          'mr-8px min-w-0 flex-1 font-medium text-t-primary',
                          isMobile ? 'truncate text-14px leading-20px' : 'truncate text-15px leading-22px'
                        )}
                      >
                        {job.name}
                      </span>
                      <CronStatusTag job={job} />
                    </span>

                    <span
                      className={classNames(
                        'min-w-0 break-words text-t-secondary',
                        isMobile ? 'text-13px leading-20px' : 'text-14px leading-22px'
                      )}
                      title={formatSchedule(job, t)}
                    >
                      {formatSchedule(job, t)}
                    </span>

                    <span
                      className='mt-16px min-w-0 break-words text-t-secondary text-13px leading-20px'
                      title={
                        job.state.next_run_at_ms
                          ? `${t('cron.nextRun')} ${formatNextRun(job.state.next_run_at_ms)}`
                          : '-'
                      }
                    >
                      {job.state.next_run_at_ms
                        ? `${t('cron.nextRun')} ${formatNextRun(job.state.next_run_at_ms)}`
                        : '-'}
                    </span>

                    <span
                      className={classNames(
                        'mt-14px flex min-w-0 items-center gap-6px text-12px leading-18px text-t-secondary',
                        !isManualOnly && 'pr-42px'
                      )}
                    >
                      {agentMeta.name ? (
                        <Tooltip content={agentMeta.name}>
                          <span className='flex h-16px w-16px shrink-0 items-center justify-center text-t-secondary'>
                            {agentMeta.logo ? (
                              <img
                                src={agentMeta.logo}
                                alt={agentMeta.name}
                                className='h-16px w-16px shrink-0 rounded-50%'
                              />
                            ) : (
                              <span className='flex h-16px w-16px items-center justify-center rounded-50% text-10px font-medium text-t-secondary'>
                                {agentMeta.name.slice(0, 1)}
                              </span>
                            )}
                          </span>
                        </Tooltip>
                      ) : null}
                      <span className='min-w-0 truncate'>{executionModeLabel}</span>
                    </span>
                  </button>

                  {!isManualOnly && (
                    <div
                      className={classNames('absolute', isMobile ? 'bottom-16px right-16px' : 'bottom-18px right-20px')}
                    >
                      <Switch
                        size='small'
                        aria-label={job.name}
                        checked={job.enabled}
                        onChange={() => handleToggleEnabled(job)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <CreateTaskDialog visible={createDialogVisible} onClose={() => setCreateDialogVisible(false)} />
      </div>
    </div>
  );
};

export default ScheduledTasksPage;
