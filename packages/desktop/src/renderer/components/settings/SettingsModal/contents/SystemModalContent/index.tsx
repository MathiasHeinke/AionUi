/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IGpuStatus, IStartOnBootStatus } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import FeedbackButton from '@/renderer/components/base/FeedbackButton';
import LanguageSwitcher from '@/renderer/components/settings/LanguageSwitcher';
import { useIsDevMode } from '@/renderer/hooks/useIsDevMode';
import { notifyManualRestartRequired } from '@/renderer/utils/appRestart';
import { isElectronDesktop } from '@/renderer/utils/platform';
import SettingsSection, { SettingsPageHeader } from '@/renderer/components/settings/SettingsSection';
import { Form, InputNumber, Message, Modal, Switch } from '@arco-design/web-react';
import { Caution } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { useSettingsViewMode } from '../../settingsViewContext';
import DevSettings from './DevSettings';
import DirInputItem from './DirInputItem';
import PreferenceRow from './PreferenceRow';
import AgentVideoGenerateToggle, { isAgentVideoGenerateSettingVisible } from './AgentVideoGenerateToggle';
import { useEntitlementGate } from '@/renderer/hooks/useEntitlementGate';

/**
 * System settings content component
 *
 * Provides system-level configuration options including language, directory config,
 * and developer tools (dev mode only).
 */
