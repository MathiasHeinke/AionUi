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
// paid Pro rungs Hoch/Max; only Standard stays free). Default: paid (all selectable).
const entitlement = {
  ok: true,
  state: 'entitled',
  trial_ends_at: null as string | null,
  has_paid_seat: false,
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

describe('useEveInferenceSelection', () => {
  beforeEach(() => {
    store.clear();
    subscribers.clear();
    entitlement.trial_ends_at = null; // paid by default
    entitlement.has_paid_seat = false;
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

  it('defaults a fresh user to EVE Standard (cloud, the free-eligible rung)', () => {
    const { result } = renderHook(() => useEveInferenceSelection());
    expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(result.current.selectedItem?.group).toBe('eve');
    // Cloud picker rows read "Standard / Hoch / Sehr hoch / Maximum".
    expect(result.current.selectedItem?.label).toBe('Standard');
  });

  it('commit() persists the choice to commandEve.inferenceSelection (next-turn pickup)', () => {
    const { result } = renderHook(() => useEveInferenceSelection());
    const localHigh = localTierValue('local-high');
    act(() => result.current.commit(localHigh));
    expect(configService.set).toHaveBeenCalledWith('commandEve.inferenceSelection', localHigh);
    expect(store.get('commandEve.inferenceSelection')).toBe(localHigh);
    expect(result.current.selection).toBe(localHigh);
  });

  it('fires the onChange callback after a successful commit', () => {
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

  it('keeps EVE Standard (free-eligible) selectable while trialing', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    const { result } = renderHook(() => useEveInferenceSelection());
    const eveStandard = eveTierValue('eve-standard');
    // Standard is the free model — selectable + committable on a trial.
    expect(result.current.isSelectable(eveStandard)).toBe(true);
    act(() => result.current.commit(eveStandard));
    expect(result.current.selection).toBe(eveStandard);
  });

  it('greys the offered paid Pro rungs while trialing and refuses to commit them', () => {
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
    // commit is a no-op for a disabled level — selection stays at the default (Standard).
    expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveHoch);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveMax);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveUltra);
  });

  it('keeps all metered cloud levels available when a trial-marked account owns purchased credits', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z';
    creditsStatus.ok = true;
    creditsStatus.tier = 'free';
    creditsStatus.purchased_credits_remaining = 120_000;

    const { result } = renderHook(() => useEveInferenceSelection());

    expect(result.current.isSelectable(eveTierValue('eve-high'))).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-xhigh'))).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(true);
  });

  it('auto-resets a previously-stored paid level (Max) to the default (Standard) when trialing', async () => {
    store.set('commandEve.inferenceSelection', eveTierValue('eve-max'));
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    creditsStatus.ok = true;
    const { result } = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
    expect(store.get('commandEve.inferenceSelection')).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
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
    expect(cloudItems.map((item) => item.label)).toEqual(['Standard', 'Hoch', 'Sehr hoch', 'Maximum']);
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

  it('persists a paid-tier fallback only after both reads confirm no funded access', async () => {
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
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );

    entitlementHookState.loading = false;
    entitlementHookState.status = entitlement;
    rerender();

    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
    expect(store.get('commandEve.inferenceSelection')).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(configService.set).toHaveBeenCalledWith('commandEve.inferenceSelection', EVE_DEFAULT_INFERENCE_SELECTION);
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

  it('migrates a persisted retired rung and writes the replacement back', async () => {
    store.set('commandEve.inferenceSelection', eveTierValue('eve-ultra'));
    entitlement.trial_ends_at = null; // paid, so nothing else can retire it

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(eveTierValue('eve-max')));
    expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue('eve-max'));
    expect(configService.set).toHaveBeenCalledWith('commandEve.inferenceSelection', eveTierValue('eve-max'));
  });

  it('shows Maximum as the active picker item after migrating', async () => {
    store.set('commandEve.inferenceSelection', eveTierValue('eve-ultra'));
    entitlement.trial_ends_at = null;

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selectedItem?.value).toBe(eveTierValue('eve-max')));
    expect(result.current.selectedItem?.label).toBe('Maximum');
  });

  it('migrates a retired rung arriving through the subscription', async () => {
    entitlement.trial_ends_at = null;
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

  it('leaves every accepted rung untouched and writes nothing', async () => {
    for (const tierId of ['eve-standard', 'eve-high', 'eve-xhigh', 'eve-max'] as const) {
      vi.clearAllMocks();
      store.set('commandEve.inferenceSelection', eveTierValue(tierId));
      entitlement.trial_ends_at = null;

      const { result, unmount } = renderHook(() => useEveInferenceSelection());
      await waitFor(() => expect(result.current.selection).toBe(eveTierValue(tierId)));
      expect(store.get('commandEve.inferenceSelection')).toBe(eveTierValue(tierId));
      expect(configService.set).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('keeps the paid Pro rungs selectable when paid (trial_ends_at null)', () => {
    const { result } = renderHook(() => useEveInferenceSelection());
    expect(result.current.isSelectable(eveTierValue('eve-high'))).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(true);
    act(() => result.current.commit(eveTierValue('eve-max')));
    expect(result.current.selection).toBe(eveTierValue('eve-max'));
  });

  it('does not offer the retired rung anywhere a user could reach it', () => {
    entitlement.trial_ends_at = null; // paid: nothing else could be hiding it
    const { result } = renderHook(() => useEveInferenceSelection());

    const values = result.current.items.map((item) => item.value);
    expect(values).not.toContain(eveTierValue('eve-ultra'));
    expect(result.current.isSelectable(eveTierValue('eve-ultra'))).toBe(false);
    for (const group of result.current.groups) {
      expect(group.items.map((item) => item.value)).not.toContain(eveTierValue('eve-ultra'));
    }
    // And Maximum is still there exactly once — retiring a rung must not
    // duplicate the one it migrates into.
    expect(values.filter((value) => value === eveTierValue('eve-max'))).toHaveLength(1);
  });

  it('never auto-resets a persisted paid tier for a confirmed non-trial user', async () => {
    const max = eveTierValue('eve-max');
    store.set('commandEve.inferenceSelection', max);
    entitlement.trial_ends_at = null;

    const { result } = renderHook(() => useEveInferenceSelection());

    await waitFor(() => expect(result.current.selection).toBe(max));
    expect(store.get('commandEve.inferenceSelection')).toBe(max);
    expect(configService.set).not.toHaveBeenCalledWith(
      'commandEve.inferenceSelection',
      EVE_DEFAULT_INFERENCE_SELECTION
    );
  });
});
