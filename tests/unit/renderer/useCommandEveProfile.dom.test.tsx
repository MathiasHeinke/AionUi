/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registrationStatusMock } = vi.hoisted(() => ({ registrationStatusMock: vi.fn() }));

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: { registrationStatus: { invoke: registrationStatusMock } },
}));

import {
  initialsFromName,
  refreshCommandEveProfile,
  resetCommandEveProfileForTests,
  useCommandEveProfile,
} from '@/renderer/components/account/useCommandEveProfile';

const ProfileConsumer: React.FC<{ testId: string }> = ({ testId }) => {
  const profile = useCommandEveProfile();
  const label = !profile.loaded
    ? 'loading'
    : profile.nameConfirmed && profile.name
      ? profile.name
      : profile.email || 'fallback';
  return (
    <span data-testid={testId} data-confirmed={profile.nameConfirmed ? 'true' : 'false'}>
      {label}
    </span>
  );
};

afterEach(() => {
  cleanup();
  resetCommandEveProfileForTests();
  vi.clearAllMocks();
});

describe('useCommandEveProfile', () => {
  it('shares one local registration read across multiple account surfaces', async () => {
    registrationStatusMock.mockResolvedValue({
      data: {
        ok: true,
        name: 'Mathias Heinke',
        name_confirmed: true,
        email: 'm@example.com',
      },
    });

    render(
      <>
        <ProfileConsumer testId='titlebar-profile' />
        <ProfileConsumer testId='footer-profile' />
      </>
    );

    await waitFor(() => expect(screen.getByTestId('footer-profile').textContent).toBe('Mathias Heinke'));
    expect(screen.getByTestId('titlebar-profile').textContent).toBe('Mathias Heinke');
    expect(screen.getByTestId('footer-profile').getAttribute('data-confirmed')).toBe('true');
    expect(registrationStatusMock).toHaveBeenCalledTimes(1);
  });

  it('hides email-local-part guesses until a confirmed name exists', async () => {
    registrationStatusMock.mockResolvedValue({
      data: {
        ok: true,
        name_confirmed: false,
        email: 'jane.doe@acme-corp.com',
        name_source: 'email_fallback',
      },
    });

    render(<ProfileConsumer testId='email-only-profile' />);

    await waitFor(() => expect(screen.getByTestId('email-only-profile').textContent).toBe('jane.doe@acme-corp.com'));
    expect(screen.getByTestId('email-only-profile').getAttribute('data-confirmed')).toBe('false');
  });

  it('refreshes shared chrome after an explicit same-session profile edit', async () => {
    registrationStatusMock
      .mockResolvedValueOnce({
        data: {
          ok: true,
          name_confirmed: false,
          email: 'mathias@example.com',
          name_source: 'email_fallback',
        },
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          name: 'Mathias Heinke',
          name_confirmed: true,
          email: 'mathias@example.com',
          name_source: 'explicit',
        },
      });

    render(<ProfileConsumer testId='edit-profile' />);
    await waitFor(() => expect(screen.getByTestId('edit-profile').textContent).toBe('mathias@example.com'));

    await act(async () => {
      await refreshCommandEveProfile();
    });

    await waitFor(() => expect(screen.getByTestId('edit-profile').textContent).toBe('Mathias Heinke'));
    expect(screen.getByTestId('edit-profile').getAttribute('data-confirmed')).toBe('true');
    expect(registrationStatusMock).toHaveBeenCalledTimes(2);
  });

  it('derives stable account initials', () => {
    expect(initialsFromName('Mathias Heinke')).toBe('MH');
    expect(initialsFromName('EVE')).toBe('EV');
    expect(initialsFromName()).toBe('');
  });
});
