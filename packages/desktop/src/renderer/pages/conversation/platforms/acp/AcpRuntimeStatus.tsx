import { ipcBridge } from '@/common';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { useIsDevMode } from '@/renderer/hooks/useIsDevMode';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Loading, Time } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AcpRuntimeActivity, AcpRuntimeActivityPhase } from './useAcpMessage';

const ACTIVE_PHASES = new Set<AcpRuntimeActivityPhase>([
  'connecting',
  'submitting',
  'thinking',
  'streaming',
  'tool_wait',
  'heartbeat_only',
  'ui_backlog',
]);
const LOCAL_MODEL_NOTICE_MS = 15_000;
const LONG_RUNNING_NOTICE_MS = 45_000;

const statusDotClass: Record<AcpRuntimeActivityPhase, string> = {
  idle: 'bg-fill-4',
  connecting: 'bg-warning-6',
  ready: 'bg-success-6',
  submitting: 'bg-warning-6',
  thinking: 'bg-primary-6',
  streaming: 'bg-primary-6',
  tool_wait: 'bg-warning-6',
  heartbeat_only: 'bg-warning-6',
  ui_backlog: 'bg-warning-6',
  done: 'bg-success-6',
  error: 'bg-danger-6',
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

const AcpRuntimeStatus: React.FC<{
  activity: AcpRuntimeActivity;
  running: boolean;
  aiProcessing: boolean;
}> = ({ activity, running, aiProcessing }) => {
  const { t } = useTranslation();
  // Founder/dev-only chrome: this log strip is hidden for operators (see the gate
  // below). The DSGVO egress notice is a SEPARATE, production-visible component
  // (EgressBoundaryNotice) so gating this strip never hides the compliance signal.
  const isDevMode = useIsDevMode();
  const [visible] = useConfig('commandEve.runtimeStatusVisible');
  const [now, setNow] = useState(Date.now());
  const isVisible = visible ?? true;
  const isActive = running || aiProcessing || ACTIVE_PHASES.has(activity.phase);

  useEffect(() => {
    if (!isVisible || !isActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive, isVisible]);

  const openLogs = useCallback(() => {
    void ipcBridge.application.systemInfo
      .invoke()
      .then((systemInfo) => {
        if (!systemInfo?.logDir) {
          Message.warning(t('conversation.runtimeStatus.logsUnavailable'));
          return;
        }
        return ipcBridge.shell.openFolderWith.invoke({ folder_path: systemInfo.logDir, tool: 'explorer' });
      })
      .catch(() => {
        Message.error(t('conversation.runtimeStatus.logsOpenFailed'));
      });
  }, [t]);

  const phaseLabel = useMemo(() => {
    const phase = isActive && activity.phase === 'ready' ? 'thinking' : activity.phase;
    return t(`conversation.runtimeStatus.phase.${phase}`, {
      defaultValue: phase,
    });
  }, [activity.phase, isActive, t]);

  // Operators never see this strip: hidden unless explicitly enabled AND in a dev
  // build. In packaged/production builds it is always hidden (isDevMode === false).
  if (!isVisible || !isDevMode) return null;

  const elapsedMs = activity.startedAt && isActive ? now - activity.startedAt : activity.elapsedMs;
  // Brand + privacy: the operator sees EVE + which LANE inference runs on (local = on-device,
  // a DSGVO selling point), NEVER the internal backend name ('hermes') or the raw engine model
  // id ('custom:command-eve-gemma4-*'). Newly visible once the status strip was mounted.
  const isLocalLane = /^custom:|gemma|command-eve/i.test(activity.modelId ?? '');
  const laneLabel = activity.modelId
    ? isLocalLane
      ? t('conversation.runtimeStatus.laneLocal', { defaultValue: 'lokal' })
      : t('conversation.runtimeStatus.laneCloud', { defaultValue: 'Cloud' })
    : t('conversation.runtimeStatus.modelUnknown');
  const hasContextUsage = typeof activity.contextUsed === 'number' && typeof activity.contextSize === 'number';
  const notice =
    isActive && elapsedMs && elapsedMs >= LONG_RUNNING_NOTICE_MS
      ? t('conversation.runtimeStatus.notice.longRunning')
      : // The "model is warming up / first answer is slow" notice only makes sense on
        // the LOCAL lane. On the cloud lane (V4 etc.) it's just wrong — a slow cloud
        // answer is not a local-model warmup — so suppress it there.
        isActive && isLocalLane && elapsedMs && elapsedMs >= LOCAL_MODEL_NOTICE_MS
        ? t('conversation.runtimeStatus.notice.localModel')
        : null;

  return (
    <div className='mb-8px flex items-start justify-between gap-12px px-12px py-8px rd-12px border border-solid border-border-2 bg-fill-1 text-12px text-t-secondary'>
      <div className='min-w-0 flex flex-col gap-4px'>
        <div className='min-w-0 flex items-center gap-8px'>
          <span
            className={`h-8px w-8px rd-50% shrink-0 ${statusDotClass[activity.phase]} ${isActive ? 'animate-pulse' : ''}`}
          />
          {isActive ? <Loading theme='outline' size='14' className='animate-spin shrink-0 text-primary-6' /> : null}
          <span className='font-500 text-t-primary'>{phaseLabel}</span>
          <span className='truncate'>EVE · {laneLabel}</span>
          {elapsedMs !== undefined ? (
            <span className='inline-flex items-center gap-4px text-t-tertiary'>
              <Time theme='outline' size='12' />
              {formatDuration(elapsedMs)}
            </span>
          ) : null}
          {hasContextUsage ? (
            <span className='text-t-tertiary'>
              {t('conversation.runtimeStatus.context', {
                used: formatTokens(activity.contextUsed as number),
                size: formatTokens(activity.contextSize as number),
              })}
            </span>
          ) : null}
        </div>
        {notice ? <div className='pl-16px text-t-tertiary'>{notice}</div> : null}
      </div>
      <Tooltip content={t('conversation.runtimeStatus.logsTooltip')}>
        <Button type='text' size='mini' onClick={openLogs}>
          {t('conversation.runtimeStatus.logs')}
        </Button>
      </Tooltip>
    </div>
  );
};

export default AcpRuntimeStatus;
