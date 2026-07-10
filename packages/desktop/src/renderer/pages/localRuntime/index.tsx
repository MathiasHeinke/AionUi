/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Empty, Spin, Tag } from '@arco-design/web-react';
import { bridge } from '@office-ai/platform';
import SettingsPageWrapper from '@renderer/pages/settings/components/SettingsPageWrapper';
import { useCommandEveFounderBuild } from '@renderer/hooks/useCommandEveFounderBuild';
import { isElectronDesktop } from '@renderer/utils/platform';

type TierStatus = 'selected' | 'available' | 'opt_in' | 'pro';

type RemediationKind = 'external-link' | 'pull-progress' | 'cloud-redirect' | 'reinstall';

type BlockedStage = {
  stage_id: string;
  stage_status: 'blocked' | 'failed';
  reason_code: string;
  remediation_kind: RemediationKind;
  detail?: string;
};

type BridgeResponse<D = unknown> = {
  success: boolean;
  msg?: string;
  data?: D;
};

type LocalRuntimeTier = {
  id: string;
  label: string;
  model_ref: string;
  runtime_model_ref: string;
  context_length: number;
  max_tokens: number;
  min_unified_memory_gb: number;
  min_free_disk_gb: number;
  status: TierStatus;
};

type LocalRuntimeModel = {
  schema_version: 'command-eve-local-runtime-status/v0';
  generated_at: string;
  read_only: true;
  release: string;
  hermes: {
    package: string;
    version: string;
  };
  provider: {
    type: 'ollama';
    base_url: string;
    egress_proxy_url: string;
  };
  selected_tier_id: string;
  selected_model_ref: string;
  receipt?: {
    path: string;
    status: 'ready' | 'blocked' | 'failed' | 'skipped';
    default_model: string;
    base_model?: string;
    next_action: string;
    completed_at: string;
  };
  model_warmup?: {
    path: string;
    status: 'running' | 'ready' | 'failed' | 'skipped';
    model: string;
    base_url: string;
    started_at: string;
    completed_at?: string;
    elapsed_ms: number;
    error?: string;
  };
  model_pull?: {
    path: string;
    status: 'pulling' | 'done' | 'failed';
    model: string;
    total: number;
    completed: number;
    percent: number;
    updated_at: string;
    error?: string;
  };
  blocked_stage?: BlockedStage;
  tiers: LocalRuntimeTier[];
  warnings: string[];
};

const formatMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

type LocalRuntimeResult = {
  version: 'command-eve-local-runtime-status/v0';
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  model?: LocalRuntimeModel;
  source: {
    manifest_path?: string;
    receipt_path?: string;
    generated_by: 'command-eve-local-runtime-status-core';
  };
};

type KanbanPreflightModule = {
  name: string;
  ok: boolean;
  error?: string;
};

type KanbanPreflightResult = {
  version: 'command-eve-kanban-preflight/v0';
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  reason_code?: string;
  message?: string;
  model?: {
    schema_version: 'command-eve-kanban-preflight/v0';
    generated_at: string;
    read_only: true;
    hermes: {
      min_required_version: string;
      installed_version: string;
      version_ok: boolean;
    };
    modules: KanbanPreflightModule[];
    board: {
      slug: string;
      db_path: string;
      db_exists: boolean;
      table_count: number;
      task_count?: number;
      read_only_opened: boolean;
    };
    governance: {
      runtime_reconciliation_path: string;
      dispatcher_disabled: boolean;
      auto_decompose_disabled: boolean;
      mcp_servers_disabled: boolean;
    };
    warnings: string[];
  };
  source: {
    generated_by: 'command-eve-kanban-preflight-core';
    hermes_home?: string;
    python_path?: string;
  };
};

const localRuntimeBridge = bridge.buildProvider<
  BridgeResponse<LocalRuntimeResult>,
  { manifestPath?: string; receiptPath?: string } | undefined
>('command-eve.local-runtime-status');

