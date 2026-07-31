/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EVE Inference picker — the ONLY model picker a Command EVE user sees. The user
 * picks a STUFE (level), never a raw model id.
 *
 * Founder mandate: "nothing confusing". The active product renders the two
 * verified groups below. Future connected-user providers can be supplied as
 * explicit routed groups, but raw CLI/agent discovery never enters this picker:
 *
 *   - Privat (lokal):   Standard (Gemma 4 E4B) · Hoch (Gemma 4 12B)
 *   - EVE Inference:    Standard · Hoch · Sehr hoch · Maximum · Ultra
 *
 * EVE LEVELS (Stufen) — both lanes share the entry word "Standard":
 *   - Standard is free-eligible; Hoch through Maximum are routine metered lanes.
 *   - Ultra is the experimental maximum-power lane and carries the only visible
 *     high-cost warning. Concrete cloud models remain server-owned.
 *
 * When the entitlement is trialing/free (entitlementCore CEVE.v2
 * `trial_ends_at` present), every offered paid rung from EVE Hoch upward is GREYED OUT with
 * a subtle "im Paid-Tarif" hint. Only EVE Standard + the two local tiers stay
 * selectable. The picker model + gating come from the pure `eveInferenceCore`.
 *
 * The selection is persisted to `commandEve.inferenceSelection`; the send path
 * resolves it (and injects the CEVE bearer for an EVE level) via the main-process
 * `command-eve.resolve-inference-provider` bridge — this component never holds
 * the raw license wire.
 */

import {
  filterEvePickerGroups,
  isEveInferenceSelection,
  resolveEvePickerItemAvailability,
  type EveLocalPickerRuntimeTruth,
  type EvePickerItem,
  type EvePickerItemAvailability,
  type EvePickerUnavailableReasonCode,
} from '@/common/config/eveInferenceCore';
import { useEveInferenceSelection } from '@renderer/hooks/agent/useEveInferenceSelection';
import { iconColors } from '@renderer/styles/colors';
import { Button, Dropdown, Input, Menu, Tooltip } from '@arco-design/web-react';
import { Brain, Check, Search } from '@icon-park/react';
import { bridge as platformBridge } from '@office-ai/platform';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type CommandEveLocalTierProbe = {
  id: string;
  installed?: boolean;
  ram_fit?: boolean;
  ready_for_use?: boolean;
  status_known?: boolean;
};

const localRuntimeStatusBridge = platformBridge.buildProvider<
  {
    success: boolean;
    data?: { model?: { tiers?: CommandEveLocalTierProbe[] } };
  },
  Record<string, never>
>('command-eve.local-runtime-status');

const readCloudOnline = (): boolean | undefined => {
  return typeof navigator === 'undefined' ? undefined : navigator.onLine !== false;
};

