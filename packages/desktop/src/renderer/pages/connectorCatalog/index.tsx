/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Empty, Input, Message, Modal, Spin, Tag } from '@arco-design/web-react';
import { bridge } from '@office-ai/platform';
import SettingsPageWrapper from '@renderer/pages/settings/components/SettingsPageWrapper';
import { useCommandEveFounderBuild } from '@renderer/hooks/useCommandEveFounderBuild';
import { isElectronDesktop } from '@renderer/utils/platform';

type ConnectorEvidenceState =
  | 'installed'
  | 'available'
  | 'needs_auth'
  | 'unverified'
  | 'gated'
  | 'connected'
  | 'blocked';

type ConnectorGuidedSetupState =
  | 'connected'
  | 'preflight_required'
  | 'auth_required'
  | 'humangate_required'
  | 'blocked';

type ConnectorGuidedSetupAction =
  | 'view_receipt'
  | 'run_read_only_preflight'
  | 'guided_auth_setup'
  | 'request_humangate'
  | 'inspect_blocker';

type BridgeResponse<D = unknown> = {
  success: boolean;
  msg?: string;
  data?: D;
};

type ConnectorPreflight = {
  ok: boolean | null;
  checked_at?: string;
  error?: string;
  reason_code?: string;
  evidence_path?: string;
  source_path?: string;
};

type ConnectorGuidedSetup = {
  state: ConnectorGuidedSetupState;
  primary_action: ConnectorGuidedSetupAction;
  reason_code: string;
  mcp_enable_allowed: false;
  connector_write_allowed: false;
  secret_handling: 'never_in_chat';
  requires_preflight: boolean;
  requires_human_gate?: string;
  receipt_path?: string;
};

type ConnectorCatalogCard = {
  id: string;
  name: string;
  tier: string;
  purpose: string;
  required_for: string[];
  auth_method: string;
  auth_surface: string;
  setup_mode: string;
  safe_preflight: string[];
  verify_command: string;
  allowed_actions: string[];
  blocked_actions: string[];
  human_gate: string;
  memory_policy: string;
  preflight_result_file: string;
  /** OPTIONAL stdio invocation (arch §4) — present for curated connectors; drives the guided-auth field set. */
  mcp_invocation?: {
    transport: 'stdio';
    command: string;
    args: string[];
    env_refs: string[];
    scope_default?: 'founder' | 'seat';
  };
  evidence_state: ConnectorEvidenceState;
  latest_preflight: ConnectorPreflight | null;
  guided_setup: ConnectorGuidedSetup;
};

type ConnectorCatalogModel = {
  schema_version: 'command-eve-connector-catalog/v0';
  generated_at: string;
  read_only: true;
  policy: {
    secret_rule?: string;
    write_rule?: string;
    state_authority?: string;
  };
  source: {
    company_os_root?: string;
    manifest_path: string;
    preflight_base?: string;
  };
  summary: Record<ConnectorEvidenceState, number>;
  mcp_enable_policy: {
    allowed: false;
    reason_code: 'READ_ONLY_CATALOG' | 'HUMANGATE_AND_PREFLIGHT_REQUIRED';
    blocked_transports: Array<'http' | 'sse' | 'streamable_http'>;
    secret_handling: 'never_in_chat';
    connector_write_allowed: false;
    safe_surface: 'guided_preflight_receipts_only';
  };
  connectors: ConnectorCatalogCard[];
  blocked_actions: string[];
};

type ConnectorCatalogResult = {
  version: 'command-eve-connector-catalog/v0';
  status: 'ready' | 'blocked' | 'failed';
  ok: boolean;
  reason_code?: string;
  message?: string;
  model?: ConnectorCatalogModel;
  source: {
    company_os_root?: string;
    manifest_path?: string;
    generated_by: 'command-eve-connector-catalog-core';
  };
};

type ConnectorPreflightResult = {
  version: 'command-eve-connector-preflight/v0';
  ok: boolean;
  status: 'ready' | 'blocked' | 'failed';
  connector_id?: string;
  reason_code?: string;
  message?: string;
  receipt_path?: string;
  audit_event_path?: string;
  audit_event_id?: string;
};

