/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MEDIUM (renderer seat-scoped mount-once state survives a switch) regression CI.
 *
 * useDayZeroOnboarding seeds TWO seat-scoped values in a MOUNT-ONCE useEffect([])
 * and never subscribes to configService:
 *   (1) alreadySeeded — from commandEve.companyBrainStatus (per-seat on-disk seed
 *       evidence under the active seat's hermesHome);
 *   (2) dismissed — read DIRECTLY from configService.get('commandEve.clientSeed
 *       Dismissed') (a SEAT_SCOPED key, so the rebind re-notify never reaches it).
 * Its host DayZeroOnboardingHost was mounted with NO seat-derived key, so it
 * stayed mounted across a switch and never re-read — seat A's onboarding state
 * leaked into a fresh seat B (the Day-0 prompt was wrongly suppressed for B).
 *
 * THE GENERAL FIX (proved here): the host is keyed by the active seat id at its
 * mount site (ProtectedLayout), driven by configService's seat-rebind signal via
 * useActiveSeatId. A switch A→B REMOUNTS the host, so every mount-once seat read
 * re-fires under seat B. This test mirrors ProtectedLayout's keying and drives a
 * real switch, asserting:
 *   - seeded seat A ⇒ onboarding hidden (alreadySeeded=true, shouldForce=false);
 *   - after switch to fresh seat B ⇒ alreadySeeded re-reads B's on-disk evidence
 *     (=false), the Day-0 prompt is NOT suppressed (shouldForce=true);
 *   - the dismissed flag re-reads per seat (B's seat-scoped dismissed, not A's).
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SEAT_A = '11111111-1111-1111-1111-111111111111';
const SEAT_B = '22222222-2222-2222-2222-222222222222';

// Per-seat on-disk seed evidence (what companyBrainStatus reads under the active
// seat's hermesHome). Seat A is seeded; fresh seat B is not.
const seededOnDisk: Record<string, boolean> = { [SEAT_A]: true, [SEAT_B]: false };

const companyBrainStatusInvoke = vi.fn();
const companyBrainSeedInvoke = vi.fn();

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    companyBrainStatus: { invoke: () => companyBrainStatusInvoke() },
    companyBrainSeed: { invoke: (req: unknown) => companyBrainSeedInvoke(req) },
  },
}));

// A faithful tiny fake of the renderer configService: bound to ONE seat at a
// time, serves only that seat's seat-scoped value, and fires onSeatRebind after
// a rebind moves the binding (mirrors the real rebindSeat seat-rebind signal).
vi.mock('@/common/config/configService', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const seatSubs = new Set<(seatId: string) => void>();
  // Per-key config subscribers (mirrors configService.subscribe), so useConfig's
  // useSyncExternalStore re-reads when rebindSeat re-notifies a changed key.
  const keySubs = new Map<string, Set<() => void>>();
  // Per-seat dismissed flag (the SEAT_SCOPED config key, namespaced per seat).
  // Declared INSIDE the hoisted factory so it has no top-level capture; tests
  // mutate it through the exposed `dismissedBySeat` handle on the fake.
  const dismissedBySeat: Record<string, boolean> = { [A]: false, [B]: false };
  const fake = {
    boundSeatId: A,
    dismissedBySeat,
    whenReady: vi.fn(async () => {}),
    getCurrentSeatId() {
      return fake.boundSeatId;
    },
    get(key: string) {
      if (key === 'commandEve.clientSeedDismissed') {
        // Serve ONLY the currently-bound seat's value.
        return dismissedBySeat[fake.boundSeatId];
      }
      return undefined;
    },
    set: vi.fn(async () => {}),
    subscribe(key: string, cb: () => void) {
      if (!keySubs.has(key)) keySubs.set(key, new Set());
      keySubs.get(key)!.add(cb);
      return () => keySubs.get(key)?.delete(cb);
    },
    onSeatRebind(cb: (seatId: string) => void) {
      seatSubs.add(cb);
      return () => seatSubs.delete(cb);
    },
    // Test-only: simulate the switch lifecycle re-homing the renderer cache and
    // firing BOTH the per-key re-notify (real rebindSeat notifies seat-scoped
    // keys whose value changed) AND the seat-rebind signal LAST.
    rebindSeat: vi.fn(async (seatId: string) => {
      if (seatId === fake.boundSeatId) return; // legacy/no-op: never fires.
      const dismissedBefore = dismissedBySeat[fake.boundSeatId];
      fake.boundSeatId = seatId;
      // Per-key re-notify: the dismissed flag may differ under the new seat.
      if (dismissedBefore !== dismissedBySeat[seatId]) {
        for (const cb of keySubs.get('commandEve.clientSeedDismissed') ?? []) cb();
      }
      for (const cb of seatSubs) cb(seatId);
    }),
  };
  return { configService: fake };
});

