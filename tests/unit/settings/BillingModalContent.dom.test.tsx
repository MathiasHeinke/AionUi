/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BillingModalContent (Lane 3, Gen-B money surface) DOM behavior:
 *   - FREE own seat → status line "Your own seat: 0 € — forever".
 *   - PAID seat → the paid-seat status line instead.
 *   - CLIENT-SEAT CTA deep-links to /account?intent=add_seat (LIVE Gen-B consumer).
 *   - CREDIT PACKS deep-link to /account?pack_eur=<n> and show the +20% bonus badge.
 *   - NO legacy 79€ Starter / 49€ Solo "plan" copy survives.
 *
 * Mirrors the honest mini-store mock pattern from SystemModalContent.dom.test.tsx.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreditMeterModel } from '@/common/config/creditsCore';

// i18next: return the defaultValue with naive {{var}} interpolation so assertions
// match the real Gen-B copy.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown>) => {
      let s = (o?.defaultValue as string) ?? _k;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{${key}}}`, 'g'), String(val));
        }
      }
      return s;
    },
  }),
}));

// APP→WEB AUTH HANDOFF: the billing CTAs now open via openAccountWeb (MAIN attaches
// the desktop session so the browser lands logged in). We assert the RELATIVE path
// it is called with (the origin + session are pinned/attached inside openAccountWeb).
const openAccountWebMock = vi.fn(() => Promise.resolve());
vi.mock('@renderer/utils/platform', () => ({
  openAccountWeb: (path: string) => openAccountWebMock(path),
  openExternalUrl: vi.fn(() => Promise.resolve()),
}));

// Honest mini-store mock (the SystemModalContent pattern): get serves a backing map.
const { configGetMock, configSetMock } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    configGetMock: vi.fn((key: string) => store.get(key)),
    configSetMock: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
});
vi.mock('@/common/config/configService', () => ({
  configService: { get: configGetMock, set: configSetMock },
}));

// useCreditsStatus is stubbed per-test to drive the seat tier + meter.
const useCreditsStatusMock = vi.fn();
vi.mock('@renderer/hooks/useCreditsStatus', () => ({
  useCreditsStatus: () => useCreditsStatusMock(),
}));

// v1.5 A3: the consumption card hooks. Default stubs keep the card in its quiet
// resting state (no usage rows) unless a test overrides them; a fail-closed
// delegate access keeps the founder-summary path off by default.
const useSeatUsageMock = vi.fn(() => ({
  loading: false,
  month: '2026-07',
  usage: null,
  available: false,
  setMonth: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@renderer/hooks/useSeatUsage', () => ({
  useSeatUsage: () => useSeatUsageMock(),
}));
const useSeatAccessMock = vi.fn(() => ({
  loading: false,
  access: { role: 'delegate', canSwitch: false, pinnedSeatId: 'seat-1', activeSeatId: 'seat-1', seats: [] },
  switching: false,
  lastSwitchError: null,
  switchErrorNonce: 0,
  refresh: vi.fn(),
  switchTo: vi.fn(),
}));
vi.mock('@renderer/hooks/useSeatAccess', () => ({
  useSeatAccess: () => useSeatAccessMock(),
}));
// isLegacySeatId is a pure helper the card imports; provide the real logic.
vi.mock('@process/commandEve/seatSwitchCore', () => ({
  isLegacySeatId: (id?: string | null) => id == null || id === '' || id === 'default' || id === 'seat-1',
}));

import BillingModalContent from '@/renderer/components/settings/SettingsModal/contents/BillingModalContent';

function meterFor(tier: CreditMeterModel['tier']): CreditMeterModel {
  return {
    tier,
    isFree: tier === 'free',
    allowanceRemaining: 30_000,
    purchasedRemaining: 0,
    totalRemaining: 30_000,
    allowanceUsedFraction: 0.5,
    freeActionsUsed: 3,
    freeCap: 40,
    spendCapEurCents: 0,
  };
}

function stubStatus(tier: CreditMeterModel['tier']): void {
  useCreditsStatusMock.mockReturnValue({
    loading: false,
    status: { ok: true, spend_cap_eur_cents: 0 },
    meter: meterFor(tier),
    refresh: vi.fn(),
    setSpendCap: vi.fn(() => Promise.resolve(true)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('BillingModalContent — Gen-B seat status', () => {
  // THESE TWO USED TO ASSERT THE SEAT LADDER: "0 € — forever" for your own seat and
  // "paid client seat" for a paid one. The Founder ruling 1.820.1 removes paid seats
  // entirely — there is ONE subscription and every seat is included — so the status row
  // now reports which side of that single decision the user is on.
  it('a non-subscriber is told Standard is not active and what it costs', () => {
    stubStatus('free');
    render(<BillingModalContent />);
    const text = screen.getByTestId('billing-plan-status').textContent ?? '';
    expect(text).toContain('No active subscription');
    expect(text).toContain('99');
  });

  it('a subscriber is told Standard is active, with the included credits and seats', () => {
    stubStatus('starter');
    render(<BillingModalContent />);
    const text = screen.getByTestId('billing-plan-status').textContent ?? '';
    expect(text).toContain('Standard is active');
    expect(text).toContain('99');
    expect(text).toContain('all seats included');
    expect(text).not.toContain('client seat');
  });

  it('the trial is stated as ending on a DECISION, never on an automatic charge', () => {
    stubStatus('trial');
    render(<BillingModalContent />);
    const text = screen.getByTestId('billing-plan-status').textContent ?? '';
    expect(text).toContain('Trial');
    expect(text).toContain('14');
    expect(text).toContain('nothing is charged automatically');
  });
});

describe('BillingModalContent — client-seat CTA + pack deep-links (Gen-B consumers)', () => {
  it('the client-seat CTA deep-links to /account?intent=add_seat', async () => {
    stubStatus('free');
    const user = userEvent.setup();
    render(<BillingModalContent />);
    await user.click(screen.getByTestId('billing-add-seat'));
    expect(openAccountWebMock).toHaveBeenCalledWith('/account?intent=add_seat');
  });

  // WAS: 'the client-seat CTA advertises the 99€ floor'. There is no seat floor any
  // more — a seat costs 0 € and is included in Standard. A "99" on this button would
  // now be a per-seat price, which is exactly the retired contract.
  it('the add-seat CTA says a seat costs nothing and is included in Standard', () => {
    stubStatus('free');
    render(<BillingModalContent />);
    const text = screen.getByTestId('billing-add-seat').textContent ?? '';
    expect(text).toContain('0 €');
    expect(text).toContain('included in Standard');
    expect(text).not.toContain('99');
  });

  it('a credit pack deep-links to /account?pack_eur=<n>', async () => {
    stubStatus('free');
    const user = userEvent.setup();
    render(<BillingModalContent />);
    await user.click(screen.getByTestId('billing-pack-100'));
    expect(openAccountWebMock).toHaveBeenCalledWith('/account?pack_eur=100');
  });

  // WAS: 'a credit pack shows the +20% recurring bonus badge'. Top-ups are FACE VALUE
  // under the ruling (1 € = 1,000 credits), so a 100 € pack grants exactly 100,000 —
  // no bonus badge, and a bonus quantity here would advertise credits nothing grants.
  it('a credit pack shows FACE-VALUE credits and no bonus badge', () => {
    stubStatus('free');
    render(<BillingModalContent />);
    const text = screen.getByTestId('billing-pack-100').textContent ?? '';
    expect(text).toContain('100.000');
    expect(text).not.toContain('20000');
    expect(text.toLowerCase()).not.toContain('bonus');
  });
});

describe('BillingModalContent — no legacy plan copy survives (Gen-B)', () => {
  it('renders no 79€ Starter / 49€ Solo / trial "plan" surfaces', () => {
    stubStatus('free');
    render(<BillingModalContent />);
    expect(screen.queryByTestId('billing-plan-starter')).toBeNull();
    expect(screen.queryByTestId('billing-plan-solo')).toBeNull();
    expect(screen.queryByTestId('billing-trial-entry')).toBeNull();
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('79€');
    expect(body).not.toContain('49€');
  });

  // 1.820.1 — the retired contract must not reappear on this surface either. This is
  // the mixed-state guard: it fires even when the correct new 99 €/month copy IS
  // present, because a page showing both advertises two contradictory contracts.
  it('renders no retired price or retired seat/bundle/Team/MAX-plan framing', () => {
    for (const tier of ['free', 'trial', 'starter'] as const) {
      cleanup();
      stubStatus(tier);
      render(<BillingModalContent />);
      const body = document.body.textContent ?? '';
      for (const retired of ['129', '149', '249', '599', '792', '990']) {
        expect(body).not.toContain(retired);
      }
      for (const framing of [
        /\d+\s?€\s?(?:\/|pro |per )\s?(?:Kunden-?)?[Ss]eat/,
        /10er-Bundle/i,
        /Team-(?:Plan|Paket|Tarif)/i,
        /\bMAX[- ](?:Plan|Abo|Tarif|subscription)\b/i,
      ]) {
        expect(body).not.toMatch(framing);
      }
    }
  });
});

describe('BillingModalContent — A3 per-seat usage card (v1.5)', () => {
  it('version-skew resting state: no server data ⇒ the honest "ab dem nächsten Server-Update" note', () => {
    stubStatus('free');
    useSeatUsageMock.mockReturnValueOnce({
      loading: false,
      month: '2026-07',
      usage: null,
      available: false,
      setMonth: vi.fn(),
      refresh: vi.fn(),
    });
    render(<BillingModalContent />);
    expect(screen.getByTestId('billing-usage')).toBeTruthy();
    expect(screen.getByTestId('billing-usage-empty').textContent).toContain('nächsten Server-Update');
  });

  it('founder summary: an admin on the legacy seat sees a joined row per seat, labels from the my-seats wire', () => {
    stubStatus('starter');
    useSeatAccessMock.mockReturnValueOnce({
      loading: false,
      access: {
        role: 'admin',
        canSwitch: true,
        pinnedSeatId: 'seat-1',
        activeSeatId: 'seat-1',
        seats: [
          { seat_id: 'seat-1', name: 'Founder', kind: 'own_company', role: 'admin', is_active: true },
          { seat_id: 'uuid-a', name: 'Klinik Salem', kind: 'client', role: 'admin', is_active: false },
        ],
      },
      switching: false,
      lastSwitchError: null,
      switchErrorNonce: 0,
      refresh: vi.fn(),
      switchTo: vi.fn(),
    });
    useSeatUsageMock.mockReturnValueOnce({
      loading: false,
      month: '2026-07',
      available: true,
      usage: {
        version: 'command-eve-seat-usage/v0',
        ok: true,
        month: '2026-07',
        seats: [
          {
            seat_id: 'seat-1',
            calls: 10,
            ok_calls: 10,
            prompt_tokens: 0,
            completion_tokens: 0,
            retail_eur_cents: 1000,
            raw_eur_cents: 200,
            credits: 100,
          },
          {
            seat_id: 'uuid-a',
            calls: 4,
            ok_calls: 4,
            prompt_tokens: 0,
            completion_tokens: 0,
            retail_eur_cents: 500,
            raw_eur_cents: 100,
            credits: 50,
          },
        ],
        total: {
          calls: 14,
          ok_calls: 14,
          prompt_tokens: 0,
          completion_tokens: 0,
          retail_eur_cents: 1500,
          raw_eur_cents: 300,
          credits: 150,
        },
      },
      setMonth: vi.fn(),
      refresh: vi.fn(),
    });
    render(<BillingModalContent />);
    // Both seats' rows render, labels joined from the wire (never from the server).
    expect(screen.getByTestId('billing-usage-row-seat-1').textContent).toContain('Founder');
    expect(screen.getByTestId('billing-usage-row-uuid-a').textContent).toContain('Klinik Salem');
  });

  it('client-seat scope: a delegate on a client seat sees ONLY its own row (no sibling seats leak)', () => {
    stubStatus('starter');
    useSeatAccessMock.mockReturnValueOnce({
      loading: false,
      access: {
        role: 'delegate',
        canSwitch: false,
        pinnedSeatId: 'uuid-a',
        activeSeatId: 'uuid-a',
        seats: [{ seat_id: 'uuid-a', name: 'Klinik Salem', kind: 'client', role: 'delegate', is_active: true }],
      },
      switching: false,
      lastSwitchError: null,
      switchErrorNonce: 0,
      refresh: vi.fn(),
      switchTo: vi.fn(),
    });
    useSeatUsageMock.mockReturnValueOnce({
      loading: false,
      month: '2026-07',
      available: true,
      usage: {
        version: 'command-eve-seat-usage/v0',
        ok: true,
        month: '2026-07',
        seats: [
          {
            seat_id: 'seat-1',
            calls: 10,
            ok_calls: 10,
            prompt_tokens: 0,
            completion_tokens: 0,
            retail_eur_cents: 1000,
            raw_eur_cents: 200,
            credits: 100,
          },
          {
            seat_id: 'uuid-a',
            calls: 4,
            ok_calls: 4,
            prompt_tokens: 0,
            completion_tokens: 0,
            retail_eur_cents: 500,
            raw_eur_cents: 100,
            credits: 50,
          },
        ],
        total: {
          calls: 14,
          ok_calls: 14,
          prompt_tokens: 0,
          completion_tokens: 0,
          retail_eur_cents: 1500,
          raw_eur_cents: 300,
          credits: 150,
        },
      },
      setMonth: vi.fn(),
      refresh: vi.fn(),
    });
    render(<BillingModalContent />);
    // Only the active client seat's row — the founder/sibling row is NOT rendered.
    expect(screen.getByTestId('billing-usage-row-uuid-a')).toBeTruthy();
    expect(screen.queryByTestId('billing-usage-row-seat-1')).toBeNull();
  });
});
