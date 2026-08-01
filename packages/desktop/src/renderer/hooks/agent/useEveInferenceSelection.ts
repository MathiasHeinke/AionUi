/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useEveInferenceSelection — the single source of truth for the Command EVE
 * inference lane selection across the TWO surfaces that can change it:
 *
 *   - The composer's MAX toggle (the ONLY intelligence affordance the composer
 *     has, on desktop and on mobile alike; off = EVE's normal unnamed behaviour,
 *     on = the MAX state).
 *   - Settings → Modell, where the private local lane is chosen deliberately.
 *
 * There is NO lane/tier entry in the mobile action sheet any more (MAT-1749).
 * It offered `Verarbeitung → EVE Cloud / Lokal`, which is a composer
 * lane-selection affordance, and it was deleted with the ladder.
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
 *   - resolve the persisted string against an entitlement-gated MODEL of the
 *     available lanes (`groups`/`items`). THAT MODEL IS NOT A PICKER AND IS NOT
 *     RENDERED ANYWHERE. It exists so this hook can answer "is the current
 *     selection still a real, funded lane?" — nothing more. The picker UI it was
 *     originally built for was deleted with the ladder (MAT-1749);
 *   - expose the resolved lane (`selectedItem`) so the composer's EVE control can
 *     say cloud-vs-local, and reset a no-longer-funded selection only after
 *     funding truth is authoritative;
 *   - own the MAX lane control state (available / locked / engaged) plus the
 *     non-brick clamp, so every surface that can engage MAX agrees on when it
 *     is purchasable-backed.
 *
 * WHAT IT IS NOT AN AUTHORITY ON: what the wire actually sends. That is computed
 * in MAIN and consumed through useEveMaxAuthority. See the MAX-lane section below.
 *
 * Keeping this in ONE hook means the composer's MAX toggle (conversation and
 * start screen) and Settings → Modell cannot drift apart.
 */

import { commandEve } from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import { isPaidPlanForSeat } from '@/common/config/creditsCore';
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
 *   - `engaged`   — MAX is the persisted selection AND it is funded.
 *
 * THIS DRIVES THE PILL, NOT THE COMPOSER. `maxState` is stamped on the toggle as
 * `data-eve-max-state` and styles the control the user pressed. Whether the
 * COMPOSER wears the MAX treatment is a different question with a different
 * answer — `maxActive` from useEveMaxAuthority, computed in MAIN. Conflating the
 * two is precisely the defect that made a lapsed seat glow while the wire
 * clamped, so the two must be read separately here as well.
 *
 * `engaged` is deliberately independent of `available`: a seat that bought MAX,
 * engaged it, and then lapsed keeps its persisted intent (so it lights up again
 * on renewal) while MAIN clamps the effective wire tier.
 */
export type EveMaxControlState = 'available' | 'locked' | 'engaged';