const connectorCatalogBridge = bridge.buildProvider<
  BridgeResponse<ConnectorCatalogResult>,
  { manifestPath?: string } | undefined
>('command-eve.connector-catalog');

const connectorPreflightBridge = bridge.buildProvider<
  BridgeResponse<ConnectorPreflightResult>,
  { connectorId: string; manifestPath?: string }
>('command-eve.connector-preflight');

// S5-P2 guided_auth_setup (arch §6): the API-key setup handler. secrets never
// leave the handler in plaintext (they are encrypted main-side). The card can
// SHOW this, but the actual MCP enable stays behind COMMAND_EVE_MCP_VAULT_ENABLED.
type GuidedAuthSetupResult = {
  version: 'command-eve-guided-auth-setup/v0';
  ok: boolean;
  reason_code?: string;
  connector_id?: string;
  path?: string;
};
const guidedAuthSetupBridge = bridge.buildProvider<
  BridgeResponse<GuidedAuthSetupResult>,
  {
    connectorId: string;
    secrets: Record<string, string>;
    scope: 'founder' | 'seat';
    humanGateReceipt: string;
    manifestPath?: string;
  }
>('command-eve.guided-auth-setup');

const stateColor = (state: ConnectorEvidenceState): 'blue' | 'green' | 'red' | 'gray' => {
  if (state === 'connected') return 'green';
  if (state === 'blocked') return 'red';
  if (state === 'installed' || state === 'available') return 'blue';
  return 'gray';
};

const setupStateColor = (state: ConnectorGuidedSetupState): 'blue' | 'green' | 'red' | 'gray' => {
  if (state === 'connected') return 'green';
  if (state === 'blocked') return 'red';
  if (state === 'preflight_required') return 'blue';
  return 'gray';
};

const textOrDash = (value?: string | null): string => {
  const text = String(value || '').trim();
  return text || '-';
};

const blockedActionLabelKey = (action: string): string => `connectorCatalog.blockedActions.${action}`;

const firstItems = (items: string[], count: number): string[] => items.slice(0, count);

const formatTimestamp = (value: string | undefined, locale: string): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const connectorDisplayName = (connector: ConnectorCatalogCard, translate: (key: string) => string): string => {
  if (/Local Company\.OS Workspace/i.test(connector.name)) return translate('connectorCatalog.publicNames.workspace');
  if (/Command EVE Command Center/i.test(connector.name)) {
    return translate('connectorCatalog.publicNames.commandCenter');
  }
  if (/Plane Execution Ledger/i.test(connector.name)) return translate('connectorCatalog.publicNames.tasks');
  if (/Honcho Memory/i.test(connector.name)) return translate('connectorCatalog.publicNames.memory');
  if (connector.id === 'aionui-hermes-runtime' || /^AionUI \+ Hermes Runtime$/i.test(connector.name)) {
    return translate('connectorCatalog.publicNames.commandEveRuntime');
  }
  if (/AionUI|Hermes|Company\.OS/i.test(connector.name)) {
    return translate('connectorCatalog.publicNames.commandEveService');
  }
  return connector.name;
};

/**
 * GUIDED AUTH SETUP MODAL (S5-P2 scaffold, arch §6). API-KEY path only. One
 * password field per env-var the connector's stdio invocation declares. The value
 * NEVER leaves the renderer as chat/state — it goes straight to the main-side
 * handler which encrypts it into the keychain vault. If the connector declares no
 * mcp_invocation (OAuth-only / not-yet-wired), the modal refuses (OAuth deferred).
 */
