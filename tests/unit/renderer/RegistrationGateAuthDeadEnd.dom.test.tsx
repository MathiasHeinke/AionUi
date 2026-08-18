/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE FIRST-RUN LOGIN DEAD END — the measured 1.823.2 blocker, pinned.
 *
 * WHAT WAS OBSERVED. The PKCE callback arrives (the browser tab renders
 * "Anmeldung bestätigt", a page only reachable after a byte-equal state check
 * with a code present), and the app then sits on "Sichere Anmeldung wird
 * geöffnet…" with ALL THREE sign-in controls disabled. Nothing in the UI can
 * change that state. The user is stuck.
 *
 * WHY IT COULD HAPPEN AT ALL. `authBusy` was cleared in exactly one place — the
 * `finally` of the bridge call — so the entire screen was hostage to that promise
 * settling. It cannot be assumed to settle: the platform's invoke primitive has a
 * resolve and NO reject (see common/adapter/bridgeInvocationRecovery.ts), so a
 * refused main-side provider left the promise pending forever and the `finally`
 * never ran.
 *
 * TWO SEPARATE THINGS ARE THEREFORE FIXED, AND BOTH ARE ASSERTED HERE. The lost
 * reply is repaired at the bridge (its own tests). But a waiting state that
 * disables every exit and has no time limit is a dead end on its own terms — any
 * future stall reproduces it. So the wait must ALSO be escapable:
 *   1. a Cancel control that is present and enabled DURING the wait, and
 *   2. a backstop timeout that ends the wait with a stated reason.
 *
 * The never-settling promise below (`new Promise(() => {})`) IS the production
 * failure, reproduced exactly.
 *
 * SHARPNESS (verified by reverting each half in isolation):
 *   * remove the Cancel control → "offers an escape" fails: no such element.
 *   * remove the timeout → "ends the wait by itself" fails: still busy after 10
 *     minutes of fake time, which is the dead end.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const bridgeMocks = vi.hoisted(() => ({
  // A promise that NEVER settles — the exact production condition.
  authWebLogin: vi.fn(() => new Promise(() => {})),
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
  refreshCommandEveProfile: vi.fn().mockResolvedValue(undefined),
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

/** Every control the user could reach on the auth step. */
function signInControlsDisabled(): boolean[] {
  return [
    screen.getByTestId('registration-gate-browser-login'),
    screen.getByTestId('registration-gate-mode-login'),
    screen.getByTestId('registration-gate-mode-register'),
    screen.getByTestId('registration-gate-password-fallback-toggle'),
  ].map((element) => (element as HTMLButtonElement).disabled);
}

/** Start the browser login and land in the waiting state the founder reported. */
function enterTheWait() {
  render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
  fireEvent.click(screen.getByTestId('registration-gate-browser-login'));
  // Precondition: this IS the reported dead end — every control disabled.
  expect(bridgeMocks.authWebLogin).toHaveBeenCalledWith({ intent: 'login' });
  expect(signInControlsDisabled()).toEqual([true, true, true, true]);
}

describe('RegistrationGatePage — the browser-login wait must never be a dead end', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bridgeMocks.authWebLogin.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('offers an escape from the wait and gives every control back when it is taken', async () => {
    enterTheWait();

    // The one control that must stay usable while everything else is disabled.
    const cancel = screen.getByTestId('registration-gate-browser-cancel') as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);

    fireEvent.click(cancel);

    await waitFor(() => expect(signInControlsDisabled()).toEqual([false, false, false, false]));
    // Cancelling is the user's own choice — it is not an error, so nothing is scolded.
    expect(screen.queryByTestId('registration-gate-auth-error')).toBeNull();
    // And the escape hatch itself is gone once the wait is over.
    expect(screen.queryByTestId('registration-gate-browser-cancel')).toBeNull();
  });

  it('ends the wait by itself, with a stated reason, when the reply never arrives', async () => {
    enterTheWait();

    // Well inside the longest HEALTHY login (~7.5 min: 5 min loopback + broker +
    // register-profile + my-license backoff) nothing may be cut off.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 60 * 1000);
    });
    expect(signInControlsDisabled()).toEqual([true, true, true, true]);

    // Past the backstop the screen returns to the user on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    });

    await waitFor(() => expect(signInControlsDisabled()).toEqual([false, false, false, false]));
    expect(screen.getByTestId('registration-gate-auth-error').textContent).toBe(
      'registrationGate.auth.errors.AUTH_TIMEOUT'
    );
  });

  it('lets the user retry immediately after escaping — the attempt is truly released', async () => {
    enterTheWait();
    fireEvent.click(screen.getByTestId('registration-gate-browser-cancel'));
    await waitFor(() => expect(signInControlsDisabled()).toEqual([false, false, false, false]));

    fireEvent.click(screen.getByTestId('registration-gate-browser-login'));

    expect(bridgeMocks.authWebLogin).toHaveBeenCalledTimes(2);
    expect(signInControlsDisabled()).toEqual([true, true, true, true]);
  });

  it('does not show the escape hatch when nothing is being waited on', () => {
    render(<RegistrationGatePage status={null} onEntitled={vi.fn()} />);
    expect(screen.queryByTestId('registration-gate-browser-cancel')).toBeNull();
  });

  it('an abandoned attempt that answers late must not repaint the screen', async () => {
    // The stall resolves AFTER the user gave up — a real possibility once the
    // bridge recovery lands. It must not re-disable controls or flash an error
    // onto a screen the user has already taken back.
    let settle: ((value: unknown) => void) | undefined;
    bridgeMocks.authWebLogin.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );

    enterTheWait();
    fireEvent.click(screen.getByTestId('registration-gate-browser-cancel'));
    await waitFor(() => expect(signInControlsDisabled()).toEqual([false, false, false, false]));

    await act(async () => {
      settle?.({ data: { ok: false, needs_paste: true, reason_code: 'BROKER_TIMEOUT' } });
      await Promise.resolve();
    });

    expect(signInControlsDisabled()).toEqual([false, false, false, false]);
    expect(screen.queryByTestId('registration-gate-auth-error')).toBeNull();
  });
});
