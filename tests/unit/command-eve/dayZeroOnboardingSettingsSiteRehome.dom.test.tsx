/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LAST renderer seam (HOOK-LEVEL re-home) regression CI.
 *
 * useDayZeroOnboarding has TWO mount sites:
 *   (1) DayZeroOnboardingHost — keyed by the active seat id in ProtectedLayout, so
 *       a switch REMOUNTS it (covered by dayZeroOnboardingSeatRemount.dom.test).
 *   (2) CompanyBrainModalContent at /settings/company-brain — NOT wrapped by the
 *       Router remount key. Before the hook-level fix, a switch A→B while the
 *       settings page was open kept showing seat A's onboarding state for fresh
 *       seat B (alreadySeeded from a mount-once useEffect([]); dismissed from a
 *       one-shot configService.get).
 *
 * THE HOOK-LEVEL FIX (proved HERE, at the un-keyed site, WITHOUT any remount):
 * useDayZeroOnboarding now depends on useActiveSeatId — its on-disk seeded load
 * re-invokes on a seat change, and dismissed is read via useConfig so the
 * per-key re-notify reaches it. So EVERY mount site re-homes on a switch.
 *
 * This test mounts CompanyBrainModalContent with NO key (mirroring the real
 * settings route), drives a real rebind A→B, and asserts:
 *   - seeded seat A ⇒ the panel Tag reads seeded=true;
 *   - after switch to fresh seat B ⇒ the SAME (un-remounted) component re-reads
 *     B's on-disk evidence ⇒ Tag flips to seeded=false (the leak is closed
 *     WITHOUT a remount — the component instance is preserved);
 *   - the dismissed flag re-reads per seat across the switch.
 */

import React from 'react';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
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
    // T3: the panel also lists entries — inert empty stubs (this test asserts the
    // status re-read count, not the list). The list uses its own IPC, so it does
    // not perturb companyBrainStatusInvoke's call count.
    companyBrainList: { invoke: async () => ({ success: true, data: { ok: true, entries: [] } }) },
    companyBrainRead: { invoke: async () => ({ success: true, data: { ok: true, body: '' } }) },
    companyBrainWrite: { invoke: async () => ({ success: true, data: { ok: true, created: true } }) },
    companyBrainRemove: { invoke: async () => ({ success: true, data: { ok: true, removed: true } }) },
  },
}));

// A faithful tiny fake of the renderer configService: bound to ONE seat at a
// time, serves only that seat's seat-scoped value, fires the PER-KEY re-notify
// for a seat-scoped key whose value changed on the switch (so useConfig re-reads
// dismissed), then fires onSeatRebind LAST (so useActiveSeatId re-renders and the
// hook re-loads the on-disk seeded evidence). Mirrors the real rebindSeat order.
vi.mock('@/common/config/configService', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  const seatSubs = new Set<(seatId: string) => void>();
  const keySubs = new Map<string, Set<() => void>>();
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
        return dismissedBySeat[fake.boundSeatId];
      }
      return undefined;
    },
    set: vi.fn(async (key: string, value: unknown) => {
      if (key === 'commandEve.clientSeedDismissed') {
        dismissedBySeat[fake.boundSeatId] = Boolean(value);
      }
      for (const cb of keySubs.get(key) ?? []) cb();
    }),
    subscribe(key: string, cb: () => void) {
      if (!keySubs.has(key)) keySubs.set(key, new Set());
      keySubs.get(key)!.add(cb);
      return () => keySubs.get(key)?.delete(cb);
    },
    onSeatRebind(cb: (seatId: string) => void) {
      seatSubs.add(cb);
      return () => seatSubs.delete(cb);
    },
    rebindSeat: vi.fn(async (seatId: string) => {
      if (seatId === fake.boundSeatId) return; // legacy/no-op: never fires.
      const dismissedBefore = dismissedBySeat[fake.boundSeatId];
      fake.boundSeatId = seatId;
      if (dismissedBefore !== dismissedBySeat[seatId]) {
        for (const cb of keySubs.get('commandEve.clientSeedDismissed') ?? []) cb();
      }
      for (const cb of seatSubs) cb(seatId);
    }),
  };
  return { configService: fake };
});

