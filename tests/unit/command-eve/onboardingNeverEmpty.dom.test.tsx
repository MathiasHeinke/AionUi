/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.6 Slice 1 — "nie wieder leer" (churn hole #4 + the waiting-banner residual
 * of churn hole #1). Pins the two load-bearing behaviors:
 *
 *  GREETING FALLBACK — a FAILED S0 read (bridge ok:false or IPC rejection) must
 *  render the claim-free fallback card instead of NOTHING. Never the ready
 *  state, never a name, never gaps. A successful read keeps today's behavior.
 *
 *  WAITING BANNER — once a conversation has visible messages (emptySlot gone),
 *  genuine first-value blockers stay visible in a slim banner; it stays quiet
 *  on empty conversations (greeting owns that surface), on ready models, and on
 *  failed reads (claim-free: never nag about a status we cannot know).
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TMessage } from '@/common/chat/chatLib';

// The greeting/banner must believe they run in the desktop app.
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

// Deterministic locale without booting the full i18n stack.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'de-DE' } }),
}));

// The S0 bridge read — each test sets the next response/rejection.
const invokeMock = vi.fn();
vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: { onboardingStatus: { invoke: (...args: unknown[]) => invokeMock(...args) } },
}));

// The banner reads the visible-message list through the MessageList context.
let messageList: Array<Partial<TMessage>> = [];
vi.mock('@renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => messageList,
}));

import OnboardingReadinessGreeting from '@renderer/pages/conversation/components/OnboardingReadinessGreeting';
import OnboardingWaitingBanner from '@renderer/pages/conversation/components/OnboardingWaitingBanner';

const okBlockedResponse = {
  data: {
    version: 'command-eve-onboarding-status/v0',
    ok: true,
    model: {
      schema_version: 'command-eve-onboarding-status/v0',
      generated_at: '2026-07-02T00:00:00.000Z',
      read_only: true,
      first_value_ready: false,
      entitlement_state: 'expired',
      cloud_bearer_available: false,
      identity: { needs_confirmation: true, confidence: 'placeholder', source: 'unverified' },
      items: [
        {
          id: 'license',
          state: 'blocked',
          plain_meaning: 'Lizenz abgelaufen.',
          remediation_kind: 'cloud-redirect',
          reason_code: 'LICENSE_EXPIRED',
        },
      ],
      warnings: [],
    },
    source: { generated_by: 'command-eve-onboarding-status-core' },
  },
};

const okReadyResponse = {
  data: {
    ...okBlockedResponse.data,
    model: {
      ...okBlockedResponse.data.model,
      first_value_ready: true,
      entitlement_state: 'entitled',
      cloud_bearer_available: true,
      items: [],
    },
  },
};

const failedCoreResponse = {
  data: {
    version: 'command-eve-onboarding-status/v0',
    ok: false,
    reason_code: 'ONBOARDING_STATUS_FAILED',
    source: { generated_by: 'command-eve-onboarding-status-core' },
  },
};

const renderInRouter = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>);

beforeEach(() => {
  invokeMock.mockReset();
  messageList = [];
});

describe('OnboardingReadinessGreeting — never empty on a failed read', () => {
  it('renders the claim-free fallback card when the core read fails (ok:false)', async () => {
    invokeMock.mockResolvedValue(failedCoreResponse);
    renderInRouter(<OnboardingReadinessGreeting />);
    const card = await screen.findByTestId('eve-onboarding-greeting');
    expect(card.getAttribute('data-degraded')).toBe('true');
    expect(card.getAttribute('data-ready')).toBe('false');
    // Claim-free: no readiness claim, no gap rows, no name.
    expect(card.textContent).not.toContain('startklar');
    expect(screen.queryAllByTestId(/eve-onboarding-greeting-gap-/)).toHaveLength(0);
    expect(card.textContent).toContain('Einrichtungs-Status');
  });

  it('renders the fallback card when the IPC call itself rejects', async () => {
    invokeMock.mockRejectedValue(new Error('bridge down'));
    renderInRouter(<OnboardingReadinessGreeting />);
    const card = await screen.findByTestId('eve-onboarding-greeting');
    expect(card.getAttribute('data-degraded')).toBe('true');
  });

  it('keeps the real greeting (no degraded marker) on a successful read', async () => {
    invokeMock.mockResolvedValue(okBlockedResponse);
    renderInRouter(<OnboardingReadinessGreeting />);
    const card = await screen.findByTestId('eve-onboarding-greeting');
    expect(card.getAttribute('data-degraded')).toBeNull();
    expect(screen.getByTestId('eve-onboarding-greeting-gap-license')).toBeTruthy();
  });
});

describe('OnboardingWaitingBanner — blockers stay visible in non-empty chats', () => {
  const visibleMessage = { id: 'm1', type: 'text', hidden: false } as Partial<TMessage>;

  it('shows the blocker with its link once the conversation has visible messages', async () => {
    invokeMock.mockResolvedValue(okBlockedResponse);
    messageList = [visibleMessage];
    renderInRouter(<OnboardingWaitingBanner />);
    const banner = await screen.findByTestId('eve-onboarding-waiting-banner');
    expect(banner.textContent).toContain('Bevor es weitergeht:');
    expect(screen.getByTestId('eve-onboarding-waiting-gap-license')).toBeTruthy();
    expect(screen.getByTestId('eve-onboarding-waiting-link-license')).toBeTruthy();
  });

  it('stays quiet on an EMPTY conversation — the emptySlot greeting owns that surface', async () => {
    invokeMock.mockResolvedValue(okBlockedResponse);
    messageList = [];
    renderInRouter(<OnboardingWaitingBanner />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId('eve-onboarding-waiting-banner')).toBeNull();
  });

  it('hidden-only messages do NOT count as visible (mirrors the emptySlot rule)', async () => {
    invokeMock.mockResolvedValue(okBlockedResponse);
    messageList = [{ id: 'h1', type: 'text', hidden: true } as Partial<TMessage>];
    renderInRouter(<OnboardingWaitingBanner />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId('eve-onboarding-waiting-banner')).toBeNull();
  });

  it('stays quiet when the user is ready', async () => {
    invokeMock.mockResolvedValue(okReadyResponse);
    messageList = [visibleMessage];
    renderInRouter(<OnboardingWaitingBanner />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId('eve-onboarding-waiting-banner')).toBeNull();
  });

  it('stays quiet on a FAILED read — never nags about an unknown status', async () => {
    invokeMock.mockResolvedValue(failedCoreResponse);
    messageList = [visibleMessage];
    renderInRouter(<OnboardingWaitingBanner />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.queryByTestId('eve-onboarding-waiting-banner')).toBeNull();
  });
});
