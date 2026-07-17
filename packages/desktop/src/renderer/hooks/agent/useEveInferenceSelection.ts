/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useEveInferenceSelection — the single source of truth for the Command EVE
 * inference tier selection across every surface that lets the user pick it:
 *
 *   - Pre-chat:  GuidPage (via {@link EveInferencePicker}).
 *   - In-chat:   the conversation header (desktop) and the mobile action sheet.
 *
 * It owns exactly the behaviour the founder mandate requires and nothing else:
 *   - read/persist the choice from/to `commandEve.inferenceSelection`
 *     (configService) so a switch made anywhere takes effect on the next turn
 *     (the send-path shim re-reads the live selection per request);
 *   - build the two-group picker model gated by live entitlement and credit
 *     truth (all metered levels remain available while bought credits exist);
 *   - expose the current display label + a `commit`, and reset a now-disabled
 *     paid tier only after funding truth is authoritative.
 *
 * Keeping this in ONE hook means the desktop component, the header injection and
 * both mobile sheets cannot drift apart.
 */

import { commandEve } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import {
  buildEvePickerGroups,
  EVE_DEFAULT_INFERENCE_SELECTION,
  EVE_INFERENCE_DEFAULT_TIER_ID,
  eveTierValue,
  isEveInferenceSelection,
  type EvePickerGroup,
  type EvePickerItem,
} from '@/common/config/eveInferenceCore';
import { useEntitlementGate } from '@renderer/hooks/useEntitlementGate';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';
import { isElectronDesktop } from '@renderer/utils/platform';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface UseEveInferenceSelectionResult {
  /** Persisted selection; unknown local/connected values stay verbatim until their source loads. */
  selection: string;
  /** Two-group picker model, gated by the current entitlement. */
  groups: EvePickerGroup[];
  /** Flattened items across both groups (label lookup / sheet rows). */
  items: EvePickerItem[];
  /** The currently-selected, still-selectable item (undefined if none). */
  selectedItem: EvePickerItem | undefined;
  /** Persist a new selection. No-op for an unknown/disabled value. */
  commit: (value: string) => void;
  /** True iff `value` is a known, selectable item. */
  isSelectable: (value: string) => boolean;
  /**
   * Whether the EVE Inference (cloud) lane has a usable license bearer at rest.
   * `true` = activated, cloud routes; `false` = no usable cloud bearer, so the
   * surface must read "Aktivierung nötig" rather than lie "EVE Cloud";
   * `undefined` = unknown
   * (loading / non-desktop / transient read error) → do NOT degrade the label.
   */
  cloudBearerAvailable: boolean | undefined;
  /** Re-read the bearer presence (call after a re-activation). */
  refreshBearer: () => Promise<void>;
}

/**
 * @param onChange Optional callback fired after a successful commit (e.g. to
 *   surface an egress notice). The persistence to configService happens first.
 */
