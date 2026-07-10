/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/renderer/components/account/useCommandEveProfile', () => ({
  useCommandEveProfile: () => ({ name: 'Mathias Heinke', email: 'm@example.com', loaded: true, refresh: vi.fn() }),
  initialsFromName: () => 'MH',
}));

import SiderFooter from '@/renderer/components/layout/Sider/SiderFooter';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
