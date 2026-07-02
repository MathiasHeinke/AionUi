/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * INTEGRATION leak check (Phase 4 / ISO-3): the CompanyBrainModalContent panel
 * reads its "seeded ✓ / noch nicht geseedet" Tag from the per-seat ON-DISK seed
 * evidence (commandEve.companyBrainStatus → company-brain/seed.json under the
 * active seat's hermesHome). After seat A seeds, seat B must render
 * `data-seeded="false"` — proving the Company-Brain "seeded" truth is per-seat,
 * not a shared install flag.
 *
 * The companyBrainStatus bridge is mocked with a SEAT-AWARE backing store keyed
 * by the active seat (exactly like the real per-seat hermesHome write), so this
 * test exercises the renderer wiring (useDayZeroOnboarding → the Tag) end-to-end
 * without the backend.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Seat-aware backing store: which seats have an on-disk seed.
const seededSeats: Set<string> = new Set();
let activeSeat = 'seat-1';

// Dismiss flag lives in the (seat-scoped) config bag; keep a tiny seat-aware mock.
const configStore: Map<string, unknown> = new Map();
const keySubs: Map<string, Set<() => void>> = new Map();
vi.mock('@/common/config/configService', () => {
  const physical = (k: string) => `${activeSeat}::${k}`;
  return {
    configService: {
      whenReady: () => Promise.resolve(),
      // This test never switches seats while a hook is mounted, so the active
      // seat id is stable per render and no rebind ever fires.
      getCurrentSeatId: () => activeSeat,
      onSeatRebind: () => () => {},
      subscribe: (key: string, cb: () => void) => {
        if (!keySubs.has(key)) keySubs.set(key, new Set());
        keySubs.get(key)!.add(cb);
        return () => keySubs.get(key)?.delete(cb);
      },
      get: (k: string) => configStore.get(physical(k)),
      set: vi.fn(async (k: string, v: unknown) => {
        configStore.set(physical(k), v);
        for (const cb of keySubs.get(k) ?? []) cb();
      }),
    },
  };
});

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    companyBrainStatus: {
      invoke: vi.fn(async () => ({
        success: true,
        data: { seeded: seededSeats.has(activeSeat), record: null },
      })),
    },
    companyBrainSeed: {
      invoke: vi.fn(async (req: { seed: { value: string } }) => {
        seededSeats.add(activeSeat);
        return { success: true, data: { ok: true } };
      }),
    },
    // T3: the panel now also lists entries — this test only asserts the seeded Tag,
    // so the list stays empty and read/write/remove are inert stubs.
    companyBrainList: { invoke: vi.fn(async () => ({ success: true, data: { ok: true, entries: [] } })) },
    companyBrainRead: { invoke: vi.fn(async () => ({ success: true, data: { ok: true, body: '' } })) },
    companyBrainWrite: { invoke: vi.fn(async () => ({ success: true, data: { ok: true, created: true } })) },
    companyBrainRemove: { invoke: vi.fn(async () => ({ success: true, data: { ok: true, removed: true } })) },
  },
}));

// Keep the heavy DayZeroOnboardingModal inert — this test only asserts the seeded Tag.
vi.mock('@renderer/components/billing/DayZeroOnboardingModal', () => ({
  default: () => null,
}));

// i18n: render the provided defaultValue so the Tag text is deterministic.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key }),
}));

import CompanyBrainModalContent from '@renderer/components/settings/SettingsModal/contents/CompanyBrainModalContent';

describe('CompanyBrainModalContent — per-seat seeded flag (ISO-3 leak guard)', () => {
  beforeEach(() => {
    seededSeats.clear();
    configStore.clear();
    activeSeat = 'seat-1';
    vi.clearAllMocks();
  });

  it('seat B reads seeded=false even after seat A seeded', async () => {
    // Seat A seeds (its hermesHome gets the on-disk evidence).
    seededSeats.add('a1b2c3d4-e5f6-4789-aabb-ccddeeff0011');

    // Now the active seat is seat B — render the panel.
    activeSeat = 'ffeeddcc-bbaa-4321-9988-776655443322';
    render(<CompanyBrainModalContent />);

    const status = await screen.findByTestId('company-brain-status');
    await waitFor(() => {
      const tag = status.querySelector('[data-seeded]');
      expect(tag?.getAttribute('data-seeded')).toBe('false');
    });
  });

  it('the seat that seeded reads seeded=true', async () => {
    activeSeat = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
    seededSeats.add(activeSeat);
    render(<CompanyBrainModalContent />);
    const status = await screen.findByTestId('company-brain-status');
    await waitFor(() => {
      const tag = status.querySelector('[data-seeded]');
      expect(tag?.getAttribute('data-seeded')).toBe('true');
    });
  });
});