// Keep the heavy seed modal inert — this test asserts the seeded Tag + re-home.
vi.mock('@renderer/components/billing/DayZeroOnboardingModal', () => ({
  default: () => null,
}));

// i18n: render the provided defaultValue so the Tag text is deterministic.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key }),
}));

import { configService as fakeConfigImport } from '@/common/config/configService';
import CompanyBrainModalContent from '@renderer/components/settings/SettingsModal/contents/CompanyBrainModalContent';
import { useDayZeroOnboarding } from '@renderer/hooks/useDayZeroOnboarding';

const fakeConfig = fakeConfigImport as unknown as {
  boundSeatId: string;
  dismissedBySeat: Record<string, boolean>;
  rebindSeat: (seatId: string) => Promise<void>;
};

beforeEach(() => {
  fakeConfig.boundSeatId = SEAT_A;
  seededOnDisk[SEAT_A] = true;
  seededOnDisk[SEAT_B] = false;
  fakeConfig.dismissedBySeat[SEAT_A] = false;
  fakeConfig.dismissedBySeat[SEAT_B] = false;
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

function seededTagValue(): string | null {
  const status = document.querySelector('[data-testid="company-brain-status"]');
  return status?.querySelector('[data-seeded]')?.getAttribute('data-seeded') ?? null;
}

describe('useDayZeroOnboarding re-homes at the un-keyed SETTINGS site (LAST seam)', () => {
  it('seeded seat A ⇒ Tag true; a switch to fresh seat B re-reads false WITHOUT a remount', async () => {
    // NO key on the component — exactly like the real /settings/company-brain
    // route, which the Router remount key does NOT wrap.
    await act(async () => {
      render(<CompanyBrainModalContent />);
    });
    await settle();

    // Capture the live component instance so we can later prove it was NOT
    // remounted: a remount would replace this DOM node.
    const status = await screen.findByTestId('company-brain-status');
    await waitFor(() => expect(seededTagValue()).toBe('true'));
    expect(companyBrainStatusInvoke).toHaveBeenCalledTimes(1);

    // Switch A→B: the rebind fires the seat-rebind signal, moving useActiveSeatId,
    // which re-runs the hook's on-disk load effect — at the SAME (un-keyed) mount
    // site, with NO remount.
    await act(async () => {
      await fakeConfig.rebindSeat(SEAT_B);
    });
    await settle();

    // Fresh seat B has no on-disk seed ⇒ the hook re-read flips the Tag to false.
    await waitFor(() => expect(seededTagValue()).toBe('false'));
    // The on-disk status was re-invoked under seat B's binding (hook-level re-read).
    expect(companyBrainStatusInvoke).toHaveBeenCalledTimes(2);
    // PROOF OF NO REMOUNT: the very same DOM node is still mounted (a remount
    // would have created a new element). The re-read came from the hook, not a key.
    expect(screen.getByTestId('company-brain-status')).toBe(status);
  });

  it('the dismissed flag re-reads per seat across the switch (hook-level, no remount)', async () => {
    // Seat A is NOT dismissed; fresh seat B's OWN seat-scoped dismissed IS set.
    // The hook exposes `dismissed` directly, so we mount it ONCE (no key, no
    // remount) and prove the value re-homes to seat B across the switch.
    fakeConfig.dismissedBySeat[SEAT_A] = false;
    fakeConfig.dismissedBySeat[SEAT_B] = true;

    const { result } = renderHook(() => useDayZeroOnboarding({ enabled: false }));
    await settle();
    // Seat A: dismissed=false (A's own seat-scoped flag).
    expect(result.current.dismissed).toBe(false);

    // Switch A→B WITHOUT a remount: the per-key re-notify reaches the useConfig
    // read, so `dismissed` flips to B's seat-scoped true.
    await act(async () => {
      await fakeConfig.rebindSeat(SEAT_B);
    });
    await settle();
    expect(result.current.dismissed).toBe(true);
  });
});
