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
 *     paid level auto-resets to the default (Mittel) when the entitlement is trialing.
 *
 * STUFEN note (3-tier model): Mittel (DeepSeek V4 Flash) is the free-eligible rung
 * — the EVE Free model AND EVE Pro's cheapest. Hoch (DeepSeek V4 Pro) + Max (GLM 5.2)
 * are the paid Pro rungs that grey out while trialing.
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
// paid Pro rungs Hoch/Max; only Mittel stays free). Default: paid (all selectable).
const entitlement: { trial_ends_at?: string | null } = { trial_ends_at: null };
vi.mock('@renderer/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => ({ loading: false, status: entitlement, blocked: false, refresh: vi.fn() }),
}));

import { useEveInferenceSelection } from '@renderer/hooks/agent/useEveInferenceSelection';
import { configService } from '@/common/config/configService';
import {
  EVE_DEFAULT_INFERENCE_SELECTION,
  eveTierValue,
  localTierValue,
} from '@/common/config/eveInferenceCore';

describe('useEveInferenceSelection', () => {
  beforeEach(() => {
    store.clear();
    subscribers.clear();
    entitlement.trial_ends_at = null; // paid by default
    vi.clearAllMocks();
  });

  it('defaults a fresh user to EVE Mittel (cloud, the free-eligible rung)', () => {
    const { result } = renderHook(() => useEveInferenceSelection());
    expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(result.current.selectedItem?.group).toBe('eve');
    expect(result.current.selectedItem?.label).toBe('Mittel');
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

  it('keeps EVE Mittel (free-eligible) selectable while trialing', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    const { result } = renderHook(() => useEveInferenceSelection());
    const eveMittel = eveTierValue('eve-standard');
    // Mittel is the free model — selectable + committable on a trial.
    expect(result.current.isSelectable(eveMittel)).toBe(true);
    act(() => result.current.commit(eveMittel));
    expect(result.current.selection).toBe(eveMittel);
  });

  it('greys the paid Pro rungs (Hoch + Max) while trialing and refuses to commit a greyed level', () => {
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    const { result } = renderHook(() => useEveInferenceSelection());
    const eveHoch = eveTierValue('eve-high');
    const eveMax = eveTierValue('eve-max');
    expect(result.current.isSelectable(eveHoch)).toBe(false);
    expect(result.current.isSelectable(eveMax)).toBe(false);
    act(() => result.current.commit(eveHoch));
    act(() => result.current.commit(eveMax));
    // commit is a no-op for a disabled level — selection stays at the default (Mittel).
    expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveHoch);
    expect(configService.set).not.toHaveBeenCalledWith('commandEve.inferenceSelection', eveMax);
  });

  it('auto-resets a previously-stored paid level (Max) to the default (Mittel) when trialing', async () => {
    store.set('commandEve.inferenceSelection', eveTierValue('eve-max'));
    entitlement.trial_ends_at = '2099-01-01T00:00:00.000Z'; // trialing
    const { result } = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
    expect(store.get('commandEve.inferenceSelection')).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
  });

  it('auto-resets a now-removed tier (the retired eve-maximum) to the default', async () => {
    // A user who persisted the old eve-maximum tier (removed in the 3-tier model)
    // must not be stranded on an unresolvable selection — reset to Mittel.
    store.set('commandEve.inferenceSelection', 'command-eve-inference:eve-maximum');
    entitlement.trial_ends_at = null; // paid
    const { result } = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(result.current.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION));
  });

  it('keeps the paid Pro rungs (Hoch + Max) selectable when paid (trial_ends_at null)', () => {
    const { result } = renderHook(() => useEveInferenceSelection());
    expect(result.current.isSelectable(eveTierValue('eve-high'))).toBe(true);
    expect(result.current.isSelectable(eveTierValue('eve-max'))).toBe(true);
    act(() => result.current.commit(eveTierValue('eve-max')));
    expect(result.current.selection).toBe(eveTierValue('eve-max'));
  });
});
