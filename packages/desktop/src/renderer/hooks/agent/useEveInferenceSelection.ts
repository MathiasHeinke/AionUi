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
  buildEveEntitlementView,
  buildEvePickerGroups,
  EVE_DEFAULT_INFERENCE_SELECTION,
  EVE_INFERENCE_MAX_TIER_ID,
  EVE_INFERENCE_STANDARD_TIER_ID,
  EVE_MAX_ENTITLED_SETTINGS_KEY,
  eveTierValue,
  hasEveMaxAccess,
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
   *
   * While authority is UNKNOWN this records an IN-MEMORY pending intent instead
   * (see {@link intentPending}) — no paint, no wire, no disk.
   */
  setMaxEngaged: (next: boolean) => void;
  /**
   * Whether both funding authorities have ANSWERED — positive or negative.
   * The gate on every write to `commandEve.inferenceSelection`.
   */
  authorityResolved: boolean;
  /**
   * A click landed while authority was UNKNOWN and is being held IN MEMORY.
   * It is not on disk, it is not painted, and it is not on the wire.
   */
  intentPending: boolean;
  /**
   * A held intent was REFUSED once the answer landed (a MAX intent on a seat the
   * answer says may not have MAX). Surfaced so the refusal is VISIBLE — an
   * impermissible intent must resolve to locked/upsell, never be silently
   * dropped. Cleared by {@link acknowledgeIntentRefused}.
   */
  intentRefused: boolean;
  /** Dismiss the refusal notice after the surface has shown it. */
  acknowledgeIntentRefused: () => void;
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

/** The one persisted key every writer in this module shares. */
const SELECTION_KEY = 'commandEve.inferenceSelection';

/**
 * AUTHORITY RESOLUTION — a DIFFERENT QUESTION from entitlement, and keeping the
 * two apart is the whole point of this function (Founder ruling, round 3).
 *
 *   `authorityResolved` = "has the funding question been ANSWERED?"
 *   `maxEntitled`       = "was the answer YES?"
 *
 * Conflating them produced three separate defects. The old predicate demanded
 * `state === 'entitled'`, so an authoritative NO never resolved: a seat the
 * server had definitively answered "not licensed" stranded every deferred write
 * forever, because the gate it was waiting on could only open for the positive
 * answer. AN AUTHORITATIVE "NO" IS AN ANSWER.
 *
 * The three ways the question gets answered, all of them terminal:
 *   1. Entitlement says NOT entitled. There is no credits account without a
 *      licence — the credits bridge returns `ok:false` with a NO_BEARER reason
 *      for exactly this seat — so waiting for a credits read would wait forever.
 *      Answer: no paid lane. RESOLVED.
 *   2. Entitlement says entitled AND the SIGNED licence already carries
 *      `has_paid_seat`. That alone decides MAX (see `hasEveMaxAccess`), so a
 *      credits blip cannot change the answer. RESOLVED.
 *   3. Entitlement says entitled and the credits read is authoritative
 *      (`ok === true`). The full picture. RESOLVED — either way.
 *
 * Everything else is UNKNOWN and must hold every write:
 *   - either source still loading;
 *   - no status object at all (pre-first-read, or a non-desktop build with no
 *     entitlement bridge — unchanged from the previous predicate, which also
 *     never opened there);
 *   - `state === 'unconfigured'`, which is this bridge's "I cannot tell you"
 *     (no bundled key, or a thrown bridge read) rather than a seat verdict.
 */
export function eveSelectionAuthorityResolved(input: {
  entitlementLoading: boolean;
  entitlementStatus: { ok?: boolean; state?: string; has_paid_seat?: boolean } | null | undefined;
  creditsLoading: boolean;
  creditsStatus: { ok?: boolean } | null | undefined;
}): boolean {
  const entitlement = input.entitlementStatus;
  const entitlementAnswered =
    input.entitlementLoading === false && entitlement != null && entitlement.state !== 'unconfigured';
  if (!entitlementAnswered) return false;
  const seatIsEntitled = entitlement.ok === true && entitlement.state === 'entitled';
  if (!seatIsEntitled) return true; // an authoritative NO is an ANSWER
  if (entitlement.has_paid_seat === true) return true; // the signed licence already decided
  return input.creditsLoading === false && input.creditsStatus?.ok === true;
}

