/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SETTINGS → MODELL IS THE **SECOND** WRITER OF `commandEve.inferenceSelection`,
 * AND THIS FILE IS THE FIRST THING THAT EVER EXERCISED ITS GATE.
 *
 * THE HOLE, MEASURED. Round 4 added two `selectionAuthorityResolved` guards to
 * ModelModalContent — one on the lane switch, one on the tier-select path — and
 * BOTH reddened nothing: deleting either left the whole suite green. Nothing in
 * the repo referenced `useEveSelectionAuthority`, `setCommandEveLocalLane` or
 * `pendingLocalLaneSelection` at all. A gate on the money key that no test can
 * make fail is indistinguishable from no gate.
 *
 * SO THIS DRIVES THE REAL COMPONENT THROUGH THE REAL DOM, in the three states the
 * authority predicate distinguishes — and they are three, not two:
 *
 *   UNKNOWN                — the credits read is not authoritative yet. HOLD the
 *                            flip in memory, tell the operator, write NOTHING.
 *   ANSWERED / POSITIVE    — entitled with an authoritative credits read. WRITE.
 *   ANSWERED / NEGATIVE    — the seat is authoritatively NOT entitled. Still an
 *                            ANSWER, so it must WRITE too. (Demanding the positive
 *                            answer is what stranded unentitled seats forever; see
 *                            eveSelectionAuthorityResolved.)
 *
 * WHAT IS REAL: ModelModalContent, `useEveSelectionAuthority`, and
 * `eveSelectionAuthorityResolved`. Only transports are stubbed — the config store,
 * the two entitlement bridges, the IPC/platform bridges, and the sibling modals
 * this surface is not about.
 *
 * NAMING: `.dom.test.tsx` is mandatory (the `node` project takes `*.test.ts` only
 * and excludes `*.dom.test.*`; the `dom` project takes ONLY `*.dom.test.ts(x)`).
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SELECTION_KEY = 'commandEve.inferenceSelection';

// ── the config store (transport) ───────────────────────────────────────────
const store: Map<string, unknown> = new Map();
const configSet = vi.fn(async (k: string, v: unknown) => {
  store.set(k, v);
});
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => configSet(k, v),
    subscribe: () => () => undefined,
  },
}));

// ── the two funding authorities (transports) ───────────────────────────────
const authority = vi.hoisted(() => ({
  entitlement: {
    loading: false,
    status: { ok: true, state: 'entitled', has_paid_seat: false, edition: undefined as string | undefined },
  },
  credits: { loading: false, status: { ok: false, tier: 'free' } },
}));
vi.mock('@/renderer/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => ({ ...authority.entitlement, blocked: false, refresh: vi.fn() }),
}));
vi.mock('@renderer/hooks/useCreditsStatus', () => ({
  useCreditsStatus: () => ({ ...authority.credits, meter: null, refresh: vi.fn() }),
}));

// ── IPC / platform bridges (transports) ────────────────────────────────────
const ensureLocalModelTier = vi.hoisted(() => vi.fn(async () => ({ data: { status: 'ready' } })));
vi.mock('@/common', () => ({
  ipcBridge: {
    mode: {
      updateProvider: { invoke: vi.fn(async () => undefined) },
      createProvider: { invoke: vi.fn(async () => undefined) },
      deleteProvider: { invoke: vi.fn(async () => undefined) },
      listProviders: { invoke: vi.fn(async () => []) },
    },
    acpConversation: { checkProviderHealth: { invoke: vi.fn(async () => ({})) } },
    commandEve: { ensureLocalModelTier: { invoke: ensureLocalModelTier } },
  },
}));
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: () => ({ invoke: async () => ({ success: true, data: {} }) }),
    buildEmitter: () => ({ emit: () => undefined, on: () => () => undefined, off: () => undefined }),
  },
}));

// ── surfaces this file is not about ────────────────────────────────────────
const stubModal = vi.hoisted(() => ({ useModal: () => [{ open: () => undefined, close: () => undefined }, null] }));
vi.mock('@/renderer/pages/settings/components/AddModelModal', () => ({ default: stubModal }));
vi.mock('@/renderer/pages/settings/components/AddPlatformModal', () => ({ default: stubModal }));
vi.mock('@/renderer/pages/settings/components/EditModeModal', () => ({ default: stubModal }));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useProvidersQuery: () => ({ data: [], mutate: vi.fn() }),
}));
vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'modal',
}));
vi.mock('@/renderer/hooks/system/useDeepLink', () => ({ consumePendingDeepLink: () => undefined }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));

import ModelModalContent from '@/renderer/components/settings/SettingsModal/contents/ModelModalContent';
import { EVE_DEFAULT_INFERENCE_SELECTION, localTierValue } from '@/common/config/eveInferenceCore';