const kanbanPreflightBridge = bridge.buildProvider<
  BridgeResponse<KanbanPreflightResult>,
  { boardSlug?: string } | undefined
>('command-eve.kanban-preflight');

const tierColor = (status: TierStatus): 'green' | 'blue' | 'gray' => {
  if (status === 'selected') return 'green';
  if (status === 'available' || status === 'pro') return 'blue';
  return 'gray';
};

const formatNumber = (value: number): string => new Intl.NumberFormat().format(value);

const textOrDash = (value?: string | null): string => {
  const text = String(value || '').trim();
  return text || '-';
};

const formatTimestamp = (value: string | undefined, locale: string): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

type PublicReceiptStatus = NonNullable<LocalRuntimeModel['receipt']>['status'] | 'unknown';

const normalizeReceiptStatus = (status: string): PublicReceiptStatus => {
  if (status === 'ready' || status === 'blocked' || status === 'failed' || status === 'skipped') return status;
  return 'unknown';
};

const TierCard: React.FC<{ tier: LocalRuntimeTier; showTechnicalDetails: boolean }> = ({
  tier,
  showTechnicalDetails,
}) => {
  const { t } = useTranslation();
  const publicLabel = t(`localRuntime.tierNames.${tier.id}`, {
    defaultValue: t(`localRuntime.tierStatus.${tier.status}`),
  });
  return (
    <article className='rounded-14px border border-solid border-[var(--color-border-2)] bg-fill-1 px-16px py-14px'>
      <div className='flex items-start justify-between gap-12px'>
        <div className='min-w-0'>
          <div className='truncate text-16px font-700 leading-24px text-t-primary'>
            {showTechnicalDetails ? tier.label : publicLabel}
          </div>
          {showTechnicalDetails ? (
            <div className='mt-2px truncate text-12px leading-18px text-t-tertiary'>{tier.model_ref}</div>
          ) : null}
        </div>
        <Tag color={tierColor(tier.status)}>{t(`localRuntime.tierStatus.${tier.status}`)}</Tag>
      </div>
      {!showTechnicalDetails ? (
        <p className='m-0 mt-8px text-13px leading-20px text-t-secondary'>
          {t(`localRuntime.tierDescriptions.${tier.id}`, {
            defaultValue: t('localRuntime.tierDescriptions.unknown'),
          })}
        </p>
      ) : null}
      <dl className='mt-12px grid gap-x-12px gap-y-7px text-12px leading-18px sm:grid-cols-[145px_minmax(0,1fr)]'>
        {showTechnicalDetails ? (
          <>
            <dt className='text-t-tertiary'>{t('localRuntime.labels.runtimeModel')}</dt>
            <dd className='m-0 break-words text-t-secondary'>{tier.runtime_model_ref}</dd>
            <dt className='text-t-tertiary'>{t('localRuntime.labels.context')}</dt>
            <dd className='m-0 text-t-secondary'>{formatNumber(tier.context_length)}</dd>
          </>
        ) : null}
        <dt className='text-t-tertiary'>{t('localRuntime.labels.requirements')}</dt>
        <dd className='m-0 text-t-secondary'>
          {t('localRuntime.requirements', {
            memory: tier.min_unified_memory_gb,
            disk: tier.min_free_disk_gb,
          })}
        </dd>
      </dl>
    </article>
  );
};

/**
 * S4 — reason-code-keyed local-lane remediation. Read-only, additive: it never
 * mutates runtime state and never shows a shell command. Cloud stays the default
 * lane, so every card reassures the operator that the cloud still works.
 */
