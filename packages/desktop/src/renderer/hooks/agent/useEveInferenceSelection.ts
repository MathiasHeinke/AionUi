/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useEveInferenceSelection — the single source of truth for the Command EVE
 * inference lane selection across every surface that can change it:
 *
 *   - The composer's MAX toggle (the ONLY cloud-intelligence affordance there;
 *     off = EVE's normal unnamed behaviour, on = the MAX state).
 *   - The mobile action sheet's LANE entry (EVE Cloud vs the private local lane
 *     — no tier nomenclature).
 *   - Settings → Modell, where the private local lane is chosen deliberately.
 *
 * There is deliberately NO cloud intelligence ladder anywhere in the UI any
 * more (MAT-1749, Founder contract). The registry still carries every wire tier
 * because the managed-visual / media turn contract consumes them, but the user
 * never sees a cloud tier name.
 *
 * It owns exactly the behaviour the founder mandate requires and nothing else:
 *   - read/persist the choice from/to `commandEve.inferenceSelection`
 *     (configService) so a switch made anywhere takes effect on the next turn
 *     (the send-path shim re-reads the live selection per request);
 *   - build the two-group picker model gated by live entitlement and credit
 *     truth (all metered levels remain available while bought credits exist);
 *   - expose the current display label + a `commit`, and reset a now-disabled
 *     paid tier only after funding truth is authoritative;
 *   - own the MAX lane control state (available / locked / engaged) plus the
 *     non-brick clamp, so every surface that can engage MAX agrees on when it
 *     is purchasable-backed and what actually goes on the wire.
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
  EVE_INFERENCE_MAX_TIER_ID,
  EVE_INFERENCE_STANDARD_TIER_ID,
  EVE_MAX_ENTITLED_SETTINGS_KEY,
  eveTierValue,
  hasEveMaxAccess,
  isEveInferenceSelection,
  migrateLegacyEveSelection,
  resolveEffectiveWireTierFromSelection,
  type EveInferenceWireTier,
  type EvePickerGroup,
  type EvePickerItem,
} from '@/common/config/eveInferenceCore';
import { useEntitlementGate } from '@renderer/hooks/useEntitlementGate';
import { useCreditsStatus } from '@renderer/hooks/useCreditsStatus';
import { isElectronDesktop } from '@renderer/utils/platform';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * The MAX control contract (all three states must be reachable and renderable):
 *   - `available` — a real purchase backs it; the toggle is operable.
 *   - `locked`    — trial/free or promotional-credit-only; the toggle renders
 *                   locked with an upsell affordance. Promotional credits never
 *                   unlock MAX.
 *   - `engaged`   — MAX is the active selection; the composer wears the MAX state.
 *
 * `engaged` is deliberately independent of `available`: a seat that bought MAX,
 * engaged it, and then lapsed keeps its persisted intent (so it lights up again
 * on renewal) while the effective wire tier clamps to Standard.
 */
export type EveMaxControlState = 'available' | 'locked' | 'engaged';