/** Only the SHARED money key counts; sibling keys are written unconditionally by design. */
const selectionWrites = (): unknown[] =>
  configSet.mock.calls.filter(([key]) => key === SELECTION_KEY).map(([, v]) => v);

/** The three authority states, set through the transports the predicate actually reads. */
function setAuthority(state: 'unknown' | 'positive' | 'negative'): void {
  if (state === 'unknown') {
    authority.entitlement.status = { ok: true, state: 'entitled', has_paid_seat: false, edition: undefined };
    authority.credits.status = { ok: false, tier: 'free' };
    return;
  }
  if (state === 'positive') {
    authority.entitlement.status = { ok: true, state: 'entitled', has_paid_seat: false, edition: undefined };
    authority.credits.status = { ok: true, tier: 'starter' };
    return;
  }
  // An authoritative NO from the entitlement bridge. There is no credits account
  // without a licence, so the credits read never becomes authoritative here — and
  // that is exactly the shape that used to strand every deferred write forever.
  authority.entitlement.status = { ok: false, state: 'not_entitled', has_paid_seat: false, edition: undefined };
  authority.credits.status = { ok: false, tier: 'free' };
}

beforeEach(() => {
  store.clear();
  store.set(SELECTION_KEY, EVE_DEFAULT_INFERENCE_SELECTION);
  configSet.mockClear();
  ensureLocalModelTier.mockClear();
  authority.entitlement.loading = false;
  authority.credits.loading = false;
  setAuthority('unknown');
});

describe('GUARD 1 — the shared key is gated on WHAT IS WRITTEN, not on which control wrote it', () => {
  // ── THE INVERTED PIN ────────────────────────────────────────────────────────
  //
  // THE TWO ROWS THAT USED TO STAND HERE, quoted rather than deleted, because they
  // are the only committed record of the behaviour and a deleted record makes a
  // correction look like a feature:
  //
  //   it('UNKNOWN: flipping the switch writes NOTHING and holds the flip in memory')
  //     expect(selectionWrites()).toEqual([]);
  //     expect(store.get(SELECTION_KEY)).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
  //
  //   it('UNKNOWN → ANSWERED: the held flip is REPLAYED, so a deliberate choice is
  //       never lost')
  //     expect(selectionWrites()).toEqual([]);   // …and lands when the answer does
  //
  // Both PASSED, and together they described the defect. R4 exists to stop a METERED
  // selection being persisted for a seat nobody has verified. Turning the PRIVATE,
  // ZERO-COST lane ON is the opposite transaction, and it was held by the same gate.
  // `state === 'unconfigured'` — this bridge's "I cannot tell you" — never resolves,
  // so on such a seat the replay is not a delay: IT NEVER FIRES. The operator was
  // pinned to the METERED default at exactly the moment the billing subsystem could
  // not answer at all. A spend control whose failure mode is "you must keep
  // spending" is the money defect wearing the guard's coat.
  //
  // Corrected contract, one sentence: a LOCAL selection is persistable in every
  // authority state; a METERED one is not. Same key, same surface, different VALUE.
  //
  /** SABOTAGE: in `setCommandEveLocalLane`, drop
   *  `&& !mayPersistSelectionWithoutAuthority(next)` from the hold condition — the
   *  zero-cost lane becomes unreachable again while the answer is missing. */
  it('UNKNOWN: flipping the switch ON writes the LOCAL lane IMMEDIATELY — no answer is needed to spend nothing', () => {
    render(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));

    expect(selectionWrites()).toEqual([localTierValue('local-standard')]);
    expect(store.get(SELECTION_KEY)).toBe(localTierValue('local-standard'));
    // The control MOVED and the disk agrees with it — no ghost state.
    expect(screen.getByTestId('command-eve-local-lane-switch').getAttribute('aria-checked')).toBe('true');
  });

  /** SABOTAGE: make that same condition unconditional (`if (false)`), i.e. gate on
   *  nothing at all. The METERED default below then lands on disk unverified. */
  it('UNKNOWN: flipping the switch OFF — a METERED default — still writes NOTHING. R4 is untouched', () => {
    // The paired negative, SAME control, SAME authority state, only the value's cost
    // differs. Without it the row above would pass just as happily against a surface
    // with no gate at all.
    setAuthority('positive');
    const view = render(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch')); // ON → local, written
    expect(selectionWrites()).toEqual([localTierValue('local-standard')]);

    configSet.mockClear();
    act(() => setAuthority('unknown'));
    view.rerender(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch')); // OFF → metered default

    expect(selectionWrites()).toEqual([]);
    expect(store.get(SELECTION_KEY)).toBe(localTierValue('local-standard'));
  });

  it('UNKNOWN → ANSWERED: the held METERED flip is REPLAYED, so a deliberate choice is never lost', async () => {
    setAuthority('positive');
    const view = render(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));
    configSet.mockClear();
    act(() => setAuthority('unknown'));
    view.rerender(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));
    expect(selectionWrites()).toEqual([]);

    act(() => setAuthority('positive'));
    view.rerender(<ModelModalContent />);

    await waitFor(() => expect(selectionWrites()).toEqual([EVE_DEFAULT_INFERENCE_SELECTION]));
  });

  it('ANSWERED / POSITIVE: the same flip writes IMMEDIATELY', () => {
    setAuthority('positive');
    render(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));
    expect(selectionWrites()).toEqual([localTierValue('local-standard')]);
  });

  it('ANSWERED / NEGATIVE: an authoritative NO is an ANSWER — it writes too, never strands', () => {
    setAuthority('negative');
    render(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));
    expect(selectionWrites()).toEqual([localTierValue('local-standard')]);
  });

  it('the METERED default is the ONE value the switch can hold — the direction, not the control, decides', () => {
    // Deliberately kept beside the row above rather than merged into it: this is the
    // claim that the gate still EXISTS on this control, stated separately from the
    // claim about which value it lets through.
    setAuthority('positive');
    const view = render(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));
    expect(selectionWrites()).toEqual([localTierValue('local-standard')]);

    configSet.mockClear();
    act(() => setAuthority('unknown'));
    view.rerender(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));
    expect(selectionWrites()).toEqual([]);
    expect(EVE_DEFAULT_INFERENCE_SELECTION.startsWith('command-eve-local:')).toBe(false);
  });
});