const RemediationCard: React.FC<{
  blocked: BlockedStage;
  warmupPollCount: number;
  pull?: LocalRuntimeModel['model_pull'];
  showTechnicalDetails: boolean;
}> = ({ blocked, warmupPollCount, pull, showTechnicalDetails }) => {
  const { t } = useTranslation();
  const kind = blocked.remediation_kind;

  const title = (() => {
    if (kind === 'cloud-redirect') {
      return blocked.reason_code === 'BLOCKED_DISK'
        ? t('localRuntime.remediation.cloud-redirect.titleDisk')
        : t('localRuntime.remediation.cloud-redirect.titleRam');
    }
    return t(`localRuntime.remediation.${kind}.title`);
  })();

  const body = (() => {
    if (kind === 'pull-progress') {
      return blocked.reason_code === 'MODEL_PULL_FAILED'
        ? t('localRuntime.remediation.pull-progress.bodyFailed')
        : t('localRuntime.remediation.pull-progress.bodyFetching');
    }
    return t(`localRuntime.remediation.${kind}.body`);
  })();

  // cloud-redirect is reassurance, not an error; everything else is a warning.
  const alertType = kind === 'cloud-redirect' ? 'info' : 'warning';

  return (
    <section className='eve-settings-group'>
      <div className='mb-12px flex flex-wrap items-center gap-8px'>
        <span className='text-16px font-700 leading-24px text-t-primary'>{t('localRuntime.remediation.title')}</span>
        <Tag color='gray'>{t('localRuntime.readOnly')}</Tag>
      </div>
      <Alert type={alertType} title={title} content={body} />

      {kind === 'external-link' ? (
        <p className='m-0 mt-12px text-12px leading-18px text-t-tertiary'>
          {t('localRuntime.remediation.external-link.actionHint')}
        </p>
      ) : null}

      {kind === 'pull-progress' ? (
        <div className='mt-12px flex flex-col gap-6px'>
          <div className='flex items-center gap-8px text-12px leading-18px text-t-tertiary'>
            <Spin size={14} />
            <span>{t('localRuntime.remediation.pull-progress.pollingLabel')}</span>
            {pull && pull.status === 'pulling' && pull.total > 0 ? (
              <Tag color='blue' data-testid='pull-progress-percent'>
                {t('localRuntime.remediation.pull-progress.progress', {
                  defaultValue: '{{percent}}% · {{done}} / {{total}}',
                  percent: pull.percent,
                  done: formatMb(pull.completed),
                  total: formatMb(pull.total),
                })}
              </Tag>
            ) : warmupPollCount > 0 ? (
              <Tag color='blue'>
                {t('localRuntime.remediation.pull-progress.pollAttempt', { count: warmupPollCount })}
              </Tag>
            ) : null}
          </div>
          {pull && pull.status === 'pulling' && pull.total > 0 ? (
            <div style={{ height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: 'var(--color-fill-3)' }}>
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, pull.percent))}%`,
                  height: '100%',
                  backgroundColor: 'rgb(var(--primary-6))',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <p className='m-0 mt-12px text-12px leading-18px text-t-secondary'>
        {t('localRuntime.remediation.cloudReassurance')}
      </p>
      {showTechnicalDetails ? (
        <div className='mt-10px grid gap-x-12px gap-y-6px text-12px leading-18px lg:grid-cols-[180px_minmax(0,1fr)]'>
          <span className='text-t-tertiary'>{t('localRuntime.remediation.reasonLabel')}</span>
          <span className='break-words text-t-secondary'>
            {`${blocked.reason_code} · ${t(`localRuntime.remediation.${kind}.explainer`)}`}
          </span>
        </div>
      ) : null}
    </section>
  );
};

const LocalRuntimePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { founderBuild: showTechnicalDetails } = useCommandEveFounderBuild();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<LocalRuntimeResult | null>(null);
  const [kanbanResult, setKanbanResult] = useState<KanbanPreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kanbanError, setKanbanError] = useState<string | null>(null);
  const [warmupPollCount, setWarmupPollCount] = useState(0);

  const load = useCallback(async () => {
    if (!isElectronDesktop()) {
      setResult({
        version: 'command-eve-local-runtime-status/v0',
        ok: false,
        status: 'blocked',
        reason_code: 'ELECTRON_BRIDGE_REQUIRED',
        message: t('localRuntime.blocked.electronBridgeRequired'),
        source: {
          generated_by: 'command-eve-local-runtime-status-core',
        },
      });
      setKanbanResult(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setKanbanError(null);
    try {
      const [response, kanbanResponse] = await Promise.all([
        localRuntimeBridge.invoke(undefined),
        kanbanPreflightBridge.invoke({ boardSlug: 'default' }),
      ]);
      const data = response.data;
      setResult(data ?? null);
      if (!response.success) {
        setError(response.msg || data?.message || t('localRuntime.errors.loadFailed'));
      }
      const kanbanData = kanbanResponse.data;
      setKanbanResult(kanbanData ?? null);
      if (!kanbanResponse.success) {
        setKanbanError(kanbanResponse.msg || kanbanData?.message || t('localRuntime.errors.kanbanLoadFailed'));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('localRuntime.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = result?.model;
  const warmupStatus = model?.model_warmup?.status;
  const warmupMissing = Boolean(model?.warnings.includes('model_warmup_receipt_missing'));
  const blockedStage = model?.blocked_stage;
  // While the local model is being fetched (S4 pull-progress card), keep the
  // existing ~12x poll alive so the live progress updates without manual reload.
  const pullInProgress = blockedStage?.remediation_kind === 'pull-progress';

  useEffect(() => {
    if (loading || !model) return undefined;
    if (!warmupMissing && warmupStatus !== 'running' && !pullInProgress) {
      setWarmupPollCount(0);
      return undefined;
    }
    // A LIVE model pull keeps advancing (the core only surfaces pull-progress
    // while the side file is fresh; a stale/dead pull drops it, ending the loop),
    // so don't freeze it at the 12x warmup cap — poll on while genuinely pulling.
    if (!pullInProgress && warmupPollCount >= 12) return undefined;
    const timer = setTimeout(() => {
      setWarmupPollCount((count) => count + 1);
      void load();
    }, 2500);
    return () => clearTimeout(timer);
  }, [load, loading, model, pullInProgress, warmupMissing, warmupPollCount, warmupStatus]);

  return (
    <SettingsPageWrapper contentClassName='max-w-1280px'>
      <div className='flex w-full flex-col gap-18px'>
        <header className='eve-page-header'>
          <div className='eve-page-header__copy'>
            <div className='flex items-center gap-8px'>
              <h1>{t('localRuntime.title')}</h1>
              <Tag color='gray'>{t('localRuntime.readOnly')}</Tag>
            </div>
            <p>{t('localRuntime.subtitle')}</p>
          </div>
          <Button type='secondary' loading={loading} onClick={() => void load()}>
            {t('localRuntime.refresh')}
          </Button>
        </header>

        {error ? (
          <Alert
            type='warning'
            title={t('localRuntime.errors.loadFailed')}
            content={showTechnicalDetails ? error : t('localRuntime.errors.loadFailedDescription')}
          />
        ) : null}
        {kanbanError ? (
          <Alert
            type='warning'
            title={t('localRuntime.errors.kanbanLoadFailed')}
            content={showTechnicalDetails ? kanbanError : t('localRuntime.errors.kanbanLoadFailedDescription')}
          />
        ) : null}
        {result && !result.ok ? (
          <Alert
            type={result.status === 'blocked' ? 'warning' : 'error'}
            title={t('localRuntime.blocked.title')}
            content={
              showTechnicalDetails
                ? `${result.reason_code || 'LOCAL_RUNTIME_UNAVAILABLE'}: ${result.message || t('localRuntime.blocked.description')}`
                : t('localRuntime.blocked.description')
            }
          />
        ) : null}

        {loading ? (
          <div className='min-h-240px flex items-center justify-center'>
            <Spin size={32} />
          </div>
        ) : model ? (
          <>
            {model.warnings.length ? (
              showTechnicalDetails ? (
                <Alert
                  type='info'
                  title={t('localRuntime.warnings.title')}
                  content={model.warnings.map((warning) => t(`localRuntime.warnings.${warning}`, warning)).join(' · ')}
                />
              ) : (
                <div className='flex items-start gap-8px text-13px leading-20px text-t-secondary'>
                  <Tag color='gray'>{t('localRuntime.warnings.title')}</Tag>
                  <span>{t('localRuntime.warnings.publicSummary')}</span>
                </div>
              )
            ) : null}

            {model.blocked_stage ? (
              <RemediationCard
                blocked={model.blocked_stage}
                warmupPollCount={warmupPollCount}
                pull={model.model_pull}
                showTechnicalDetails={showTechnicalDetails}
              />
            ) : null}

            <section className='eve-settings-group'>
              <div className='mb-12px text-16px font-700 leading-24px text-t-primary'>
                {t('localRuntime.sections.runtimeTruth')}
              </div>
              <div className='grid gap-x-12px gap-y-8px text-12px leading-18px lg:grid-cols-[180px_minmax(0,1fr)]'>
                <span className='text-t-tertiary'>{t('localRuntime.labels.release')}</span>
                <span className='text-t-secondary'>{model.release}</span>
                <span className='text-t-tertiary'>{t('localRuntime.labels.localLane')}</span>
                <span className='text-t-secondary'>{t('localRuntime.values.managedByEve')}</span>
                {showTechnicalDetails ? (
                  <>
                    <span className='text-t-tertiary'>{t('localRuntime.labels.hermes')}</span>
                    <span className='text-t-secondary'>{`${model.hermes.package} ${model.hermes.version}`}</span>
                    <span className='text-t-tertiary'>{t('localRuntime.labels.provider')}</span>
                    <span className='text-t-secondary'>{model.provider.type}</span>
                    <span className='text-t-tertiary'>{t('localRuntime.labels.ollamaUrl')}</span>
                    <span className='break-words text-t-secondary'>{model.provider.base_url}</span>
                    <span className='text-t-tertiary'>{t('localRuntime.labels.egressProxy')}</span>
                    <span className='break-words text-t-secondary'>{model.provider.egress_proxy_url}</span>
                    <span className='text-t-tertiary'>{t('localRuntime.labels.selectedModel')}</span>
                    <span className='break-words text-t-secondary'>{model.selected_model_ref}</span>
                  </>
                ) : null}
              </div>
            </section>

            <section className='grid gap-12px lg:grid-cols-3'>
              {model.tiers.map((tier) => (
                <TierCard key={tier.id} tier={tier} showTechnicalDetails={showTechnicalDetails} />
              ))}
            </section>

            <section className='eve-settings-group'>
              <div className='mb-12px flex flex-wrap items-center gap-8px'>
                <span className='text-16px font-700 leading-24px text-t-primary'>
                  {t('localRuntime.sections.kanban')}
                </span>
                {kanbanResult ? (
                  <Tag color={kanbanResult.ok ? 'green' : kanbanResult.status === 'blocked' ? 'gray' : 'red'}>
                    {kanbanResult.ok ? t('localRuntime.kanban.ready') : t('localRuntime.kanban.notReady')}
                  </Tag>
                ) : null}
                {showTechnicalDetails ? <Tag color='gray'>{t('localRuntime.readOnly')}</Tag> : null}
              </div>
              {kanbanResult?.model ? (
                <>
                  <div className='grid gap-x-12px gap-y-8px text-12px leading-18px lg:grid-cols-[180px_minmax(0,1fr)]'>
                    <span className='text-t-tertiary'>{t('localRuntime.kanban.labels.localData')}</span>
                    <span className='text-t-secondary'>
                      {kanbanResult.model.board.db_exists
                        ? t('localRuntime.kanban.dbPresent.yes')
                        : t('localRuntime.kanban.dbPresent.no')}
                    </span>
                    <span className='text-t-tertiary'>{t('localRuntime.kanban.labels.tasks')}</span>
                    <span className='text-t-secondary'>
                      {typeof kanbanResult.model.board.task_count === 'number'
                        ? formatNumber(kanbanResult.model.board.task_count)
                        : '-'}
                    </span>
                    <span className='text-t-tertiary'>{t('localRuntime.kanban.labels.modules')}</span>
                    <span className='text-t-secondary'>
                      {t('localRuntime.kanban.moduleCount', {
                        ready: kanbanResult.model.modules.filter((module) => module.ok).length,
                        total: kanbanResult.model.modules.length,
                      })}
                    </span>
                    <span className='text-t-tertiary'>{t('localRuntime.kanban.labels.protection')}</span>
                    <span className='text-t-secondary'>
                      {/* Write-governance lock = dispatcher off + external MCP off. auto_decompose
                          is intentionally ON (tree-building, not execution) — see
                          isKanbanWriteGovernanceLocked in kanbanPreflightCore (Founder 2026-07-05). */}
                      {kanbanResult.model.governance.dispatcher_disabled &&
                      kanbanResult.model.governance.mcp_servers_disabled
                        ? t('localRuntime.kanban.governanceLocked')
                        : t('localRuntime.kanban.governanceOpen')}
                    </span>
                    {showTechnicalDetails ? (
                      <>
                        <span className='text-t-tertiary'>{t('localRuntime.labels.hermes')}</span>
                        <span className='text-t-secondary'>
                          {`${kanbanResult.model.hermes.installed_version} / ${kanbanResult.model.hermes.min_required_version}`}
                        </span>
                        <span className='text-t-tertiary'>{t('localRuntime.kanban.labels.board')}</span>
                        <span className='text-t-secondary'>{kanbanResult.model.board.slug}</span>
                        <span className='text-t-tertiary'>{t('localRuntime.kanban.labels.db')}</span>
                        <span className='break-words text-t-secondary'>{kanbanResult.model.board.db_path}</span>
                        <span className='text-t-tertiary'>{t('localRuntime.kanban.labels.reconciliation')}</span>
                        <span className='break-words text-t-secondary'>
                          {kanbanResult.model.governance.runtime_reconciliation_path}
                        </span>
                      </>
                    ) : null}
                  </div>
                  {kanbanResult.model.warnings.length ? (
                    showTechnicalDetails ? (
                      <Alert
                        className='mt-12px'
                        type='info'
                        title={t('localRuntime.warnings.title')}
                        content={kanbanResult.model.warnings
                          .map((warning) => t(`localRuntime.warnings.${warning}`, warning))
                          .join(' · ')}
                      />
                    ) : (
                      <div className='mt-12px flex items-start gap-8px text-13px leading-20px text-t-secondary'>
                        <Tag color='gray'>{t('localRuntime.warnings.title')}</Tag>
                        <span>{t('localRuntime.warnings.publicTaskSummary')}</span>
                      </div>
                    )
                  ) : null}
                </>
              ) : (
                <Empty description={t('localRuntime.empty.noKanban')} />
              )}
            </section>

            <section className='eve-settings-group'>
              <div className='mb-12px text-16px font-700 leading-24px text-t-primary'>
                {t('localRuntime.sections.receipt')}
              </div>
              {model.receipt ? (
                <div className='grid gap-x-12px gap-y-8px text-12px leading-18px lg:grid-cols-[180px_minmax(0,1fr)]'>
                  <span className='text-t-tertiary'>{t('localRuntime.labels.status')}</span>
                  <span className='text-t-secondary'>
                    {t(`localRuntime.receiptStatus.${normalizeReceiptStatus(model.receipt.status)}`, {
                      defaultValue: t('localRuntime.receiptStatus.unknown'),
                    })}
                  </span>
                  <span className='text-t-tertiary'>{t('localRuntime.labels.nextAction')}</span>
                  <span className='text-t-secondary'>
                    {showTechnicalDetails
                      ? model.receipt.next_action
                      : t(`localRuntime.receiptNextAction.${normalizeReceiptStatus(model.receipt.status)}`, {
                          defaultValue: t('localRuntime.receiptNextAction.unknown'),
                        })}
                  </span>
                  <span className='text-t-tertiary'>{t('localRuntime.labels.storage')}</span>
                  <span className='text-t-secondary'>{t('localRuntime.values.storedLocally')}</span>
                  {showTechnicalDetails ? (
                    <>
                      <span className='text-t-tertiary'>{t('localRuntime.labels.baseModel')}</span>
                      <span className='text-t-secondary'>{textOrDash(model.receipt.base_model)}</span>
                      <span className='text-t-tertiary'>{t('localRuntime.labels.receiptPath')}</span>
                      <span className='break-words text-t-secondary'>{model.receipt.path}</span>
                    </>
                  ) : null}
                </div>
              ) : (
                <Empty description={t('localRuntime.empty.noReceipt')} />
              )}
            </section>

            <section className='eve-settings-group'>
              <div className='mb-12px flex items-center gap-8px'>
                <span className='text-16px font-700 leading-24px text-t-primary'>
                  {t('localRuntime.sections.warmup')}
                </span>
                {model.model_warmup ? (
                  <Tag
                    color={
                      model.model_warmup.status === 'ready'
                        ? 'green'
                        : model.model_warmup.status === 'running'
                          ? 'blue'
                          : model.model_warmup.status === 'skipped'
                            ? 'gray'
                            : 'red'
                    }
                  >
                    {t(`localRuntime.warmupStatus.${model.model_warmup.status}`)}
                  </Tag>
                ) : null}
              </div>
              {model.model_warmup ? (
                <div className='grid gap-x-12px gap-y-8px text-12px leading-18px lg:grid-cols-[180px_minmax(0,1fr)]'>
                  <span className='text-t-tertiary'>{t('localRuntime.labels.elapsed')}</span>
                  <span className='text-t-secondary'>
                    {t('localRuntime.elapsedMs', { elapsed: model.model_warmup.elapsed_ms })}
                  </span>
                  {showTechnicalDetails ? (
                    <>
                      <span className='text-t-tertiary'>{t('localRuntime.labels.startedAt')}</span>
                      <span className='text-t-secondary'>
                        {formatTimestamp(model.model_warmup.started_at, i18n.language)}
                      </span>
                      {model.model_warmup.completed_at ? (
                        <>
                          <span className='text-t-tertiary'>{t('localRuntime.labels.completedAt')}</span>
                          <span className='text-t-secondary'>
                            {formatTimestamp(model.model_warmup.completed_at, i18n.language)}
                          </span>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {showTechnicalDetails && model.model_warmup.error ? (
                    <>
                      <span className='text-t-tertiary'>{t('localRuntime.labels.error')}</span>
                      <span className='break-words text-t-secondary'>{model.model_warmup.error}</span>
                    </>
                  ) : null}
                  {showTechnicalDetails ? (
                    <>
                      <span className='text-t-tertiary'>{t('localRuntime.labels.model')}</span>
                      <span className='break-words text-t-secondary'>{model.model_warmup.model}</span>
                      <span className='text-t-tertiary'>{t('localRuntime.labels.baseUrl')}</span>
                      <span className='break-words text-t-secondary'>{model.model_warmup.base_url}</span>
                      <span className='text-t-tertiary'>{t('localRuntime.labels.receiptPath')}</span>
                      <span className='break-words text-t-secondary'>{model.model_warmup.path}</span>
                    </>
                  ) : null}
                </div>
              ) : (
                <Empty description={t('localRuntime.empty.noWarmup')} />
              )}
            </section>
          </>
        ) : (
          <Empty description={t('localRuntime.empty.noRuntime')} />
        )}
      </div>
    </SettingsPageWrapper>
  );
};

export default LocalRuntimePage;