const GuidedAuthSetupModal: React.FC<{
  connector: ConnectorCatalogCard | null;
  visible: boolean;
  submitting: boolean;
  showTechnicalDetails: boolean;
  onCancel: () => void;
  onSubmit: (input: { connectorId: string; secrets: Record<string, string>; humanGateReceipt: string }) => void;
}> = ({ connector, visible, submitting, showTechnicalDetails, onCancel, onSubmit }) => {
  const { t } = useTranslation();
  const envRefs = connector?.mcp_invocation?.env_refs ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState('');

  useEffect(() => {
    // Reset the fields whenever the target connector changes (never carry a secret
    // from one connector's modal into another).
    setValues({});
    setReceipt('');
  }, [connector?.id, visible]);

  const canSubmit =
    !!connector &&
    envRefs.length > 0 &&
    envRefs.every((name) => (values[name] ?? '').length > 0) &&
    receipt.trim().length > 0;

  return (
    <Modal
      title={
        connector
          ? t('connectorCatalog.setupModal.title', { name: connectorDisplayName(connector, t) })
          : t('connectorCatalog.setupModal.fallbackTitle')
      }
      visible={visible}
      onCancel={onCancel}
      okText={t('connectorCatalog.setupModal.confirm')}
      confirmLoading={submitting}
      okButtonProps={{ disabled: !canSubmit }}
      onOk={() => {
        if (!connector || !canSubmit) return;
        onSubmit({ connectorId: connector.id, secrets: values, humanGateReceipt: receipt.trim() });
      }}
    >
      {envRefs.length === 0 ? (
        <Alert type='warning' content={t('connectorCatalog.setupModal.unavailable')} />
      ) : (
        <div className='flex flex-col gap-12px'>
          <Alert type='info' content={t('connectorCatalog.setupModal.security')} />
          {envRefs.map((name, index) => (
            <div key={name} className='flex flex-col gap-4px'>
              <label className='text-12px font-600 text-t-primary'>
                {showTechnicalDetails
                  ? `${t('connectorCatalog.setupModal.credential')} · ${name}`
                  : t('connectorCatalog.setupModal.credentialNumber', { number: index + 1 })}
              </label>
              <Input.Password
                data-testid={`guided-auth-input-${name}`}
                value={values[name] ?? ''}
                placeholder={t('connectorCatalog.setupModal.credentialPlaceholder')}
                onChange={(v) => setValues((prev) => ({ ...prev, [name]: v }))}
              />
            </div>
          ))}
          <div className='flex flex-col gap-4px'>
            <label className='text-12px font-600 text-t-primary'>
              {t('connectorCatalog.setupModal.approvalReceipt')}
            </label>
            <Input
              data-testid='guided-auth-input-receipt'
              value={receipt}
              placeholder={t('connectorCatalog.setupModal.approvalReceiptPlaceholder')}
              onChange={setReceipt}
            />
          </div>
        </div>
      )}
    </Modal>
  );
};

