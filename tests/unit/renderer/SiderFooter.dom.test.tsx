/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const updateState = vi.hoisted(() => ({ status: { status: 'idle' } as { status: string; version?: string } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
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
}));

vi.mock('@/renderer/hooks/system/useAutoUpdateStatus', () => ({
  useAutoUpdateStatus: () => updateState.status,
}));

vi.mock('@/renderer/components/account/useCommandEveProfile', () => ({
  useCommandEveProfile: () => ({ name: 'Mathias Heinke', email: 'm@example.com', loaded: true, refresh: vi.fn() }),
  initialsFromName: () => 'MH',
}));

import SiderFooter from '@/renderer/components/layout/Sider/SiderFooter';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  updateState.status = { status: 'idle' };
});

describe('SiderFooter', () => {
  it('shows the shared account identity and opens settings', () => {
    const onSettingsClick = vi.fn();
    render(
      <SiderFooter
        isMobile={false}
        isSettings={false}
        theme='dark'
        siderTooltipProps={{}}
        onSettingsClick={onSettingsClick}
        onThemeToggle={vi.fn()}
      />
    );

    expect(screen.getByText('Mathias Heinke')).toBeTruthy();
    expect(screen.getByText('MH')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sider-footer-identity'));
    expect(onSettingsClick).toHaveBeenCalledTimes(1);
  });

  it('uses the existing modal event instead of starting a second update flow', () => {
    const openListener = vi.fn();
    window.addEventListener('aionui-open-update-modal', openListener);

    render(
      <SiderFooter
        isMobile={false}
        isSettings={false}
        theme='dark'
        siderTooltipProps={{}}
        onSettingsClick={vi.fn()}
        onThemeToggle={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('sider-footer-update'));
    expect(openListener).toHaveBeenCalledTimes(1);
    window.removeEventListener('aionui-open-update-modal', openListener);
  });

  it('renders only the update icon and exposes state through accessible metadata', () => {
    updateState.status = { status: 'downloaded', version: '1.8.12' };

    render(
      <SiderFooter
        isMobile={false}
        isSettings={false}
        theme='dark'
        siderTooltipProps={{}}
        onSettingsClick={vi.fn()}
        onThemeToggle={vi.fn()}
      />
    );

    const updateButton = screen.getByTestId('sider-footer-update');
    expect(updateButton.getAttribute('data-update-status')).toBe('downloaded');
    expect(updateButton.getAttribute('aria-label')).toBe('update.readyTooltip');
    expect(updateButton.textContent).toBe('');
    expect(screen.queryByText('update.modalTitle')).toBeNull();
  });
});
