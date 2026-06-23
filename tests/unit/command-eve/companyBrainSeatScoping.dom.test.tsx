/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * INTEGRATION leak check (Phase 4 / ISO-2): the CompanyBrainModalContent panel
 * reads its "seeded ✓ / noch nicht geseedet" Tag from the per-seat config flag.
 * After seat A seeds, seat B must render `data-seeded="false"` — proving the
 * Company-Brain "seeded" truth is per-seat, not a shared install flag.
 *
 * The configService is mocked with a SEAT-AWARE backing store (it returns
 * different values per active seat exactly like the real per-seat namespace),
 * so this test exercises the renderer wiring (useDayZeroOnboarding → the Tag)
 * end-to-end without the backend.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Seat-aware backing store keyed by `${seatId}::${key}` for the seat-scoped flag.
const store: Map<string, unknown> = new Map();
let activeSeat = 'seat-1';

vi.mock('@/common/config/configService', () => {
  const SEAT_SCOPED = new Set(['commandEve.clientSeeded', 'commandEve.clientSeedDismissed']);
  const physical = (k: string) => (SEAT_SCOPED.has(k) ? `${activeSeat}::${k}` : k);
  return {
    configService: {
      whenReady: () => Promise.resolve(),
      get: (k: string) => store.get(physical(k)),
      set: vi.fn(async (k: string, v: unknown) => {
        store.set(physical(k), v);
      }),
    },
  };
});

// Keep the heavy DayZeroOnboardingModal inert — this test only asserts the seeded Tag.
vi.mock('@renderer/components/billing/DayZeroOnboardingModal', () => ({
  default: () => null,
}));

// i18n: render the provided defaultValue so the Tag text is deterministic.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key }),
}));

import CompanyBrainModalContent from '@renderer/components/settings/SettingsModal/contents/CompanyBrainModalContent';

describe('CompanyBrainModalContent — per-seat seeded flag (ISO-2 leak guard)', () => {
  beforeEach(() => {
    store.clear();
    activeSeat = 'seat-1';
    vi.clearAllMocks();
  });

  it('seat B reads seeded=false even after seat A seeded', async () => {
    // Seat A seeds (write under seat A's namespace).
    activeSeat = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
    store.set(`${activeSeat}::commandEve.clientSeeded`, true);

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
    store.set(`${activeSeat}::commandEve.clientSeeded`, true);
    render(<CompanyBrainModalContent />);
    const status = await screen.findByTestId('company-brain-status');
    await waitFor(() => {
      const tag = status.querySelector('[data-seeded]');
      expect(tag?.getAttribute('data-seeded')).toBe('true');
    });
  });
});