const EveInferencePicker: React.FC<{
  /** Called with the new selection value when the user picks an item. */
  onChange?: (selection: string) => void;
  /** Disable the whole control (e.g. while sending). */
  disabled?: boolean;
}> = ({ onChange, disabled }) => {
  const { t } = useTranslation();
  // All state/persistence/gating lives in the shared hook so the GuidPage
  // picker, the in-session header and the mobile sheets never drift apart.
  const { selection, groups, selectedItem, commit, cloudBearerAvailable } = useEveInferenceSelection(onChange);

  const [query, setQuery] = useState('');
  const [cloudOnline, setCloudOnline] = useState<boolean | undefined>(readCloudOnline);
  const [localTiers, setLocalTiers] = useState<Record<string, EveLocalPickerRuntimeTruth> | undefined>(undefined);

  const refreshLocalRuntime = useCallback(async (): Promise<void> => {
    try {
      const response = await localRuntimeStatusBridge.invoke({});
      const tiers = response.success ? response.data?.model?.tiers : undefined;
      if (!Array.isArray(tiers)) return;
      setLocalTiers(
        Object.fromEntries(
          tiers.map((tier) => [
            tier.id,
            {
              statusKnown: tier.status_known === true,
              ramFit: tier.ram_fit !== false,
              installed: tier.installed === true,
              readyForUse: tier.ready_for_use === true,
            },
          ])
        )
      );
    } catch {
      // Unknown is an honest state. A failed probe must not invent a blocker.
    }
  }, []);

  useEffect(() => {
    void refreshLocalRuntime();
    const handleFocus = (): void => void refreshLocalRuntime();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refreshLocalRuntime]);

  useEffect(() => {
    const refreshOnline = (): void => setCloudOnline(readCloudOnline());
    window.addEventListener('online', refreshOnline);
    window.addEventListener('offline', refreshOnline);
    return () => {
      window.removeEventListener('online', refreshOnline);
      window.removeEventListener('offline', refreshOnline);
    };
  }, []);

  const runtimeTruth = useMemo(
    () => ({ cloudOnline, cloudAuthenticated: cloudBearerAvailable, localTiers }),
    [cloudBearerAvailable, cloudOnline, localTiers]
  );
  const availabilityByValue = useMemo(
    () =>
      new Map(
        groups
          .flatMap((group) => group.items)
          .map((item) => [item.value, resolveEvePickerItemAvailability(item, runtimeTruth)] as const)
      ),
    [groups, runtimeTruth]
  );
  const filteredGroups = useMemo(() => filterEvePickerGroups(groups, query), [groups, query]);

  // An EVE (cloud) tier is selected but there is NO license wire at rest. The
  // send path fails loudly and keeps the draft, so the chip must not claim that
  // the cloud tier is ready. `=== false` only: transient reads keep the normal label.
  const selectedAvailability = selectedItem ? availabilityByValue.get(selectedItem.value) : undefined;
  const eveCloudNeedsActivation = selectedItem?.group === 'eve' && selectedAvailability?.reasonCode === 'AUTH_REQUIRED';
  const eveCloudIsOffline = selectedItem?.group === 'eve' && selectedAvailability?.reasonCode === 'OFFLINE';

  const availabilityLabel = useCallback(
    (availability: EvePickerItemAvailability): { short: string; detail: string } | undefined => {
      if (availability.state === 'checking') {
        const detail = t('conversation.eveInference.statusChecking', 'Status wird geprüft');
        return { short: t('conversation.eveInference.checking', 'Prüfung'), detail };
      }

      const labels: Record<EvePickerUnavailableReasonCode, { short: string; detail: string }> = {
        PAID_TIER_REQUIRED: {
          short: t('conversation.eveInference.paidPlan', 'Paid'),
          detail: t('conversation.eveInference.paidOnly', 'Nur im Paid-Tarif verfügbar'),
        },
        OFFLINE: {
          short: t('conversation.eveInference.offline', 'Offline'),
          detail: t('conversation.eveInference.offlineUnavailable', 'EVE Cloud benötigt eine Internetverbindung.'),
        },
        AUTH_REQUIRED: {
          short: t('conversation.eveInference.activation', 'Aktivierung'),
          detail: t('conversation.eveInference.needsActivation', 'Aktivierung nötig'),
        },
        HARDWARE_UNSUPPORTED: {
          short: t('conversation.eveInference.hardware', 'Hardware'),
          detail: t('conversation.eveInference.hardwareUnavailable', 'Hardware nicht geeignet'),
        },
        NOT_INSTALLED: {
          short: t('conversation.eveInference.notInstalled', 'Nicht installiert'),
          detail: t('conversation.eveInference.localNotInstalled', 'Lokales Modell ist nicht installiert'),
        },
        VERIFICATION_REQUIRED: {
          short: t('conversation.eveInference.verification', 'Verifizierung'),
          detail: t('conversation.eveInference.verificationRequired', 'Lokales Modell muss verifiziert werden'),
        },
        UNAVAILABLE: {
          short: t('conversation.eveInference.unavailable', 'Nicht verfügbar'),
          detail: t('conversation.eveInference.unavailable', 'Nicht verfügbar'),
        },
      };

      return availability.reasonCode ? labels[availability.reasonCode] : undefined;
    },
    [t]
  );

  const handleSelect = useCallback(
    (item: EvePickerItem) => {
      if (!availabilityByValue.get(item.value)?.selectable) return;
      commit(item.value);
    },
    [availabilityByValue, commit]
  );

  const displayLabel = useMemo(() => {
    if (selectedItem) {
      // If the cloud lane has no bearer at rest, say so instead of claiming the
      // selected tier is ready.
      if (eveCloudIsOffline) {
        return `EVE Cloud · ${t('conversation.eveInference.offline', 'Offline')}`;
      }
      if (eveCloudNeedsActivation) {
        return `EVE Cloud · ${t('conversation.eveInference.needsActivation', 'Aktivierung nötig')}`;
      }
      // The EVE cloud rows already carry their user-facing strength labels, so the
      // chip shows that label verbatim (no redundant "EVE Cloud · EVE Standard").
      // The local lane stays prefixed with "Lokal · <tier>" so the private lane is
      // never mistaken for cloud.
      if (selectedItem.group === 'eve') {
        return selectedItem.label;
      }
      if (selectedItem.group === 'connected') {
        return selectedItem.label;
      }
      const localLabel = `${t('common.localModel', 'Lokal')} · ${selectedItem.label}`;
      return selectedAvailability?.state === 'unavailable'
        ? `${localLabel} · ${t('conversation.eveInference.unavailable', 'Nicht verfügbar')}`
        : localLabel;
    }
    return t('conversation.eveInference.pick', 'Modell wählen');
  }, [selectedItem, selectedAvailability, eveCloudIsOffline, eveCloudNeedsActivation, t]);

  const renderLogo = () => <Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />;

  const droplist = (
    <div
      className='eve-inference-picker-menu flex flex-col overflow-hidden'
      style={{
        width: 340,
        maxWidth: 'calc(100vw - 32px)',
        height: 462,
        maxHeight: 'calc(100vh - 40px)',
      }}
    >
      <div className='p-8px shrink-0'>
        <Input
          allowClear
          value={query}
          onChange={setQuery}
          prefix={<Search theme='outline' size='14' fill={iconColors.secondary} />}
          placeholder={t('conversation.eveInference.search', 'Modelle durchsuchen')}
          aria-label={t('conversation.eveInference.search', 'Modelle durchsuchen')}
        />
      </div>
      <div
        className='eve-inference-picker-scroll flex-1 min-h-0 overflow-y-auto'
        style={{ overflowY: 'auto', scrollbarGutter: 'stable' }}
      >
        <Menu style={{ width: '100%' }}>
          {filteredGroups.map((group) => (
            <Menu.ItemGroup key={`${group.kind}:${group.title}`} title={group.title}>
              {group.items.map((item) => {
                const availability = availabilityByValue.get(item.value) ?? {
                  state: 'checking' as const,
                  selectable: true,
                };
                const statusLabel = availabilityLabel(availability);
                const isSelected = item.value === selection;
                const row = (
                  <Menu.Item
                    key={item.value}
                    disabled={!availability.selectable}
                    className={isSelected ? 'bg-2!' : ''}
                    data-testid={`eve-inference-option-${item.value}`}
                    data-selected={isSelected ? 'true' : 'false'}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => handleSelect(item)}
                  >
                    <div className='flex items-center justify-between gap-8px w-full min-w-0'>
                      <span className='flex items-center gap-6px min-w-0'>
                        <span className={!availability.selectable ? 'opacity-50 shrink-0' : 'shrink-0'}>
                          {item.label}
                        </span>
                        {item.sublabel ? (
                          <span className='text-12px opacity-50 truncate min-w-0'>({item.sublabel})</span>
                        ) : null}
                      </span>
                      <span className='flex items-center gap-6px shrink-0'>
                        {item.costBadge ? (
                          <span
                            className={
                              item.gated
                                ? 'text-11px font-600 px-6px py-1px rounded-full text-warning bg-warning-light-1 shrink-0'
                                : 'text-11px px-6px py-1px rounded-full opacity-70 bg-2 shrink-0'
                            }
                            title={
                              item.gated
                                ? t(
                                    'conversation.eveInference.highestCost',
                                    'Höchste Kosten — nur für die härteste Aufgabe'
                                  )
                                : t('conversation.eveInference.consumesCredits', 'Verbraucht Credits')
                            }
                          >
                            {item.costBadge}
                          </span>
                        ) : null}
                        {statusLabel ? (
                          <span className='text-11px opacity-60 shrink-0' title={statusLabel.detail}>
                            {statusLabel.short}
                          </span>
                        ) : null}
                        {isSelected ? (
                          <Check theme='outline' size='13' fill={iconColors.primary} aria-hidden='true' />
                        ) : null}
                      </span>
                    </div>
                  </Menu.Item>
                );
                return availability.state === 'unavailable' && statusLabel ? (
                  <Tooltip key={item.value} position='left' content={statusLabel.detail}>
                    {row}
                  </Tooltip>
                ) : (
                  row
                );
              })}
            </Menu.ItemGroup>
          ))}
        </Menu>
        {filteredGroups.length === 0 ? (
          <div className='px-12px py-24px text-center text-12px opacity-60'>
            {t('conversation.eveInference.noResults', 'Keine Modelle gefunden')}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <Dropdown trigger='click' droplist={droplist} disabled={disabled} position='br'>
      <Button
        className='sendbox-model-btn header-model-btn agent-mode-compact-pill'
        shape='round'
        size='small'
        disabled={disabled}
      >
        <span className='flex items-center gap-6px min-w-0 leading-none'>
          {renderLogo()}
          <span className='truncate'>{displayLabel}</span>
        </span>
      </Button>
    </Dropdown>
  );
};

export default EveInferencePicker;

// Re-export so callers can detect whether the active selection is the cloud
// lane (e.g. to show an egress notice) without re-importing the core.
export { isEveInferenceSelection };