export interface UseEveInferenceSelectionResult {
  /** Persisted selection; unknown local/connected values stay verbatim until their source loads. */
  selection: string;
  /** Two-group picker model, gated by the current entitlement. */
  groups: EvePickerGroup[];
  /** Flattened items across both groups (label lookup / sheet rows). */
  items: EvePickerItem[];
  /** The currently-selected, still-selectable item (undefined if none). */
  selectedItem: EvePickerItem | undefined;
  /**
   * The picker row the persisted selection points at, EVEN IF it is currently
   * locked. `selectedItem` intentionally hides a locked row (nothing may act on
   * it); this one exists so a surface can still NAME the user's choice instead of
   * regressing to "pick a model" the moment a subscription lapses.
   */
  activeItem: EvePickerItem | undefined;
  /** Persist a new selection. No-op for an unknown/disabled value. */
  commit: (value: string) => void;
  /** True iff `value` is a known, selectable item. */
  isSelectable: (value: string) => boolean;
  /** MAX is backed by a real purchase (paid plan/seat, top-up, or bought credits). */
  maxAvailable: boolean;
  /** MAX is the persisted selection (independent of whether it is still funded). */
  maxEngaged: boolean;
  /** MAX is wanted or shown but not purchasable-backed — render the upsell. */
  maxLocked: boolean;
  /** Rolled-up control state for the toggle surface. */
  maxState: EveMaxControlState;
  /**
   * Engage/disengage MAX. Disengaging always works. Engaging is refused when MAX
   * is locked, so the control can never persist a lane the server would refuse.
   */
  setMaxEngaged: (next: boolean) => void;
  /**
   * The wire tier this seat would actually POST right now — MAX clamped to
   * `standard` while unentitled, so a lapsed seat can still send. `undefined`
   * for a local/unresolvable selection, exactly like the unclamped resolver.
   */
  effectiveWireTier: EveInferenceWireTier | undefined;
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
      // The MAX gate needs the two signals the wider metered-credit rule blurs
      // together. `has_paid_plan` is a real plan; `has_purchased_credits` is a
      // REAL top-up. Included-allowance credits — where a promotional grant
      // lands — deliberately feed NEITHER, which is what keeps a promotion from
      // unlocking the strong lane. Both require an authoritative credits read:
      // an unreadable status must not be able to open a paid lane.
      has_paid_plan: creditsAreAuthoritative && creditsStatus?.tier !== 'free',
      has_purchased_credits: creditsAreAuthoritative && purchasedCredits > 0,
    };
  }, [creditsStatus, status]);

  const [selection, expose] = useState<string>(() => {
    // Default to EVE Standard (cloud) for a fresh user; local Gemma is opt-in.
    const stored = configService.get('commandEve.inferenceSelection') || EVE_DEFAULT_INFERENCE_SELECTION;
    return migrateLegacyEveSelection(stored) ?? stored;
  });

  /**
   * Adopt a selection, migrating a retired one on the way in AND persisting the
   * replacement.
   *
   * Reading through a migration is not enough on its own: the stored string and
   * the picker's active row both come from the raw value, so without this write
   * the config would keep a tier the server refuses and the picker would keep
   * showing it as chosen. State and config move together here so the two can
   * never disagree.
   *
   * The write is guarded on an ACTUAL change, so re-adopting an already-migrated
   * value neither writes nor re-enters through the subscription — no loop, no
   * duplicate onChange.
   */
  const setSelection = useCallback((next: string) => {
    const migrated = migrateLegacyEveSelection(next);
    if (migrated === undefined) {
      expose(next);
      return;
    }
    expose(migrated);
    if (configService.get('commandEve.inferenceSelection') !== migrated) {
      configService.set('commandEve.inferenceSelection', migrated);
    }
  }, []);

  // A selection already on disk when this mounts never passes through the
  // subscription, so it is migrated (and written back) once here.
  useEffect(() => {
    const stored = configService.get('commandEve.inferenceSelection');
    const migrated = migrateLegacyEveSelection(stored);
    if (migrated !== undefined && migrated !== stored) {
      expose(migrated);
      configService.set('commandEve.inferenceSelection', migrated);
    }
  }, []);

  // Keep local state in sync with config changes from any other surface
  // (header ↔ sheet ↔ GuidPicker all read the same key).
  useEffect(() => {
    const unsubscribe = configService.subscribe('commandEve.inferenceSelection', (value) => {
      if (typeof value === 'string' && value.length > 0) setSelection(value);
    });
    return unsubscribe;
  }, [setSelection]);

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

  // --- MAX lane -------------------------------------------------------------
  const maxSelectionValue = eveTierValue(EVE_INFERENCE_MAX_TIER_ID);
  const maxAvailable = hasEveMaxAccess(pickerEntitlement);
  const maxEngaged = selection === maxSelectionValue;
  const maxLocked = !maxAvailable;
  const maxState: EveMaxControlState = maxEngaged && maxAvailable ? 'engaged' : maxAvailable ? 'available' : 'locked';
  /**
   * What THIS RENDERER would put on the wire. Read carefully: the renderer does
   * NOT own the send path — the main-process shim resolves the tier per request
   * from the backend store. So this value is a VIEW for renderer surfaces, and
   * the clamp that actually protects a lapsed seat is the one in
   * `inferenceSelectionBackendRead.ts`, fed by the `commandEve.maxEntitled` flag
   * published just below. Both apply the same pure rule, so they agree.
   */
  const effectiveWireTier = resolveEffectiveWireTierFromSelection(selection, { maxEntitled: maxAvailable });

  // PUBLISH the entitlement fact the MAIN process needs to apply the clamp.
  //
  // The main process reads this from the same settings bag it already fetches
  // for the selection, so the clamp costs nothing extra per turn. Only publish
  // once the funding truth is AUTHORITATIVE: writing `false` from a loading or
  // unreadable state would clamp a paying seat down to Standard, which is worse
  // than not clamping at all. Guarded on an actual change so this never loops.
  useEffect(() => {
    if (!paidTierAccessKnown) return;
    if (configService.get(EVE_MAX_ENTITLED_SETTINGS_KEY) === maxAvailable) return;
    configService.set(EVE_MAX_ENTITLED_SETTINGS_KEY, maxAvailable);
  }, [maxAvailable, paidTierAccessKnown]);

  const setMaxEngaged = useCallback(
    (next: boolean) => {
      const value = next ? maxSelectionValue : eveTierValue(EVE_INFERENCE_STANDARD_TIER_ID);
      // Engaging a locked MAX would persist a lane the server refuses; the
      // upsell affordance is the answer there, not a write.
      if (next && !maxAvailable) return;
      if (value === selection) return;
      setSelection(value);
      configService.set('commandEve.inferenceSelection', value);
      onChange?.(value);
    },
    [maxAvailable, maxSelectionValue, onChange, selection, setSelection]
  );

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
  //  - a now-UNKNOWN EVE selection that resolves to no picker item.
  //
  // MAX IS THE ONE EXCEPTION, and it is deliberate. An unfunded MAX is not a
  // stranded selection: the clamp above already makes it SEND on Standard, so
  // nothing is broken by keeping it — while erasing it would throw away the
  // user's stated intent and force them to re-pick after every lapse or transient
  // credits blip. Intent is preserved; entitlement decides what travels.
  //
  // Unknown local/connected values remain untouched because their provider model
  // may not have loaded yet; an absent picker row is not proof they were retired.
  useEffect(() => {
    const fallback = eveTierValue(EVE_INFERENCE_DEFAULT_TIER_ID);
    const isUnknownEve = isEveInferenceSelection(selection) && !items.some((item) => item.value === selection);
    const isConfirmedUnfundedTier =
      selectedRaw?.group === 'eve' && selectedRaw.disabled && paidTierAccessKnown && selection !== maxSelectionValue;
    if ((isConfirmedUnfundedTier || isUnknownEve) && selection !== fallback) {
      setSelection(fallback);
      configService.set('commandEve.inferenceSelection', fallback);
    }
  }, [selectedRaw, items, paidTierAccessKnown, selection, maxSelectionValue]);

  return {
    selection,
    groups,
    items,
    selectedItem,
    activeItem: selectedRaw,
    commit,
    isSelectable,
    maxAvailable,
    maxEngaged,
    maxLocked,
    maxState,
    setMaxEngaged,
    effectiveWireTier,
    cloudBearerAvailable,
    refreshBearer,
  };
}

export default useEveInferenceSelection;
