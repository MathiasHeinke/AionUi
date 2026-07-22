/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import {
  COMMAND_EVE_DEFAULT_LOCAL_MODEL_TIER_ID,
  COMMAND_EVE_LOCAL_MODEL_TIERS,
  COMMAND_EVE_SHELL_ENABLED,
  normalizeCommandEveLocalModelTierId,
} from '@/common/config/commandEveShell';
import type { IProvider } from '@/common/config/storage';
import { Button, Divider, Message, Popconfirm, Collapse, Tag, Switch, Tooltip } from '@arco-design/web-react';
import { CheckOne, CloseOne, DeleteFour, Heartbeat, Info, Minus, Plus, Refresh, Write } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AddModelModal from '@/renderer/pages/settings/components/AddModelModal';
import AddPlatformModal from '@/renderer/pages/settings/components/AddPlatformModal';
import { isNewApiPlatform, NEW_API_PROTOCOL_OPTIONS } from '@/renderer/utils/model/modelPlatforms';
import EditModeModal from '@/renderer/pages/settings/components/EditModeModal';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useProvidersQuery } from '@/renderer/hooks/agent/useModelProviderList';
import { useSettingsViewMode } from '../settingsViewContext';
import { consumePendingDeepLink } from '@/renderer/hooks/system/useDeepLink';
import { useEntitlementGate } from '@/renderer/hooks/useEntitlementGate';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';
import { shouldDisableModelByok } from '@/common/config/eveInferenceCore';
import { bridge as platformBridge } from '@office-ai/platform';
import SettingsSection, { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';
import { EVE_SETTINGS_TAG_COLOR } from '@/renderer/components/settings/settingsSemantics';
import { commandEveLocalPullMatchesTier } from './commandEveLocalModelUiCore';
import { filterUserManagedProviders, isUserManagedProviderId } from './providerProtectionCore';
import '../model-provider.css';

/** 1.6.3 — the per-tier disk truth the status bridge injects (see localRuntimeStatusCore). */
type CommandEveLocalTierProbe = {
  installed: boolean;
  installed_size_bytes?: number;
  ram_fit: boolean;
  disk_fit: boolean;
  resume_available: boolean;
  ready_for_use: boolean;
  recommended: boolean;
  status_known: boolean;
  runtime: 'ollama' | 'bonsai-prism' | 'colibri';
  runtime_model_ref?: string;
  model_ref?: string;
};

const localRuntimeStatusBridge = platformBridge.buildProvider<
  {
    success: boolean;
    data?: {
      model?: {
        tiers?: Array<{
          id: string;
          installed?: boolean;
          installed_size_bytes?: number;
          ram_fit?: boolean;
          disk_fit?: boolean;
          resume_available?: boolean;
          ready_for_use?: boolean;
          recommended?: boolean;
          status_known?: boolean;
          runtime?: 'ollama' | 'bonsai-prism' | 'colibri';
          runtime_model_ref?: string;
          model_ref?: string;
        }>;
        warnings?: string[];
        model_pull?: { model: string; percent: number; status: string };
      };
    };
  },
  { manifestPath?: string } | undefined
>('command-eve.local-runtime-status');

/**
 * 获取协议显示标签颜色
 * Get protocol badge color
 */
const getProtocolColor = (protocol: string): string => {
  switch (protocol) {
    case 'gemini':
      return 'blue';
    case 'anthropic':
      return 'gold';
    case 'openai':
    default:
      return 'green';
  }
};

/**
 * 获取协议显示名称
 * Get protocol display name
 */
const getProtocolLabel = (protocol: string): string => {
  return NEW_API_PROTOCOL_OPTIONS.find((p) => p.value === protocol)?.label || 'OpenAI';
};

/**
 * 获取下一个协议（循环切换）
 * Get next protocol (cycle through options)
 */
const getNextProtocol = (current: string): string => {
  const idx = NEW_API_PROTOCOL_OPTIONS.findIndex((p) => p.value === current);
  const nextIdx = (idx + 1) % NEW_API_PROTOCOL_OPTIONS.length;
  return NEW_API_PROTOCOL_OPTIONS[nextIdx].value;
};

// Calculate API Key count
const getApiKeyCount = (api_key: string): number => {
  if (!api_key) return 0;
  return api_key.split(/[,\n]/).filter((k) => k.trim().length > 0).length;
};

/**
 * 获取供应商的启用状态（全选/半选/全不选）
 * Get provider enable state (all/partial/none)
 */
const getProviderState = (platform: IProvider): { checked: boolean; indeterminate: boolean } => {
  if (!platform.model_enabled) {
    // 没有 model_enabled 记录，默认全部启用
    return { checked: true, indeterminate: false };
  }

  const models = platform.models ?? [];
  const enabledCount = models.filter((model) => platform.model_enabled?.[model] !== false).length;
  const totalCount = models.length;

  if (enabledCount === 0) {
    return { checked: false, indeterminate: false }; // 全不选
  } else if (enabledCount === totalCount) {
    return { checked: true, indeterminate: false }; // 全选
  } else {
    return { checked: true, indeterminate: true }; // 半选（有模型开启，显示为开启状态）
  }
};

/**
 * 检查模型是否启用
 * Check if model is enabled
 */
const isModelEnabled = (platform: IProvider, model: string): boolean => {
  if (!platform.model_enabled) return true; // 默认启用
  return platform.model_enabled[model] !== false;
};

const ModelModalContent: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const [collapseKey, setCollapseKey] = useState<Record<string, boolean>>({});
  const [healthCheckLoading, setHealthCheckLoading] = useState<Record<string, boolean>>({});
  const [selectedLocalModelTierId, setSelectedLocalModelTierId] = useState(() =>
    normalizeCommandEveLocalModelTierId(
      configService.get('commandEve.localModelTierId') ?? COMMAND_EVE_DEFAULT_LOCAL_MODEL_TIER_ID
    )
  );
  const { data, mutate } = useProvidersQuery();
  const userManagedProviders = useMemo(() => filterUserManagedProviders(data), [data]);
  const [message, messageContext] = Message.useMessage();

  /**
   * Create when the provider id is new, update otherwise.
   * The caller is expected to have mutated the id-bearing record already.
   */
  const persistPlatform = async (platform: IProvider): Promise<void> => {
    if (!isUserManagedProviderId(platform.id)) {
      throw new Error('COMMAND_EVE_RESERVED_PROVIDER');
    }
    const existing = (data || []).some((item) => item.id === platform.id);
    if (existing) {
      const { id, ...body } = platform;
      await ipcBridge.mode.updateProvider.invoke({ id, ...body });
    } else {
      await ipcBridge.mode.createProvider.invoke(platform);
    }
  };

  const updatePlatform = (platform: IProvider, success: () => void) => {
    const existing = (data || []).find((item) => item.id === platform.id);
    const nextArray = existing
      ? (data || []).map((item) => (item.id === platform.id ? { ...item, ...platform } : item))
      : [...(data || []), platform];

    // Optimistic update
    void mutate(nextArray, false);

    persistPlatform(platform)
      .then(() => {
        void mutate();
        success();
      })
      .catch((error) => {
        void mutate();
        console.error('Failed to save provider:', error);
        // 409 Conflict — duplicate id (rare pre-launch); different toast
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('409')) {
          message.error(t('settings.providerIdConflict', { defaultValue: 'Provider id already exists, retry.' }));
        } else {
          message.error(t('settings.saveModelConfigFailed'));
        }
      });
  };

  const removePlatform = (id: string) => {
    if (!isUserManagedProviderId(id)) return;
    const nextArray = (data ?? []).filter((item: IProvider) => item.id !== id);
    void mutate(nextArray, false);
    ipcBridge.mode.deleteProvider
      .invoke({ id })
      .then(() => {
        void mutate();
      })
      .catch((error) => {
        void mutate();
        console.error('Failed to delete provider:', error);
        message.error(t('settings.saveModelConfigFailed'));
      });
  };

  const selectCommandEveLocalModelTier = async (tierId: string): Promise<boolean> => {
    const normalizedTierId = normalizeCommandEveLocalModelTierId(tierId);
    setSelectedLocalModelTierId(normalizedTierId);
    try {
      await configService.set('commandEve.localModelTierId', normalizedTierId);
      message.success(t('settings.commandEveLocalRuntimeSelected'));
      return true;
    } catch (error) {
      console.error('Failed to save Command EVE local model tier:', error);
      setSelectedLocalModelTierId(
        normalizeCommandEveLocalModelTierId(
          configService.get('commandEve.localModelTierId') ?? COMMAND_EVE_DEFAULT_LOCAL_MODEL_TIER_ID
        )
      );
      message.error(t('settings.saveModelConfigFailed'));
      return false;
    }
  };

  // ── 1.6.3: the model cards tell the TRUTH (audit wf_9db95fb2: "Auswählen"
  // only wrote a config key + toasted "gespeichert" — no install check, no
  // download, no hardware fit). The status bridge injects installed/fits/
  // recommended per tier; the (previously caller-less) ensureLocalModelTier IPC
  // finally powers a real download button; pull progress streams via the poll.
  const [localTiers, setLocalTiers] = useState<Record<string, CommandEveLocalTierProbe>>({});
  const [localPull, setLocalPull] = useState<{ model: string; percent: number; status: string } | null>(null);
  const [ensuringTierId, setEnsuringTierId] = useState<string | null>(null);
  useEffect(() => {
    if (!COMMAND_EVE_SHELL_ENABLED) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      let pulling = false;
      try {
        const res = await localRuntimeStatusBridge.invoke({});
        const model = res?.data?.model;
        if (alive && model) {
          const byId: Record<string, CommandEveLocalTierProbe> = {};
          for (const tier of model.tiers ?? []) {
            byId[tier.id] = {
              installed: tier.installed === true,
              installed_size_bytes:
                typeof tier.installed_size_bytes === 'number' ? tier.installed_size_bytes : undefined,
              ram_fit: tier.ram_fit !== false,
              disk_fit: tier.disk_fit !== false,
              resume_available: tier.resume_available === true,
              ready_for_use: tier.ready_for_use === true,
              recommended: tier.recommended === true,
              status_known: tier.status_known !== false,
              runtime:
                tier.runtime === 'bonsai-prism' ? 'bonsai-prism' : tier.runtime === 'colibri' ? 'colibri' : 'ollama',
              runtime_model_ref: tier.runtime_model_ref,
              model_ref: tier.model_ref,
            };
          }
          setLocalTiers(byId);
          const pull = model.model_pull;
          if (pull && ['pulling', 'building'].includes(pull.status)) {
            pulling = true;
            setLocalPull({ model: pull.model, percent: pull.percent, status: pull.status });
          } else {
            setLocalPull(null);
          }
        }
      } catch {
        /* fail-soft: cards keep their last honest state */
      }
      if (alive) timer = setTimeout(() => void load(), pulling ? 2500 : 10000);
    };
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Download & activate: persist the tier choice (unchanged select path), then
  // fire the full ensure pass (bootstrap re-run → streamOllamaPull with the
  // live progress side-file → warm-up). NOT awaited to completion for UI state —
  // progress arrives via the status poll; a blocked result surfaces honestly.
  const downloadCommandEveLocalModelTier = async (tierId: string): Promise<void> => {
    const normalizedTierId = normalizeCommandEveLocalModelTierId(tierId);
    setEnsuringTierId(normalizedTierId);
    try {
      if (!(await selectCommandEveLocalModelTier(normalizedTierId))) return;
      const res = await ipcBridge.commandEve.ensureLocalModelTier.invoke({ tierId: normalizedTierId });
      const status = res?.data?.status;
      if (status && status !== 'ready') {
        message.warning(
          t('settings.commandEveLocalRuntimeEnsureBlocked', {
            reason: res?.data?.next_action || status,
          })
        );
      }
    } catch (error) {
      console.error('Command EVE local model ensure failed:', error);
    } finally {
      setEnsuringTierId(null);
    }
  };

  // 切换供应商启用状态（全选 ↔ 全不选）
  const toggleProviderEnabled = (platform: IProvider) => {
    const { checked } = getProviderState(platform);
    const newState = !checked; // 切换状态

    // 批量更新所有模型状态
    const model_enabled: Record<string, boolean> = {};
    (platform.models ?? []).forEach((model) => {
      model_enabled[model] = newState;
    });

    const updated = {
      ...platform,
      model_enabled,
    };
    updatePlatform(updated, () => {});
  };

  // 切换模型启用状态
  const toggleModelEnabled = (platform: IProvider, model: string, enabled: boolean) => {
    const model_enabled = { ...platform.model_enabled };
    model_enabled[model] = enabled;

    const updated = {
      ...platform,
      model_enabled,
    };

    updatePlatform(updated, () => {});
  };

  // Execute provider/model health check without creating a conversation.
  const performHealthCheck = async (platform: IProvider, modelName: string) => {
    const loadingKey = `${platform.id}-${modelName}`;
    setHealthCheckLoading((prev) => ({ ...prev, [loadingKey]: true }));

    const startTime = Date.now();

    try {
      const result = await ipcBridge.acpConversation.checkProviderHealth.invoke({
        provider_id: platform.id,
        model: modelName,
      });
      const latency = result.elapsed_ms || Date.now() - startTime;
      const success = result.status === 'healthy';
      const errorMessage = result.message || t('common.unknownError');

      try {
        // 先获取最新的数据，确保不会覆盖其他并发的更新
        const latestData = await ipcBridge.mode.listProviders.invoke();
        const latestPlatform = (latestData || []).find((item) => item.id === platform.id);
        const model_health = { ...latestPlatform?.model_health };
        model_health[modelName] = {
          status: success ? 'healthy' : 'unhealthy',
          last_check: Date.now(),
          latency,
          error: success ? undefined : errorMessage,
        };

        await ipcBridge.mode.updateProvider.invoke({ id: platform.id, model_health });
        await mutate();
        if (success) {
          Message.success({
            content: `${platform.name} - ${modelName}: ${t('common.success')} (${latency}ms)`,
            duration: 3000,
          });
        } else {
          Message.error({
            content: `${platform.name} - ${modelName}: ${t('common.failed')} - ${errorMessage}`,
            duration: 5000,
          });
        }
      } catch (saveError) {
        console.error('Failed to save health check result:', saveError);
        Message.error({
          content: t('settings.saveModelConfigFailed'),
          duration: 3000,
        });
      }
    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      Message.error({
        content: `${platform.name} - ${modelName}: ${t('common.failed')} - ${errorMessage}`,
        duration: 5000,
      });

      try {
        // 先获取最新的数据，确保不会覆盖其他并发的更新
        const latestData = await ipcBridge.mode.listProviders.invoke();
        const latestPlatform = (latestData || []).find((item) => item.id === platform.id);
        const model_health = { ...latestPlatform?.model_health };
        model_health[modelName] = {
          status: 'unhealthy',
          last_check: Date.now(),
          latency,
          error: errorMessage,
        };

        await ipcBridge.mode.updateProvider.invoke({ id: platform.id, model_health });
        await mutate();
      } catch (saveError) {
        console.error('Failed to save health check result:', saveError);
      }
    } finally {
      setHealthCheckLoading((prev) => ({ ...prev, [loadingKey]: false }));
    }
  };

  const clearAllHealthData = () => {
    if (!data) return;
    const nextArray: IProvider[] = data.map((platform: IProvider) => ({
      ...platform,
      model_health: undefined as IProvider['model_health'],
    }));
    void mutate(nextArray, false);

    Promise.all(
      (data || []).map((platform) => ipcBridge.mode.updateProvider.invoke({ id: platform.id, model_health: {} }))
    )
      .then(() => {
        void mutate();
        Message.success({
          content: t('settings.healthStatusCleared'),
          duration: 2000,
        });
      })
      .catch((error) => {
        void mutate();
        console.error('Failed to clear health status:', error);
        message.error(t('settings.saveModelConfigFailed'));
      });
  };

  // BYOK (bring-your-own-key) gating (1.2.18 Req 4 + v1.5 M7): adding an own model
  // / API key (offline OR cloud — both flow through the "Add Platform" path) is
  // unlocked by EITHER paid path — a PAID CLIENT SEAT (has_paid_seat) OR an ACTIVE
  // CREDIT SUBSCRIPTION (has_active_topup, from 25 €/Monat). Free AND trial
  // entitlements are greyed out. Both discriminants are main-process-derived
  // honest hints (has_paid_seat from the entitlement, has_active_topup from
  // credits-status); the server stays the binding gate for everything
  // money-metered. A transient credits read is UNKNOWN, never a synthetic free
  // result; only an authoritative `ok:true` response may confirm no top-up.
  const { status: entitlementStatus } = useEntitlementGate();
  const { status: creditsStatus } = useCreditsStatus();
  const proFeatureView = useMemo(
    () => ({
      trial_ends_at: entitlementStatus?.trial_ends_at ?? null,
      has_paid_seat: entitlementStatus?.has_paid_seat === true,
      // Additive M7 unlock. Absent (pre-deploy / no subscription) ⇒ false ⇒
      // today's paid-seat-only behavior.
      has_active_topup: creditsStatus?.ok === true && creditsStatus.has_active_topup === true,
    }),
    [
      entitlementStatus?.trial_ends_at,
      entitlementStatus?.has_paid_seat,
      creditsStatus?.ok,
      creditsStatus?.has_active_topup,
    ]
  );
  const byokDisabled = COMMAND_EVE_SHELL_ENABLED && shouldDisableModelByok(proFeatureView, creditsStatus?.ok === true);

  const [addPlatformModalCtrl, addPlatformModalContext] = AddPlatformModal.useModal({
    onSubmit(platform) {
      updatePlatform(platform, () => {
        setCollapseKey((prev) => ({ ...prev, [platform.id]: true }));
        addPlatformModalCtrl.close();
      });
    },
  });

  // Consume pending deep-link data on mount (set by useDeepLink hook before navigation)
  useEffect(() => {
    const pending = consumePendingDeepLink();
    if (pending && !byokDisabled) {
      addPlatformModalCtrl.open({ deepLinkData: pending });
    }
  }, [addPlatformModalCtrl, byokDisabled]);

  const [addModelModalCtrl, addModelModalContext] = AddModelModal.useModal({
    onSubmit(platform) {
      updatePlatform(platform, () => {
        setCollapseKey((prev) => ({ ...prev, [platform.id]: true }));
        addModelModalCtrl.close();
      });
    },
  });

  const [editModalCtrl, editModalContext] = EditModeModal.useModal({
    onChange(platform) {
      updatePlatform(platform, () => editModalCtrl.close());
    },
  });

  return (
    <div className='eve-model-settings'>
      {messageContext}
      {addPlatformModalContext}
      {editModalContext}
      {addModelModalContext}

      <SettingsPageHeader
        title={t('settings.model')}
        description={
          COMMAND_EVE_SHELL_ENABLED
            ? t('settings.modelPageDescription', {
                defaultValue: 'Wähle EVEs lokale Verarbeitungsspur und verwalte optionale eigene Modelle.',
              })
            : t('settings.customModelSupportNote')
        }
      />

      {/* Content Area */}
      <AionScrollArea className='flex-1 min-h-0' disableOverflow={isPageMode}>
        {COMMAND_EVE_SHELL_ENABLED && (
          <SettingsSection
            testId='command-eve-local-runtime-section'
            title={t('settings.commandEveLocalRuntime')}
            description={t('settings.commandEveLocalRuntimeRestartNote')}
            action={<Tag color='arcoblue'>{t('settings.commandEveLocalRuntimeBackend')}</Tag>}
            bodyClassName='eve-model-tier-list'
          >
            {COMMAND_EVE_LOCAL_MODEL_TIERS.map((tier) => {
              const selected = selectedLocalModelTierId === tier.id;
              const displayLabel = t(`settings.commandEveLocalRuntimeLane.${tier.lane}`);
              const displayDescription = t(`settings.commandEveLocalRuntimeLane.${tier.lane}Description`);
              // 1.6.3 — the card's honest state, from the injected probe:
              // installed ✓ / lädt X % / nicht geladen / läuft nicht auf
              // diesem Mac / Status unbekannt (Ollama down). No probe row
              // yet (first render) keeps the old claim-free card.
              const probe = localTiers[tier.id];
              const resumeAvailable = probe?.runtime === 'colibri' && probe.resume_available;
              const fits = !probe || (probe.ram_fit && (probe.disk_fit || resumeAvailable));
              // Percent is only ever THIS tier's pull (review fix: a click on
              // tier B must not display a foreign/stale tier-A percent).
              const activeThis = commandEveLocalPullMatchesTier(localPull, probe);
              const ensuringThis = ensuringTierId === tier.id;
              const ramBlocked = Boolean(probe && !probe.ram_fit);
              const diskBlocked = Boolean(probe && !probe.disk_fit && !probe.installed && !resumeAvailable);
              const activationBlocked =
                tier.state === 'experimental' ? !probe || ramBlocked || diskBlocked : ramBlocked || diskBlocked;
              // Review fixes: the download affordance ALSO covers the SELECTED
              // tier (the most common broken state) and the Ollama-down case —
              // ensureLocalModelTier starts the runtime itself (idempotent).
              const showDownload = probe !== undefined && !probe.installed && fits;
              return (
                <div
                  key={tier.id}
                  data-testid={`command-eve-model-tier-${tier.id}`}
                  className='eve-model-tier'
                  data-selected={selected ? 'true' : 'false'}
                >
                  <div className='eve-model-tier__header'>
                    <div className='eve-model-tier__copy'>
                      <div className='eve-model-tier__title-line'>
                        <strong>{displayLabel}</strong>
                        {probe?.recommended && (
                          <Tag color='arcoblue'>{t('settings.commandEveLocalRuntimeRecommended')}</Tag>
                        )}
                        {tier.state === 'experimental' && (
                          <Tag color={EVE_SETTINGS_TAG_COLOR.attention}>
                            {t('settings.commandEveLocalRuntimeExperimental')}
                          </Tag>
                        )}
                        {tier.alignment === 'uncensored' && (
                          <Tag color={EVE_SETTINGS_TAG_COLOR.attention}>
                            {t('settings.commandEveLocalRuntimeUncensored')}
                          </Tag>
                        )}
                        {tier.toolCalling === 'preview' && (
                          <Tag color='purple'>{t('settings.commandEveLocalRuntimeToolPreview')}</Tag>
                        )}
                      </div>
                      <span>{displayDescription}</span>
                    </div>
                  </div>
                  <div className='eve-model-tier__state' data-testid={`command-eve-model-tier-state-${tier.id}`}>
                    {activeThis ? (
                      <Tag color='blue'>
                        {localPull?.status === 'building'
                          ? t('settings.commandEveLocalRuntimeBuilding')
                          : t('settings.commandEveLocalRuntimeDownloading', { percent: localPull?.percent ?? 0 })}
                      </Tag>
                    ) : selected && probe?.installed && !probe.ready_for_use ? (
                      <Tag color={EVE_SETTINGS_TAG_COLOR.attention}>
                        {t('settings.commandEveLocalRuntimeVerificationRequired')}
                      </Tag>
                    ) : probe?.installed ? (
                      <Tag color='green'>{t('settings.commandEveLocalRuntimeInstalled')}</Tag>
                    ) : probe && !probe.status_known ? (
                      <Tag color='gray'>{t('settings.commandEveLocalRuntimeStatusUnknown')}</Tag>
                    ) : probe ? (
                      <Tag color='gray'>{t('settings.commandEveLocalRuntimeNotInstalled')}</Tag>
                    ) : null}
                    {resumeAvailable && !activeThis && (
                      <Tag color={EVE_SETTINGS_TAG_COLOR.attention}>
                        {t('settings.commandEveLocalRuntimeResumeAvailable')}
                      </Tag>
                    )}
                    {probe && !fits && <Tag color='gray'>{t('settings.commandEveLocalRuntimeNotOnThisMac')}</Tag>}
                  </div>
                  <div className='eve-model-tier__meta'>
                    {t('settings.commandEveLocalRuntimeMeta', {
                      context: `${Math.round(tier.contextLength / 1024)}k`,
                      memory: tier.memoryGb,
                      disk: tier.diskGb,
                    })}
                    {` · ${t('settings.commandEveLocalRuntimeRecommendedMemory', {
                      memory: tier.recommendedMemoryGb,
                    })}`}
                    {probe?.installed && typeof probe.installed_size_bytes === 'number'
                      ? ` · ${t('settings.commandEveLocalRuntimeInstalledSize', { gb: (probe.installed_size_bytes / 1024 ** 3).toFixed(1) })}`
                      : ''}
                  </div>
                  {selected && probe?.ready_for_use && !showDownload && !activationBlocked ? (
                    <Tag
                      className='eve-model-tier__action'
                      color='green'
                      data-testid={`command-eve-model-tier-select-${tier.id}`}
                    >
                      {t('settings.commandEveLocalRuntimeCurrent')}
                    </Tag>
                  ) : (
                    <Button
                      data-testid={`command-eve-model-tier-select-${tier.id}`}
                      className='eve-model-tier__action'
                      type={showDownload || (selected && probe && !probe.ready_for_use) ? 'primary' : 'outline'}
                      size='small'
                      loading={ensuringThis || activeThis}
                      disabled={activationBlocked}
                      onClick={() => void downloadCommandEveLocalModelTier(tier.id)}
                    >
                      {tier.state === 'experimental' && !probe
                        ? t('settings.commandEveLocalRuntimeStatusUnknown')
                        : activationBlocked
                          ? t('settings.commandEveLocalRuntimeNotOnThisMac')
                          : showDownload
                            ? resumeAvailable
                              ? t('settings.commandEveLocalRuntimeResume')
                              : probe && !probe.status_known
                                ? t('settings.commandEveLocalRuntimeStartAndEnsure')
                                : t('settings.commandEveLocalRuntimeDownload')
                            : selected && probe && !probe.ready_for_use
                              ? t('settings.commandEveLocalRuntimeVerifyAndActivate')
                              : t('settings.commandEveLocalRuntimeSelect')}
                    </Button>
                  )}
                </div>
              );
            })}
          </SettingsSection>
        )}
        <SettingsSection
          title={t('settings.customModelsTitle', { defaultValue: 'Eigene Modelle' })}
          description={
            <span data-testid='command-eve-model-support-note'>
              {COMMAND_EVE_SHELL_ENABLED
                ? t('settings.customModelsDescription', {
                    defaultValue:
                      'Optionale Pro-Einstellungen für eigene Modellzugänge. EVE funktioniert auch ohne sie.',
                  })
                : t('settings.customModelSupportNote')}
            </span>
          }
          action={
            <div className='eve-model-settings__actions'>
              <Button size='small' icon={<Refresh size={15} />} onClick={clearAllHealthData}>
                {t('settings.clearStatus')}
              </Button>
              <Tooltip
                content={t(
                  'settings.byokPaidSeatOnly',
                  'Freigeschaltet mit Kunden-Seat ODER Credit-Abo (ab 25 €/Monat)'
                )}
                disabled={!byokDisabled}
              >
                <Button
                  type='primary'
                  size='small'
                  disabled={byokDisabled}
                  icon={<Plus size='16' />}
                  onClick={() => {
                    if (byokDisabled) return;
                    addPlatformModalCtrl.open();
                  }}
                >
                  {t('settings.addModel')}
                </Button>
              </Tooltip>
            </div>
          }
        >
          {userManagedProviders.length === 0 ? (
            <div className='eve-settings-notice eve-settings-inline-notice'>
              <Info theme='outline' size={15} />
              <span>
                <strong className='eve-model-settings__empty-title'>{t('settings.noConfiguredModels')}</strong>
                <span>
                  {t('settings.eveNoConfiguredModelsHint', {
                    defaultValue:
                      'EVE Cloud und die lokale KI sind fest eingebaut — hier musst du nichts einrichten. Eigene Modelle kannst du später als Profi-Option ergänzen.',
                  })}
                </span>
              </span>
            </div>
          ) : (
            <div className='eve-model-provider-list'>
              {userManagedProviders.map((platform: IProvider) => {
                const key = platform.id;
                const isExpanded = collapseKey[platform.id] ?? false;
                return (
                  <Collapse
                    activeKey={isExpanded ? ['image-generation'] : []}
                    onChange={(_, activeKeys) => {
                      const expanded = activeKeys.includes('image-generation');
                      setCollapseKey((prev) => ({ ...prev, [platform.id]: expanded }));
                    }}
                    key={key}
                    bordered={false}
                    expandIconPosition='left'
                    className='eve-model-provider-collapse'
                  >
                    <Collapse.Item
                      name='image-generation'
                      className='eve-model-provider-collapse__item group'
                      header={
                        <div className='group flex items-center justify-between w-full min-h-32px gap-8px min-w-0'>
                          <span
                            className={`text-14px font-500 truncate min-w-0 transition-colors ${isExpanded ? 'text-t-primary' : 'text-2 group-hover:text-1'}`}
                          >
                            {platform.name}
                          </span>
                          <div
                            data-eve-interaction-role='event-boundary'
                            className='flex items-center gap-8px shrink-0'
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                            }}
                          >
                            <span className='text-12px text-t-secondary whitespace-nowrap hidden md:inline-flex items-center overflow-hidden max-w-0 opacity-0 group-hover:max-w-320px group-hover:opacity-100 transition-all duration-180'>
                              <button
                                type='button'
                                className='border-none bg-transparent p-0 text-inherit cursor-pointer hover:text-t-primary transition-colors'
                                onClick={() => setCollapseKey((prev) => ({ ...prev, [platform.id]: !isExpanded }))}
                              >
                                {t('settings.modelCount')}（{(platform.models ?? []).length}）
                              </button>
                              <span className='mx-6px'>|</span>
                              <button
                                type='button'
                                className='border-none bg-transparent p-0 text-inherit cursor-pointer hover:text-t-primary transition-colors'
                                onClick={() => editModalCtrl.open({ data: platform, disabled: byokDisabled })}
                              >
                                {t('settings.apiKeyCount')}（{getApiKeyCount(platform.api_key)}）
                              </button>
                            </span>
                            <span className='text-12px text-t-secondary whitespace-nowrap md:hidden'>
                              {(platform.models ?? []).length} / {getApiKeyCount(platform.api_key)}
                            </span>
                            {/* 供应商启用开关 / Provider enable switch */}
                            <Switch
                              size='small'
                              checked={getProviderState(platform).checked}
                              onChange={() => toggleProviderEnabled(platform)}
                            />
                            <div className='flex items-center gap-4px'>
                              <Button
                                size='mini'
                                className='model-provider-action-btn !w-28px !h-28px !min-w-28px text-t-secondary hover:text-t-primary'
                                icon={<Plus size='14' />}
                                onClick={() => addModelModalCtrl.open({ data: platform })}
                              />
                              <Popconfirm
                                title={t('settings.deleteAllModelConfirm')}
                                onOk={() => removePlatform(platform.id)}
                              >
                                <Button
                                  size='mini'
                                  className='model-provider-action-btn !w-28px !h-28px !min-w-28px text-t-secondary hover:text-t-primary'
                                  icon={<Minus size='14' />}
                                />
                              </Popconfirm>
                              <Button
                                size='mini'
                                className='model-provider-action-btn !w-28px !h-28px !min-w-28px text-t-secondary hover:text-t-primary'
                                icon={<Write size='14' />}
                                onClick={() => editModalCtrl.open({ data: platform, disabled: byokDisabled })}
                              />
                            </div>
                          </div>
                        </div>
                      }
                    >
                      {(platform.models ?? []).map((model: string, index: number, arr: string[]) => {
                        const isNewApiProvider = isNewApiPlatform(platform.platform);
                        const modelProtocol = platform.model_protocols?.[model] || 'openai';
                        const model_health = platform.model_health?.[model];
                        const healthStatus = model_health?.status || 'unknown';

                        return (
                          <div key={model}>
                            <div className='flex items-center justify-between px-8px py-12px transition-colors hover:bg-[var(--fill-0)]'>
                              <div className='flex items-center gap-8px'>
                                {/* 健康状态指示器 / Health status indicator */}
                                {healthStatus !== 'unknown' && (
                                  <Tooltip
                                    content={
                                      <div>
                                        <div className='flex items-center gap-4px'>
                                          {healthStatus === 'healthy' ? (
                                            <CheckOne theme='filled' size={14} className='text-success' />
                                          ) : (
                                            <CloseOne theme='filled' size={14} className='text-danger' />
                                          )}
                                          <span>
                                            {healthStatus === 'healthy' ? t('common.success') : t('common.failed')}
                                          </span>
                                        </div>
                                        {model_health?.latency && (
                                          <div className='text-12px mt-4px'>
                                            {t('settings.latency')}: {model_health.latency}ms
                                          </div>
                                        )}
                                        {model_health?.error && (
                                          <div className='text-12px mt-4px'>{model_health.error}</div>
                                        )}
                                        {model_health?.last_check && (
                                          <div className='text-12px mt-4px'>
                                            {t('mcp.lastCheck')}: {new Date(model_health.last_check).toLocaleString()}
                                          </div>
                                        )}
                                      </div>
                                    }
                                  >
                                    <div
                                      className={`w-8px h-8px rounded-full ${healthStatus === 'healthy' ? 'bg-green-500' : 'bg-red-500'}`}
                                    />
                                  </Tooltip>
                                )}

                                <span className='text-14px text-t-primary'>{model}</span>

                                {/* New API 协议标签（点击循环切换）/ New API protocol badge (click to cycle) */}
                                {isNewApiProvider && (
                                  <Tag
                                    size='small'
                                    color={getProtocolColor(modelProtocol)}
                                    className='cursor-pointer select-none'
                                    onClick={() => {
                                      const nextProtocol = getNextProtocol(modelProtocol);
                                      const newProtocols = { ...platform.model_protocols };
                                      newProtocols[model] = nextProtocol;
                                      updatePlatform({ ...platform, model_protocols: newProtocols }, () => {});
                                    }}
                                  >
                                    {getProtocolLabel(modelProtocol)}
                                  </Tag>
                                )}

                                {/* 模型启用开关 / Model enable switch */}
                                <Switch
                                  size='small'
                                  checked={isModelEnabled(platform, model)}
                                  onChange={(checked) => toggleModelEnabled(platform, model, checked)}
                                />
                              </div>

                              <div className='flex items-center gap-6px shrink-0'>
                                {/* 心跳检测按钮 / Health check button */}
                                <Tooltip content={t('settings.healthCheck')}>
                                  <Button
                                    size='mini'
                                    className='!w-28px !h-28px !min-w-28px !bg-[var(--color-bg-1)] text-t-secondary hover:text-t-primary hover:!bg-[var(--fill-0)]'
                                    icon={<Heartbeat theme='outline' size='16' />}
                                    loading={healthCheckLoading[`${platform.id}-${model}`]}
                                    onClick={() => performHealthCheck(platform, model)}
                                  />
                                </Tooltip>

                                <Popconfirm
                                  title={t('settings.deleteModelConfirm')}
                                  onOk={() => {
                                    const newModels = platform.models.filter((item: string) => item !== model);
                                    // 同时清理模型相关状态，避免删除后重加模型时复用脏状态
                                    // Clean all per-model state to avoid stale state on re-add.
                                    const newProtocols = { ...platform.model_protocols };
                                    const newModelEnabled = { ...platform.model_enabled };
                                    const newModelHealth = { ...platform.model_health };
                                    delete newProtocols[model];
                                    delete newModelEnabled[model];
                                    delete newModelHealth[model];

                                    updatePlatform(
                                      {
                                        ...platform,
                                        models: newModels,
                                        model_protocols:
                                          Object.keys(newProtocols).length > 0 ? newProtocols : undefined,
                                        model_enabled:
                                          Object.keys(newModelEnabled).length > 0 ? newModelEnabled : undefined,
                                        model_health:
                                          Object.keys(newModelHealth).length > 0 ? newModelHealth : undefined,
                                      },
                                      () => {}
                                    );
                                  }}
                                >
                                  <Button
                                    size='mini'
                                    className='!w-28px !h-28px !min-w-28px !bg-[var(--color-bg-1)] text-t-secondary hover:text-t-primary hover:!bg-[var(--fill-0)]'
                                    icon={<DeleteFour theme='outline' size='18' strokeWidth={2} />}
                                  />
                                </Popconfirm>
                              </div>
                            </div>
                            {index < arr.length - 1 && <Divider className='!my-0 !border-[var(--color-border-2)]/70' />}
                          </div>
                        );
                      })}
                    </Collapse.Item>
                  </Collapse>
                );
              })}
            </div>
          )}
        </SettingsSection>
      </AionScrollArea>
    </div>
  );
};

export default ModelModalContent;
