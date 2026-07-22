/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auth-step LOGIN/REGISTER mode tests — the founder-reported first-screen bugs.
 *
 * Asserts: browser PKCE is the prominent default; direct credentials are hidden behind
 * an accessible fallback toggle; the fallback keeps password-manager semantics; and
 * the in-app "suggest password" generator fills a strong value in register mode.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const bridgeMocks = vi.hoisted(() => ({
  authWebLogin: vi.fn(() => new Promise(() => {})),
}));
const profileMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    entitlementStatus: { invoke: vi.fn() },
    entitlementRegister: { invoke: vi.fn() },
    entitlementActivate: { invoke: vi.fn() },
    authPasswordLogin: { invoke: vi.fn() },
    authWebLogin: { invoke: bridgeMocks.authWebLogin },
  },
}));
vi.mock('@renderer/services/i18n', () => ({ changeLanguage: vi.fn() }));
vi.mock('@renderer/utils/platform', () => ({ openAccountWeb: vi.fn(), openExternalUrl: vi.fn() }));
vi.mock('@/renderer/components/account/useCommandEveProfile', () => ({
  refreshCommandEveProfile: profileMocks.refresh,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'de-DE', resolvedLanguage: 'de-DE' },
  }),
}));

type MockButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  htmlType?: 'button' | 'submit';
  loading?: boolean;
  type?: string;
  shape?: string;
};
type MockInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  onChange?: (value: string) => void;
  visibility?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
};
type MockTextAreaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> & {
  onChange?: (value: string) => void;
};
type MockCheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  onChange?: (checked: boolean) => void;
};
// Arco → minimal DOM. Input.Password forwards autoComplete/name so we can assert them;
// visibility/onVisibilityChange are consumed so they never hit the DOM as invalid attrs.
vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, onClick, loading, htmlType, type: _variant, shape: _shape, ...rest }: MockButtonProps) => (
    <button
      type={htmlType === 'submit' ? 'submit' : 'button'}
      onClick={onClick}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {children}
    </button>
  ),
  Checkbox: ({ onChange, ...rest }: MockCheckboxProps) => (
    <input type='checkbox' onChange={(e) => onChange?.(e.target.checked)} {...rest} />
  ),
  Input: Object.assign(
    ({ onChange, ...rest }: MockInputProps) => <input onChange={(e) => onChange?.(e.target.value)} {...rest} />,
    {
      TextArea: ({ onChange, ...rest }: MockTextAreaProps) => (
        <textarea onChange={(e) => onChange?.(e.target.value)} {...rest} />
      ),
      Password: ({
        onChange,
        visibility: _visibility,
        onVisibilityChange: _onVisibilityChange,
        ...rest
      }: MockInputProps) => <input type='password' onChange={(e) => onChange?.(e.target.value)} {...rest} />,
    }
  ),
}));

import RegistrationGatePage from '@/renderer/pages/registrationGate';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  bridgeMocks.authWebLogin.mockImplementation(() => new Promise(() => {}));
});