const ConnectorCard: React.FC<{
  connector: ConnectorCatalogCard;
  running: boolean;
  showTechnicalDetails: boolean;
  hasTopBorder: boolean;
  onRunPreflight: (connectorId: string) => void;
  onGuidedAuthSetup: (connector: ConnectorCatalogCard) => void;
}> = ({ connector, running, showTechnicalDetails, hasTopBorder, onRunPreflight, onGuidedAuthSetup }) => {
  const { t, i18n } = useTranslation();
  const latestPreflight = connector.latest_preflight;
  const stateLabel = t(`connectorCatalog.states.${connector.evidence_state}`);
  const displayName = connectorDisplayName(connector, t);
  const isGuidedAuth = connector.guided_setup.primary_action === 'guided_auth_setup';
  const canUseGuidedAuth = isGuidedAuth && showTechnicalDetails;
  const canRunPreflight = connector.guided_setup.primary_action === 'run_read_only_preflight';
  const verificationLabel = latestPreflight
    ? t(latestPreflight.ok ? 'connectorCatalog.values.checkPassed' : 'connectorCatalog.values.checkFailed')
    : t('connectorCatalog.values.checkPending');
  return (
    <article
      data-testid={`connector-card-${connector.id}`}
      className={`flex flex-col gap-10px py-16px ${
        hasTopBorder ? 'border-0 border-t border-solid border-[var(--glass-panel-border)]' : ''
      }`}
    >
      <div className='flex items-start justify-between gap-12px'>
        <div className='min-w-0'>
          <div className='truncate text-15px font-700 leading-22px text-t-primary'>{displayName}</div>
          {showTechnicalDetails ? (
            <div className='mt-2px truncate text-12px leading-18px text-t-tertiary'>{connector.id}</div>
          ) : null}
        </div>
        <Tag color={stateColor(connector.evidence_state)}>{stateLabel}</Tag>
      </div>

      <p className='m-0 text-13px leading-20px text-t-secondary'>
        {showTechnicalDetails ? connector.purpose : t(`connectorCatalog.cardDescriptions.${connector.evidence_state}`)}
      </p>

      <dl className='grid gap-x-16px gap-y-8px text-12px leading-18px sm:grid-cols-[130px_minmax(0,1fr)_130px_minmax(0,1fr)]'>
        <dt className='text-t-tertiary'>{t('connectorCatalog.labels.verification')}</dt>
        <dd className='m-0 text-t-secondary'>{verificationLabel}</dd>
        <dt className='text-t-tertiary'>{t('connectorCatalog.labels.approval')}</dt>
        <dd className='m-0 text-t-secondary'>
          {connector.guided_setup.requires_human_gate
            ? t('connectorCatalog.labels.approvalRequired')
            : t('connectorCatalog.labels.noApprovalRequired')}
        </dd>
        {latestPreflight ? (
          <>
            <dt className='text-t-tertiary'>{t('connectorCatalog.labels.checkedAt')}</dt>
            <dd className='m-0 text-t-secondary sm:col-span-3'>
              {formatTimestamp(latestPreflight.checked_at, i18n.language)}
            </dd>
          </>
        ) : null}
      </dl>

      <div className='flex flex-wrap items-center gap-8px text-12px leading-18px text-t-secondary'>
        <span className='font-600 text-t-primary'>{t('connectorCatalog.sections.guidedSetup')}</span>
        <Tag color={setupStateColor(connector.guided_setup.state)}>
          {t(`connectorCatalog.setupStates.${connector.guided_setup.state}`)}
        </Tag>
        <span>
          {t(
            isGuidedAuth && !showTechnicalDetails
              ? 'connectorCatalog.setupActions.guided_auth_setup_public'
              : `connectorCatalog.setupActions.${connector.guided_setup.primary_action}`
          )}
        </span>
      </div>

      {showTechnicalDetails ? (
        <details className='text-12px leading-18px text-t-secondary'>
          <summary className='cursor-pointer font-600 text-t-primary'>
            {t('connectorCatalog.sections.technicalDetails')}
          </summary>
          <dl className='mt-10px grid gap-x-12px gap-y-6px sm:grid-cols-[150px_minmax(0,1fr)]'>
            <dt className='text-t-tertiary'>{t('connectorCatalog.labels.auth')}</dt>
            <dd className='m-0 break-words'>{textOrDash(connector.auth_method)}</dd>
            <dt className='text-t-tertiary'>{t('connectorCatalog.labels.surface')}</dt>
            <dd className='m-0 break-words'>{textOrDash(connector.auth_surface)}</dd>
            <dt className='text-t-tertiary'>{t('connectorCatalog.labels.technicalSource')}</dt>
            <dd className='m-0 break-words'>{textOrDash(connector.preflight_result_file)}</dd>
            <dt className='text-t-tertiary'>{t('connectorCatalog.labels.reason')}</dt>
            <dd className='m-0 break-words'>{connector.guided_setup.reason_code}</dd>
            <dt className='text-t-tertiary'>{t('connectorCatalog.labels.systemChanges')}</dt>
            <dd className='m-0 break-words'>
              {connector.guided_setup.mcp_enable_allowed
                ? t('connectorCatalog.values.allowed')
                : t('connectorCatalog.values.blocked')}
            </dd>
            <dt className='text-t-tertiary'>{t('connectorCatalog.labels.secrets')}</dt>
            <dd className='m-0 break-words'>
              {t(`connectorCatalog.secretHandling.${connector.guided_setup.secret_handling}`)}
            </dd>
          </dl>
          <div className='mt-10px grid gap-10px lg:grid-cols-2'>
            <div>
              <div className='mb-6px text-12px font-600 leading-18px text-t-primary'>
                {t('connectorCatalog.sections.allowed')}
              </div>
              <div className='flex flex-wrap gap-6px'>
                {firstItems(connector.allowed_actions, 4).map((action) => (
                  <Tag key={action} color='green'>
                    {action}
                  </Tag>
                ))}
                {connector.allowed_actions.length === 0 ? <Tag color='gray'>-</Tag> : null}
              </div>
            </div>
            <div>
              <div className='mb-6px text-12px font-600 leading-18px text-t-primary'>
                {t('connectorCatalog.sections.blocked')}
              </div>
              <div className='flex flex-wrap gap-6px'>
                {firstItems(connector.blocked_actions, 4).map((action) => (
                  <Tag key={action} color='red'>
                    {action}
                  </Tag>
                ))}
                {connector.blocked_actions.length === 0 ? <Tag color='gray'>-</Tag> : null}
              </div>
            </div>
          </div>
        </details>
      ) : null}

      {/* Only the two LIVE actions render as a real button. request_humangate /
          inspect_blocker / view_receipt have no in-app handler (no dead controls,
          founder 2026-07-05) — they render as an honest status note instead. */}
      {canRunPreflight || canUseGuidedAuth ? (
        <Button
          data-testid={`connector-preflight-button-${connector.id}`}
          disabled={running}
          loading={running}
          className='self-start'
          title={
            canRunPreflight
              ? t('connectorCatalog.actions.runPreflightTitle')
              : t('connectorCatalog.actions.guidedAuthTitle')
          }
          onClick={() => (isGuidedAuth ? onGuidedAuthSetup(connector) : onRunPreflight(connector.id))}
        >
          {t(`connectorCatalog.setupActions.${connector.guided_setup.primary_action}`)}
        </Button>
      ) : (
        <div data-testid={`connector-status-note-${connector.id}`} className='text-12px leading-18px text-t-tertiary'>
          {t(`connectorCatalog.statusNote.${connector.guided_setup.primary_action}`, {
            defaultValue: t('connectorCatalog.statusNote.default', {
              defaultValue: 'Kein direkter Schritt in der App nötig.',
            }),
          })}
        </div>
      )}
    </article>
  );
};

