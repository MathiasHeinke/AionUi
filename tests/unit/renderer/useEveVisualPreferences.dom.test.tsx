/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configSetMock, configSubscribeMock, whenReadyMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configSetMock: vi.fn(),
  configSubscribeMock: vi.fn(() => () => undefined),
  whenReadyMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
    subscribe: configSubscribeMock,
    whenReady: whenReadyMock,
  },
}));

import { useEveVisualPreferences } from '@/renderer/hooks/ui/useEveVisualPreferences';

const VisualConsumer: React.FC = () => {
  const { preferences, resolvedAppearance, loaded, setPreferences } = useEveVisualPreferences(true);
  return (
    <button
      type='button'
      data-testid='visual-consumer'
      data-loaded={String(loaded)}
      data-mode={resolvedAppearance}
      onClick={() => void setPreferences((current) => ({ ...current, accent: 'emerald' }))}
    >
      {preferences.accent}
    </button>
  );
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-eve-reduced-effects');
});

describe('useEveVisualPreferences', () => {
  it('hydrates, projects and persists one normalized preference model', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'commandEve.visualPreferences') return { mode: 'dark', accent: 'petrol', glassOpacity: 0.8 };
      return 'command-eve-light';
    });
    configSetMock.mockResolvedValue(undefined);

    render(<VisualConsumer />);

    await waitFor(() => expect(screen.getByTestId('visual-consumer').getAttribute('data-loaded')).toBe('true'));
    expect(screen.getByTestId('visual-consumer').getAttribute('data-mode')).toBe('dark');
    expect(screen.getByTestId('visual-consumer').textContent).toBe('petrol');
    expect(document.documentElement.style.getPropertyValue('--primary-6')).toBe('15, 118, 110');

    fireEvent.click(screen.getByTestId('visual-consumer'));
    await waitFor(() => expect(configSetMock).toHaveBeenCalledTimes(1));
    expect(configSetMock.mock.calls[0][0]).toBe('commandEve.visualPreferences');
    expect(configSetMock.mock.calls[0][1]).toMatchObject({ mode: 'dark', accent: 'emerald' });
  });
});