export function useEveInferenceSelection(onChange?: (selection: string) => void): UseEveInferenceSelectionResult {
  const { loading: entitlementLoading, status } = useEntitlementGate();
  const { loading: creditsLoading, status: creditsStatus } = useCreditsStatus();

  const pickerEntitlement = useMemo(() => {
    const creditsAreAuthoritative = creditsStatus?.ok === true;
    const purchasedCredits = Number(creditsStatus?.purchased_credits_remaining ?? 0);
    const includedCredits = Number(creditsStatus?.included_allowance_credits_remaining ?? 0);
    const hasMeteredCredits =
      creditsAreAuthoritative &&
      (creditsStatus?.has_active_topup === true ||
        creditsStatus?.tier !== 'free' ||
        purchasedCredits > 0 ||
        includedCredits > 0);

    return {
      ...status,
      has_active_topup: creditsStatus?.has_active_topup === true,
      has_metered_credits: hasMeteredCredits,
      metered_credit_access_known: creditsAreAuthoritative,
    };
  }, [creditsStatus, status]);

  const [selection, setSelection] = useState<string>(() => {
    // Default to EVE Standard (cloud) for a fresh user; local Gemma is opt-in.
    return configService.get('commandEve.inferenceSelection') || EVE_DEFAULT_INFERENCE_SELECTION;
  });

  // Keep local state in sync with config changes from any other surface
  // (header ↔ sheet ↔ GuidPicker all read the same key).
  useEffect(() => {
    const unsubscribe = configService.subscribe('commandEve.inferenceSelection', (value) => {
      if (typeof value === 'string' && value.length > 0) setSelection(value);
    });
    return unsubscribe;
  }, []);

  // Bearer presence for the EVE (cloud) lane. The header chip + picker must tell
  // the truth: without a license wire, showing "EVE Cloud · Hoch" would lie.
  // `undefined` stays the safe default (don't degrade on a transient/unknown read).
  const [cloudBearerAvailable, setCloudBearerAvailable] = useState<boolean | undefined>(undefined);
  const refreshBearer = useCallback(async () => {
    if (!isElectronDesktop()) {
      setCloudBearerAvailable(undefined);
      return;
    }
    try {
      const response = await commandEve.licenseWireStatus.invoke();
      setCloudBearerAvailable(response?.data?.available === true);
    } catch {
      // Unknown on a transient bridge error — leave the label untouched.
      setCloudBearerAvailable(undefined);
    }
  }, []);
  useEffect(() => {
    void refreshBearer();
  }, [refreshBearer]);
  // Reflect a re-activation done in Settings → Account without a reload: re-read
  // on window focus (cheap presence-only call).
  useEffect(() => {
    if (!isElectronDesktop()) return;
    const onFocus = (): void => void refreshBearer();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshBearer]);

  const groups = useMemo(() => buildEvePickerGroups(pickerEntitlement), [pickerEntitlement]);
  const items = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // A destructive fallback is only justified once both independent funding
  // sources have finished with authoritative truth. In particular, a stale
  // trial marker can arrive before purchased-credit status during startup.
  const paidTierAccessKnown =
    !entitlementLoading &&
    status?.ok === true &&
    status.state === 'entitled' &&
    !creditsLoading &&
    creditsStatus?.ok === true;

  const selectedRaw = useMemo(() => items.find((i) => i.value === selection), [items, selection]);
  const selectedItem = selectedRaw && !selectedRaw.disabled ? selectedRaw : undefined;

  const isSelectable = useCallback(
    (value: string) => {
      const item = items.find((i) => i.value === value);
      return Boolean(item && !item.disabled);
    },
    [items]
  );

  const commit = useCallback(
    (value: string) => {
      const item = items.find((i) => i.value === value);
      // Ignore unknown values and greyed (paid-only while trialing) rows.
      if (!item || item.disabled) return;
      setSelection(value);
      configService.set('commandEve.inferenceSelection', value);
      onChange?.(value);
    },
    [items, onChange]
  );

  // Reset to the safe default (EVE Standard) once when the active selection is no
  // longer usable, so no surface shows a stranded value as "active":
  //  - a metered EVE tier after both entitlement and credit truth confirm that it
  //    is no longer funded, OR
  //  - a now-UNKNOWN EVE selection (e.g. the retired `eve-maximum` id) that
  //    resolves to no picker item.
  // Unknown local/connected values remain untouched because their provider model
  // may not have loaded yet; an absent picker row is not proof they were retired.
  useEffect(() => {
    const fallback = eveTierValue(EVE_INFERENCE_DEFAULT_TIER_ID);
    const isUnknownEve = isEveInferenceSelection(selection) && !items.some((item) => item.value === selection);
    const isConfirmedUnfundedTier = selectedRaw?.group === 'eve' && selectedRaw.disabled && paidTierAccessKnown;
    if ((isConfirmedUnfundedTier || isUnknownEve) && selection !== fallback) {
      setSelection(fallback);
      configService.set('commandEve.inferenceSelection', fallback);
    }
  }, [selectedRaw, items, paidTierAccessKnown, selection]);

  return { selection, groups, items, selectedItem, commit, isSelectable, cloudBearerAvailable, refreshBearer };
}

export default useEveInferenceSelection;