/**
 * The write gate on its own, for the OTHER surface that persists the shared key
 * (Settings → Modell's local-lane switch). It lives here rather than in its own
 * file so there is exactly one definition of "may this key be written", and so
 * the hooks/agent directory stays under the ten-child limit.
 */
export function useEveSelectionAuthority(): boolean {
  const { loading: entitlementLoading, status } = useEntitlementGate();
  const { loading: creditsLoading, status: creditsStatus } = useCreditsStatus();
  return eveSelectionAuthorityResolved({
    entitlementLoading,
    entitlementStatus: status,
    creditsLoading,
    creditsStatus,
  });
}

/**
 * @param onChange Optional callback fired after a successful commit (e.g. to
 *   surface an egress notice). The persistence to configService happens first.
 */
export function useEveInferenceSelection(onChange?: (selection: string) => void): UseEveInferenceSelectionResult {
  const { loading: entitlementLoading, status } = useEntitlementGate();
  const { loading: creditsLoading, status: creditsStatus } = useCreditsStatus();

  // THE VIEW EVERY GATE BELOW IS ASKED ABOUT — built by the shared, node-testable
  // constructor rather than inline here, so a test can produce a
  // PRODUCTION-COMPLETE view instead of a hand-typed partial that quietly lands in
  // a compatibility branch. See buildEveEntitlementView for why that mattered.
  const pickerEntitlement = useMemo(
    () => buildEveEntitlementView(status, creditsStatus, isPaidPlanForSeat),
    [creditsStatus, status]
  );

  // THE WRITE GATE — hoisted above every writer on purpose (R4).
  //
  // It used to be computed further down, AFTER `setSelection` and after the mount
  // migration effect, which is precisely why those two could persist a lane while
  // the entitlement was still unknown. A guard that is declared after the code it
  // is supposed to guard cannot guard it.
  //
  // It is `authorityResolved`, NOT `maxEntitled` — see the doc on
  // eveSelectionAuthorityResolved for why demanding the POSITIVE answer stranded
  // an unentitled seat's deferred writes forever.
  const authorityResolved = eveSelectionAuthorityResolved({
    entitlementLoading,
    entitlementStatus: status,
    creditsLoading,
    creditsStatus,
  });

  const [selection, expose] = useState<string>(() => {
    // Default to EVE Standard (cloud) for a fresh user; local Gemma is opt-in.
    const stored = configService.get(SELECTION_KEY) || EVE_DEFAULT_INFERENCE_SELECTION;
    return migrateLegacyEveSelection(stored) ?? stored;
  });

  /**
   * THE PENDING INTENT, IN MEMORY AND NOWHERE ELSE.
   *
   * A click during the UNKNOWN window is an intent, not a decision the app may
   * record. It is deliberately NOT a second persisted key: an on-disk "pending"
   * key would recreate the very problem this gate exists to close, one rename
   * away. It is deliberately NOT folded into `selection` either — `maxEngaged`
   * is derived from `selection`, so parking a MAX intent there would PAINT MAX
   * on an answer nobody has given.
   */
  const [pendingIntent, setPendingIntent] = useState<string | undefined>(undefined);
  /** A held intent the answer then refused. Drives the visible locked/upsell resolution. */
  const [intentRefused, setIntentRefused] = useState(false);
  const acknowledgeIntentRefused = useCallback(() => setIntentRefused(false), []);

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
   *
   * THE GATE NO LONGER LOOKS AT `origin`, AND THAT IS THE FIX. It used to exempt
   * `origin: 'user'` on the reasoning that refusing a deliberate choice would be
   * its own bug — but an exempted writer is not a gated writer, and this one
   * persisted MAX for a seat nobody had yet established may have it. A deliberate
   * choice made during the UNKNOWN window is not discarded; it is held IN MEMORY
   * by the caller (see `pendingIntent`) and replayed — or visibly refused — the
   * moment the answer lands. The parameter survives only to distinguish those two
   * cases in the reader's head; both are held.
   *
   * In-memory state still updates so the UI stays coherent; only the DISK write
   * waits for an answer. What waits is exactly what R4 protects: a stored
   * `eve-ultra` was being silently migrated to `eve-max` (or a stored MAX reset to
   * Standard) before anyone knew whether the seat was entitled, and the write is
   * not undone when the answer arrives.
   */
  const setSelection = useCallback(
    (next: string) => {
      // `migrateLegacyEveSelection` answers `undefined` for BOTH "not an EVE
      // value" and "already canonical", so the resolved value is the migration
      // when there is one and the input otherwise. The old shape returned early
      // on `undefined`, which is why every caller had to re-issue its own
      // `configService.set` — and an ungated duplicate write beside a gated one
      // is how `origin: 'user'` slipped past the gate in the first place. ONE
      // writer, ONE gate.
      const resolved = migrateLegacyEveSelection(next) ?? next;
      expose(resolved);
      if (!authorityResolved) return;
      if (configService.get(SELECTION_KEY) !== resolved) {
        configService.set(SELECTION_KEY, resolved);
      }
    },
    [authorityResolved]
  );

  // A selection already on disk when this mounts never passes through the
  // subscription, so it is migrated (and written back) once funding truth is
  // AUTHORITATIVE.
  //
  // The `authorityResolved` gate is the fix for the R4 hole this effect was:
  // it ran on mount with an empty dep array, i.e. at the exact moment entitlement
  // is least likely to be known, and rewrote the persisted key anyway. A seat
  // whose stored lane was the retired `eve-ultra` had it replaced with `eve-max`
  // before anything knew whether that seat may have MAX. The in-memory adoption
  // still happens immediately (the UI must not show a dead lane); only the write
  // waits. Re-runs when the answer lands — for the NEGATIVE answer as well as the
  // positive one, which is exactly what the old `state === 'entitled'` gate could
  // not do — so nothing is stranded.
  useEffect(() => {
    const stored = configService.get(SELECTION_KEY);
    const migrated = migrateLegacyEveSelection(stored);
    if (migrated === undefined || migrated === stored) return;
    expose(migrated);
    if (!authorityResolved) return;
    configService.set(SELECTION_KEY, migrated);
  }, [authorityResolved]);

  // Keep local state in sync with writes from the other surface. Since MAT-1749
  // there are exactly two writers of this key — the composer's MAX toggle (via
  // setMaxEngaged) and Settings → Modell — and several readers, all of them
  // reading through this hook. This subscription is what lets a Settings change
  // reach an open composer without a reload.
  useEffect(() => {
    const unsubscribe = configService.subscribe(SELECTION_KEY, (value) => {
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
  // sources have finished with authoritative truth (`paidTierAccessKnown`, hoisted
  // above the writers). In particular, a stale trial marker can arrive before
  // purchased-credit status during startup.

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
    if (!authorityResolved) return;
    if (configService.get(EVE_MAX_ENTITLED_SETTINGS_KEY) === maxAvailable) return;
    configService.set(EVE_MAX_ENTITLED_SETTINGS_KEY, maxAvailable);
  }, [maxAvailable, authorityResolved]);

  const setMaxEngaged = useCallback(
    (next: boolean) => {
      const value = next ? maxSelectionValue : eveTierValue(EVE_INFERENCE_STANDARD_TIER_ID);
      // UNKNOWN: hold the click IN MEMORY. It must not paint MAX (nothing here
      // touches `selection`), must not send MAX (the send path re-reads the DISK
      // key, which is untouched), and must not touch disk. It is neither obeyed
      // nor discarded — it waits for the answer.
      if (!authorityResolved) {
        setPendingIntent(value);
        setIntentRefused(false);
        return;
      }
      // Engaging a locked MAX would persist a lane the server refuses; the
      // upsell affordance is the answer there, not a write — and the refusal is
      // RAISED, not swallowed, so the surface can show it.
      if (next && !maxAvailable) {
        setIntentRefused(true);
        return;
      }
      setIntentRefused(false);
      if (value === selection) return;
      setSelection(value);
      onChange?.(value);
    },
    [authorityResolved, maxAvailable, maxSelectionValue, onChange, selection, setSelection]
  );

  /**
   * THE ANSWER LANDS — resolve the held intent, in one of exactly two visible
   * ways. Never silently sent, never silently painted, never silently dropped.
   */
  useEffect(() => {
    if (!authorityResolved || pendingIntent === undefined) return;
    setPendingIntent(undefined);
    if (pendingIntent === maxSelectionValue && !maxAvailable) {
      // The answer is NO. The intent resolves to locked/upsell, VISIBLY.
      setIntentRefused(true);
      return;
    }
    setIntentRefused(false);
    if (pendingIntent === selection) return;
    setSelection(pendingIntent);
    onChange?.(pendingIntent);
  }, [authorityResolved, maxAvailable, maxSelectionValue, onChange, pendingIntent, selection, setSelection]);

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
      // UNKNOWN: held in memory like every other click. `commit` is the same
      // shared key, so exempting it would leave the gate with a hole named
      // differently.
      if (!authorityResolved) {
        setPendingIntent(value);
        setIntentRefused(false);
        return;
      }
      setSelection(value);
      onChange?.(value);
    },
    [authorityResolved, items, onChange, setSelection]
  );

  // ── THE UNKNOWN-LANE FALLBACK EFFECT IS DELETED, AND THAT IS THE HONEST FIX ──
  //
  // It reset a stranded EVE selection to Standard on two conditions:
  //   `isUnknownEve`            — an EVE value resolving to no lane in the model;
  //   `isConfirmedUnfundedTier` — an EVE lane that is present but disabled.
  // Its comment claimed it prevented a silent downgrade, and a test file claimed
  // deleting its guard would go red. NEITHER ARM CAN EVER BE TRUE, so both claims
  // were false. Measured, not reasoned: deleting the guard reddened 0 of 4486
  // tests, and deleting the whole effect reddened 0 as well.
  //
  //   `isUnknownEve` is unreachable because EVERY path that sets `selection`
  //   normalises first — the useState initializer and `setSelection` both run
  //   `migrateLegacyEveSelection`, which maps ANY `command-eve-inference:*` string
  //   (retired, unknown, corrupt) onto the OFFERED surface. `isEveInferenceSelection`
  //   is the same prefix test, so an EVE selection that is not in `items` cannot
  //   exist here.
  //
  //   `isConfirmedUnfundedTier` is unreachable because the EVE group offers exactly
  //   Standard and MAX; Standard is never disabled, and MAX is excluded by the
  //   `!== maxSelectionValue` term that keeps the intent across a lapse. There is
  //   no third rung to be disabled.
  //
  // Dead code whose comment asserts a safety property is worse than no code: it is
  // read as protection. The premise that KILLED it is pinned instead, in
  // tests/unit/command-eve/eveSelectionStrandingImpossible.test.ts — if a third
  // selectable EVE rung or a paid-only Standard is ever added, that test goes red
  // and whoever adds it has to bring a GATED reset back with it.

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
    authorityResolved,
    intentPending: pendingIntent !== undefined,
    intentRefused,
    acknowledgeIntentRefused,
    cloudBearerAvailable,
    refreshBearer,
  };
}

export default useEveInferenceSelection;
