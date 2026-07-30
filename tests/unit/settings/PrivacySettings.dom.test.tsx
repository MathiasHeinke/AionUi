/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The component resolves `bridge.buildProvider(...).invoke` at module load, so
// the mock must hand back an object exposing `invoke` for every channel.
const {
  getConsentMock,
  setConsentMock,
  getTtsConsentMock,
  setTtsConsentMock,
  visualPolicyReadMock,
  visualPolicySetMock,
  isDesktopMock,
  currentSeatId,
  seatRebindListeners,
} = vi.hoisted(() => ({
  getConsentMock: vi.fn(),
  setConsentMock: vi.fn(),
  getTtsConsentMock: vi.fn(),
  setTtsConsentMock: vi.fn(),
  visualPolicyReadMock: vi.fn(),
  visualPolicySetMock: vi.fn(),
  isDesktopMock: vi.fn(),
  currentSeatId: { current: 'owner' },
  seatRebindListeners: new Set<(seatId: string) => void>(),
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn((channel: string) => ({
      invoke:
        channel === 'command-eve.telemetry-consent-set'
          ? setConsentMock
          : channel === 'command-eve.multimodal-tts-consent-get'
            ? getTtsConsentMock
            : channel === 'command-eve.multimodal-tts-consent-set'
              ? setTtsConsentMock
              : getConsentMock,
    })),
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      cloudVisualPolicyRead: { invoke: visualPolicyReadMock },
      cloudVisualPolicySet: { invoke: visualPolicySetMock },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    getCurrentSeatId: () => currentSeatId.current,
    onSeatRebind: (listener: (seatId: string) => void) => {
      seatRebindListeners.add(listener);
      return () => seatRebindListeners.delete(listener);
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => isDesktopMock(),
}));

vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid='settings-page-wrapper'>{children}</div>,
}));

vi.mock('@/renderer/components/settings/PreferenceRow', () => ({
  default: ({
    label,
    description,
    children,
    testId = 'preference-row',
  }: {
    label: string;
    description?: React.ReactNode;
    children: React.ReactNode;
    testId?: string;
  }) => (
    <div data-testid={testId}>
      <span data-testid='preference-label'>{label}</span>
      {description ? <span data-testid='preference-description'>{description}</span> : null}
      {children}
    </div>
  ),
}));

vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'page',
}));

import PrivacySettings from '@/renderer/pages/settings/PrivacySettings';

function enabledPolicy(seatId = currentSeatId.current) {
  return {
    status: 'enabled' as const,
    reason: 'enabled_by_product_default' as const,
    seatId,
    physicalKey: `seat:${seatId}:commandEve.cloudVisualAnalysisEnabled`,
  };
}

function disabledPolicy(seatId = currentSeatId.current) {
  return {
    status: 'disabled' as const,
    reason: 'disabled_by_operator' as const,
    seatId,
    physicalKey: `seat:${seatId}:commandEve.cloudVisualAnalysisEnabled`,
  };
}

