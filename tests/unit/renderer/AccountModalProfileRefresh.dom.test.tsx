/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registrationStatus: vi.fn(),
  registrationUpdate: vi.fn(),
  refreshSharedProfile: vi.fn(),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    registrationStatus: { invoke: mocks.registrationStatus },
    registrationUpdate: { invoke: mocks.registrationUpdate },
    licenseWireStatus: { invoke: vi.fn().mockResolvedValue({ data: { available: true } }) },
    entitlementActivate: { invoke: vi.fn() },
    authLogout: { invoke: vi.fn() },
    entitlementReset: { invoke: vi.fn() },
    authWebLogin: { invoke: vi.fn() },
  },
}));

vi.mock('@/renderer/components/account/useCommandEveProfile', () => ({
  refreshCommandEveProfile: mocks.refreshSharedProfile,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; status?: string };
type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  onChange?: (value: string) => void;
};

vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, loading, status: _status, ...props }: ButtonProps) => (
    <button {...props} disabled={loading || props.disabled}>
      {children}
    </button>
  ),
  Input: Object.assign(
    ({ onChange, ...props }: InputProps) => <input {...props} onChange={(event) => onChange?.(event.target.value)} />,
    { TextArea: () => <textarea /> }
  ),
  Message: { error: vi.fn(), success: vi.fn() },
  Popconfirm: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Tag: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));

vi.mock('@/renderer/components/settings/PreferenceRow', () => ({
  default: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/settings/SettingsSection', () => ({
  default: ({ children, action }: React.PropsWithChildren<{ action?: React.ReactNode }>) => (
    <section>
      {action}
      {children}
    </section>
  ),
  SettingsPageHeader: () => null,
}));

import AccountModalContent from '@/renderer/components/settings/SettingsModal/contents/AccountModalContent';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AccountModalContent profile propagation', () => {
  it('refreshes the shared profile store after a successful same-session edit', async () => {
    mocks.registrationStatus
      .mockResolvedValueOnce({
        data: {
          ok: true,
          has_session: true,
          name: 'Alter Name',
          company: 'Fyn Labs',
          email: 'user@example.com',
        },
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          has_session: true,
          name: 'Neuer Name',
          company: 'Fyn Labs',
          email: 'user@example.com',
        },
      });
    mocks.registrationUpdate.mockResolvedValue({ data: { ok: true } });
    mocks.refreshSharedProfile.mockResolvedValue(undefined);

    render(<AccountModalContent />);
    await waitFor(() => expect(screen.getByTestId('account-name').textContent).toBe('Alter Name'));

    fireEvent.click(screen.getByTestId('account-edit'));
    fireEvent.change(screen.getByTestId('account-name-input'), { target: { value: 'Neuer Name' } });
    fireEvent.click(screen.getByTestId('account-save'));

    await waitFor(() =>
      expect(mocks.registrationUpdate).toHaveBeenCalledWith({ name: 'Neuer Name', company: 'Fyn Labs' })
    );
    await waitFor(() => expect(mocks.refreshSharedProfile).toHaveBeenCalledTimes(1));
    expect(mocks.registrationStatus).toHaveBeenCalledTimes(2);
  });
});
