/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DelegatedTaskProjection } from '@/common/chat/delegationActivity';
import {
  durableWorkRuntimeMs,
  type DurableWorkAction,
  type DurableWorkItemV1,
  type DurableWorkStatus,
} from '@/common/runtime/durableWorkActivity';
import { eveTeamWorkerLabel } from '@/common/config/eveTeamRoster';
import {
  requestDurableWorkAction,
  useDurableWorkActivity,
} from '@/renderer/pages/conversation/runtime/durableWorkActivityAdapter';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Pause, PlayOne, Power, Redo, Right, Robot, Time } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './styles.module.css';

export type DurableWorkActivityProps = {
  conversationId: string;
  legacyTasks?: readonly DelegatedTaskProjection[];
  mode?: 'rail' | 'detail';
  workItemId?: string;
  onOpen?: (item: DurableWorkItemV1) => void;
  onOpenEvidence?: (item: DurableWorkItemV1, evidence: DurableWorkItemV1['evidence'][number]) => void;
};

const ACTIVE_STATUSES = new Set<DurableWorkStatus>(['starting', 'running', 'waiting', 'needs_input', 'stalled']);
const EMPTY_LEGACY_TASKS: readonly DelegatedTaskProjection[] = [];

const durationLabel = (milliseconds: number | null): string => {
  if (milliseconds === null) return '—';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
};

const relativeActivity = (timestamp: number | undefined, now: number) => {
  if (!timestamp) return { key: 'conversation.durableWork.unknown' } as const;
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (elapsedSeconds < 10) return { key: 'conversation.durableWork.justNow' } as const;
  if (elapsedSeconds < 60) {
    return { key: 'conversation.durableWork.secondsAgo', options: { count: elapsedSeconds } } as const;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return { key: 'conversation.durableWork.minutesAgo', options: { count: elapsedMinutes } } as const;
  }
  return {
    key: 'conversation.durableWork.hoursAgo',
    options: { count: Math.floor(elapsedMinutes / 60) },
  } as const;
};

const actionForItem = (item: DurableWorkItemV1): 'pause' | 'resume' => {
  const preferred = item.status === 'waiting' || item.status === 'stalled' ? 'resume' : 'pause';
  if (item.actions[preferred].available) return preferred;
  const alternative = preferred === 'pause' ? 'resume' : 'pause';
  return item.actions[alternative].available ? alternative : preferred;
};

const actionIcon = (action: DurableWorkAction): React.ReactNode => {
  if (action === 'pause') return <Pause size={14} aria-hidden='true' />;
  if (action === 'resume') return <PlayOne size={14} aria-hidden='true' />;
  if (action === 'retry') return <Redo size={14} aria-hidden='true' />;
  return <Power size={14} aria-hidden='true' />;
};

const wakeReceiptKey = (item: DurableWorkItemV1): string => {
  const state = item.receipts.wake?.state;
  return state ? `conversation.durableWork.receiptOutcome.${state}` : 'conversation.durableWork.wakeReceiptAbsent';
};

const statusKey = (status: DurableWorkStatus): string => `conversation.durableWork.status.${status}`;
const kindKey = (kind: DurableWorkItemV1['kind']): string => `conversation.durableWork.kind.${kind}`;

