import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const downloadedStatus = {
  status: 'downloaded' as const,
  version: '1.8.12',
  releaseNotes: 'Quiet background updates',
};

const bridge = vi.hoisted(() => ({
  quitAndInstall: vi.fn(),
  openListener: vi.fn(() => vi.fn()),
  autoCheck: vi.fn(),
  manualCheck: vi.fn(),
}));

const updateStore = vi.hoisted(() => ({
  status: {
    status: 'downloaded' as const,
    version: '1.8.12',
    releaseNotes: 'Quiet background updates',
  } as { status: string; version?: string; releaseNotes?: string },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    icon,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button {...props}>
      {icon}
      {children}
    </button>
  ),
  Progress: () => <div data-testid='progress' />,
  Message: { error: vi.fn() },
}));

vi.mock('@icon-park/react', () => ({
  CheckOne: () => <span />,
  Download: () => <span />,
  FolderOpen: () => <span />,
  Refresh: () => <span />,
  CloseOne: () => <span />,
  Install: () => <span />,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    update: {
      open: { on: bridge.openListener },
      check: { invoke: bridge.manualCheck },
      download: { invoke: vi.fn() },
      downloadProgress: { on: vi.fn(() => vi.fn()) },
    },
    autoUpdate: {
      check: { invoke: bridge.autoCheck },
      download: { invoke: vi.fn() },
      quitAndInstall: { invoke: bridge.quitAndInstall },
    },
    shell: {
      openExternal: { invoke: vi.fn() },
      openFile: { invoke: vi.fn() },
      showItemInFolder: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/common/config/commandEveShell', () => ({ COMMAND_EVE_SHELL_ENABLED: true }));

vi.mock('@/renderer/hooks/system/useAutoUpdateStatus', () => ({
  useAutoUpdateStatus: () => updateStore.status,
  getAutoUpdateStatusSnapshot: () => updateStore.status,
}));

vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (
    <div data-testid='update-modal' data-visible={String(visible)}>
      {children}
    </div>
  ),
}));

vi.mock('@/renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import UpdateModal from '@/renderer/components/settings/UpdateModal';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  updateStore.status = downloadedStatus;
});

describe('UpdateModal background update behavior', () => {
  it('does not interrupt the user when a downloaded status arrives', () => {
    render(<UpdateModal />);

    expect(screen.getByTestId('update-modal').getAttribute('data-visible')).toBe('false');
    expect(bridge.quitAndInstall).not.toHaveBeenCalled();
  });

  it('opens downloaded details only after the footer event and supports deferring', () => {
    render(<UpdateModal />);

    act(() => {
      window.dispatchEvent(new Event('aionui-open-update-modal'));
    });
    expect(screen.getByTestId('update-modal').getAttribute('data-visible')).toBe('true');
    expect(screen.getByText('update.readyToInstall')).toBeTruthy();
    expect(screen.getByText('Quiet background updates')).toBeTruthy();

    fireEvent.click(screen.getByText('update.later'));
    expect(screen.getByTestId('update-modal').getAttribute('data-visible')).toBe('false');
    expect(bridge.quitAndInstall).not.toHaveBeenCalled();
  });

  it('shows current feed notes when an older manual result remains in state', async () => {
    updateStore.status = { status: 'idle' };
    bridge.autoCheck.mockResolvedValue({
      success: true,
      data: { updateInfo: { version: '1.8.11' } },
    });
    bridge.manualCheck.mockResolvedValue({
      success: true,
      data: {
        currentVersion: '1.8.10',
        updateAvailable: true,
        latest: {
          tagName: 'v1.8.11',
          version: '1.8.11',
          name: 'Old update',
          body: 'Stale GitHub notes',
          htmlUrl: 'https://example.invalid/1.8.11',
          prerelease: false,
          draft: false,
          assets: [],
        },
      },
    });

    const view = render(<UpdateModal />);
    act(() => {
      window.dispatchEvent(new Event('aionui-open-update-modal'));
    });
    await waitFor(() => expect(bridge.manualCheck).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
    });

    updateStore.status = {
      status: 'downloaded',
      version: '1.8.12',
      releaseNotes: 'Current feed notes',
    };
    view.rerender(<UpdateModal />);

    await waitFor(() => expect(screen.getByText('Current feed notes')).toBeTruthy());
    expect(screen.queryByText('Stale GitHub notes')).toBeNull();
  });
});
