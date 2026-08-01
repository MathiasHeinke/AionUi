/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * R4, THE PERSISTENCE HALF: while entitlement is UNKNOWN, nothing may rewrite
 * `commandEve.inferenceSelection`.
 *
 * WHY THIS FILE EXISTS AT ALL. `eveMaxEntitlementHold.dom.test.tsx` used to claim
 * this property in a block titled "the persisted MAX selection survives the whole
 * sequence". It could not: that file replaces `useEveInferenceSelection` wholesale
 * with `vi.mock`, so the hook that owns every write to this key never executed.
 * The assertion "no call to configService.set named the selection key" was
 * therefore true of a mock, and deleting the production guard could not turn it
 * red. It was a green gate guarding a path the product does not take.
 *
 * SO: THE HOOK HERE IS REAL. `useEveInferenceSelection` is imported and rendered,
 * not mocked. What IS mocked is strictly the boundary it reads from — the two
 * status hooks that ANSWER the entitlement question (that answer, and its absence,
 * is the input being varied), the Electron config store, and the IPC bridge. The
 * assertion is on the real `configService.set` calls the real hook makes.
 *
 * SABOTAGE CHECK: remove either `paidTierAccessKnown` guard in the hook (the mount
 * migration, or the unknown-lane fallback) and the UNKNOWN cases below go red.
 *
 * NAMING: `.dom.test.tsx`. The vitest `node` project takes `tests/unit/**\/*.test.ts`
 * and never `.tsx`; the `dom` project takes ONLY `*.dom.test.ts(x)`. A plain
 * `.test.tsx` matches NEITHER and "passes" by never running.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SELECTION_KEY = 'commandEve.inferenceSelection';
/** A RETIRED tier that still exists on disk for real users — the migration's input. */
const LEGACY_SELECTION = 'command-eve-inference:eve-ultra';
const MAX_SELECTION = 'command-eve-inference:eve-max';
const STANDARD_SELECTION = 'command-eve-inference:eve-standard';
/** An EVE selection that resolves to no lane in the model — the fallback's input. */
const UNRESOLVABLE_SELECTION = 'command-eve-inference:eve-does-not-exist';

/** The persisted config store, as a plain map so writes are observable. */
const store = vi.hoisted(() => ({ map: new Map<string, unknown>(), sets: [] as Array<[string, unknown]> }));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => store.map.get(key),
    set: (key: string, value: unknown) => {
      store.sets.push([key, value]);
      store.map.set(key, value);
    },
    subscribe: () => () => undefined,
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    licenseWireStatus: { invoke: vi.fn(async () => ({ success: true, data: { available: true } })) },
  },
}));

vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

/** THE INPUT UNDER VARIATION: whether entitlement + credit truth have landed. */
const gate = vi.hoisted(() => ({
  entitlement: { loading: true, status: null as unknown },
  credits: { loading: true, status: null as unknown },
}));

vi.mock('@renderer/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => gate.entitlement,
}));
vi.mock('@renderer/hooks/useCreditsStatus', () => ({
  useCreditsStatus: () => gate.credits,
}));

// THE REAL HOOK. Imported after the boundary mocks, never mocked itself.
import { useEveInferenceSelection } from '@renderer/hooks/agent/useEveInferenceSelection';

/** Entitlement is still being read — nothing has answered yet. */
function entitlementUnknown(): void {
  gate.entitlement = { loading: true, status: null };
  gate.credits = { loading: true, status: null };
}

/** A LOADED but non-authoritative read: the answer arrived and it is "no answer". */
function entitlementUnreadable(): void {
  gate.entitlement = { loading: false, status: { ok: false, state: 'unknown' } };
  gate.credits = { loading: false, status: { ok: false } };
}

/** Both sources answered: this seat is entitled and its credits are readable. */
function entitlementKnown(): void {
  gate.entitlement = { loading: false, status: { ok: true, state: 'entitled', edition: 'standard' } };
  gate.credits = {
    loading: false,
    status: {
      ok: true,
      tier: 'starter',
      purchased_credits_remaining: 5000,
      included_allowance_credits_remaining: 60000,
      has_active_topup: false,
    },
  };
}

const selectionWrites = (): Array<[string, unknown]> => store.sets.filter(([key]) => key === SELECTION_KEY);