const DurableWorkActivity: React.FC<DurableWorkActivityProps> = ({
  conversationId,
  legacyTasks = EMPTY_LEGACY_TASKS,
  mode = 'rail',
  workItemId,
  onOpen,
  onOpenEvidence,
}) => {
  const { t } = useTranslation();
  const activity = useDurableWorkActivity(conversationId, legacyTasks);
  const [now, setNow] = useState(() => Date.now());
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionAnnouncement, setActionAnnouncement] = useState('');
  const visibleItems = useMemo(
    () => (mode === 'detail' && workItemId ? activity.items.filter((item) => item.id === workItemId) : activity.items),
    [activity.items, mode, workItemId]
  );

  useEffect(() => {
    if (!visibleItems.some((item) => ACTIVE_STATUSES.has(item.status))) return;
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [visibleItems]);

  const submitAction = async (item: DurableWorkItemV1, action: DurableWorkAction) => {
    const key = `${item.id}:${action}`;
    setPendingAction(key);
    try {
      const ack = await requestDurableWorkAction(conversationId, item, action, activity.revision);
      const announcement =
        ack.state === 'accepted'
          ? t('conversation.durableWork.actionAccepted')
          : ack.state === 'needs_approval'
            ? t('conversation.durableWork.actionNeedsApproval')
            : ack.state === 'rejected'
              ? t('conversation.durableWork.actionRejected')
              : t('conversation.durableWork.actionUnavailable');
      setActionAnnouncement(announcement);
      if (ack.state === 'accepted') Message.success(announcement);
      else if (ack.state === 'needs_approval') Message.info(announcement);
      else if (ack.state === 'rejected') Message.error(announcement);
      else Message.warning(announcement);
    } catch {
      const announcement = t('conversation.durableWork.actionFailed');
      setActionAnnouncement(announcement);
      Message.error(announcement);
    } finally {
      setPendingAction(null);
    }
  };

  if (visibleItems.length === 0) {
    if (mode === 'rail') return null;
    return (
      <section className={styles.emptyDetail} data-testid='durable-work-detail-empty'>
        <Robot size={24} aria-hidden='true' />
        <strong>{t('conversation.durableWork.detailUnavailable')}</strong>
        <span>{t('conversation.durableWork.detailUnavailableHint')}</span>
      </section>
    );
  }

  const renderAction = (item: DurableWorkItemV1, action: DurableWorkAction) => {
    const capability = item.actions[action];
    const available = activity.connected && capability.available;
    const label = t(`conversation.durableWork.action.${action}`, { goal: item.goal });
    const reason = available
      ? capability.requiresApproval
        ? t('conversation.durableWork.approvalRequired')
        : label
      : capability.reason
        ? t(`conversation.durableWork.actionReason.${capability.reason}`, {
            defaultValue: capability.reason,
          })
        : t('conversation.durableWork.actionUnavailableHint');
    const reasonId = `durable-work-action-${item.id}-${action}-reason`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const button = (
      <Button
        type='text'
        size='mini'
        className={styles.actionButton}
        icon={actionIcon(action)}
        aria-label={label}
        aria-describedby={reasonId}
        aria-busy={pendingAction === `${item.id}:${action}`}
        disabled={!available}
        loading={pendingAction === `${item.id}:${action}`}
        onClick={() => void submitAction(item, action)}
      />
    );
    return (
      <React.Fragment key={action}>
        <Tooltip content={reason} mini>
          <span className={styles.actionWrap} tabIndex={available ? undefined : 0}>
            {button}
          </span>
        </Tooltip>
        <span id={reasonId} className={styles.srOnly}>
          {reason}
        </span>
      </React.Fragment>
    );
  };

  return (
    <section
      className={`${styles.root} ${mode === 'detail' ? styles.detailRoot : ''}`}
      aria-label={t('conversation.durableWork.label')}
      data-connected={activity.connected ? 'true' : 'false'}
      data-testid={`durable-work-activity-${mode}`}
    >
      <span className={styles.srOnly} aria-live='polite'>
        {actionAnnouncement}
      </span>
      {mode === 'rail' ? <span className={styles.eyebrow}>{t('conversation.durableWork.label')}</span> : null}
      <div className={styles.list} role='list'>
        {visibleItems.map((item) => {
          const runtime = durableWorkRuntimeMs(item, now);
          const toggleAction = actionForItem(item);
          const workerLabel = eveTeamWorkerLabel(item.role);
          const currentStep = item.current?.step || item.current?.tool || item.goal;
          const lastActivity = relativeActivity(item.lastActivityAt, now);
          return (
            <article
              key={item.id}
              className={`${styles.item} ${mode === 'detail' ? styles.detailItem : ''}`}
              data-status={item.status}
              data-testid={`durable-work-item-${item.id}`}
              role='listitem'
            >
              <div className={styles.itemTopline}>
                <span className={styles.statusDot} aria-hidden='true' />
                <div className={styles.identity}>
                  <strong>{item.goal}</strong>
                  <span>
                    {t(kindKey(item.kind))} · {workerLabel}
                  </span>
                </div>
                <span className={styles.statusLabel}>{t(statusKey(item.status))}</span>
              </div>

              <div className={styles.itemMeta}>
                <span title={currentStep}>{currentStep}</span>
                <span className={styles.timeValue}>
                  <Time size={12} aria-hidden='true' /> {durationLabel(runtime)}
                </span>
              </div>

              <div className={styles.lastActivity}>
                {t('conversation.durableWork.lastActivity', {
                  value: t(lastActivity.key, lastActivity.options),
                })}
              </div>

              {mode === 'rail' && item.receipts.wake ? (
                <div className={styles.receiptOutcome}>{t(wakeReceiptKey(item))}</div>
              ) : null}

              {mode === 'detail' ? (
                <div className={styles.detailGrid}>
                  <div className={styles.detailBlock}>
                    <span className={styles.detailLabel}>{t('conversation.durableWork.currentStep')}</span>
                    <strong>{item.current?.step || t('conversation.durableWork.unknown')}</strong>
                    <span>{item.current?.tool || t('conversation.durableWork.noTool')}</span>
                  </div>
                  <div className={styles.detailBlock}>
                    <span className={styles.detailLabel}>{t('conversation.durableWork.receipts')}</span>
                    <strong>{t(wakeReceiptKey(item))}</strong>
                    <span>
                      {item.statusReason
                        ? t(`conversation.durableWork.statusReason.${item.statusReason}`, {
                            defaultValue: item.statusReason,
                          })
                        : t('conversation.durableWork.receiptProjection')}
                    </span>
                  </div>
                  <div className={styles.detailBlock}>
                    <span className={styles.detailLabel}>{t('conversation.durableWork.gates')}</span>
                    {item.gates.length > 0 ? (
                      <ul className={styles.detailList}>
                        {item.gates.map((gate) => (
                          <li key={gate.id} data-state={gate.state}>
                            {gate.label} · {t(`conversation.durableWork.gate.${gate.state}`)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span>{t('conversation.durableWork.noGates')}</span>
                    )}
                  </div>
                  <div className={styles.detailBlock}>
                    <span className={styles.detailLabel}>{t('conversation.durableWork.evidence')}</span>
                    {item.evidence.length > 0 ? (
                      <ul className={styles.detailList}>
                        {item.evidence.map((evidence) => {
                          const canOpenArtifact =
                            Boolean(onOpenEvidence) &&
                            (evidence.kind === 'artifact' || evidence.ref?.startsWith('artifact:') === true);
                          return (
                            <li key={evidence.id}>
                              {canOpenArtifact ? (
                                <Button
                                  type='text'
                                  size='mini'
                                  className={styles.evidenceButton}
                                  onClick={() => onOpenEvidence?.(item, evidence)}
                                >
                                  {evidence.label}
                                </Button>
                              ) : (
                                evidence.label
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <span>{t('conversation.durableWork.noEvidence')}</span>
                    )}
                  </div>
                </div>
              ) : null}

              <div className={styles.actions} aria-label={t('conversation.durableWork.actions')}>
                {onOpen ? (
                  <Button
                    type='text'
                    size='mini'
                    className={styles.openButton}
                    icon={<Right size={14} aria-hidden='true' />}
                    aria-label={t('conversation.durableWork.action.open', { goal: item.goal })}
                    onClick={() => onOpen(item)}
                  >
                    {t('conversation.durableWork.open')}
                  </Button>
                ) : null}
                {renderAction(item, toggleAction)}
                {renderAction(item, 'retry')}
                {renderAction(item, 'cancel')}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
};

export default DurableWorkActivity;
