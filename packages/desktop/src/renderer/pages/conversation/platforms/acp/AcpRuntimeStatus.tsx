import { ipcBridge } from '@/common';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import { COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT } from '@/common/config/eveContextPolicyCore';
import { isEveInferenceSelection } from '@/common/config/eveInferenceCore';
import { useEveInferenceSelection } from '@/renderer/hooks/agent/useEveInferenceSelection';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { useIsDevMode } from '@/renderer/hooks/useIsDevMode';
import { resolveEffectiveContextLimit } from '@/renderer/utils/model/modelContextLimits';
import { emitAcpPerformanceMark } from '@/renderer/utils/performance/acpPerformanceMarks';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Shield, Time } from '@renderer/components/icons';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EgressBoundaryStatus } from './EgressBoundaryNotice';
import type { AcpRuntimeActivity, AcpRuntimeActivityPhase } from './useAcpMessage';

const ACTIVE_PHASES = new Set<AcpRuntimeActivityPhase>([
  'connecting',
  'submitting',
  'thinking',
  'provider_wait',
  'retry_wait',
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
  provider_wait: 'bg-warning-6',
  retry_wait: 'bg-warning-6',
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
  if (tokens === COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT) {
    return '256k';
  }
  if (tokens >= 1024) {
    const kiloTokens = tokens / 1024;
    return `${Number.isInteger(kiloTokens) ? kiloTokens.toFixed(0) : kiloTokens.toFixed(1)}k`;
  }
  return String(tokens);
}

const AcpRuntimeStatus: React.FC<{
  activity: AcpRuntimeActivity;
  running: boolean;
  aiProcessing: boolean;
  conversationId?: string;
  backend?: string;
  egressBoundary?: EgressBoundaryStatus | null;
}> = ({ activity, running, aiProcessing, conversationId, backend, egressBoundary }) => {
  const { t } = useTranslation();
  // Operators see a redacted lifecycle line while work is active. Dev mode adds
  // lane/context/log details, but raw backend and model identifiers never become
  // part of the customer-facing status contract.
  const isDevMode = useIsDevMode();
  const [visible] = useConfig('commandEve.runtimeStatusVisible');
  const eveInference = useEveInferenceSelection();
  const [now, setNow] = useState(Date.now());
  const visibleSubmitAttemptRef = useRef<string | null>(null);
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
    const phase =
      isActive && (activity.phase === 'idle' || activity.phase === 'ready' || activity.phase === 'done')
        ? 'thinking'
        : activity.phase;
    return t(`conversation.runtimeStatus.phase.${phase}`, {
      defaultValue: phase,
    });
  }, [activity.phase, isActive, t]);
  const retryLabel =
    activity.phase === 'retry_wait' && activity.retryAfterMs !== undefined
      ? t('conversation.runtimeStatus.retryDetail', {
          seconds: Math.max(0, Math.ceil(activity.retryAfterMs / 1000)),
          attempt: activity.attempt,
          maxAttempts: activity.maxAttempts,
        })
      : null;

  const egressDecision = egressBoundary?.decision;
  const egressLabel =
    egressDecision === 'block'
      ? t('conversation.runtimeStatus.egress.blockedCompact', { defaultValue: 'Sensible Daten blockiert' })
      : egressDecision === 'redact'
        ? t('conversation.runtimeStatus.egress.redactedCompact', { defaultValue: 'Sensible Daten bereinigt' })
        : null;
  const showOperatorStatus = isActive || activity.phase === 'error' || Boolean(egressLabel);
  useLayoutEffect(() => {
    if (
      !isVisible ||
      !showOperatorStatus ||
      activity.phase !== 'submitting' ||
      !conversationId ||
      !Number.isSafeInteger(activity.attemptId)
    ) {
      return;
    }
    const key = `${conversationId}:${activity.seatGeneration ?? 'unknown'}:${activity.attemptId}`;
    if (visibleSubmitAttemptRef.current === key) return;
    visibleSubmitAttemptRef.current = key;
    emitAcpPerformanceMark({
      stage: 'runtime_activity_visible',
      conversationId,
      attemptId: activity.attemptId,
      seatGeneration: activity.seatGeneration,
      turnId: activity.turnId,
    });
  }, [
    activity.attemptId,
    activity.phase,
    activity.seatGeneration,
    activity.turnId,
    conversationId,
    isVisible,
    showOperatorStatus,
  ]);
  if (!isVisible || (!isDevMode && !showOperatorStatus)) return null;

  const elapsedMs = activity.startedAt && isActive ? now - activity.startedAt : activity.elapsedMs;
  // Brand + privacy: the operator sees EVE + which LANE inference runs on (local = on-device,
  // a DSGVO selling point), NEVER the internal backend name ('hermes') or the raw engine model
  // id ('custom:command-eve-gemma4-*'). Newly visible once the status strip was mounted.
  const isEveConversation = isCommandEveAcpConversation(backend);
  // The selected lane is the display-policy truth. Bearer presence is checked
  // fail-closed by the send boundary, but it loads asynchronously and must not
  // make an active EVE cloud turn flicker back to Hermes' local 64k telemetry.
  const cloudSelectionActive = isEveConversation && isEveInferenceSelection(eveInference.selection);
  const selectedLaneKnown = isEveConversation && Boolean(eveInference.selectedItem);
  const effectiveModelId = cloudSelectionActive ? eveInference.selection : activity.modelId;
  const isLocalLane = isEveConversation
    ? !cloudSelectionActive
    : /^custom:|gemma|command-eve/i.test(activity.modelId ?? '');
  const laneLabel =
    activity.modelId || selectedLaneKnown
      ? isLocalLane
        ? t('conversation.runtimeStatus.laneLocal', { defaultValue: 'lokal' })
        : t('conversation.runtimeStatus.laneCloud', { defaultValue: 'Cloud' })
      : t('conversation.runtimeStatus.modelUnknown');
  const hasContextUsage = typeof activity.contextUsed === 'number' && typeof activity.contextSize === 'number';
  const effectiveContextSize = hasContextUsage
    ? resolveEffectiveContextLimit(effectiveModelId, activity.contextSize)
    : undefined;
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
    <div
      className='acp-runtime-status'
      data-testid='acp-runtime-status'
      data-ttft-attempt-id={activity.attemptId}
      data-ttft-turn-id={activity.turnId}
    >
      <div className='acp-runtime-status__content'>
        <span
          className={`h-8px w-8px rd-50% shrink-0 ${statusDotClass[activity.phase]} ${isActive ? 'animate-pulse' : ''} ${activity.phase === 'thinking' || activity.phase === 'streaming' ? 'acp-runtime-status__dot--active' : ''}`}
        />
        <span className='font-500 text-t-primary'>{phaseLabel}</span>
        {retryLabel ? <span className='acp-runtime-status__notice'>{retryLabel}</span> : null}
        {isDevMode ? <span className='truncate'>EVE · {laneLabel}</span> : null}
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
              size: formatTokens(effectiveContextSize as number),
            })}
          </span>
        ) : null}
        {notice ? (
          <span className='acp-runtime-status__notice' title={notice}>
            {notice}
          </span>
        ) : null}
        {!isDevMode && activity.phase === 'tool_wait' && activity.detail ? (
          <span className='acp-runtime-status__notice' title={activity.detail}>
            {t('conversation.runtimeStatus.toolDetail', { tool: activity.detail })}
          </span>
        ) : null}
        {egressLabel ? (
          <Tooltip
            content={[
              egressLabel,
              t('conversation.runtimeStatus.egress.findingCount', {
                count: egressBoundary?.finding_count ?? 0,
                defaultValue: '{{count}} Treffer',
              }),
              egressBoundary?.observed_at
                ? new Date(egressBoundary.observed_at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : null,
              t('conversation.runtimeStatus.egress.compactHint', {
                defaultValue: 'Originalwerte werden nicht angezeigt.',
              }),
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <span
              className={`acp-runtime-status__privacy ${egressDecision === 'block' ? 'text-danger-6' : ''}`}
              data-testid='acp-runtime-egress-receipt'
            >
              <Shield theme='outline' size='12' />
              <span>{egressLabel}</span>
              <span aria-label={t('conversation.runtimeStatus.egress.findings', { defaultValue: 'Treffer' })}>
                {egressBoundary?.finding_count ?? 0}
              </span>
            </span>
          </Tooltip>
        ) : null}
      </div>
      {isDevMode ? (
        <Tooltip content={t('conversation.runtimeStatus.logsTooltip')}>
          <Button className='acp-runtime-status__logs' type='text' size='mini' onClick={openLogs}>
            {t('conversation.runtimeStatus.logs')}
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
};

export default AcpRuntimeStatus;
