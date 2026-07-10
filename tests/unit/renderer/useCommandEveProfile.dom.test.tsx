/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registrationStatusMock } = vi.hoisted(() => ({ registrationStatusMock: vi.fn() }));

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: { registrationStatus: { invoke: registrationStatusMock } },
}));

import { initialsFromName, useCommandEveProfile } from '@/renderer/components/account/useCommandEveProfile';

const ProfileConsumer: React.FC<{ testId: string }> = ({ testId }) => {
  const profile = useCommandEveProfile();
  return <span data-testid={testId}>{profile.name || (profile.loaded ? 'fallback' : 'loading')}</span>;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useCommandEveProfile', () => {
  it('shares one local registration read across multiple account surfaces', async () => {
    registrationStatusMock.mockResolvedValue({ data: { ok: true, name: 'Mathias Heinke', email: 'm@example.com' } });

    render(
      <>
        <ProfileConsumer testId='titlebar-profile' />
        <ProfileConsumer testId='footer-profile' />
      </>
    );

    await waitFor(() => expect(screen.getByTestId('footer-profile').textContent).toBe('Mathias Heinke'));
    expect(screen.getByTestId('titlebar-profile').textContent).toBe('Mathias Heinke');
    expect(registrationStatusMock).toHaveBeenCalledTimes(1);
  });

  it('derives stable account initials', () => {
    expect(initialsFromName('Mathias Heinke')).toBe('MH');
    expect(initialsFromName('EVE')).toBe('EV');
    expect(initialsFromName()).toBe('');
  });
});