const ConnectorCatalogPage: React.FC = () => {
  const { t } = useTranslation();
  const { founderBuild: showTechnicalDetails } = useCommandEveFounderBuild();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ConnectorCatalogResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflightStatus, setPreflightStatus] = useState<ConnectorPreflightResult | null>(null);
  const [runningPreflightId, setRunningPreflightId] = useState<string | null>(null);
  // S5-P2 guided-auth-setup modal state.
  const [authModalConnector, setAuthModalConnector] = useState<ConnectorCatalogCard | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    if (!isElectronDesktop()) {
      setResult({
        version: 'command-eve-connector-catalog/v0',
        ok: false,
        status: 'blocked',
        reason_code: 'CONNECTOR_CATALOG_ELECTRON_BRIDGE_REQUIRED',
        message: t('connectorCatalog.blocked.electronBridgeRequired'),
        source: {
          generated_by: 'command-eve-connector-catalog-core',
        },
      });
      setLoading(false);
      return;
    }

    try {
      const response = await connectorCatalogBridge.invoke(undefined);
      setResult(response.data ?? null);
      if (!response.success && !response.data) {
        setError(response.msg || t('connectorCatalog.errors.loadFailed'));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('connectorCatalog.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runPreflight = useCallback(
    async (connectorId: string) => {
      setRunningPreflightId(connectorId);
      setPreflightStatus(null);
      try {
        const response = await connectorPreflightBridge.invoke({
          connectorId,
          manifestPath: result?.model?.source.manifest_path,
        });
        setPreflightStatus(response.data ?? null);
        await refresh();
      } catch (preflightError) {
        setPreflightStatus({
          version: 'command-eve-connector-preflight/v0',
          ok: false,
          status: 'failed',
          connector_id: connectorId,
          reason_code: 'CONNECTOR_PREFLIGHT_UI_FAILED',
          message:
            preflightError instanceof Error ? preflightError.message : t('connectorCatalog.errors.preflightFailed'),
        });
      } finally {
        setRunningPreflightId(null);
      }
    },
    [refresh, result?.model?.source.manifest_path, t]
  );

  const submitGuidedAuth = useCallback(
    async (input: { connectorId: string; secrets: Record<string, string>; humanGateReceipt: string }) => {
      setAuthSubmitting(true);
      try {
        const response = await guidedAuthSetupBridge.invoke({
          connectorId: input.connectorId,
          secrets: input.secrets,
          scope: 'founder',
          humanGateReceipt: input.humanGateReceipt,
          manifestPath: result?.model?.source.manifest_path,
        });
        if (response.success && response.data?.ok) {
          Message.success(t('connectorCatalog.setupModal.storedSuccess'));
          setAuthModalConnector(null);
          await refresh();
        } else {
          Message.error(
            showTechnicalDetails
              ? response.msg || response.data?.reason_code || t('connectorCatalog.setupModal.setupFailed')
              : t('connectorCatalog.setupModal.setupFailed')
          );
        }
      } catch (authError) {
        Message.error(
          showTechnicalDetails && authError instanceof Error
            ? authError.message
            : t('connectorCatalog.setupModal.setupFailed')
        );
      } finally {
        setAuthSubmitting(false);
      }
    },
    [refresh, result?.model?.source.manifest_path, showTechnicalDetails, t]
  );

  const model = result?.model;
  const summaryRows = useMemo(
    () =>
      model
        ? (Object.entries(model.summary) as Array<[ConnectorEvidenceState, number]>).filter(([, value]) => value > 0)
        : [],
    [model]
  );

  return (
    <SettingsPageWrapper contentClassName='max-w-1120px'>
      <div className='flex w-full flex-col gap-16px'>
        <header className='eve-page-header'>
          <div className='eve-page-header__copy'>
            <div className='flex items-center gap-8px'>
              <h1>{t('connectorCatalog.title')}</h1>
              <Tag color='gray'>{t('connectorCatalog.readOnly')}</Tag>
            </div>
            <p>{t('connectorCatalog.subtitle')}</p>
          </div>
          <Button shape='round' onClick={() => void refresh()} loading={loading}>
            {t('connectorCatalog.refresh')}
          </Button>
        </header>

        {loading ? (
          <div className='flex min-h-260px items-center justify-center rounded-16px border border-dashed border-border-2 bg-fill-1'>
            <Spin />
          </div>
        ) : error ? (
          <Alert
            type='error'
            title={t('connectorCatalog.errors.loadFailed')}
            content={showTechnicalDetails ? error : t('connectorCatalog.errors.loadFailedDescription')}
          />
        ) : !result || result.status !== 'ready' || !model ? (
          <Alert
            type='warning'
            title={t('connectorCatalog.blocked.title')}
            content={
              showTechnicalDetails
                ? `${result?.reason_code || 'CONNECTOR_CATALOG_UNAVAILABLE'}: ${result?.message || t('connectorCatalog.blocked.description')}`
                : t('connectorCatalog.blocked.description')
            }
          />
        ) : (
          <>
            <section className='eve-settings-group'>
              <div className='flex flex-wrap items-start justify-between gap-12px'>
                <div className='max-w-720px'>
                  <div className='text-15px font-700 leading-22px text-t-primary'>
                    {t('connectorCatalog.security.title')}
                  </div>
                  <p className='m-0 mt-4px text-13px leading-20px text-t-secondary'>
                    {t('connectorCatalog.security.summary')} {t('connectorCatalog.security.approval')}{' '}
                    {t('connectorCatalog.security.minimumAccess')}
                  </p>
                </div>
                <Tag color='green'>{t('connectorCatalog.values.protectionActive')}</Tag>
              </div>
              {showTechnicalDetails ? (
                <div className='mt-12px grid gap-8px text-12px leading-18px text-t-secondary sm:grid-cols-2'>
                  <span>{`${t('connectorCatalog.labels.generatedAt')}: ${textOrDash(model.generated_at)}`}</span>
                  <span className='min-w-0 truncate'>{`${t('connectorCatalog.labels.manifest')}: ${textOrDash(model.source.manifest_path)}`}</span>
                  <span className='min-w-0 truncate'>{`${t('connectorCatalog.labels.companyRoot')}: ${textOrDash(model.source.company_os_root)}`}</span>
                  <span className='min-w-0 truncate'>{`${t('connectorCatalog.labels.authority')}: ${textOrDash(model.policy.state_authority)}`}</span>
                  <span>{textOrDash(model.policy.secret_rule)}</span>
                  <span>{textOrDash(model.policy.write_rule)}</span>
                  <Tag color='red'>{`${t(
                    'connectorCatalog.labels.mcpEnable'
                  )}: ${t('connectorCatalog.values.blocked')}`}</Tag>
                  <Tag color='gray'>{model.mcp_enable_policy.reason_code}</Tag>
                  {model.mcp_enable_policy.blocked_transports.map((transport) => (
                    <Tag key={transport} color='red'>
                      {transport}
                    </Tag>
                  ))}
                </div>
              ) : null}
            </section>

            {preflightStatus ? (
              <div className='flex flex-col gap-8px'>
                <Alert
                  type={preflightStatus.ok ? 'success' : 'warning'}
                  title={
                    preflightStatus.ok
                      ? t('connectorCatalog.preflight.successTitle')
                      : t('connectorCatalog.preflight.blockedTitle')
                  }
                  content={
                    showTechnicalDetails
                      ? `${preflightStatus.reason_code || preflightStatus.status}: ${
                          preflightStatus.receipt_path || preflightStatus.message || '-'
                        }`
                      : t(
                          preflightStatus.ok
                            ? 'connectorCatalog.preflight.successDescription'
                            : 'connectorCatalog.preflight.blockedDescription'
                        )
                  }
                />
                {showTechnicalDetails && preflightStatus.audit_event_path ? (
                  <div
                    data-testid='connector-preflight-audit-event-path'
                    className='rounded-12px border border-solid border-[var(--color-border-2)] bg-[var(--color-bg-2)] px-12px py-8px text-12px leading-18px text-t-secondary'
                  >
                    <span className='mr-6px font-600 text-t-primary'>{t('connectorCatalog.labels.auditEvent')}:</span>
                    <code className='break-all rounded-6px bg-[var(--color-fill-2)] px-6px py-2px text-t-primary'>
                      {preflightStatus.audit_event_path}
                    </code>
                  </div>
                ) : null}
              </div>
            ) : null}

            {summaryRows.length > 0 ? (
              <section className='eve-settings-group'>
                <h2 className='m-0 text-16px font-700 leading-24px text-t-primary'>
                  {t('connectorCatalog.sections.statusOverview')}
                </h2>
                <div className='mt-12px grid grid-cols-2 gap-x-16px gap-y-14px lg:grid-cols-4'>
                  {summaryRows.map(([state, value]) => (
                    <div key={state} className='min-w-0'>
                      <div className='text-24px font-700 leading-30px text-t-primary'>{value}</div>
                      <div className='mt-2px text-12px leading-18px text-t-secondary'>
                        {t(`connectorCatalog.states.${state}`)}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className='eve-settings-group'>
              <div className='flex items-center justify-between gap-12px'>
                <h2 className='m-0 text-18px font-700 leading-26px text-t-primary'>
                  {t('connectorCatalog.sections.connectors')}
                </h2>
                <Tag color='gray'>{model.connectors.length}</Tag>
              </div>
              {model.connectors.length > 0 ? (
                <div className='mt-8px'>
                  {model.connectors.map((connector, index) => (
                    <ConnectorCard
                      key={connector.id}
                      connector={connector}
                      running={runningPreflightId === connector.id}
                      showTechnicalDetails={showTechnicalDetails}
                      hasTopBorder={index > 0}
                      onRunPreflight={runPreflight}
                      onGuidedAuthSetup={setAuthModalConnector}
                    />
                  ))}
                </div>
              ) : (
                <Empty description={t('connectorCatalog.empty.noConnectors')} />
              )}
            </section>

            {showTechnicalDetails ? (
              <section className='eve-settings-group'>
                <h2 className='m-0 text-16px font-700 leading-24px text-t-primary'>
                  {t('connectorCatalog.sections.globalBlocked')}
                </h2>
                <div className='mt-10px flex flex-wrap gap-6px'>
                  {model.blocked_actions.map((action) => (
                    <Tag key={action} color='red'>
                      {t(blockedActionLabelKey(action), { defaultValue: action })}
                    </Tag>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      <GuidedAuthSetupModal
        connector={authModalConnector}
        visible={authModalConnector !== null}
        submitting={authSubmitting}
        showTechnicalDetails={showTechnicalDetails}
        onCancel={() => setAuthModalConnector(null)}
        onSubmit={submitGuidedAuth}
      />
    </SettingsPageWrapper>
  );
};

export default ConnectorCatalogPage;