function switchSeat(seatId: string) {
  currentSeatId.current = seatId;
  seatRebindListeners.forEach((listener) => listener(seatId));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('PrivacySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSeatId.current = 'owner';
    seatRebindListeners.clear();
    getConsentMock.mockResolvedValue({ consent: false });
    setConsentMock.mockResolvedValue({ consent: true });
    getTtsConsentMock.mockResolvedValue({
      success: true,
      data: { consent: false, privacyLane: 'cloud_auto', persisted: true },
    });
    setTtsConsentMock.mockResolvedValue({
      success: true,
      data: { consent: true, privacyLane: 'cloud_us', persisted: true },
    });
    visualPolicyReadMock.mockResolvedValue({ success: true, data: enabledPolicy() });
    visualPolicySetMock.mockImplementation(({ enabled }: { enabled: boolean }) =>
      Promise.resolve({
        success: true,
        data: { ok: true, policy: enabled ? enabledPolicy() : disabledPolicy() },
      })
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the telemetry opt-in toggle on desktop, off by default', async () => {
    isDesktopMock.mockReturnValue(true);
    render(<PrivacySettings />);

    // The toggle (Switch) renders inside the preference row.
    const rows = await screen.findAllByTestId('preference-row');
    const row = rows[0];
    expect(row).toBeInTheDocument();
    expect(screen.getByText('Send anonymous crash reports')).toBeInTheDocument();
    expect(screen.getByText('Allow cloud voice output')).toBeInTheDocument();

    const toggle = row.querySelector('button[role="switch"]');
    expect(toggle).toBeTruthy();

    // Consent is read from the bridge and reflected as OFF.
    await waitFor(() => expect(getConsentMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getTtsConsentMock).toHaveBeenCalledTimes(1));
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('persists cloud voice consent through the main-owned bridge', async () => {
    const user = userEvent.setup();
    isDesktopMock.mockReturnValue(true);
    render(<PrivacySettings />);

    const label = await screen.findByText('Allow cloud voice output');
    const row = label.closest('[data-testid="preference-row"]');
    expect(row).not.toBeNull();
    const toggle = (row as HTMLElement).querySelector('button[role="switch"]');
    expect(toggle).toBeTruthy();

    await user.click(toggle as HTMLElement);

    await waitFor(() => {
      expect(setTtsConsentMock).toHaveBeenCalledWith({ consent: true, privacyLane: 'cloud_us' });
    });
  });

  it('shows the healthy absent-key policy as on and disables it through Main', async () => {
    const user = userEvent.setup();
    isDesktopMock.mockReturnValue(true);
    render(<PrivacySettings />);

    const row = await screen.findByTestId('visual-policy-row');
    const toggle = row.querySelector('button[role="switch"]');
    await waitFor(() => expect(toggle?.getAttribute('aria-checked')).toBe('true'));

    await user.click(toggle as HTMLElement);
    await waitFor(() => expect(visualPolicySetMock).toHaveBeenCalledWith({ expectedSeatId: 'owner', enabled: false }));
    await waitFor(() => expect(toggle?.getAttribute('aria-checked')).toBe('false'));
  });

  it('shows exact false as off and restores the product default through Main', async () => {
    const user = userEvent.setup();
    isDesktopMock.mockReturnValue(true);
    visualPolicyReadMock.mockResolvedValue({ success: true, data: disabledPolicy() });
    render(<PrivacySettings />);

    const row = await screen.findByTestId('visual-policy-row');
    const toggle = row.querySelector('button[role="switch"]');
    await waitFor(() => expect(toggle?.getAttribute('aria-checked')).toBe('false'));

    await user.click(toggle as HTMLElement);
    await waitFor(() => expect(visualPolicySetMock).toHaveBeenCalledWith({ expectedSeatId: 'owner', enabled: true }));
  });

  it.each([
    ['unavailable result', { success: false, data: { status: 'unavailable', reason: 'malformed_stored_value' } }],
    ['read rejection', new Error('settings unavailable')],
  ])('fails closed for %s', async (_name, result) => {
    isDesktopMock.mockReturnValue(true);
    if (result instanceof Error) visualPolicyReadMock.mockRejectedValue(result);
    else visualPolicyReadMock.mockResolvedValue(result);
    render(<PrivacySettings />);

    const row = await screen.findByTestId('visual-policy-row');
    const toggle = row.querySelector('button[role="switch"]');
    await waitFor(() => expect(row).toHaveTextContent('This setting is currently unavailable'));
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(toggle).toBeDisabled();
  });

  it('ignores a stale A read after switching to B', async () => {
    isDesktopMock.mockReturnValue(true);
    const seatARead = createDeferred<{ success: true; data: ReturnType<typeof enabledPolicy> }>();
    visualPolicyReadMock
      .mockReturnValueOnce(seatARead.promise)
      .mockResolvedValueOnce({ success: true, data: disabledPolicy('seat-b') });
    render(<PrivacySettings />);

    await act(async () => switchSeat('seat-b'));
    const row = await screen.findByTestId('visual-policy-row');
    const toggle = row.querySelector('button[role="switch"]');
    await waitFor(() => expect(toggle?.getAttribute('aria-checked')).toBe('false'));

    await act(async () => seatARead.resolve({ success: true, data: enabledPolicy('owner') }));
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('ignores an A→B→A completion from the earlier A generation', async () => {
    isDesktopMock.mockReturnValue(true);
    const firstARead = createDeferred<{ success: true; data: ReturnType<typeof enabledPolicy> }>();
    visualPolicyReadMock
      .mockReturnValueOnce(firstARead.promise)
      .mockResolvedValueOnce({ success: true, data: disabledPolicy('seat-b') })
      .mockResolvedValueOnce({ success: true, data: disabledPolicy('owner') });
    render(<PrivacySettings />);

    await act(async () => switchSeat('seat-b'));
    await act(async () => switchSeat('owner'));
    const row = await screen.findByTestId('visual-policy-row');
    const toggle = row.querySelector('button[role="switch"]');
    await waitFor(() => expect(toggle?.getAttribute('aria-checked')).toBe('false'));

    await act(async () => firstARead.resolve({ success: true, data: enabledPolicy('owner') }));
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the desktop-only notice (no toggle) when not on desktop', () => {
    isDesktopMock.mockReturnValue(false);
    render(<PrivacySettings />);

    expect(screen.getByText('Telemetry is only collected by the desktop app.')).toBeInTheDocument();
    expect(screen.queryByTestId('preference-row')).not.toBeInTheDocument();
    // No consent read happens in browser mode.
    expect(getConsentMock).not.toHaveBeenCalled();
    expect(getTtsConsentMock).not.toHaveBeenCalled();
  });
});
