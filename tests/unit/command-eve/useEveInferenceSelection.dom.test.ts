/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useEveInferenceSelection — the shared in-session EVE tier selection hook.
 *
 * Covers the behaviour FIX C relies on:
 *   - a fresh user defaults to EVE Standard (cloud);
 *   - commit() persists to `commandEve.inferenceSelection` so the send-path shim
 *     re-reads it on the next turn;
 *   - a switch made on one surface propagates to others via the config
 *     subscription (header ↔ sheet ↔ GuidPage);
 *   - a greyed paid level (trialing) is NOT committable, and a previously-stored
 *     paid level auto-resets to the default (Standard) when neither entitlement
 *     nor metered credits fund it.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const store: Map<string, unknown> = new Map();
const subscribers: Map<string, Set<(value: unknown) => void>> = new Map();

vi.mock('@/common/config/configService', () => {
  return {
    configService: {
      get: (k: string) => store.get(k),
      set: vi.fn((k: string, v: unknown) => {
        store.set(k, v);
        const subs = subscribers.get(k);
        if (subs) {
          for (const cb of subs) cb(v);
        }
      }),
      subscribe: (k: string, cb: (value: unknown) => void) => {
        if (!subscribers.has(k)) subscribers.set(k, new Set());
        subscribers.get(k)!.add(cb);
        return () => {
          subscribers.get(k)?.delete(cb);
        };
      },
    },
  };
});

// Controllable entitlement status. `trial_ends_at` non-null ⇒ trialing (greys the
// paid Pro rungs Hoch/Max; only Standard stays SELECTABLE — selectable, never
// free: a Standard turn is credit-metered like every other cloud turn).
// Default: paid (all selectable).
const entitlement = {
  ok: true,
  state: 'entitled',
  trial_ends_at: null as string | null,
  has_paid_seat: false,
  // The SIGNED licence edition, exactly as the entitlement status carries it.
  // `undefined` means NO signed licence, which is not a weaker claim than a
  // comped one — it is no authority at all, and `isPaidPlanForSeat` refuses it.
  edition: undefined as string | undefined,
};
const entitlementHookState: { loading: boolean; status: typeof entitlement | null } = {
  loading: false,
  status: entitlement,
};
vi.mock('@renderer/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => ({ ...entitlementHookState, blocked: false, refresh: vi.fn() }),
}));

const creditsStatus: {
  ok: boolean;
  tier: string;
  purchased_credits_remaining: number;
  included_allowance_credits_remaining: number;
  has_active_topup: boolean;
} = {
  ok: false,
  tier: 'free',
  purchased_credits_remaining: 0,
  included_allowance_credits_remaining: 0,
  has_active_topup: false,
};
const creditsHookState: { loading: boolean; status: typeof creditsStatus | null } = {
  loading: false,
  status: creditsStatus,
};
vi.mock('@renderer/hooks/useCreditsStatus', () => ({
  useCreditsStatus: () => ({ ...creditsHookState, meter: null, refresh: vi.fn() }),
}));

import { useEveInferenceSelection } from '@renderer/hooks/agent/useEveInferenceSelection';
import { configService } from '@/common/config/configService';
import { EVE_DEFAULT_INFERENCE_SELECTION, eveTierValue, localTierValue } from '@/common/config/eveInferenceCore';

/** Writes to the SHARED SELECTION KEY only — never the sibling `maxEntitled` key. */
const selectionWrites = (): unknown[][] =>
  vi.mocked(configService.set).mock.calls.filter(([key]) => key === 'commandEve.inferenceSelection');

