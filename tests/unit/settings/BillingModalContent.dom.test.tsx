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

const openExternalMock = vi.fn(() => Promise.resolve());
vi.mock('@renderer/utils/platform', () => ({
  openExternalUrl: (url: string) => openExternalMock(url),
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
  it('shows the 0€-forever own-seat status on the free tier', () => {
    stubStatus('free');
    render(<BillingModalContent />);
    expect(screen.getByTestId('billing-own-seat').textContent).toContain('0 € — forever');
  });

  it('shows the paid-seat status on a paid tier', () => {
    stubStatus('starter');
    render(<BillingModalContent />);
    expect(screen.getByTestId('billing-own-seat').textContent).toContain('paid client seat');
    expect(screen.getByTestId('billing-own-seat').textContent).not.toContain('0 € — forever');
  });
});

describe('BillingModalContent — client-seat CTA + pack deep-links (Gen-B consumers)', () => {
  it('the client-seat CTA deep-links to /account?intent=add_seat', async () => {
    stubStatus('free');
    const user = userEvent.setup();
    render(<BillingModalContent />);
    await user.click(screen.getByTestId('billing-add-seat'));
    expect(openExternalMock).toHaveBeenCalledWith('https://command-eve.com/account?intent=add_seat');
  });

  it('the client-seat CTA advertises the 99€ floor', () => {
    stubStatus('free');
    render(<BillingModalContent />);
    expect(screen.getByTestId('billing-add-seat').textContent).toContain('99');
  });

  it('a credit pack deep-links to /account?pack_eur=<n>', async () => {
    stubStatus('free');
    const user = userEvent.setup();
    render(<BillingModalContent />);
    await user.click(screen.getByTestId('billing-pack-100'));
    expect(openExternalMock).toHaveBeenCalledWith('https://command-eve.com/account?pack_eur=100');
  });

  it('a credit pack shows the +20% recurring bonus badge (fires because bonus > 0)', () => {
    stubStatus('free');
    render(<BillingModalContent />);
    // 100€ pack: +20,000 bonus credits ⇒ the "+{{n}} bonus" badge renders.
    expect(screen.getByTestId('billing-pack-100').textContent).toContain('20000');
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
});