export interface UseEveInferenceSelectionResult {
  /** Persisted selection; unknown local/connected values stay verbatim until their source loads. */
  selection: string;
  /**
   * The entitlement-gated model of the available lanes (cloud group + local
   * group). INTERNAL RESOLUTION INPUT ONLY — no surface renders it. It feeds
   * `items` below, which feeds the lane resolution and the unfunded-reset.
   * The picker that used to render it no longer exists (MAT-1749).
   */
  groups: EvePickerGroup[];
  /** `groups` flattened, for lane lookup by persisted value. Not rendered anywhere. */
  items: EvePickerItem[];
  /**
   * The lane the persisted selection resolves to, when it is still selectable.
   * Read by the composer's EVE control to say cloud-vs-local (and by
   * AcpRuntimeStatus) — never to name a cloud tier.
   */
  selectedItem: EvePickerItem | undefined;
  /**
   * The lane the persisted selection points at, EVEN IF it is currently locked.
   * `selectedItem` intentionally hides a locked lane (nothing may act on it);
   * this one keeps the user's stated choice legible across a lapse.
   * NOTE: nothing consumes this today — its last reader was the mobile lane
   * entry, deleted in MAT-1749. Kept as API, not as evidence of a surface.
   */
  activeItem: EvePickerItem | undefined;
  /**
   * Persist a new selection. No-op for an unknown/disabled value.
   * NOTE: no caller today — the surfaces that used it (the mobile lane entry,
   * the old picker) are gone. Settings → Modell writes the key directly, and the
   * composer writes only through `setMaxEngaged`.
   */
  commit: (value: string) => void;
  /** True iff `value` is a known, selectable lane. No caller today (see `commit`). */
  isSelectable: (value: string) => boolean;
  /**
   * MAX is backed by a real purchase: a paid plan/seat, OR a purchased-credit
   * BALANCE. An active top-up is deliberately NOT in that list — a subscription
   * that has been fully spent has no purchased balance, and unlocking on it made
   * the client offer a lane the server answers with 402.
   */
  maxAvailable: boolean;
  /** MAX is the persisted selection (INTENT — independent of whether it is funded). */
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
   * Whether the EVE Inference (cloud) lane has a usable license bearer at rest.
   * `true` = activated, cloud routes; `false` = no usable cloud bearer, so the
   * composer's EVE control reads "Aktivierung nötig" (UnifiedSendBar's privacy
   * summary) rather than lie "EVE Cloud"; `undefined` = unknown
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
    // NOTE the deliberate asymmetry with the MAX gate below. `!== 'free'` is
    // CORRECT here: this governs the metered/Standard lane, which a TRIAL seat is
    // meant to reach on its promotional allowance. Only the MAX gate must treat
    // trial as unpaid, and that one uses the explicit allowlist.
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
      //
      // TWO ALLOWLISTS, NOT `!== 'free'`. The negative form classified the
      // server's `trial` tier as PAID and unlocked MAX for every trial seat —
      // the exact thing the Founder rule forbids — and defaulted every future
      // tier to paid. `isPaidPlanForSeat` names the paid TIERS and the paid
      // seat EDITIONS explicitly, so anything new is unpaid until someone
      // decides otherwise, which is the only safe direction for a money gate.
      //
      // THE EDITION IS PART OF IT, and that is not belt-and-braces. The tier is
      // DERIVED server-side from the granted allowance, and an ALOIS100 0 €
      // `pilot` seat is seeded the STARTER allowance — so it reports
      // `tier: 'starter'` and the tier allowlist ALONE would unlock MAX for the
      // one seat the Founder rule names. The signed edition is what can tell a
      // comped allowance from a bought subscription.
      has_paid_plan: creditsAreAuthoritative && isPaidPlanForSeat(creditsStatus?.tier, status?.edition),
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
   * Reading through a migration is not enough on its own: the stored string is
   * what the SEND PATH re-reads per request, so without this write the config
   * would keep a tier the server refuses and every later read would resurrect
   * it. State and config move together here so the two can never disagree.
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

  // Keep local state in sync with writes from the other surface. Since MAT-1749
  // there are exactly two writers of this key — the composer's MAX toggle (via
  // setMaxEngaged) and Settings → Modell — and several readers, all of them
  // reading through this hook. This subscription is what lets a Settings change
  // reach an open composer without a reload.
  useEffect(() => {
    const unsubscribe = configService.subscribe('commandEve.inferenceSelection', (value) => {
      if (typeof value === 'string' && value.length > 0) setSelection(value);
    });
    return unsubscribe;
  }, [setSelection]);

  // Bearer presence for the EVE (cloud) lane. The composer's EVE control must
  // tell the truth: without a license wire, saying "EVE Cloud" would lie, so the
  // privacy summary reads "Aktivierung nötig" instead.
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
  // NO EFFECTIVE-WIRE-TIER IS COMPUTED HERE ANY MORE — deliberately.
  //
  // This hook used to derive `effectiveWireTier` and `maxActive` from
  // resolveEveWireLaneDecision, in parallel with the MAIN process that
  // actually builds the shim request. Two authorities can disagree, and when they
  // do the composer paints a state the wire is not in. The decision now comes from
  // main over `command-eve.inference-lane-decision` — see useEveMaxAuthority.
  //
  // What remains here is deliberately NOT routing: `maxEngaged` is stored INTENT,
  // and `maxAvailable` is the ENTITLEMENT question that drives the lock/upsell on
  // the control. Neither may be used to paint the composer surface.

  const maxState: EveMaxControlState = maxEngaged && maxAvailable ? 'engaged' : maxAvailable ? 'available' : 'locked';

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

  // Reset to the safe default once when the persisted selection is no longer
  // usable, so the SEND PATH never re-reads a stranded value as the active lane:
  //  - a metered EVE tier after both entitlement and credit truth confirm that it
  //    is no longer funded, OR
  //  - a now-UNKNOWN EVE selection that resolves to no lane in the model.
  //
  // MAX IS THE ONE EXCEPTION, and it is deliberate. An unfunded MAX is not a
  // stranded selection: the clamp above already makes it SEND on Standard, so
  // nothing is broken by keeping it — while erasing it would throw away the
  // user's stated intent and force them to re-pick after every lapse or transient
  // credits blip. Intent is preserved; entitlement decides what travels.
  //
  // Unknown local/connected values remain untouched because their provider model
  // may not have loaded yet; an absent lane is not proof they were retired.
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
    cloudBearerAvailable,
    refreshBearer,
  };
}

export default useEveInferenceSelection;