beforeEach(() => {
  store.map = new Map<string, unknown>();
  store.sets = [];
  entitlementUnknown();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('UNKNOWN entitlement: the persisted selection key is never rewritten', () => {
  it('does NOT migrate a retired tier on disk while entitlement is unknown', async () => {
    // THE CITED DEFECT. A stored `eve-ultra` was rewritten to `eve-max` by the
    // mount effect, with an empty dependency list — i.e. at the one moment
    // entitlement is guaranteed not to be known yet. The write is not undone when
    // the answer turns out to be "not entitled".
    store.map.set(SELECTION_KEY, LEGACY_SELECTION);

    const view = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(view.result.current.selection).toBeTruthy());

    expect(selectionWrites(), 'no write may happen while entitlement is unknown').toEqual([]);
    expect(store.map.get(SELECTION_KEY), 'what is ON DISK is unchanged').toBe(LEGACY_SELECTION);
    // The UI still moves on: in-memory adoption is not a promise, the disk is.
    expect(view.result.current.selection).not.toBe(LEGACY_SELECTION);
  });

  it('does NOT reset an unresolvable EVE selection while entitlement is unknown', async () => {
    // The second ungated writer: the unknown-lane fallback. Its sibling arm
    // (`isConfirmedUnfundedTier`) carried a `paidTierAccessKnown` term; this one
    // did not, so an unresolved lane was downgraded to Standard and written out.
    store.map.set(SELECTION_KEY, UNRESOLVABLE_SELECTION);

    const view = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(view.result.current.selection).toBeTruthy());

    expect(selectionWrites()).toEqual([]);
    expect(store.map.get(SELECTION_KEY)).toBe(UNRESOLVABLE_SELECTION);
  });

  it('does NOT downgrade a persisted MAX while entitlement is unknown', async () => {
    store.map.set(SELECTION_KEY, MAX_SELECTION);

    const view = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(view.result.current.selection).toBe(MAX_SELECTION));

    expect(selectionWrites()).toEqual([]);
    expect(store.map.get(SELECTION_KEY)).toBe(MAX_SELECTION);
    // ...and it must not PAINT MAX either, on an answer nobody has given.
    expect(view.result.current.maxAvailable).toBe(false);
  });

  it('an UNREADABLE status is unknown too — a failed read is not permission to write', async () => {
    // `loading: false` is not the same as `ok: true`. Treating "finished reading,
    // read failed" as an answer is how a transient blip erases a paid intent.
    store.map.set(SELECTION_KEY, LEGACY_SELECTION);
    entitlementUnreadable();

    const view = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(view.result.current.selection).toBeTruthy());

    expect(selectionWrites()).toEqual([]);
    expect(store.map.get(SELECTION_KEY)).toBe(LEGACY_SELECTION);
  });
});

describe('KNOWN entitlement: the migration is not merely postponed forever', () => {
  it('migrates the retired tier on disk once both sources are authoritative', async () => {
    // The other half of fail-closed: holding the write while unknown must not
    // become never writing at all, or a stranded tier the server refuses would
    // outlive every session.
    store.map.set(SELECTION_KEY, LEGACY_SELECTION);
    entitlementKnown();

    const view = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(store.map.get(SELECTION_KEY)).not.toBe(LEGACY_SELECTION));

    expect(selectionWrites().length).toBeGreaterThan(0);
    expect(view.result.current.selection).toBe(store.map.get(SELECTION_KEY));
    expect(String(store.map.get(SELECTION_KEY))).toMatch(/^command-eve-inference:/);
  });

  it('the write waits for the answer rather than being lost: unknown → known migrates', async () => {
    // The exact real-world sequence: the app mounts before the status calls
    // resolve, then they resolve. The guard must defer, not discard.
    store.map.set(SELECTION_KEY, LEGACY_SELECTION);

    const view = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(view.result.current.selection).toBeTruthy());
    expect(selectionWrites(), 'nothing written while unknown').toEqual([]);

    entitlementKnown();
    view.rerender();

    await waitFor(() => expect(store.map.get(SELECTION_KEY)).not.toBe(LEGACY_SELECTION));
    expect(selectionWrites().length).toBeGreaterThan(0);
  });

  it('a user-initiated pick is ALWAYS persisted — the gate holds machine writes, not people', async () => {
    // The guard must not swallow a deliberate choice; that would be its own bug.
    entitlementKnown();
    store.map.set(SELECTION_KEY, MAX_SELECTION);

    const view = renderHook(() => useEveInferenceSelection());
    await waitFor(() => expect(view.result.current.items.length).toBeGreaterThan(0));

    view.result.current.commit(STANDARD_SELECTION);
    await waitFor(() => expect(store.map.get(SELECTION_KEY)).toBe(STANDARD_SELECTION));
  });
});