describe('RegistrationGatePage — auth LOGIN/REGISTER modes', () => {
  it('defaults to browser-first LOGIN and does not immediately demand credentials', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    expect(screen.getByTestId('registration-gate-browser-login')).toBeTruthy();
    expect(screen.getByTestId('registration-gate-password-fallback-toggle').getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(screen.queryByTestId('registration-gate-email')).toBeNull();
    expect(screen.queryByTestId('registration-gate-password')).toBeNull();
    expect(screen.queryByTestId('registration-gate-login')).toBeNull();
    expect(screen.queryByTestId('registration-gate-register')).toBeNull();
  });

  it('routes an implicit Enter submit to browser auth while credentials are collapsed', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    fireEvent.submit(screen.getByTestId('registration-gate-auth'));

    expect(bridgeMocks.authWebLogin).toHaveBeenCalledWith({ intent: 'login' });
    expect(screen.queryByText('registrationGate.auth.errors.fieldsRequired')).toBeNull();
  });

  it('refreshes the shared profile before a successful browser-auth landing', async () => {
    bridgeMocks.authWebLogin.mockResolvedValueOnce({ data: { ok: true, entitled: true } });
    profileMocks.refresh.mockResolvedValueOnce(undefined);
    const onEntitled = vi.fn().mockResolvedValue(undefined);
    render(<RegistrationGatePage status={null} onEntitled={onEntitled} />);

    fireEvent.click(screen.getByTestId('registration-gate-browser-login'));

    await waitFor(() => expect(onEntitled).toHaveBeenCalledTimes(1));
    expect(profileMocks.refresh).toHaveBeenCalledTimes(1);
    expect(profileMocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(onEntitled.mock.invocationCallOrder[0]);
  });

  it('reveals an accessible direct-login fallback with current-password semantics', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    fireEvent.click(screen.getByTestId('registration-gate-password-fallback-toggle'));

    expect(screen.getByTestId('registration-gate-password-fallback')).toBeTruthy();
    expect(screen.getByTestId('registration-gate-login')).toBeTruthy();
    expect(screen.getByTestId('registration-gate-password').getAttribute('autocomplete')).toBe('current-password');
  });

  it('returns from the optional license path to browser-first auth, not the legacy PII form', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);

    fireEvent.click(screen.getByTestId('registration-gate-have-code'));
    expect(screen.getByTestId('registration-gate-license-form')).toBeTruthy();
    fireEvent.click(screen.getByTestId('registration-gate-back'));

    expect(screen.getByTestId('registration-gate-browser-login')).toBeTruthy();
    expect(screen.queryByTestId('registration-gate-form')).toBeNull();
  });

  it('keeps the rare license path honest by asking for its required local binding explicitly', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);

    fireEvent.click(screen.getByTestId('registration-gate-have-code'));

    expect(screen.getByTestId('registration-gate-license-setup')).toBeTruthy();
    expect(screen.queryByTestId('registration-gate-license-submit')).toBeNull();
    fireEvent.click(screen.getByTestId('registration-gate-license-setup-button'));
    expect(screen.getByTestId('registration-gate-form')).toBeTruthy();

    fireEvent.click(screen.getByTestId('registration-gate-registration-back'));
    expect(screen.getByTestId('registration-gate-license-form')).toBeTruthy();
    expect(screen.getByTestId('registration-gate-license-setup')).toBeTruthy();
  });

  it('switching to REGISTER keeps browser primary and gives the fallback new-password semantics', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    fireEvent.click(screen.getByTestId('registration-gate-mode-register'));

    expect(screen.getByTestId('registration-gate-browser-login')).toBeTruthy();
    expect(screen.queryByTestId('registration-gate-register')).toBeNull();
    fireEvent.click(screen.getByTestId('registration-gate-password-fallback-toggle'));
    expect(screen.getByTestId('registration-gate-register')).toBeTruthy();
    expect(screen.queryByTestId('registration-gate-login')).toBeNull();
    expect(screen.getByTestId('registration-gate-password').getAttribute('autocomplete')).toBe('new-password');
  });

  it('the in-app generator fills a strong password covering every char class', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    fireEvent.click(screen.getByTestId('registration-gate-mode-register'));
    fireEvent.click(screen.getByTestId('registration-gate-password-fallback-toggle'));
    const pw = screen.getByTestId('registration-gate-password') as HTMLInputElement;
    expect(pw.value).toBe('');
    // Generate many times: EVERY result must be 18 chars AND contain upper, lower,
    // digit, special — so a digit/symbol server policy can never reject our own password.
    for (let i = 0; i < 50; i += 1) {
      fireEvent.click(screen.getByTestId('registration-gate-suggest-password'));
      const value = (screen.getByTestId('registration-gate-password') as HTMLInputElement).value;
      expect(value.length).toBe(18);
      expect(value).toMatch(/[A-Z]/);
      expect(value).toMatch(/[a-z]/);
      expect(value).toMatch(/[0-9]/);
      expect(value).toMatch(/[!@#$%^&*\-_=+]/);
    }
  });
});
