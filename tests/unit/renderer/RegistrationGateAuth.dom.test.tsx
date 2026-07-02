/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auth-step LOGIN/REGISTER mode tests — the founder-reported first-screen bugs.
 *
 * Asserts: the screen has an explicit mode toggle; the SINGLE primary action always
 * matches the selected mode (no "Anmelden" button while registering); the password
 * field carries current-password in login mode and new-password in register mode (so
 * the OS/manager offers to FILL vs SUGGEST correctly); and the in-app
 * "suggest password" generator fills a strong value in register mode.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    entitlementStatus: { invoke: vi.fn() },
    entitlementRegister: { invoke: vi.fn() },
    entitlementActivate: { invoke: vi.fn() },
    authPasswordLogin: { invoke: vi.fn() },
    authWebLogin: { invoke: vi.fn() },
  },
}));
vi.mock('@renderer/services/i18n', () => ({ changeLanguage: vi.fn() }));
vi.mock('@renderer/utils/platform', () => ({ openAccountWeb: vi.fn(), openExternalUrl: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'de-DE', resolvedLanguage: 'de-DE' },
  }),
}));
// Arco → minimal DOM. Input.Password forwards autoComplete/name so we can assert them;
// visibility/onVisibilityChange are consumed so they never hit the DOM as invalid attrs.
vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, onClick, loading, htmlType, ...rest }: any) => (
    <button type={htmlType === 'submit' ? 'submit' : 'button'} onClick={onClick} disabled={loading} {...rest}>
      {children}
    </button>
  ),
  Checkbox: ({ onChange, ...rest }: any) => <input type='checkbox' onChange={(e) => onChange?.(e.target.checked)} {...rest} />,
  Input: Object.assign(
    ({ onChange, ...rest }: any) => <input onChange={(e) => onChange?.(e.target.value)} {...rest} />,
    {
      TextArea: ({ onChange, ...rest }: any) => <textarea onChange={(e) => onChange?.(e.target.value)} {...rest} />,
      Password: ({ onChange, visibility, onVisibilityChange, ...rest }: any) => (
        <input type='password' onChange={(e) => onChange?.(e.target.value)} {...rest} />
      ),
    }
  ),
}));

import RegistrationGatePage from '@/renderer/pages/registrationGate';

afterEach(() => cleanup());

describe('RegistrationGatePage — auth LOGIN/REGISTER modes', () => {
  it('defaults to LOGIN: primary is "Anmelden", no register button, password is current-password', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    // The single primary action is the login button; the register button is NOT shown.
    expect(screen.getByTestId('registration-gate-login')).toBeTruthy();
    expect(screen.queryByTestId('registration-gate-register')).toBeNull();
    // No "suggest password" affordance in login mode.
    expect(screen.queryByTestId('registration-gate-suggest-password')).toBeNull();
    expect(screen.getByTestId('registration-gate-password').getAttribute('autocomplete')).toBe('current-password');
  });

  it('switching to REGISTER makes the primary "Konto erstellen" (no stray "Anmelden" primary) + new-password', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    fireEvent.click(screen.getByTestId('registration-gate-mode-register'));
    // Primary is now the register button; the login PRIMARY button is gone.
    expect(screen.getByTestId('registration-gate-register')).toBeTruthy();
    expect(screen.queryByTestId('registration-gate-login')).toBeNull();
    // The password field now advertises new-password ⇒ managers offer to SUGGEST one.
    expect(screen.getByTestId('registration-gate-password').getAttribute('autocomplete')).toBe('new-password');
  });

  it('the in-app generator fills a strong password covering every char class', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    fireEvent.click(screen.getByTestId('registration-gate-mode-register'));
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