const SystemModalContent: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();
  const isDevMode = useIsDevMode();
  const [form] = Form.useForm();
  const [modal, modalContextHolder] = Modal.useModal();
  const [error, setError] = useState<string | null>(null);
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const initializingRef = useRef(true);

  const [startOnBoot, setStartOnBoot] = useState<IStartOnBootStatus>({
    supported: false,
    enabled: false,
    isPackaged: false,
    platform: 'web',
  });
  const [closeToTray, setCloseToTray] = useState(false);
  const [gpuStatus, setGpuStatus] = useState<IGpuStatus | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const [cronNotificationEnabled, setCronNotificationEnabled] = useState(false);
  const [promptTimeout, setPromptTimeout] = useState<number>(300);
  const [agentIdleTimeout, setAgentIdleTimeout] = useState<number>(5);
  const [saveUploadToWorkspace, setSaveUploadToWorkspace] = useState(false);
  const [autoPreviewOfficeFiles, setAutoPreviewOfficeFiles] = useState(true);
  const [runtimeStatusVisible, setRuntimeStatusVisible] = useState(true);
  const [egressStatusVisible, setEgressStatusVisible] = useState(true);
  // S11 — PER-SEAT PII/DSGVO egress redaction switch. Read REACTIVELY via useConfig
  // (mirrors the useDayZeroOnboarding fix for the sibling seat-scoped key
  // commandEve.clientSeedDismissed): the per-key re-notify that rebindSeat fires on
  // a seat switch — and every configService.set — reaches this control, instead of
  // a one-shot mount-once configService.get that survived a switch/boot and showed
  // the prior seat's (or the pre-init fail-safe) state. THIS was the live bug where
  // the toggle "couldn't be turned off": the mount-once useState never reflected
  // the written value. `true` = filter ON (redact), the fail-safe default
  // (absent / anything but the exact string 'off' ⇒ on).
  const [egressRedactionMode] = useConfig('commandEve.egressRedactionMode');
  const egressRedactionOn = egressRedactionMode !== 'off';
  // COMPA-626 — EVE's kanban clearance. OFF (default) ⇒ EVE's card proposals need a
  // confirm-card click; ON ⇒ EVE applies its kanban card changes directly (no click).
  const [kanbanAutoApprove] = useConfig('commandEve.kanbanAutoApprove');
  // CEVE-18205 — the agent video-generate release is offered only to an ENTITLED
  // seat. `status` is null while the first read is in flight, which
  // `isAgentVideoGenerateSettingVisible` treats as not-entitled: the row appears
  // once entitlement is proven, never optimistically.
  const { status: entitlementStatus } = useEntitlementGate();
  const agentVideoGenerateVisible = isAgentVideoGenerateSettingVisible(entitlementStatus?.state);
  const kanbanAutoApproveOn = kanbanAutoApprove === true;
  const [modelWarmupEnabled, setModelWarmupEnabled] = useState(true);

  // BOOT READINESS (same guarantee as useDayZeroOnboarding): useConfig's first
  // snapshot is a synchronous configService.get that can run BEFORE the config
  // cache has finished loading, and initialize() does NOT notify per key. Force one
  // re-read after whenReady() resolves so useSyncExternalStore re-pulls a persisted
  // 'off' from a prior launch. No-op once ready; the seat-rebind re-notify covers
  // every subsequent switch.
  const [, setEgressReadyTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void configService.whenReady().then(() => {
      if (!cancelled) setEgressReadyTick((tick) => tick + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    ipcBridge.application.getStartOnBootStatus
      .invoke()
      .then((result) => {
        if (result.success && result.data) {
          setStartOnBoot(result.data);
        }
      })
      .catch(() => {});

    ipcBridge.application.getGpuStatus
      .invoke()
      .then((result) => {
        if (result.success && result.data) {
          setGpuStatus(result.data);
        }
      })
      .catch(() => {});
  }, [isDesktop]);

  useEffect(() => {
    setCloseToTray(configService.get('system.closeToTray') ?? false);
    if (isDesktop) {
      ipcBridge.systemSettings.getCloseToTray
        .invoke()
        .then((enabled) => {
          setCloseToTray(enabled);
          configService.setLocal('system.closeToTray', enabled);
        })
        .catch(() => {});
    }
    setNotificationEnabled(configService.get('system.notificationEnabled') ?? true);
    setCronNotificationEnabled(configService.get('system.cronNotificationEnabled') ?? false);
    setSaveUploadToWorkspace(configService.get('upload.saveToWorkspace') ?? false);
    setAutoPreviewOfficeFiles(configService.get('system.autoPreviewOfficeFiles') ?? true);
    setRuntimeStatusVisible(configService.get('commandEve.runtimeStatusVisible') ?? true);
    setEgressStatusVisible(configService.get('commandEve.egressStatusVisible') ?? true);
    // egressRedactionMode (S11) is read reactively via useConfig above — no
    // mount-once seed here (that one-shot get was the bug: it never re-read on a
    // seat switch or after a late backend load, so the toggle looked stuck).
    setModelWarmupEnabled(configService.get('commandEve.modelWarmupEnabled') ?? true);
    const pt = configService.get('acp.promptTimeout');
    if (pt && pt > 0) setPromptTimeout(pt);
    const ait = configService.get('acp.agentIdleTimeout');
    if (ait && ait > 0) setAgentIdleTimeout(ait);
  }, [isDesktop]);

  const handleCloseToTrayChange = useCallback(
    (checked: boolean) => {
      const previous = closeToTray;
      setCloseToTray(checked);
      configService.setLocal('system.closeToTray', checked);

      if (!isDesktop) {
        configService.set('system.closeToTray', checked).catch(() => {
          setCloseToTray(previous);
          configService.setLocal('system.closeToTray', previous);
        });
        return;
      }

      ipcBridge.systemSettings.setCloseToTray.invoke({ enabled: checked }).catch(() => {
        setCloseToTray(previous);
        configService.setLocal('system.closeToTray', previous);
      });
    },
    [closeToTray, isDesktop]
  );

  const handleHardwareAccelerationChange = useCallback(
    (checked: boolean) => {
      const previous = gpuStatus;
      const optimistic: IGpuStatus = {
        userOverride: checked ? 'force-on' : 'force-off',
        autoDisabled: false,
        crashCount: 0,
        lastCrashAt: gpuStatus?.lastCrashAt ?? null,
      };
      setGpuStatus(optimistic);

      const apply = () => {
        ipcBridge.application.setGpuOverride
          .invoke({ override: checked ? 'force-on' : 'force-off' })
          .then((result) => {
            if (result.success && result.data) {
              setGpuStatus(result.data);
              ipcBridge.application.restart
                .invoke()
                .then((restartResult) => notifyManualRestartRequired(restartResult, t))
                .catch(() => {});
            } else {
              setGpuStatus(previous);
              Message.error(t('settings.hardwareAccelerationUpdateFailed'));
            }
          })
          .catch(() => {
            setGpuStatus(previous);
            Message.error(t('settings.hardwareAccelerationUpdateFailed'));
          });
      };

      modal.confirm({
        title: t('settings.updateConfirm'),
        content: t('settings.hardwareAccelerationRestartConfirm'),
        onOk: apply,
        onCancel: () => setGpuStatus(previous),
      });
    },
    [gpuStatus, modal, t]
  );

  const handleStartOnBootChange = useCallback(
    (checked: boolean) => {
      const previousStatus = startOnBoot;
      setStartOnBoot((prev) => ({ ...prev, enabled: checked }));

      ipcBridge.application.setStartOnBoot
        .invoke({ enabled: checked })
        .then((result) => {
          if (result.success && result.data) {
            setStartOnBoot(result.data);
            return;
          }

          setStartOnBoot(previousStatus);
          Message.error(result.msg || t('settings.startOnBootUpdateFailed'));
        })
        .catch(() => {
          setStartOnBoot(previousStatus);
          Message.error(t('settings.startOnBootUpdateFailed'));
        });
    },
    [startOnBoot, t]
  );

  const handleNotificationEnabledChange = useCallback((checked: boolean) => {
    setNotificationEnabled(checked);
    configService.set('system.notificationEnabled', checked).catch(() => {
      setNotificationEnabled(!checked);
      configService.setLocal('system.notificationEnabled', !checked);
    });
  }, []);

  const handleCronNotificationEnabledChange = useCallback((checked: boolean) => {
    setCronNotificationEnabled(checked);
    configService.set('system.cronNotificationEnabled', checked).catch(() => {
      setCronNotificationEnabled(!checked);
      configService.setLocal('system.cronNotificationEnabled', !checked);
    });
  }, []);

  const handlePromptTimeoutChange = useCallback((val: number | undefined) => {
    setPromptTimeout(val as number);
  }, []);

  const handlePromptTimeoutBlur = useCallback(() => {
    const clamped = Math.max(30, Math.min(3600, promptTimeout || 300));
    setPromptTimeout(clamped);
    configService.set('acp.promptTimeout', clamped).catch(() => {});
  }, [promptTimeout]);

  const handleAgentIdleTimeoutChange = useCallback((val: number | undefined) => {
    setAgentIdleTimeout(val as number);
  }, []);

  const handleAgentIdleTimeoutBlur = useCallback(() => {
    const clamped = Math.max(1, Math.min(60, agentIdleTimeout || 5));
    setAgentIdleTimeout(clamped);
    configService.set('acp.agentIdleTimeout', clamped).catch(() => {});
  }, [agentIdleTimeout]);

  const handleSaveUploadToWorkspaceChange = useCallback((checked: boolean) => {
    setSaveUploadToWorkspace(checked);
    configService.set('upload.saveToWorkspace', checked).catch(() => {
      setSaveUploadToWorkspace(!checked);
      configService.setLocal('upload.saveToWorkspace', !checked);
    });
  }, []);

  const handleAutoPreviewOfficeFilesChange = useCallback((checked: boolean) => {
    setAutoPreviewOfficeFiles(checked);
    configService.set('system.autoPreviewOfficeFiles', checked).catch(() => {
      setAutoPreviewOfficeFiles(!checked);
      configService.setLocal('system.autoPreviewOfficeFiles', !checked);
    });
  }, []);

  const handleRuntimeStatusVisibleChange = useCallback((checked: boolean) => {
    setRuntimeStatusVisible(checked);
    configService.set('commandEve.runtimeStatusVisible', checked).catch(() => {
      setRuntimeStatusVisible(!checked);
      configService.setLocal('commandEve.runtimeStatusVisible', !checked);
    });
  }, []);

  const handleEgressStatusVisibleChange = useCallback((checked: boolean) => {
    setEgressStatusVisible(checked);
    configService.set('commandEve.egressStatusVisible', checked).catch(() => {
      setEgressStatusVisible(!checked);
      configService.setLocal('commandEve.egressStatusVisible', !checked);
    });
  }, []);

  // S11 — PER-SEAT PII/DSGVO egress redaction switch. Turning it OFF is a DSGVO
  // control-waiver, so it is gated behind an explicit confirm with the warning
  // (spec §5). Turning it back ON is immediate (the safe direction). The persisted
  // value is the string mode 'on'|'off' (seat-scoped); the fail-safe main-process
  // resolver treats absent/error as 'on'.
  const applyEgressRedactionMode = useCallback(
    (on: boolean) => {
      const mode = on ? 'on' : 'off';
      const previousMode = on ? 'off' : 'on';
      // configService.set optimistically updates the cache + notifies, so the
      // useConfig-derived toggle flips immediately. If the backend PUT rejects,
      // roll the cache back to the prior value AND surface it LOUDLY — a DSGVO
      // control that silently fails to persist is worse than the bug (founder
      // self-detection standard): never a mystery bounce, never a false "off".
      const issuedForSeat = configService.getCurrentSeatId();
      configService.set('commandEve.egressRedactionMode', mode).catch((persistError) => {
        // Rollback ONLY if we are still on the seat the write was issued for — a
        // rebind mid-flight re-homed the cache, and seat A's rollback must not
        // land in seat B's namespace (the new seat's own value is authoritative).
        if (configService.getCurrentSeatId() === issuedForSeat) {
          configService.setLocal('commandEve.egressRedactionMode', previousMode);
        }
        console.error('[SystemSettings] Failed to persist PII egress redaction mode:', persistError);
        Message.error(
          t('settings.commandEvePiiProtectionSaveFailed', {
            defaultValue:
              'PII-Schutz konnte nicht gespeichert werden — Änderung nicht übernommen. Bitte erneut versuchen.',
          })
        );
      });
    },
    [t]
  );

  const handleEgressRedactionChange = useCallback(
    (checked: boolean) => {
      if (checked) {
        // Re-enabling the filter is the SAFE direction — no confirm needed.
        applyEgressRedactionMode(true);
        return;
      }
      // Disabling it is a conscious DSGVO control-waiver — confirm with the warning.
      modal.confirm({
        title: t('settings.commandEvePiiProtectionConfirmTitle', {
          defaultValue: 'PII-Schutz für diesen Seat ausschalten?',
        }),
        content: t('settings.commandEvePiiProtectionConfirmBody', {
          defaultValue:
            'Aus: Inhalte gehen UNGESCHWÄRZT an das Cloud-Modell (gilt nur für diesen Seat). Persönliche Daten (Telefon, IBAN, Adressen, Gesundheits-/Finanzdaten) werden dann NICHT mehr automatisch entfernt, bevor sie deinen Mac verlassen.',
        }),
        okText: t('settings.commandEvePiiProtectionConfirmOk', { defaultValue: 'Trotzdem ausschalten' }),
        cancelText: t('common.cancel', { defaultValue: 'Abbrechen' }),
        onOk: () => applyEgressRedactionMode(false),
      });
    },
    [applyEgressRedactionMode, modal, t]
  );

  const handleModelWarmupEnabledChange = useCallback((checked: boolean) => {
    setModelWarmupEnabled(checked);
    configService.set('commandEve.modelWarmupEnabled', checked).catch(() => {
      setModelWarmupEnabled(!checked);
      configService.setLocal('commandEve.modelWarmupEnabled', !checked);
    });
  }, []);

  // COMPA-626 — grant/revoke EVE's direct kanban clearance. useConfig reflects the value
  // optimistically; on a backend reject, roll the cache back so the toggle never lies.
  const handleKanbanAutoApproveChange = useCallback(
    (checked: boolean) => {
      const prior = !checked;
      configService.set('commandEve.kanbanAutoApprove', checked).catch(() => {
        configService.setLocal('commandEve.kanbanAutoApprove', prior);
        Message.error(
          t('settings.commandEveKanbanAutoApproveError', {
            defaultValue: 'Konnte die Kanban-Freigabe nicht speichern.',
          })
        );
      });
    },
    [t]
  );

  // Get system directory info
  const { data: systemInfo } = useSWR('system.dir.info', () => ipcBridge.application.systemInfo.invoke());

  // Initialize form data
  useEffect(() => {
    if (systemInfo) {
      initializingRef.current = true;
      form.setFieldsValue({ workDir: systemInfo.workDir, logDir: systemInfo.logDir });
      requestAnimationFrame(() => {
        initializingRef.current = false;
      });
    }
  }, [systemInfo, form]);

  const preferenceItems = [
    { key: 'language', label: t('settings.language'), component: <LanguageSwitcher /> },
    {
      key: 'startOnBoot',
      label: t('settings.startOnBoot'),
      description: startOnBoot.supported ? t('settings.startOnBootDesc') : t('settings.startOnBootUnsupported'),
      component: (
        <Switch checked={startOnBoot.enabled} onChange={handleStartOnBootChange} disabled={!startOnBoot.supported} />
      ),
    },
    {
      key: 'closeToTray',
      label: t('settings.closeToTray'),
      component: <Switch checked={closeToTray} onChange={handleCloseToTrayChange} />,
    },
    // Runtime log strip toggle — DEV BUILDS ONLY. The strip itself is dev-gated, so
    // the toggle is meaningless to operators (who never see the strip in production).
    // The egress notice below stays for ALL users (DSGVO signal).
    ...(isDevMode
      ? [
          {
            key: 'commandEveRuntimeStatus',
            label: t('settings.commandEveRuntimeStatus'),
            description: t('settings.commandEveRuntimeStatusDesc'),
            component: <Switch checked={runtimeStatusVisible} onChange={handleRuntimeStatusVisibleChange} />,
          },
        ]
      : []),
    {
      // S11 — PER-SEAT PII/DSGVO egress redaction switch. Mounted right next to the
      // egress status signal (the same Privacy area). Default ON (fail-safe redact).
      key: 'commandEvePiiProtection',
      label: t('settings.commandEvePiiProtection', { defaultValue: 'PII-Schutz (DSGVO-Egress-Filter)' }),
      description: t('settings.commandEvePiiProtectionDesc', {
        defaultValue:
          'An: Persönliche Daten (Telefon, IBAN, Adressen, Gesundheits-/Finanzdaten) werden vor dem Senden an Cloud-Modelle automatisch geschwärzt. Lokale Modelle sind nicht betroffen — dort verlassen Daten deinen Mac nie. Gilt nur für diesen Seat.',
      }),
      component: <Switch checked={egressRedactionOn} onChange={handleEgressRedactionChange} />,
    },
    {
      key: 'commandEveEgressStatus',
      label: t('settings.commandEveEgressStatus'),
      description: t('settings.commandEveEgressStatusDesc'),
      component: <Switch checked={egressStatusVisible} onChange={handleEgressStatusVisibleChange} />,
    },
    {
      key: 'commandEveModelWarmup',
      label: t('settings.commandEveModelWarmup'),
      description: t('settings.commandEveModelWarmupDesc'),
      component: <Switch checked={modelWarmupEnabled} onChange={handleModelWarmupEnabledChange} />,
    },
    {
      // COMPA-626 — EVE's kanban clearance. OFF (default) = EVE proposes, you confirm each
      // card change with a click; ON = EVE applies its kanban card changes directly.
      key: 'commandEveKanbanAutoApprove',
      label: t('settings.commandEveKanbanAutoApprove', { defaultValue: 'EVE darf Kanban-Karten direkt bearbeiten' }),
      description: t('settings.commandEveKanbanAutoApproveDesc', {
        defaultValue:
          'Aus (Standard): EVE schlägt Karten-Änderungen vor, du bestätigst jede mit einem Klick. An: EVE legt Karten an, verschiebt und bearbeitet sie direkt — ohne Bestätigung. Jede Änderung wird protokolliert. Löschen/Dispatch bleibt immer gesperrt.',
      }),
      component: <Switch checked={kanbanAutoApproveOn} onChange={handleKanbanAutoApproveChange} />,
    },
    // CEVE-18205 — EVE's own video-generation release. Sits beside the kanban
    // clearance because it answers the same shape of question ("what may EVE do
    // without asking?"), and it is the most expensive answer in the list: this one
    // spends credits per call.
    //
    // OFFERED ONLY TO AN ENTITLED SEAT. A seat the main-process gate would refuse
    // must not be shown the control at all — an offer the product will not honour
    // reads as a broken app, and the loading window before the first entitlement
    // read resolves is treated as not-entitled (fail-closed).
    ...(agentVideoGenerateVisible
      ? [
          {
            key: 'commandEveAgentVideoGenerate',
            label: t('settings.commandEveAgentVideoGenerate', {
              defaultValue: 'Eve darf selbst Videos generieren',
            }),
            description: t('settings.commandEveAgentVideoGenerateDesc', {
              defaultValue:
                'Aus (Standard): Videos entstehen nur, wenn du sie selbst über die Video-Auswahl startest — dort siehst du vorher Qualität, Länge und Kosten. An: EVE darf im Gespräch selbst ein kurzes Video erzeugen, wenn du im selben Zug eines verlangst. Jeder Lauf kostet Credits. Länge und Qualität legt die App fest, nicht das Modell. Gilt nur für diesen Seat.',
            }),
            component: <AgentVideoGenerateToggle />,
          },
        ]
      : []),
    ...(isDesktop && gpuStatus
      ? [
          {
            key: 'hardwareAcceleration',
            label: t('settings.hardwareAcceleration'),
            description: gpuStatus.autoDisabled
              ? t('settings.hardwareAccelerationAutoDisabled')
              : t('settings.hardwareAccelerationDesc'),
            component: (
              <Switch
                checked={gpuStatus.userOverride !== 'force-off' && !gpuStatus.autoDisabled}
                onChange={handleHardwareAccelerationChange}
              />
            ),
          },
        ]
      : []),
    {
      key: 'promptTimeout',
      label: t('settings.promptTimeout'),
      component: (
        <InputNumber
          value={promptTimeout}
          onChange={handlePromptTimeoutChange}
          onBlur={handlePromptTimeoutBlur}
          max={3600}
          step={30}
          style={{ width: 120 }}
          suffix='s'
        />
      ),
    },
    {
      key: 'agentIdleTimeout',
      label: t('settings.agentIdleTimeout'),
      description: t('settings.agentIdleTimeoutDesc'),
      component: (
        <InputNumber
          value={agentIdleTimeout}
          onChange={handleAgentIdleTimeoutChange}
          onBlur={handleAgentIdleTimeoutBlur}
          max={60}
          step={5}
          style={{ width: 120 }}
          suffix='min'
        />
      ),
    },
    {
      key: 'saveUploadToWorkspace',
      label: t('settings.saveUploadToWorkspace'),
      component: <Switch checked={saveUploadToWorkspace} onChange={handleSaveUploadToWorkspaceChange} />,
    },
    {
      key: 'autoPreviewOfficeFiles',
      label: t('settings.autoPreviewOfficeFiles'),
      description: t('settings.autoPreviewOfficeFilesDesc'),
      component: <Switch checked={autoPreviewOfficeFiles} onChange={handleAutoPreviewOfficeFilesChange} />,
    },
  ];

  const preferenceGroups = {
    application: ['language', 'startOnBoot', 'closeToTray'],
    // CEVE-18205 — the video-generate release joins the CONTROL group: it answers
    // "what may EVE do without asking?", the same question as the kanban clearance
    // beside it. When the seat is not entitled the item is absent from
    // `preferenceItems` entirely, so naming it here renders nothing.
    control: [
      'commandEvePiiProtection',
      'commandEveEgressStatus',
      'commandEveKanbanAutoApprove',
      'commandEveAgentVideoGenerate',
    ],
    performance: [
      'commandEveRuntimeStatus',
      'commandEveModelWarmup',
      'hardwareAcceleration',
      'promptTimeout',
      'agentIdleTimeout',
    ],
    files: ['saveUploadToWorkspace', 'autoPreviewOfficeFiles'],
  };

  const renderPreferenceItems = (keys: string[]) =>
    preferenceItems
      .filter((item) => keys.includes(item.key))
      .map((item) => (
        <PreferenceRow
          key={item.key}
          label={item.label}
          description={item.description}
          testId={`system-preference-${item.key}`}
        >
          {item.component}
        </PreferenceRow>
      ));

  const saveDirConfigValidate = (_values: { workDir: string; logDir: string }): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      modal.confirm({
        title: t('settings.updateConfirm'),
        content: t('settings.restartConfirm'),
        onOk: resolve,
        onCancel: reject,
      });
    });
  };

  const savingRef = useRef(false);

  const handleValuesChange = useCallback(
    async (_changedValue: unknown, allValues: Record<string, string>) => {
      if (initializingRef.current || savingRef.current || !systemInfo) return;
      const { workDir, logDir } = allValues;
      const needsRestart = workDir !== systemInfo.workDir || logDir !== systemInfo.logDir;
      if (!needsRestart) return;

      savingRef.current = true;
      setError(null);
      try {
        await saveDirConfigValidate({ workDir, logDir });
        // Pass systemInfo.cacheDir as-is: cacheDir is no longer user-editable
        // (removed from UI), but the backend IPC interface still expects it.
        // Passing the current value ensures existing custom paths are preserved.
        await ipcBridge.application.updateSystemInfo.invoke({ cacheDir: systemInfo.cacheDir, workDir, logDir });
        const restartResult = await ipcBridge.application.restart.invoke();
        notifyManualRestartRequired(restartResult, t);
      } catch (caughtError: unknown) {
        form.setFieldsValue({ workDir: systemInfo.workDir, logDir: systemInfo.logDir });
        if (caughtError) {
          setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
        }
      } finally {
        savingRef.current = false;
      }
    },
    [systemInfo, form, saveDirConfigValidate, t]
  );

  return (
    <div className='eve-system-settings flex flex-col h-full w-full'>
      {modalContextHolder}

      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <SettingsPageHeader title={t('settings.system')} description={t('settings.systemPageDescription')} />

        <SettingsSection
          title={t('settings.systemApplicationSection')}
          description={t('settings.systemApplicationSectionDescription')}
          bodyClassName='eve-settings-list'
        >
          {renderPreferenceItems(preferenceGroups.application)}
        </SettingsSection>

        <SettingsSection
          title={t('settings.systemControlSection')}
          description={t('settings.systemControlSectionDescription')}
          bodyClassName='eve-settings-list'
        >
          {renderPreferenceItems(preferenceGroups.control)}
        </SettingsSection>

        <SettingsSection
          title={t('settings.systemPerformanceSection')}
          description={t('settings.systemPerformanceSectionDescription')}
          bodyClassName='eve-settings-list'
        >
          {renderPreferenceItems(preferenceGroups.performance)}
        </SettingsSection>

        <SettingsSection
          title={t('settings.systemNotificationsSection')}
          description={t('settings.systemNotificationsSectionDescription')}
          bodyClassName='eve-settings-list'
        >
          <PreferenceRow label={t('settings.notification')}>
            <Switch checked={notificationEnabled} onChange={handleNotificationEnabledChange} />
          </PreferenceRow>
          {notificationEnabled && (
            <div className='eve-settings-sublist'>
              <PreferenceRow label={t('settings.cronNotificationEnabled')}>
                <Switch checked={cronNotificationEnabled} onChange={handleCronNotificationEnabledChange} />
              </PreferenceRow>
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          title={t('settings.systemFilesSection')}
          description={t('settings.systemFilesSectionDescription')}
          bodyClassName='eve-settings-list'
        >
          {renderPreferenceItems(preferenceGroups.files)}
        </SettingsSection>

        <SettingsSection
          title={t('settings.systemStorageSection')}
          description={t('settings.systemStorageSectionDescription')}
        >
          <Form form={form} layout='vertical' className='eve-settings-form' onValuesChange={handleValuesChange}>
            <DirInputItem label={t('settings.workDir')} field='workDir' />
            <DirInputItem label={t('settings.logDir')} field='logDir' />
            {error && (
              <div className='eve-settings-inline-notice eve-settings-inline-notice--error' role='alert'>
                <Caution theme='outline' size='16' />
                <span>
                  {typeof error === 'string' ? error : JSON.stringify(error)}
                  <FeedbackButton module='system-settings' className='ml-6px' />
                </span>
              </div>
            )}
          </Form>
        </SettingsSection>

        {/* Developer settings: DevTools + CDP (only visible in dev mode) */}
        <DevSettings />
      </AionScrollArea>
    </div>
  );
};

export default SystemModalContent;
