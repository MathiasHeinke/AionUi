/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import { SWRConfig } from 'swr';

const { systemInfoMock, updateSystemInfoMock, restartMock, showOpenMock, messageInfoMock } = vi.hoisted(() => ({
  systemInfoMock: vi.fn(),
  updateSystemInfoMock: vi.fn(),
  restartMock: vi.fn(),
  showOpenMock: vi.fn(),
  messageInfoMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/base/FeedbackButton', () => ({
  default: () => <button type='button'>settings.oneClickFeedback</button>,
}));

vi.mock('@/renderer/components/settings/LanguageSwitcher', () => ({
  default: () => <div>LanguageSwitcher</div>,
}));

vi.mock('@/renderer/components/settings/SettingsModal/contents/SystemModalContent/DevSettings', () => ({
  default: () => <div>DevSettings</div>,
}));

// Honest mini-store mock: SystemModalContent now reads the PII toggle REACTIVELY
// via useConfig (configService.subscribe + get through useSyncExternalStore) and
// awaits whenReady() — so the mock must behave like the real service: get serves
// a backing map, set/setLocal write it AND notify per-key subscribers (else the
// derived toggle never re-renders and every toggle test deadlocks on stale UI).
const { configGetMock, configSetMock, configSetLocalMock, configSubscribeMock, notifyConfigKey } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const subscribers = new Map<string, Set<() => void>>();
  const notify = (key: string) => {
    for (const cb of subscribers.get(key) ?? []) cb();
  };
  return {
    configGetMock: vi.fn((key: string) => store.get(key)),
    configSetMock: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      notify(key);
      return Promise.resolve();
    }),
    configSetLocalMock: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      notify(key);
    }),
    configSubscribeMock: vi.fn((key: string, cb: () => void) => {
      if (!subscribers.has(key)) subscribers.set(key, new Set());
      subscribers.get(key)!.add(cb);
      return () => subscribers.get(key)?.delete(cb);
    }),
    notifyConfigKey: notify,
  };
});

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
    setLocal: configSetLocalMock,
    subscribe: configSubscribeMock,
    whenReady: vi.fn(() => Promise.resolve()),
    getCurrentSeatId: vi.fn(() => 'seat-1'),
    onSeatRebind: vi.fn(() => () => {}),
  },
}));
void notifyConfigKey;

// CEVE-18205 — the agent video-generate row is offered only to an ENTITLED seat,
// so the entitlement read is a mocked seam rather than a live bridge call. The
// default is the fail-closed one (null = still loading / no bridge); individual
// tests opt into an entitled seat.
const { entitlementStatusMock } = vi.hoisted(() => ({
  entitlementStatusMock: vi.fn<() => { state: string } | null>(() => null),
}));

vi.mock('@/renderer/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => ({
    loading: false,
    status: entitlementStatusMock(),
    blocked: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      systemInfo: { invoke: systemInfoMock },
      updateSystemInfo: { invoke: updateSystemInfoMock },
      restart: { invoke: restartMock },
      getStartOnBootStatus: { invoke: vi.fn(() => Promise.resolve({ success: false })) },
      getGpuStatus: { invoke: vi.fn(() => Promise.resolve({ success: false })) },
    },
    systemSettings: {
      getCloseToTray: { invoke: vi.fn(() => Promise.resolve(false)) },
      setCloseToTray: { invoke: vi.fn(() => Promise.resolve()) },
    },
    dialog: {
      showOpen: { invoke: showOpenMock },
    },
    shell: {
      openFolderWith: { invoke: vi.fn(() => Promise.resolve()) },
    },
  },
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: {
      ...actual.Message,
      info: messageInfoMock,
    },
    Modal: {
      ...actual.Modal,
      useModal: () => [
        {
          confirm: ({ onOk }: { onOk?: () => void }) => {
            onOk?.();
          },
        },
        null,
      ],
    },
  };
});

import SystemModalContent from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent';

const defaultSystemInfo = {
  cacheDir: '/cache',
  workDir: '/work',
  logDir: '/logs',
  platform: 'darwin',
  arch: 'arm64',
};

const renderContent = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ConfigProvider>
        <SystemModalContent />
      </ConfigProvider>
    </SWRConfig>
  );

