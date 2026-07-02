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
// v1.6 Slice 2: the handover-note read (default: no note ⇒ system card owns
// the surface — the pre-Slice-2 behavior stays byte-identical).
const noteInvokeMock = vi.fn();
vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    onboardingStatus: { invoke: (...args: unknown[]) => invokeMock(...args) },
    startscreenNote: { invoke: (...args: unknown[]) => noteInvokeMock(...args) },
  },
}));

// Chip sends ride the real send path — mocked at the '@/common' boundary.
const sendMessageMock = vi.fn();
vi.mock('@/common', () => ({
  ipcBridge: { acpConversation: { sendMessage: { invoke: (...args: unknown[]) => sendMessageMock(...args) } } },
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
  noteInvokeMock.mockReset();
  sendMessageMock.mockReset();
  // Default: no handover note — every pre-Slice-2 expectation holds unchanged.
  noteInvokeMock.mockResolvedValue({ data: { version: 'command-eve-startscreen-note/v0', ok: true, exists: false } });
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

/**
 * v1.6 Slice 2 — "Die Hinterlassene Hand": the surface renders EVE's really
 * left-behind words verbatim, framed by the SYSTEM's mtime; her `next:` entries
 * are the only tap-chips; blockers/degraded status never get hidden behind her
 * note; and without a note everything above stays byte-identical.
 */
describe('OnboardingReadinessGreeting — handover note (Die Hinterlassene Hand)', () => {
  const NOTE_RAW = [
    '---',
    'next:',
    '  - Die zwei Entwürfe reviewen',
    '---',
    'Wir haben heute deinen Brief geschärft und die Posts skizziert.',
  ].join('\n');

  const noteResponse = (mtimeMs: number, raw = NOTE_RAW) => ({
    data: { version: 'command-eve-startscreen-note/v0', ok: true, exists: true, mtime_ms: mtimeMs, raw },
  });

  it('renders her note verbatim with the system age frame and suppresses the generic ready headline', async () => {
    invokeMock.mockResolvedValue(okReadyResponse);
    noteInvokeMock.mockResolvedValue(noteResponse(Date.now() - 60_000));
    renderInRouter(<OnboardingReadinessGreeting />);
    const note = await screen.findByTestId('eve-handover-note');
    expect(note.getAttribute('data-age-class')).toBe('today');
    expect(screen.getByTestId('eve-handover-note-body').textContent).toContain(
      'Wir haben heute deinen Brief geschärft und die Posts skizziert.'
    );
    expect(screen.getByTestId('eve-handover-note-age').textContent).toContain('geschrieben heute');
    // Her voice owns the surface: the generic system ready-headline is gone.
    expect(screen.getByTestId('eve-onboarding-greeting').textContent).not.toContain('startklar');
  });

  it('a real blocker stays visible BELOW her note (system information is never hidden)', async () => {
    invokeMock.mockResolvedValue(okBlockedResponse);
    noteInvokeMock.mockResolvedValue(noteResponse(Date.now() - 60_000));
    renderInRouter(<OnboardingReadinessGreeting />);
    await screen.findByTestId('eve-handover-note');
    expect(screen.getByTestId('eve-onboarding-greeting-gap-license')).toBeTruthy();
  });

  it('frames a 16-day-old note as a long-absence welcome (K11 return framing)', async () => {
    invokeMock.mockResolvedValue(okReadyResponse);
    noteInvokeMock.mockResolvedValue(noteResponse(Date.now() - 16 * 86_400_000));
    renderInRouter(<OnboardingReadinessGreeting />);
    const note = await screen.findByTestId('eve-handover-note');
    expect(note.getAttribute('data-age-class')).toBe('long');
    expect(screen.getByTestId('eve-handover-note-age').textContent).toContain('schön, dass du wieder da bist');
  });

  it('her next: entry is a tappable chip that sends HER suggestion into the conversation', async () => {
    invokeMock.mockResolvedValue(okReadyResponse);
    noteInvokeMock.mockResolvedValue(noteResponse(Date.now() - 60_000));
    sendMessageMock.mockResolvedValue({ success: true });
    const { ConversationProvider } = await import('@/renderer/hooks/context/ConversationContext');
    renderInRouter(
      <ConversationProvider value={{ conversation_id: 'conv-1', type: 'acp' }}>
        <OnboardingReadinessGreeting />
      </ConversationProvider>
    );
    const chip = await screen.findByTestId('eve-handover-note-next-0');
    expect(chip.textContent).toBe('Die zwei Entwürfe reviewen');
    chip.click();
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    expect(sendMessageMock.mock.calls[0][0]).toMatchObject({
      input: 'Die zwei Entwürfe reviewen',
      conversation_id: 'conv-1',
    });
  });

  it('an empty-body note renders NOTHING in her name (system card owns the surface)', async () => {
    invokeMock.mockResolvedValue(okReadyResponse);
    noteInvokeMock.mockResolvedValue(noteResponse(Date.now(), '---\nnext:\n  - Chip ohne Notiz\n---\n'));
    renderInRouter(<OnboardingReadinessGreeting />);
    const card = await screen.findByTestId('eve-onboarding-greeting');
    expect(screen.queryByTestId('eve-handover-note')).toBeNull();
    expect(card.textContent).toContain('startklar');
  });
});
