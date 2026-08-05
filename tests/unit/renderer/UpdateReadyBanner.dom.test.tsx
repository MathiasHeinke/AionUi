/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773: the restart-after-update gap. The banner must appear once the
 * updater reports `downloaded`, must offer quitAndInstall, and a dismissal
 * must snooze — never silence — the prompt (it re-surfaces on the wake-up
 * timer and on window focus).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutoUpdateStatus } from '@/common/update/updateTypes';
import { UPDATE_READY_SNOOZE_MS } from '@/common/update/updateReadyPromptCore';

const bridgeState = vi.hoisted(() => ({
  listener: null as ((status: AutoUpdateStatus) => void) | null,
  getStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    icon,
    loading: _loading,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode; loading?: boolean }) => (
    <button {...props}>
      {icon}
      {children}
    </button>
  ),
  Message: { error: vi.fn() },
}));

vi.mock('@icon-park/react', () => ({
  Refresh: () => <span />,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    autoUpdate: {
      status: {
        on: vi.fn((listener: (status: AutoUpdateStatus) => void) => {
          bridgeState.listener = listener;
          return bridgeState.remove;
        }),
      },
      getStatus: { invoke: bridgeState.getStatus },
      quitAndInstall: { invoke: bridgeState.quitAndInstall },
    },
  },
}));

import UpdateReadyBanner from '@/renderer/components/settings/UpdateReadyBanner';
import { resetAutoUpdateStatusStoreForTest } from '@/renderer/hooks/system/useAutoUpdateStatus';

const DOWNLOADED: AutoUpdateStatus = { status: 'downloaded', version: '1.820.4' };

const hydrateWith = (status: AutoUpdateStatus | null): void => {
  bridgeState.getStatus.mockResolvedValue({ success: true, data: { status } });
};

beforeEach(() => {
  resetAutoUpdateStatusStoreForTest();
  bridgeState.listener = null;
  bridgeState.getStatus.mockReset();
  bridgeState.quitAndInstall.mockReset();
  bridgeState.remove.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetAutoUpdateStatusStoreForTest();
});

describe('UpdateReadyBanner', () => {
  it('stays hidden while the durable status has no downloaded update', async () => {
    hydrateWith(null);
    render(<UpdateReadyBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('update-ready-banner')).toBeNull();
  });

  it('prompts "update installed — restart now" when the durable main status is downloaded', async () => {
    hydrateWith(DOWNLOADED);
    render(<UpdateReadyBanner />);

    await waitFor(() => expect(screen.getByTestId('update-ready-banner')).toBeInTheDocument());
    expect(screen.getByTestId('update-ready-banner').textContent).toContain('update.restartBannerTitle');
    expect(screen.getByTestId('update-ready-banner').textContent).toContain('1.820.4');
  });

  it('appears when a live bridge status event reports the download finished', async () => {
    hydrateWith(null);
    render(<UpdateReadyBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('update-ready-banner')).toBeNull();

    act(() => {
      bridgeState.listener?.(DOWNLOADED);
    });
    expect(screen.getByTestId('update-ready-banner')).toBeInTheDocument();
  });

  it('invokes quitAndInstall on confirm', async () => {
    hydrateWith(DOWNLOADED);
    bridgeState.quitAndInstall.mockResolvedValue(undefined);
    render(<UpdateReadyBanner />);

    await waitFor(() => expect(screen.getByTestId('update-ready-banner-restart')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('update-ready-banner-restart'));

    await waitFor(() => expect(bridgeState.quitAndInstall).toHaveBeenCalledTimes(1));
  });

  it('snoozes on "Later" and re-surfaces when the snooze timer expires', async () => {
    hydrateWith(DOWNLOADED);
    render(<UpdateReadyBanner />);
    await waitFor(() => expect(screen.getByTestId('update-ready-banner')).toBeInTheDocument());

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('update-ready-banner-later'));
    expect(screen.queryByTestId('update-ready-banner')).toBeNull();

    // Still hidden just before the snooze ends...
    act(() => {
      vi.advanceTimersByTime(UPDATE_READY_SNOOZE_MS - 1000);
    });
    expect(screen.queryByTestId('update-ready-banner')).toBeNull();

    // ...and back once it expires — the dismissal is never permanent silence.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('update-ready-banner')).toBeInTheDocument();
  });

  it('re-surfaces on window focus only after the snooze has expired', async () => {
    hydrateWith(DOWNLOADED);
    render(<UpdateReadyBanner />);
    await waitFor(() => expect(screen.getByTestId('update-ready-banner')).toBeInTheDocument());

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('update-ready-banner-later'));
    expect(screen.queryByTestId('update-ready-banner')).toBeNull();

    // Focus while the snooze is armed: stays hidden.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.queryByTestId('update-ready-banner')).toBeNull();

    // Focus after the snooze expired (system clock moved without firing timers):
    // the prompt must come back.
    act(() => {
      vi.setSystemTime(Date.now() + UPDATE_READY_SNOOZE_MS + 1);
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByTestId('update-ready-banner')).toBeInTheDocument();
  });

  it('re-surfaces over an armed snooze when a newer build finishes downloading', async () => {
    hydrateWith(DOWNLOADED);
    render(<UpdateReadyBanner />);
    await waitFor(() => expect(screen.getByTestId('update-ready-banner')).toBeInTheDocument());

    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('update-ready-banner-later'));
    expect(screen.queryByTestId('update-ready-banner')).toBeNull();

    act(() => {
      bridgeState.listener?.({ status: 'downloaded', version: '1.820.5' });
    });
    const banner = screen.getByTestId('update-ready-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain('1.820.5');
  });
});