describe('SystemModalContent directory settings', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    systemInfoMock.mockResolvedValue(defaultSystemInfo);
    updateSystemInfoMock.mockResolvedValue(undefined);
    restartMock.mockResolvedValue({ restarted: true, manualRestartRequired: false });
    showOpenMock.mockResolvedValue(['/new-logs']);
  });

  it('persists a selected log directory and restarts with the updated directory config', async () => {
    const user = userEvent.setup();
    const { container } = renderContent();

    await screen.findByText('/logs');
    const logDirItem = screen.getByText('settings.logDir').closest('.arco-form-item');
    expect(logDirItem).not.toBeNull();

    const pickButton = within(logDirItem as HTMLElement).getByRole('button');
    await user.click(pickButton);

    await waitFor(() => {
      expect(updateSystemInfoMock).toHaveBeenCalledWith({
        cacheDir: '/cache',
        workDir: '/work',
        logDir: '/new-logs',
      });
    });
    expect(restartMock).toHaveBeenCalledTimes(1);
    expect(container).toHaveTextContent('/new-logs');
  });

  it('shows the update failure reason when changing a directory fails', async () => {
    const user = userEvent.setup();
    updateSystemInfoMock.mockRejectedValueOnce(new Error('permission denied'));
    showOpenMock.mockResolvedValueOnce(['/new-work']);
    const { container } = renderContent();

    await screen.findByText('/work');
    const workDirItem = screen.getByText('settings.workDir').closest('.arco-form-item');
    expect(workDirItem).not.toBeNull();

    await user.click(within(workDirItem as HTMLElement).getByRole('button'));

    await screen.findByText('permission denied');
    expect(container).toHaveTextContent('/work');
    expect(restartMock).not.toHaveBeenCalled();
  });

  it('opens the directory picker when clicking the work directory field body', async () => {
    const user = userEvent.setup();
    showOpenMock.mockResolvedValueOnce(['/new-work']);
    renderContent();

    await screen.findByText('/work');
    const workDirItem = screen.getByText('settings.workDir').closest('.arco-form-item');
    expect(workDirItem).not.toBeNull();
    const fieldBody = (workDirItem as HTMLElement).querySelector('.eve-dir-input');
    expect(fieldBody).not.toBeNull();

    await user.click(fieldBody as HTMLElement);

    await waitFor(() => {
      expect(updateSystemInfoMock).toHaveBeenCalledWith({
        cacheDir: '/cache',
        workDir: '/new-work',
        logDir: '/logs',
      });
    });
  });

  it('tells the user to restart manually when dev mode cannot relaunch automatically', async () => {
    const user = userEvent.setup();
    restartMock.mockResolvedValueOnce({ restarted: false, manualRestartRequired: true, reason: 'dev-mode' });
    const { container } = renderContent();

    await screen.findByText('/logs');
    const logDirItem = screen.getByText('settings.logDir').closest('.arco-form-item');
    expect(logDirItem).not.toBeNull();

    await user.click(within(logDirItem as HTMLElement).getByRole('button'));

    await waitFor(() => {
      expect(updateSystemInfoMock).toHaveBeenCalledWith({
        cacheDir: '/cache',
        workDir: '/work',
        logDir: '/new-logs',
      });
    });
    expect(restartMock).toHaveBeenCalledTimes(1);
    expect(messageInfoMock).toHaveBeenCalledWith('settings.restartManualRequired');
    expect(container).toHaveTextContent('/new-logs');
  });

  it('shows field-specific tooltip text when hovering the folder action button', async () => {
    const user = userEvent.setup();
    renderContent();

    await screen.findByText('/work');
    const workDirItem = screen.getByText('settings.workDir').closest('.arco-form-item');
    const logDirItem = screen.getByText('settings.logDir').closest('.arco-form-item');
    expect(workDirItem).not.toBeNull();
    expect(logDirItem).not.toBeNull();

    const workDirButton = within(workDirItem as HTMLElement).getByRole('button');
    const logDirButton = within(logDirItem as HTMLElement).getByRole('button');

    await user.hover(workDirButton);
    expect(await screen.findByText('settings.changeWorkDir')).toBeInTheDocument();

    await user.unhover(workDirButton);
    await user.hover(logDirButton);
    expect(await screen.findByText('settings.changeLogDir')).toBeInTheDocument();
  });
});

describe('SystemModalContent — PII/DSGVO egress toggle (S11)', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    systemInfoMock.mockResolvedValue(defaultSystemInfo);
    configGetMock.mockReturnValue(undefined);
  });

  const findPiiSwitch = async (): Promise<HTMLElement> => {
    const row = (await screen.findByText('settings.commandEvePiiProtection')).closest(
      '[data-testid="system-preference-commandEvePiiProtection"]'
    );
    expect(row).not.toBeNull();
    return within(row as HTMLElement).getByRole('switch');
  };

  it('renders the PII-Schutz toggle in the privacy area (default ON when unset)', async () => {
    renderContent();
    const sw = await findPiiSwitch();
    // Absent config ⇒ ON (fail-safe default).
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('turning OFF (after confirm) persists mode "off"', async () => {
    const user = userEvent.setup();
    renderContent();
    const sw = await findPiiSwitch();

    // The mocked Modal.useModal auto-approves onOk → the waiver is confirmed.
    await user.click(sw);

    await waitFor(() => {
      expect(configSetMock).toHaveBeenCalledWith('commandEve.egressRedactionMode', 'off');
    });
  });

  it('turning back ON persists mode "on" immediately (safe direction, no confirm needed)', async () => {
    const user = userEvent.setup();
    // Start from an explicit 'off' so the first click re-enables.
    configGetMock.mockImplementation((key: string) => (key === 'commandEve.egressRedactionMode' ? 'off' : undefined));
    renderContent();
    const sw = await findPiiSwitch();
    expect(sw).toHaveAttribute('aria-checked', 'false');

    await user.click(sw);

    await waitFor(() => {
      expect(configSetMock).toHaveBeenCalledWith('commandEve.egressRedactionMode', 'on');
    });
  });
});

describe('SystemModalContent — paid video permission', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    systemInfoMock.mockResolvedValue(defaultSystemInfo);
    updateSystemInfoMock.mockResolvedValue(undefined);
    restartMock.mockResolvedValue({ restarted: true, manualRestartRequired: false });
    showOpenMock.mockResolvedValue(['/new-logs']);
    configGetMock.mockImplementation(() => undefined);
  });

  it('offers no second per-seat video spend switch; native Hermes permission remains the owner', async () => {
    renderContent();
    await screen.findByText('settings.commandEveKanbanAutoApprove');
    expect(screen.queryByText('settings.commandEveAgentVideoGenerate')).toBeNull();
    expect(screen.queryByTestId('system-preference-commandEveAgentVideoGenerate')).toBeNull();
  });
});
