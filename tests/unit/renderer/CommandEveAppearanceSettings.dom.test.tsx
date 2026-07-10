/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setVisualPreferencesMock, showOpenMock, getImageBase64Mock } = vi.hoisted(() => ({
  setVisualPreferencesMock: vi.fn(() => Promise.resolve()),
  showOpenMock: vi.fn(),
  getImageBase64Mock: vi.fn(),
}));

const preferences = {
  schemaVersion: 1 as const,
  mode: 'system' as const,
  accent: 'blue' as const,
  glassOpacity: 0.84,
  glassBlur: 20,
  reducedEffects: false,
  background: {
    enabled: false,
    fit: 'cover' as const,
    intensity: 1,
    blur: 0,
    dim: 0,
    adaptiveTint: true,
  },
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({
    theme: 'light',
    visualPreferences: preferences,
    setVisualPreferences: setVisualPreferencesMock,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: { showOpen: { invoke: showOpenMock } },
    fs: { getImageBase64: { invoke: getImageBase64Mock } },
  },
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type='button' onClick={onClick}>
      {children}
    </button>
  ),
  Message: { error: vi.fn() },
  Modal: { confirm: vi.fn() },
  Slider: () => <div data-testid='slider' />,
  Switch: ({
    checked,
    onChange,
    'data-testid': testId,
    'aria-label': ariaLabel,
  }: {
    checked?: boolean;
    onChange?: (value: boolean) => void;
    'data-testid'?: string;
    'aria-label'?: string;
  }) => (
    <button
      type='button'
      data-testid={testId}
      aria-label={ariaLabel}
      aria-pressed={checked}
      onClick={() => onChange?.(!checked)}
    />
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import CommandEveAppearanceSettings from '@/renderer/components/settings/CommandEveAppearanceSettings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  delete (preferences.background as typeof preferences.background & { assetId?: string }).assetId;
});

describe('CommandEveAppearanceSettings', () => {
  it('routes mode and accent controls through the single visual preference model', () => {
    render(<CommandEveAppearanceSettings />);

    fireEvent.click(screen.getByTestId('eve-appearance-mode-dark'));
    const modeUpdater = setVisualPreferencesMock.mock.calls[0][0];
    expect(modeUpdater(preferences)).toMatchObject({ mode: 'dark', accent: 'blue' });

    fireEvent.click(screen.getByTestId('eve-appearance-accent-emerald'));
    const accentUpdater = setVisualPreferencesMock.mock.calls[1][0];
    expect(accentUpdater(preferences)).toMatchObject({ mode: 'system', accent: 'emerald' });
  });

  it('supports standard radio arrow navigation and the adaptive background tint', () => {
    (preferences.background as typeof preferences.background & { assetId?: string }).assetId = 'bg-test';
    localStorage.setItem('command-eve.visual-background.bg-test', 'data:image/png;base64,AAAA');
    render(<CommandEveAppearanceSettings />);

    fireEvent.keyDown(screen.getByTestId('eve-appearance-mode-system'), { key: 'ArrowRight' });
    const modeUpdater = setVisualPreferencesMock.mock.calls[0][0];
    expect(modeUpdater(preferences)).toMatchObject({ mode: 'light' });

    fireEvent.click(screen.getByTestId('eve-appearance-adaptive-tint'));
    const tintUpdater = setVisualPreferencesMock.mock.calls[1][0];
    expect(tintUpdater(preferences)).toMatchObject({ background: { adaptiveTint: false } });
  });

  it('gives every visual preference switch an accessible name', () => {
    (preferences.background as typeof preferences.background & { assetId?: string }).assetId = 'bg-test';
    localStorage.setItem('command-eve.visual-background.bg-test', 'data:image/png;base64,AAAA');

    render(<CommandEveAppearanceSettings />);

    expect(screen.getByRole('button', { name: 'settings.commandEveAppearance.reducedEffects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.commandEveAppearance.backgroundEnabled' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.commandEveAppearance.adaptiveTint' })).toBeTruthy();
  });

  it('stores an uploaded image locally and persists only its opaque id', async () => {
    showOpenMock.mockResolvedValue(['/tmp/background.png']);
    getImageBase64Mock.mockResolvedValue('data:image/png;base64,AAAA');
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');

    render(<CommandEveAppearanceSettings />);
    fireEvent.click(screen.getAllByText('settings.commandEveAppearance.chooseBackground')[0]);

    await waitFor(() => expect(setVisualPreferencesMock).toHaveBeenCalledTimes(1));
    const updater = setVisualPreferencesMock.mock.calls[0][0];
    const next = updater(preferences);
    expect(next.background.assetId).toBe('bg-11111111-1111-4111-8111-111111111111');
    expect(next.background).not.toHaveProperty('path');
    expect(localStorage.getItem(`command-eve.visual-background.${next.background.assetId}`)).toBe(
      'data:image/png;base64,AAAA'
    );
  });
});
