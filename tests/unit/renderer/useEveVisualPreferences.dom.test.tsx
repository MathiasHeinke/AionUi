/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configSetMock, configSetLocalMock, configSubscribeMock, subscriberRef, whenReadyMock } =
  vi.hoisted(() => ({
    configGetMock: vi.fn(),
    configSetMock: vi.fn(),
    configSetLocalMock: vi.fn(),
    configSubscribeMock: vi.fn(() => () => undefined),
    subscriberRef: { current: undefined as ((raw: unknown) => void) | undefined },
    whenReadyMock: vi.fn(() => Promise.resolve()),
  }));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
    setLocal: configSetLocalMock,
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
      onClick={() => void setPreferences((current) => ({ ...current, accent: 'emerald' })).catch(() => undefined)}
    >
      {preferences.accent}
    </button>
  );
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  subscriberRef.current = undefined;
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-eve-reduced-effects');
  document.body.removeAttribute('style');
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
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--primary-6')).toBe('15, 118, 110'));

    fireEvent.click(screen.getByTestId('visual-consumer'));
    await waitFor(() => expect(configSetMock).toHaveBeenCalledTimes(1));
    expect(configSetMock.mock.calls[0][0]).toBe('commandEve.visualPreferences');
    expect(configSetMock.mock.calls[0][1]).toMatchObject({ mode: 'dark', accent: 'emerald' });
  });

  it('keeps a decorative legacy dark theme dark during the one-time migration', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'commandEve.visualPreferences') return undefined;
      if (key === 'theme.activeId') return 'retroma-obsidian-book';
      if (key === 'theme.userThemes') return [];
      return undefined;
    });

    render(<VisualConsumer />);

    await waitFor(() => expect(screen.getByTestId('visual-consumer').getAttribute('data-loaded')).toBe('true'));
    expect(screen.getByTestId('visual-consumer').getAttribute('data-mode')).toBe('dark');
  });

  it('rolls back the optimistic preference when persistence fails', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'commandEve.visualPreferences') return { mode: 'light', accent: 'petrol' };
      return undefined;
    });
    configSubscribeMock.mockImplementation((_key: string, callback: (raw: unknown) => void) => {
      subscriberRef.current = callback;
      return () => {
        subscriberRef.current = undefined;
      };
    });
    configSetMock.mockImplementationOnce((_key: string, value: unknown) => {
      subscriberRef.current?.(value);
      return Promise.reject(new Error('write failed'));
    });

    render(<VisualConsumer />);
    await waitFor(() => expect(screen.getByTestId('visual-consumer').textContent).toBe('petrol'));
    fireEvent.click(screen.getByTestId('visual-consumer'));

    await waitFor(() => expect(configSetMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('visual-consumer').textContent).toBe('petrol'));
    expect(configSetLocalMock).toHaveBeenCalledWith(
      'commandEve.visualPreferences',
      expect.objectContaining({
        accent: 'petrol',
      })
    );
  });
});