import { configService as fakeConfigImport } from '@/common/config/configService';
import DayZeroOnboardingHost from '@renderer/components/billing/DayZeroOnboardingHost';
import { useActiveSeatId } from '@renderer/hooks/useActiveSeatId';

const fakeConfig = fakeConfigImport as unknown as {
  boundSeatId: string;
  dismissedBySeat: Record<string, boolean>;
  rebindSeat: (seatId: string) => Promise<void>;
};

// Mirror ProtectedLayout: the host is keyed by the active seat id, so a switch
// REMOUNTS it. The host renders the modal ONLY when it decides to force the Day-0
// prompt (shouldForce), else it returns null. We surface that decision in the DOM
// via a marker the mocked modal renders, so the CURRENT committed decision is
// queryable (a null-returning host leaves no marker — no stale signal).
vi.mock('@renderer/components/billing/DayZeroOnboardingModal', () => ({
  default: (props: { open: boolean }) => (props.open ? <div data-testid='day0-prompt' /> : null),
}));

function Harness() {
  const activeSeatId = useActiveSeatId();
  return <DayZeroOnboardingHost key={activeSeatId} entitled />;
}

beforeEach(() => {
  fakeConfig.boundSeatId = SEAT_A;
  seededOnDisk[SEAT_A] = true;
  seededOnDisk[SEAT_B] = false;
  fakeConfig.dismissedBySeat[SEAT_A] = false;
  fakeConfig.dismissedBySeat[SEAT_B] = false;
  // companyBrainStatus reflects the CURRENTLY-bound seat's on-disk evidence.
  companyBrainStatusInvoke.mockReset().mockImplementation(async () => ({
    success: true,
    data: { seeded: seededOnDisk[fakeConfig.boundSeatId] },
  }));
  companyBrainSeedInvoke.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// True iff the host CURRENTLY commits the Day-0 prompt (the marker is in the DOM).
// A null-returning host (shouldForce=false) leaves no marker — no stale signal.
function promptShownNow(): boolean {
  return document.querySelector('[data-testid="day0-prompt"]') !== null;
}

describe('Day-0 onboarding re-reads per seat on a switch (MEDIUM regression)', () => {
  it('seeded seat A suppresses the prompt; a switch to fresh seat B un-suppresses it', async () => {
    await act(async () => {
      render(<Harness />);
    });
    await settle();

    // Seat A is seeded ⇒ alreadySeeded=true ⇒ shouldForce=false ⇒ prompt hidden.
    expect(promptShownNow()).toBe(false);

    // Switch A→B: the lifecycle rebinds the renderer cache + fires seat-rebind,
    // which moves useActiveSeatId, which REMOUNTS the host under seat B.
    await act(async () => {
      await fakeConfig.rebindSeat(SEAT_B);
    });
    await settle();

    // Seat B is FRESH (no on-disk seed) ⇒ alreadySeeded re-reads false ⇒ the
    // Day-0 prompt is NOT suppressed for B (the leak is closed).
    expect(promptShownNow()).toBe(true);
    // And the per-seat status was re-read under seat B's binding.
    expect(companyBrainStatusInvoke).toHaveBeenCalledTimes(2);
  });

  it('the dismissed flag re-reads per seat across a switch', async () => {
    // Seat A is seeded AND dismissed; seat B is fresh but its OWN dismissed flag
    // is set ⇒ even though B is unseeded, B's seat-scoped dismissed suppresses it.
    seededOnDisk[SEAT_A] = true;
    fakeConfig.dismissedBySeat[SEAT_B] = true;

    await act(async () => {
      render(<Harness />);
    });
    await settle();
    expect(promptShownNow()).toBe(false); // A: seeded.

    await act(async () => {
      await fakeConfig.rebindSeat(SEAT_B);
    });
    await settle();

    // B is unseeded but B's OWN dismissed=true ⇒ still suppressed. This proves the
    // dismissed read re-homed to seat B (it did NOT serve seat A's dismissed=false,
    // which would have shown the prompt). Restore for other tests.
    expect(promptShownNow()).toBe(false);
    fakeConfig.dismissedBySeat[SEAT_B] = false;
  });

  it('a single-seat/legacy install never remounts (the active seat id is stable)', async () => {
    await act(async () => {
      render(<Harness />);
    });
    await settle();
    const callsAfterMount = companyBrainStatusInvoke.mock.calls.length;

    // A no-op rebind to the SAME seat must not fire the seat-rebind signal, so the
    // host does not remount and the mount-once status read does NOT re-fire.
    await act(async () => {
      await fakeConfig.rebindSeat(SEAT_A);
    });
    await settle();
    expect(companyBrainStatusInvoke.mock.calls.length).toBe(callsAfterMount);
  });
});