describe('GUARD 2 — the tier-select path is the SAME key and carries the SAME value-keyed rule', () => {
  // THE PIN THAT USED TO STAND HERE said the tier click "moves the SIBLING key but
  // NOT the shared one" during UNKNOWN, and was held/replayed. It PASSED, and it
  // encoded the same defect one level down: every value this path can write is a
  // LOCAL one (`localTierValue(...)`), i.e. a move WITHIN the zero-cost lane that
  // cannot put a seat on a metered rung. Holding it stranded the private lane on the
  // seats whose authority never resolves — for a write that costs nothing.
  //
  /** SABOTAGE: in `selectCommandEveLocalModelTier`, drop the
   *  `|| mayPersistSelectionWithoutAuthority(localTierValue(match.id))` disjunct.
   *  The tier click is held again during UNKNOWN. */

  /** Turn the local lane on with the answer in hand, then move to `state`. */
  function withLaneActive(state: 'unknown' | 'positive' | 'negative') {
    setAuthority('positive');
    const view = render(<ModelModalContent />);
    fireEvent.click(screen.getByTestId('command-eve-local-lane-switch'));
    expect(selectionWrites()).toEqual([localTierValue('local-standard')]);
    configSet.mockClear();
    act(() => setAuthority(state));
    view.rerender(<ModelModalContent />);
    return view;
  }

  it('UNKNOWN: picking a different bundled tier moves the SIBLING key AND the shared one — both are local', async () => {
    withLaneActive('unknown');
    fireEvent.click(screen.getByTestId('command-eve-model-tier-select-gemma-4-12b-local-planning'));

    // The sibling key has no funding meaning and is written either way — asserting
    // it proves the click really reached the handler, so the assertion below is
    // about the GATE and not about a click that never landed.
    await waitFor(() =>
      expect(configSet).toHaveBeenCalledWith('commandEve.localModelTierId', 'gemma-4-12b-local-planning')
    );
    await waitFor(() => expect(selectionWrites()).toEqual([localTierValue('local-high')]));
    expect(store.get(SELECTION_KEY)).toBe(localTierValue('local-high'));
  });

  it('and what it wrote is still a LOCAL value — the exemption can never smuggle a metered rung', async () => {
    // The rule is about the VALUE. If this path ever learns to write something that
    // is not local, the exemption it now enjoys becomes a hole, and this reds.
    withLaneActive('unknown');
    fireEvent.click(screen.getByTestId('command-eve-model-tier-select-gemma-4-12b-local-planning'));
    await waitFor(() => expect(selectionWrites().length).toBe(1));
    for (const written of selectionWrites()) {
      expect(typeof written === 'string' && written.startsWith('command-eve-local:')).toBe(true);
    }
  });

  it('ANSWERED / POSITIVE: the same tier click writes the shared key immediately', async () => {
    withLaneActive('positive');
    fireEvent.click(screen.getByTestId('command-eve-model-tier-select-gemma-4-12b-local-planning'));
    await waitFor(() => expect(selectionWrites()).toEqual([localTierValue('local-high')]));
  });

  it('ANSWERED / NEGATIVE: an authoritative NO writes too — the gate is on the ANSWER, not on YES', async () => {
    withLaneActive('negative');
    fireEvent.click(screen.getByTestId('command-eve-model-tier-select-gemma-4-12b-local-planning'));
    await waitFor(() => expect(selectionWrites()).toEqual([localTierValue('local-high')]));
  });
});
