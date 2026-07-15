import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutoUpdateStatus } from '@/common/update/updateTypes';

const bridgeState = vi.hoisted(() => ({
  listener: null as ((status: AutoUpdateStatus) => void) | null,
  getStatus: vi.fn(),
  remove: vi.fn(),
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
      getStatus: {
        invoke: bridgeState.getStatus,
      },
    },
  },
}));

import { resetAutoUpdateStatusStoreForTest, useAutoUpdateStatus } from '@/renderer/hooks/system/useAutoUpdateStatus';

const StatusProbe = () => {
  const status = useAutoUpdateStatus();
  return <output data-testid='status'>{JSON.stringify(status)}</output>;
};

beforeEach(() => {
  resetAutoUpdateStatusStoreForTest();
  bridgeState.listener = null;
  bridgeState.getStatus.mockReset();
  bridgeState.remove.mockReset();
});

afterEach(() => {
  cleanup();
  resetAutoUpdateStatusStoreForTest();
});

describe('useAutoUpdateStatus', () => {
  it('hydrates the durable main-process status for a newly mounted renderer', async () => {
    bridgeState.getStatus.mockResolvedValue({
      success: true,
      data: {
        status: {
          status: 'downloaded',
          version: '1.8.12',
          releaseNotes: 'Background updates',
        },
      },
    });

    render(<StatusProbe />);

    await waitFor(() => expect(screen.getByTestId('status').textContent).toContain('downloaded'));
    expect(screen.getByTestId('status').textContent).toContain('1.8.12');
  });

  it('does not let a late hydration response overwrite a newer live event', async () => {
    let resolveHydration: ((value: unknown) => void) | null = null;
    bridgeState.getStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveHydration = resolve;
      })
    );

    render(<StatusProbe />);
    act(() => {
      bridgeState.listener?.({ status: 'available', version: '1.8.13' });
    });
    expect(screen.getByTestId('status').textContent).toContain('1.8.13');

    await act(async () => {
      resolveHydration?.({
        success: true,
        data: { status: { status: 'downloaded', version: '1.8.12' } },
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId('status').textContent).toContain('1.8.13');
    expect(screen.getByTestId('status').textContent).not.toContain('1.8.12');
  });

  it('hydrates metadata beneath a live progress event without replacing its phase', async () => {
    let resolveHydration: ((value: unknown) => void) | null = null;
    bridgeState.getStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveHydration = resolve;
      })
    );

    render(<StatusProbe />);
    act(() => {
      bridgeState.listener?.({
        status: 'downloading',
        progress: { bytesPerSecond: 20, percent: 40, transferred: 40, total: 100 },
      });
    });

    await act(async () => {
      resolveHydration?.({
        success: true,
        data: {
          status: {
            status: 'available',
            version: '1.8.12',
            releaseNotes: 'Quiet background updates',
          },
        },
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId('status').textContent).toContain('downloading');
    expect(screen.getByTestId('status').textContent).toContain('1.8.12');
    expect(screen.getByTestId('status').textContent).toContain('Quiet background updates');
    expect(screen.getByTestId('status').textContent).toContain('"percent":40');
  });
});