describe('useEveInferenceSelection', () => {
  beforeEach(() => {
    store.clear();
    subscribers.clear();
    entitlement.trial_ends_at = null; // paid by default
    entitlement.has_paid_seat = false;
    entitlement.edition = undefined; // no signed licence unless a case sets one
    entitlementHookState.loading = false;
    entitlementHookState.status = entitlement;
    // No authoritative credit receipt by default: existing entitlement-only
    // tests keep exercising the compatibility path.
    creditsStatus.ok = false;
    creditsStatus.tier = 'free';
    creditsStatus.purchased_credits_remaining = 0;
    creditsStatus.included_allowance_credits_remaining = 0;
    creditsStatus.has_active_topup = false;
    creditsHookState.loading = false;
    creditsHookState.status = creditsStatus;
    vi.clearAllMocks();
  });

  it('defaults a fresh user to EVE Standard (cloud, the unnamed default rung)', () => {
    const { result } = renderHook(() => useEveInferenceSelection());
    expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(result.current.selectedItem?.group).toBe('eve');
    // The cloud offer reads exactly "Standard · MAX".
    expect(result.current.selectedItem?.label).toBe('Standard');
    const cloud = result.current.groups.find((g) => g.kind === 'eve')!;
    expect(cloud.items.map((i) => i.label)).toEqual(['Standard', 'MAX']);
  });

  it('commit() persists the choice to commandEve.inferenceSelection (next-turn pickup)', () => {
    // AUTHORITY FIRST, and that is the contract rather than fixture noise: under
    // the Founder ruling NO writer persists this key while the funding question
    // is unanswered — `origin: 'user'` included. The held case is asserted
    // directly below and in eveInferenceSelectionUnknownWrite.dom.test.tsx.
    creditsStatus.ok = true;
    const { result } = renderHook(() => useEveInferenceSelection());
    const localHigh = localTierValue('local-high');
    act(() => result.current.commit(localHigh));
    expect(configService.set).toHaveBeenCalledWith('commandEve.inferenceSelection', localHigh);
    expect(store.get('commandEve.inferenceSelection')).toBe(localHigh);
    expect(result.current.selection).toBe(localHigh);
  });

  it('commit() of a METERED rung while authority is UNKNOWN writes NOTHING and holds the intent in memory', async () => {
    // The paired negative for the row above: same click, same mechanism, only the
    // answer to "may we write?" changed. Without this pairing the row above would
    // pass just as happily with the gate deleted.
    //
    // THE PROBE IS NOW A METERED VALUE, AND THAT IS THE CORRECTION. It used to be
    // `localTierValue('local-high')` — so this row pinned the private, ZERO-COST
    // lane as un-persistable while the funding question was open. R4 exists to stop
    // an unverified seat persisting a rung that SPENDS; applying it to a lane that
    // spends nothing made the cost-free option unreachable on precisely the seats
    // whose entitlement bridge cannot answer (`unconfigured` never resolves). The
    // hold is on what the value COSTS. Here it must, and does, still hold.
    creditsStatus.ok = false; // entitled, but the credits read is not authoritative
    // Start on the private lane, so the metered pick below is a REAL change and the
    // held-then-replayed write cannot be confused with a no-op.
    const localHigh = localTierValue('local-high');
    store.set('commandEve.inferenceSelection', localHigh);
    const { result, rerender } = renderHook(() => useEveInferenceSelection());
    const meteredStandard = eveTierValue('eve-standard');
    act(() => result.current.commit(meteredStandard));
    expect(selectionWrites()).toEqual([]);
    expect(store.get('commandEve.inferenceSelection')).toBe(localHigh);
    // Not painted either — the in-memory selection is untouched.
    expect(result.current.selection).toBe(localHigh);
    // ...but not dropped: it is held, and lands when the answer does.
    expect(result.current.intentPending).toBe(true);

    creditsStatus.ok = true;
    creditsHookState.status = { ...creditsStatus };
    rerender();
    await waitFor(() => expect(store.get('commandEve.inferenceSelection')).toBe(meteredStandard));
    expect(result.current.intentPending).toBe(false);
  });

  it('commit() of the LOCAL lane while authority is UNKNOWN writes IMMEDIATELY — nothing is spent, nothing is held', () => {
    // The other half of the same rule, on the same call, in the same state. The
    // zero-cost lane must remain reachable exactly when the billing subsystem can
    // not answer — that is when an operator most needs it.
    creditsStatus.ok = false;
    const { result } = renderHook(() => useEveInferenceSelection());
    const localHigh = localTierValue('local-high');
    act(() => result.current.commit(localHigh));
    expect(selectionWrites()).toEqual([['commandEve.inferenceSelection', localHigh]]);
    expect(store.get('commandEve.inferenceSelection')).toBe(localHigh);
    expect(result.current.selection).toBe(localHigh);
    expect(result.current.intentPending).toBe(false);
  });

  it('fires the onChange callback after a successful commit', () => {
    creditsStatus.ok = true;
    const onChange = vi.fn();
    const { result } = renderHook(() => useEveInferenceSelection(onChange));
    const eveStandard = eveTierValue('eve-standard');
    act(() => result.current.commit(eveStandard));
    expect(onChange).toHaveBeenCalledWith(eveStandard);
  });

  it('propagates a switch made on another surface via the config subscription', async () => {
    const { result } = renderHook(() => useEveInferenceSelection());
    const localStandard = localTierValue('local-standard');
    // Simulate the header/sheet writing the key directly.
    act(() => {
      configService.set('commandEve.inferenceSelection', localStandard);
    });
    await waitFor(() => expect(result.current.selection).toBe(localStandard));
  });

  it('a retired rung arriving over the SUBSCRIPTION while authority is UNKNOWN is not re-persisted', async () => {
    // THE FOURTH WRITER, and the one with no other gate in front of it. `commit`
    // and `setMaxEngaged` hold their own clicks; the mount effect holds its own
    // migration. The subscription handler calls `setSelection` directly, so when
    // ANOTHER surface (Settings → Modell) writes a retired rung while the funding
    // question is unanswered, only setSelection's own gate stands between that and
    // a migrated rewrite of the shared key. Deleting that gate reddened nothing
    // until this row existed.
    creditsStatus.ok = false; // entitled, credits not authoritative ⇒ UNKNOWN
    const { result } = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
    vi.clearAllMocks();

    // Through configService.set — the only call that notifies subscribers, i.e.
    // the real cross-surface path.
    act(() => {
      configService.set('commandEve.inferenceSelection', eveTierValue('eve-ultra'));
    });

    // In memory the hook may adopt the migrated value (the UI must not show a dead
    // lane), but what is ON DISK is the other surface's word, unrewritten.
    await waitFor(() => expect(result.current.selection).toBe(eveTierValue('eve-max')));
    expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue('eve-ultra'));
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveTierValue('eve-max'));
  });

  it('keeps EVE Standard SELECTABLE while trialing — selectable, not free', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    const { result } = renderHook(() => useEveInferenceSelection());
    const eveStandard = eveTierValue('eve-standard');
    // Standard is the free model — selectable + committable on a trial.
    expect(result.current.isSelectable(eveStandard)).toBe(true);
    act(() => result.current.commit(eveStandard));
    expect(result.current.selection).toBe(eveStandard);
  });

  it('greys MAX while trialing and refuses to commit it (no legacy rung is even offered)', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    creditsStatus.tier = 'free';
    const { result } = renderHook(() => useEveInferenceSelection());
    const eveHoch = eveTierValue('eve-high');
    const eveMax = eveTierValue('eve-max');
    const eveUltra = eveTierValue('eve-ultra');
    expect(result.current.isSelectable(eveHoch)).toBe(false);
    expect(result.current.isSelectable(eveMax)).toBe(false);
    expect(result.current.isSelectable(eveUltra)).toBe(false);
    act(() => result.current.commit(eveHoch));
    act(() => result.current.commit(eveMax));
    act(() => result.current.commit(eveUltra));
    // commit is a no-op for a disabled/unknown level — selection stays at Standard.
    expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveHoch);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveMax);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveUltra);
  });

  it('MAX unlocks when a trial-marked account owns PURCHASED credits', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    creditsStatus.ok = true;
    creditsStatus.tier = 'free';
    creditsStatus.purchased_credits_remaining = 120_000;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.isSelectable(eveTierValue('eve-standard'))).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(true);
    expect(result.current.maxAvailable).toBe(true);
    expect(result.current.maxLocked).toBe(false);
  });

  it('preserves a stored MAX intent while unfunded, and clamps the WIRE tier instead', async () => {
    // The non-brick clamp: erasing the selection would throw away the user's
    // stated intent and force a re-pick after every lapse. The clamp keeps the
    // seat sending on Standard while the intent survives on disk.
    store.set('commandEve.inferenceSelection', eveTierValue('eve-max'));
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    creditsStatus.ok = true;
    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.maxLocked).toBe(true));
    expect(result.current.selection).toBe(eveTierValue('eve-max'));
    expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue('eve-max'));
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );
    // ...and the seat can still send: the effective wire tier is the floor rung.
    // The chip can still NAME the choice even though it is not selectable.
    expect(result.current.selectedItem).toBeUndefined();
    expect(result.current.activeItem?.label).toBe('MAX');
    expect(result.current.activeItem?.disabled).toBe(true);
  });

  it('preserves a funded paid tier when stale trial truth arrives before purchased credits', async () => {
    const eveMax = eveTierValue('eve-max');
    store.set('commandEve.inferenceSelection', eveMax);
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    entitlementHookState.loading = true;
    entitlementHookState.status = null;
    creditsHookState.loading = true;
    creditsHookState.status = null;

    const { result, rerender } = renderHook(() => useEveInferenceSelection());
    expect(result.current.selection).toBe(eveMax);

    entitlementHookState.loading = false;
    entitlementHookState.status = entitlement;
    rerender();

    const cloudItems = result.current.groups.find((group) => group.kind === 'eve')?.items ?? [];
    expect(cloudItems.map((item) => item.label)).toEqual(['Standard', 'MAX']);
    expect(cloudItems.find((item) => item.value === eveMax)?.disabled).toBe(true);
    expect(result.current.selection).toBe(eveMax);
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );

    creditsStatus.ok = true;
    creditsStatus.purchased_credits_remaining = 120_000;
    creditsHookState.loading = false;
    creditsHookState.status = creditsStatus;
    rerender();

    await waitFor(() => expect(result.current.isSelectable(eveMax)).toBe(true));
    expect(result.current.selection).toBe(eveMax);
    expect(store.get('commandEve.inferenceSelection')).toBe(eveMax);
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );
  });

  it('NEVER persists a fallback over a stored MAX, even once both reads confirm no funded access', async () => {
    // This used to reset to Standard. Under the clamp it must not: the seat is
    // already able to send, so overwriting the choice buys nothing and loses the
    // intent that should re-engage on purchase.
    const eveMax = eveTierValue('eve-max');
    store.set('commandEve.inferenceSelection', eveMax);
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    entitlementHookState.loading = true;
    entitlementHookState.status = null;
    creditsHookState.loading = true;
    creditsHookState.status = null;

    const { result, rerender } = renderHook(() => useEveInferenceSelection());

    creditsStatus.ok = true;
    creditsHookState.loading = false;
    creditsHookState.status = creditsStatus;
    rerender();
    expect(result.current.selection).toBe(eveMax);

    entitlementHookState.loading = false;
    entitlementHookState.status = entitlement;
    rerender();

    await waitFor(() => expect(result.current.maxLocked).toBe(true));
    expect(result.current.selection).toBe(eveMax);
    expect(store.get('commandEve.inferenceSelection')).toBe(eveMax);
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );
  });

  it('lights MAX back up on purchase WITHOUT the user re-picking it', async () => {
    const eveMax = eveTierValue('eve-max');
    store.set('commandEve.inferenceSelection', eveMax);
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    creditsStatus.ok = true;

    const { result, rerender } = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(result.current.maxLocked).toBe(true));

    // The seat buys credits.
    creditsStatus.purchased_credits_remaining = 120_000;
    creditsHookState.status = { ...creditsStatus };
    rerender();

    await waitFor(() => expect(result.current.maxAvailable).toBe(true));
    expect(result.current.maxEngaged).toBe(true);
    expect(result.current.maxState).toBe('engaged');
    expect(result.current.selection).toBe(eveMax);
  });

  it('auto-resets a now-removed tier (the retired eve-maximum) to the default', async () => {
    // A user who persisted the old eve-maximum wire id
    // must not be stranded on an unresolvable selection — reset to Standard.
    store.set('commandEve.inferenceSelection', 'command-eve-inference:eve-maximum');
    entitlement.trial_ends_at = null; // paid
    const { result } = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
  });

  it.each([
    ['local', 'command-eve-local:future-local'],
    ['connected', 'connected-provider:future-model'],
  ])('preserves an unknown %s selection without claiming a known picker item', async (_kind, persisted) => {
    store.set('commandEve.inferenceSelection', persisted);

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(persisted));
    expect(result.current.selectedItem).toBeUndefined();
    expect(store.get('commandEve.inferenceSelection')).toBe(persisted);
    expect(configService.set).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Retired-rung migration.
  //
  // Reading through a migration is not the same as migrating: the stored string
  // and the picker's active row both come from the RAW persisted value, so
  // without a write-back the config keeps a tier the server refuses and the
  // picker keeps presenting it as chosen. These pin the write, not just the read.
  // -------------------------------------------------------------------------
  //
  // EVERY WRITE-BACK ROW BELOW ESTABLISHES AUTHORITATIVE FUNDING TRUTH FIRST
  // (`creditsStatus.ok = true`), and that is not fixture noise — it is the
  // contract. The write-back is gated on `paidTierAccessKnown`: while entitlement
  // is UNKNOWN the hook adopts the migrated value in memory but must NOT touch
  // disk, because a rewrite performed before anyone knows whether the seat is
  // entitled is not undone when the answer arrives (R4). These rows used to run
  // with `creditsStatus.ok = false` — i.e. UNKNOWN — and asserted the write
  // happened anyway, which made the defect the contract. The held case has its own
  // file: eveInferenceSelectionUnknownWrite.dom.test.tsx.

  // With no visible "Standard" label any more, the user-facing outcome of a
  // migration is a BOOLEAN INTENT: MAX off (EVE's normal unnamed behaviour) or on.
  // Whether MAX actually SERVES is a separate, main-process question — see
  // eveMaxAuthority.test.ts. This hook is not an authority on that.
  it.each([
    ['eve-standard', false],
    ['eve-high', false],
    ['eve-xhigh', true],
    ['eve-max', true],
    ['eve-ultra', true],
  ])('MIGRATION ROW: a persisted %s lands on MAX=%s', async (from, maxOn) => {
    store.set('commandEve.inferenceSelection', eveTierValue(from as 'eve-high'));
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = true; // entitled, so "MAX on" is not clamped

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.maxEngaged).toBe(maxOn));
    // NOTE: the hook no longer reports an effective wire tier. What the wire
    // actually sends is the MAIN process's decision (useEveMaxAuthority); this
    // hook owns INTENT and ENTITLEMENT only.
  });

  it.each([
    ['eve-high', 'eve-standard'],
    ['eve-xhigh', 'eve-max'],
    ['eve-ultra', 'eve-max'],
  ])('MIGRATION ROW: a persisted %s is rewritten to %s on disk (write-back)', async (from, to) => {
    store.set('commandEve.inferenceSelection', eveTierValue(from as 'eve-high'));
    entitlement.trial_ends_at = null;
    creditsStatus.ok = true; // funding truth is AUTHORITATIVE — the write is allowed

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(eveTierValue(to as 'eve-max')));
    expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue(to as 'eve-max'));
    expect(configService.set).toHaveBeenCalledWith('commandEve.inferenceSelection', eveTierValue(to as 'eve-max'));
  });

  it('MIGRATION ROW: a legacy MAX-bound seat that is UNENTITLED shows locked and clamps, without losing the intent', async () => {
    store.set('commandEve.inferenceSelection', eveTierValue('eve-ultra'));
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(eveTierValue('eve-max')));
    expect(result.current.maxEngaged).toBe(true);
    expect(result.current.maxLocked).toBe(true);
    expect(result.current.maxState).toBe('locked');
    // Still sendable — clamped to the floor rung, intent preserved on disk.
    expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue('eve-max'));
  });

  it('MIGRATION ROW: an UNKNOWN eve value becomes Standard and is written back', async () => {
    store.set('commandEve.inferenceSelection', 'command-eve-inference:eve-maximum');
    entitlement.trial_ends_at = null;
    creditsStatus.ok = true; // authoritative: the reset may be persisted

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
    expect(store.get('commandEve.inferenceSelection')).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
  });

  it('MIGRATION ROW: the SAME unknown value is NOT written back while entitlement is unknown', async () => {
    // The paired negative. Identical setup minus the authoritative credit read, so
    // the only thing that changed is the answer to "may we write?". Without this
    // pairing the row above would pass just as happily with the guard deleted.
    store.set('commandEve.inferenceSelection', 'command-eve-inference:eve-maximum');
    entitlement.trial_ends_at = null;
    creditsStatus.ok = false; // funding truth NOT authoritative ⇒ UNKNOWN

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
    expect(store.get('commandEve.inferenceSelection')).toBe('command-eve-inference:eve-maximum');
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );
  });

  it('shows MAX as the active picker item after migrating (on a purchased seat)', async () => {
    store.set('commandEve.inferenceSelection', eveTierValue('eve-ultra'));
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = true;

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selectedItem?.value).toBe(eveTierValue('eve-max')));
    expect(result.current.selectedItem?.label).toBe('MAX');
  });

  it('migrates a retired rung arriving through the subscription', async () => {
    entitlement.trial_ends_at = null;
    creditsStatus.ok = true; // authoritative — a subscription-borne migration may persist
    const { result } = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
    vi.clearAllMocks();

    // Through configService.set, not store.set: only the former notifies
    // subscribers, so writing the backing store directly would test nothing and
    // look like a product defect.
    act(() => {
      configService.set('commandEve.inferenceSelection', eveTierValue('eve-ultra'));
    });

    await waitFor(() => expect(result.current.selection).toBe(eveTierValue('eve-max')));
    expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue('eve-max'));
    expect(configService.set).toHaveBeenLastCalledWith('commandEve.inferenceSelection', eveTierValue('eve-max'));
  });

  it('leaves every OFFERED rung untouched and writes the SELECTION key nothing', async () => {
    for (const tierId of ['eve-standard', 'eve-max'] as const) {
      vi.clearAllMocks();
      store.set('commandEve.inferenceSelection', eveTierValue(tierId));
      entitlement.trial_ends_at = null;
      entitlement.has_paid_seat = true;

      const { result, unmount } = renderHook(() => useEveInferenceSelection());
      await waitFor(() => expect(result.current.selection).toBe(eveTierValue(tierId)));
      expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue(tierId));
      // SCOPED TO THE KEY UNDER TEST. A blanket `not.toHaveBeenCalled()` also
      // forbade the `commandEve.maxEntitled` publication — a DIFFERENT key with
      // its own contract, which now legitimately lands here because a SIGNED paid
      // seat resolves authority without waiting on a credits read.
      expect(selectionWrites()).toEqual([]);
      unmount();
    }
  });

  it('MIGRATION ROW: a LOCAL selection is left completely alone', async () => {
    for (const localId of ['local-standard', 'local-high'] as const) {
      vi.clearAllMocks();
      store.set('commandEve.inferenceSelection', localTierValue(localId));
      entitlement.trial_ends_at = null;

      const { result, unmount } = renderHook(() => useEveInferenceSelection());
      await waitFor(() => expect(result.current.selection).toBe(localTierValue(localId)));
      expect(store.get('commandEve.inferenceSelection')).toBe(localTierValue(localId));
      expect(configService.set).not.toHaveBeenCalled();
      // A local lane engages no cloud tier, so it can debit no cloud credits.
      expect(result.current.selectedItem?.group).toBe('local');
      unmount();
    }
  });

  it('keeps MAX selectable on a purchased seat', () => {
    entitlement.has_paid_seat = true;
    const { result } = renderHook(() => useEveInferenceSelection());
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(true);
    act(() => result.current.commit(eveTierValue('eve-max')));
    expect(result.current.selection).toBe(eveTierValue('eve-max'));
  });

  it('does not offer any non-offered rung anywhere a user could reach it', () => {
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = true;
    const { result } = renderHook(() => useEveInferenceSelection());

    const values = result.current.items.map((item) => item.value);
    for (const retired of ['eve-high', 'eve-xhigh', 'eve-ultra'] as const) {
      expect(values).not.toContain(eveTierValue(retired));
      expect(result.current.isSelectable(eveTierValue(retired))).toBe(false);
    }
    // And MAX is there exactly once — collapsing the ladder must not duplicate
    // the rung everything migrates into.
    expect(values.filter((value) => value === eveTierValue('eve-max'))).toHaveLength(1);
  });

  it('never auto-resets a persisted MAX for a confirmed purchased seat', async () => {
    const max = eveTierValue('eve-max');
    store.set('commandEve.inferenceSelection', max);
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = true;

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(max));
    expect(store.get('commandEve.inferenceSelection')).toBe(max);
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );
  });

  // -------------------------------------------------------------------------
  // The MAX control contract (spec 2.6): available / locked / engaged.
  // -------------------------------------------------------------------------

  it('MAX is LOCKED on promotional/allowance credits only — a promotion is not a purchase', () => {
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;
    creditsStatus.tier = 'free';
    creditsStatus.purchased_credits_remaining = 0;
    creditsStatus.included_allowance_credits_remaining = 100; // the promo grant
    creditsStatus.has_active_topup = false;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.maxAvailable).toBe(false);
    expect(result.current.maxLocked).toBe(true);
    expect(result.current.maxState).toBe('locked');
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(false);
    // ...while the promotional seat keeps the entry rung it was granted.
    expect(result.current.isSelectable(eveTierValue('eve-standard'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TRIAL IS NOT PAID (CAO finding 2).
  //
  // The server has always reported `trial` as its own tier. The desktop union did
  // not model it and the MAX gate asked "is it not free?", so a trial seat
  // answered "paid" and unlocked MAX — the exact thing the Founder rule forbids.
  // It only failed to bite because the credits BRIDGE happened to fold every
  // unrecognised tier into `free`; carrying the true value through, which honesty
  // requires, would have armed it immediately.
  // -------------------------------------------------------------------------

  it('TRIAL + promotional allowance -> MAX LOCKED (a trial is not a purchase)', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;
    creditsStatus.tier = 'trial';
    creditsStatus.included_allowance_credits_remaining = 100_000; // EUR 100 promo grant
    creditsStatus.purchased_credits_remaining = 0;
    creditsStatus.has_active_topup = false;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.maxAvailable).toBe(false);
    expect(result.current.maxLocked).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(false);
    // ...and the promotional allowance still funds the routine lane, as intended.
    expect(result.current.isSelectable(eveTierValue('eve-standard'))).toBe(true);
  });

  it('TRIAL + PURCHASED credits -> MAX UNLOCKED (buying is what unlocks it)', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;
    creditsStatus.tier = 'trial';
    creditsStatus.included_allowance_credits_remaining = 100_000;
    creditsStatus.purchased_credits_remaining = 5_000;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.maxAvailable).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(true);
  });

  it.each([['starter'], ['solo']])('a REAL paid plan (%s) on a SIGNED seat -> MAX UNLOCKED', (tier) => {
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = false; // the PLAN alone must be enough...
    entitlement.edition = 'standard'; // ...but a real plan comes on a signed seat.
    creditsStatus.ok = true;
    creditsStatus.tier = tier;
    creditsStatus.purchased_credits_remaining = 0;
    creditsStatus.has_active_topup = false;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.maxAvailable).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(true);
  });

  it.each([['starter'], ['solo']])('INVERTED: the same paid TIER (%s) with NO signed edition -> MAX LOCKED', (tier) => {
    // This case used to expect UNLOCKED, and that assertion WAS the defect. The
    // reported tier is DERIVED from whatever allowance was granted, so it cannot
    // tell a bought subscription from a comped one; only the signed licence can.
    // With the edition ABSENT the client was unlocking a lane the server — which
    // judges the LICENCE — answers 402 on. Unknown authority fails CLOSED (R4).
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = false;
    entitlement.edition = undefined;
    creditsStatus.ok = true;
    creditsStatus.tier = tier;
    creditsStatus.purchased_credits_remaining = 0;
    creditsStatus.has_active_topup = false;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.maxAvailable).toBe(false);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(false);
    // NOT BRICKED: Standard is still selectable — R1/R2 hold.
    expect(result.current.isSelectable(eveTierValue('eve-standard'))).toBe(true);
  });

  it('an UNKNOWN future tier defaults to UNPAID — the allowlist fails in the safe direction', () => {
    // With `!== 'free'` every tier the server invents later would unlock MAX by
    // default. The allowlist inverts that.
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;
    creditsStatus.tier = 'some-future-tier';
    creditsStatus.purchased_credits_remaining = 0;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.maxAvailable).toBe(false);
  });

  it('MAX is AVAILABLE on a paid seat and on PURCHASED credits — never on a top-up alone', () => {
    // INVERTED (CAO round 2): the middle row used to expect `true` for an active
    // top-up with an EMPTY wallet. That assertion WAS the defect — a fully spent
    // subscription has no purchased balance, so the server 402s it while the client
    // was offering it.
    const cases: Array<{ name: string; apply: () => void; available: boolean }> = [
      {
        name: 'paid seat',
        apply: () => {
          entitlement.has_paid_seat = true;
        },
        available: true,
      },
      {
        name: 'active top-up, wallet EMPTY',
        apply: () => {
          creditsStatus.ok = true;
          creditsStatus.has_active_topup = true;
        },
        available: false,
      },
      {
        name: 'active top-up WITH purchased credits',
        apply: () => {
          creditsStatus.ok = true;
          creditsStatus.has_active_topup = true;
          creditsStatus.purchased_credits_remaining = 5_000;
        },
        available: true,
      },
      {
        name: 'purchased credits, no top-up',
        apply: () => {
          creditsStatus.ok = true;
          creditsStatus.purchased_credits_remaining = 5_000;
        },
        available: true,
      },
    ];
    for (const c of cases) {
      entitlement.has_paid_seat = false;
      creditsStatus.ok = false;
      creditsStatus.tier = 'free';
      creditsStatus.has_active_topup = false;
      creditsStatus.purchased_credits_remaining = 0;
      c.apply();

      const { result, unmount } = renderHook(() => useEveInferenceSelection());
      expect(result.current.maxAvailable, c.name).toBe(c.available);
      expect(result.current.maxState, c.name).toBe(c.available ? 'available' : 'locked');
      unmount();
    }
  });

  it('setMaxEngaged engages and disengages MAX, and refuses to engage while locked', () => {
    entitlement.has_paid_seat = true;
    const { result } = renderHook(() => useEveInferenceSelection());

    act(() => result.current.setMaxEngaged(true));
    expect(result.current.selection).toBe(eveTierValue('eve-max'));
    expect(result.current.maxEngaged).toBe(true);
    expect(result.current.maxState).toBe('engaged');

    act(() => result.current.setMaxEngaged(false));
    expect(result.current.selection).toBe(eveTierValue('eve-standard'));
    expect(result.current.maxEngaged).toBe(false);
  });

  // -------------------------------------------------------------------------
  // PUBLISHING the entitlement fact the MAIN process clamps on.
  //
  // Without this write the clamp in inferenceSelectionBackendRead has no input,
  // `maxEntitled` is always unknown, and a lapsed MAX seat eats the server's
  // upsell on every turn. This is the renderer half of that contract.
  // -------------------------------------------------------------------------

  it('publishes commandEve.maxEntitled=false once funding truth is AUTHORITATIVE', async () => {
    entitlement.trial_ends_at = null;
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;

    renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(store.get('commandEve.maxEntitled')).toBe(false));
  });

  it('publishes commandEve.maxEntitled=true for a purchased seat', async () => {
    entitlement.has_paid_seat = true;
    creditsStatus.ok = true;

    renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(store.get('commandEve.maxEntitled')).toBe(true));
  });

  it('publishes NOTHING while funding truth is still loading — an unknown must never clamp a paying seat', async () => {
    entitlementHookState.loading = true;
    entitlementHookState.status = null;
    creditsHookState.loading = true;
    creditsHookState.status = null;

    const { rerender } = renderHook(() => useEveInferenceSelection());
    rerender();

    // Absent, NOT false. `false` here would downgrade a seat we simply cannot
    // see yet.
    expect(store.has('commandEve.maxEntitled')).toBe(false);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.maxEntitled', false);
  });

  it('does not rewrite an unchanged entitlement flag (no write loop)', async () => {
    entitlement.has_paid_seat = true;
    creditsStatus.ok = true;
    store.set('commandEve.maxEntitled', true);

    const { rerender } = renderHook(() => useEveInferenceSelection());
    rerender();
    rerender();

    expect(configService.set).not.toHaveBeenCalledWith('commandEve.maxEntitled', true);
  });

  it('setMaxEngaged(true) is a no-op for a locked seat — no write, no lane the server would refuse', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;
    const { result } = renderHook(() => useEveInferenceSelection());
    vi.clearAllMocks();

    act(() => result.current.setMaxEngaged(true));

    expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(result.current.maxEngaged).toBe(false);
    expect(configService.set).not.toHaveBeenCalled();
  });
});
