/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE COMPOSER SURFACE MUST DEPICT EFFECTIVE ACTIVE INFERENCE — never a stored
 * preference.
 *
 * This is a REAL-STATE test, not a prop test: it mounts the actual
 * `useEveInferenceSelection` hook over mocked config/entitlement/credits stores
 * and drives the same inputs production drives, then reads the DOM. A test that
 * fed the component fabricated props could not have caught the defect it exists
 * to prevent — the defect lived in WHICH piece of hook state the surface was
 * wired to.
 *
 * The defect, measured in the real app on a lapsed/locked persisted-MAX seat:
 *   data-engaged=true · data-active=false · aria-pressed=false · surface MAX=TRUE
 * The composer painted the full MAX treatment while the wire clamped that very
 * turn to the routine tier.
 *
 * NAMING: must end in `.dom.test.tsx` — the `node` vitest project includes only
 * `*.test.ts` and the `dom` project only `*.dom.test.ts(x)`, so a `.test.tsx`
 * file would match NEITHER and "pass" by never running.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: Map<string, unknown> = new Map();
const subscribers: Map<string, Set<(value: unknown) => void>> = new Map();

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (k: string) => store.get(k),
    set: vi.fn((k: string, v: unknown) => {
      store.set(k, v);
      for (const cb of subscribers.get(k) ?? []) cb(v);
    }),
    subscribe: (k: string, cb: (value: unknown) => void) => {
      if (!subscribers.has(k)) subscribers.set(k, new Set());
      subscribers.get(k)!.add(cb);
      return () => {
        subscribers.get(k)?.delete(cb);
      };
    },
  },
}));

const entitlement = { ok: true, state: 'entitled', trial_ends_at: null as string | null, has_paid_seat: false };
const entitlementHookState: { loading: boolean; status: typeof entitlement | null } = {
  loading: false,
  status: entitlement,
};
vi.mock('@renderer/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => ({ ...entitlementHookState, blocked: false, refresh: vi.fn() }),
}));

