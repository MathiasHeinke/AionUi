import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { logStreamOnMock } = vi.hoisted(() => ({
  logStreamOnMock: vi.fn(() => vi.fn()),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      logStream: { on: logStreamOnMock },
      openDevTools: { invoke: vi.fn() },
    },
    task: { stopAll: { invoke: vi.fn() } },
  },
}));
vi.mock('@/common/config/constants', () => ({ TEAM_MODE_ENABLED: false }));
vi.mock('@/common/config/commandEveShell', () => ({ COMMAND_EVE_SHELL_ENABLED: true }));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@renderer/components/layout/Titlebar', () => ({ default: () => null }));
vi.mock('@renderer/components/layout/PwaPullToRefresh', () => ({ default: () => null }));
vi.mock('@renderer/components/settings/UpdateModal', () => ({ default: () => null }));
vi.mock('@renderer/components/team/TeamManageConfirmCard', () => ({ default: () => null }));
vi.mock('@renderer/components/team/KanbanAcpConfirmCard', () => ({ default: () => null }));
vi.mock('@renderer/components/seats/SeatRail', () => ({
  default: ({ compact = false }: { compact?: boolean }) => (
    <nav data-testid='layout-seat-rail' data-compact={String(compact)} />
  ),
}));
vi.mock('@renderer/hooks/context/NavigationHistoryContext', () => ({
  NavigationHistoryProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@renderer/hooks/system/useDeepLink', () => ({ useDeepLink: vi.fn() }));
vi.mock('@renderer/hooks/system/useNotificationClick', () => ({ useNotificationClick: vi.fn() }));
vi.mock('@renderer/hooks/file/useDirectorySelection', () => ({
  useDirectorySelection: () => ({ contextHolder: null }),
}));
vi.mock('@renderer/hooks/ui/useConversationShortcuts', () => ({ useConversationShortcuts: vi.fn() }));
vi.mock('@renderer/hooks/useCommandEveFounderBuild', () => ({
  useCommandEveFounderBuild: () => ({ founderBuild: false }),
}));
vi.mock('@renderer/utils/ui/siderTooltip', () => ({ cleanupSiderTooltips: vi.fn() }));
vi.mock('@arco-design/web-react', async () => {
  const React = await import('react');
  const Layout = ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement('div', props, children);
  Layout.Sider = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
    React.createElement('aside', props, children);
  Layout.Header = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
    React.createElement('header', props, children);
  Layout.Content = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
    React.createElement('main', props, children);
  return { Layout };
});

import Layout from '@renderer/components/layout/Layout';

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/guid']}>
      <Routes>
        <Route element={<Layout sider={<div data-testid='sider' />} />}>
          <Route path='/guid' element={<div data-testid='outlet' />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Layout — authoritative seat rail reachability', () => {
  beforeEach(() => {
    logStreamOnMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps the same rail mounted in compact mode at 767px', async () => {
    setViewportWidth(767);
    renderLayout();

    await waitFor(() => {
      expect(screen.getByTestId('layout-seat-rail').getAttribute('data-compact')).toBe('true');
    });
    expect(screen.getByTestId('outlet')).toBeTruthy();
  });

  it('mounts the same rail in desktop mode at the 768px boundary', async () => {
    setViewportWidth(768);
    renderLayout();

    await waitFor(() => {
      expect(screen.getByTestId('layout-seat-rail').getAttribute('data-compact')).toBe('false');
    });
    expect(screen.getByTestId('outlet')).toBeTruthy();
  });
});