const creditsStatus = {
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import EveMaxToggle, { EVE_MAX_COMPOSER_ATTRIBUTE } from '@/renderer/components/agent/EveMaxToggle';
import { useEveInferenceSelection } from '@renderer/hooks/agent/useEveInferenceSelection';
import { eveTierValue, localTierValue, EVE_DEFAULT_INFERENCE_SELECTION } from '@/common/config/eveInferenceCore';

const SELECTION_KEY = 'commandEve.inferenceSelection';

/**
 * Publishes the hook's own view of what the WIRE will send, so the invariant can
 * be asserted against the surface rather than restated by the test.
 */
const WireTierProbe: React.FC = () => {
  const { effectiveWireTier, maxEngaged, maxActive } = useEveInferenceSelection();
  return (
    <span
      data-testid='wire-probe'
      data-wire-tier={effectiveWireTier ?? 'none'}
      data-engaged={maxEngaged ? 'true' : 'false'}
      data-active={maxActive ? 'true' : 'false'}
    />
  );
};

/** Mount the toggle inside a real composer surface, exactly as the send bars do. */
function renderComposer() {
  return render(
    <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
      <div className='unified-send-bar'>
        <EveMaxToggle />
        <WireTierProbe />
      </div>
    </div>
  );
}

type SeatState = {
  name: string;
  selection: string;
  /** Applied to the mocked entitlement/credits stores. */
  apply: () => void;
  expectSurfaceMax: boolean;
};

const SEAT_STATES: SeatState[] = [
  {
    name: 'selected=MAX + ENTITLED',
    selection: eveTierValue('eve-max'),
    apply: () => {
      entitlement.has_paid_seat = true;
      creditsStatus.ok = true;
    },
    expectSurfaceMax: true,
  },
  {
    name: 'selected=MAX + NOT entitled (lapsed, intent remembered)',
    selection: eveTierValue('eve-max'),
    apply: () => {
      entitlement.has_paid_seat = false;
      creditsStatus.ok = true; // authoritative: proven unentitled
    },
    expectSurfaceMax: false,
  },
  {
    name: 'selected=MAX + entitlement UNKNOWN (first boot)',
    selection: eveTierValue('eve-max'),
    apply: () => {
      entitlement.has_paid_seat = false;
      entitlementHookState.loading = true;
      entitlementHookState.status = null;
      creditsHookState.loading = true;
      creditsHookState.status = null;
    },
    expectSurfaceMax: false,
  },
  {
    name: 'selected=default (routine lane)',
    selection: EVE_DEFAULT_INFERENCE_SELECTION,
    apply: () => {
      entitlement.has_paid_seat = true;
      creditsStatus.ok = true;
    },
    expectSurfaceMax: false,
  },
  {
    name: 'selected=LOCAL (private lane)',
    selection: localTierValue('local-standard'),
    apply: () => {
      entitlement.has_paid_seat = true;
      creditsStatus.ok = true;
    },
    expectSurfaceMax: false,
  },
];

function resetStores(): void {
  store.clear();
  subscribers.clear();
  entitlement.trial_ends_at = null;
  entitlement.has_paid_seat = false;
  entitlementHookState.loading = false;
  entitlementHookState.status = entitlement;
  creditsStatus.ok = false;
  creditsStatus.tier = 'free';
  creditsStatus.purchased_credits_remaining = 0;
  creditsStatus.included_allowance_credits_remaining = 0;
  creditsStatus.has_active_topup = false;
  creditsHookState.loading = false;
  creditsHookState.status = creditsStatus;
  vi.clearAllMocks();
}

describe('composer MAX surface — the state matrix', () => {
  beforeEach(resetStores);

  it.each(SEAT_STATES.map((s) => [s.name, s] as const))('%s', async (_name, seat) => {
    store.set(SELECTION_KEY, seat.selection);
    seat.apply();

    renderComposer();
    const composer = screen.getByTestId('composer');

    await waitFor(() => {
      expect(composer.hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(seat.expectSurfaceMax);
    });
    if (seat.expectSurfaceMax) {
      expect(composer.getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');
    }
  });

  it('LAPSED SEAT: surface is NOT painted, but the pill still shows the remembered intent', async () => {
    // The half the founder explicitly wants kept: intent stays visible on the
    // control the user pressed, while the surface tells the truth about what is
    // running.
    store.set(SELECTION_KEY, eveTierValue('eve-max'));
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;

    renderComposer();
    const composer = screen.getByTestId('composer');
    const pill = screen.getByTestId('eve-max-toggle');

    await waitFor(() => expect(pill.getAttribute('data-locked')).toBe('true'));
    // Surface: silent.
    expect(composer.hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
    // Pill: the intent is still there and still readable.
    expect(pill.getAttribute('data-engaged')).toBe('true');
    expect(pill.getAttribute('data-active')).toBe('false');
    expect(pill.getAttribute('aria-pressed')).toBe('false');
    expect(pill.textContent).toContain('MAX');
  });

  it('UNKNOWN entitlement never paints, even though the selection IS MAX', async () => {
    // Unknown is not active. Painting here would reinstate the same lie for the
    // first turns after every launch.
    store.set(SELECTION_KEY, eveTierValue('eve-max'));
    entitlementHookState.loading = true;
    entitlementHookState.status = null;
    creditsHookState.loading = true;
    creditsHookState.status = null;

    renderComposer();

    const composer = screen.getByTestId('composer');
    const probe = screen.getByTestId('wire-probe');
    expect(probe.getAttribute('data-engaged')).toBe('true');
    expect(composer.hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
  });

  it('purchasing repaints the surface WITHOUT the user re-picking MAX', async () => {
    store.set(SELECTION_KEY, eveTierValue('eve-max'));
    entitlement.has_paid_seat = false;
    creditsStatus.ok = true;

    const { rerender } = renderComposer();
    const composer = screen.getByTestId('composer');
    await waitFor(() => expect(composer.hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false));

    creditsStatus.purchased_credits_remaining = 120_000;
    creditsHookState.status = { ...creditsStatus };
    rerender(
      <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
        <div className='unified-send-bar'>
          <EveMaxToggle />
          <WireTierProbe />
        </div>
      </div>
    );

    await waitFor(() => expect(composer.getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true'));
  });
});

describe('composer MAX surface — THE INVARIANT', () => {
  beforeEach(resetStores);

  /**
   * Stated as an invariant rather than as scenarios that happen to cover it:
   *
   *   surface is marked MAX  ⟺  the effective wire tier is 'max'
   *
   * Both directions matter. Left-to-right forbids the defect that was measured
   * (painted while clamping). Right-to-left forbids the opposite regression —
   * a seat genuinely running MAX with no visual state at all.
   */
  it('the surface is marked MAX if and only if the effective wire tier is max — across EVERY state', async () => {
    for (const seat of SEAT_STATES) {
      resetStores();
      store.set(SELECTION_KEY, seat.selection);
      seat.apply();

      const view = renderComposer();
      const composer = screen.getByTestId('composer');
      const probe = screen.getByTestId('wire-probe');

      await waitFor(() => expect(probe.getAttribute('data-wire-tier')).toBeTruthy());

      const surfaceIsMax = composer.hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE);
      const wireIsMax = probe.getAttribute('data-wire-tier') === 'max';

      expect(surfaceIsMax, `${seat.name}: surface/wire disagreement`).toBe(wireIsMax);

      // The specific lie, spelled out: never painted while the wire clamps to
      // the routine tier.
      if (probe.getAttribute('data-wire-tier') === 'standard') {
        expect(surfaceIsMax, `${seat.name}: painted MAX while clamping to standard`).toBe(false);
      }

      view.unmount();
    }
  });

  it('a stored MAX intent alone NEVER paints the surface — only the wire decides', async () => {
    // Every state below has data-engaged=true. Only the entitled one may paint.
    const engagedStates = SEAT_STATES.filter((s) => s.selection === eveTierValue('eve-max'));
    expect(engagedStates.length).toBeGreaterThan(1);

    for (const seat of engagedStates) {
      resetStores();
      store.set(SELECTION_KEY, seat.selection);
      seat.apply();

      const view = renderComposer();
      const probe = screen.getByTestId('wire-probe');
      const composer = screen.getByTestId('composer');

      await waitFor(() => expect(probe.getAttribute('data-engaged')).toBe('true'));
      expect(composer.hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE), seat.name).toBe(seat.expectSurfaceMax);

      view.unmount();
    }
  });
});
